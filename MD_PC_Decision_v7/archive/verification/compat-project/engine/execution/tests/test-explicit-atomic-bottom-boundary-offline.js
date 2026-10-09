'use strict';

const assert = require('assert');
const {
  checkpointFrom,
  reconcileExpectedAtomicBottom
} = require('../../lib/duel-log-state');

function block(key, detailKeys = []) {
  const details = detailKeys.map(id => ({
    type: 'PROCESSING_CARD',
    rawType: 'HAND_GAIN',
    role: 'HAND_GAIN_CANDIDATE',
    side: 'SELF',
    card: { id, name: id }
  }));
  return {
    activationKey: key,
    activation: { card: { id: key, name: key } },
    details,
    signature: `${key}|${details.map(item => `${item.type}:${item.card.id}`).join(',')}`
  };
}

const previous = {
  checkpoint: checkpointFrom([block('M17', ['M08', 'M08'])])
};

const m13 = block('M13', ['M21', 'M15', 'M06', 'M06']);
const detached = reconcileExpectedAtomicBottom(previous, [m13], 'm13', '2026-09-27T00:00:00.000Z');
assert.ok(detached);
assert.strictEqual(detached.continuity, 'CONTINUOUS_EXPLICIT_ATOMIC_BOTTOM_NEW_BLOCKS');
assert.deepStrictEqual(detached.newBlocks, [m13]);
assert.strictEqual(detached.matchedAnchor.cardKey, 'M13');
assert.strictEqual(detached.matchedAnchor.previousCheckpoint, 'M17');
assert.strictEqual(detached.state.checkpoint.activationKey, 'M13');

assert.strictEqual(
  reconcileExpectedAtomicBottom(previous, [block('M14')], 'M13'),
  null,
  'a visible but different activation cannot replace the executor-declared atom'
);
assert.strictEqual(
  reconcileExpectedAtomicBottom(previous, [m13, block('M13')], 'M13'),
  null,
  'duplicate expected activations are ambiguous and must fail closed'
);

const m19 = block('M19', ['E04']);
const m20 = block('M20', ['E04']);
const suffix = reconcileExpectedAtomicBottom(previous, [m19, m20], 'M20');
assert.ok(suffix);
assert.deepStrictEqual(suffix.newBlocks, [m20]);
assert.strictEqual(reconcileExpectedAtomicBottom(previous, [m13], ''), null);

console.log('EXPLICIT_ATOMIC_BOTTOM_BOUNDARY_OFFLINE_PASS');
