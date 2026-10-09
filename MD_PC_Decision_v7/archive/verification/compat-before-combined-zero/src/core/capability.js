'use strict';
const { known } = require('./snapshot');
const STATUS = Object.freeze({ READY: 'READY', BLOCKED: 'BLOCKED', UNKNOWN: 'UNKNOWN' });
const ready = (reason, evidence = {}) => ({ status: STATUS.READY, reason, evidence });
const blocked = (reason, evidence = {}) => ({ status: STATUS.BLOCKED, reason, evidence });
const unknown = (reason, evidence = {}) => ({ status: STATUS.UNKNOWN, reason, evidence });
function countHand(snapshot, id) {
  if (!known(snapshot.hand) || !Array.isArray(snapshot.hand.data.cards)) return null;
  return snapshot.hand.data.cards.filter(card => card && String(card.id) === id).length;
}
function totalCount(snapshot, id) {
  if (!known(snapshot.library) || !Array.isArray(snapshot.library.data.cards)) return null;
  const card = snapshot.library.data.cards.find(row => row && String(row.id) === id);
  const count = card && (card.count ?? card.copies);
  return Number.isInteger(count) && count >= 0 ? count : null;
}
function outsideCount(snapshot, id) {
  if (!known(snapshot.ledger)) return null;
  const count = snapshot.ledger.data.outsideDeckCounts && snapshot.ledger.data.outsideDeckCounts[id];
  return Number.isInteger(count) && count >= 0 ? count : null;
}
function deckRemaining(snapshot, id) {
  const total = totalCount(snapshot, id), outside = outsideCount(snapshot, id);
  return total == null || outside == null || outside > total ? null : total - outside;
}
function deckTotalRemaining(snapshot) {
  if (!known(snapshot.library) || !known(snapshot.ledger)) return null;
  let total = 0;
  for (const row of snapshot.library.data.cards || []) {
    if (!/^M\d+$/.test(String(row && row.id || ''))) continue;
    const remaining = deckRemaining(snapshot, row.id);
    if (remaining == null) return null;
    total += remaining;
  }
  const unknownComponents = snapshot.ledger.data.unknownExodiaOutsideCount;
  if (unknownComponents != null) {
    if (!Number.isInteger(unknownComponents) || unknownComponents < 0) return null;
    total -= unknownComponents;
  }
  return total >= 0 ? total : null;
}
function aligned(snapshot) {
  if (!known(snapshot.hand) || !known(snapshot.ledger)) return false;
  const h = snapshot.hand.data.revision, l = snapshot.ledger.data.lastHandRevision;
  return Number.isInteger(h) && h >= 0 && Number.isInteger(l) && h === l;
}
function goldenDraw2(snapshot, facts = {}) {
  for (const name of ['hand', 'ledger', 'library']) if (!known(snapshot[name])) return unknown('SOURCE_UNKNOWN', { source: name });
  if (!aligned(snapshot)) return unknown('HAND_LEDGER_VERSION_MISMATCH');
  if (snapshot.consistency && snapshot.consistency.length) return unknown('SNAPSHOT_INCONSISTENT');
  const copies = countHand(snapshot, 'M14');
  const remaining = deckTotalRemaining(snapshot);
  if (facts.uiRole && !['PROVEN', 'READY'].includes(facts.uiRole.status)) return unknown('CURRENT_UI_ROLE_UNKNOWN');
  return goldenDrawFacts({ copies, remaining, equipment: facts.bambooEquip,
    pending: facts.pendingCommit === true || facts.pendingTransaction === true });
}
function goldenDrawFacts({ copies, remaining, equipment, pending = false }) {
  if (pending) return unknown('STATE_TRANSACTION_INCOMPLETE');
  if (!Number.isInteger(copies) || copies < 0) return unknown('HAND_SCHEMA_INVALID');
  if (!Number.isInteger(remaining) || remaining < 0) return unknown('DECK_REMAINING_UNKNOWN');
  if (!equipment || !['PROVEN', 'ABSENT'].includes(equipment.status)) return unknown('BAMBOO_EQUIP_NOT_CURRENTLY_PROVEN');
  if (copies < 1) return blocked('GOLDEN_BAMBOO_NOT_IN_CURRENT_HAND');
  if (remaining < 2) return blocked('MAIN_DECK_FEWER_THAN_TWO', { remaining });
  if (equipment.status === 'ABSENT') return blocked('BAMBOO_EQUIP_PROVEN_ABSENT');
  return ready('GOLDEN_DRAW2_PROVEN', { copies, remaining, equipEvidence: equipment.evidence || null });
}
function authorizeIrreversible(result) { return Boolean(result && result.status === STATUS.READY); }
// A blocked single ability is NOT proof that every reachable action is blocked.
function provesDeadlock(results) { return Array.isArray(results) && results.length > 0 && results.every(r => r && r.status === STATUS.BLOCKED); }
module.exports = { STATUS, ready, blocked, unknown, countHand, deckRemaining, deckTotalRemaining,
  aligned, goldenDraw2, goldenDrawFacts, authorizeIrreversible, provesDeadlock };
