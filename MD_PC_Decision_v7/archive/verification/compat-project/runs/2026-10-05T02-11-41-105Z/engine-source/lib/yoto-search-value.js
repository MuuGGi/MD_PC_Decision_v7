'use strict';
const { bambooSearchTargetIds } = require('./bamboo-search-policy');

function summarizeBambooEquipResources(deckRemaining = {}, handCards = [], options = {}) {
  const hand = Array.isArray(handCards) ? handCards : [];
  const runtime = options.runtime || {};
  const branch = runtime.v5Branch || {};
  const fieldCount = runtime.bambooSwordEquipped === true ? 1 : 0;
  const fieldId = fieldCount ? (runtime.equippedBambooId ||
    (branch.goldenDrawEquipId === 'M20' || branch.currentState === 'M20_EQUIPPED' ? 'M20' : 'M19')) : null;
  const byId = {};
  for (const id of ['M19', 'M20']) {
    const total = options.byId && options.byId[id] && Number(options.byId[id].count);
    const deck = Math.max(0, Number(deckRemaining[id] || 0));
    const held = hand.filter(card => card && card.id === id).length;
    const field = fieldId === id ? fieldCount : 0;
    byId[id] = { deck, hand: held, field, total: Number.isFinite(total) ? total : null,
      outsideHandField: Number.isFinite(total) ? Math.max(0, total - deck - held - field) : null };
  }
  const deckCount = byId.M19.deck + byId.M20.deck;
  const handCount = byId.M19.hand + byId.M20.hand;
  const knownTotals = Object.values(byId).every(row => row.total !== null);
  return { byId, deckCount, handCount, fieldCount,
    outsideHandFieldCount: knownTotals ? byId.M19.outsideHandField + byId.M20.outsideHandField : null,
    replacementCountAfterLink: deckCount + handCount,
    hasReplacementAfterLink: deckCount + handCount > 0,
    fieldIdentitySource: !fieldCount ? 'NO_FIELD_EQUIP' :
      (runtime.equippedBambooId ? 'COMMITTED_EQUIP' : 'LEGACY_BRANCH_INFERENCE') };
}

// A deferred search stocks Golden in hand; it does not prove the remaining
// Deck equip has been drawn or equipped. Never sacrifice the absolute last
// equip, or interrupt an already-held Golden without immediate replacement.
function canStockGoldenForLaterEquip(resources, handCards, goldenInDeck) {
  return goldenInDeck > 0 && resources.deckCount > 0 &&
    !(handCards || []).some(card => card && card.id === 'M14');
}

function evaluateProductiveYotoSearch(deckRemaining = {}, handCards = [], options = {}) {
  const goldenInDeck = Math.max(0, Number(deckRemaining.M14 || 0));
  const trueSwordInDeck = Math.max(0, Number(deckRemaining.M20 || 0));
  const handEquipIds = (Array.isArray(handCards) ? handCards : [])
    .filter(card => card && (card.id === 'M19' || card.id === 'M20'))
    .map(card => card.id);

  const immediatelyUsableGolden = handEquipIds.length > 0 ? goldenInDeck : 0;
  const deferredGolden = goldenInDeck - immediatelyUsableGolden;
  const equipResources = summarizeBambooEquipResources(deckRemaining, handCards, options);
  // Outlet is diagnostic only; the user permits stocking Golden and waiting.
  const deferredGoldenHasOutlet = options.deferredGoldenHasOutlet === true;
  const deferredGoldenSearchAllowed = !trueSwordInDeck && !handEquipIds.length &&
    canStockGoldenForLaterEquip(equipResources, handCards, goldenInDeck);
  const productiveGolden = immediatelyUsableGolden || (deferredGoldenSearchAllowed ? goldenInDeck : 0);
  const productiveCount = trueSwordInDeck + productiveGolden;

  return {
    productiveCount,
    trueSwordInDeck,
    searchableGolden: goldenInDeck,
    productiveGolden,
    immediatelyUsableGolden,
    deferredGolden,
    deferredGoldenHasOutlet,
    deferredGoldenSearchAllowed,
    equipResources,
    blockedReason: !productiveCount ? 'NO_REPLACEMENT_BAMBOO_EQUIP_AFTER_LINK' : null,
    handEquipIds
  };
}

function shouldEvaluateEquippedYotoContinuation(node, hasGoldenInHand, goldenDrawEquipId) {
  // A hand True Bamboo used only to enable Golden is not an equipped Yoto;
  // drawing the last Golden must never reopen Y1 for this carrier.
  if (goldenDrawEquipId === 'M20') return false;
  return ['M19_EQUIPPED', 'GOLDEN_BAMBOO_DRAW_READY', 'EQUIPPED_YOTO_NO_SEARCH_TARGET'].includes(node);
}

// Pure, current-state plan shared by branch routing and the pre-input guard.
// M14 is never counted as an equip. No random draw is assumed to succeed.
function planEquippedBambooContinuation(deckRemaining = {}, handCards = [], options = {}) {
  const resources = summarizeBambooEquipResources(deckRemaining, handCards, options);
  const runtime = options.runtime || {};
  const branch = runtime.v5Branch || {};
  const fieldId = resources.byId.M19.field ? 'M19' : resources.byId.M20.field ? 'M20' : null;
  const searchId = bambooSearchTargetIds().find(id => Number(deckRemaining[id] || 0) > 0) || null;
  const replacementId = resources.byId.M20.hand > 0 || searchId === 'M20' ? 'M20'
    : resources.byId.M19.hand > 0 ? 'M19' : null;
  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const hasGolden = handCards.some(card => card && card.id === 'M14');
  // Narrow provenance: the first equip encountered was True + Golden, with
  // ALL Yotos still in Deck. This is not the earlier Yoto-first Link loop.
  const firstTrueGoldenSetup = !fieldId && resources.byId.M20.hand > 0 && hasGolden &&
    resources.byId.M19.total > 0 && resources.byId.M19.deck === resources.byId.M19.total &&
    resources.byId.M19.hand === 0 && Number(runtime.usedCounts && runtime.usedCounts.M19 || 0) === 0 &&
    Number(runtime.usedCounts && runtime.usedCounts.M20 || 0) === 0 &&
    Number(runtime.effectUsage && runtime.effectUsage.M19_SEARCH || 0) === 0 && carrierId !== 'M06';
  const rayePreparation = branch.currentState === 'RAYE_NORMAL_SUMMONED' &&
    runtime.rayeNormalSummoned === true && branch.rayeOnlyMonster !== false && !fieldId;
  const prepareEquipId = rayePreparation
    ? resources.byId.M19.hand > 0 && searchId ? 'M19'
      : resources.byId.M20.hand > 0 && resources.byId.M19.deck > 0 ? 'M20' : null
    : null;
  // E10 is never a continuation Link material. Raye's own-effect departure
  // is a different route: prepare Yoto CL1 / E10 CL2 before it leaves.
  const directRaye = fieldId === 'M19' && carrierId === 'M06' &&
    runtime.rayeNormalSummoned === true && Boolean(searchId);
  const canDeferGolden = searchId === 'M14' &&
    canStockGoldenForLaterEquip(resources, handCards, Number(deckRemaining.M14 || 0));
  const shouldLink = fieldId === 'M19' && carrierId !== 'E10' && carrierId !== 'M06' &&
    Boolean(carrierId && searchId && (replacementId || canDeferGolden));
  const deferredGoldenSearch = shouldLink && !replacementId;
  const shouldContinue = shouldLink || directRaye;
  const convertsTrue = shouldLink && replacementId === 'M20' && resources.byId.M19.deck > 0;
  const steps = directRaye ? ['RAYE_EFFECT_SEND_M19_SUMMON_E10', 'DUAL_M19_CL1_E10_CL2', `SEARCH_${searchId}`]
    : deferredGoldenSearch ? ['LINK_SEND_M19', 'SEARCH_M14', 'WAIT_FOR_DECK_EQUIP']
    : shouldLink ? ['LINK_SEND_M19', `SEARCH_${searchId}`, `EQUIP_${replacementId}`,
    ...(convertsTrue ? ['SEND_M20_EQUIP_DECK_M19'] : [])] : [];
  return { shouldLink, shouldContinue, routeKind: directRaye ? 'RAYE_DIRECT_DUAL'
      : deferredGoldenSearch ? 'YOTO_LINK_DEFERRED_GOLDEN' : shouldLink ? 'YOTO_LINK' : 'PRESERVE',
    searchId, replacementId, carrierId, fieldId, prepareEquipId,
    firstTrueGoldenSetup,
    replacementSource: replacementId && resources.byId[replacementId].hand > 0 ? 'HAND'
      : replacementId === 'M20' && searchId === 'M20' ? 'YOTO_SEARCH' : null,
    canReplaceEquipDeterministically: Boolean(replacementId), deferredGoldenSearch, convertsTrue, steps,
    projectedEquipSentToGraveCount: shouldLink ? (convertsTrue ? 2 : 1) : directRaye ? 1 : 0,
    projectedFieldEquipId: directRaye ? null : shouldLink ? (convertsTrue ? 'M19' : replacementId) : fieldId,
    reason: fieldId !== 'M19' ? 'NO_EQUIPPED_YOTO' : !carrierId ? 'NO_PROVEN_CARRIER'
      : carrierId === 'E10' ? 'E10_CANNOT_BE_LINK_MATERIAL'
      : carrierId === 'M06' && !directRaye ? 'RAYE_DUAL_ROUTE_NOT_PROVEN' : !searchId ? 'NO_SEARCH_TARGET'
      : directRaye ? 'PREPARED_RAYE_DIRECT_DUAL'
        : deferredGoldenSearch ? 'STOCK_GOLDEN_WAIT_FOR_REMAINING_DECK_EQUIP'
        : !replacementId ? 'NO_DETERMINISTIC_REPLACEMENT'
        : convertsTrue ? 'TWO_EQUIPS_TO_GRAVE_ONE_ON_FIELD' : 'FIXED_SEARCH_WITH_REPLACEMENT',
    equipResources: resources };
}

module.exports = {
  summarizeBambooEquipResources,
  evaluateProductiveYotoSearch,
  shouldEvaluateEquippedYotoContinuation,
  planEquippedBambooContinuation
};
