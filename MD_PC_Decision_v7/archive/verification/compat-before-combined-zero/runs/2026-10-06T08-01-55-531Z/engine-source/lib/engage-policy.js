'use strict';

const TARGETS = Object.freeze({
  RAYE: Object.freeze({ id: 'M06', name: '闪刀姬－零衣' }),
  HAMP: Object.freeze({ id: 'M08', name: '闪术兵器－H.A.M.P.' }),
  HORNET: Object.freeze({ id: 'M22', name: '闪刀机－大黄蜂无人机' }),
  TRADE_IN: 'M12',
  ALLURE: 'M13'
});

function cardName(deck, id) {
  const row = deck && deck.byId && deck.byId[id];
  if (row && row.name) return row.name;
  if (id === TARGETS.RAYE.id) return TARGETS.RAYE.name;
  if (id === TARGETS.HAMP.id) return TARGETS.HAMP.name;
  if (id === TARGETS.HORNET.id) return TARGETS.HORNET.name;
  return id;
}

function knownSpentSingleCopy(deck, state, id) {
  const total = Number(deck && deck.byId && deck.byId[id] && deck.byId[id].count || 0);
  const used = Number(state && state.usedCounts && state.usedCounts[id] || 0);
  return total === 1 && used > 0;
}

function remainingCount(deck, state, id) {
  if (knownSpentSingleCopy(deck, state, id)) return 0;
  return Number(deck && deck.deckRemaining && deck.deckRemaining[id] || 0);
}

function searchableEngageTargets(deck, state = {}) {
  return [TARGETS.HORNET.id, TARGETS.HAMP.id, TARGETS.RAYE.id]
    .map(id => ({
      id,
      name: cardName(deck, id),
      remaining: remainingCount(deck, state, id)
    }))
    .filter(item => item.remaining > 0);
}

function extraDeckMonsterPresent(state = {}) {
  const branch = state && state.v5Branch || {};
  const carrierId = String(branch.carrierId || branch.carrierCardId || '');
  return /^E\d+$/.test(carrierId);
}

function ownMonsterPresent(state = {}) {
  const branch = state.v5Branch || {};
  return Boolean(String(branch.carrierId || branch.carrierCardId || '') ||
    state.rayeNormalSummoned === true || state.engageBlockedByMainMonster === true ||
    ['HORNET_TOKEN_READY', 'POST_E10_HORNET_TOKEN_READY'].includes(branch.currentState));
}

function buildEngageTargetPriority(deck, state = {}) {
  const remaining = id => remainingCount(deck, state, id) > 0;
  const hasInHand = id =>
    Number(deck && deck.handCounts && deck.handCounts[id] || 0) > 0;

  let orderedIds;
  let reason;

  // Empty FIELD (not merely an empty Extra Monster Zone) takes precedence
  // over Allure, held HAMP and the spent-Trade threshold. Secure the token /
  // sword / Kagari entrance before choosing a downstream draw partner.
  if (!ownMonsterPresent(state) && remaining(TARGETS.HORNET.id)) {
    orderedIds = [TARGETS.HORNET.id, TARGETS.HAMP.id, TARGETS.RAYE.id];
    reason = '我方场上没有怪兽且黄蜂仍在牌组：交闪先检索黄蜂，进入衍生物→火刀回收；妖刀可与素材配合送墓。不因手持兵器、诱惑或已用交易覆盖此入口。';
  } else if (remaining(TARGETS.RAYE.id) &&
      (hasInHand(TARGETS.HAMP.id) || Number(state.usedCounts?.[TARGETS.TRADE_IN] || 0) >= 2)) {
    orderedIds = [TARGETS.RAYE.id, TARGETS.HAMP.id, TARGETS.HORNET.id];
    reason = hasInHand(TARGETS.HAMP.id)
      ? '手牌已有H.A.M.P.，不再优先检索重复兵器；优先零衣，保留通招/自身效果/诱惑资源'
      : '抵价交易已发动至少两次，优先检索零衣，不再默认囤积H.A.M.P.';
  } else if (hasInHand(TARGETS.TRADE_IN)) {
    orderedIds = [TARGETS.HAMP.id, TARGETS.RAYE.id, TARGETS.HORNET.id];
    reason = '额外怪兽区已有怪兽；手牌有抵价交易，H.A.M.P.优先形成抽2配合，大黄蜂只作末位备用';
  } else if (hasInHand(TARGETS.ALLURE) && hasInHand(TARGETS.RAYE.id)) {
    orderedIds = [TARGETS.HAMP.id, TARGETS.RAYE.id, TARGETS.HORNET.id];
    reason =
      '手牌已有零衣可配合暗之诱惑，不再检索重复零衣，优先检索H.A.M.P.；' +
      '大黄蜂会卡住后续交闪，只作末位备用';
  } else if (hasInHand(TARGETS.ALLURE)) {
    orderedIds = [TARGETS.RAYE.id, TARGETS.HAMP.id, TARGETS.HORNET.id];
    reason = '手牌有暗之诱惑且没有零衣，零衣优先形成抽2配合；大黄蜂只作末位备用';
  } else {
    orderedIds = [TARGETS.HAMP.id, TARGETS.RAYE.id, TARGETS.HORNET.id];
    reason = '默认优先H.A.M.P.，其次零衣；大黄蜂会卡住后续交闪，只在其它目标均不在牌组时备用';
  }

  return {
    targets: orderedIds
      .filter(remaining)
      .map(id => ({ id, name: cardName(deck, id) })),
    reason
  };
}

function chooseEngageTarget(deck, state = {}) {
  const priority = buildEngageTargetPriority(deck, state);
  const target = priority.targets[0];
  return target ? { ...target, reason: priority.reason } : null;
}

function buildEngageLegalTargets() {
  return [
    { ...TARGETS.RAYE },
    { ...TARGETS.HAMP },
    { ...TARGETS.HORNET }
  ];
}

module.exports = {
  knownSpentSingleCopy,
  searchableEngageTargets,
  extraDeckMonsterPresent,
  ownMonsterPresent,
  buildEngageTargetPriority,
  chooseEngageTarget,
  buildEngageLegalTargets
};
