'use strict';

const { chooseEngageTarget, searchableEngageTargets } = require('./engage-policy');
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');

// This is an opportunity-cost rule, not a request to traverse every Link.
// It applies only after a proven Yoto search, before equipping the searched
// True Bamboo. Never consume an equipped last sword, Raye, or E10.
function planTrueBambooGain(cards, runtime, deck) {
  const state = runtime || {}, branch = state.v5Branch || {};
  const node = String(branch.currentState || '');
  if (!Array.isArray(cards) || !cards.some(c => c.id === 'M20') ||
      state.bambooSwordEquipped === true || branch.active === true ||
      state.engageBlockedByMainMonster === true || state.rayeNormalSummoned === true ||
      Number(state.effectUsage && state.effectUsage.M19_SEARCH || 0) <= 0) return null;

  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const recoveryUsed = Number(state.effectUsage && state.effectUsage.KAGARI_RECOVERY || 0) > 0;
  // This deferral protects the NOT-YET-used Kagari entrance only. Once
  // Kagari recovered Engage, the atomic collector must equip/convert True
  // first; a persisted provenance flag is not an ongoing priority lease.
  if (recoveryUsed || !(node === 'YOTO_SEARCH_DONE' && ['E03', 'E04', 'E05'].includes(carrierId))) return null;

  const engage = cards.find(c => c.id === 'M17');
  const target = chooseEngageTarget(deck, state);
  const targets = searchableEngageTargets(deck, state);
  const grave = Number(state.graveSpellCount || 0);
  const remaining = adjustedMainDeckRemainingCount(deck);
  if (engage && target && remaining >= (grave >= 3 ? 2 : 1)) {
    return { stage: 'ENGAGE_BEFORE_TRUE',
      card: engage, carrierId, target, targets,
      reason: '妖刀已检索到真刀，但当前载体尚未装刀。先发动交闪取得实际牌组目标，再准备Link篝回收交闪；若有安全装备续接，将装刀送墓与火刀收益合并，否则回收完成后再装刀，保留最后一把装备。' };
  }
  if (Number(state.usedCounts && state.usedCounts.M17 || 0) > 0) {
    return { stage: 'KAGARI_LINK_BEFORE_TRUE', carrierId,
      reason: '当前非火刀没有装备，墓地已有交闪。准备Link篝：有安全装备续接时先在此素材上装刀（真刀先换妖刀），Link后妖刀CL1、篝CL2；否则沿用无装备火刀回收，不能耗尽最后一把装备。' };
  }
  return null;
}

function buildTrueBambooGainAction(cards, runtime, deck) {
  const plan = planTrueBambooGain(cards, runtime, deck);
  if (!plan) return null;
  return plan.card ? {
    slot: plan.card.index, id: 'M17', name: plan.card.name, tier: -5, usable: true,
    reason: plan.reason,
    details: { phase: plan.stage, searchTarget: plan.target, searchableTargets: plan.targets,
      trueBambooGainBeforeEquip: true, carrierId: plan.carrierId }
  } : {
    specialAction: 'KAGARI_LINK_BEFORE_TRUE', id: 'E02', name: '闪刀姬－篝', tier: -5,
    reason: plan.reason, details: { phase: plan.stage, trueBambooGainBeforeEquip: true, carrierId: plan.carrierId }
  };
}

module.exports = { planTrueBambooGain, buildTrueBambooGainAction };
