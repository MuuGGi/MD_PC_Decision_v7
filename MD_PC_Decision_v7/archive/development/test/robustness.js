'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { runAction, STEP } = require('../../../src/core/transaction-engine');
const { createJournal } = require('../../../src/core/transaction-journal');
const { atomicWriteJson, readJsonStrict } = require('../../../src/core/json-store');
const { createCommitCoordinator } = require('../../../src/core/state-commit');
const { loadSnapshot } = require('../../../src/core/snapshot');
const { goldenDraw2, provesDeadlock } = require('../../../src/core/capability');
const { canStartNewDecision } = require('../../../src/core/decision-gate');
const { proveForeground } = require('../../../src/core/input-guard');
const { NotReadyError, ContractError, UnsafeReplayError, ShadowViolationError } = require('../../../src/core/errors');
const { adaptV6ObserverResult, dedupeAcrossFrames } = require('../../../src/core/observer-contract');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const { createChain, addLink, sealChain, resolveLink } = require('../../../src/core/chain-contract');
const cp = require('child_process');
const cases = [];
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv7-robust-'));
  atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), { revision: 0, handCount: 1, capturedAt: '2026-10-07T00:00:00Z', cards: [{ id: 'M14' }] });
  atomicWriteJson(path.join(root, 'debug/main-deck-ledger/state.json'), { openingBaselineCapturedAt: '2026-10-07T00:00:00Z', lastHandRevision: 0, outsideDeckCounts: { M14: 1, M09: 0 } });
  atomicWriteJson(path.join(root, 'decision-state.json'), { usedCounts: {}, graveSpellCount: 0, normalSummonUsed: false, bambooSwordEquipped: false });
  atomicWriteJson(path.join(root, 'card-library.json'), { cards: [{ id: 'M14', count: 3 }, { id: 'M09', count: 3 }] });
  atomicWriteJson(path.join(root, 'debug/duel-log-live/observer_state.json'), { checkpoint: { activationKey: 'M17', signature: 'A' } });
  atomicWriteJson(path.join(root, 'debug/duel-log-live/latest_result.json'), { continuity: 'CONTINUOUS', capturedAt: 'A' });
  return root;
}
function action(overrides = {}) {
  return { type: 'DRAW', instanceBasis: async () => ({ target: 'M14' }), steps: [{ id: 'ACTIVATE', stateOwner: 'LEGACY',
    guard: async () => ({ status: 'READY' }), prepare: async () => ({}), sendInput: async () => ({ sent: true }),
    verify: async () => ({ proven: true }), recoverEvidence: async () => ({ proven: true }), ...overrides }] };
}
async function test(name, fn) { await fn(); cases.push(name); }
async function run() {
  await test('changing observation cannot bypass active no-replay', async () => {
    const root = makeRoot(); let sends = 0;
    const a = action({ sendInput: async () => { sends++; return {}; }, verify: async () => { throw new NotReadyError('ANIMATION'); } });
    const ctx = { root, snapshot: async () => loadSnapshot(root) };
    assert.equal((await runAction(a, ctx)).status, 'WAITING');
    atomicWriteJson(path.join(root, 'debug/duel-log-live/latest_result.json'), { capturedAt: 'B', continuity: 'UPDATED' });
    const hand = readJsonStrict(path.join(root, 'debug/hand-change-live/session_state.json')); hand.revision = 1;
    atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), hand);
    const result = await runAction(a, ctx);
    assert.equal(result.status, 'COMMITTED'); assert.equal(sends, 1);
  });
  await test('different action cannot replace unresolved action', async () => {
    const root = makeRoot(), ctx = { root, snapshot: async () => loadSnapshot(root) };
    await runAction(action({ verify: async () => { throw new NotReadyError('WAIT'); } }), ctx);
    const other = action(); other.type = 'LINK';
    await assert.rejects(() => runAction(other, ctx), e => e instanceof UnsafeReplayError);
  });
  await test('null proof cannot commit', async () => {
    const root = makeRoot(); const result = await runAction(action({ verify: async () => null }), { root, snapshot: async () => loadSnapshot(root) });
    assert.equal(result.status, 'WAITING'); assert.equal(result.transaction.steps[0].state, STEP.INPUT_SENT);
  });
  await test('commit recovery never rechecks closed activation UI', async () => {
    const root = makeRoot(); let calls = 0, guardCalls = 0;
    const a = action({ stateOwner: 'V7', guard: async () => { guardCalls++; return { status: 'READY' }; },
      commit: async () => { if (++calls === 1) throw new Error('CRASH'); return { committed: true }; } });
    const ctx = { root, snapshot: async () => loadSnapshot(root) };
    await assert.rejects(() => runAction(a, ctx), /CRASH/);
    a.steps[0].guard = async () => { throw new Error('OLD_UI_ALREADY_GONE'); };
    assert.equal((await runAction(a, ctx)).status, 'COMMITTED'); assert.equal(guardCalls, 1);
  });
  await test('same baseline completed invocation cannot replay', async () => {
    const root = makeRoot(); let sends = 0; const a = action({ sendInput: async () => { sends++; return {}; } });
    const ctx = { root, snapshot: async () => loadSnapshot(root) };
    await runAction(a, ctx); assert.equal((await runAction(a, ctx)).status, 'ALREADY_COMMITTED'); assert.equal(sends, 1);
  });
  await test('corrupt business JSON is not missing and never overwritten', async () => {
    const root = makeRoot(), file = path.join(root, 'broken.json'); fs.writeFileSync(file, '{broken');
    const c = createCommitCoordinator(root);
    assert.throws(() => c.prepare({ commitId: 'C1', operations: [{ operationKey: 'A', targetPath: file, transform: () => ({ n: 1 }) }] }), e => e instanceof ContractError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });
  await test('corrupt commit plan blocks new decision', async () => {
    const root = makeRoot(), dir = path.join(root, 'debug/v7/commits'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'C1.json'), '{broken');
    const c = createCommitCoordinator(root); assert.throws(() => c.hasIncomplete(), /PERSISTED_STATE_UNREADABLE/);
    assert.equal(canStartNewDecision(loadSnapshot(root), c, null).status, 'UNKNOWN');
  });
  await test('corrupt active transaction blocks new input', async () => {
    const root = makeRoot(), dir = path.join(root, 'debug/v7/transactions/active'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'D-T0001.json'), '{broken');
    let sends = 0; await assert.rejects(() => runAction(action({ sendInput: async () => { sends++; } }), { root, snapshot: async () => loadSnapshot(root) }), /PERSISTED_STATE_UNREADABLE/);
    assert.equal(sends, 0);
  });
  await test('commit path and identity cannot escape or silently change', async () => {
    const root = makeRoot(), c = createCommitCoordinator(root);
    assert.throws(() => c.prepare({ commitId: '../OUT', operations: [] }), /COMMIT_PLAN_INVALID/);
    assert.throws(() => c.prepare({ commitId: 'C1', operations: [{ operationKey: 'A', targetPath: path.resolve(root, '../other.json'), transform: () => ({}) }] }), /STATE_PATH_OUTSIDE_ROOT/);
    const f = path.join(root, 'decision-state.json');
    c.prepare({ commitId: 'C2', operations: [{ operationKey: 'A', targetPath: f, transform: v => ({ ...v, n: 1 }) }] });
    assert.throws(() => c.prepare({ commitId: 'C2', operations: [{ operationKey: 'B', targetPath: f, transform: () => ({}) }] }), /COMMIT_ID_REUSED/);
  });
  await test('missing count fields remain UNKNOWN', async () => {
    const root = makeRoot(); const s = loadSnapshot(root); s.ledger.data.outsideDeckCounts = {};
    assert.equal(goldenDraw2(s, { bambooEquip: { status: 'PROVEN' } }).status, 'UNKNOWN');
    assert.equal(provesDeadlock({ status: 'BLOCKED' }), false);
    assert.equal(provesDeadlock([{ status: 'BLOCKED' }, { status: 'UNKNOWN' }]), false);
  });
  await test('missing source and missing hardware proof never READY', async () => {
    assert.equal(canStartNewDecision({ consistency: [] }, null, null).status, 'UNKNOWN');
    assert.equal((await proveForeground(async () => ({}), {})).status, 'UNKNOWN');
  });
  await test('known JSON with incomplete resource schema cannot start decisions', async () => {
    for (const [rel, value] of [
      ['debug/hand-change-live/session_state.json', { revision: 0, handCount: 5, cards: [{ id: 'M14' }] }],
      ['decision-state.json', { usedCounts: {} }],
      ['debug/main-deck-ledger/state.json', { lastHandRevision: 0, outsideDeckCounts: {} }]
    ]) {
      const root = makeRoot(); atomicWriteJson(path.join(root, rel), value);
      assert.equal(canStartNewDecision(loadSnapshot(root), null, null).status, 'UNKNOWN');
    }
  });
  await test('changing recovery mode cannot replace input ownership', async () => {
    const root = makeRoot(), ctx = { root, snapshot: async () => loadSnapshot(root) };
    const a = action({ verify: async () => { throw new NotReadyError('WAIT'); } });
    await runAction(a, ctx);
    a.steps[0].mode = 'LEGACY_MONOLITH'; a.steps[0].executeLegacy = async () => { throw new Error('MUST_NOT_REPLAY'); };
    await assert.rejects(() => runAction(a, ctx), /OWNERSHIP_CHANGED/);
  });
  await test('header actor is separate from affected-card owner', async () => {
    const c = adaptV6ObserverResult({ newOperationBlocks: [{ activationKey: 'M17', activation: { side: 'SELF' }, details: [{ rawType: 'TARGET', side: 'OPPONENT', card: { id: 'UNKNOWN' } }] }] }, { duelId: 'D1' });
    assert.equal(c.events[0].actor, 'SELF'); assert.equal(c.events[0].evidence.details[0].actor, 'OPPONENT');
  });
  await test('extended operation retains identity and updates evidence', async () => {
    const b = { activationKey: 'M17', activation: { side: 'SELF' }, details: [{ rawType: 'TARGET', side: 'SELF', card: { id: 'M06' } }] };
    const first = adaptV6ObserverResult({ newOperationBlocks: [b], continuity: 'NEW' }, { duelId: 'D1' });
    const second = adaptV6ObserverResult({ extendedOperationBlocks: [{ ...b, details: [...b.details, { rawType: 'HAND_GAIN', side: 'SELF', card: { id: 'M06' } }] }], continuity: 'EXTENDED' }, { duelId: 'D1', previousContract: first });
    assert.equal(first.events[0].eventInstanceKey, second.events[0].eventInstanceKey);
    const merged = dedupeAcrossFrames([first, second]); assert.equal(merged.length, 1); assert.equal(merged[0].evidence.details.length, 2);
  });
  await test('same-name ambiguous extension cannot guess identity', async () => {
    const b = { activationKey: 'M19', activation: { side: 'SELF' }, details: [{ rawType: 'ACTIVATE', side: 'SELF' }] };
    const first = adaptV6ObserverResult({ newOperationBlocks: [b, b] }, { duelId: 'D1' });
    const second = adaptV6ObserverResult({ extendedOperationBlocks: [b] }, { duelId: 'D1', previousContract: first });
    assert.equal(first.events.length, 2); assert.equal(second.events[0].identityStatus, 'AMBIGUOUS');
  });
  await test('chain order and complete-building evidence enforced', async () => {
    const c = createChain('C1'); addLink(c, { index: 1, actor: 'SELF' }); addLink(c, { index: 2, actor: 'OPPONENT', actionType: 'UNKNOWN_CARD' });
    assert.throws(() => resolveLink(c, 1, { status: 'RESOLVED', proven: true }), /CHAIN_NOT_RESOLVING/);
    sealChain(c, { proven: true }); assert.throws(() => resolveLink(c, 1, { status: 'RESOLVED', proven: true }), /CHAIN_RESOLUTION_ORDER/);
    resolveLink(c, 2, { status: 'RESOLVED', proven: true }); resolveLink(c, 1, { status: 'NEGATED', proven: true }); assert.equal(c.status, 'RESOLVED');
  });
  await test('shadow blocks callback, fd, stream and subprocess writes', async () => {
    const root = makeRoot(), file = path.join(root, 'decision-state.json'), before = fs.readFileSync(file);
    for (const fn of [() => fs.writeFile(file, 'BAD', () => {}), () => fs.openSync(file, 'r+'), () => fs.createWriteStream(file), () => cp.spawnSync(process.execPath, ['-v'])])
      await assert.rejects(() => withStrictReadOnly(async () => fn()), e => e instanceof ShadowViolationError);
    assert(fs.readFileSync(file).equals(before));
  });
  console.log('V7_ROBUSTNESS_REGRESSIONS_PASS; cases=' + cases.length);
  return cases;
}
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { run };
