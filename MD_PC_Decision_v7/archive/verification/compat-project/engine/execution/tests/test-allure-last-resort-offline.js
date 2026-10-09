'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { voidOrdinarySettlement } = require('../core/observer-completion');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { recoverLegacyAllurePromptCheckpoint } = require('../../execution/core/m13-last-resort');

const ROOT = path.resolve(__dirname, '../..');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const { detectM13DialogBounds, detectM13BanishCandidateCenters } = require('../../execution/core/m13-banish-selection');
const geometryFixtures = [
  ['material/issues/issue-101-user-scene.png', [945, 1103], true],
  ['material/verified/issue-095-m13-two-dark-prompt.png', [945, 1103], true],
  ['2026-09-22T15-57-24-792Z', [787, 945, 1103, 1261]],
  ['2026-09-23T16-01-32-241Z', [1024]],
  ['2026-09-26T12-53-08-727Z', [866, 1024, 1182]],
  ['2026-09-26T13-06-04-692Z', [708, 866, 1024, 1182, 1340]],
  ['2026-09-28T09-05-56-948Z', [1024]],
  ['2026-09-29T15-26-30-912Z', [866, 1024, 1182]],
  ['2026-09-30T14-25-25-020Z', [629, 787, 945, 1103, 1261, 1419]]
];
for (const [name, expected, fullFrame] of geometryFixtures) {
  const file = fullFrame ? path.join(ROOT, name) : path.join(ROOT,
    'material/verified/evidence/M13_allure_of_darkness', name, 'm13_banish_candidates_stable.png');
  const png = PNG.sync.read(fs.readFileSync(file));
  const strip = fullFrame ? cropImage(png, { x: 540, y: 790, width: 970, height: 250 }) : png;
  assert.ok(detectM13DialogBounds(strip), name);
  assert.deepStrictEqual(detectM13BanishCandidateCenters(strip).map(row => row.x), expected, name);
}
const uniformDark = { width: 970, height: 250, data: Buffer.alloc(970 * 250 * 4) };
assert.strictEqual(detectM13DialogBounds(uniformDark), null, 'both dialog borders required');
assert.deepStrictEqual(detectM13BanishCandidateCenters(uniformDark), []);
assert.strictEqual(detectM13DialogBounds({}), null);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-allure-last-resort-'));
const ids = ['M04', 'M05', 'M10', 'M10', 'M13', 'M14'];
const hand = ids.map((id, i) => ({ id, index: i + 1, name: id, usable: true }));
const decision = { deck: { deckRemaining: { M06: 2, M08: 1, M19: 2, M20: 1, M09: 19 } },
  actions: [], selected: null, engageTargets: [] };
const runtime = { graveSpellCount: 7, usedCounts: { M12: 2 },
  normalSummonUsed: false, v5Branch: { active: false, currentState: 'KAGARI_RECOVERY_DONE' } };
const deadlock = analyzeReachableResourceDeadlock({ cards: hand, runtime, decisionResult: decision });
assert.strictEqual(deadlock.terminal, true);
const action = buildLastResortAllureAction(hand, decision, deadlock);
assert.strictEqual(action.slot, 5);
assert.strictEqual(action.details.allureLastResort, true);
assert.strictEqual(action.details.rayeRemaining, 2);
assert.strictEqual(buildLastResortAllureAction(hand, decision, { terminal: false }), null);
assert.strictEqual(buildLastResortAllureAction([...hand, { id: 'M06' }], decision, deadlock), null);
assert.strictEqual(buildLastResortAllureAction([...hand, { id: 'M08' }], decision, deadlock), null);
assert.strictEqual(buildLastResortAllureAction([...hand, { id: 'UNKNOWN' }], decision, deadlock), null);
assert.strictEqual(buildLastResortAllureAction(hand, { deck: { deckRemaining: { M06: 0, M09: 25 } } }, deadlock), null);
assert.strictEqual(buildLastResortAllureAction(hand, { deck: { deckRemaining: { M06: 0, M08: 1, M09: 25 } } }, deadlock).details.hampRemaining, 1);
assert.strictEqual(buildLastResortAllureAction(hand, { deck: { deckRemaining: { M06: 1 } } }, deadlock), null);
for (const resource of ['M09', 'M11', 'M16', 'M12']) {
  const available = { ...decision, actions: [{ id: resource }] };
  const proof = analyzeReachableResourceDeadlock({ cards: hand, runtime, decisionResult: available });
  assert.strictEqual(buildLastResortAllureAction(hand, available, proof), null, `${resource} precedes the gamble`);
}
const fieldProof = analyzeReachableResourceDeadlock({ cards: hand,
  runtime: { ...runtime, chickenGameDrawPending: true }, decisionResult: decision });
assert.strictEqual(buildLastResortAllureAction(hand, decision, fieldProof), null);

// Execute the actual top-level suggestion function with a fixed deck snapshot.
const mainSource = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
assert.doesNotMatch(mainSource, /runExecutor\(PRODUCTION_ENTRYPOINTS\.M13/);
const registryStart = mainSource.indexOf('function resolveVerifiedExecutor(');
const registryEnd = mainSource.indexOf('function buildDecisionSuggestion(', registryStart);
const registryContext = vm.createContext({ ROOT, fs, path, readJson,
  VERIFIED_PATH: require('../../lib/project-storage').VERIFIED_STATUS_PATH });
vm.runInContext(mainSource.slice(registryStart, registryEnd), registryContext);
assert.strictEqual(registryContext.resolveVerifiedExecutor('M13').relative.replaceAll(String.fromCharCode(92), '/'),
  'execution/live/run-m13-allure-of-darkness.js');
const functionStart = mainSource.indexOf('function buildDecisionSuggestion(');
const functionEnd = mainSource.indexOf('function shortExtraForDecision(', functionStart);
const suggestionContext = vm.createContext({ ROOT, path, loadDecisionState: () => runtime,
  isStrategicallyUsable: () => true, knownNonRayeMonsterPresent: () => false, buildLastResortAllureAction,
  require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => ({}) };
    if (id.endsWith('decision-engine')) return { collectActions: () => ({ ...decision, actions: [] }) };
    if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock };
    throw new Error(`unexpected suggestion dependency: ${id}`);
  } });
vm.runInContext(mainSource.slice(functionStart, functionEnd), suggestionContext);
const suggestion = suggestionContext.buildDecisionSuggestion({ cards: hand });
assert.strictEqual(suggestion.selected.id, 'M13');
assert.strictEqual(suggestion.strategicDeadlock.terminal, false);

// The real parent executor must consume the surrender result before generic
// draw accounting, rather than loading the deliberately stale pre-loss hand.
const executorStart = mainSource.indexOf('function runExecutor(');
const executorEnd = mainSource.indexOf('function incrementUsedCount(', executorStart);
let accountingCalls = 0;
let completedStage = 'COMPLETE_SURRENDER';
const executorContext = vm.createContext({ ROOT, path, fs, PRELOAD_PATH: 'mock-preload',
  console: { log() {}, error() {} }, process: { execPath: 'mock-node', env: {} }, voidOrdinarySettlement,
  loadDecisionState: () => runtime, snapshotDuelLogForCard: () => ({}),
  snapshotVictoryOutcome: () => ({ terminal: false, mtimeMs: 0 }), exodiaVictoryRisk: () => null,
  spawnSync: (_, args) => { assert.ok(args.includes('--last-resort-raye')); return { status: 0 }; },
  loadLastResortAllureState: () => ({ stage: completedStage, result: { status: 'TERMINAL_SURRENDER' } }),
  updateDecisionStateAfterSuccess: () => { accountingCalls++; } });
vm.runInContext(mainSource.slice(executorStart, executorEnd), executorContext);
assert.strictEqual(executorContext.runExecutor('execution/live/run-m13-allure-of-darkness.js', 5,
  { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye']).terminalSurrender, true);
assert.strictEqual(accountingCalls, 0);
completedStage = 'COMPLETE_RAYE';
executorContext.runExecutor('execution/live/run-m13-allure-of-darkness.js', 5,
  { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye']);
assert.strictEqual(accountingCalls, 1);
completedStage = 'COMPLETE_HAMP';
executorContext.runExecutor('execution/live/run-m13-allure-of-darkness.js', 5,
  { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye']);
assert.strictEqual(accountingCalls, 2);

// A fresh strict win still closes the transaction if the child stopped while
// exiting its observer; the next new duel must not inherit this pending lock.
let snapshots = 0;
let victoryCheckpoint;
executorContext.snapshotVictoryOutcome = () => ++snapshots === 1
  ? { terminal: false, mtimeMs: 0 }
  : { terminal: true, mtimeMs: 1, result: { terminal: true, type: 'VICTORY', checkedAt: new Date().toISOString(), strictEvidence: { matched: true } } };
executorContext.isLastResortAllurePending = row => row.stage === 'OBSERVER_STARTED';
executorContext.ALLURE_LAST_RESORT_STATE_PATH = 'mock-state';
executorContext.writeJsonAtomic = (file, row) => {
  if (file.endsWith('last-settlement-void.json')) { assert.strictEqual(row.status, 'VOID_AFTER_CONFIRMED_VICTORY'); return; }
  assert.strictEqual(file, 'mock-state'); victoryCheckpoint = row;
};
completedStage = 'OBSERVER_STARTED';
assert.throws(() => executorContext.runExecutor('execution/live/run-m13-allure-of-darkness.js', 5,
  { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye']), error => error.terminalVictory === true);
assert.strictEqual(victoryCheckpoint.stage, 'COMPLETE_VICTORY');
assert.strictEqual(accountingCalls, 2);
completedStage = 'SURRENDER_STARTED';
assert.throws(() => executorContext.runExecutor('execution/live/run-m13-allure-of-darkness.js', 5,
  { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye']), /COMPLETION_NOT_PROVEN/);
assert.strictEqual(accountingCalls, 2);

function selectionHarness(candidateIds, options = {}) {
  const file = path.join(ROOT, 'execution/core/m13-banish-selection.js');
  const realRequire = createRequire(file);
  const points = candidateIds.map((id, i) => ({ x: 1024 - (candidateIds.length - 1) * 79 + i * 158, y: 925, width: 116 }));
  const strip = { width: 970, height: 250, data: Buffer.alloc(970 * 250 * 4, 255) };
  for (let y = 242; y < 250; y++) for (let x = 139; x <= 828; x++) {
    const offset = (y * 970 + x) * 4;
    strip.data[offset] = strip.data[offset + 1] = strip.data[offset + 2] = 20;
  }
  const calls = [];
  let selectedIndex = null;
  let promptOpen = true;
  const bridge = { async click(x, y) {
    const index = points.findIndex(row => row.x === x && row.y === y);
    calls.push(index >= 0 ? `candidate:${index}` : 'submit');
    if (index >= 0) {
      selectedIndex = selectedIndex === index ? null : index;
      if (options.autoSubmitSingle === true && candidateIds.length === 1) promptOpen = false;
    }
  } };
  const context = vm.createContext({ __dirname: path.dirname(file), module: { exports: {} },
    console: { log() {} }, Number, require: id => {
      if (id.endsWith('win-fast')) return { captureReferenceRoi: async () => strip,
        mapReferencePoint: (_, point) => point, sleep: async () => {} };
      if (id === './image-metrics') return { imageDarkRatio: () => 0.9 };
      if (id.endsWith('recognition-result')) return { normalizeRecognized: row => row };
      if (id.endsWith('hand-state')) return { yellowUsableStats: () => ({ estimatedYellowPixels: 900 }) };
      if (id.endsWith('prompt-submit-timing')) return { waitBeforePromptSubmit: async () => {} };
      if (id.endsWith('scan-state')) return { saveRgbaPng() {}, recognizeCurrentCard: async () => ({
        id: candidateIds[selectedIndex], name: candidateIds[selectedIndex],
        accepted: candidateIds[selectedIndex] !== 'UNKNOWN' }) };
      if (id.endsWith('prompt-candidate-centers')) return {
        detectCandidateCenters: () => promptOpen ? points : []
      };
      return realRequire(id);
    } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { run: options => context.module.exports.selectM13BanishTarget({ bridge, info: {}, ...options }),
    calls, get selectedIndex() { return selectedIndex; } };
}

function lifecycleHarness({ branch = 'NO_RAYE', cards = hand, infoCount = 0, failSurrender = false } = {}) {
  const file = path.join(ROOT, 'execution/core/m13-last-resort.js');
  const realRequire = createRequire(file);
  const calls = [];
  const baseline = { status: 'PASS', handCount: cards.length, cards, revision: 10 };
  const context = vm.createContext({ __dirname: path.dirname(file), module: { exports: {} },
    console: { log() {} }, require: id => {
      if (id.endsWith('win-fast')) return { MdFastBridge: class {
        async start() { calls.push('start'); } async stop() { calls.push('stop'); }
      }, sleep: async () => { calls.push('settle'); } };
      if (id.endsWith('md-foreground')) return { activateAndVerifyMasterDuel: async () => ({ info: {} }) };
      if (id === './observer-current-baseline') return { establishCurrentObserverBaseline: async () => {
        calls.push('baseline'); return baseline;
      } };
      if (id === './hand-target') return { selectObservedHandCard: async () => {
        calls.push('select-allure'); return { clickReference: { x: 1100, y: 1000 } };
      } };
      if (id === './hand-spell-activation') return { clickSelectedHandSpellActivation: async () => {
        calls.push('activate'); return { pass: true };
      } };
      if (id === './m13-banish-selection') return { selectM13BanishTarget: async options => {
        calls.push('prompt');
        assert.strictEqual(options.lastResort, true);
        if (branch === 'NO_DARK') throw new Error('M13_BANISH_PROMPT_TIMEOUT:bestCandidates=0');
        if (branch === 'UNKNOWN') throw new Error('M13_LAST_RESORT_CANDIDATE_UNKNOWN_NO_RAYE_NOT_PROVEN');
        if (branch === 'RAYE' || branch === 'HAMP') {
          const id = branch === 'RAYE' ? 'M06' : 'M08';
          await options.onBeforeSubmit({ selected: { id } });
          calls.push('banish-' + id); return { selected: { id } };
        }
        return { status: 'NO_SAFE_DARK_IN_PROMPT', seen: [{ card: { id: 'M04', accepted: true } }] };
      } };
      if (id === './deadlock-surrender') return { runConfirmedDeadlockSurrender: async () => {
        calls.push('surrender'); if (failSurrender) throw new Error('SURRENDER_NOT_PROVEN');
        return { status: 'SURRENDER_COMPLETE' };
      } };
      if (id.endsWith('recognizer')) return { loadLibrary: () => ({}), loadTemplates: async () => ({}) };
      if (id.endsWith('decision-engine')) return { collectActions: () => decision };
      if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock: () => deadlock };
      if (id.endsWith('runtime-files')) return { readJson: fileName => fileName === path.join(ROOT, 'decision-state.json')
        ? runtime : readJson(fileName), writeJsonAtomic };
      if (id.endsWith('self-priority-gate')) return { waitForSelfPriorityBlue: async () => { calls.push('blue'); } };
      if (id.endsWith('hand-info-overlay')) return { loadInfoDigitTemplates: () => ({}) };
      if (id.endsWith('test-hand-info-live')) return { runFastOwnAutoHold: async (_, expected) => {
        assert.deepStrictEqual(expected.own, 0); calls.push('info');
        return { result: { status: 'OK', own: { handCount: infoCount } } };
      } };
      return realRequire(id);
    } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { run: context.module.exports.runM13LastResort, calls,
    observe: async () => { calls.push('observe'); return { status: 'PASS' }; } };
}

async function main() {
  const soleAuto = selectionHarness(['M08'], { autoSubmitSingle: true });
  const soleAutoOrder = [];
  const soleAutoResult = await soleAuto.run({
    plannedBeforeActivation: { id: 'M08', name: '闪术兵器－H.A.M.P.', originalSlot: 2 },
    onBeforeSubmit: async proof => {
      assert.strictEqual(proof.selected.id, 'M08');
      assert.strictEqual(proof.submitMode, 'SINGLE_CANDIDATE_MAY_AUTO_SUBMIT');
      soleAutoOrder.push('checkpoint');
    }
  });
  assert.strictEqual(soleAutoResult.selected.id, 'M08');
  assert.strictEqual(soleAutoResult.confirmProof.mode, 'SINGLE_CANDIDATE_AUTO_SUBMITTED');
  assert.deepStrictEqual(soleAuto.calls, ['candidate:0'],
    'auto-submitted one-card prompt is clicked exactly once and never confirmed by stale coordinates');
  assert.deepStrictEqual(soleAutoOrder, ['checkpoint']);

  const soleConfirm = selectionHarness(['M08']);
  const soleConfirmResult = await soleConfirm.run({
    plannedBeforeActivation: { id: 'M08', name: '闪术兵器－H.A.M.P.', originalSlot: 2 }
  });
  assert.strictEqual(soleConfirmResult.confirmProof.mode, 'SINGLE_CANDIDATE_EXPLICIT_CONFIRM');
  assert.deepStrictEqual(soleConfirm.calls, ['candidate:0', 'submit'],
    'one-card prompt that stays open gets one card click followed by one proven confirm');

  const noRaye = selectionHarness(['M04', 'M03', 'M05']);
  assert.strictEqual((await noRaye.run({ lastResort: true })).status, 'NO_SAFE_DARK_IN_PROMPT');
  assert.strictEqual(noRaye.calls.includes('submit'), false);
  assert.strictEqual(noRaye.selectedIndex, null);
  assert.strictEqual(noRaye.calls.length, 6, 'all three DARK candidates inspected and toggled off');
  const hamp = selectionHarness(['M01', 'M08']);
  let hampSubmitCheckpoint = false;
  const hampResult = await hamp.run({ lastResort: true, onBeforeSubmit: async proof => {
    assert.strictEqual(proof.selected.id, 'M08'); hampSubmitCheckpoint = true;
  } });
  assert.strictEqual(hampResult.selected.id, 'M08');
  assert.strictEqual(hampResult.priorityRank, 2);
  assert.strictEqual(hampSubmitCheckpoint, true);
  assert.strictEqual(hamp.calls.filter(call => call === 'submit').length, 1);
  assert.strictEqual(hamp.selectedIndex, 1, 'component protected, HAMP kept selected after submit');
  const raye = selectionHarness(['M04', 'M06', 'M08']);
  let beforeSubmit = false;
  const found = await raye.run({ lastResort: true, onBeforeSubmit: async () => { beforeSubmit = true; } });
  assert.strictEqual(found.selected.id, 'M06');
  assert.strictEqual(beforeSubmit, true);
  assert.strictEqual(raye.calls.filter(call => call === 'submit').length, 1);
  const ordinary = selectionHarness(['M04', 'M08']);
  assert.strictEqual((await ordinary.run({})).selected.id, 'M08', 'normal M13 fallback unchanged');
  const unknown = selectionHarness(['M04', 'UNKNOWN']);
  await assert.rejects(unknown.run({ lastResort: true }), /CANDIDATE_UNKNOWN/);
  assert.strictEqual(unknown.calls.includes('submit'), false);
  const unknownWithHamp = selectionHarness(['UNKNOWN', 'M08']);
  await assert.rejects(unknownWithHamp.run({ lastResort: true }), /CANDIDATE_UNKNOWN/);
  assert.strictEqual(unknownWithHamp.calls.includes('submit'), false);
  const wrongPrompt = selectionHarness(['M10', 'M13']);
  await assert.rejects(wrongPrompt.run({ lastResort: true }), /NON_DARK_CANDIDATE_WRONG_PROMPT/);
  assert.strictEqual(wrongPrompt.calls.includes('submit'), false);

  const options = name => ({ checkpointPath: path.join(temp, `${name}.json`), debugDir: path.join(temp, name) });
  const lost = lifecycleHarness();
  const lostOptions = options('lost');
  assert.strictEqual((await lost.run({ ...lostOptions, observe: lost.observe })).status, 'TERMINAL_SURRENDER');
  assert.strictEqual(readJson(lostOptions.checkpointPath).stage, 'COMPLETE_SURRENDER');
  assert.ok(lost.calls.includes('activate') && lost.calls.includes('surrender'));
  assert.ok(!lost.calls.includes('info') && !lost.calls.includes('observe'));
  const lostCalls = lost.calls.length;
  await lost.run({ ...lostOptions, resume: true });
  assert.strictEqual(lost.calls.length, lostCalls, 'completed recovery has no bridge or input');

  const drawn = lifecycleHarness({ branch: 'RAYE' });
  assert.strictEqual((await drawn.run({ ...options('drawn'), observe: drawn.observe })).status, 'PASS');
  assert.ok(drawn.calls.includes('banish-M06') && drawn.calls.includes('observe'));
  assert.ok(!drawn.calls.includes('surrender'));
  const drawnHamp = lifecycleHarness({ branch: 'HAMP' });
  const drawnHampOptions = options('drawn-hamp');
  assert.strictEqual((await drawnHamp.run({ ...drawnHampOptions, observe: drawnHamp.observe })).status, 'PASS');
  assert.strictEqual(readJson(drawnHampOptions.checkpointPath).stage, 'COMPLETE_HAMP');
  assert.ok(drawnHamp.calls.includes('banish-M08') && drawnHamp.calls.includes('observe'));
  assert.ok(!drawnHamp.calls.includes('surrender'));
  const doneHampCalls = drawnHamp.calls.length;
  await drawnHamp.run({ ...drawnHampOptions, resume: true });
  assert.strictEqual(drawnHamp.calls.length, doneHampCalls);
  // Actual failed checkpoint and supplied scene: only redirect the unsubmitted prompt.
  const legacy = require('../../material/issues/issue-101-allure-before.json');
  const currentScene = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/issues/issue-101-user-scene.png')));
  const points = detectM13BanishCandidateCenters(cropImage(currentScene, { x: 540, y: 790, width: 970, height: 250 }));
  const witness = { points, headerDarkRatio: 0.8, evidenceSource: 'issue-101-user-scene.png' };
  const repaired = recoverLegacyAllurePromptCheckpoint(legacy, witness);
  assert.strictEqual(repaired.stage, 'BANISH_PROMPT_READY');
  assert.strictEqual(repaired.baseline.revision, 2);
  assert.strictEqual(repaired.recoveryProof.safeCandidateIds[0], 'M08');
  for (const bad of [{ ...legacy, stage: 'BANISH_SUBMIT_STARTED' }, { ...legacy, submitProof: {} },
    { ...legacy, banishProof: {} }, { ...legacy, failureProof: { seen: [{ card: { id: 'UNKNOWN' } }] } }]) {
    assert.throws(() => recoverLegacyAllurePromptCheckpoint(bad, witness), /EVIDENCE_INVALID/);
  }
  assert.throws(() => recoverLegacyAllurePromptCheckpoint(legacy, { ...witness, points: [] }), /EVIDENCE_INVALID/);
  const legacyOptions = options('legacy-hamp');
  writeJsonAtomic(legacyOptions.checkpointPath, legacy);
  const legacyStopped = lifecycleHarness({ branch: 'HAMP' });
  await assert.rejects(legacyStopped.run({ ...legacyOptions, resume: true }), /NEEDS_CURRENT_PROMPT_REPAIR/);
  assert.strictEqual(legacyStopped.calls.length, 0, 'old HAMP failure must not resume surrender');
  writeJsonAtomic(legacyOptions.checkpointPath, repaired);
  const legacyResumed = lifecycleHarness({ branch: 'HAMP' });
  await legacyResumed.run({ ...legacyOptions, resume: true, observe: legacyResumed.observe });
  assert.deepStrictEqual(legacyResumed.calls, ['start', 'prompt', 'banish-M08', 'settle', 'stop', 'observe']);
  assert.strictEqual(readJson(legacyOptions.checkpointPath).stage, 'COMPLETE_HAMP');
  const winning = lifecycleHarness({ branch: 'RAYE' });
  const winningOptions = options('winning');
  assert.strictEqual((await winning.run({ ...winningOptions,
    observe: async () => ({ status: 'TERMINAL_VICTORY' }) })).status, 'TERMINAL_VICTORY');
  assert.strictEqual(readJson(winningOptions.checkpointPath).stage, 'COMPLETE_VICTORY');
  assert.ok(!winning.calls.includes('surrender'));
  const emptyCards = ['M10', 'M10', 'M13', 'M14'].map((id, i) => ({ id, index: i + 1 }));
  const empty = lifecycleHarness({ branch: 'NO_DARK', cards: emptyCards });
  assert.strictEqual((await empty.run({ ...options('empty'), observe: empty.observe })).status, 'TERMINAL_SURRENDER');
  assert.ok(empty.calls.indexOf('blue') < empty.calls.indexOf('info'));
  assert.ok(empty.calls.indexOf('info') < empty.calls.indexOf('surrender'));
  assert.ok(!empty.calls.includes('observe'));
  const notEmpty = lifecycleHarness({ branch: 'NO_DARK', cards: emptyCards, infoCount: 7 });
  await assert.rejects(notEmpty.run(options('not-empty')), /EMPTY_HAND_NOT_PROVEN/);
  assert.ok(!notEmpty.calls.includes('surrender'));
  const darkTimeout = lifecycleHarness({ branch: 'NO_DARK' });
  await assert.rejects(darkTimeout.run(options('dark-timeout')), /BANISH_PROMPT_TIMEOUT/);
  assert.ok(!darkTimeout.calls.includes('info') && !darkTimeout.calls.includes('surrender'));

  const failed = lifecycleHarness({ failSurrender: true });
  const failedOptions = options('failed');
  await assert.rejects(failed.run(failedOptions), /SURRENDER_NOT_PROVEN/);
  assert.strictEqual(readJson(failedOptions.checkpointPath).stage, 'SURRENDER_STARTED');
  const recovered = lifecycleHarness();
  await recovered.run({ ...failedOptions, resume: true });
  assert.ok(recovered.calls.includes('surrender'));
  assert.ok(!recovered.calls.includes('activate') && !recovered.calls.includes('prompt'));
  const readyOptions = options('user-confirmed-ready');
  writeJsonAtomic(readyOptions.checkpointPath, { stage: 'SURRENDER_READY', slot: 5,
    baseline: { cards: hand, handCount: 6 }, failureProof: {
      status: 'NO_SAFE_DARK_IN_PROMPT', seen: [{ card: { accepted: true, id: 'M04' } }] } });
  const ready = lifecycleHarness();
  assert.strictEqual((await ready.run({ ...readyOptions, resume: true })).status, 'TERMINAL_SURRENDER');
  assert.deepStrictEqual(ready.calls, ['start', 'surrender', 'stop'],
    'verified failure recovery only surrenders; no activation, scan, INFO or observer');
  assert.strictEqual(readJson(readyOptions.checkpointPath).stage, 'COMPLETE_SURRENDER');
  const oldNoRayeOnly = options('old-no-raye-only');
  writeJsonAtomic(oldNoRayeOnly.checkpointPath, { stage: 'SURRENDER_READY', failureProof: {
    status: 'NO_RAYE_IN_DARK_PROMPT', source: 'LEGACY_NO_HAMP_PROOF' } });
  const oldUnproven = lifecycleHarness();
  await assert.rejects(oldUnproven.run({ ...oldNoRayeOnly, resume: true }), /NEEDS_CURRENT_PROMPT_REPAIR/);
  assert.strictEqual(oldUnproven.calls.length, 0);
  const uncertain = lifecycleHarness({ branch: 'UNKNOWN' });
  const uncertainOptions = options('uncertain');
  await assert.rejects(uncertain.run(uncertainOptions), /CANDIDATE_UNKNOWN/);
  assert.ok(!uncertain.calls.includes('surrender'));
  const uncertainCalls = uncertain.calls.length;
  await assert.rejects(uncertain.run({ ...uncertainOptions, resume: true }), /AMBIGUOUS_STAGE_NO_REPLAY/);
  assert.strictEqual(uncertain.calls.length, uncertainCalls);
  for (const stage of ['BANISH_SUBMIT_STARTED', 'OBSERVER_STARTED']) {
    const uncertainPath = options(stage);
    writeJsonAtomic(uncertainPath.checkpointPath, { stage });
    const h = lifecycleHarness();
    await assert.rejects(h.run({ ...uncertainPath, resume: true }), /AMBIGUOUS_STAGE_NO_REPLAY/);
    assert.strictEqual(h.calls.length, 0);
  }
  const activatedOptions = options('activated');
  writeJsonAtomic(activatedOptions.checkpointPath, { stage: 'ACTIVATED', baseline: { cards: hand, handCount: 6 }, slot: 5 });
  const activated = lifecycleHarness();
  await activated.run({ ...activatedOptions, resume: true });
  assert.ok(!activated.calls.includes('activate') && !activated.calls.includes('baseline'));
  console.log('ALLURE_LAST_RESORT_OFFLINE_PASS; raye/HAMP=CONTINUE; noSafeDark=SURRENDER; noDark=INFO0; unknown=STOP; currentPromptRepair=NO_REACTIVATION');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(temp);
  assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('v6-allure-last-resort-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
