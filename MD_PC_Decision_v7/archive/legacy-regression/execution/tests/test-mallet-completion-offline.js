'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { completeMalletSelection, committedSelectionState, MALLET_RESUME_STATUSES } =
  require('../core/m11-mallet-completion');
const { readPng, cropImage } = require('../../lib/png-utils');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { loadMalletEvidenceTemplates, analyzeMalletResolutionEvidence } =
  require('../core/m11-mallet-resolution-evidence');

const ROOT = path.resolve(__dirname, '../..');
const hand = { revision: 14, handCount: 8,
  cards: ['M03', 'M06', 'M06', 'M07', 'M08', 'M08', 'M11', 'M14'].map(id => ({ id })) };
function checkpoint(status = 'READY_TO_CONFIRM') {
  const returned = hand.cards.filter(card => card.id !== 'M11');
  return { version: 2, status, baseline: structuredClone(hand),
    baselineFingerprint: hand.cards.map(card => card.id).join('>'),
    malletSlot: 7, keepIds: [], plan: { returned, kept: [] },
    committedIds: returned.map(card => card.id),
    selectionProof: { selectedCount: 7, rows: returned.map(card => ({ card })) } };
}
const proof = { status: 'PASS', expectedDrawCount: 7, drawResultCount: 7,
  returnBeforePrimaryDrawCount: 3, drawLabelCount: 1 };
const notReady = { status: 'NOT_READY', expectedDrawCount: 7, drawResultCount: 0,
  returnBeforePrimaryDrawCount: 0, drawLabelCount: 0 };
function hooks(observations, prompt = {}) {
  const calls = [], saves = [];
  return { calls, saves,
    waitStable: async count => { calls.push(['wait', count]); },
    observeResolution: async options => {
      calls.push(['observe', options]);
      return observations.shift() || notReady;
    },
    probePrompt: async () => { calls.push(['probe']); return prompt; },
    confirmSelection: async () => { calls.push(['confirm']); return { status: 'PASS', left: true }; },
    persistCheckpoint: value => { calls.push(['save', value.status]); saves.push(value); }
  };
}
function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production boundaries: ${start}`);
  return source.slice(from, to);
}

async function completionCases() {
  for (const status of MALLET_RESUME_STATUSES) {
    const saved = checkpoint(status), before = JSON.stringify(saved);
    const h = hooks([proof]);
    const result = await completeMalletSelection({ checkpoint: saved, ...h });
    assert.strictEqual(result.checkpoint.status, 'RESOLUTION_PROVEN');
    assert.strictEqual(result.selectionProof, saved.selectionProof);
    assert.strictEqual(JSON.stringify(saved), before, 'input checkpoint is not mutated');
    assert.deepStrictEqual(h.calls.map(row => row[0]), ['wait', 'observe', 'save']);
    assert.strictEqual(h.saves.length, 1, 'already resolved does not confirm/reselect/recast');
  }
  const partial = checkpoint('SELECTION_ACTIVE');
  partial.committedIds.pop();
  assert.strictEqual(committedSelectionState(partial).complete, false);
  const hPartial = hooks([proof]);
  await assert.rejects(completeMalletSelection({ checkpoint: partial, ...hPartial }), /BEFORE_ALL_COMMITS/);
  assert.strictEqual(hPartial.calls.length, 0);
  partial.status = 'READY_TO_CONFIRM';
  assert.throws(() => committedSelectionState(partial), /INCOMPLETE_FINAL_CHECKPOINT/);
  const badDuplicate = checkpoint();
  badDuplicate.committedIds[0] = 'M06';
  assert.throws(() => committedSelectionState(badDuplicate), /UNPLANNED_COMMIT:M06/);

  const realModal = { modalBodyProven: true, likelyVisible: true, action: { usable: { left: true } } };
  const hConfirm = hooks([notReady, proof], realModal);
  await completeMalletSelection({ checkpoint: checkpoint(), ...hConfirm });
  assert.deepStrictEqual(hConfirm.calls.map(row => row[0]),
    ['wait', 'observe', 'probe', 'confirm', 'save', 'wait', 'observe', 'save']);
  assert.deepStrictEqual(hConfirm.saves.map(row => row.status), ['CONFIRMED', 'RESOLUTION_PROVEN']);
  const alreadyConfirmed = checkpoint('CONFIRMED');
  alreadyConfirmed.confirmProof = { clickCount: 1 };
  const hConfirmed = hooks([notReady, proof], realModal);
  await completeMalletSelection({ checkpoint: alreadyConfirmed, ...hConfirmed });
  assert.ok(!hConfirmed.calls.some(row => row[0] === 'confirm'),
    'saved Confirm receipt forbids another input while its UI lingers');
  const kept = checkpoint();
  kept.plan.returned = [{ id: 'M03' }, { id: 'M06' }];
  kept.plan.kept = [{ id: 'M19' }];
  kept.committedIds = ['M03', 'M06'];
  const hKept = hooks([{ ...proof, expectedDrawCount: 2, drawResultCount: 2 }]);
  await completeMalletSelection({ checkpoint: kept, ...hKept });
  assert.strictEqual(hKept.calls[1][1].expectedDrawCount, 2,
    'redraw uses returned count, excluding protected cards');
  for (const prompt of [
    { modalBodyProven: false, likelyVisible: true, action: { usable: { left: true, center: true } } },
    { modalBodyProven: true, likelyVisible: true, action: { usable: { left: false, center: true, right: true } } },
    { modalBodyProven: true, likelyVisible: false, action: { usable: { left: true } } }
  ]) {
    const h = hooks([notReady, proof], prompt);
    await completeMalletSelection({ checkpoint: checkpoint(), ...h });
    assert.ok(!h.calls.some(row => row[0] === 'confirm'), 'ambiguous hand/buttons never authorize a click');
  }
  for (const invalid of [notReady, { ...proof, drawResultCount: 6 },
    { ...proof, expectedDrawCount: 6 }, { ...proof, returnBeforePrimaryDrawCount: 0 },
    { ...proof, drawLabelCount: 0 }]) {
    const h = hooks([invalid, invalid]);
    const saved = { ...checkpoint('RESOLUTION_PROVEN'), resolutionProof: proof };
    await assert.rejects(completeMalletSelection({ checkpoint: saved, ...h }), /RESOLUTION_NOT_PROVEN/);
    assert.strictEqual(h.saves.length, 0, 'cached or wrong-count evidence does not finish recovery');
    assert.ok(!h.calls.some(row => row[0] === 'confirm'));
  }
}

async function productionWrapper() {
  const live = fs.readFileSync(path.join(ROOT, 'execution/live/run-m11-mallet-keep-weapon.js'), 'utf8');
  const calls = [];
  const context = vm.createContext({ completeMalletSelection, console: { log() {} },
    sleep: async ms => calls.push(['wait', ms]), malletResolutionStableWaitMs: () => 2700,
    observeMalletResolutionTail: async options => { calls.push(['observe', options]); return proof; },
    probeMalletSelectionPrompt: async () => { throw new Error('unexpected prompt probe'); },
    confirmMalletSelection: async () => { throw new Error('unexpected game click'); },
    persistResumeState: value => calls.push(['save', value.status]) });
  vm.runInContext(between(live, 'async function finishSubmittedMalletSelection(', 'async function main()'), context);
  await context.finishSubmittedMalletSelection({ checkpoint: checkpoint(),
    bridge: 'bridge', info: 'info', templates: 'templates', attemptDir: 'attempt' });
  assert.deepStrictEqual(calls.map(row => row[0]), ['wait', 'observe', 'save']);
  assert.strictEqual(calls[1][1].expectedDrawCount, 7);
  assert.strictEqual(calls[1][1].debugDir, 'attempt');
  // The live dispatch consumes the saved selection before deciding to select.
  const resumeBranch = between(live, '    if (resumeState) {', '\n    if (!selectionProof) {');
  assert.ok(resumeBranch.includes('if (savedSelection.complete)'));
  assert.ok(resumeBranch.includes('selectionProof = completed.selectionProof;'));
}

async function recoveryLock() {
  const source = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
  const production = between(source, 'function loadPendingMalletCheckpoint(', 'function loadCurrentDecisionWithoutRescan(');
  function harness(saved = checkpoint(), fail = false) {
    const calls = [], logs = [];
    const context = vm.createContext({ MALLET_RESUME_STATUSES, committedSelectionState,
      M11_RESUME_STATE_PATH: 'checkpoint', fs: { existsSync: () => Boolean(saved) },
      readJson: () => saved, console: { log: value => logs.push(value), error: value => logs.push(value) },
      assertFreshRuntimeBeforeGameAction: () => calls.push(['freshness']),
      PRODUCTION_ENTRYPOINTS: { M11: 'm11-live' },
      runExecutor: (...args) => {
        calls.push(['executor', ...args]);
        if (fail) {
          const error = new Error('OFFLINE_FAILURE');
          if (fail === 'VICTORY') error.terminalVictory = true;
          throw error;
        }
      },
      confirmDetectedVictoryResult: async (...args) => calls.push(['victory', ...args]),
      loadObserverSessionState: () => ({ handCount: 7, revision: 0, cards: [{ id: 'AFTER_SCAN' }] }) });
    vm.runInContext(production, context);
    return { context, calls, logs };
  }
  for (const answer of ['q', 'r', '手牌7', 'n']) {
    const h = harness();
    const result = await h.context.resumePendingMalletAtDecision(hand, { question: async () => answer });
    assert.strictEqual(result.quit, answer === 'q');
    assert.strictEqual(h.calls.length, 0, 'restart/q/invalid input does not act or rescan');
  }
  const h = harness();
  assert.strictEqual(h.context.loadPendingMalletCheckpoint(hand).status, 'READY_TO_CONFIRM');
  assert.strictEqual(h.calls.length, 0, 'loading/restarting only reads checkpoint');
  const result = await h.context.resumePendingMalletAtDecision(hand, { question: async () => '' });
  assert.strictEqual(result.state.handCount, 7);
  const executor = h.calls.find(row => row[0] === 'executor');
  assert.strictEqual(executor[1], 'm11-live');
  assert.strictEqual(executor[2], 7);
  assert.deepStrictEqual(Array.from(executor[4]), ['--keep=', '--resume-current-selection']);
  const failed = harness(checkpoint(), true);
  const failResult = await failed.context.resumePendingMalletAtDecision(hand, { question: async () => '' });
  assert.strictEqual(failResult.state, hand, 'failed recovery keeps baseline and pending lock');
  assert.ok(failed.logs.some(value => /保留万宝槌恢复锁/.test(value)));
  const won = harness(checkpoint(), 'VICTORY');
  const wonResult = await won.context.resumePendingMalletAtDecision(hand, { question: async () => '' });
  assert.strictEqual(wonResult.quit, true, 'recovery victory hands off to mature settlement and ends duel');
  assert.strictEqual(won.calls.filter(row => row[0] === 'victory').length, 1);
  assert.ok(!won.logs.some(value => /保留万宝槌恢复锁/.test(value)));
  assert.strictEqual(harness(null).context.loadPendingMalletCheckpoint(hand), null);
  assert.throws(() => harness({ ...checkpoint(), status: 'UNKNOWN' }).context.loadPendingMalletCheckpoint(hand),
    /PENDING_CHECKPOINT_INVALID/);
  const wrongHand = { ...hand, cards: hand.cards.slice().reverse() };
  assert.throws(() => harness().context.loadPendingMalletCheckpoint(wrongHand), /PENDING_BASELINE_MISMATCH/);
  const loop = between(source, '      const malletRecovery = await resumePendingMalletAtDecision', '      normalizeEquippedYotoGoldenDrawPriority');
  assert.ok(loop.includes('continue;'), 'pending M11 bypasses ordinary decision suggestions');
}

async function realPixelEvidence() {
  const source = fs.readFileSync(path.join(ROOT, 'execution/core/m11-mallet-selection.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(between(source, 'function classifyMalletPromptBody(', 'async function probeMalletSelectionPrompt('), context);
  for (const filename of ['issue-098-selection-seven.png', 'issue-098-selection-single.png']) {
    const image = await readPng(path.join(ROOT, 'material/issues', filename));
    assert.strictEqual(context.classifyMalletPromptBody(image).modalBodyProven, true, filename);
  }
  const closed = await readPng(path.join(ROOT, 'material/issues/issue-098-closed-modal.png'));
  assert.strictEqual(context.classifyMalletPromptBody(closed).modalBodyProven, false,
    'actual ordinary yellow hand art is not a selection modal');
  const scene = await readPng(path.join(ROOT, 'material/issues/issue-098-user-scene.png'));
  const promptRoi = cropImage(scene, { x: 520, y: 820, width: 1025, height: 225 });
  assert.strictEqual(context.classifyMalletPromptBody(promptRoi).modalBodyProven, false);
  const [evidenceTemplates, templates] = await Promise.all([
    loadMalletEvidenceTemplates(ROOT), loadTemplates(ROOT, loadLibrary(ROOT))
  ]);
  const evidence = analyzeMalletResolutionEvidence(scene, { x: 1650, y: 95, width: 380, height: 970 },
    evidenceTemplates, templates, { expectedDrawCount: 7 });
  assert.ok(evidence.returnBeforePrimaryDrawCount > 0, 'actual returns precede redraw');
  assert.ok(evidence.drawLabelCount > 0, 'actual DRAW label');
  assert.strictEqual(evidence.drawResultCount, 7, 'actual screenshot redraws seven cards');
  console.log(`ISSUE-098 saved screenshot: RETURN=${evidence.returnBeforePrimaryDrawCount}; DRAW=${evidence.drawResultCount}; no GUI input`);
}

(async () => {
  await completionCases();
  await productionWrapper();
  await recoveryLock();
  await realPixelEvidence();
  console.log('PASS M11 submitted/auto-resolved recovery, strict modal, pending lock, actual pixel evidence');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
