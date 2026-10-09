'use strict';
const { hashValue, clone } = require('./json-store');
const { createJournal } = require('./transaction-journal');
const { deriveDuelIdentity, buildActionBaseline } = require('./snapshot');
const { withFileLock } = require('./file-lock');
const { ContractError, UnknownFactError, UnsafeReplayError, NotReadyError } = require('./errors');
const STEP = Object.freeze({ PREPARED: 'PREPARED', NO_REPLAY_PERSISTED: 'NO_REPLAY_PERSISTED',
  INPUT_SENT: 'INPUT_SENT', EVIDENCE_CONFIRMED: 'EVIDENCE_CONFIRMED', STATE_COMMITTING: 'STATE_COMMITTING', COMMITTED: 'COMMITTED' });
const now = () => new Date().toISOString();
function instanceKey(duelId, actionType, baseline, intent) {
  return 'INST-' + hashValue({ duelId, actionType, baseline, intent }).slice(0, 32);
}
function assertAction(action) {
  if (!action || typeof action.type !== 'string' || !action.type) throw new ContractError('ACTION_TYPE_REQUIRED');
  if (!Array.isArray(action.steps) || !action.steps.length) throw new ContractError('ACTION_STEPS_REQUIRED');
  const seen = new Set();
  for (const step of action.steps) {
    if (!step.id || seen.has(step.id)) throw new ContractError('STEP_ID_INVALID_OR_DUPLICATE');
    seen.add(step.id);
    for (const method of ['guard', 'prepare', 'recoverEvidence']) if (typeof step[method] !== 'function')
      throw new ContractError('STEP_CONTRACT_INCOMPLETE', undefined, { step: step.id, method });
    if (!['LEGACY', 'V7'].includes(step.stateOwner)) throw new ContractError('STEP_STATE_OWNER_REQUIRED');
    if (step.stateOwner === 'V7' && typeof step.commit !== 'function') throw new ContractError('V7_STATE_OWNER_REQUIRES_COMMIT');
    if (step.mode === 'LEGACY_MONOLITH') {
      if (step.stateOwner !== 'LEGACY' || typeof step.executeLegacy !== 'function') throw new ContractError('LEGACY_MONOLITH_CONTRACT_INVALID');
    } else if (typeof step.sendInput !== 'function' || typeof step.verify !== 'function') throw new ContractError('STEP_INPUT_VERIFY_REQUIRED');
  }
}
function proof(value, spec) {
  if (!value || typeof value !== 'object' || value.proven !== true) throw new NotReadyError('STEP_EVIDENCE_NOT_PROVEN');
  if (typeof spec.validateEvidence === 'function' && spec.validateEvidence(value) !== true)
    throw new NotReadyError('STEP_EVIDENCE_CONTRACT_FAILED');
  return value;
}
function validateResume(tx, action) {
  if (tx.actionType !== action.type) throw new UnsafeReplayError('OTHER_TRANSACTION_IN_FLIGHT', undefined, { id: tx.id, action: tx.actionType });
  if (tx.steps.length !== action.steps.length || tx.steps.some((step, i) => step.id !== action.steps[i].id || !Object.values(STEP).includes(step.state)))
    throw new ContractError('TRANSACTION_SCHEMA_CHANGED_DURING_RECOVERY');
  if (tx.steps.some((step, i) => (step.mode && step.mode !== (action.steps[i].mode || 'SEPARATED')) ||
      (step.stateOwner && step.stateOwner !== action.steps[i].stateOwner)))
    throw new ContractError('TRANSACTION_OWNERSHIP_CHANGED_DURING_RECOVERY');
  return tx;
}
async function createOrResume(action, context, store) {
  assertAction(action);
  const snapshot = await context.snapshot(), duel = deriveDuelIdentity(snapshot);
  if (duel.status !== 'KNOWN') throw new UnknownFactError('DUEL_ID_UNKNOWN');
  if (context.resumeTransactionId) {
    const tx = store.load(context.resumeTransactionId);
    if (!tx || tx.duelId !== duel.value) throw new UnsafeReplayError('RECOVERY_TRANSACTION_NOT_CURRENT_DUEL');
    return { tx: { ...validateResume(tx, action), resumed: true } };
  }
  // Active identity is durable. Current observations necessarily change AFTER input.
  const active = store.listActive ? store.listActive(duel.value) : [];
  if (active.length > 1) throw new ContractError('MULTIPLE_ACTIVE_TRANSACTIONS');
  if (active.length) return { tx: { ...validateResume(active[0], action), resumed: true } };
  const intent = typeof action.instanceBasis === 'function' ? await action.instanceBasis(context, snapshot) : {};
  const baseline = buildActionBaseline(snapshot, intent), key = instanceKey(duel.value, action.type, baseline, intent);
  const compatible = store.findActiveByInstanceKey(key);
  if (compatible) return { tx: { ...validateResume(compatible, action), resumed: true } };
  const done = store.findArchivedByInstanceKey ? store.findArchivedByInstanceKey(key) : null;
  if (done) return { completed: done };
  if (snapshot.consistency && snapshot.consistency.length) throw new UnknownFactError('SNAPSHOT_INCONSISTENT');
  const tx = { version: 2, id: duel.value + '-T' + String(store.nextSequence(duel.value)).padStart(4, '0'),
    duelId: duel.value, actionType: action.type, instanceKey: key, intent, baseline,
    createdAt: now(), resumed: false, status: 'ACTIVE', currentStep: 0,
    steps: action.steps.map(step => ({ id: step.id, state: STEP.PREPARED, stateOwner: step.stateOwner,
      mode: step.mode || 'SEPARATED', irreversible: step.irreversible !== false })) };
  store.save(tx); return { tx };
}
function update(store, tx, index, patch) {
  tx.steps[index] = { ...tx.steps[index], ...patch }; tx.currentStep = index; store.save(tx); return tx.steps[index];
}
async function runUnlocked(action, context, store) {
  const resumed = await createOrResume(action, context, store);
  if (resumed.completed) return { status: 'ALREADY_COMMITTED', transaction: resumed.completed };
  const tx = resumed.tx;
  for (let i = 0; i < action.steps.length; i++) {
    const spec = action.steps[i]; let step = tx.steps[i];
    if (step.state === STEP.COMMITTED) continue;
    if (step.stateOwner && step.stateOwner !== spec.stateOwner) throw new ContractError('STATE_OWNER_CHANGED_DURING_RECOVERY');
    const recovering = tx.resumed === true && step.state !== STEP.PREPARED;
    try {
      if (step.state === STEP.PREPARED) {
        const guard = await spec.guard(context, tx, step);
        if (!guard || guard.status !== 'READY') return { status: guard && guard.status === 'BLOCKED' ? 'BLOCKED' : 'WAITING', transaction: tx, step: spec.id, guard };
        const prepared = await spec.prepare(context, tx, step);
        if (typeof spec.beforeInput === 'function') {
          const final = await spec.beforeInput(context, tx, prepared);
          if (!final || final.status !== 'READY') return { status: 'WAITING', transaction: tx, step: spec.id, guard: final };
        }
        step = update(store, tx, i, { state: STEP.NO_REPLAY_PERSISTED, prepared, noReplayAt: now(), guardEvidence: guard.evidence || null });
      }
      if (step.state === STEP.NO_REPLAY_PERSISTED) {
        if (recovering) {
          const evidence = proof(await spec.recoverEvidence(context, tx, step), spec);
          step = update(store, tx, i, { state: STEP.EVIDENCE_CONFIRMED, evidence, evidenceAt: now(), recoveredWithoutReplay: true });
        } else if (spec.mode === 'LEGACY_MONOLITH') {
          const result = await spec.executeLegacy(context, step.prepared, tx, step);
          if (!result || result.verified !== true) throw new NotReadyError('LEGACY_RESULT_NOT_VERIFIED');
          const evidence = proof(result.evidence, spec);
          step = update(store, tx, i, { state: STEP.EVIDENCE_CONFIRMED, evidence, evidenceAt: now(), legacyStateResult: result.stateResult || { owner: 'LEGACY' } });
        } else {
          const receipt = await spec.sendInput(context, step.prepared, tx, step);
          step = update(store, tx, i, { state: STEP.INPUT_SENT, inputReceipt: receipt || null, inputSentAt: now() });
        }
      }
      if (step.state === STEP.INPUT_SENT) {
        const evidence = proof(await (recovering ? spec.recoverEvidence(context, tx, step) : spec.verify(context, tx, step)), spec);
        step = update(store, tx, i, { state: STEP.EVIDENCE_CONFIRMED, evidence, evidenceAt: now() });
      }
      if (step.state === STEP.EVIDENCE_CONFIRMED) {
        proof(step.evidence, spec);
        step = spec.stateOwner === 'LEGACY'
          ? update(store, tx, i, { state: STEP.COMMITTED, stateResult: { owner: 'LEGACY' }, committedAt: now() })
          : update(store, tx, i, { state: STEP.STATE_COMMITTING, stateCommitStartedAt: now() });
      }
      // Disk recovery does NOT require an activation prompt which is already closed.
      if (step.state === STEP.STATE_COMMITTING) {
        proof(step.evidence, spec);
        const result = await spec.commit(context, tx, step);
        step = update(store, tx, i, { state: STEP.COMMITTED, stateResult: result, committedAt: now() });
      }
    } catch (error) {
      update(store, tx, i, { inputUncertain: step.state === STEP.NO_REPLAY_PERSISTED,
        lastError: { phase: step.state, code: error.code || null, message: String(error.message || error), at: now() } });
      if (error instanceof NotReadyError) return { status: 'WAITING', transaction: tx, step: spec.id, reason: error.code };
      throw error;
    }
  }
  tx.status = 'COMMITTED'; tx.committedAt = now(); store.save(tx); store.archive(tx);
  return { status: 'COMMITTED', transaction: clone(tx) };
}
async function runAction(action, context) {
  const store = context.journal || createJournal(context.root);
  return store.lockPath ? withFileLock(store.lockPath, () => runUnlocked(action, context, store)) : runUnlocked(action, context, store);
}
function assertNoReplay(tx) {
  for (const step of tx.steps || []) if (step.state !== STEP.PREPARED && step.replayRequested)
    throw new UnsafeReplayError('NO_REPLAY_BOUNDARY_VIOLATED', undefined, { step: step.id });
  return true;
}
module.exports = { STEP, instanceKey, runAction, assertNoReplay };
