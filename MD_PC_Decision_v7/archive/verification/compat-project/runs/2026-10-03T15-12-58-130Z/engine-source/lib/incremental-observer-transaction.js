'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, restoreBuffer, readJsonIfExistsSafe } = require('./runtime-files');
const { applyIncrementalResultToMainDeckLedger } = require('./main-deck-ledger');
const { isExodiaComponentCard } = require('./exodia-policy');
const ROOT = path.resolve(__dirname, '..');
const PENDING_OBSERVER_PATH = path.join(ROOT, 'debug/hand-change-live/pending_observer_transaction.json');
const LEDGER_PATH = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const RESUMABLE_HAND_EFFECTS = new Set(['M09', 'M12', 'M14', 'M15', 'M16', 'M17']);

function commitIncrementalObserverResult({ incrementalResult, log, statePath, resultPath }) {
  const paths = [LEDGER_PATH, statePath, resultPath];
  const before = paths.map(filename => fs.existsSync(filename) ? fs.readFileSync(filename) : null);
  try {
    for (const insertion of incrementalResult.insertedCards || []) {
      if (!/^M\d+$/.test(String(insertion.card && insertion.card.id || '')) &&
          !isExodiaComponentCard(insertion.card)) {
        throw new Error('OBSERVER_GAIN_IDENTITY_UNRESOLVED');
      }
    }
    // The shared ledger validates the entire transition before exposing a new hand.
    applyIncrementalResultToMainDeckLedger({ incrementalResult, log });
    writeJsonAtomic(statePath, incrementalResult.after, { trailingNewline: true });
    writeJsonAtomic(resultPath, incrementalResult, { trailingNewline: true });
  } catch (error) {
    for (let i = 0; i < paths.length; i++) restoreBuffer(paths[i], before[i]);
    error.observerCommitFailure = true;
    throw error;
  }
}

function recordFailedIncrementalObservation({ activationKey, selectedCardId, selectedSlot,
  before, decisionBefore, log, error }) {
  if (!RESUMABLE_HAND_EFFECTS.has(activationKey) || activationKey !== selectedCardId || !before) return null;
  const pending = { version: 1, status: 'OBSERVATION_FAILED', activationKey,
    slot: Number(selectedSlot), before, decisionBefore, log,
    baselineFingerprint: (before.cards || []).map(card => card.id).join('>'),
    failedAt: new Date().toISOString(), error: String(error && error.message || error),
    recoveryPolicy: 'CURRENT_BOTTOM_INCREMENTAL_ONLY_NO_CARD_ACTIVATION_NO_FULL_HAND_SCAN' };
  writeJsonAtomic(PENDING_OBSERVER_PATH, pending, { trailingNewline: true });
  return pending;
}

function loadPendingIncrementalObservation(state) {
  const pending = readJsonIfExistsSafe(PENDING_OBSERVER_PATH);
  if (!pending) {
    if (fs.existsSync(PENDING_OBSERVER_PATH)) throw new Error('PENDING_OBSERVER_TRANSACTION_UNREADABLE');
    return null;
  }
  if (pending.version !== 1 || pending.status !== 'OBSERVATION_FAILED' ||
      !RESUMABLE_HAND_EFFECTS.has(pending.activationKey) || !Number.isInteger(pending.slot) || pending.slot < 1 ||
      !pending.before || !pending.decisionBefore || !pending.baselineFingerprint ||
      pending.baselineFingerprint !== (pending.before.cards || []).map(card => card.id).join('>') ||
      pending.baselineFingerprint !== (state.cards || []).map(card => card.id).join('>') ||
      Number(pending.before.revision) !== Number(state.revision)) {
    throw new Error('PENDING_OBSERVER_TRANSACTION_BASELINE_INVALID');
  }
  const currentDecision = readJsonIfExistsSafe(path.join(ROOT, 'decision-state.json'));
  if (JSON.stringify(currentDecision) !== JSON.stringify(pending.decisionBefore)) {
    throw new Error('PENDING_OBSERVER_TRANSACTION_ACCOUNTING_CHANGED');
  }
  return pending;
}

module.exports = { PENDING_OBSERVER_PATH, commitIncrementalObserverResult,
  recordFailedIncrementalObservation, loadPendingIncrementalObservation };
