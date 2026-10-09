'use strict';

const EXODIA_COMPONENT_IDS = Object.freeze([
  'M01', 'M02', 'M03', 'M04', 'M05'
]);

// Runtime identity for a sealed component whose exact head/arm/leg artwork is
// intentionally not resolved.  The five pieces are singletons, are never used
// as costs, and Master Duel itself proves the win.  Production therefore only
// needs their class and count; it must not click or stop merely to distinguish
// one piece from another.
const EXODIA_UNKNOWN_ID = 'EXODIA_UNKNOWN';

function isExactExodiaComponentId(id) {
  return EXODIA_COMPONENT_IDS.includes(String(id || ''));
}

function isExodiaComponentId(id) {
  const value = String(id || '');
  return value === EXODIA_UNKNOWN_ID || isExactExodiaComponentId(value);
}

function isExodiaComponentCard(card) {
  return Boolean(card && (
    card.persistentExodia === true ||
    isExodiaComponentId(card.id)
  ));
}

// One counting key for every runtime verifier. Exact artwork IDs are evidence
// aliases of this class, never five different accounting buckets.
function canonicalRuntimeCardId(value) {
  const raw = typeof value === 'string' ? value
    : value && (value.id || (value.card && value.card.id));
  const id = String(raw || '');
  return isExodiaComponentId(id) ? EXODIA_UNKNOWN_ID : id;
}

function countRuntimeCardIds(cards) {
  const counts = new Map();
  for (const card of cards || []) {
    const id = canonicalRuntimeCardId(card);
    if (!id || id === 'UNKNOWN') throw new Error('RUNTIME_HAND_IDENTITY_UNRESOLVED');
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function changeRuntimeCardCount(counts, card, delta, errorCode = 'RUNTIME_REMOVE_ABSENT_CARD') {
  const id = canonicalRuntimeCardId(card);
  if (!id || id === 'UNKNOWN') throw new Error('RUNTIME_HAND_IDENTITY_UNRESOLVED');
  const next = (counts.get(id) || 0) + delta;
  if (next < 0) throw new Error(`${errorCode}:${id}`);
  if (next === 0) counts.delete(id);
  else counts.set(id, next);
}

// Runtime consumers must compare sealed pieces by class, not head/limb ID.
// This never makes UNKNOWN or an ordinary card interchangeable with a piece.
function sameRuntimeCardIdentity(expected, observed) {
  const a = canonicalRuntimeCardId(expected);
  const b = canonicalRuntimeCardId(observed);
  if (!a || !b || a === 'UNKNOWN' || b === 'UNKNOWN') return false;
  return a === b;
}

function countExodiaComponents(cards) {
  return Math.min(5, (cards || []).filter(isExodiaComponentCard).length);
}

function sameRuntimeCardMultiset(expected, observed) {
  if (!Array.isArray(expected) || !Array.isArray(observed) || expected.length !== observed.length) return false;
  try {
    const a = countRuntimeCardIds(expected);
    const b = countRuntimeCardIds(observed);
    return a.size === b.size && [...a].every(([id, count]) => b.get(id) === count);
  } catch (_) { return false; }
}

function normalizeExodiaComponentCard(card, candidateIds = null) {
  if (!isExodiaComponentCard(card)) return card;
  const candidates = Array.isArray(candidateIds) && candidateIds.length
    ? candidateIds.filter(isExactExodiaComponentId)
    : EXODIA_COMPONENT_IDS.slice();
  return {
    ...card,
    id: EXODIA_UNKNOWN_ID,
    name: '被封印组件（身份无需区分）',
    persistentExodia: true,
    candidateIds: [...new Set(candidates)]
  };
}

function adjustedMainDeckRemainingCount(deck) {
  const raw = Object.entries(deck && deck.deckRemaining || {})
    .filter(([id]) => /^M\d+$/.test(id))
    .reduce((sum, [, count]) => sum + Math.max(0, Number(count || 0)), 0);
  const unresolvedOutside = Math.max(0, Number(
    deck && (
      deck.unknownExodiaOutsideCount ??
      (deck.mainDeckLedger && deck.mainDeckLedger.unknownExodiaOutsideCount)
    ) || 0
  ));
  return Math.max(0, raw - unresolvedOutside);
}

function buildExodiaComponentSet() {
  return new Set(EXODIA_COMPONENT_IDS);
}

module.exports = {
  EXODIA_COMPONENT_IDS,
  EXODIA_UNKNOWN_ID,
  isExactExodiaComponentId,
  isExodiaComponentId,
  isExodiaComponentCard,
  canonicalRuntimeCardId,
  countRuntimeCardIds,
  changeRuntimeCardCount,
  sameRuntimeCardIdentity,
  sameRuntimeCardMultiset,
  countExodiaComponents,
  normalizeExodiaComponentCard,
  adjustedMainDeckRemainingCount,
  buildExodiaComponentSet
};
