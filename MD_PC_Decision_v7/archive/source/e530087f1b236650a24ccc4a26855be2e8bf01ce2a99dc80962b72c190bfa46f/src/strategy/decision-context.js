'use strict';
const { known } = require('../core/snapshot');
const { hashValue, clone } = require('../core/json-store');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

// A read-only view of existing authorities, not a second ledger. A partial zone
// remains partial: usedCounts cannot identify every card in GY or banishment.
function createDecisionContext(snapshot, expectedHand) {
  for (const key of ['hand', 'runtime', 'ledger', 'library'])
    if (!known(snapshot?.[key])) throw new Error('STRATEGY_SOURCE_UNKNOWN:' + key);
  if (!Array.isArray(snapshot.consistency) || snapshot.consistency.length)
    throw new Error('STRATEGY_SNAPSHOT_INCONSISTENT');
  const hand = clone(snapshot.hand.data), runtime = clone(snapshot.runtime.data);
  if (expectedHand && (hand.revision !== expectedHand.revision ||
      hashValue(hand.cards.map(c => c.id)) !== hashValue(expectedHand.cards.map(c => c.id))))
    throw new Error('STRATEGY_HAND_NOT_SNAPSHOT_HAND');
  const branch = runtime.v5Branch || {};
  return freeze({ snapshotKey: snapshot.snapshotKey,
    hand, runtime, ledger: clone(snapshot.ledger.data), library: clone(snapshot.library.data),
    observer: known(snapshot.observerState) ? clone(snapshot.observerState.data) : null,
    log: known(snapshot.log) ? clone(snapshot.log.data) : null,
    duelId: known(snapshot.session) ? snapshot.session.data.duelId || null : null,
    zones: {
      hand: { status: 'KNOWN', revision: hand.revision },
      deck: { status: 'KNOWN', source: 'SHARED_OUTSIDE_DECK_LEDGER' },
      field: { status: 'PARTIAL', carrierId: branch.carrierId || branch.carrierCardId || null,
        equippedBambooCounts: clone(runtime.equippedBambooCounts || {}), fieldSpell: runtime.fieldSpell || null },
      grave: { status: 'PARTIAL', spellCount: runtime.graveSpellCount, identities: 'UNKNOWN' },
      banished: { status: 'UNKNOWN' }, opponent: { status: 'UNKNOWN' }
    } });
}

module.exports = { createDecisionContext };
