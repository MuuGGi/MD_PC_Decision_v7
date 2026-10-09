'use strict';
const { countRuntimeCardIds, canonicalRuntimeCardId } = require('../../lib/exodia-policy');

const MALLET_RESUME_STATUSES = Object.freeze([
  'SELECTION_ACTIVE', 'READY_TO_CONFIRM', 'CONFIRMED', 'RESOLUTION_PROVEN'
]);

function committedSelectionState(checkpoint) {
  const plan = checkpoint && checkpoint.plan;
  const returned = plan && plan.returned;
  const committed = checkpoint && checkpoint.committedIds;
  if (!Array.isArray(returned) || !returned.length || !Array.isArray(committed)) {
    throw new Error('M11_COMPLETION_SELECTION_LEDGER_INVALID');
  }
  for (const card of returned) {
    if (!card || !card.id) throw new Error('M11_COMPLETION_RETURN_ID_INVALID');
  }
  const available = countRuntimeCardIds(returned);
  for (const rawId of committed) {
    const id = canonicalRuntimeCardId(rawId);
    const left = available.get(id) || 0;
    if (left <= 0) throw new Error(`M11_COMPLETION_UNPLANNED_COMMIT:${id}`);
    available.set(id, left - 1);
  }
  const complete = committed.length === returned.length;
  if (checkpoint.status !== 'SELECTION_ACTIVE' && !complete) {
    throw new Error('M11_COMPLETION_INCOMPLETE_FINAL_CHECKPOINT');
  }
  return { complete, expectedDrawCount: returned.length };
}

function resolutionMatchesSelection(proof, count) {
  return Boolean(proof && proof.status === 'PASS' &&
    proof.expectedDrawCount === count && proof.drawResultCount === count &&
    proof.returnBeforePrimaryDrawCount > 0 && proof.drawLabelCount > 0);
}

async function completeMalletSelection({ checkpoint, waitStable, observeResolution,
  probePrompt, confirmSelection, persistCheckpoint }) {
  const selected = committedSelectionState(checkpoint);
  if (!selected.complete) throw new Error('M11_COMPLETION_BEFORE_ALL_COMMITS');
  const count = selected.expectedDrawCount;
  // Last explicit Select can already close the modal and begin the redraw.
  // Never turn a saved READY_TO_CONFIRM back into candidate selection.
  await waitStable(count);
  let resolutionProof = await observeResolution({ expectedDrawCount: count,
    maxAttempts: 2, retryWaitMs: 500, throwOnNotReady: false });
  let next = { ...checkpoint };
  let confirmProof = checkpoint.confirmProof || null;
  if (!resolutionMatchesSelection(resolutionProof, count)) {
    const prompt = await probePrompt();
    if (!confirmProof && !['CONFIRMED', 'RESOLUTION_PROVEN'].includes(checkpoint.status) &&
        prompt.modalBodyProven === true && prompt.likelyVisible === true &&
        prompt.action && prompt.action.usable && prompt.action.usable.left === true) {
      confirmProof = await confirmSelection();
      next = { ...next, status: 'CONFIRMED', confirmProof };
      persistCheckpoint(next);
      await waitStable(count);
    }
    // Closed modal / ambiguous yellow hand art is never a Confirm fallback.
    resolutionProof = await observeResolution({ expectedDrawCount: count,
      maxAttempts: 8, retryWaitMs: 700, throwOnNotReady: true });
  }
  if (!resolutionMatchesSelection(resolutionProof, count)) {
    throw new Error('M11_COMPLETION_RESOLUTION_NOT_PROVEN');
  }
  next = { ...next, status: 'RESOLUTION_PROVEN', confirmProof, resolutionProof,
    completionMode: confirmProof ? 'CONFIRM_THEN_CURRENT_RETURN_DRAW_TAIL' : 'CURRENT_RETURN_DRAW_TAIL_WITHOUT_CONFIRM_INPUT' };
  persistCheckpoint(next);
  return { checkpoint: next, confirmProof, resolutionProof,
    selectionProof: checkpoint.selectionProof || { selectedCount: count,
      newlyCommittedCount: 0, alreadyCommittedIds: checkpoint.committedIds.slice(),
      rows: [], keptCount: (checkpoint.plan.kept || []).length,
      protectedRemaining: (checkpoint.plan.kept || []).slice(), policy: 'SAVED_EXPLICIT_COMMIT_LEDGER' } };
}

module.exports = { MALLET_RESUME_STATUSES, committedSelectionState,
  resolutionMatchesSelection, completeMalletSelection };
