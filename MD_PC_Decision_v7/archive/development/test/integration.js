'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { atomicWriteJson, readOwnedJson } = require('../../../src/core/json-store');
const { loadSnapshot } = require('../../../src/core/snapshot');
const { makeBindings, KEY } = require('../../../src/integration/production-bindings');
const { createJournal, buildConfirmedVictoryProof } = require('../../../src/core/transaction-journal');
const { adaptV6ObserverResult } = require('../../../src/core/observer-contract');
const { chooseRole, roleFact } = require('../../../src/core/ui-role-detector');
const manifest = require('../../../config/v6-ownership.json');
const rootDir = path.resolve(__dirname, '../../..');
let count = 0;
function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv7-integration-'));
  atomicWriteJson(path.join(root, 'debug/v7/session.json'), { duelId: 'D-TEST', startProven: true });
  atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), { cards: [{ id: 'M14', index: 1 }], handCount: 1, revision: 0 });
  atomicWriteJson(path.join(root, 'debug/main-deck-ledger/state.json'), { lastHandRevision: 0, outsideDeckCounts: { M14: 1 } });
  atomicWriteJson(path.join(root, 'decision-state.json'), { usedCounts: {}, graveSpellCount: 0, normalSummonUsed: false, bambooSwordEquipped: true });
  atomicWriteJson(path.join(root, 'card-library.json'), { cards: [{ id: 'M14', count: 3 }] });
  return root;
}
async function check(name, fn) { await fn(); count++; console.log('V7_INTEGRATION PASS ' + name); }
async function simulateLoop(options = {}) {
  const persistentRoot = options.persistent ? seed() : null;
  const session = { duelId: persistentRoot ? 'D-TEST' : 'D', startProven: true,
    startedAt: new Date(Date.now() - 1000).toISOString() };
  const events = [], observedContractActions = [];
  const snapshot = persistentRoot ? loadSnapshot(persistentRoot) : { consistency: [], runtime: { status: 'KNOWN', data: { usedCounts: {} } } };
  const runtime = snapshot.runtime.data, state = persistentRoot ? snapshot.hand.data : { revision: 0, cards: [] };
  const decision = { selected: { id: 'M09', slot: 1 }, basis: {
    snapshotKey: snapshot.snapshotKey || 'S', handRevision: 0, duelId: session.duelId } };
  let step = 0;
  const mature = {
    assertEnvironment() {}, assertFreshRuntimeBeforeGameAction() {},
    resetDecisionStateForNewDuel() { events.push('reset'); },
    async establishOpeningState() { events.push('opening'); return state; },
    loadDecisionState: () => runtime,
    createSimpleDrawAutoController: () => ({ stop() { events.push('auto-stop'); }, completed() {} }),
    loadPendingM18Route: () => options.pending || null, loadPendingM21Transaction: () => null,
    loadPendingMalletCheckpoint: () => null, loadPendingIncrementalObservation: () => null,
    normalizeEquippedYotoGoldenDrawPriority() {}, currentAtomicNode: () => 'IDLE', isTransactionPendingNode: () => false,
    buildDecisionSuggestion(hand, source) { assert.strictEqual(hand, state); assert.strictEqual(source, snapshot); events.push('decide'); return decision; },
    printDecisionPoint(_hand, _title, _auto, prepared) { assert.strictEqual(prepared, decision); return prepared; },
    async executeSelected({ decision: prepared }) {
      assert.strictEqual(prepared, decision);
      events.push('execute');
      if (options.victory) {
        const e = new Error('TERMINAL'); e.terminalVictory = true;
        e.outcome = options.invalidVictory ? {} : { terminal: true, type: 'VICTORY', checkedAt: new Date().toISOString(),
          strictEvidence: { matched: true, reasonText: { matched: true }, exodiaLastFive: { matched: true } } };
        throw e;
      }
      return { executed: true, state: { ...state, revision: ++step }, quit: true };
    },
    async confirmDetectedVictoryResult() {
      events.push('void-after-proven-victory');
      if (options.settlementError) throw new Error('SETTLEMENT_INTERRUPTED');
      return options.settlementPaused ? false : true;
    }
  };
  class Bridge {
    async start() { events.push('bridge-start'); } async stop() { events.push('bridge-stop'); }
    async command() { events.push('guard'); }
    async info() { return { hwnd: 10, title: 'masterduel', client: { width: 2048, height: 1152 } }; }
  }
  const dependencies = {
    fs: { appendFileSync() { events.push('audit'); } },
    '../core/json-store': { readOwnedJson: file => file.endsWith('session.json') ? session : manifest, atomicWriteJson() {} },
    '../core/snapshot': { loadSnapshot: () => snapshot },
    '../core/input-guard': { proveForeground: async () => ({ status: options.foreground || 'READY' }) },
    '../integration/production-bindings': { KEY, makeBindings: () => persistentRoot
      ? makeBindings({ root: persistentRoot, mature, manifest, finalGuard: async () => ({ status: 'READY' }) })
      : ({ async dispatch(key, intent, execute) { events.push('dispatch:' + key); return { ...await execute(), v7TransactionId: 'T-TEST' }; } }) },
    '../integration/v6-observer-adapter': { readContract: (_root, options) => { observedContractActions.push(options.actionInstanceId); return { status: 'UNKNOWN' }; } },
    '../../engine/runtime/mature-driver': mature,
    '../../engine/lib/win-fast': { MdFastBridge: Bridge, clientReport: () => ({}) },
    '../../engine/lib/self-priority-gate': { waitForSelfPriorityBlue: async () => { events.push('priority'); return { status: 'READY' }; } },
    '../../engine/lib/runtime-source-freshness': { createRuntimeSourceFreshnessGuard: () => ({ assertFresh() {} }) },
    '../../autotest/policy': require('../../../autotest/policy'),
    '../../autotest/auto-hook': { check() { if (options.stop) throw new Error('USER_STOP'); } },
    '../../engine/lib/main-deck-ledger': { initializeSharedDeckState() { events.push('ledger-init'); } },
    '../../engine/lib/recognizer': { loadLibrary: () => ({}) },
    '../core/transaction-journal': { buildConfirmedVictoryProof, createJournal: () => persistentRoot ? createJournal(persistentRoot)
      : ({ listActive: () => options.active ? [{}] : [], closeDuel(id, proof) {
        assert.equal(id, session.duelId); assert.equal(proof.proven, true);
        assert.equal(proof.countsAsExecutionPass, false); events.push('terminal-journal-closed');
      } }) },
    '../core/state-commit': { createCommitCoordinator: () => ({ hasIncomplete: () => Boolean(options.incomplete) }) },
    '../core/decision-gate': { canStartNewDecision: () => ({ status: options.gate || 'READY' }) },
    'readline/promises': { createInterface: () => ({ close() { events.push('rl-close'); } }) }
  };
  const context = { module: { exports: {} }, __dirname: path.join(rootDir, 'src/runtime'), console: { log() {} },
    process: { versions: { node: '20.11.1' }, env: { MD_V7_RUN: '1', MD_AUTOTEST_GUARD: 'mock', MD_V7_DUEL_ID: session.duelId } },
    require: id => dependencies[id] || require(id.startsWith('.') ? path.resolve(rootDir, 'src/runtime', id) : id) };
  vm.runInNewContext(fs.readFileSync(path.join(rootDir, 'src/runtime/duel-loop.js'), 'utf8'), context);
  let error; try { await context.module.exports.run(); } catch (e) { error = e; }
  return { events, observedContractActions, error, persistentRoot, session };
}
async function run() {
  await check('actual unit registry commits once and writes no second business apply', async () => {
    const root = seed(); let input = 0, guards = 0;
    const mature = { assertFreshRuntimeBeforeGameAction() {}, loadObserverSessionState: () => loadSnapshot(root).hand.data };
    const units = makeBindings({ root, mature, manifest, finalGuard: async () => { guards++; return { status: 'READY' }; } });
    const before = fs.readFileSync(path.join(root, 'decision-state.json'));
    const execute = async () => { input++; return { executed: true, state: mature.loadObserverSessionState() }; };
    const first = await units.dispatch(KEY.HAND, { cardId: 'M14', slot: 1 }, execute);
    const second = await units.dispatch(KEY.HAND, { cardId: 'M14', slot: 1 }, execute);
    assert.equal(input, 1); assert.equal(guards, 2); assert.equal(second.alreadyCommitted, true);
    assert.equal(first.v7TransactionId, second.v7TransactionId); assert(first.v7TransactionId);
    assert(fs.readFileSync(path.join(root, 'decision-state.json')).equals(before));
    assert.equal(createJournal(root).listActive('D-TEST').length, 0);
  });
  await check('changed observation after uncertain unit cannot trigger input again', async () => {
    const root = seed(); let input = 0;
    const units = makeBindings({ root, mature: { assertFreshRuntimeBeforeGameAction() {} }, manifest, finalGuard: async () => ({ status: 'READY' }) });
    const execute = async () => { input++; throw new Error('CRASH_AFTER_INPUT'); };
    await assert.rejects(() => units.dispatch(KEY.HAND, { cardId: 'M14', slot: 1 }, execute), /CRASH/);
    atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), { revision: 1, handCount: 0, cards: [] });
    await assert.rejects(() => units.dispatch(KEY.HAND, { cardId: 'M09', slot: 2 }, execute), /V7_UNIT_NOT_PROVEN/);
    assert.equal(input, 1);
  });
  await check('final foreground guard forbids dispatch input', async () => {
    const root = seed(); let input = 0, guards = 0;
    const units = makeBindings({ root, mature: {}, manifest, finalGuard: async () => ({ status: ++guards === 1 ? 'READY' : 'UNKNOWN' }) });
    await assert.rejects(() => units.dispatch(KEY.HAND, { cardId: 'M14' }, async () => { input++; }), e =>
      e.code === 'V7_INPUT_GUARD_NOT_PROVEN' && require('../../../autotest/policy').classifyFailure(e) === 'STOP_TEST');
    assert.equal(input, 0);
  });
  await check('V7 real main-loop lifecycle dispatches V7 unit', async () => {
    const result = await simulateLoop(); assert.ifError(result.error);
    assert.equal(result.events.filter(e => e === 'opening').length, 1);
    assert(result.events.includes('dispatch:' + KEY.HAND)); assert(result.events.includes('bridge-stop'));
    assert.deepEqual(result.observedContractActions, ['T-TEST']);
    assert.equal(result.events.filter(e => e === 'decide').length, 1);
    assert(result.events.indexOf('priority') < result.events.indexOf('decide'));
  });
  await check('UNKNOWN baseline, unsafe foreground, pending legacy and stop never select', async () => {
    for (const options of [{ gate: 'UNKNOWN' }, { foreground: 'UNKNOWN' }, { pending: { stage: 'INPUT_SENT' } },
      { active: true }, { incomplete: true }, { stop: true }]) {
      const result = await simulateLoop(options); assert(result.error); assert(!result.events.includes('execute'));
    }
  });
  await check('published decision basis changes before input reject old intent', async () => {
    for (const mutation of ['runtime', 'log']) {
      const root = seed(); let input = 0, guards = 0;
      const before = loadSnapshot(root);
      const units = makeBindings({ root, mature: { assertFreshRuntimeBeforeGameAction() {} }, manifest,
        finalGuard: async () => {
          if (++guards === 1) {
            if (mutation === 'runtime') atomicWriteJson(path.join(root, 'decision-state.json'),
              { ...before.runtime.data, normalSummonUsed: true });
            else atomicWriteJson(path.join(root, 'debug/duel-log-live/latest_result.json'), { newOperationBlocks: [] });
          }
          return { status: 'READY' };
        } });
      await assert.rejects(() => units.dispatch(KEY.HAND, { cardId: 'M14', slot: 1,
        decisionBasis: { snapshotKey: before.snapshotKey, handRevision: 0, duelId: 'D-TEST' } },
        async () => { input++; }), /V7_STRATEGY_BASIS_CHANGED_NO_INPUT/);
      assert.equal(input, 0);
    }
  });
  await check('proven terminal exception voids ordinary settlement without fake PASS', async () => {
    const result = await simulateLoop({ victory: true }); assert.ifError(result.error);
    assert(result.events.includes('void-after-proven-victory')); assert.equal(result.events.filter(e => e === 'execute').length, 1);
    assert(result.events.indexOf('terminal-journal-closed') > result.events.indexOf('void-after-proven-victory'));
  });
  await check('actual main loop and registry archive terminal transaction without ordinary business writes', async () => {
    for (const mode of [{}, { settlementPaused: true }, { settlementError: true }]) {
      const result = await simulateLoop({ persistent: true, victory: true, ...mode });
      if (mode.settlementError) assert.match(result.error.message, /SETTLEMENT_INTERRUPTED/); else assert.ifError(result.error);
      const journal = createJournal(result.persistentRoot);
      assert.equal(journal.listActive('D-TEST').length, 0);
      assert.equal(journal.closedProof('D-TEST').terminalProof.countsAsExecutionPass, false);
      const tx = readOwnedJson(path.join(result.persistentRoot, 'debug/v7/transactions/archive/D-TEST-T0001.json'));
      assert.equal(tx.status, 'ABANDONED'); assert.equal(tx.steps[0].state, 'NO_REPLAY_PERSISTED');
      assert.equal(loadSnapshot(result.persistentRoot).hand.data.revision, 0);
      assert.deepEqual(loadSnapshot(result.persistentRoot).runtime.data.usedCounts, {});
      assert(!fs.existsSync(path.join(result.persistentRoot, 'debug/v7/unit-receipts/D-TEST-T0001.json')));
      assert.equal(result.events.filter(e => e === 'execute').length, 1);
    }
  });
  await check('terminal flag without current strict evidence neither confirms victory nor abandons transaction', async () => {
    const result = await simulateLoop({ persistent: true, victory: true, invalidVictory: true });
    assert.match(result.error.code, /CURRENT_STRICT_VICTORY/);
    assert.equal(createJournal(result.persistentRoot).listActive('D-TEST').length, 1);
    assert.equal(createJournal(result.persistentRoot).closedProof('D-TEST'), null);
    assert(!result.events.includes('void-after-proven-victory'));
  });
  await check('extended identity survives empty/cropped observation', async () => {
    const block = { activationKey: 'M17', activation: { side: 'SELF' }, details: [{ rawType: 'TARGET', card: { id: 'M06' } }] };
    const a = adaptV6ObserverResult({ newOperationBlocks: [block] }, { duelId: 'D' });
    const empty = adaptV6ObserverResult({ continuity: 'CROPPED', newOperationBlocks: [] }, { duelId: 'D', previousContract: a });
    const b = adaptV6ObserverResult({ extendedOperationBlocks: [{ ...block, details: [...block.details, { rawType: 'HAND_GAIN' }] }] }, { duelId: 'D', previousContract: empty });
    assert.equal(a.events[0].eventInstanceKey, b.events[0].eventInstanceKey);
  });
  await check('identical NEW logs in different durable actions are not merged; repeated/cropped frames dedupe', async () => {
    const block = { activationKey: 'M19', activation: { side: 'SELF' }, details: [{ rawType: 'HAND_GAIN', side: 'SELF', card: { id: 'M14' } }] };
    const log = { newOperationBlocks: [block], matchedContinuityAnchor: { activationKey: 'M19' } };
    const root = seed(); atomicWriteJson(path.join(root, 'debug/duel-log-live/latest_result.json'), log);
    const { readContract } = require('../../../src/integration/v6-observer-adapter');
    const a = readContract(root, { duelId: 'D', actionInstanceId: 'T1' }).contract;
    const b = readContract(root, { duelId: 'D', actionInstanceId: 'T2', previousContract: a }).contract;
    assert.notEqual(a.observationId, b.observationId);
    assert.notEqual(a.events[0].eventInstanceKey, b.events[0].eventInstanceKey); assert.equal(b.history.length, 2);
    const repeat = readContract(root, { duelId: 'D', actionInstanceId: 'T2', previousContract: b }).contract;
    assert.equal(repeat.history.length, 2); assert.equal(repeat.events[0].eventInstanceKey, b.events[0].eventInstanceKey);
    const cropped = adaptV6ObserverResult({ continuity: 'CROPPED', newOperationBlocks: [] }, { duelId: 'D', actionInstanceId: 'T2', previousContract: repeat });
    const recaptured = readContract(root, { duelId: 'D', actionInstanceId: 'T2', previousContract: cropped }).contract;
    assert.equal(recaptured.history.length, 2); assert.equal(recaptured.events[0].eventInstanceKey, b.events[0].eventInstanceKey);
  });
  await check('role ranking requires semantic proof and local target region', async () => {
    assert.throws(() => chooseRole([{ score: 1 }]), /ROLE_TEST_REQUIRED/);
    const role = roleFact(() => chooseRole([{ score: 1, role: 'SET', x: 50, y: 50 }, { score: 0.8, role: 'ACTIVATE', x: 5, y: 5 }],
      { roleTest: c => c.role === 'ACTIVATE', expectedRegion: { x: 0, y: 0, width: 10, height: 10 } }));
    assert.equal(role.status, 'PROVEN'); assert.equal(role.candidate.x, 5);
  });
  await check('five-game supervisor preserves error-victory-interruption accounting', async () => {
    const { TestStore } = require('../../../autotest/store'), { playOne } = require('../../../autotest/session');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv7-session-')), store = new TestStore(path.join(root, 'batch'), { aggregateDir: root, statisticsPath: path.join(root, 'statistics.json') });
    let calls = [];
    for (let i = 0; i < 5; i++) {
      const result = await playOne(store, { stopped: () => false, start: async () => {}, waitMain1: async () => {},
        play: async () => { if (i === 2) throw new Error('UNKNOWN_UI'); return { outcome: i === 1 ? 'SURRENDER' : 'WIN', proven: true, proof: { i } }; },
        archive: async (_, label) => { calls.push(label); }, observeEnd: async () => null,
        surrender: async () => { calls.push('surrender'); return { outcome: 'SURRENDER', proven: true, proof: {} }; },
        finishBoard: async () => ({ gems: null }) });
      assert.equal(result.stop, false);
    }
    assert.equal(store.state.games.length, 5); assert.equal(store.state.totals.wins, 3); assert.equal(store.state.totals.errorSurrenders, 1);
    assert(calls.indexOf('before-recovery') < calls.indexOf('surrender'));
    calls = [];
    const result = await playOne(store, { stopped: () => false, start: async () => {}, waitMain1: async () => {},
      play: async () => { throw new Error('MOUSE_INTERFERENCE'); }, archive: async () => {}, surrender: async () => calls.push('bad') });
    assert.equal(result.stop, true); assert.equal(result.game.outcome, 'INTERRUPTED'); assert.equal(calls.length, 0);
  });
  console.log('V7_PRODUCTION_INTEGRATION_PASS; cases=' + count);
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
