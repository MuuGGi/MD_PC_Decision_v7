'use strict';
const { planEquippedBambooContinuation } = require('./yoto-search-value');
const { describeE10EngageSources } = require('./e10-engage-source-policy');
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');

function describeDoubleLinkSwordReadiness(cards = [], runtime = {}, deck = {}) {
  const branch = runtime.v5Branch || {};
  // Equip activation increments usedCounts even while the sword remains on
  // field. Use a confirmed departure/search receipt, never usedCounts alone.
  const equipSentToGrave = Number(runtime.equipSentToGraveCount || 0) > 0 ||
    Number(runtime.effectUsage?.M19_SEARCH || 0) > 0 ||
    (branch.source === 'FORMAL_V5_T20_3_REPEATABLE_M19' && runtime.equippedBambooId === 'M19' &&
      ['M19_EQUIPPED', 'GOLDEN_BAMBOO_DRAW_READY', 'EQUIPPED_YOTO_NO_SEARCH_TARGET'].includes(branch.currentState));
  const carrier = String(branch.carrierId || branch.carrierCardId || '');
  const futureSwordDeparture = /^E0[2-9]$/.test(carrier) && ['M19', 'M20'].some(id => {
    const index = cards.findIndex(card => card?.id === id);
    if (index < 0) return false;
    const remaining = { ...deck.deckRemaining };
    if (id === 'M20') {
      if (!(Number(remaining.M19 || 0) > 0)) return false;
      remaining.M19--;
    }
    return planEquippedBambooContinuation(remaining, cards.filter((_, n) => n !== index), {
      deck: { ...deck, deckRemaining: remaining }, byId: deck.byId,
      runtime: { ...runtime, bambooSwordEquipped: true, equippedBambooId: 'M19',
        equippedBambooCounts: { M19: 1 }, v5Branch: { carrierId: carrier } }
    }).shouldLink;
  });
  // A possible future hand-equip loop is an alternative opportunity, not a
  // committed transaction. In particular the searched final sword must not
  // create a perpetual obligation to send another sword after Kagari is used.
  const kagariPreparationOutstanding = branch.kagariSwordLink === true &&
    Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) === 0 &&
    (runtime.bambooSwordEquipped === true || cards.some(c => c.id === branch.plannedSwordId));
  const swordDeparturePlanned = kagariPreparationOutstanding ||
    (!equipSentToGrave && runtime.bambooSwordEquipped === true);
  return { ready: !swordDeparturePlanned, equipSentToGrave, stageComplete: equipSentToGrave, swordDeparturePlanned,
    futureSwordDepartureAvailable: futureSwordDeparture,
    reason: swordDeparturePlanned ? 'FINISH_PLANNED_SWORD_DEPARTURE_FIRST' :
      equipSentToGrave ? 'CONFIRMED_EQUIP_ALREADY_SENT_TO_GRAVE' : 'NO_PRODUCTIVE_SWORD_DEPARTURE_PLANNED' };
}

function chooseEquippedRayeLink(cards, runtime, deck, continuation) {
  const combined = describeCombinedYotoZero(cards, runtime, deck);
  if (combined.ready && combined.nextAction === 'LINK')
    return { answer: '2', combined, engage: combined.engage,
      reason: 'COMBINED_SWORD_DEPARTURE_AND_ZERO_GAIN_ONE_EXTRA_SUMMON' };
  const sword = describeDoubleLinkSwordReadiness(cards, runtime, deck);
  const engage = describeE10EngageSources(deck, cards, runtime);
  const carrier = String(runtime.v5Branch?.carrierId || '');
  const ready = sword.ready && continuation?.shouldLink === true &&
    runtime.rayeNormalSummoned === true && /^E0[2-9]$/.test(carrier) &&
    Number(runtime.effectUsage?.E10_SUMMON || 0) === 0 &&
    Number(runtime.graveSpellCount || 0) + 1 >= 3 &&
    adjustedMainDeckRemainingCount(deck) >= (engage.preferredSource === 'GRAVE' ? 3 : 4) &&
    engage.searchableComponentRemaining > 0 && engage.preferredSource !== 'NONE' &&
    (engage.preferredSource === 'GRAVE' || engage.deckEngagePreferred);
  return { answer: ready ? '2' : '1', sword, engage,
    reason: ready ? 'SWORD_STAGE_COMPLETE_AND_ZERO_ENGAGE_GAIN_PROVEN' : 'PRESERVE_RAYE_AND_LINK_CARRIER' };
}

// Current-state opportunity, not a committed macro. The Link itself can fulfil
// the sword-departure prerequisite. Compare its actual gains with the longer
// single-Link -> Zero alternative; never pretend the sword has already left.
function describeCombinedYotoZero(cards = [], runtime = {}, deck = {}) {
  const branch = runtime.v5Branch || {}, carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const unavailable = reason => ({ ready: false, reason, carrierId });
  if (/PENDING|IN_FLIGHT|PROMPT|SELECTED_FROM_DECK|FIELD_EFFECT_ACTIVATED/.test(branch.currentState || ''))
    return unavailable('TRANSACTION_PENDING');
  // Existing two-material capability proves Extra-zone carrier + Main-zone
  // Raye. Two Main-zone monsters need a separately proven placement/identity
  // capability; do not silently point both material clicks at the same anchor.
  if (!/^E0[2-9]$/.test(carrierId)) return unavailable('TWO_MATERIAL_ZONES_NOT_SUPPORTED');
  if (Number(runtime.effectUsage?.E10_SUMMON || 0) > 0) return unavailable('ZERO_ALREADY_USED');
  if (!deck.deckRemaining || ['M06', 'M08', 'M14', 'M17', 'M19', 'M20', 'M22'].some(id =>
      !Number.isInteger(deck.deckRemaining[id]) || deck.deckRemaining[id] < 0) ||
      !Number.isInteger(runtime.graveSpellCount) || runtime.graveSpellCount < 0)
    return unavailable('RESOURCE_EVIDENCE_UNKNOWN');
  const alreadySummoned = runtime.rayeNormalSummoned === true;
  const raye = cards.find(c => c.id === 'M06');
  if (!alreadySummoned && (!raye || runtime.normalSummonUsed === true)) return unavailable('NO_UNUSED_RAYE_ENTRY');
  const fireRecovery = ['E03', 'E04', 'E05'].includes(carrierId) &&
    Number(runtime.usedCounts?.M17 || 0) > 0 && Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) === 0;
  if (fireRecovery) return unavailable('PRESERVE_ADDITIONAL_UNUSED_FIRE_GAIN');
  const resources = require('./yoto-search-value').summarizeBambooEquipResources(
    deck.deckRemaining, cards, { runtime, byId: deck.byId });
  if (resources.fieldCount > 1) return unavailable('MULTI_YOTO_ZERO_POOL_NOT_SUPPORTED');
  let sword = null, nextAction = resources.byId.M19.field ? alreadySummoned ? 'LINK' : 'SUMMON_RAYE' : null;
  let projectedCards = cards.slice(), remaining = { ...deck.deckRemaining }, converted = false;
  const projectedRuntime = { ...runtime, usedCounts: { ...runtime.usedCounts },
    v5Branch: { ...branch, carrierId }, bambooSwordEquipped: true,
    equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 } };
  if (!resources.fieldCount) {
    sword = cards.find(c => c.id === 'M19' && c.usable !== false) ||
      cards.find(c => c.id === 'M20' && c.usable !== false && remaining.M19 > 0);
    if (!sword) return unavailable('NO_CURRENT_SEARCHING_SWORD');
    projectedCards = projectedCards.filter(c => c !== sword);
    nextAction = 'EQUIP'; converted = sword.id === 'M20';
  } else if (resources.byId.M20.field) {
    if (branch.currentState !== 'M20_EQUIPPED' || remaining.M19 < 1)
      return unavailable('TRUE_CONVERSION_NOT_AVAILABLE');
    nextAction = 'CONVERT_TRUE'; converted = true;
  }
  if (converted) { remaining.M19--; projectedRuntime.graveSpellCount++; }
  if (!alreadySummoned) projectedCards = projectedCards.filter(c => c !== raye);
  const projectedDeck = { ...deck, deckRemaining: remaining };
  const continuation = planEquippedBambooContinuation(remaining, projectedCards,
    { runtime: projectedRuntime, deck: projectedDeck, byId: deck.byId });
  if (!continuation.shouldLink) return unavailable(continuation.reason);
  // Source is queried AFTER the actual costs and sword entry into GY; neither
  // a future random draw nor a hand-only search target is counted as available.
  const engage = describeE10EngageSources(projectedDeck, projectedCards,
    { ...projectedRuntime, graveSpellCount: projectedRuntime.graveSpellCount + 1 });
  if (engage.engageInGrave > runtime.graveSpellCount)
    return unavailable('GRAVE_SOURCE_EVIDENCE_INCONSISTENT');
  if (!engage.searchableComponentRemaining || engage.preferredSource === 'NONE')
    return unavailable('NO_CURRENT_ENGAGE_GAIN');
  const bonusDraw = projectedRuntime.graveSpellCount + 1 >= 3;
  const requiredDeckCards = 1 + (engage.preferredSource === 'DECK' ? 1 : 0) + 1 + (bonusDraw ? 1 : 0);
  if (adjustedMainDeckRemainingCount(projectedDeck) < requiredDeckCards)
    return unavailable('INSUFFICIENT_DECK_FOR_COMBINED_GAIN');
  return { ready: true, reason: 'SAME_SWORD_AND_ZERO_GAIN_WITH_ONE_EXTRA_SUMMON',
    nextAction, carrierId, raye, alreadySummoned, sword, continuation, engage, bonusDraw,
    targetLinkId: 'E10', currentYotoCount: resources.byId.M19.field,
    searchId: continuation.searchId, gains: ['YOTO_SEARCH', 'E10_ENGAGE'],
    extraDeckSummons: 1, alternativeExtraDeckSummons: 2,
    savedExtraDeckSummons: 1, requiredDeckCards, recheckAfterResolution: true };
}

module.exports = { describeDoubleLinkSwordReadiness, chooseEquippedRayeLink, describeCombinedYotoZero };
