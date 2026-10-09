'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { createJournal, buildConfirmedVictoryProof } = require('../../../src/core/transaction-journal');
const { atomicWriteJson, readOwnedJson, clone, hashValue } = require('../../../src/core/json-store');
const { runAction, instanceKey } = require('../../../src/core/transaction-engine');
const { loadSnapshot, buildActionBaseline } = require('../../../src/core/snapshot');
const { withFileLockSync } = require('../../../src/core/file-lock');
const ROOT = path.resolve(__dirname, '../../..');
const evidence = path.join(ROOT, 'archive/autotest/runs/2026-10-09T08-22-33-595Z/game-00001/completed');
const transactionPath = path.join(evidence, 'debug/v7/transactions/active/DUEL-d99ce6f6cb2fd6ccb13abde2-T0029.json');
const originalBytes = fs.readFileSync(transactionPath), tx = JSON.parse(originalBytes);
const session = readOwnedJson(path.join(evidence, 'debug/v7/session.json'));
const outcome = readOwnedJson(path.join(evidence, 'debug/duel-outcome-live/latest_result.json'));
const proof = buildConfirmedVictoryProof(session, outcome);
const generated = [], base = fs.realpathSync(os.tmpdir()); let cases = 0;
function seed() {
  const root = fs.mkdtempSync(path.join(base, 'mdv7-terminal-close-')); generated.push(root);
  for (const rel of ['debug/v7/session.json', 'debug/hand-change-live/session_state.json',
    'debug/main-deck-ledger/state.json', 'decision-state.json', 'card-library.json'])
    atomicWriteJson(path.join(root, rel), readOwnedJson(path.join(evidence, rel)));
  const journal = createJournal(root); journal.save(clone(tx)); return { root, journal };
}
function businessBytes(root) { return ['debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'decision-state.json'].map(rel => fs.readFileSync(path.join(root, rel)).toString()); }
async function check(name, fn) { await fn(); cases++; console.log('V7_TERMINAL_CLOSE PASS ' + name); }
async function run() {
  await check('real final M21 transaction is abandoned, not committed or promoted', () => {
    const { root, journal } = seed(), before = businessBytes(root);
    journal.closeDuel(session.duelId, proof);
    assert.equal(journal.listActive(session.duelId).length, 0);
    const archived = journal.findArchivedByInstanceKey(tx.instanceKey);
    assert.equal(archived.status, 'ABANDONED'); assert.equal(archived.steps[0].state, 'NO_REPLAY_PERSISTED');
    assert.equal(archived.terminalProof.countsAsExecutionPass, false);
    assert.equal(archived.terminalProof.canCommitHandDelta, false);
    assert.deepEqual(archived.baseline, tx.baseline); assert.deepEqual(archived.steps, tx.steps);
    assert.deepEqual(businessBytes(root), before);
    assert(!fs.existsSync(path.join(root, 'debug/v7/unit-receipts', tx.id + '.json')));
  });
  await check('closure is idempotent and never changes a previously committed action', () => {
    const { root, journal } = seed(), committed = { ...clone(tx), id: session.duelId + '-T9999', instanceKey: 'DONE', status: 'COMMITTED' };
    journal.save(committed); journal.archive(committed);
    const donePath = path.join(root, 'debug/v7/transactions/archive', committed.id + '.json');
    const doneBefore = fs.readFileSync(donePath), marker = journal.closeDuel(session.duelId, proof);
    const first = journal.findArchivedByInstanceKey(tx.instanceKey);
    assert.deepEqual(journal.closeDuel(session.duelId, proof), marker);
    assert.deepEqual(journal.findArchivedByInstanceKey(tx.instanceKey), first);
    assert(fs.readFileSync(donePath).equals(doneBefore));
  });
  await check('close only the proven duel, leaving another duel active', () => {
    const { journal } = seed(), other = { ...clone(tx), id: 'OTHER-T0001', duelId: 'OTHER', instanceKey: 'OTHER' };
    journal.save(other); journal.closeDuel(session.duelId, proof);
    assert.equal(journal.listActive('OTHER').length, 1); assert.equal(journal.closedProof('OTHER'), null);
    assert.throws(() => journal.closeDuel('OTHER', proof), /ID_MISMATCH/);
  });
  const invalid = [
    ['terminal flag alone', { terminal: true, type: undefined, checkedAt: undefined, strictEvidence: undefined }], ['ordinary result', { terminal: false }],
    ['defeat', { type: 'DEFEAT' }], ['old evidence', { checkedAt: '2026-10-09T08:00:00Z' }],
    ['future evidence', { checkedAt: '2100-01-01T00:00:00Z' }], ['other duel evidence', { duelId: 'OTHER' }],
    ['unproven strict match', { strictEvidence: { ...outcome.strictEvidence, matched: false } }],
    ['missing win reason', { strictEvidence: { ...outcome.strictEvidence, reasonText: { matched: false } } }],
    ['missing five components', { strictEvidence: { ...outcome.strictEvidence, exodiaLastFive: { matched: false } } }]
  ];
  for (const [name, patch] of invalid) await check(name + ' cannot close a transaction', () => {
    const { journal } = seed();
    assert.throws(() => buildConfirmedVictoryProof(session, { ...outcome, ...patch }), /CURRENT_STRICT_VICTORY/);
    assert.equal(journal.listActive(session.duelId).length, 1); assert.equal(journal.closedProof(session.duelId), null);
  });
  await check('unproven session and invalid proof disposition fail closed', () => {
    assert.throws(() => buildConfirmedVictoryProof({ ...session, startProven: false }, outcome), /CURRENT_STRICT_VICTORY/);
    const { journal } = seed();
    for (const patch of [{ checkedAt: new Date().toISOString() }, { countsAsExecutionPass: true }, { canCommitHandDelta: true }])
      assert.throws(() => journal.closeDuel(session.duelId, { ...proof, ...patch }), /DISPOSITION_INVALID/);
    assert.equal(journal.listActive(session.duelId).length, 1); assert.equal(journal.closedProof(session.duelId), null);
  });
  await check('proof older than a current input cannot close it', () => {
    const { journal } = seed(), changed = clone(tx);
    changed.steps[0].noReplayAt = new Date(Date.parse(outcome.checkedAt) + 1).toISOString(); journal.save(changed);
    assert.throws(() => journal.closeDuel(session.duelId, proof), /PREDATES_TRANSACTION/);
    assert.equal(journal.listActive(session.duelId).length, 1); assert.equal(journal.closedProof(session.duelId), null);
  });
  await check('partial archive failure persists terminal seal and retries without gameplay input', () => {
    const { journal } = seed(), archive = journal.archive.bind(journal);
    journal.archive = () => { throw new Error('ARCHIVE_DISK_FAILURE'); };
    assert.throws(() => journal.closeDuel(session.duelId, proof), /ARCHIVE_DISK_FAILURE/);
    assert(journal.closedProof(session.duelId)); assert.equal(journal.listActive(session.duelId).length, 1);
    journal.archive = archive; journal.closeDuel(session.duelId, proof);
    assert.equal(journal.listActive(session.duelId).length, 0);
  });
  await check('transaction mutex prevents concurrent close from writing a terminal seal', () => {
    const { journal } = seed();
    withFileLockSync(journal.lockPath, () => assert.throws(() => journal.closeDuel(session.duelId, proof), /TRANSACTION_BUSY/));
    assert.equal(journal.closedProof(session.duelId), null);
  });
  const action = { type: tx.actionType, instanceBasis: async () => tx.intent, steps: [{ id: 'MATURE_VERIFIED_UNIT',
    mode: 'LEGACY_MONOLITH', stateOwner: 'LEGACY', guard: async () => ({ status: 'READY' }), prepare: async () => ({}),
    executeLegacy: async () => { throw new Error('GAME_INPUT_MUST_NOT_RUN'); },
    recoverEvidence: async () => { throw new Error('RECOVERY_MUST_NOT_RUN'); } }] };
  await check('terminal seal rejects same or changed ordinary actions and explicit resume', async () => {
    const { root, journal } = seed(); journal.closeDuel(session.duelId, proof);
    const context = { root, snapshot: async () => loadSnapshot(root) };
    for (const request of [action, { ...action, instanceBasis: async () => ({ different: true }) }])
      await assert.rejects(() => runAction(request, context), /DUEL_ALREADY_TERMINAL/);
    await assert.rejects(() => runAction(action, { ...context, resumeTransactionId: tx.id }), /DUEL_ALREADY_TERMINAL/);
  });
  await check('an abandoned archive can never masquerade as ALREADY_COMMITTED', async () => {
    const { root, journal } = seed(), snapshot = loadSnapshot(root), abandoned = clone(tx);
    const baseline = buildActionBaseline(snapshot, tx.intent);
    abandoned.instanceKey = instanceKey(session.duelId, action.type, baseline, tx.intent);
    abandoned.status = 'ABANDONED'; journal.save(abandoned); journal.archive(abandoned);
    await assert.rejects(() => runAction(action, { root, snapshot: async () => snapshot }), /ABANDONED_TRANSACTION/);
  });
  assert(fs.readFileSync(transactionPath).equals(originalBytes), 'historical evidence must remain original ACTIVE, not be rewritten');
  console.log('V7_TERMINAL_TRANSACTION_CLOSE_PASS; cases=' + cases + '; real M21 fixture; nativeInputs=0; formalBusinessWrites=0; evidenceUnchanged=' + hashValue(tx));
}
run().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => {
  for (const root of generated) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('mdv7-terminal-close-') ||
        fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_GENERATED_TEST_CLEANUP');
    fs.rmSync(root, { recursive: true });
  }
});
