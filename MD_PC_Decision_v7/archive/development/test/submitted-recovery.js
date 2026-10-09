'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { readOwnedJson, atomicWriteJson, hashValue } = require('../../../src/core/json-store');
const { inspectSubmittedEquipment, recoverSubmittedEquipment } = require('../../../src/integration/submitted-equipment-recovery');
const { makeBindings } = require('../../../src/integration/production-bindings');
const { createJournal } = require('../../../src/core/transaction-journal');
const matureReducer = require('../../../engine/runtime/mature-driver').deriveSwordEquippedState;
const fixture = path.resolve(__dirname, '../../../archive/regression-fixtures/submitted-equipment');
const read = name => readOwnedJson(path.join(fixture, name));
function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv7-equip-recovery-')), tx = read('transaction.json');
  const dir = path.join(root, 'debug/execution/V5_formal_atomic/2026-10-07T06-43-20-986Z_M19_equip');
  atomicWriteJson(path.join(dir, 'equip_target/preferred_equip_carrier.json'), read('target.json'));
  atomicWriteJson(path.join(dir, 'equip_confirm/M19_equip_confirm_latest.json'), read('confirm.json'));
  const actionsFile = path.join(root, 'actions.jsonl'); fs.copyFileSync(path.join(fixture, 'actions.jsonl'), actionsFile);
  atomicWriteJson(path.join(root, 'decision-state.json'), read('runtime.json'));
  atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), read('hand.json'));
  atomicWriteJson(path.join(root, 'debug/main-deck-ledger/state.json'), { lastHandRevision: tx.baseline.hand.revision,
    outsideDeckCounts: tx.baseline.ledger.counts, unknownExodiaOutsideCount: 1 });
  atomicWriteJson(path.join(root, 'card-library.json'), require('../../../engine/card-library.json'));
  atomicWriteJson(path.join(root, 'debug/v7/session.json'), { duelId: tx.duelId, startProven: true });
  createJournal(root).save(tx);
  const proof = inspectSubmittedEquipment(root, tx, actionsFile);
  return { root, tx, ticket: { actionsFile, equipmentProofHash: hashValue(proof) } };
}
async function run() {
  const { root, tx, ticket } = seed(); let observer = 0, legacyInputs = 0;
  const mature = { assertFreshRuntimeBeforeGameAction() {}, deriveSwordEquippedState: matureReducer,
    loadObserverSessionState: () => readOwnedJson(path.join(root, 'debug/hand-change-live/session_state.json')) };
  const observeOutcome = () => {
    observer++;
    const state = mature.loadObserverSessionState(); state.cards.splice(tx.intent.slot - 1, 1);
    state.cards.forEach((c, i) => { c.index = i + 1; }); state.handCount--; state.revision++;
    atomicWriteJson(path.join(root, 'debug/hand-change-live/session_state.json'), state);
    const ledger = readOwnedJson(path.join(root, 'debug/main-deck-ledger/state.json')); ledger.lastHandRevision = state.revision;
    atomicWriteJson(path.join(root, 'debug/main-deck-ledger/state.json'), ledger);
    atomicWriteJson(path.join(root, 'debug/duel-log-live/latest_result.json'), { continuity: 'CONTINUOUS_VIA_BOTTOM_TAIL_NEW_BLOCKS',
      newOperationBlocks: [{ activationKey: 'M19', activation: { side: 'SELF', card: { id: 'M19' } },
        details: [{ side: 'SELF', rawType: 'TARGET_SELECTION', card: { id: 'M06' } }] }] });
    return state;
  };
  const finalGuard = async () => ({ status: 'READY' });
  const recover = current => recoverSubmittedEquipment({ root, tx: current, ticket, mature, finalGuard, observeOutcome });
  const units = makeBindings({ root, mature, finalGuard, manifest: require('../../../config/v6-ownership.json'), recoverSubmitted: recover });
  const result = await units.dispatch(tx.actionType, tx.intent, () => { legacyInputs++; throw new Error('MUST_NOT_REPLAY'); });
  assert.equal(result.passiveRecovery, true); assert.equal(legacyInputs, 0); assert.equal(observer, 1);
  assert.equal(result.state.handCount, 3); assert.equal(readOwnedJson(path.join(root, 'decision-state.json')).usedCounts.M19, 1);
  assert.equal(createJournal(root).listActive(tx.duelId).length, 0);
  await recover(tx); assert.equal(observer, 1); assert.equal(readOwnedJson(path.join(root, 'decision-state.json')).usedCounts.M19, 1);
  const wrong = seed(), events = fs.readFileSync(wrong.ticket.actionsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  events.at(-1).command.x += 20; fs.writeFileSync(wrong.ticket.actionsFile, events.map(JSON.stringify).join('\n') + '\n');
  assert.throws(() => inspectSubmittedEquipment(wrong.root, wrong.tx, wrong.ticket.actionsFile), /CONFIRM_INPUT_RECEIPT_MISSING/);
  const changed = seed(); const state = readOwnedJson(path.join(changed.root, 'decision-state.json')); state.usedCounts.M19 = 3;
  atomicWriteJson(path.join(changed.root, 'decision-state.json'), state);
  await assert.rejects(() => recoverSubmittedEquipment({ ...changed, mature, finalGuard, observeOutcome }), /RUNTIME_BASELINE_CHANGED/);
  console.log('V7_SUBMITTED_EQUIPMENT_RECOVERY_PASS; real confirm receipt; no activation replay; hand/ledger + missing runtime once; repeated recovery idempotent; mismatched receipt/state rejected');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
