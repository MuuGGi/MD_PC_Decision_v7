'use strict';
const sequence = cards => (cards || []).map(card => card.id);
function completeE10ResolutionDecision(runtime, { zeroTargetId, zeroTargetSource, handRevision }) {
  if (runtime.v5Branch?.currentState === 'E10_EFFECT_RESOLVED' &&
      runtime.v5Branch.carrierId === 'E10' && runtime.lastE10Resolution?.handRevision === handRevision) return runtime;
  const state = { ...runtime, usedCounts: { ...(runtime.usedCounts || {}) } };
  if (zeroTargetId && zeroTargetSource === 'GRAVE') {
    state.usedCounts[zeroTargetId] = Math.max(0, Number(state.usedCounts[zeroTargetId] || 0) - 1);
  }
  state.rayeNormalSummoned = false;
  // Resolving the effect releases the prompt lock; the summoned monster remains
  // in the Extra Monster Zone and still blocks Hornet's token entrance.
  state.v5Branch = { active: false, currentState: 'E10_EFFECT_RESOLVED', carrierId: 'E10',
    updatedAt: new Date().toISOString(), source: 'FORMAL_V5_R3' };
  state.lastE10Resolution = { targetId: zeroTargetId, targetSource: zeroTargetSource, handRevision };
  return state;
}
function verifyE10IncrementalResolution({ baseline, targetId, targetSource, log, incremental, hand, ledger }) {
  const same = (a, b) => JSON.stringify(sequence(a)) === JSON.stringify(sequence(b));
  const before = incremental?.before, after = incremental?.after, inf = incremental?.inference;
  const blocks = log?.newOperationBlocks || [];
  const targets = blocks.filter(block => block.activationKey === 'E10');
  const gains = targets[0]?.details?.filter(d => d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE') || [];
  if (!baseline || incremental?.status !== 'PASS' || !same(baseline.cards, before?.cards) ||
      Number(before?.revision) !== Number(baseline.revision) ||
      Number(after?.revision) !== Number(baseline.revision) + 1 ||
      before.handCount !== baseline.handCount || after.handCount !== baseline.handCount + 1 ||
      after.cards.length !== after.handCount || inf?.activationKey !== 'E10' || inf.consumed != null ||
      (inf.costConsumed || []).length || inf.addedCount !== 1 ||
      targets.length !== 1 || gains.length !== 1 || gains[0].card?.id !== targetId ||
      blocks.some(b => !['M06', 'E10'].includes(b.activationKey))) {
    throw new Error('E10_SAVED_INCREMENTAL_RESOLUTION_INVALID');
  }
  const count = cards => {
    const out = {}; for (const card of cards || []) out[card.id] = (out[card.id] || 0) + 1; return out;
  };
  const expected = count(before.cards), actual = count(after.cards);
  expected[targetId] = (expected[targetId] || 0) + 1;
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if ((expected[id] || 0) !== (actual[id] || 0)) throw new Error('E10_SAVED_HAND_MULTISET_INVALID');
  }
  if (hand?.revision !== after.revision || hand.handCount !== after.handCount ||
      !same(hand.cards, after.cards) || ledger?.lastHandRevision !== after.revision ||
      ledger.lastIncrementalFingerprint !== `${after.revision}|E10|${targetId}`) {
    throw new Error('E10_SAVED_COMMIT_MISMATCH');
  }
  const minimum = targetSource === 'DECK' ? (count(before.cards)[targetId] || 0) + 1 : actual[targetId];
  if (Number(ledger.outsideDeckCounts?.[targetId] || 0) < minimum) throw new Error('E10_SAVED_LEDGER_GAIN_MISSING');
  return { state: hand, zeroTargetId: targetId, zeroTargetSource: targetSource,
    savedObservationOnly: true };
}
module.exports = { completeE10ResolutionDecision, verifyE10IncrementalResolution };
