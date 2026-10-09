'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const RUN = path.resolve(ROOT, '../runs/2026-10-07T00-58-41-658Z');
const ARCHIVE = path.join(RUN, 'game-00001/before-recovery');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const frame = PNG.sync.read(fs.readFileSync(path.join(ARCHIVE, 'last-guarded-frame.png')));
const previous = json(path.join(ARCHIVE, 'debug/duel-log-live/observer_state.json'));
const previousLog = json(path.join(ARCHIVE, 'debug/duel-log-live/latest_result.json'));
const hand = json(path.join(ARCHIVE, 'debug/hand-change-live/session_state.json'));
const savedDecision = json(path.join(ARCHIVE, 'decision-state.json'));
const source = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const section = (s, a, b) => {
  const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j);
};
const continuity = require('../../lib/observer-log-continuity');
const stateTools = require('../../lib/duel-log-state');
const { findCrossRunTailContinuity } = require('../../lib/duel-log-tail-continuity');

async function bundle() {
  const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
  const loaded = await loadTemplates(ROOT, loadLibrary(ROOT));
  return { loaded,
    labelTemplates: await require('../../lib/duel-log-label-reader').loadDuelLogLabelTemplates(ROOT),
    fieldRowTemplates: await require('../../lib/duel-log-field-rows').loadFieldRowTemplates(ROOT) };
}
function readerReplay(templates, readerText) {
  const file = path.join(ROOT, 'runtime/observer/test-duel-log-live.js'), native = createRequire(file);
  const disk = new Map(), messages = [], module = { exports: {} };
  const stateFile = path.join(ROOT, 'debug/duel-log-live/observer_state.json');
  const resultFile = path.join(ROOT, 'debug/duel-log-live/latest_result.json');
  const put = (f, v) => disk.set(path.resolve(f), Buffer.from(JSON.stringify(v)));
  put(stateFile, previous); put(resultFile, previousLog);
  const deny = () => { throw new Error('NATIVE_INPUT_FORBIDDEN'); };
  const bridge = { info: async () => ({ title: 'masterduel' }), activateMasterDuel: deny,
    click: deny, wheelBurstCaptureReferenceRoi: deny };
  const ctx = vm.createContext({ module, __dirname: path.dirname(file), Buffer, process,
    console: { log: (...a) => messages.push(a.join(' ')) }, require: id => {
      if (id === 'fs') return { mkdirSync() {}, existsSync: f => disk.has(path.resolve(f)),
        readFileSync: (f, encoding) => { const b = disk.get(path.resolve(f));
          if (!b) throw new Error('VIRTUAL_FILE_MISSING:' + f); return encoding ? b.toString(encoding) : b; },
        writeFileSync: (f, b) => disk.set(path.resolve(f), Buffer.from(b)) };
      if (id.endsWith('runtime-files')) return { writeJsonAtomic: put };
      if (id.endsWith('win-fast')) return { MdFastBridge: class { constructor() { deny(); } },
        clientReport: () => ({ clientFullyVisible: true, aspectError: 0, client: {} }), captureReferenceRoi: deny };
      if (id.endsWith('run-timer')) return { RunTimer: class {
        async time(_, fn) { return fn(); } timeSync(_, fn) { return fn(); } finish() {} summary() { return ''; }
      } };
      if (id.endsWith('/recognizer')) return { loadLibrary: () => ({}), loadTemplates: async () => templates.loaded };
      if (id.endsWith('duel-log-label-reader')) return { ...native(id), loadDuelLogLabelTemplates: async () => templates.labelTemplates };
      if (id.endsWith('duel-log-field-rows')) return { ...native(id), loadFieldRowTemplates: async () => templates.fieldRowTemplates };
      if (id.endsWith('png-utils')) return { ...native(id), savePng: deny };
      return native(id);
    } });
  vm.runInContext(readerText, ctx, { filename: file });
  const run = options => module.exports.runDuelLogLive({ ...options, bridge,
    skipActivation: true, skipForegroundReactivate: true, initialScreenshot: frame,
    performanceFast: true, observerFast: true, allowBacktrack: false });
  const adjacent = vm.createContext({ ROOT, path, bridge, console: { log() {} },
    OBSERVER_STATE_PATH: stateFile, LOG_RESULT_PATH: resultFile,
    readBytesIfExists: f => disk.get(path.resolve(f)), readJsonIfExists: f => jsonBuffer(disk.get(path.resolve(f))),
    restoreBytes: (f, b) => b ? disk.set(path.resolve(f), b) : disk.delete(path.resolve(f)),
    runDuelLogLive: run, require: () => ({ waitForSelfPriorityBlue: async () => {} }) });
  vm.runInContext(section(source('execution/core/branch-adjacent-observer.js'),
    'function compactDetail(', 'function isExpectedAdjacentNotReady('), adjacent);
  return { run, messages, disk, adjacent, stateFile, resultFile,
    log: () => jsonBuffer(disk.get(resultFile)), state: () => jsonBuffer(disk.get(stateFile)) };
}
const jsonBuffer = b => b && JSON.parse(b.toString());
async function actualOptionalPool() {
  const file = path.join(ROOT, 'execution/core/optional-effect-prompt-observer.js'), native = createRequire(file);
  const module = { exports: {} };
  const ctx = vm.createContext({ module, __dirname: path.dirname(file), require: id => {
    if (id.endsWith('win-fast')) return { captureReferenceRoi: async (_, __, roi) => require('../../lib/png-utils').cropImage(frame, roi) };
    if (id.endsWith('scan-state')) return { saveRgbaPng() { throw new Error('PNG_WRITE_FORBIDDEN'); } };
    return native(id);
  } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return module.exports.probeOptionalEffectPrompt({ bridge: {}, info: {} });
}
function atoms(pool, observe, { actualTarget = 'E02', failMaterial = false, failPool = false } = {}, text) {
  const events = [], atomic = vm.createContext({ ROOT, path, ROUTE_ROOT: 'MEMORY', TOKEN_ANCHOR: { x: 1024, y: 705 },
    ALL_LINK_IDS: ['E02', 'E03', 'E04', 'E05', 'E10'], console: { log() {} }, ensureDir() {}, timestampId: () => 'OFFLINE',
    loadLibrary: () => ({}), loadTemplates: async () => [], sleep: async () => {},
    startBridge: async () => ({ bridge: { stop: async () => events.push('STOP') }, info: {} }),
    require: () => ({ observeAdjacentLogEventually: options => { events.push('OLD_LOG_VALIDATION'); return observe(options); } }),
    clickExtraDeckSummonButton: async () => events.push('OPEN_EXTRA'), waitForSummonCandidates: async () => ({}),
    selectNextLegalLink: async () => { events.push('IDENTIFY_LINK'); return { selected: { id: actualTarget } }; },
    clickBottomSummonSubmit: async () => events.push('SUBMIT_LINK'),
    proveCarrierMaterialSelectable: async () => {}, clickCarrierMaterial: async () => events.push('MATERIAL'),
    clickMaterialBlueConfirm: async () => { events.push('CONFIRM'); if (failMaterial) throw new Error('RESPONSE_BLOCKED'); },
    waitForPostLinkOptionalPool: async () => { events.push('CURRENT_POOL'); if (failPool) throw new Error('POOL_NOT_READY'); return pool; }
  });
  vm.runInContext(section(text, 'async function runHornetTokenToKagariLinkAtomic(', 'async function runKagariEffectToRecoveryPromptAtomic(') +
    section(source('execution/core/atomic-route-executor.js'), 'async function selectSpecificLink(', 'function chooseYellowComponent(') +
    section(source('execution/core/atomic-route-executor.js'), 'function buildUnequippedKagariGainProof(', 'function buildYotoSingleLinkResolutionProof('), atomic);
  return { atomic, events };
}
function mainHarness(atom) {
  let saved = structuredClone(savedDecision), commits = [];
  const text = source('runtime/main-v6.js');
  const ctx = vm.createContext({ console: { log() {} },
    loadDecisionState: () => structuredClone(saved), saveDecisionState: v => { saved = v; commits.push(v.v5Branch.currentState); },
    prepareSwordForPlannedKagari: async () => null, hornetTrueYotoWindPlan: () => null,
    runHornetTokenToKagariLinkAtomic: opts => atom.atomic.runHornetTokenToKagariLinkAtomic(opts),
    runKagariEffectToRecoveryPromptAtomic: async () => { atom.events.push('H2_ONLY'); return {}; }
  });
  vm.runInContext(section(text, 'function branchCarrierId(', 'function clearAtomicBranch(') +
    section(text, 'async function executeFieldTransition(', 'async function executeAtomicResponseInterval('), ctx);
  return { ctx, commits, get saved() { return saved; } };
}
async function test() {
  const templates = await bundle(), pool = await actualOptionalPool();
  assert.strictEqual(pool.visible, true); assert.strictEqual(pool.candidateCount, 1);
  const oldText = fs.readFileSync(path.join(RUN, 'engine-source/runtime/observer/test-duel-log-live.js'), 'utf8');
  const oldAtoms = fs.readFileSync(path.join(RUN, 'engine-source/execution/core/atomic-route-executor.js'), 'utf8');
  const old = readerReplay(templates, oldText);
  await old.run({ expectedAtomicActivationKey: 'M22' });
  assert.strictEqual(old.log().newOperationBlocks.length, 0);
  assert.strictEqual(old.log().extendedOperationBlocks.length, 0);
  assert.strictEqual(old.log().observerFieldTransitions[0].to, 'E02', 'old reader actually recognized Kagari');
  const broken = atoms(pool, opts => old.adjacent.observeAdjacentLog(opts), {}, oldAtoms);
  await assert.rejects(broken.atomic.runHornetTokenToKagariLinkAtomic({ state: hand }), /EXPECTED_ADJACENT_BLOCK_NOT_FOUND/);
  const current = readerReplay(templates, source('runtime/observer/test-duel-log-live.js'));
  const observed = await current.adjacent.observeAdjacentLog({ bridge: {}, label: 'H1_REPLAY',
    expectedActivationKey: 'M22', expectedMode: 'new-or-extended', requiredDetails: [{ cardId: 'E02', roleIncludes: 'LINK_SUMMON' }] });
  assert.strictEqual(observed.proof.acceptedBlockSource, 'EXTENDED_BLOCK');
  assert.strictEqual(observed.proof.upwardBacktrackSteps, 0);
  assert.strictEqual(current.log().newOperationBlocks.length, 0, 'old Hornet must not be consumed twice');
  assert.strictEqual(current.log().extendedOperationBlocks.length, 1);
  assert.strictEqual(current.log().observerFieldTransitions.length, 1);
  assert.strictEqual(current.log().bottomTailContinuity.matched, false, 'real failed primary-tail path reproduced');
  const block = current.log().extendedOperationBlocks[0];
  await current.run({ expectedAtomicActivationKey: 'M22' });
  assert.strictEqual(current.log().extendedOperationBlocks.length, 0, 'same saved Link is not a fresh extension');

  for (const kind of ['CROSS_RUN_TAIL_OVERLAP', 'SELF_ACTIVATION', 'CHECKPOINT_EXTENSION', 'HORNET_LINK_CONTINUATION']) {
    for (const target of ['E02', 'E10']) {
      const b = structuredClone(block); b.details.find(d => d.rawType === 'LINK_SUMMON').card.id = target;
      if (kind === 'HORNET_LINK_CONTINUATION') b.details = b.details.filter(d => d.rawType !== 'SPECIAL_SUMMON');
      const o = { checkpointFound: true, matchedAnchor: { kind, source: 'VISIBLE_OPERATION_BLOCK', linkTarget: target }, newBlocks: [] };
      const receipts = []; continuity.finalizeFieldOperationContract(o, [b], previous.checkpoint, receipts);
      assert.strictEqual(o.extendedBlocks.length, 1); assert.strictEqual(receipts.length, 1); assert.strictEqual(receipts[0].to, target);
      continuity.finalizeFieldOperationContract(o, [b], previous.checkpoint, receipts);
      assert.strictEqual(o.extendedBlocks.length, 1); assert.strictEqual(receipts.length, 1);
    }
  }
  for (const mutate of [b => { b.details = b.details.filter(d => d.rawType !== 'LINK_SUMMON'); },
    b => { b.details.find(d => d.rawType === 'LINK_SUMMON').side = 'OPPONENT'; },
    b => { b.details.find(d => d.rawType === 'LINK_SUMMON').inferred = true; },
    b => { b.details.push(structuredClone(b.details.find(d => d.rawType === 'LINK_SUMMON'))); }]) {
    const b = structuredClone(block); mutate(b);
    const o = { checkpointFound: true, matchedAnchor: { source: 'VISIBLE_OPERATION_BLOCK' }, newBlocks: [] };
    continuity.finalizeFieldOperationContract(o, [b], previous.checkpoint, []);
    assert.strictEqual(o.extendedBlocks, undefined);
  }
  const already = { checkpointFound: true, matchedAnchor: { source: 'VISIBLE_OPERATION_BLOCK' }, newBlocks: [] };
  continuity.finalizeFieldOperationContract(already, [block], stateTools.checkpointFrom([block]), []);
  assert.strictEqual(already.extendedBlocks, undefined);

  const good = atoms(pool, () => { throw new Error('OLD_LOG_SHOULD_NOT_RUN'); }, {}, source('execution/core/atomic-route-executor.js'));
  const parent = mainHarness(good), result = await parent.ctx.executeFieldTransition({ state: hand });
  assert.strictEqual(result.state, hand); assert.strictEqual(parent.saved.v5Branch.currentState, 'KAGARI_EFFECT_PENDING');
  assert.strictEqual(parent.commits[0], 'HORNET_KAGARI_LINK_IN_FLIGHT');
  assert.strictEqual(parent.saved.effectUsage.KAGARI_RECOVERY, undefined, 'summon proof is not an effect/gain proof');
  assert.strictEqual(good.events.includes('OLD_LOG_VALIDATION'), false);
  await parent.ctx.executeFieldTransition({ state: hand });
  assert.strictEqual(good.events.filter(e => e === 'SUBMIT_LINK').length, 1);
  assert.strictEqual(good.events.at(-1), 'H2_ONLY');
  for (const opts of [{ actualTarget: 'E03' }, { failMaterial: true }, { failPool: true }]) {
    const bad = atoms(pool, () => {}, opts, source('execution/core/atomic-route-executor.js')), m = mainHarness(bad);
    await assert.rejects(m.ctx.executeFieldTransition({ state: hand }), /MISMATCH|RESPONSE_BLOCKED|POOL_NOT_READY/);
    assert.strictEqual(m.saved.v5Branch.currentState, 'HORNET_KAGARI_LINK_IN_FLIGHT');
    const count = bad.events.length; await m.ctx.executeFieldTransition({ state: hand }); assert.strictEqual(bad.events.length, count, 'no replay after interruption');
    if (opts.actualTarget) assert.strictEqual(bad.events.includes('SUBMIT_LINK'), false);
  }
  for (const p of [{ ...pool, visible: false }, { ...pool, candidateCount: 0 }, { ...pool, candidateCount: 2 }]) {
    const bad = atoms(p, () => {}, {}, source('execution/core/atomic-route-executor.js'));
    let committed = false; await assert.rejects(bad.atomic.runHornetTokenToKagariLinkAtomic({ state: hand,
      onOptionalPoolProven: () => { committed = true; } }), /NOT_SINGLE|NOT_PROVEN/);
    assert.strictEqual(committed, false);
  }
  await assert.rejects(good.atomic.runHornetTokenToKagariLinkAtomic({ state: hand,
    onOptionalPoolProven: () => { throw new Error('PERSIST_FAILED'); } }), /PERSIST_FAILED/);
  console.log('HORNET_KAGARI_FIELD_CONTRACT_OFFLINE_PASS; actual H1 old recognized/false failure -> shared extension + physical commit; all continuity paths; self/unique/fresh guards; no replay after response/unknown; effect not precommitted; nativeInputs=0/liveWrites=0');
}
test().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
