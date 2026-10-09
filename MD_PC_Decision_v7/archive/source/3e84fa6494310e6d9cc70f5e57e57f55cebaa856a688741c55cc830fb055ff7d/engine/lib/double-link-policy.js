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
  const swordDeparturePlanned = branch.kagariSwordLink === true ||
    futureSwordDeparture || (!equipSentToGrave && runtime.bambooSwordEquipped === true);
  return { ready: !swordDeparturePlanned, equipSentToGrave, stageComplete: equipSentToGrave, swordDeparturePlanned,
    reason: swordDeparturePlanned ? 'FINISH_PLANNED_SWORD_DEPARTURE_FIRST' :
      equipSentToGrave ? 'CONFIRMED_EQUIP_ALREADY_SENT_TO_GRAVE' : 'NO_PRODUCTIVE_SWORD_DEPARTURE_PLANNED' };
}

function chooseEquippedRayeLink(cards, runtime, deck, continuation) {
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
module.exports = { describeDoubleLinkSwordReadiness, chooseEquippedRayeLink };
