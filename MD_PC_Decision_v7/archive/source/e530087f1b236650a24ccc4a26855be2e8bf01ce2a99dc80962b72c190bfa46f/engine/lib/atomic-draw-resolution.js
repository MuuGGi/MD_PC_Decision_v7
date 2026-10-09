'use strict';
const DRAW_COUNTS = Object.freeze({ M09: 1, M15: 1, M16: 1, M12: 2, M14: 2 });

// A parsed INFO integer is not evidence that the ordinary duel still exists.
// Validate only actions whose final hand delta is known. M18's observer uses a
// staged baseline (spell already removed); do not subtract that spell twice.
function expectedResolvedHandCount(baseline, activationKey, gainCount) {
  if (!Number.isInteger(baseline?.handCount) || !Array.isArray(baseline.cards) ||
      baseline.cards.length !== baseline.handCount) return null;
  const hasSpell = baseline.cards.some(card => card.id === activationKey);
  // M21 placement is committed before this observer is called. Its input
  // baseline is always beforeDraw; another M21 in hand is NOT the field card.
  if (activationKey === 'M21') return baseline.handCount + 1;
  let gains = DRAW_COUNTS[activationKey];
  let cost = 0;
  if (activationKey === 'M12' || activationKey === 'M13') {
    if (!hasSpell) return null; // A partially staged cost cannot be inferred.
    gains = 2;
    cost = 1;
  } else if (activationKey === 'M17') {
    if (![1, 2].includes(gainCount)) return null;
    gains = gainCount;
  } else if (activationKey === 'M18') {
    gains = 1;
  }
  if (!Number.isInteger(gains)) return null;
  const count = baseline.handCount - Number(hasSpell) - cost + gains;
  return count >= 0 ? count : null;
}

function inspectAtomicDrawResolution(log, activationKey, expectedGainCount) {
  const expected = activationKey === 'M17' && [1, 2].includes(expectedGainCount)
    ? expectedGainCount : DRAW_COUNTS[activationKey];
  if (!expected) return { supported: false, ready: true };
  const blocks = (log?.newOperationBlocks || []).filter(b => b?.activationKey === activationKey);
  if (blocks.length > 1) throw new Error('ATOMIC_DRAW_RESOLUTION_AMBIGUOUS:' + activationKey);
  const gains = (blocks[0]?.details || []).filter(d => d.rawType === 'HAND_GAIN' && d.side === 'SELF');
  if (gains.length > expected) throw new Error('ATOMIC_DRAW_RESOLUTION_EXCESS_GAINS:' + activationKey);
  return { supported: true, ready: blocks.length === 1 && gains.length === expected,
    expected, observed: gains.length, activationKey };
}

// Callback-driven so the actual bounded wait is regression-tested without a
// bridge. Never replay an activation, pay a cost, or accept INFO count alone.
async function waitForAtomicDrawResolution({ activationKey, readLog, refresh, delay,
  expectedGainCount, now = Date.now, timeoutMs = 12000, intervalMs = 300, onPending = () => {} }) {
  const start = now();
  let polls = 0;
  while (true) {
    const proof = inspectAtomicDrawResolution(readLog(), activationKey, expectedGainCount);
    if (proof.ready) return { proof, polls, terminal: false };
    if (now() - start >= timeoutMs) throw new Error('ATOMIC_DRAW_RESOLUTION_TIMEOUT:' + activationKey);
    onPending(proof, polls);
    await delay(intervalMs);
    const outcome = await refresh();
    polls++;
    if (outcome?.terminal === true) return { polls, terminal: true, outcome };
  }
}
module.exports = { inspectAtomicDrawResolution, waitForAtomicDrawResolution, expectedResolvedHandCount };
