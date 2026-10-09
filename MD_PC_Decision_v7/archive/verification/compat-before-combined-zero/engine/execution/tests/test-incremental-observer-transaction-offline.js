'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '../..');
const fixture = filename => JSON.parse(fs.readFileSync(path.join(ROOT, 'material/issues', filename), 'utf8'));
const failed = fixture('issue-099-m12-failed-incremental.json');
const log = fixture('issue-099-m12-log.json');
const originalLedger = fixture('issue-099-ledger-before.json');
const decision = fixture('issue-099-decision-before.json');
const library = require('../../card-library.json');
const locator = require('../../lib/incremental-hand-locator');
const exodiaPolicy = require('../../lib/exodia-policy');
const { assertNoNewHandClicks } = require('../../lib/incremental-observer-policy');
const handPath = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const ledgerPath = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const resultPath = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
const pendingPath = path.join(ROOT, 'debug/hand-change-live/pending_observer_transaction.json');
function between(source, start, end) {
  const i = source.indexOf(start), j = source.indexOf(end, i);
  assert.ok(i >= 0 && j > i, start);
  return source.slice(i, j);
}
function isolated(before, ledger) {
  const files = new Map(), writes = [];
  let failWrite = null;
  const put = (filename, value) => files.set(filename, Buffer.from(JSON.stringify(value)));
  put(handPath, before); put(ledgerPath, ledger); put(resultPath, { old: 'PASS' });
  put(path.join(ROOT, 'card-library.json'), library); put(path.join(ROOT, 'decision-state.json'), decision);
  const fakeFs = { existsSync: filename => files.has(filename),
    readFileSync: (filename, encoding) => {
      if (!files.has(filename)) throw new Error(`Missing in-memory file: ${filename}`);
      return encoding ? files.get(filename).toString(encoding) : Buffer.from(files.get(filename));
    } };
  const runtimeFiles = {
    readJsonIfExistsSafe: filename => files.has(filename) ? JSON.parse(files.get(filename)) : null,
    writeJsonAtomic: (filename, value) => {
      writes.push(filename);
      if (failWrite === filename) { failWrite = null; throw new Error('INJECTED_DISK_FAILURE'); }
      put(filename, value);
    },
    restoreBuffer: (filename, buffer) => {
      if (buffer == null) files.delete(filename); else files.set(filename, Buffer.from(buffer));
    }
  };
  function load(relative, overrides) {
    const filename = path.join(ROOT, relative), mod = { exports: {} };
    const actualRequire = Module.createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports,
      __dirname: path.dirname(filename), Buffer, process, console: { log() {} },
      require: request => Object.hasOwn(overrides, request) ? overrides[request] : actualRequire(request) },
    { filename });
    return mod.exports;
  }
  const ledgerModule = load('lib/main-deck-ledger.js', { './runtime-files': runtimeFiles });
  const transaction = load('lib/incremental-observer-transaction.js', {
    fs: fakeFs, './runtime-files': runtimeFiles, './main-deck-ledger': ledgerModule });
  return { files, writes, transaction, runtimeFiles, setFailWrite: filename => { failWrite = filename; } };
}
function correctedBefore() {
  const before = structuredClone(failed.before);
  const row = before.cards.find(card => card.id === 'M05');
  row.id = 'M03'; row.name = '被封印的右腕'; row.candidateIds = ['M03'];
  const ledger = structuredClone(originalLedger);
  ledger.outsideDeckCounts.M05 -= 1; ledger.outsideDeckCounts.M03 += 1;
  return { before, ledger };
}
const source = fs.readFileSync(path.join(ROOT, 'runtime/observer/observe-hand-change-incremental-live.js'), 'utf8');
const denseProduction = between(source, '    const denseFanMode =', '    let inference =');
async function runNormalDense(harness, before) {
  const inputs = [], actualBlock = log.newOperationBlocks.find(block => block.activationKey === 'M12');
  const context = { ...locator, assertNoNewHandClicks, path, library, state: before, latestBlock: actualBlock,
    PERSISTENT_EXODIA_IDS: exodiaPolicy.buildExodiaComponentSet(),
    EXODIA_UNKNOWN_ID: exodiaPolicy.EXODIA_UNKNOWN_ID,
    normalizeExodiaComponentCard: exodiaPolicy.normalizeExodiaComponentCard,
    blocks: log.operationBlocks || log.newOperationBlocks, effectiveLog: log, observedHandCount: 8,
    nextRevision: Number(before.revision) + 1, passivePath: 'SAVED_PASSIVE_HAND',
    STATE_PATH: handPath, DEBUG_DIR: path.dirname(handPath), infoOutput: { result: failed.info },
    timer: { timeSync: (_, fn) => fn(), time: async (_, fn) => fn() },
    commitIncrementalObserverResult: harness.transaction.commitIncrementalObserverResult,
    bridge: { key: async () => inputs.push('key'), click: async () => inputs.push('click') },
    recognizeDenseTargetSlots: async () => { inputs.push('new-card-click'); throw new Error('Unexpected new-card click'); },
    runDenseHandScan: async () => { inputs.push('full-hand-scan'); throw new Error('Forbidden full-hand scan'); },
    console: { log() {}, error() {} } };
  const execute = vm.runInNewContext(`(async function () { ${denseProduction} })`, context);
  try { await execute(); } catch (error) { error.inputs = inputs; throw error; }
  return inputs;
}

(async () => {
  const { before, ledger } = correctedBefore();
  const valid = isolated(before, ledger);
  const inputs = await runNormalDense(valid, before);
  assert.deepStrictEqual(inputs, [], 'normal M12 eight-card path does not click or rescan hand');
  const after = JSON.parse(valid.files.get(handPath));
  assert.deepStrictEqual(after.cards.map(card => card.id),
    ['M01', 'M02', 'M03', 'EXODIA_UNKNOWN', 'M06', 'M12', 'M14', 'M16']);
  assert.strictEqual(after.revision, 7);
  const committedLedger = JSON.parse(valid.files.get(ledgerPath));
  assert.strictEqual(committedLedger.lastHandRevision, 7);
  assert.strictEqual(committedLedger.outsideDeckCounts.M03, 1);
  assert.strictEqual(committedLedger.outsideDeckCounts.M05, 0);
  assert.strictEqual(committedLedger.unknownExodiaOutsideCount, 1);
  assert.strictEqual(committedLedger.outsideDeckCounts.M14, 1);
  assert.strictEqual(valid.writes[0], ledgerPath, 'ledger validates before exposing the hand');
  const incremental = JSON.parse(valid.files.get(resultPath));
  assert.strictEqual(incremental.inference.costConsumed[0].id, 'M08');
  assert.ok(incremental.finalClicks.every(row => row.physicalClicksIssued === 0));

  const ambiguous = isolated(failed.before, originalLedger);
  assert.deepStrictEqual(await runNormalDense(ambiguous, failed.before), [],
    'another component draw is valid without deciding whether the earlier component was M05');
  const ambiguousAfter = JSON.parse(ambiguous.files.get(handPath));
  assert.strictEqual(ambiguousAfter.cards.filter(card => card.id === 'EXODIA_UNKNOWN').length, 1);
  const ambiguousLedger = JSON.parse(ambiguous.files.get(ledgerPath));
  assert.strictEqual(ambiguousLedger.outsideDeckCounts.M05, 1);
  assert.strictEqual(ambiguousLedger.unknownExodiaOutsideCount, 1);
  // Normal new-duel scans already emit anonymous components. Exercise that
  // real eight-card path as well: adding a component updates only the class
  // count; no exact ordering, new-card probe or full-hand rescan is needed.
  const anonymousBefore = structuredClone(before);
  anonymousBefore.cards = anonymousBefore.cards.map(card => exodiaPolicy.normalizeExodiaComponentCard(card));
  const anonymousLedger = structuredClone(ledger);
  anonymousLedger.unknownExodiaOutsideCount = 0;
  for (const id of exodiaPolicy.EXODIA_COMPONENT_IDS) {
    anonymousLedger.unknownExodiaOutsideCount += anonymousLedger.outsideDeckCounts[id] || 0;
    anonymousLedger.outsideDeckCounts[id] = 0;
  }
  const anonymous = isolated(anonymousBefore, anonymousLedger);
  assert.deepStrictEqual(await runNormalDense(anonymous, anonymousBefore), []);
  const anonymousAfter = JSON.parse(anonymous.files.get(handPath));
  assert.strictEqual(exodiaPolicy.countExodiaComponents(anonymousAfter.cards), 4);
  assert.deepStrictEqual(anonymousAfter.cards.slice(0, 4).map(card => card.id), Array(4).fill('EXODIA_UNKNOWN'));
  assert.deepStrictEqual(anonymousAfter.cards.slice(4).map(card => card.id), ['M06', 'M12', 'M14', 'M16']);
  assert.strictEqual(JSON.parse(anonymous.files.get(ledgerPath)).unknownExodiaOutsideCount, 4);
  const diskFailure = isolated(before, ledger);
  const diskBefore = [...diskFailure.files].map(([filename, value]) => [filename, value.toString()]);
  diskFailure.setFailWrite(handPath);
  await assert.rejects(runNormalDense(diskFailure, before), /INJECTED_DISK_FAILURE/);
  assert.deepStrictEqual([...diskFailure.files].map(([filename, value]) => [filename, value.toString()]), diskBefore);

  const pending = ambiguous.transaction.recordFailedIncrementalObservation({ activationKey: 'M12',
    selectedCardId: 'M12', selectedSlot: 6, before: failed.before, decisionBefore: decision, log,
    error: new Error('ledger conflict') });
  assert.strictEqual(pending.status, 'OBSERVATION_FAILED');
  assert.strictEqual(ambiguous.transaction.loadPendingIncrementalObservation(failed.before).activationKey, 'M12');
  assert.throws(() => ambiguous.transaction.loadPendingIncrementalObservation({ ...failed.before, revision: 7 }),
    /BASELINE_INVALID/);
  assert.strictEqual(ambiguous.transaction.recordFailedIncrementalObservation({ activationKey: 'M21',
    selectedCardId: 'M18', before: failed.before }), null, 'staged M18 observer retains its mature recovery owner');

  const mainSource = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
  const runtimeProduction = between(mainSource, 'async function resumePendingIncrementalAtDecision(',
    'function loadCurrentDecisionWithoutRescan(');
  for (const answer of ['q', 'r', '', 'FAIL', 'VICTORY']) {
    const calls = [];
    const context = { console: { log() {}, error() {} }, PENDING_OBSERVER_PATH: pendingPath,
      loadPendingIncrementalObservation: () => pending,
      assertFreshRuntimeBeforeGameAction: () => calls.push('freshness'),
      runExecutor: (file, slot, card) => {
        calls.push(file);
        assert.strictEqual(file, 'runtime/observer/run-live-incremental.js');
        assert.strictEqual(card.id, 'M12'); assert.strictEqual(slot, 6);
        if (answer === 'FAIL' || answer === 'VICTORY') {
          const error = new Error('FAILED_OBSERVER'); error.terminalVictory = answer === 'VICTORY'; throw error;
        }
      },
      confirmDetectedVictoryResult: async () => calls.push('victory'),
      loadObserverSessionState: () => after, fs: { unlinkSync: () => calls.push('remove-pending') } };
    vm.runInNewContext(runtimeProduction, context);
    const result = await context.resumePendingIncrementalAtDecision(failed.before,
      { question: async () => ['FAIL', 'VICTORY'].includes(answer) ? '' : answer });
    if (answer === 'q' || answer === 'r') assert.deepStrictEqual(calls, []);
    if (answer === '') { assert.strictEqual(result.state, after); assert.ok(calls.includes('remove-pending')); }
    if (answer === 'FAIL') { assert.strictEqual(result.state, failed.before); assert.ok(!calls.includes('remove-pending')); }
    if (answer === 'VICTORY') { assert.strictEqual(result.quit, true); assert.ok(calls.includes('victory')); }
  }
  assert.ok(!denseProduction.includes('runDenseHandScan('), 'normal dense observation has no full-scan fallback');
  console.log('INCREMENTAL_OBSERVER_TRANSACTION_OFFLINE_PASS; normal M12 class gains input=0; exact component aliases accepted; disk rollback; recovery observer-only; victory preserved');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
