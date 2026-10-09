'use strict';
const { ContractError } = require('./errors');
const { hashValue } = require('./json-store');
// Current owned effect -> exact outcome. Adjacency to an old activation is
// diagnostic history, not mandatory provenance for a deliberately delayed effect.
function verifyOwnedFieldGain({ cardId, transactionId, sourceProof, baseline, log, incremental,
  expectedCount = 1, identity = card => card && card.id }) {
  const requireFact = (condition, reason) => { if (!condition) throw new ContractError('EFFECT_RECEIPT_' + reason); };
  requireFact(transactionId && sourceProof && sourceProof.proven === true && sourceProof.actor === 'SELF' &&
    sourceProof.cardId === cardId && sourceProof.transactionId === transactionId, 'SOURCE_NOT_PROVEN');
  requireFact(baseline && Number.isInteger(baseline.revision) && Array.isArray(baseline.cards) &&
    baseline.handCount === baseline.cards.length, 'BASELINE_INVALID');
  requireFact(log && /^CONTINUOUS/.test(log.continuity || ''), 'CONTINUITY_UNKNOWN');
  const blocks = (log.newOperationBlocks || []).filter(b => b.activationKey === cardId &&
    (b.details || []).some(d => d.role === 'HAND_GAIN_CANDIDATE' || d.rawType === 'HAND_GAIN'));
  requireFact(blocks.length === 1 && blocks[0].activation && blocks[0].activation.side === 'SELF' &&
    blocks[0].activation.card && blocks[0].activation.card.id === cardId, 'ACTOR_OR_INSTANCE_AMBIGUOUS');
  const gains = (blocks[0].details || []).filter(d => d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE' && d.rawType === 'HAND_GAIN');
  requireFact(gains.length === expectedCount && gains.every(d => d.inferred !== true && identity(d.card) && identity(d.card) !== 'UNKNOWN'), 'GAINS_NOT_PROVEN');
  const before = incremental && incremental.before, after = incremental && incremental.after;
  const inference = incremental && incremental.inference, inserted = incremental && incremental.insertedCards || [];
  requireFact(incremental && incremental.status === 'PASS' && before && after && inference &&
    inference.activationKey === cardId && inference.consumed == null && !(inference.costConsumed || []).length, 'NOT_OWNED_FIELD_OUTCOME');
  const ids = cards => cards.map(identity), sorted = cards => ids(cards).sort();
  requireFact(before.revision === baseline.revision && before.handCount === baseline.handCount &&
    Array.isArray(before.cards) && hashValue(ids(before.cards)) === hashValue(ids(baseline.cards)), 'STALE_BASELINE');
  requireFact(after.revision === before.revision + 1 && after.handCount === before.handCount + expectedCount &&
    Array.isArray(after.cards) && after.cards.length === after.handCount && inserted.length === expectedCount, 'DELTA_INVALID');
  requireFact(hashValue(sorted(inserted.map(row => row.card))) === hashValue(sorted(gains.map(row => row.card))) &&
    hashValue(sorted(after.cards)) === hashValue(sorted([...before.cards, ...gains.map(row => row.card)])), 'GAIN_IDENTITY_MISMATCH');
  return { proven: true, transactionId, source: 'CURRENT_OWNED_FIELD_GAIN', cardId,
    signature: blocks[0].signature, count: expectedCount, revision: after.revision };
}
module.exports = { verifyOwnedFieldGain };
