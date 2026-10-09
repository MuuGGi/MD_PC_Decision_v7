'use strict';
const crypto = require('crypto');
const { compareSavedBlockToCurrent } = require('./duel-log-tail-continuity');
const { checkpointFrom } = require('./duel-log-state');

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function logFingerprint(state) {
  return fingerprint({ checkpoint: state?.checkpoint, tailBlocks: state?.tailBlocks || [] });
}
function handFingerprint(state) {
  return fingerprint({ revision: Number(state?.revision || 0), cards: (state?.cards || []).map(c => c.id) });
}
function beginTransaction({ baseline, logBefore, bottomThumb, activationKey, now = Date.now() }) {
  if (!baseline || baseline.cards?.length !== baseline.handCount ||
      !baseline.cards.some(c => c.id === activationKey) || !logBefore?.checkpoint) {
    throw new Error('ATOMIC_LOG_TRANSACTION_BASELINE_INVALID');
  }
  return { version: 1, actionId: crypto.randomUUID(), activationKey,
    startedAt: now, baselineFingerprint: handFingerprint(baseline),
    logFingerprint: logFingerprint(logBefore), bottomThumb };
}
function completeTransaction(draft, { selected, actionProof, gainCount, firstGainId,
  confirmationProofs, now = Date.now() }) {
  if (!draft || selected?.selected?.accepted !== true || selected.selected.id !== draft.activationKey ||
      actionProof?.responseBoundaryPriority?.safeForRecognitionAndControl !== true ||
      !actionProof.activationButton || ![1, 2].includes(gainCount) || !/^M\d{2}$/.test(firstGainId) ||
      !confirmationProofs?.length || confirmationProofs.some(proof => proof !== true)) {
    throw new Error('ATOMIC_LOG_TRANSACTION_EXECUTION_UNPROVEN');
  }
  return { ...draft, completedAt: now, gainCount, firstGainId, executionConfirmed: true };
}
function validateTransaction(receipt, { baseline, logBefore, activationKey, now = Date.now() }) {
  if (receipt?.version !== 1 || !receipt.actionId || receipt.executionConfirmed !== true ||
      receipt.activationKey !== activationKey || ![1, 2].includes(receipt.gainCount) ||
      !/^M\d{2}$/.test(receipt.firstGainId) ||
      receipt.baselineFingerprint !== handFingerprint(baseline) ||
      receipt.logFingerprint !== logFingerprint(logBefore) ||
      !Number.isFinite(receipt.startedAt) || !Number.isFinite(receipt.completedAt) ||
      receipt.completedAt < receipt.startedAt || receipt.completedAt > now ||
      now - receipt.completedAt > 120000 || logBefore?.atomicActionId === receipt.actionId) {
    throw new Error('ATOMIC_LOG_TRANSACTION_NOT_CURRENT');
  }
  return receipt;
}

// The scrollbar's bottom-anchored thumb shrinks when history is appended.
// Content equality alone cannot distinguish repeated spell transactions.
function historyAppendProven(before, after) {
  return Boolean(before?.atBottom && after?.atBottom &&
    Number.isFinite(before.top) && Number.isFinite(after.top) &&
    Math.abs(before.bottom - after.bottom) <= 1 && Math.abs(before.x - after.x) <= 3 &&
    before.top - after.top >= 2);
}
function reconcileTransactionBottom(previous, blocks, receipt, currentThumb) {
  if (!receipt || !historyAppendProven(receipt.bottomThumb, currentThumb) ||
      !Array.isArray(blocks) || blocks.length < 2) return null;
  const last = blocks[blocks.length - 1];
  if (last.activationKey !== receipt.activationKey) return null;
  const prefix = blocks.slice(0, -1), saved = previous?.tailBlocks || [];
  if (prefix.length > saved.length || !prefix.every((b, i) =>
    compareSavedBlockToCurrent(saved[saved.length - prefix.length + i], b).matched)) return null;
  const gains = (last.details || []).filter(d => d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE');
  if (gains.length > receipt.gainCount || (gains.length && gains[0].card?.id !== receipt.firstGainId)) return null;
  return { continuity: 'CONTINUOUS_EXECUTOR_TRANSACTION_APPEND', checkpointFound: true,
    matchedAnchor: { kind: 'EXECUTOR_TRANSACTION_APPEND', source: 'VISIBLE_OPERATION_BLOCK',
      cardKey: receipt.activationKey, actionId: receipt.actionId, historyAppendProven: true },
    newBlocks: [last], state: { version: 1, capturedAt: new Date().toISOString(),
      checkpoint: checkpointFrom(blocks), atomicActionId: receipt.actionId } };
}
module.exports = { beginTransaction, completeTransaction, validateTransaction,
  historyAppendProven, reconcileTransactionBottom };
