'use strict';

const { searchableEngageTargets, buildEngageLegalTargets } = require('./engage-policy');

// Count legal Engage targets (not Engage itself), including targets a later
// Mallet can return from hand. Hand holdings do not make a current Deck search legal.
function describeE10EngageSources(deck, cards = [], runtime = {}) {
  const engageDeckRemaining = Number(deck.deckRemaining?.M17 || 0);
  const searchableTargets = searchableEngageTargets(deck, runtime);
  const searchableComponentRemaining = searchableTargets.reduce((n, target) => n + Number(target.remaining || 0), 0);
  const targetIds = new Set(buildEngageLegalTargets().map(target => target.id));
  const searchableComponentsInHand = cards.filter(card => targetIds.has(card?.id)).length;
  const handPlusDeckStrikerCount = searchableComponentRemaining + searchableComponentsInHand;
  const engageInGrave = Number(runtime.usedCounts?.M17 || 0);
  const deckEngagePreferred = handPlusDeckStrikerCount > 2;
  const preferredSource = engageInGrave > 0 && (!deckEngagePreferred || engageDeckRemaining === 0)
    ? 'GRAVE' : engageDeckRemaining > 0 ? 'DECK' : engageInGrave > 0 ? 'GRAVE' : 'NONE';
  return { preferredSource, engageDeckRemaining, engageInGrave, searchableComponentRemaining,
    searchableComponentsInHand, handPlusDeckStrikerCount, deckEngagePreferred, searchableTargets,
    reason: `手牌+牌组交闪目标=${handPlusDeckStrikerCount}（手牌${searchableComponentsInHand}/牌组${searchableComponentRemaining}）；` +
      (preferredSource === 'GRAVE' ? '目标仅剩1/2张或牌组无交闪，优先墓地回收。'
        : preferredSource === 'DECK' ? deckEngagePreferred ? '目标充足，优先牌组交闪。'
          : '目标不足且无墓地交闪；牌组交闪仅作兜底，不提高零梦优先级。' : '没有已确认的交闪来源。') };
}

function selectE10EngageCandidate(candidates, policy) {
  const rows = candidates.filter(row => row.recognized?.accepted && row.recognized.id === 'M17')
    .sort((a, b) => a.reference.x - b.reference.x);
  const grave = Number(policy.engageInGrave || 0), deck = Number(policy.engageDeckRemaining || 0);
  if (rows.length !== grave + deck || !rows.length) {
    throw new Error(`V5_ZERO_ENGAGE_SOURCE_COUNT_MISMATCH:recognized=${rows.length};grave=${grave};deck=${deck}`);
  }
  const source = policy.preferredSource;
  if (!['GRAVE', 'DECK'].includes(source) || (source === 'GRAVE' ? grave : deck) <= 0) {
    throw new Error('V5_ZERO_ENGAGE_SOURCE_UNAVAILABLE');
  }
  // User-confirmed order: GY copies are at the FRONT, then Deck copies.
  return { ...rows[source === 'GRAVE' ? 0 : grave], rank: 0, selectedSource: source };
}

function buildE10EngageSourcePolicy({ library, handState, runtimeState }) {
  const cards = Array.isArray(handState && handState.cards) ? handState.cards : [];
  const runtime = runtimeState || {};
  const deck = require('./decision-engine').buildDeckState(library, cards, runtime);
  return describeE10EngageSources(deck, cards, runtime);
}

module.exports = { buildE10EngageSourcePolicy, describeE10EngageSources, selectE10EngageCandidate };
