'use strict';
const fs = require('fs'), path = require('path');
const { ProductionRegistry } = require('../core/registry');
const { runAction } = require('../core/transaction-engine');
const { loadSnapshot, known } = require('../core/snapshot');
const { readOwnedJson, atomicWriteJson, hashValue, insidePath } = require('../core/json-store');
const { createCommitCoordinator } = require('../core/state-commit');
const { canStartNewDecision } = require('../core/decision-gate');
const { NotReadyError, ContractError, UnknownFactError } = require('../core/errors');

const KEY = Object.freeze({ HAND: 'UNIT:HAND_SELECTION', FIELD: 'UNIT:FIELD_INTERVAL',
  GAIN: 'UNIT:FIXED_FIELD_GAIN', DRAW: 'UNIT:DEFERRED_FIELD_DRAW' });
function makeBindings({ root, mature, finalGuard, manifest, recoverSubmitted = null }) {
  const proveInputSafety = async () => {
    const result = await finalGuard();
    if (!result || result.status !== 'READY') throw new UnknownFactError('V7_INPUT_GUARD_NOT_PROVEN', undefined, result || {});
    return result;
  };
  const registry = new ProductionRegistry(manifest);
  const coordinator = createCommitCoordinator(root);
  for (const key of Object.values(KEY)) registry.register(key, async (context, payload) => {
    let returned;
    const proveDecisionBasis = () => {
      const basis = payload.intent.decisionBasis;
      if (!basis) return; // Existing field/recovery units do not start a new strategy decision.
      const current = loadSnapshot(root);
      if (typeof basis.snapshotKey !== 'string' || current.snapshotKey !== basis.snapshotKey ||
          !known(current.hand) || current.hand.data.revision !== basis.handRevision ||
          !known(current.session) || current.session.data.duelId !== basis.duelId)
        throw new UnknownFactError('V7_STRATEGY_BASIS_CHANGED_NO_INPUT');
    };
    const confirmReturned = tx => {
      const after = loadSnapshot(root);
      if (!returned || returned.executed !== true || !known(after.hand) || !known(after.ledger) || !known(after.runtime) || after.consistency.length)
        throw new ContractError('V7_LEGACY_COMMITTED_STATE_INCONSISTENT');
      if (!returned.state || returned.state.revision !== after.hand.data.revision ||
          !Array.isArray(returned.state.cards) || hashValue(returned.state.cards.map(c => c.id)) !== hashValue(after.hand.data.cards.map(c => c.id)))
        throw new ContractError('V7_RETURNED_HAND_NOT_COMMITTED_HAND');
      const evidence = { proven: true, source: returned.passiveRecovery ? 'RECONCILED_SUBMITTED_UNIT' : 'MATURE_DRIVER_RETURN_AND_ALIGNED_STATE',
        capability: key, transactionId: tx.id, handRevision: after.hand.data.revision,
        handHash: after.hand.hash, ledgerHash: after.ledger.hash, runtimeHash: after.runtime.hash,
        recoveryRuntimeOwner: returned.recoveryRuntimeOwner || null };
      atomicWriteJson(insidePath(root, path.join(root, 'debug/v7/unit-receipts', tx.id + '.json')), evidence);
      return evidence;
    };
    const action = { type: key, instanceBasis: async () => payload.intent,
      steps: [{ id: 'MATURE_VERIFIED_UNIT', mode: 'LEGACY_MONOLITH', stateOwner: 'LEGACY',
        guard: async () => {
          const snapshot = loadSnapshot(root);
          const baseline = canStartNewDecision(snapshot, coordinator, null);
          if (baseline.status !== 'READY') return baseline;
          proveDecisionBasis();
          if (key === KEY.HAND && payload.intent.cardId === 'M14') {
            const equipment = snapshot.runtime.data.bambooSwordEquipped;
            const golden = require('../core/capability').goldenDraw2(snapshot, { bambooEquip:
              { status: equipment === true ? 'PROVEN' : equipment === false ? 'ABSENT' : 'UNKNOWN', evidence: 'LEGACY_VERIFIED_EQUIP_STATE' } });
            if (golden.status !== 'READY') return golden;
          }
          return proveInputSafety();
        },
        prepare: async () => ({ intent: payload.intent }), beforeInput: async () => {
          proveDecisionBasis(); return proveInputSafety();
        },
        executeLegacy: async (_ctx, _prepared, tx) => {
          mature.assertFreshRuntimeBeforeGameAction();
          returned = await payload.execute();
          if (!returned || returned.executed !== true) throw new NotReadyError('LEGACY_EXECUTION_RESULT_NOT_PROVEN');
          const evidence = confirmReturned(tx);
          return { verified: true, evidence, stateResult: { owner: 'LEGACY', committed: true } };
        },
        recoverEvidence: async (_ctx, tx) => {
          const receipt = readOwnedJson(insidePath(root, path.join(root, 'debug/v7/unit-receipts', tx.id + '.json')));
          if (!receipt && recoverSubmitted) {
            returned = await recoverSubmitted(tx, key);
            return confirmReturned(tx);
          }
          if (!receipt || receipt.transactionId !== tx.id || receipt.capability !== key || receipt.proven !== true)
            throw new NotReadyError('V7_CURRENT_UNIT_RECEIPT_NOT_PROVEN');
          const after = loadSnapshot(root);
          if (!known(after.hand) || !known(after.ledger) || after.consistency.length ||
              receipt.handHash !== after.hand.hash || receipt.ledgerHash !== after.ledger.hash || receipt.runtimeHash !== after.runtime.hash)
            throw new NotReadyError('V7_RECOVERY_STATE_NOT_RECEIPT_STATE');
          returned = { executed: true, state: mature.loadObserverSessionState(), quit: false, passiveRecovery: true };
          return receipt;
        }
      }] };
    const result = await runAction(action, context);
    if (result.status === 'ALREADY_COMMITTED') return { executed: true, state: mature.loadObserverSessionState(), quit: false, alreadyCommitted: true, v7TransactionId: result.transaction.id };
    if (result.status !== 'COMMITTED') throw new NotReadyError('V7_UNIT_NOT_PROVEN', undefined,
      { status: result.status, step: result.step, reason: result.reason, transactionId: result.transaction && result.transaction.id });
    return { ...returned, v7TransactionId: result.transaction.id };
  });
  return {
    registry,
    async dispatch(key, intent, execute) {
      return registry.dispatch(key, { root, snapshot: async () => loadSnapshot(root) }, { intent, execute });
    }
  };
}
module.exports = { KEY, makeBindings };
