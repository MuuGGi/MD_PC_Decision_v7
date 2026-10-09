'use strict';
const fs = require('fs'), path = require('path');
const { readOwnedJson, hashValue, insidePath } = require('../core/json-store');
const { NotReadyError, ContractError } = require('../core/errors');
const { createCommitCoordinator } = require('../core/state-commit');
function inspectSubmittedEquipment(root, tx, actionsFile) {
  const fail = reason => { throw new NotReadyError('SUBMITTED_EQUIP_' + reason); };
  const id = tx && tx.intent && tx.intent.cardId;
  if (!tx || tx.actionType !== 'UNIT:HAND_SELECTION' || !['M19', 'M20'].includes(id) ||
      tx.steps[0]?.state !== 'NO_REPLAY_PERSISTED' || tx.baseline.runtime.bambooSwordEquipped !== false) fail('UNSUPPORTED_STAGE');
  const parent = insidePath(root, path.join(root, 'debug/execution/V5_formal_atomic'));
  const at = Date.parse(tx.noReplayAt || tx.steps[0].noReplayAt);
  const attempts = fs.readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.endsWith('_' + id + '_equip'))
    .map(e => ({ dir: insidePath(root, path.join(parent, e.name)), at: Date.parse(e.name.split('_')[0].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z$/, 'T$1:$2:$3.$4Z')) }))
    .filter(e => Number.isFinite(at) && e.at >= at);
  if (attempts.length !== 1) fail('ATTEMPT_NOT_UNIQUE');
  const directory = attempts[0].dir;
  const targetFile = insidePath(root, path.join(directory, 'equip_target/preferred_equip_carrier.json'));
  const confirmFile = insidePath(root, path.join(directory, 'equip_confirm', id + '_equip_confirm_latest.json'));
  const target = readOwnedJson(targetFile), confirm = readOwnedJson(confirmFile);
  if (target?.recognized?.accepted !== true || !target.recognized.id ||
      target.recognized.id !== tx.baseline.runtime.branch?.carrierId || confirm?.probe?.visible !== true ||
      !/EQUIP_CONFIRM/.test(confirm.probe.detector || '') || !Number.isFinite(confirm.probe.chosen?.centerX) ||
      !Number.isFinite(confirm.probe.chosen?.centerY)) fail('TARGET_OR_CONFIRM_NOT_PROVEN');
  const events = fs.readFileSync(actionsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const inputs = events.filter(e => /^INPUT_(REQUEST|COMPLETE)$/.test(e.type));
  const geometry = tx.steps[0].guardEvidence?.client;
  if (!(geometry?.width > 0 && geometry?.height > 0)) fail('INPUT_GEOMETRY_NOT_PROVEN');
  const complete = inputs.at(-1), request = inputs.at(-2), point = {
    x: confirm.probe.chosen.centerX * geometry.width / 2048,
    y: confirm.probe.chosen.centerY * geometry.height / 1152 };
  if (!complete || complete.type !== 'INPUT_COMPLETE' || request?.type !== 'INPUT_REQUEST' ||
      hashValue(complete.command) !== hashValue(request.command) || complete.command.cmd !== 'click' ||
      complete.command.x !== Math.round(point.x) || complete.command.y !== Math.round(point.y) ||
      Date.parse(complete.at) < attempts[0].at || Date.parse(confirm.capturedAt) < at ||
      Date.parse(confirm.capturedAt) > Date.parse(complete.at)) fail('CONFIRM_INPUT_RECEIPT_MISSING');
  return { transactionId: tx.id, cardId: id, carrier: target, directory, targetFile, confirmFile, actionsFile };
}
async function recoverSubmittedEquipment({ root, tx, ticket, mature, finalGuard, observeOutcome = null }) {
  const proof = inspectSubmittedEquipment(root, tx, ticket.actionsFile);
  if (hashValue(proof) !== ticket.equipmentProofHash) throw new ContractError('AUTOTEST_RESUME_EVIDENCE_CHANGED');
  const decisionPath = path.join(root, 'decision-state.json'), before = readOwnedJson(decisionPath);
  const expected = tx.baseline.runtime;
  const baselineMatches = hashValue(before.v5Branch) === hashValue(expected.branch) &&
    hashValue(before.usedCounts) === hashValue(expected.usedCounts) && before.bambooSwordEquipped === false;
  const commitId = tx.id + '_EQUIP_STATE', coordinator = createCommitCoordinator(root), plan = coordinator.load(commitId);
  if (!baselineMatches && !plan) throw new ContractError('AUTOTEST_RESUME_RUNTIME_BASELINE_CHANGED');
  const hand = mature.loadObserverSessionState();
  const expectedCards = [...tx.baseline.hand.cards];
  if (expectedCards[Number(tx.intent.slot) - 1] !== proof.cardId) throw new ContractError('AUTOTEST_RESUME_SELECTED_SLOT_CHANGED');
  expectedCards.splice(Number(tx.intent.slot) - 1, 1);
  let after = hand;
  if (hand.revision === tx.baseline.hand.revision) {
    if (hashValue(hand.cards.map(c => c.id)) !== hashValue(tx.baseline.hand.cards)) throw new ContractError('AUTOTEST_RESUME_HAND_BASELINE_CHANGED');
    const guard = await finalGuard();
    if (guard.status !== 'READY') throw new ContractError('AUTOTEST_RESUME_FOREGROUND_UNSAFE');
    // ONLY observation/INFO; no activate/equip/confirm/material inputs replayed.
    after = (observeOutcome || require('../../engine/execution/core/atomic-route-executor').runObserver)({ expectedAtomicActivationKey: proof.cardId });
  }
  if (after.revision !== tx.baseline.hand.revision + 1 || after.handCount !== expectedCards.length ||
      hashValue(after.cards.map(c => c.id)) !== hashValue(expectedCards)) throw new ContractError('AUTOTEST_RESUME_EQUIP_DELTA_NOT_PROVEN');
  const log = readOwnedJson(path.join(root, 'debug/duel-log-live/latest_result.json'));
  const blocks = (log?.newOperationBlocks || []).filter(b => b.activationKey === proof.cardId && b.activation?.side === 'SELF');
  if (!/^CONTINUOUS/.test(log?.continuity || '') || blocks.length !== 1 || !(blocks[0].details || []).some(d =>
    d.side === 'SELF' && d.card?.id === proof.carrier.recognized.id && /TARGET/.test(d.rawType || d.role || d.type || '')))
    throw new ContractError('AUTOTEST_RESUME_EQUIP_CURRENT_LOG_NOT_PROVEN');
  const ledger = readOwnedJson(path.join(root, 'debug/main-deck-ledger/state.json'));
  if (ledger.lastHandRevision !== after.revision || hashValue(ledger.outsideDeckCounts) !== hashValue(tx.baseline.ledger.counts))
    throw new ContractError('AUTOTEST_RESUME_EQUIP_LEDGER_NOT_PROVEN');
  // Observer owns hand+ledger. ONLY the previously absent runtime completion is
  // committed here, through the same pure mature reducer and idempotent plan.
  if (!plan) coordinator.prepare({ commitId, operations: [{ operationKey: 'SUBMITTED_EQUIP_RUNTIME', targetPath: decisionPath,
    transform: runtime => mature.deriveSwordEquippedState(runtime, proof.cardId, proof.carrier) }] });
  coordinator.apply(commitId);
  return { executed: true, state: after, quit: false, passiveRecovery: true, recoveryRuntimeOwner: 'V7' };
}
module.exports = { inspectSubmittedEquipment, recoverSubmittedEquipment };
