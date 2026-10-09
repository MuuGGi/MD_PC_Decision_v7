'use strict';
const { clone } = require('../core/json-store');
const { leadingCandidate, arbitrateCandidates } = require('./action-order');
const { collectCandidateActions } = require('../../engine/lib/decision-engine');
const { withDecisionLedgerSnapshot } = require('../../engine/lib/main-deck-ledger');
const { describeRayeCloseout } = require('../../engine/lib/raye-closeout-policy');
const { analyzeReachableResourceDeadlock } = require('../../engine/lib/deadlock-detector');
const { buildLastResortAllureAction } = require('../../engine/lib/allure-policy');
const { adjustedMainDeckRemainingCount } = require('../../engine/lib/exodia-policy');
const { planEquippedBambooContinuation, summarizeBambooEquipResources } = require('../../engine/lib/yoto-search-value');
const { planGoldenBambooSetup } = require('../../engine/lib/golden-bamboo-setup-policy');
const { planKagariSwordPreparation } = require('../../engine/lib/kagari-sword-plan');
const { chooseEquippedRayeLink } = require('../../engine/lib/double-link-policy');
const { mainMonsterConstraint } = require('../core/field-state');

function fieldCandidates(context, result) {
  const { hand, runtime } = context, rows = [];
  const leader = leadingCandidate(result);
  const closeout = describeRayeCloseout(hand.cards, runtime, result);
  const node = String(runtime.v5Branch?.currentState || ''), carrierId = String(runtime.v5Branch?.carrierId || '');
  const addField = (name, tier, reason, details = {}) => rows.push({ specialAction: 'FIELD_RESOURCE_STEP',
    id: carrierId || 'FIELD', name, tier, reason, details: { node, ...details } });
  const recoveryReady = Number(runtime.usedCounts.M17 || 0) > 0 &&
    Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) === 0;
  const equips = summarizeBambooEquipResources(result.deck.deckRemaining, hand.cards,
    { runtime, byId: result.deck.byId });
  if (node === 'M20_EQUIPPED' && equips.byId.M20.field > 0 && carrierId && result.deck.deckRemaining.M19 > 0)
    addField('发动当前真刀效果，以实际牌组妖刀换装', -1,
      '当前真刀、载体与牌组妖刀已确认；只执行这次换装，结算后重新比较抽牌及送墓收益。',
      { fieldIntent: 'TRUE_EQUIP_CONVERSION' });
  if (node === 'M19_EQUIPPED') {
    const plan = planEquippedBambooContinuation(result.deck.deckRemaining, hand.cards,
      { runtime, deck: result.deck, byId: result.deck.byId });
    const currentYotoCount = equips.byId.M19.field;
    const kagari = recoveryReady && ['TOKEN_SKY_STRIKER', 'E03', 'E04', 'E05'].includes(carrierId);
    // A historical plan for two effects is not a receipt for two equipped
    // swords. The existing preparation may still require a real hand sword.
    const prepareSecond = kagari && currentYotoCount === 1 &&
      runtime.v5Branch?.kagariSwordLink === true && runtime.v5Branch?.m19EffectCount === 2 &&
      hand.cards.some(c => c.id === 'M19');
    const m19EffectCount = currentYotoCount + (prepareSecond ? 1 : 0);
    let twoSwordReady = m19EffectCount !== 2;
    if (kagari && m19EffectCount === 2) {
      const held = hand.cards.slice();
      if (prepareSecond) held.splice(held.findIndex(c => c.id === 'M19'), 1);
      const continuation = planEquippedBambooContinuation(result.deck.deckRemaining, held,
        { deck: result.deck, byId: result.deck.byId, runtime: { ...runtime,
          equippedBambooCounts: { ...runtime.equippedBambooCounts, M19: 2 },
          v5Branch: { ...runtime.v5Branch, kagariSwordLink: true, m19EffectCount: 2 } } });
      twoSwordReady = continuation.twoYotoKagari && continuation.shouldLink;
    }
    if (plan.shouldContinue && [1, 2].includes(m19EffectCount) && twoSwordReady) {
      const doubleWithRaye = !kagari && carrierId !== 'M06' && runtime.rayeNormalSummoned === true &&
        chooseEquippedRayeLink(hand.cards, runtime, result.deck, plan).answer === '2';
      addField('兑现当前装备离场的检索／回收收益', -1,
        '当前装备离场收益成立；已有可抽金竹时，仍由共享装备计划比较确定续接与先抽牌，不预测随机补刀。',
        { fieldIntent: 'EQUIPPED_BAMBOO_DEPARTURE', targetLinkId: kagari ? 'E02' : doubleWithRaye ? 'E10' : null,
          materialCarrierId: carrierId, currentYotoCount, m19EffectCount,
          doubleWithRaye,
          additionalHandCosts: prepareSecond ? { M19: 1 } : {} });
    }
  }
  if (node === 'HORNET_TOKEN_READY' || node === 'POST_E10_HORNET_TOKEN_READY') {
    const setup = planGoldenBambooSetup(hand.cards, runtime, result.deck);
    // A ready equipment draw should not be destroyed by blindly taking the
    // token away first. The hand setup competes normally with all other actions.
    if (node === 'HORNET_TOKEN_READY' && carrierId === 'TOKEN_SKY_STRIKER' &&
        (!setup || setup.fixedContinuationReady)) {
      const preparation = planKagariSwordPreparation(hand.cards, runtime, result.deck, carrierId);
      if (preparation)
        addField('在当前黄蜂素材上准备可回收交闪的装备收益', -1,
          '同一局面已决定本次装备及后续可行回收；只提交当前装备，结算后重算，不在执行器里临时换成裸Link。',
          { fieldIntent: 'TOKEN_SWORD_PREPARATION', kagariPreparation: preparation,
            additionalHandCosts: { [preparation.plannedSwordId]: 1 } });
      else if (recoveryReady && !setup)
        addField('用当前黄蜂素材Link火刀取得已知交闪回收入口', 0.5,
          '本次没有已证明的装备抽牌或装备续接准备，且火刀未用、墓地交闪已确认；只选择当前裸Link。',
          { fieldIntent: 'TOKEN_LINK_KAGARI' });
      else if (!recoveryReady) {
        const swordId = runtime.v5Branch?.plannedSwordId;
        const sword = hand.cards.find(c => c.id === swordId);
        if (sword && ['M19', 'M20'].includes(swordId))
          addField('为当前黄蜂载体装备已确认的手牌刀', -1,
            '当前刀与载体已存在；装备完成后重新决定换装、抽牌与送墓，不把历史支线计划当作最终答案。',
            { fieldIntent: 'TOKEN_BAMBOO_EQUIP', swordId,
              additionalHandCosts: { [swordId]: 1 } });
      }
    }
  }
  if (node === 'RAYE_SECOND_MATERIAL_READY' && closeout.ready &&
      closeout.mode === 'DOUBLE_LINK' && closeout.alreadySummoned)
    addField('用当前已在场的两个素材Link零梦',
      closeout.sword.stageComplete ? 2.5 : 96,
      '两素材已在场；依刀送墓阶段排序，不重复通招或占用手牌零衣费用。',
      { fieldIntent: 'COMMITTED_TWO_MATERIAL_GAIN', e10EngageSource: closeout.source,
        swordStage: closeout.sword.stageComplete ? 'CONFIRMED_COMPLETE' : 'NOT_CONFIRMED_COMPLETE' });
  if (runtime.chickenGameDrawPending === true && adjustedMainDeckRemainingCount(result.deck) >= 1) {
    rows.push({ specialAction: 'M21_FIELD_DRAW', id: 'M21', name: '试胆竞速', tier: 1.5,
      reason: '场上已确认的竞速抽1此前为固定检索让路；优先于普通随机抽牌。',
      details: { pendingFieldDraw: true } });
  }
  // Legality and priority are different facts. No currently planned sword
  // departure does NOT mean the sword/GY stage has already been completed.
  if (closeout.ready && node !== 'RAYE_SECOND_MATERIAL_READY') {
    const lastGoldenException = !closeout.swordEntryDeferred && leader?.id === 'M11' && result.deck.deckRemaining.M14 === 1 &&
      closeout.bonusDraw && (closeout.source === 'GRAVE' || closeout.sourcePolicy?.deckEngagePreferred);
    const double = closeout.mode === 'DOUBLE_LINK';
    const stageComplete = closeout.sword?.stageComplete === true;
    const tier = lastGoldenException ? Math.min(2.5, leader.tier - 0.25)
      : double ? stageComplete ? 2.5 : 96 : 101;
    rows.push({ slot: closeout.alreadySummoned ? undefined : closeout.raye.index,
      specialAction: closeout.alreadySummoned ? 'RAYE_FIELD_EFFECT' : undefined,
      id: 'M06', name: closeout.raye?.name || '闪刀姬－零衣', tier,
      v5Fallback: !double,
      reason: (lastGoldenException ? '牌组只剩一张金竹，按既定浮动规则先兑现零梦交闪收益；' : '') +
        (double ? stageComplete ? '刀送墓阶段已确认完成，双素材零梦可在普通抽2前兑现交闪；'
          : '刀送墓阶段尚未完成，双素材零梦保持后备，不抢过有安全费用的诱惑等普通抽2；'
          : closeout.swordEntryDeferred ? '无刀且未确认刀送墓，不因检索零衣立即通招；现有收益和洗牌先做，仅保留已证明合法的资源收尾后备；'
          : '当前普通收益优先；无其它可用动作时，零衣作为直出零梦的收尾入口；') +
        (double ? '通召后必须消耗现有Link与零衣两个素材。' : '零衣须为唯一主怪兽再发动自身效果。'),
      details: { phase: double ? 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY' : 'RAYE_DIRECT_E10_CLOSEOUT',
        existingCarrierId: closeout.carrierId, e10EngageSource: closeout.source,
        swordStage: stageComplete ? 'CONFIRMED_COMPLETE' : 'NOT_CONFIRMED_COMPLETE',
        swordEntryDeferred: closeout.swordEntryDeferred === true,
        engageTargets: result.engageTargets, graveSpellCount: runtime.graveSpellCount } });
  }
  return rows;
}

function explicitDevelopmentCandidates(context, options) {
  const { runtime, hand } = context, raye = hand.cards.find(c => c.id === 'M06');
  if (runtime.v5TestMode === 'RAYE_TRUE_DUAL' && raye && hand.cards.some(c => c.id === 'M20') &&
      runtime.normalSummonUsed !== true && !options.hasNonRayeMonster(runtime))
    return [{ ...raye, slot: raye.index, tier: -100,
      reason: '显式开发模式：只强制零衣入口，后续仍使用正式原子执行。',
      details: { v5TestMode: runtime.v5TestMode } }];
  const hornet = hand.cards.find(c => c.id === 'M22');
  if (runtime.v5TestMode === 'HORNET_TRUE_YOTO_LINK' && hornet &&
      Number(runtime.usedCounts.M22 || 0) === 0 && ['M19', 'M20'].every(id => hand.cards.some(c => c.id === id)))
    return [{ ...hornet, slot: hornet.index, tier: -100,
      reason: '显式开发模式：只强制黄蜂入口，后续仍使用正式原子执行。',
      details: { v5TestMode: runtime.v5TestMode } }];
  return [];
}

function evaluateDecision(context, options) {
  if (options.isTransactionPending(context.runtime.v5Branch?.currentState || ''))
    throw new Error('STRATEGY_UNFINISHED_TRANSACTION_NOT_NEW_DECISION');
  return withDecisionLedgerSnapshot(context.ledger, () => {
    const runtime = clone(context.runtime);
    // Legacy active also encoded future strategy plans. Only known completed
    // field nodes are normalized in this read-only view; open dialogs are not.
    if (options.isFieldPlanning(runtime.v5Branch?.currentState || ''))
      runtime.v5Branch = { ...runtime.v5Branch, active: false };
    const effectiveContext = { ...context, runtime };
    const cards = context.hand.cards.map(card => ({ ...card,
      usable: options.isStrategicallyUsable(card, context.hand, runtime) }));
    const result = collectCandidateActions(cards, context.library, runtime);
    const offered = [...result.actions, ...fieldCandidates(effectiveContext, result),
      ...explicitDevelopmentCandidates(context, options)];
    const mainZone = mainMonsterConstraint(runtime);
    // All providers meet the same capability veto before deadlock/arbitration.
    const blockedCandidates = offered.filter(a => a.id === 'M17' && mainZone.blocked);
    const candidates = offered.filter(a => !(a.id === 'M17' && mainZone.blocked));
    // Deadlock sees the complete same resource pool, not the hand-only result
    // that happened to exist before a field action was considered.
    let strategicDeadlock = analyzeReachableResourceDeadlock({ cards: context.hand.cards,
      runtime, decisionResult: { ...result, actions: candidates } });
    if (result.trueBambooGainPolicy?.applied)
      strategicDeadlock = { terminal: false, type: 'NONE', reason: 'PROVEN_TRUE_BAMBOO_GAIN_ROUTE' };
    const gamble = buildLastResortAllureAction(context.hand.cards,
      { ...result, actions: candidates }, strategicDeadlock);
    if (gamble) {
      candidates.push(gamble);
      strategicDeadlock = { terminal: false, type: 'NONE', reason: 'LAST_RESORT_ALLURE_RAYE_CHANCE',
        prerequisite: strategicDeadlock };
    }
    const final = arbitrateCandidates(candidates, runtime, result.deck.handCounts);
    if (final.rejected.length) throw new Error('STRATEGY_CANDIDATE_CONTRACT_INVALID:' + JSON.stringify(final.rejected));
    const selected = strategicDeadlock.terminal === true ? null : final.selected;
    const published = { ...result, actions: final.actions, selected };
    return { result: published, selected, runtime, strategicDeadlock,
      basis: { snapshotKey: context.snapshotKey, handRevision: context.hand.revision, duelId: context.duelId },
      decisionTrace: { authority: 'V7_SHARED_STRATEGY', zones: context.zones, mainZone,
        equipmentOpportunity: result.equipmentOpportunity || null,
        blockedCandidates, candidates: final.trace } };
  });
}

module.exports = { evaluateDecision };
