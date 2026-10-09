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
  // A last CURRENT Deck target makes the remaining Deck Engage a future dead
  // draw. Remove that Engage from Deck now; hand/Mallet opportunities do not
  // replace a current legal Deck target. Keep the existing other source rules.
  const lastDeckTarget = searchableComponentRemaining === 1;
  const deckEngagePreferred = lastDeckTarget || handPlusDeckStrikerCount > 2;
  const preferredSource = engageInGrave > 0 && (!deckEngagePreferred || engageDeckRemaining === 0)
    ? 'GRAVE' : engageDeckRemaining > 0 ? 'DECK' : engageInGrave > 0 ? 'GRAVE' : 'NONE';
  return { preferredSource, engageDeckRemaining, engageInGrave, searchableComponentRemaining,
    searchableComponentsInHand, handPlusDeckStrikerCount, lastDeckTarget, deckEngagePreferred, searchableTargets,
    reason: `手牌+牌组交闪目标=${handPlusDeckStrikerCount}（手牌${searchableComponentsInHand}/牌组${searchableComponentRemaining}）；` +
      (preferredSource === 'GRAVE' ? '牌组无交闪或其余目标按既定规则优先墓地回收。'
        : preferredSource === 'DECK' ? lastDeckTarget ? '牌组只剩1个合法检索目标，先拿牌组交闪，避免之后成为废抽。'
          : deckEngagePreferred ? '目标充足，优先牌组交闪。'
          : '目标不足且无墓地交闪；牌组交闪仅作兜底，不提高零梦优先级。' : '没有已确认的交闪来源。') };
}

// The executor consumes the published source, not its own route override.
// A conflicting last-target receipt is stale: reject it rather than substitute.
function bindE10EngageSourcePolicy(policy, requestedSource = '') {
  const source = String(requestedSource || '').toUpperCase();
  if (!source) return policy;
  const available = source === 'GRAVE' ? policy.engageInGrave : policy.engageDeckRemaining;
  if (!['GRAVE', 'DECK'].includes(source) || !Number.isInteger(available) || available <= 0)
    throw new Error('V5_ZERO_PUBLISHED_ENGAGE_SOURCE_UNAVAILABLE');
  if (policy.lastDeckTarget && policy.engageDeckRemaining > 0 && source !== 'DECK')
    throw new Error('V5_ZERO_PUBLISHED_ENGAGE_SOURCE_STALE_LAST_TARGET');
  return { ...policy, preferredSource: source,
    reason: `保持决策层已发布交闪来源=${source}；当前牌组目标=${policy.searchableComponentRemaining}，` +
      `牌组交闪=${policy.engageDeckRemaining}，墓地交闪=${policy.engageInGrave}；本窗口不重新仲裁来源。` };
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

module.exports = { buildE10EngageSourcePolicy, describeE10EngageSources, selectE10EngageCandidate, bindE10EngageSourcePolicy };
