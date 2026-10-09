'use strict';

const SAFE_BANISH_PRIORITY = Object.freeze([
  Object.freeze({ id: 'M06', name: '闪刀姬－零衣' }),
  Object.freeze({ id: 'M08', name: '闪术兵器－H.A.M.P.' })
]);

function buildAllureBanishPriority() {
  return SAFE_BANISH_PRIORITY.map(item => ({ ...item }));
}

function findAllureBanishCandidate(cards) {
  for (const preferred of SAFE_BANISH_PRIORITY) {
    const matches = (cards || []).filter(item => item && item.id === preferred.id);
    if (!matches.length) continue;
    const first = matches[0];
    return {
      ...preferred,
      count: matches.length,
      originalSlot: Number(first.index) || (cards || []).indexOf(first) + 1
    };
  }
  return null;
}

// Search demand is a current draw partner, independent of normal-summon use.
// A held HAMP is usable emergency material, not a reason to fetch another HAMP
// when a Raye can provide the preferred normal draw2 cost instead.
function describeAllurePartnerDemand(handCounts = {}) {
  if (Number(handCounts.M13 || 0) <= 0 || Number(handCounts.M06 || 0) > 0) return null;
  return { id: 'M06', count: 1, purpose: 'ALLURE_PREFERRED_DRAW_COST',
    preservesHamp: Number(handCounts.M08 || 0) > 0,
    reason: '手中诱惑缺少零衣费用；检索零衣可兑现正常抽2并保留兵器，通招已用不影响其诱惑费用用途。' };
}

function describeAllureDecision(handCounts = {}, usedCounts = {}) {
  const rayeCount = Number(handCounts.M06 || 0);
  const hampCount = Number(handCounts.M08 || 0);

  if (rayeCount > 0) {
    return {
      allowed: true,
      target: { id: 'M06', name: '闪刀姬－零衣' },
      tier: 3,
      tierLabel: 'P3 抽2（零衣作诱惑费用）',
      tradeInUsed: Number(usedCounts.M12 || 0),
      protectHampForFutureTradeIn: false,
      reason:
        '手里有零衣可安全除外，暗之诱惑按正常抽2处理；固定检索和普通抽1先做，但先于暂时休战及普通万宝槌。优先除外零衣，不牺牲组件。'
    };
  }

  if (hampCount > 0) {
    const tradeInUsed = Number(usedCounts.M12 || 0);
    const protectHampForFutureTradeIn = tradeInUsed < 3;
    return {
      allowed: true,
      target: { id: 'M08', name: '闪术兵器－H.A.M.P.' },
      tier: 99,
      tierLabel: 'P99 暗之诱惑（H.A.M.P.应急，万宝槌之前）',
      tradeInUsed,
      protectHampForFutureTradeIn,
      reason: protectHampForFutureTradeIn
        ? `抵价交易目前只使用了${tradeInUsed}/3张；H.A.M.P.优先保留作未来抵价交易8星费用。` +
          '先完成固定检索/回收及其它可用抽牌；没有其它费用更合适的动作时，仍先发动可用诱惑，万宝槌留作保护性兜底。'
        : '3张抵价交易均已使用；H.A.M.P.可作为应急除外目标。先完成固定检索/回收及其它可用抽牌，诱惑先于保护性兜底的万宝槌。'
    };
  }

  return {
    allowed: false,
    target: null,
    tier: null,
    tierLabel: null,
    tradeInUsed: Number(usedCounts.M12 || 0),
    protectHampForFutureTradeIn: false,
    reason:
      '当前手牌没有零衣；也没有按已讨论规则允许应急除外的H.A.M.P.，暂不自动选择。'
  };
}

// A no-safe-DARK gamble is offered only after every modeled action is exhausted.
// A forecast of no further draw must never skip a currently legal fixed search.
function buildLastResortAllureAction(cards, decisionResult, deadlock) {
  const hand = Array.isArray(cards) ? cards : [];
  const deck = decisionResult && decisionResult.deck && decisionResult.deck.deckRemaining;
  if (!deadlock || deadlock.terminal !== true || deadlock.type !== 'DEADLOCK' ||
      !deck || (decisionResult.actions || []).some(action => action && action.id !== 'M13') ||
      hand.length < 2 || hand.some(row => !row || !row.id || row.id === 'UNKNOWN') ||
      findAllureBanishCandidate(hand) || Number(deck.M06 || 0) + Number(deck.M08 || 0) <= 0) return null;
  const remaining = Object.entries(deck).filter(([id]) => /^M\d+$/.test(id))
    .reduce((sum, [, count]) => sum + Math.max(0, Number(count || 0)), 0);
  if (remaining < 2) return null;
  const allure = hand.find(row => row.id === 'M13');
  if (!allure) return null;
  return {
    id: allure.id, name: allure.name || '暗之诱惑', slot: Number(allure.index) || hand.indexOf(allure) + 1,
    tier: 1000, tierLabel: '最后尝试：暗之诱惑抽安全暗属性',
    reason: `普通抽牌和固定检索/回收都已走不通，牌组仍有${Number(deck.M06 || 0)}张零衣、${Number(deck.M08 || 0)}张兵器；` +
      '最后发动诱惑抽2，优先除外零衣，没有零衣则除外兵器继续；两者都没有才投降。' +
      '没有暗属性时整手送墓，不等待不存在的除外窗口。',
    details: { allureLastResort: true, surrenderIfNoSafeDark: true,
      rayeRemaining: Number(deck.M06 || 0), hampRemaining: Number(deck.M08 || 0) }
  };
}

module.exports = {
  describeAllurePartnerDemand,
  SAFE_BANISH_PRIORITY,
  buildAllureBanishPriority,
  findAllureBanishCandidate,
  describeAllureDecision,
  buildLastResortAllureAction
};
