'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const { createRequire } = require('module');
const RUN = path.resolve(ROOT, '../runs/2026-10-03T15-12-58-130Z');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const image = file => PNG.sync.read(fs.readFileSync(file));
const { cropImage } = require('../../lib/png-utils');
const { observerReplay } = require('./test-observer-replay-harness-offline');
const { beginTransaction, completeTransaction, validateTransaction, reconcileTransactionBottom } = require('../../lib/atomic-log-transaction');
const { findCrossRunTailContinuity } = require('../../lib/duel-log-tail-continuity');
const { buildActivationBlocks, annotateBlockRelationships, reconcileExpectedAtomicBottom } = require('../../lib/duel-log-state');
const reader = require('../../runtime/observer/test-duel-log-live');
const config = require('../../live-config');

async function templates() {
  const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
  const library = loadLibrary(ROOT), loaded = await loadTemplates(ROOT, library);
  return { phaseTemplate: null, loaded,
    cardTemplates: loaded.map(item => ({ ...item.card, image: item.image })),
    labelTemplates: await require('../../lib/duel-log-label-reader').loadDuelLogLabelTemplates(ROOT),
    fieldRowTemplates: await require('../../lib/duel-log-field-rows').loadFieldRowTemplates(ROOT) };
}
function recognizedLog(frame, bundle) {
  const log = reader.recognizeDuelLogScreenshot(frame, bundle, { skipMain1Search: true });
  const grouped = buildActivationBlocks(log.events);
  annotateBlockRelationships(grouped.blocks);
  return { ...log, operationBlocks: grouped.blocks, newOperationBlocks: grouped.blocks.slice(-1),
    newActivationBlocks: grouped.blocks.slice(-1) };
}
async function replayLogReader({ previous, previousLog, frame, receipt, bundle }) {
  const disk = new Map(), messages = [], file = path.join(ROOT, 'runtime/observer/test-duel-log-live.js');
  const stateFile = path.join(ROOT, 'debug/duel-log-live/observer_state.json');
  const resultFile = path.join(ROOT, 'debug/duel-log-live/latest_result.json');
  const put = (name, value) => disk.set(path.resolve(name), Buffer.from(JSON.stringify(value)));
  put(stateFile, previous); put(resultFile, previousLog);
  const native = createRequire(file), module = { exports: {} }, info = { title: 'masterduel' };
  const forbidden = () => { throw new Error('NATIVE_INPUT_FORBIDDEN'); };
  const bridge = { info: async () => info, activateMasterDuel: forbidden, click: forbidden,
    wheelBurstCaptureReferenceRoi: forbidden };
  const context = vm.createContext({ module, __dirname: path.dirname(file), process, Buffer,
    console: { log: (...args) => messages.push(args.join(' ')) }, require: id => {
      if (id === 'fs') return { mkdirSync() {}, existsSync: name => disk.has(path.resolve(name)),
        readFileSync: (name, encoding) => { const value = disk.get(path.resolve(name));
          if (!value) throw new Error('UNEXPECTED_DISK_READ:' + name);
          return encoding ? value.toString(encoding) : value; },
        writeFileSync: (name, value) => disk.set(path.resolve(name), Buffer.from(value)) };
      if (id.endsWith('runtime-files')) return { writeJsonAtomic: put };
      if (id.endsWith('win-fast')) return { MdFastBridge: class { constructor() { forbidden(); } },
        clientReport: () => ({ clientFullyVisible: true, aspectError: 0, client: {} }) };
      if (id.endsWith('run-timer')) return { RunTimer: class {
        async time(_, fn) { return fn(); } timeSync(_, fn) { return fn(); } finish() {} summary() { return ''; }
      } };
      if (id.endsWith('/recognizer')) return { loadLibrary: () => ({}), loadTemplates: async () => bundle.loaded };
      if (id.endsWith('duel-log-label-reader')) return { ...native(id), loadDuelLogLabelTemplates: async () => bundle.labelTemplates };
      if (id.endsWith('duel-log-field-rows')) return { ...native(id), loadFieldRowTemplates: async () => bundle.fieldRowTemplates };
      return native(id);
    } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  await module.exports.runDuelLogLive({ bridge, skipActivation: true, skipForegroundReactivate: true,
    initialScreenshot: frame, performanceFast: true, expectedAtomicActivationKey: 'M17',
    allowBacktrack: false, atomicLogTransaction: receipt });
  return { log: JSON.parse(disk.get(resultFile)), state: JSON.parse(disk.get(stateFile)), messages };
}
async function replayReceiptAdapter({ previous, baseline, frame, execution }) {
  const file = path.join(ROOT, 'execution/core/atomic-log-observation.js'), native = createRequire(file);
  const disk = new Map(), put = (name, value) => disk.set(path.resolve(name), JSON.stringify(value));
  put(path.join(ROOT, 'debug/hand-change-live/session_state.json'), baseline);
  put(path.join(ROOT, 'debug/duel-log-live/observer_state.json'), previous);
  const module = { exports: {} }, context = vm.createContext({ module, __dirname: path.dirname(file),
    require: id => {
      if (id === 'fs') return { existsSync: name => disk.has(path.resolve(name)) };
      if (id.endsWith('runtime-files')) return { readJson: name => JSON.parse(disk.get(path.resolve(name))), writeJsonAtomic: put };
      if (id.endsWith('win-fast')) return { captureReferenceRoi: async () => frame };
      return native(id);
    } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  // Standalone baseline adapters omit revision; the protocol must use the
  // persisted hand revision and explicit CLI key even without parent env.
  const draft = await module.exports.beginAtomicLogObservation({ baseline: { ...baseline, revision: undefined }, activationKey: 'M17' });
  const args = module.exports.completeAtomicLogObservation(draft, { ...execution,
    gainCount: 2, firstGainId: 'M06', confirmationProofs: [true, true, true] }, 'MEMORY_ONLY');
  const policy = require('../../lib/incremental-observer-policy');
  assert.strictEqual(policy.expectedAtomicActivationKey({ argv: args, env: {} }), 'M17');
  const receipt = JSON.parse(disk.get(path.resolve(args.find(arg => arg.startsWith('--atomic-log-transaction=')).split('=').slice(1).join('='))));
  validateTransaction(receipt, { baseline, logBefore: previous, activationKey: 'M17' });
  await assert.rejects(module.exports.beginAtomicLogObservation({ baseline: { ...baseline, cards: [] }, activationKey: 'M17' }), /BASELINE_CHANGED/);
  put(path.join(ROOT, 'debug/duel-log-live/observer_state.json'), { ...previous, checkpoint: null });
  assert.strictEqual(await module.exports.beginAtomicLogObservation({ baseline, activationKey: 'M17' }), null,
    'empty Main1: no receipt required; the mature first-operation path stays available');
}
async function test() {
  const bundle = await templates(), archive = path.join(RUN, 'game-00004/before-recovery');
  const previous = json(path.join(archive, 'debug/duel-log-live/observer_state.json'));
  const previousLog = json(path.join(archive, 'debug/duel-log-live/latest_result.json'));
  const baseline = json(path.join(archive, 'debug/hand-change-live/session_state.json'));
  const frame = image(path.join(archive, 'last-guarded-frame.png'));
  const log = recognizedLog(frame, bundle);
  assert.deepStrictEqual(log.operationBlocks.map(b => b.activationKey), ['M17', 'M17']);
  assert.strictEqual(findCrossRunTailContinuity(previous.tailBlocks, log.operationBlocks).matched, false);
  assert.strictEqual(reconcileExpectedAtomicBottom(previous, log.operationBlocks, 'M17'), null,
    'reproduce old repeated-activation ambiguity; generic matcher must stay closed');
  const execution = json(path.join(RUN, 'game-00004/runtime-debug/execution/M17_engage_bonus_draw/2026-10-03T15-32-41-335Z/execution_click.json'));
  await replayReceiptAdapter({ previous, baseline,
    frame: image(path.join(archive, 'debug/duel-log-live/latest_client.png')), execution });
  const draft = beginTransaction({ baseline, logBefore: previous, bottomThumb: previousLog.logPanelDetection.thumb,
    activationKey: 'M17', now: Date.now() - 100 });
  const receipt = completeTransaction(draft, { ...execution, gainCount: 2, firstGainId: 'M06',
    confirmationProofs: [execution.searchProof.selected.accepted, execution.bonusProof.clicked] });
  validateTransaction(receipt, { baseline, logBefore: previous, activationKey: 'M17' });
  const thumb = reader.detectLogScrollbarThumb(frame);
  const boundary = reconcileTransactionBottom(previous, log.operationBlocks, receipt, thumb);
  assert.ok(boundary); assert.strictEqual(boundary.newBlocks.length, 1);
  assert.deepStrictEqual(boundary.newBlocks[0].details.filter(d => d.role === 'HAND_GAIN_CANDIDATE').map(d => d.card.id), ['M06', 'M13']);
  for (const bad of [null, { ...thumb, top: receipt.bottomThumb.top }, { ...thumb, atBottom: false }])
    assert.strictEqual(reconcileTransactionBottom(previous, log.operationBlocks, receipt, bad), null);
  assert.strictEqual(reconcileTransactionBottom(previous, log.operationBlocks, { ...receipt, firstGainId: 'M08' }, thumb), null);
  for (const change of [{ baselineFingerprint: 'wrong' }, { logFingerprint: 'old' },
    { completedAt: Date.now() - 120001 }, { executionConfirmed: false }, { gainCount: 99 }]) {
    assert.throws(() => validateTransaction({ ...receipt, ...change }, { baseline, logBefore: previous, activationKey: 'M17' }), /NOT_CURRENT/);
  }
  assert.throws(() => completeTransaction(draft, { ...execution, gainCount: 2, firstGainId: 'M06', confirmationProofs: [false] }), /UNPROVEN/);
  await assert.rejects(replayLogReader({ previous, previousLog, frame, bundle }), /BOTTOM_ONLY_CHECKPOINT_NOT_PROVEN/);
  const production = await replayLogReader({ previous, previousLog, frame, bundle, receipt });
  assert.strictEqual(production.log.continuity, 'CONTINUOUS_EXECUTOR_TRANSACTION_APPEND');
  assert.strictEqual(production.log.newOperationBlocks.length, 1);
  assert.strictEqual(production.state.atomicActionId, receipt.actionId);
  assert.strictEqual(production.log.scrollBacktracking.performed, false);
  const { waitForAtomicDrawResolution, inspectAtomicDrawResolution } = require('../../lib/atomic-draw-resolution');
  assert.strictEqual(inspectAtomicDrawResolution(production.log, 'M17', 2).ready, true);
  let currentLog = { newOperationBlocks: [{ ...production.log.newOperationBlocks[0], details: [] }] }, clock = 0;
  const matured = await waitForAtomicDrawResolution({ activationKey: 'M17', expectedGainCount: 2,
    readLog: () => currentLog, now: () => clock, delay: async ms => { clock += ms; },
    refresh: async () => { currentLog = production.log; } });
  assert.strictEqual(matured.polls, 1);
  const h = observerReplay({ archive, passiveImage: cropImage(frame, config.handFan.detectRoi), handCount: 7,
    mutateLog: target => Object.assign(target, production.log) });
  await h.run();
  const result = h.json(h.resultPath);
  assert.strictEqual(result.status, 'PASS');
  assert.deepStrictEqual(Array.from(result.after.cards, c => c.id), ['EXODIA_UNKNOWN', 'M06', 'M08', 'M08', 'M12', 'M13', 'M14']);
  const beforeLedger = JSON.parse(h.before.find(([f]) => f === h.ledgerPath)[1]);
  const afterLedger = h.json(h.ledgerPath);
  for (const id of ['M06', 'M13']) assert.strictEqual(afterLedger.outsideDeckCounts[id], Number(beforeLedger.outsideDeckCounts[id] || 0) + 1);
  assert.ok(result.finalClicks.every(c => !c.physicalClicksIssued));

  // Both H3 failures: real title projection is 4 despite INFO=5. The semantic
  // transaction must not depend on click geometry when no card click is needed.
  for (const [game, attempt] of [[2, '2026-10-03T15-19-06-466Z'], [3, '2026-10-03T15-26-53-101Z']]) {
    const base = path.join(RUN, `game-${String(game).padStart(5, '0')}/completed`);
    const hornetDir = path.join(base, 'debug/execution/M22_hornet_drones');
    const actualAttempt = fs.existsSync(path.join(hornetDir, attempt)) ? attempt : fs.readdirSync(hornetDir)[0];
    const before = json(path.join(hornetDir, actualAttempt, 'hand_incremental_result.json')).after;
    const passive = image(path.join(base, `debug/hand-change-live/revision_${before.revision + 1}/passive_hand.png`));
    assert.strictEqual(require('../../lib/hand-state').estimateHandCountByTitleComponents(passive).count, 4);
    const recovery = { activationKey: 'E02', signature: 'E02|PROCESSING_CARD:M17',
      activation: { card: { id: 'E02', name: '闪刀姬－篝' }, side: 'SELF' },
      details: [{ type: 'PROCESSING_CARD', rawType: 'RETURN_TO_HAND', role: 'HAND_GAIN_CANDIDATE',
        side: 'SELF', card: { id: 'M17', name: '闪刀起动－交闪' } }] };
    const setup = extra => observerReplay({ archive: base, passiveImage: passive, handCount: 5,
      mutateHand: state => { Object.keys(state).forEach(k => delete state[k]); Object.assign(state, before); },
      mutateLog: target => { target.newOperationBlocks = [recovery]; target.newActivationBlocks = [recovery];
        target.operationBlocks = [recovery]; target.observerFieldTransitions = []; }, ...extra });
    const legacy = setup({ sourceRoot: path.join(RUN, 'engine-source') });
    await assert.rejects(legacy.run(), /PASSIVE_CURRENT_HAND_COMPONENTS_UNAVAILABLE/);
    const current = setup(); await current.run();
    assert.strictEqual(current.json(current.resultPath).after.handCount, 5);
    assert.ok(current.messages.some(m => m.includes('记账采用 INFO')));
    assert.ok(current.json(current.resultPath).finalClicks.every(c => !c.physicalClicksIssued));
    assert.strictEqual(current.json(current.resultPath).insertedCards[0].card.id, 'M17');
    const badInfo = setup({ handCount: 6 }); await assert.rejects(badInfo.run(), /HAND_COUNT|UNRESOLVED|UNAVAILABLE/);
  }
  console.log('OCT03_TRANSACTION_BOUNDARIES_OFFLINE_PASS; repeated Engage real pixels + executor append receipt + full observer/ledger; H3 real 4-title/5-card cases; stale/missing receipt and wrong INFO closed; nativeInputs=0');
}
if (require.main === module) test().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { test };
