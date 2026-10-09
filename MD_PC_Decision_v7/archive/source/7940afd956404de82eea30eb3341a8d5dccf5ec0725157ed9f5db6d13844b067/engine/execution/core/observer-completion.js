'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const OUTCOME_PATH = path.join(ROOT, 'debug/duel-outcome-live/latest_result.json');
function outcomeMtimeMs(file = OUTCOME_PATH) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}
function readFreshVictoryOutcome(previousMtimeMs, observerStartedAt, file = OUTCOME_PATH) {
  if (outcomeMtimeMs(file) <= previousMtimeMs) return null;
  const outcome = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checkedAt = Date.parse(outcome?.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt < observerStartedAt - 1000 ||
      outcome?.terminal !== true || outcome.type !== 'VICTORY' ||
      outcome.strictEvidence?.matched !== true) return null;
  return outcome;
}
// Void the ordinary settlement verdict ONLY after independent strict WIN
// proof. This is not an action PASS, a physical undo, or a ledger rollback.
function voidOrdinarySettlement(outcome, previousVerdict = { status: 'NOT_EVALUATED' }) {
  if (outcome?.terminal !== true || outcome.type !== 'VICTORY' ||
      outcome.strictEvidence?.matched !== true || !Number.isFinite(Date.parse(outcome.checkedAt))) {
    throw new Error('SETTLEMENT_VOID_REQUIRES_CONFIRMED_VICTORY');
  }
  return { status: 'VOID_AFTER_CONFIRMED_VICTORY', reason: 'ORDINARY_VALIDATION_NO_LONGER_APPLICABLE',
    outcomeCheckedAt: outcome.checkedAt, previousVerdict,
    countsAsExecutionPass: false, countsAsActionFailure: false, canCommitHandDelta: false };
}
// Observer success has two mutually exclusive meanings. Executors must branch
// BEFORE reading ordinary hand/log artifacts, which remain old on a victory.
function observeCompletion(runObserver, file = OUTCOME_PATH) {
  const before = outcomeMtimeMs(file), startedAt = Date.now();
  runObserver();
  const outcome = readFreshVictoryOutcome(before, startedAt, file);
  return outcome ? { kind: 'TERMINAL_VICTORY', outcome } : { kind: 'HAND_DELTA' };
}
module.exports = { outcomeMtimeMs, readFreshVictoryOutcome, observeCompletion, voidOrdinarySettlement };
