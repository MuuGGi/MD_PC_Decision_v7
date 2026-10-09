'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const policy = require('../../lib/exodia-policy');
const { readPng, cropImage } = require('../../lib/png-utils');
const { compareSweeps } = require('../../lib/dense-hand-segmenter');
const resume = require('../../material/issues/issue-117-m11-resume.json');
const protectedPaths = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/execution/M11_mallet_keep_weapon/_resume/resume_state.json'];
const before = protectedPaths.map(rel => [rel, fs.existsSync(path.join(ROOT, rel))
  ? fs.readFileSync(path.join(ROOT, rel)) : null]);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function segment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}

(async () => {
  const componentIds = [...policy.EXODIA_COMPONENT_IDS, policy.EXODIA_UNKNOWN_ID];
  for (const expected of componentIds) {
    for (const actual of componentIds) {
      assert.strictEqual(policy.sameRuntimeCardIdentity(expected, { id: actual }), true);
    }
    for (const actual of ['', 'UNKNOWN', 'M06', 'M08', 'M11', 'M17']) {
      assert.strictEqual(policy.sameRuntimeCardIdentity(expected, actual), false);
      assert.strictEqual(policy.sameRuntimeCardIdentity(actual, expected), false);
    }
  }
  assert.strictEqual(policy.sameRuntimeCardIdentity('UNKNOWN', 'UNKNOWN'), false);
  assert.strictEqual(policy.sameRuntimeCardIdentity('M06', 'M08'), false);
  assert.strictEqual(policy.sameRuntimeCardIdentity('M06', 'M06'), true);
  assert.strictEqual(compareSweeps({ cards: [{ id: 'M02', accepted: true }, { id: 'M06', accepted: true }] },
    { cards: [{ id: 'EXODIA_UNKNOWN', accepted: true }, { id: 'M06', accepted: true }] }).equal, true);
  assert.strictEqual(compareSweeps({ cards: [{ id: 'M02', accepted: true }] },
    { cards: [{ id: 'M06', accepted: true }] }).equal, false);
  assert.strictEqual(compareSweeps({ cards: [{ id: 'M02', accepted: false }] },
    { cards: [{ id: 'M05', accepted: true }] }).equal, false);

  const file = path.join(ROOT, 'execution/core/m11-mallet-selection.js');
  const nativeRequire = createRequire(file);
  let actualId = 'M02', accepted = true, rawImage, fakeNow = 0;
  const module = { exports: {} };
  const clicks = [], logs = [];
  const context = vm.createContext({ module, exports: module.exports, Buffer, __dirname: path.dirname(file),
    Date: { now: () => fakeNow },
    console: { log: value => logs.push(String(value)) }, require: id => {
      const normalized = id.replace(/\\/g, '/');
      if (normalized.endsWith('lib/win-fast')) return {
        captureReferenceRoi: async (_bridge, _info, roi) => cropImage(rawImage, roi),
        mapReferencePoint: (_info, point) => point, sleep: async ms => { fakeNow += ms; }
      };
      if (normalized.endsWith('runtime/observer/scan-state')) return { saveRgbaPng: () => { throw new Error('unexpected write'); },
        recognizeCurrentCard: async () => ({ judged: { accepted, best: { id: actualId, name: actualId, mad: 0 } } }) };
      if (normalized.endsWith('prompt-submit-timing')) return { waitBeforePromptSubmit: async () => {} };
      return nativeRequire(id);
    } });
  vm.runInContext(read('execution/core/m11-mallet-selection.js'), context, { filename: file });
  const options = { bridge: { click: async (x, y) => clicks.push({ x, y }) }, info: {},
    library: {}, templates: {}, debugDir: null, expectedCard: { id: 'EXODIA_UNKNOWN', name: '组件' }, step: 1 };
  // Execute the exact verifier that failed live, including generic/exact pairs
  // and unaccepted/mixed/ordinary-card negative cases.
  for (const expected of componentIds) {
    for (const actual of componentIds) {
      actualId = actual;
      const result = await context.verifyPromptCardSelection({ ...options, expectedCard: { id: expected } });
      assert.strictEqual(result.id, 'EXODIA_UNKNOWN');
    }
  }
  accepted = false;
  await assert.rejects(context.verifyPromptCardSelection(options), /M11_PROMPT_CARD_VERIFY_FAILED/);
  accepted = true; actualId = 'M06';
  await assert.rejects(context.verifyPromptCardSelection(options), /M11_PROMPT_CARD_VERIFY_FAILED/);
  actualId = 'M08';
  await assert.rejects(context.verifyPromptCardSelection({ ...options, expectedCard: { id: 'M06' } }), /VERIFY_FAILED/);
  actualId = 'M02';
  assert.strictEqual(clicks.length, 0);

  // Exercise the generic dense target wrapper and low-hand lookup with actual
  // production functions, not just the shared comparator in isolation.
  const targetFile = path.join(ROOT, 'execution/core/hand-target.js');
  const targetNativeRequire = createRequire(targetFile), targetModule = { exports: {} };
  let denseCardId = 'M02';
  vm.runInNewContext(read('execution/core/hand-target.js'), { module: targetModule,
    __dirname: path.dirname(targetFile), console: { log() {} }, require: id => {
      if (id.replace(/\\/g, '/').endsWith('capture-hand-scroll-segments-live')) return {
        recognizeDenseTargetSlots: async options => ({ success: true, selectionKept: true,
          recognized: [{ slot: options.targetSlots[0], card: { id: denseCardId },
            recognition: { accepted: true, id: denseCardId }, clickReference: { x: 596, y: 1007 } }] })
      };
      if (id === './low-hand-target') return {};
      return targetNativeRequire(id);
    } });
  const targetApi = targetModule.exports;
  assert.strictEqual(targetApi.findObservedTarget(resume.baseline, 'M02').slot, 1);
  assert.strictEqual(targetApi.findObservedTarget(resume.baseline, 'M05').matches.length, 2);
  const targeted = await targetApi.selectObservedHandCard({ ...options, baseline: resume.baseline,
    expectedId: 'EXODIA_UNKNOWN', debugDir: 'test-only' });
  assert.strictEqual(targeted.slot, 1);
  await assert.rejects(targetApi.selectObservedHandCard({ ...options,
    bridge: { key: async () => {} }, baseline: resume.baseline, expectedId: 'M06', debugDir: 'test-only' }), /TARGET_MISMATCH/);
  const low = vm.createContext({ sameRuntimeCardIdentity: policy.sameRuntimeCardIdentity });
  vm.runInContext(segment(read('execution/core/low-hand-target.js'), 'function findObservedSlot(', 'async function '), low);
  assert.strictEqual(low.findObservedSlot({ handCount: 2, cards: [{ id: 'EXODIA_UNKNOWN' }, { id: 'M06' }] }, 'M02').slot, 1);

  // Real failed-scene pixels: only first candidate has a selected diamond.
  rawImage = await readPng(path.join(ROOT, 'material/issues/issue-117-selected-component.png'));
  const promptImage = cropImage(rawImage, { x: 520, y: 820, width: 1025, height: 225 });
  assert.strictEqual(context.classifyMalletPromptBody(promptImage).modalBodyProven, true);
  for (const x of [596, 754, 912, 1070, 1228, 1386]) {
    assert.strictEqual(context.classifyMalletSelectedBadge(promptImage, { x, y: 925 }).pass, x === 596);
  }
  const realLayout = await context.probeMalletActionLayout(options);
  assert.strictEqual(realLayout.usable.center, true);
  // Physical-center calculation is isolated; real badge, modal, action-strip
  // pixels, identity verifier, and recovery submit code remain production.
  context.resolveVisibleCandidate = async () => ({ ref: { x: 596, y: 925 }, source: 'TEST_MEASURED_FRAME' });
  const recovery = await context.recoverSelectedReturnCard({ ...options, currentCandidateCount: 7,
    candidateIndex: 0, card: resume.plan.remainingCards[0] });
  assert.ok(recovery && recovery.badge.pass);
  assert.strictEqual(clicks.length, 0, 'recovery proves selection without another card click');
  const committed = await context.commitOneReturnCard({ ...options, currentCandidateCount: 7,
    candidateIndex: 0, card: resume.plan.remainingCards[0], preselected: recovery });
  assert.deepStrictEqual(clicks, [{ x: 1024, y: 1082 }], 'only Select is clicked, not the selected card');
  assert.strictEqual(committed.recoveredAlreadySelected, true);

  actualId = 'M17';
  await assert.rejects(context.recoverSelectedReturnCard({ ...options, currentCandidateCount: 7,
    candidateIndex: 0, card: resume.plan.remainingCards[0] }), /VERIFY_FAILED/);
  assert.strictEqual(clicks.length, 1, 'protected/wrong identity never submits');
  actualId = 'M02';
  context.resolveVisibleCandidate = async () => ({ ref: { x: 754, y: 925 } });
  await assert.rejects(context.recoverSelectedReturnCard({ ...options, currentCandidateCount: 7,
    candidateIndex: 1, card: resume.plan.remainingCards[1] }), /AMBIGUOUS_NO_RECLICK/);
  assert.strictEqual(clicks.length, 1, 'a different selected position must not be toggled');

  // Production outer loop must forward the preselection proof to the regular
  // commit path, update class/count receipts once, then leave protected M17.
  context.recoverSelectedReturnCard = async () => recovery;
  const calls = [];
  context.commitOneReturnCard = async args => {
    calls.push({ preselected: Boolean(args.preselected), card: args.card.id });
    return { card: args.card, recoveredAlreadySelected: Boolean(args.preselected) };
  };
  const receipts = [];
  const selection = await context.selectMalletReturnCards({ ...options,
    remainingCards: resume.plan.remainingCards, keepIds: resume.keepIds, resumeSelection: true,
    alreadyCommittedIds: [], onCommitted: async row => receipts.push(Array.from(row.committedIds)) });
  assert.strictEqual(calls.length, 6);
  assert.strictEqual(calls[0].preselected, true);
  assert.ok(calls.slice(1).every(row => !row.preselected));
  assert.strictEqual(selection.selectedCount, 6);
  assert.deepStrictEqual(Array.from(selection.protectedRemaining, card => card.id), ['M17']);
  assert.deepStrictEqual(receipts.at(-1), ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M06', 'M08', 'M08', 'M11']);

  // Incremental evidence compares class multisets, not exact component aliases.
  const observer = read('runtime/observer/observe-hand-change-incremental-live.js');
  const evidence = vm.createContext({ normalizeExodiaComponentCard: policy.normalizeExodiaComponentCard });
  vm.runInContext(segment(observer, 'function sameIdMultiset(', 'function canCommitPureRemovalWithoutPassiveGeometry('), evidence);
  assert.strictEqual(evidence.sameIdMultiset(['M02', 'M05', 'M06'], ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M06']), true);
  assert.strictEqual(evidence.sameIdMultiset(['M02', 'M05'], ['EXODIA_UNKNOWN']), false);
  assert.strictEqual(evidence.sameIdMultiset(['M02', 'M06'], ['EXODIA_UNKNOWN', 'M08']), false);
  // Wiring guards prevent reintroducing strict ID comparisons at these audited consumers.
  for (const rel of ['execution/core/m11-mallet-selection.js', 'execution/core/hand-target.js',
    'execution/core/low-hand-target.js', 'execution/core/executor-preload.js',
    'runtime/observer/capture-hand-scroll-segments-live.js', 'runtime/observer/observe-hand-change-incremental-live.js',
    'lib/dense-hand-segmenter.js']) assert.ok(read(rel).includes('sameRuntimeCardIdentity('), rel);
  assert.ok(read('execution/live/run-m11-mallet-keep-weapon.js').includes('resumeSelection: resumingPartialSelection'));
  for (const [rel, bytes] of before) {
    if (bytes === null) assert.ok(!fs.existsSync(path.join(ROOT, rel)), rel);
    else assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  }
  console.log('COMPONENT_IDENTITY_BOUNDARIES_OFFLINE_PASS; 6x6 class pairs/strict ordinary+unknown guards; actual selected pixels; resume cardClicks0/select1; return6/keepM17; class multiset; stateWrites0/gameInputs0');
})().catch(error => { console.error(error); process.exitCode = 1; });
