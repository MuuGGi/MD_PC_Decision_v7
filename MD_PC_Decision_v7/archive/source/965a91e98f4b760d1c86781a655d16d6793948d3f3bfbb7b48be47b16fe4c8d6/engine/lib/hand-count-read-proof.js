'use strict';

// In-memory, single-use proof only. A number, a saved JSON, another bridge,
// or a previous scan can never suppress a live count read.
const reads = new WeakMap();
const MAX_AGE_MS = 10000;
function issueHandCountReadProof(bridge, result, maxHoldMs) {
  const count = result?.own?.handCount;
  const age = Date.now() - Date.parse(result?.capturedAt);
  if (!bridge || !Number.isFinite(maxHoldMs) || maxHoldMs <= 0 ||
      result?.status !== 'OK' || result.own?.status !== 'OK' ||
      !Number.isInteger(count) || count < 1 || count > 12 ||
      result.mouseReleased !== true || result.failSafeTriggered !== false ||
      !Number.isFinite(result.holdDurationMs) || result.holdDurationMs < 0 || result.holdDurationMs > maxHoldMs ||
      !Number.isFinite(age) || age < -1000 || age > MAX_AGE_MS ||
      (result.fastOwnOnly === true && Number(result.stableReads || 0) < 2)) {
    throw new Error('LIVE_HAND_COUNT_PROOF_INVALID');
  }
  const proof = Object.freeze({ kind: 'LIVE_RELEASED_HAND_COUNT' });
  reads.set(proof, { bridge, count, capturedAt: Date.parse(result.capturedAt),
    result: { ...result, own: { ...result.own } } });
  return { handCount: count, proof };
}
function consumeHandCountReadProof(bridge, proof, expected) {
  const read = proof && typeof proof === 'object' ? reads.get(proof) : null;
  if (read) reads.delete(proof);
  const age = read ? Date.now() - read.capturedAt : NaN;
  if (!read || read.bridge !== bridge || !Number.isInteger(expected) || read.count !== expected ||
      !Number.isFinite(age) || age < -1000 || age > MAX_AGE_MS) {
    throw new Error('LIVE_HAND_COUNT_PROOF_STALE_OR_UNBOUND');
  }
  return { result: { ...read.result, own: { ...read.result.own },
    reusedWithinCurrentBaseline: true }, debugDir: null };
}
module.exports = { issueHandCountReadProof, consumeHandCountReadProof };
