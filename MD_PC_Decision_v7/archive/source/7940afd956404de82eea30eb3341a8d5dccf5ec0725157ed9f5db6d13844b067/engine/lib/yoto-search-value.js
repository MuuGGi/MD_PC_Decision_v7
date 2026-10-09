'use strict';
const { chooseBambooSearchTarget } = require('./bamboo-search-policy');
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');

function summarizeBambooEquipResources(deckRemaining = {}, handCards = [], options = {}) {
  const hand = Array.isArray(handCards) ? handCards : [];
  const runtime = options.runtime || {};
  const branch = runtime.v5Branch || {};
  const committedCounts = runtime.equippedBambooCounts;
  const fieldCounts = runtime.bambooSwordEquipped !== true ? {} : committedCounts ||
    { [runtime.equippedBambooId || (branch.goldenDrawEquipId === 'M20' || branch.currentState === 'M20_EQUIPPED' ? 'M20' : 'M19')]: 1 };
  const fieldCount = ['M19', 'M20'].reduce((n, id) => n + Math.max(0, Number(fieldCounts[id] || 0)), 0);
  const fieldId = fieldCount ? (runtime.equippedBambooId ||
    (branch.goldenDrawEquipId === 'M20' || branch.currentState === 'M20_EQUIPPED' ? 'M20' : 'M19')) : null;
  const byId = {};
  for (const id of ['M19', 'M20']) {
    const total = options.byId && options.byId[id] && Number(options.byId[id].count);
    const deck = Math.max(0, Number(deckRemaining[id] || 0));
    const held = hand.filter(card => card && card.id === id).length;
    const field = Math.max(0, Number(fieldCounts[id] || 0));
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
// equip. Ordinary Golden does not outrank a proven fixed search/replacement
// chain, but is cashed before speculative departures. Re-plan after resolution.
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

function provenUnequippedBambooCarrier(runtime = {}) {
  const branch = runtime.v5Branch || {}, node = String(branch.currentState || '');
  if (runtime.bambooSwordEquipped === true ||
      (branch.active === true && node !== 'RAYE_NORMAL_SUMMONED') ||
      /PENDING|IN_FLIGHT|PROMPT|SELECTED_FROM_DECK|FIELD_EFFECT_ACTIVATED/.test(node)) return null;
  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  return /^E(?:0[2-9]|10)$/.test(carrierId) || carrierId === 'TOKEN_SKY_STRIKER' ||
    (carrierId === 'M06' && runtime.rayeNormalSummoned === true) ? carrierId : null;
}

// A live hand True + a proven carrier + a Deck Yoto is a deterministic
// conversion regardless of how True entered the hand or the last node label.
function planTrueBambooConversionSetup(cards = [], runtime = {}, deck = {}) {
  const carrierId = provenUnequippedBambooCarrier(runtime);
  const sword = cards.find(card => card?.id === 'M20');
  const yotoInDeck = Number(deck.deckRemaining?.M19 || 0);
  if (!carrierId || !sword || yotoInDeck < 1 || adjustedMainDeckRemainingCount(deck) < 1) return null;
  return { sword, carrierId, yotoInDeck,
    branchState: String(runtime.v5Branch?.currentState || ''), phase: 'CURRENT_RESOURCE_TRUE_EQUIP' };
}

// Pure, current-state plan shared by branch routing and the pre-input guard.
// M14 is never counted as an equip. No random draw is assumed to succeed.
function planEquippedBambooContinuation(deckRemaining = {}, handCards = [], options = {}) {
  const resources = summarizeBambooEquipResources(deckRemaining, handCards, options);
  const runtime = options.runtime || {};
  const branch = runtime.v5Branch || {};
  const fieldId = resources.byId.M19.field ? 'M19' : resources.byId.M20.field ? 'M20' : null;
  const searchId = chooseBambooSearchTarget({ deckRemaining, handCards }).id;
  const replacementId = resources.byId.M20.hand > 0 || searchId === 'M20' ? 'M20'
    : resources.byId.M19.hand > 0 ? 'M19' : null;
  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const hasGolden = handCards.some(card => card && card.id === 'M14');
  const goldenDrawReady = require('../../src/integration/legacy-capabilities').goldenFromLegacy(
    handCards, options.deck || { deckRemaining }, { ...runtime, bambooSwordEquipped: Boolean(fieldId) }, fieldId).status === 'READY';
  // Narrow provenance: the first equip encountered was True + Golden, with
  // ALL Yotos still in Deck. This is not the earlier Yoto-first Link loop.
  const firstTrueGoldenSetup = !fieldId && resources.byId.M20.hand > 0 && hasGolden &&
    resources.byId.M19.total > 0 && resources.byId.M19.deck === resources.byId.M19.total &&
    resources.byId.M19.hand === 0 && Number(runtime.usedCounts && runtime.usedCounts.M19 || 0) === 0 &&
    Number(runtime.usedCounts && runtime.usedCounts.M20 || 0) === 0 &&
    Number(runtime.effectUsage && runtime.effectUsage.M19_SEARCH || 0) === 0 && carrierId !== 'M06';
  const rayePreparation = carrierId === 'M06' && runtime.rayeNormalSummoned === true &&
    branch.rayeOnlyMonster !== false && !fieldId;
  const afterHandYotoHasReplacement = searchId === 'M20' || resources.byId.M20.hand > 0 ||
    resources.byId.M19.hand > 1 || canStockGoldenForLaterEquip(resources, handCards, Number(deckRemaining.M14 || 0));
  const prepareEquipId = rayePreparation
    ? resources.byId.M19.hand > 0 && searchId && afterHandYotoHasReplacement ? 'M19'
      : resources.byId.M20.hand > 0 && resources.byId.M19.deck > 0 ? 'M20' : null
    : null;
  // E10 is never a continuation Link material. Raye's own-effect departure
  // is a different route: prepare Yoto CL1 / E10 CL2 before it leaves.
  const linkCarrier = /^E0[2-9]$/.test(carrierId) || carrierId === 'TOKEN_SKY_STRIKER';
  const rayeCarrier = carrierId === 'M06' && runtime.rayeNormalSummoned === true;
  const twoYotoKagari = resources.byId.M19.field === 2 &&
    ['TOKEN_SKY_STRIKER', 'E03', 'E04', 'E05'].includes(carrierId) &&
    Number(runtime.usedCounts?.M17 || 0) > 0 && Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) === 0 &&
    Number(deckRemaining.M20 || 0) >= 1 && Number(deckRemaining.M14 || 0) >= 1;
  // Fixed chain > ordinary draw-2. A Deck-only spare for a Golden search is
  // NOT a deterministic replacement: do not pretend its eventual draw/equip.
  const fixedContinuationReady = fieldId === 'M19' && Boolean(searchId && replacementId) &&
    (linkCarrier || rayeCarrier);
  const goldenDrawPreferred = goldenDrawReady && !fixedContinuationReady;
  const directRaye = fieldId === 'M19' && carrierId === 'M06' &&
    runtime.rayeNormalSummoned === true && Boolean(searchId) &&
    !goldenDrawPreferred && resources.hasReplacementAfterLink;
  const canDeferGolden = searchId === 'M14' &&
    canStockGoldenForLaterEquip(resources, handCards, Number(deckRemaining.M14 || 0));
  const shouldLink = fieldId === 'M19' && linkCarrier &&
    !goldenDrawPreferred && Boolean(searchId && (replacementId || canDeferGolden));
  const deferredGoldenSearch = shouldLink && !replacementId;
  const shouldContinue = shouldLink || directRaye;
  const convertsTrue = shouldLink && replacementId === 'M20' && resources.byId.M19.deck > 0;
  const steps = twoYotoKagari ? ['LINK_E02_SEND_TWO_M19', 'M19_CL1_M19_CL2_E02_CL3',
    'RECOVER_M17', 'SEARCH_M20', 'SEARCH_M14', 'EQUIP_M20_FOR_GOLDEN']
    : directRaye ? ['RAYE_EFFECT_SEND_M19_SUMMON_E10', 'DUAL_M19_CL1_E10_CL2', `SEARCH_${searchId}`]
    : deferredGoldenSearch ? ['LINK_SEND_M19', 'SEARCH_M14', 'WAIT_FOR_DECK_EQUIP']
    : shouldLink ? ['LINK_SEND_M19', `SEARCH_${searchId}`, `EQUIP_${replacementId}`,
    ...(convertsTrue ? ['SEND_M20_EQUIP_DECK_M19'] : [])] : [];
  return { shouldLink, shouldContinue, routeKind: directRaye ? 'RAYE_DIRECT_DUAL'
      : deferredGoldenSearch ? 'YOTO_LINK_DEFERRED_GOLDEN' : shouldLink ? 'YOTO_LINK' : 'PRESERVE',
    searchId, replacementId, carrierId, fieldId, prepareEquipId, goldenDrawReady,
    fixedContinuationReady, goldenDrawPreferred,
    twoYotoKagari,
    firstTrueGoldenSetup,
    replacementSource: replacementId && resources.byId[replacementId].hand > 0 ? 'HAND'
      : replacementId === 'M20' && searchId === 'M20' ? 'YOTO_SEARCH' : null,
    canReplaceEquipDeterministically: Boolean(replacementId), deferredGoldenSearch, convertsTrue, steps,
    projectedEquipSentToGraveCount: twoYotoKagari ? 2 : shouldLink ? (convertsTrue ? 2 : 1) : directRaye ? 1 : 0,
    projectedFieldEquipId: directRaye ? null : shouldLink ? (convertsTrue ? 'M19' : replacementId) : fieldId,
    reason: goldenDrawPreferred ? 'ORDINARY_GOLDEN_DRAW_BEFORE_SPECULATIVE_DEPARTURE'
      : goldenDrawReady && fixedContinuationReady ? 'FIXED_CHAIN_BEFORE_ORDINARY_GOLDEN_DRAW'
      : fieldId !== 'M19' ? 'NO_EQUIPPED_YOTO' : !carrierId ? 'NO_PROVEN_CARRIER'
      : carrierId === 'E10' ? 'E10_CANNOT_BE_LINK_MATERIAL'
      : carrierId === 'M06' && !directRaye ? !resources.hasReplacementAfterLink
        ? 'PRESERVE_LAST_BAMBOO_EQUIP' : 'RAYE_DUAL_ROUTE_NOT_PROVEN' : !searchId ? 'NO_SEARCH_TARGET'
      : directRaye ? 'PREPARED_RAYE_DIRECT_DUAL'
        : deferredGoldenSearch ? 'STOCK_GOLDEN_WAIT_FOR_REMAINING_DECK_EQUIP'
        : !replacementId ? 'NO_DETERMINISTIC_REPLACEMENT'
        : convertsTrue ? 'TWO_EQUIPS_TO_GRAVE_ONE_ON_FIELD' : 'FIXED_SEARCH_WITH_REPLACEMENT',
    equipResources: resources };
}

// The original diagram's TWO branches. Each fork publishes only the CURRENT
// action and its costs; receipt node names do not award strategic priority.
// UI transactions/optional chains remain in the mature transition executor.
function collectBambooBranchCandidates(cards = [], runtime = {}, deck = {}) {
  const { PRIORITY: P } = require('../../src/strategy/action-order');
  const { describeEquipmentOpportunityCost } = require('./raye-closeout-policy');
  const { planKagariSwordPreparation } = require('./kagari-sword-plan');
  const { chooseEquippedRayeLink, describeCombinedYotoZero } = require('./double-link-policy');
  const { planGoldenBambooSetup } = require('./golden-bamboo-setup-policy');
  const { mainMonsterConstraint } = require('../../src/core/field-state');
  const { chooseEngageTarget } = require('./engage-policy');
  const branch = runtime.v5Branch || {}, node = String(branch.currentState || '');
  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const resources = summarizeBambooEquipResources(deck.deckRemaining, cards, { runtime, byId: deck.byId });
  const recoveryReady = Number(runtime.usedCounts?.M17 || 0) > 0 && Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) === 0;
  const fireMaterial = ['TOKEN_SKY_STRIKER', 'E03', 'E04', 'E05'].includes(carrierId);
  const opportunity = describeEquipmentOpportunityCost(cards, runtime, deck);
  const actions = [], decision = { branch: carrierId ? 'B_CARRIER_BAMBOO' : 'A_HORNET_KAGARI',
    fork: 'NO_CURRENT_BRANCH_GAIN', carrierId: carrierId || null, resources, opportunity, recoveryReady };
  let engageAction = null;
  const held = id => cards.find(c => c?.id === id);
  const handAction = (card, tier, reason, details = {}) => actions.push({ ...card, slot: card.index,
    tier, usable: true, reason, details: { branchDecision: true, ...details } });
  const fieldAction = (fieldIntent, reason, details = {}) => actions.push({ id: carrierId || 'FIELD',
    name: reason, specialAction: 'FIELD_RESOURCE_STEP', tier: P.FIXED_RESOURCE, reason,
    details: { branchDecision: true, node, fieldIntent, ...details } });
  const finish = fork => ({ actions, engageAction, branchDecision: { ...decision, fork } });
  if (/PENDING|IN_FLIGHT|PROMPT|SELECTED_FROM_DECK|FIELD_EFFECT_ACTIVATED/.test(node))
    return finish('WAIT_FOR_COMMITTED_TRANSACTION');

  // A: entrance establishes a carrier, never a precommitted future macro.
  if (!carrierId) {
    const hornet = held('M22');
    const equipment = held('M19') || held('M20');
    const fixedEquipment = equipment && (equipment.id === 'M19'
      ? Number(deck.deckRemaining?.M20 || 0) > 0 : Number(deck.deckRemaining?.M19 || 0) > 0);
    if (hornet?.usable === true && !mainMonsterConstraint(runtime).blocked && (recoveryReady || fixedEquipment))
      handAction(hornet, P.FIXED_RESOURCE, '大支线A：黄蜂先生成实际载体；装备、抽2和火刀回收在结算后的分叉决定。',
        { phase: 'HORNET_CARRIER_ENTRY', bambooFollowUp: Boolean(fixedEquipment) });
    const raye = held('M06');
    if (!hornet && raye && equipment && held('M14') && runtime.normalSummonUsed !== true &&
        !mainMonsterConstraint(runtime).blocked && adjustedMainDeckRemainingCount(deck) >= 2)
      handAction(raye, P.DRAW_TWO + 0.5, '大支线B：现有零衣通招可提供刀的抽2载体；安全诱惑先做，只提交通招，不预支抽牌。',
        { phase: 'RAYE_CARRIER_FOR_BAMBOO' });
    return finish('CARRIER_ENTRY');
  }

  // B: fulfil sword departure and Zero gain with the SAME Link when the
  // current costs, replacement and Engage yield are proved. Publish only the
  // next action, never reserve a future draw or execute a multi-step macro.
  const combined = describeCombinedYotoZero(cards, runtime, deck);
  decision.combinedZeroOpportunity = combined.ready ? {
    nextAction: combined.nextAction, gains: combined.gains,
    extraDeckSummons: combined.extraDeckSummons, savedExtraDeckSummons: combined.savedExtraDeckSummons
  } : { ready: false, reason: combined.reason };
  if (combined.ready) {
    const jointGain = { gains: combined.gains, extraDeckSummons: combined.extraDeckSummons,
      alternativeExtraDeckSummons: combined.alternativeExtraDeckSummons,
      savedExtraDeckSummons: combined.savedExtraDeckSummons };
    if (combined.nextAction === 'EQUIP')
      handAction(combined.sword, P.FIXED_RESOURCE,
        '大支线B：先装当前刀，使送刀检索与双素材零梦在一次Link中完成，少一次额外特招；装备结算后重新核对。',
        { phase: 'CURRENT_RESOURCE_JOINT_EQUIP', jointGain,
          equipIntent: { cardId: combined.sword.id, carrierId, forGoldenOnly: false,
            conversionExpected: combined.sword.id === 'M20' } });
    else if (combined.nextAction === 'CONVERT_TRUE')
      fieldAction('TRUE_EQUIP_CONVERSION', '大支线B：真刀先换妖刀，再从实际场面决定合并送刀与零梦收益。', { jointGain });
    else if (combined.nextAction === 'SUMMON_RAYE')
      handAction(combined.raye, P.FIXED_RESOURCE,
        '大支线B：妖刀载体已确认，通招零衣准备一次双素材Link兑现刀检索和零梦交闪；本次只通招。',
        { phase: 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY', existingCarrierId: carrierId,
          e10EngageSource: combined.engage.preferredSource, preserveEquippedYoto: true, jointGain });
    else if (combined.nextAction === 'LINK')
      fieldAction('EQUIPPED_BAMBOO_DEPARTURE',
        '大支线B：当前两个素材及妖刀已齐，直接Link零梦触发双效果，不绕一次普通单素材Link。',
        { targetLinkId: 'E10', materialCarrierId: carrierId, currentYotoCount: 1,
          m19EffectCount: 1, doubleWithRaye: true, bambooSearchTargetId: combined.searchId,
          linkObjective: 'BAMBOO_DEPARTURE', additionalHandCosts: {}, jointGain });
    return finish('COMBINED_YOTO_ZERO_GAIN');
  }

  // B / fork 1: an open Zero gain competes BEFORE nonproductive equipment.
  if (opportunity.deferEquipment) {
    if (opportunity.nextResource === 'CURRENT_ENGAGE_ACCESS')
      engageAction = { tier: P.ENGAGE, reason: '大支线B：当前交闪可补齐零衣／零梦收益，保持最后手牌刀未装备，结算后重新决定。' };
    return finish('KEEP_UNEQUIPPED_FOR_ZERO_GAIN');
  }

  // B / fork 2: current True equip has one proven conversion action.
  if (resources.byId.M20.field > 0) {
    if (Number(deck.deckRemaining?.M19 || 0) > 0 && node === 'M20_EQUIPPED')
      fieldAction('TRUE_EQUIP_CONVERSION', '大支线B：场上真刀换装牌组妖刀；换装完成后重新判断抽2和送墓。');
    return finish('TRUE_TO_YOTO_OR_KEEP_FOR_GOLDEN');
  }

  // B / fork 3: current Yoto either cashes a fixed departure or stays for draw2.
  if (resources.byId.M19.field > 0) {
    const plan = planEquippedBambooContinuation(deck.deckRemaining, cards, { runtime, deck, byId: deck.byId });
    let count = resources.byId.M19.field, prepareSecond = false, continuation = plan;
    if (recoveryReady && fireMaterial && count === 1 && held('M19') &&
        Number(deck.deckRemaining?.M20 || 0) > 0 && Number(deck.deckRemaining?.M14 || 0) > 0 && cards.length <= 11) {
      const afterSecond = cards.filter(c => c !== held('M19'));
      const two = planEquippedBambooContinuation(deck.deckRemaining, afterSecond, { deck, byId: deck.byId,
        runtime: { ...runtime, equippedBambooCounts: { M19: 2 } } });
      if (two.twoYotoKagari && two.shouldLink) { prepareSecond = true; count = 2; continuation = two; }
    }
    if (continuation.shouldContinue && [1, 2].includes(count) && (count !== 2 || continuation.twoYotoKagari)) {
      const fire = recoveryReady && fireMaterial;
      const doubleWithRaye = !fire && carrierId !== 'M06' && runtime.rayeNormalSummoned === true &&
        chooseEquippedRayeLink(cards, runtime, deck, continuation).answer === '2';
      fieldAction('EQUIPPED_BAMBOO_DEPARTURE', prepareSecond
        ? '大支线A/B：补装当前手牌妖刀，准备两次检索＋火刀回收；本次只装备，随后重新验收决策。'
        : '大支线B：当前装备送墓存在确定检索续接；选择离场动作，之后完整处理刀和新怪兽效果。',
        { targetLinkId: fire ? 'E02' : doubleWithRaye ? 'E10' : null, materialCarrierId: carrierId,
          currentYotoCount: resources.byId.M19.field, m19EffectCount: count, doubleWithRaye,
          bambooSearchTargetId: continuation.searchId,
          linkObjective: 'BAMBOO_DEPARTURE', additionalHandCosts: prepareSecond ? { M19: 1 } : {} });
    }
    return finish(continuation.shouldContinue ? 'CONFIRMED_DEPARTURE' : 'KEEP_EQUIP_FOR_GOLDEN');
  }

  // A / fork: held Engage is cashed before spending the unused Fire carrier.
  const engage = held('M17'), search = chooseEngageTarget(deck, runtime);
  if (recoveryReady && fireMaterial && carrierId !== 'TOKEN_SKY_STRIKER' && engage && search &&
      !mainMonsterConstraint(runtime).blocked && adjustedMainDeckRemainingCount(deck) >= (runtime.graveSpellCount >= 3 ? 2 : 1)) {
    engageAction = { tier: P.FIXED_RESOURCE,
      reason: '大支线A/B：载体未装备且火刀回收可用，先兑现手中交闪，再从新资源决定装刀合并或裸Link。' };
    return finish('ENGAGE_BEFORE_FIRE_RECOVERY');
  }
  const setup = planGoldenBambooSetup(cards, runtime, deck);
  if (recoveryReady && fireMaterial) {
    const preparation = planKagariSwordPreparation(cards, runtime, deck, carrierId);
    if (preparation) {
      fieldAction('KAGARI_SWORD_PREPARATION', '大支线A：在当前素材上装备已选定的刀，合并确定的刀检索与火刀回收。',
        { kagariPreparation: preparation, materialCarrierId: carrierId,
          additionalHandCosts: { [preparation.plannedSwordId]: 1 } });
      return finish('EQUIP_FOR_COMBINED_FIRE_GAIN');
    }
    if (!setup) {
      actions.push({ id: 'E02', name: '闪刀姬－篝', tier: P.FIXED_RESOURCE,
        specialAction: 'KAGARI_LINK_BEFORE_TRUE', reason: '大支线A：没有当前可兑现的装刀抽2／送刀续接，裸Link火刀回收真实墓地交闪。',
        details: { branchDecision: true, fieldIntent: 'BARE_KAGARI_LINK', carrierId } });
      return finish('BARE_FIRE_RECOVERY');
    }
  }

  // B / fork 2: choose equipment from CURRENT gain, independent of origin.
  const conversion = planTrueBambooConversionSetup(cards, runtime, deck);
  const yoto = held('M19');
  const afterYoto = yoto ? cards.filter(c => c !== yoto) : [];
  const yotoPlan = yoto && planEquippedBambooContinuation(deck.deckRemaining, afterYoto, { deck, byId: deck.byId,
    runtime: { ...runtime, bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 } } });
  const sword = conversion?.sword || (yotoPlan?.shouldContinue ? yoto : setup?.sword);
  if (sword) {
    const fixed = Boolean(conversion || yotoPlan?.fixedContinuationReady || yotoPlan?.deferredGoldenSearch);
    const forGoldenOnly = !fixed && Boolean(setup);
    handAction(sword, fixed ? P.FIXED_RESOURCE : P.DRAW_TWO, fixed
      ? '大支线B：装备使当前确定换装／检索续接成立；每一步结算后回当前分叉。'
      : '大支线B：没有先兑现的Link收益，装备当前刀使金竹抽2；最后一把刀也可用于抽2。',
      { phase: forGoldenOnly ? setup.phase : sword.id === 'M20' ? 'CURRENT_RESOURCE_TRUE_EQUIP' : 'EQUIP_YOTO_FOR_FIXED_SEARCH',
        enablesGoldenDraw2: Boolean(setup), equipIntent: { cardId: sword.id, carrierId,
          forGoldenOnly, conversionExpected: sword.id === 'M20' && Number(deck.deckRemaining?.M19 || 0) > 0 } });
  }
  return finish(sword ? 'EQUIP_FOR_CURRENT_GAIN' : 'NO_CURRENT_BRANCH_GAIN');
}

// A Link selection is a strategy fork over the GAME-proven legal set. Equal
// no-immediate-gain carriers get an explicit stable tie-break, not window order.
function chooseBambooLinkTarget(legalIds, { carrierId, recoveryReady = false, allowZero = false } = {}) {
  const scores = id => id === 'E02' ? recoveryReady ? 3 : -1 : id === 'E10' ? allowZero ? 2 : -1
    : ['E03', 'E04', 'E05'].includes(id) ? 1 : -1;
  return [...new Set(legalIds)].filter(id => scores(id) >= 0)
    .sort((a, b) => scores(b) - scores(a) || Number(a === carrierId) - Number(b === carrierId) || a.localeCompare(b))[0] || null;
}

module.exports = {
  collectBambooBranchCandidates,
  chooseBambooLinkTarget,
  provenUnequippedBambooCarrier,
  planTrueBambooConversionSetup,
  summarizeBambooEquipResources,
  evaluateProductiveYotoSearch,
  shouldEvaluateEquippedYotoContinuation,
  planEquippedBambooContinuation
};
