'use strict';

const {
  EXODIA_UNKNOWN_ID,
  isExodiaComponentCard,
  adjustedMainDeckRemainingCount
} = require('./exodia-policy');
const { buildEngageLegalTargets } = require('./engage-policy');

const IDS = Object.freeze({
  TOON_DRAGON: 'M07',
  TOON_TABLE: 'M10',
  MALLET: 'M11',
  GOLDEN_BAMBOO: 'M14',
  ENGAGE: 'M17',
  YOTO: 'M19',
  TRUE_BAMBOO: 'M20'
});
const DRAW_RESOURCE_IDS = new Set(['M09', 'M12', 'M13', 'M14', 'M15', 'M16', 'M18', 'M21']);

function countById(cards) {
  const out = {};
  for (const card of cards || []) {
    if (!card || !card.id || card.id === 'UNKNOWN') continue;
    out[card.id] = (out[card.id] || 0) + 1;
  }
  return out;
}

function nameOf(deck, id) {
  if (id === EXODIA_UNKNOWN_ID) return '被封印组件';
  return deck && deck.byId && deck.byId[id] ? deck.byId[id].name : id;
}

function mainDeckRemainingCount(deck) {
  return adjustedMainDeckRemainingCount(deck);
}

function buildMalletKeepPolicy(deck, cards, runtimeState = {}) {
  const keep = [];
  const reasons = [];
  const handCounts = deck && deck.handCounts || countById(cards);

  const addKeep = (id, reason) => {
    if (Number(handCounts[id] || 0) <= 0) return;
    if (!keep.includes(id)) keep.push(id);
    if (reason) reasons.push(reason);
  };

  const toonTableRestartReady =
    Number(handCounts[IDS.TOON_TABLE] || 0) > 0 &&
    Number(handCounts[IDS.TOON_DRAGON] || 0) > 0 &&
    Number(deck && deck.deckRemaining && deck.deckRemaining[IDS.TOON_DRAGON] || 0) === 0;

  if (toonTableRestartReady) {
    addKeep(
      IDS.TOON_TABLE,
      '手里同时有卡通目录和青眼卡通龙：保留目录，把白龙留给万宝洗回牌组，使目录重新可检索。'
    );
  }

  const branch = runtimeState && runtimeState.v5Branch || {};
  const carrierId = String(branch.carrierId || '');
  const bambooRestartReady = Boolean(
    carrierId &&
    runtimeState.bambooSwordEquipped !== true &&
    Number(handCounts[IDS.GOLDEN_BAMBOO] || 0) > 0 &&
    Number(handCounts[IDS.YOTO] || 0) > 0 &&
    Number(handCounts[IDS.TRUE_BAMBOO] || 0) > 0 &&
    Number(deck && deck.deckRemaining && deck.deckRemaining[IDS.YOTO] || 0) === 0
  );

  if (bambooRestartReady) {
    addKeep(
      IDS.TRUE_BAMBOO,
      `场上仍有载体${carrierId}，但牌组妖刀为0：保护真刀，把手中妖刀用万宝槌洗回牌组，` +
      '随后由真刀固定从牌组装备妖刀'
    );
    addKeep(
      IDS.GOLDEN_BAMBOO,
      '保护金黄色竹光，等真刀重新贴回妖刀后固定抽2'
    );
  }

  const engageTargets = buildEngageLegalTargets().map(item => item.id);
  const engageDeckRemaining = engageTargets.reduce(
    (sum, id) => sum + Number(deck && deck.deckRemaining && deck.deckRemaining[id] || 0),
    0
  );
  const engageTargetsInHand = engageTargets.filter(id => Number(handCounts[id] || 0) > 0);

  const engageRestartReady = Boolean(
    Number(handCounts[IDS.ENGAGE] || 0) > 0 &&
    engageDeckRemaining === 0 &&
    engageTargetsInHand.length > 0
  );
  if (engageRestartReady) {
    addKeep(
      IDS.ENGAGE,
      `交闪当前无可检索目标；手里压着${engageTargetsInHand.map(id => nameOf(deck, id)).join('/')}` +
      '，保留交闪，把这些目标洗回后再检索。'
    );
  }

  const graveSpellCount = Number(runtimeState && runtimeState.graveSpellCount || 0);
  const engageThirdSpellSetupReady = Boolean(
    graveSpellCount === 2 &&
    Number(handCounts[IDS.MALLET] || 0) > 0 &&
    Number(handCounts[IDS.ENGAGE] || 0) > 0
  );
  const nonMalletNonEngageCards = (cards || []).filter(card =>
    card && card.id !== IDS.MALLET && card.id !== IDS.ENGAGE
  );
  const protectEngageForThirdSpell = Boolean(
    engageThirdSpellSetupReady && nonMalletNonEngageCards.length > 0
  );
  const engageMustReturnToMallet = Boolean(
    engageThirdSpellSetupReady && nonMalletNonEngageCards.length === 0
  );

  if (protectEngageForThirdSpell) {
    addKeep(
      IDS.ENGAGE,
      '墓地已有2张魔法：保护交闪，返回其它手牌；万宝槌结算后自身成为第3张墓地魔法，再发动交闪取得检索并抽1。'
    );
  } else if (engageMustReturnToMallet) {
    reasons.push(
      '墓地已有2张魔法，但手牌只剩交闪与万宝槌；万宝槌至少要返回1张，因此交闪必须作为唯一返回对象，不能虚构“保护交闪且返回0张”。'
    );
  }

  const deckRemaining = mainDeckRemainingCount(deck);
  const exodiaInHand = (cards || []).filter(isExodiaComponentCard);

  // Restore the original narrow endgame exception. Class/count recognition
  // must not turn conditional Mallet protection into permanent hand retention.
  const protectExodiaComponents = deckRemaining <= 5 && exodiaInHand.length >= 4;
  if (protectExodiaComponents) {
    for (const id of [...new Set(exodiaInHand.map(card => card.id))]) addKeep(id, null);
    reasons.push(
      `主卡组估计余量=${deckRemaining}≤5，且手里已有${exodiaInHand.length}个被封印组件：这些组件全部保留（只计类别与数量）。`
    );
  }

  const keepSet = new Set(keep);
  // Only the activated copy leaves the hand. Other Mallets remain selectable,
  // matching the mature executor's slot-based buildRemainingPlan.
  let removedActivatedMallet = false;
  const remainingCards = (cards || []).filter(card => {
    if (!card) return false;
    if (card.id === IDS.MALLET && !removedActivatedMallet) {
      removedActivatedMallet = true;
      return false;
    }
    return true;
  });
  const returnable = remainingCards.filter(card => !keepSet.has(card.id));

  const fixedSearchRestartReady = Boolean(
    toonTableRestartReady || engageRestartReady || bambooRestartReady
  );

  return {
    keepIds: keep,
    keepNames: keep.map(id => nameOf(deck, id)),
    returnableCount: returnable.length,
    returnableIds: returnable.map(card => card.id),
    toonTableRestartReady,
    engageRestartReady,
    engageThirdSpellSetupReady,
    protectEngageForThirdSpell,
    engageMustReturnToMallet,
    bambooRestartReady,
    fixedSearchRestartReady,
    carrierId: carrierId || null,
    deckRemaining,
    exodiaComponentCount: exodiaInHand.length,
    protectExodiaComponents,
    reasons,
    reason: reasons.length
      ? reasons.join('；')
      : '当前没有命中额外保护规则：万宝槌自身以外的手牌全部返回。'
  };
}

// Use the completed legal action pool, not hand membership or grave count
// alone. A first Chicken Game still advances the hand although graveGain=0.
function hasAvailableResourceBeforeMallet(actions = [], runtimeState = {}) {
  if (runtimeState.chickenGameDrawPending === true) return true;
  return actions.some(action => action &&
    action.id !== IDS.MALLET &&
    (action.id !== IDS.ENGAGE || Number(runtimeState.graveSpellCount || 0) >= 3));
}

function malletPriorityForPolicy(malletPolicy, { actions = [], runtimeState = {} } = {}) {

  // A restart is useful only after currently available gains/filter draws are cashed
  // in. Holdings of Raye/HAMP are not a reason to suppress legal Engage: the
  // later Mallet can return those targets. Use the completed legal pool,
  // not mere card membership (blocked Engage/un-equipped Golden stay closed).
  const gainReady =
    actions.some(action => action && action.usable !== false && (
      (action.id === IDS.ENGAGE && Number(runtimeState.graveSpellCount || 0) >= 3 &&
        Number(malletPolicy && malletPolicy.deckRemaining || 0) >= 2 &&
        runtimeState.engageBlockedByMainMonster !== true &&
        (action.details?.searchableTargets || []).length > 0) ||
      (['M19', 'M20'].includes(action.id) && action.details?.enablesGoldenDraw2 === true) ||
      (DRAW_RESOURCE_IDS.has(action.id) && action.details?.protectedToonDragonCost !== true &&
        (action.id !== IDS.GOLDEN_BAMBOO || runtimeState.bambooSwordEquipped === true))
    ));
  if (gainReady) {
    return { tier: 100, tierLabel: 'P100 万宝槌：当前可用赚卡/滤抽先做' };
  }

  if (malletPolicy && malletPolicy.engageThirdSpellSetupReady &&
      !hasAvailableResourceBeforeMallet(actions, runtimeState)) {
    return { tier: 0.5, tierLabel: 'P0.5 万宝槌补足交闪第3张魔法' };
  }
  if (malletPolicy && malletPolicy.bambooRestartReady) {
    return { tier: 1, tierLabel: 'P1 万宝槌重启真刀固定贴妖刀' };
  }
  if (malletPolicy && malletPolicy.toonTableRestartReady) {
    return { tier: 1, tierLabel: 'P1 万宝槌重启卡通目录' };
  }
  return malletPolicy && malletPolicy.engageRestartReady
    ? { tier: 1, tierLabel: 'P1 万宝槌重启交闪固定检索' }
    : { tier: 100, tierLabel: 'P100 万宝槌最后手段' };
}

module.exports = {
  buildMalletKeepPolicy,
  malletPriorityForPolicy,
  hasAvailableResourceBeforeMallet
};
