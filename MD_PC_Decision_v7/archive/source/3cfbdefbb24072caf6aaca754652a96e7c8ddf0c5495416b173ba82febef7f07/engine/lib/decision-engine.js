/**
 * Master Duel FTK 魔法决策层 v12
 *
 * 本版只负责：
 *   1. 根据真实扫描到的手牌与黄框过滤“当前可操作魔法”；
 *   2. 结合牌组剩余数量与少量局面状态排序；
 *   3. 输出下一张建议使用的牌；
 *   4. 绝不自动发动。
 *
 * 已按当前讨论确认的规则实现：
 *   - 固定检索层：卡通目录等能够确定取得特定卡片的动作位于最高层；
 *                 有目录则优先连续检索目录，最后检索青眼卡通龙。
 *   - 大黄蜂限制：仅在额外怪兽区为空且路线确有后续收益时考虑；额外怪兽区已有怪兽时硬性保留，避免衍生物占用主怪兽区卡住交闪。
 *   - 墓地魔法>=3：交闪虽然可固定检索，但附带随机抽1，因此低于纯固定检索层；
 *                  仍高于后面的普通随机抽牌。交闪检索大黄蜂仅为其它合法目标耗尽后的末位备用。
 *   - 普通动作：抵价交易 / 无之炼狱 / 金黄色竹光 /
 *               愚蠢的重葬 / 试胆竞速 / 暴发户哥布林。
 *   - 墓地魔法<3：同级动作中，优先正常结算后能自然增加墓地魔法数的动作；
 *                  不会为了凑3而主动使用妖刀/真刀等装备魔法。
 *   - 暂时休战：低优先级，所有安全的普通抽1/抽2/2换2与确定资源路线之后才考虑；
 *               但高于“只能丢未完成目录链白龙”的抵价交易、未满3魔法交闪和万宝槌。
 *   - 交闪<3：尽量保留；普通滤抽与暂时休战都走不动后才作为保底检索动作。
 *   - 暗之诱惑：固定检索/回收及其它可用抽牌之后、万宝槌之前；优先除外零衣，其次H.A.M.P.，不消耗组件。
 *   - 万宝槌：普通兜底位于可用诱惑之后；仅目录/交闪/真刀的明确固定组合成立时，
 *             保护发动端和确定收益牌、洗回目标，重新建立固定检索/装备链。
 *             但当前已有合法赚卡/滤抽时先兑现，再按新手牌重算洗牌；不因已持零衣/兵器保留可用交闪。
 *
 * 仍未定义、因此本版不会擅自决定：
 *   - 愚蠢的重葬具体送墓目标；
 *   - 竹光装备/怪兽区/大黄蜂的复杂联动；
 *   - 复杂Link路线由V5操作层处理；本文件只负责顶层手牌动作与万宝槌保护集合。
 */

// PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_DECISION
const { getSharedDeckState } = require('./main-deck-ledger');
const { goldenFromLegacy } = require('../../src/integration/legacy-capabilities');
const { buildTrueBambooGainAction, planTrueBambooGain } = require('./true-bamboo-gain-policy');
const { planGoldenBambooSetup } = require('./golden-bamboo-setup-policy');
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');
const { buildTradeInCostPolicy } = require('./trade-in-policy');
const { chooseToonTableTarget } = require('./toon-table-policy');
const { describeAllureDecision } = require('./allure-policy');
const { summarizeBambooEquipResources, planEquippedBambooContinuation,
  planTrueBambooConversionSetup } = require('./yoto-search-value');
const {
  searchableEngageTargets,
  extraDeckMonsterPresent,
  buildEngageTargetPriority,
  chooseEngageTarget
} = require('./engage-policy');
const {
  buildMalletKeepPolicy,
  malletPriorityForPolicy,
  hasAvailableResourceBeforeMallet
} = require('./mallet-policy');
const IDS = {
  RAYE: 'M06',
  TOON_DRAGON: 'M07',
  HAMP: 'M08',
  UPSTART: 'M09',
  TOON_TABLE: 'M10',
  MALLET: 'M11',
  TRADE_IN: 'M12',
  ALLURE: 'M13',
  GOLDEN_BAMBOO: 'M14',
  INTO_VOID: 'M15',
  ONE_DAY: 'M16',
  ENGAGE: 'M17',
  FOOLISH_GOODS: 'M18',
  CURSED_BAMBOO: 'M19',
  TRUE_BAMBOO: 'M20',
  CHICKEN_GAME: 'M21',
  HORNET: 'M22'
};

const SPELL_IDS = new Set([
  IDS.UPSTART,
  IDS.TOON_TABLE,
  IDS.MALLET,
  IDS.TRADE_IN,
  IDS.ALLURE,
  IDS.GOLDEN_BAMBOO,
  IDS.INTO_VOID,
  IDS.ONE_DAY,
  IDS.ENGAGE,
  IDS.FOOLISH_GOODS,
  IDS.CURSED_BAMBOO,
  IDS.TRUE_BAMBOO,
  IDS.CHICKEN_GAME,
  IDS.HORNET
]);

function countById(cards) {
  const out = {};
  for (const c of cards || []) {
    if (!c || !c.id || c.id === 'UNKNOWN') continue;
    out[c.id] = (out[c.id] || 0) + 1;
  }
  return out;
}

function makeCardMeta(library) {
  const byId = {};
  for (const c of library.cards || []) byId[c.id] = c;
  return byId;
}

function buildDeckState(library, cards, runtimeState) {
  // PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_DECISION: one authoritative deck ledger for every search/decision.
  const handCounts = countById(cards);
  const usedCounts = Object.assign({}, runtimeState && runtimeState.usedCounts || {});
  const byId = makeCardMeta(library);
  const shared = getSharedDeckState(library, cards, runtimeState || {});

  return {
    handCounts,
    usedCounts,
    deckRemaining: shared.deckRemaining,
    outsideDeckCounts: shared.outsideDeckCounts,
    unknownExodiaOutsideCount: shared.unknownExodiaOutsideCount,
    mainDeckLedger: shared.ledger,
    bambooEquipResources: summarizeBambooEquipResources(shared.deckRemaining, cards, { runtime: runtimeState, byId }),
    byId
  };
}

function nameOf(deck, id) {
  return deck.byId[id] ? deck.byId[id].name : id;
}

function spellCardIsUsable(card) {
  if (!card || !SPELL_IDS.has(card.id)) return false;
  if (card.usable === true) return true;
  // Exact right-log gains intentionally avoid clicking a newly drawn card, so
  // they may carry no yellow-frame `usable` sample.  Only M11 is admitted here:
  // its mature executor re-locates the current physical slot, re-proves M11 and
  // its activation button before any irreversible input.  This lets a freshly
  // drawn Mallet immediately repair a stranded deterministic search/equip chain
  // without weakening usability rules for other Spells.
  return card.id === IDS.MALLET && card.rightLogCertain === true;
}

function toonTableTarget(deck) {
  const target = chooseToonTableTarget(deck && deck.deckRemaining || {});
  if (!target) return null;
  return {
    ...target,
    name: nameOf(deck, target.id) || target.name
  };
}

function mainDeckRemainingCount(deck) {
  return adjustedMainDeckRemainingCount(deck);
}

function normalSpellGraveGain(id, runtimeState) {
  // 这里只统计“本张正常执行后，至少能确认自然进入墓地的魔法数”。
  // 不擅自把愚蠢的重葬送墓目标额外计入，因为目标规则还没讨论。
  if (id === IDS.CHICKEN_GAME) {
    // 第一张场地留场；若场上已有试胆竞速，再发动一张会把旧场地送墓。
    return runtimeState.fieldSpell === IDS.CHICKEN_GAME ? 1 : 0;
  }

  if (id === IDS.CURSED_BAMBOO || id === IDS.TRUE_BAMBOO || id === IDS.HORNET) {
    // 装备/速攻等复杂场面牌当前不用于“为了凑三魔法”的普通动作池。
    return 0;
  }

  // 普通魔法正常结算后通常会进墓；当前只对本决策池使用。
  return 1;
}

function hornetBlockedByExtraDeckMonster(state = {}) {
  return extraDeckMonsterPresent(state);
}

function makeAction(card, tier, label, extra) {
  return Object.assign({
    slot: card.index,
    x: card.x,
    y: card.y,
    id: card.id,
    name: card.name,
    tier,
    tierLabel: label,
    usable: card.usable === true,
    graveGain: 0,
    reason: '',
    details: {}
  }, extra || {});
}

function collectActions(cards, library, runtimeState) {
  const state = Object.assign({
    graveSpellCount: 0,
    fieldSpell: null,
    bambooSwordEquipped: false,
    usedCounts: {}
  }, runtimeState || {});

  const deck = buildDeckState(library, cards, state);
  const actions = [];
  const holds = [];
  const deckCardCount = mainDeckRemainingCount(deck);

  for (const card of cards) {
    if (!spellCardIsUsable(card)) continue;

    // P0：卡通目录，任何时候绝对最高。
    if (card.id === IDS.TOON_TABLE) {
      const target = toonTableTarget(deck);
      if (target) {
        actions.push(makeAction(card, 0, 'P0 卡通目录绝对优先', {
          graveGain: 1,
          reason: `卡通目录永远最高优先级；${target.reason}`,
          details: { searchTarget: target }
        }));
      } else {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '卡通目录虽然显示可用，但按当前已知牌组状态已没有目录/青眼卡通龙可检索，暂不自动选择。'
        });
      }
      continue;
    }

    // P1：墓地三魔法后的交闪。
    if (card.id === IDS.ENGAGE) {
      const postE10HornetBambooDraw2 = Boolean(
        state && state.v5Branch && state.v5Branch.postE10HornetBambooDraw2 === true
      );
      const engageBlockedByMainMonster = state && state.engageBlockedByMainMonster === true;
      if (postE10HornetBambooDraw2 || engageBlockedByMainMonster) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '零梦后的黄蜂路线已经占用主怪兽区；交闪本局当前必定不能发动，只保留在手，不参与推荐。'
        });
        continue;
      }
      const targets = searchableEngageTargets(deck, state);
      const searchTarget = chooseEngageTarget(deck, state);
      if (!targets.length) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '交闪当前没有已知可检索目标（零衣/H.A.M.P./大黄蜂均不在牌组）。'
        });
      } else if (state.graveSpellCount >= 3) {
        actions.push(makeAction(card, 1, 'P1 三魔法交闪', {
          graveGain: 1,
          reason: `墓地魔法=${state.graveSpellCount}，已满足三魔法；交闪可检索并获得额外抽牌。若当前没有“大黄蜂→篝回收交闪→竹光”等更确定的资源链，则优先处理交闪。`,
          details: { searchableTargets: targets, searchTarget }
        }));
      } else {
        // “尽量”保留，而非永远禁止：常规滤抽以后才使用，但仍早于暂时休战/万宝槌。
        actions.push(makeAction(card, 94, 'P94 未满三魔法的交闪（保留到暂时休战之后）', {
          graveGain: 1,
          reason: `墓地魔法=${state.graveSpellCount}<3，尽量保留交闪等待追加抽1；普通滤抽与暂时休战都走不动后，才把无追加抽1的交闪作为保底检索。`,
          details: { searchableTargets: targets, searchTarget }
        }));
      }
      continue;
    }

    // P3：抽2。用户规则：任何抽1动作都排在抽2之前。
    if (card.id === IDS.TRADE_IN) {
      if (deckCardCount < 2) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: `牌组仅剩${deckCardCount}张，无法合法结算抽2；本动作已硬性屏蔽。`
        });
        continue;
      }
      const tradeInPolicy = buildTradeInCostPolicy({
        handCounts: deck.handCounts,
        usedCounts: state.usedCounts || {}
      });
      const toonTablesInGrave = tradeInPolicy.toonTablesInGrave;
      const cost = tradeInPolicy.plannedCost;

      // The decision layer and the physical M12 executor consume the same
      // shared cost policy.  This prevents the Toon-Dragon protection rule from
      // drifting between recommendation and the live cost-selection prompt.
      if (cost) {
        const toonDragonStillProtected = tradeInPolicy.toonDragonStillProtected;

        const policyReason = toonTablesInGrave < 3
          ? (
              cost.id === IDS.HAMP
                ? `卡通目录入墓=${toonTablesInGrave}/3；目录链尚未完成，本轮用H.A.M.P.支付并保护青眼卡通龙`
                : `卡通目录入墓=${toonTablesInGrave}/3；当前只能用青眼卡通龙支付，但白龙仍是未完成目录链的重要检索目标`
            )
          : '3张卡通目录均已进墓，青眼卡通龙可以正常作为抵价交易费用';

        // If Toon Dragon is the only current Trade-In cost while the Toon Table
        // chain is not exhausted, do not burn that deterministic search target
        // before One Day of Peace.  This is the specific live rule confirmed on
        // 2026-09-11: protected-Blue-Eyes Trade-In < One Day, but still > Mallet.
        const tier = toonDragonStillProtected ? 95 : 3;
        const tierLabel = toonDragonStillProtected
          ? 'P95 抵价交易+受保护白龙（低于暂时休战）'
          : 'P3 抽2';

        actions.push(makeAction(card, tier, tierLabel, {
          graveGain: normalSpellGraveGain(card.id, state),
          reason: toonDragonStillProtected
            ? `抵价交易当前只能丢青眼卡通龙；${policyReason}。按当前规则先发动暂时休战等安全资源，避免把尚可被卡通目录固定检索的白龙提前送墓；本动作仅高于万宝槌。`
            : `抵价交易为抽2，排在所有普通抽1之后；${policyReason}；本轮费用=${cost.name}。`,
          details: {
            discardTarget: cost,
            toonTablesInGrave,
            protectedToonDragonCost: toonDragonStillProtected
          }
        }));
      } else {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '当前手牌未识别到青眼卡通龙或H.A.M.P.作为8星代价，暂不自动选择。'
        });
      }
      continue;
    }

    if (card.id === IDS.ALLURE) {
      if (deckCardCount < 2) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: `牌组仅剩${deckCardCount}张，无法合法结算抽2；本动作已硬性屏蔽。`
        });
        continue;
      }

      const allurePolicy = describeAllureDecision(
        deck.handCounts || {},
        state.usedCounts || {}
      );

      if (allurePolicy.allowed && allurePolicy.target) {
        actions.push(makeAction(card, allurePolicy.tier, allurePolicy.tierLabel, {
          graveGain: normalSpellGraveGain(card.id, state),
          reason: allurePolicy.reason,
          details: {
            banishTarget: {
              id: allurePolicy.target.id,
              name: nameOf(deck, allurePolicy.target.id) || allurePolicy.target.name
            },
            tradeInUsed: allurePolicy.tradeInUsed,
            protectHampForFutureTradeIn: allurePolicy.protectHampForFutureTradeIn
          }
        }));
      } else {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: allurePolicy.reason
        });
      }
      continue;
    }

    if (card.id === IDS.GOLDEN_BAMBOO) {
      const goldenCapability = goldenFromLegacy(cards, deck, state);
      if (goldenCapability.reason === 'MAIN_DECK_FEWER_THAN_TWO') {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: `牌组仅剩${deckCardCount}张，无法合法结算抽2；本动作已硬性屏蔽。`
        });
      } else if (goldenCapability.status === 'READY') {
        actions.push(makeAction(card, 3, 'P3 抽2', {
          graveGain: normalSpellGraveGain(card.id, state),
          reason: '金黄色的竹光为抽2；场上已有竹光装备，但按规则排在所有抽1之后。',
          details: { bambooSwordEquipped: true, goldenCapability }
        }));
      } else {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '尚未记录场上有竹光装备；为避免误判黄框，本版暂不自动使用金黄色的竹光。'
        });
      }
      continue;
    }

    if (
      card.id === IDS.INTO_VOID ||
      card.id === IDS.FOOLISH_GOODS ||
      card.id === IDS.CHICKEN_GAME ||
      card.id === IDS.UPSTART
    ) {
      if (deckCardCount < 1) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '牌组已空，无法结算抽1；本动作已硬性屏蔽。'
        });
        continue;
      }
      const extra = {};
      if (card.id === IDS.CHICKEN_GAME) {
        extra.fieldSpellAlreadyChicken = state.fieldSpell === IDS.CHICKEN_GAME;
      }

      actions.push(makeAction(card, 2, 'P2 抽1优先', {
        graveGain: normalSpellGraveGain(card.id, state),
        reason: card.id === IDS.CHICKEN_GAME
          ? (state.fieldSpell === IDS.CHICKEN_GAME
              ? '试胆竞速可用；场上已记录有试胆竞速，本次替换会让旧场地进入墓地。'
              : '试胆竞速可用；当前未记录旧试胆竞速，发动后新场地留场，本次本身不直接增加墓地魔法。')
          : `${card.name}属于抽1动作；按当前规则优先于所有抽2。`,
        details: extra
      }));
      continue;
    }


    // P0.5 / P6：大黄蜂。额外怪兽区必须为空；否则它只会占用
    // 主怪兽区并卡住交闪，既不进入普通动作池，也不进入旧固定链。
    // 已经用过交闪且墓地魔法>=3时，大黄蜂不是普通展开，而是确定资源链：
    // 大黄蜂 -> 衍生物 -> 篝 -> 回收墓地交闪；若手里还有妖刀/真刀，
    // 后续操作层再继续竹光固定检索。这个确定资源必须先于“再次发动交闪+随机抽1”。
    if (card.id === IDS.HORNET) {
      if (hornetBlockedByExtraDeckMonster(state)) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason:
            `额外怪兽区已有${state.v5Branch.carrierId}；此时发动大黄蜂只会生成主怪兽区衍生物并卡住后续交闪，` +
            '不把它当作资源动作。'
        });
        continue;
      }
      const engageInGrave = Number(state.usedCounts && state.usedCounts[IDS.ENGAGE] || 0) > 0;
      const hasYoto = (deck.handCounts[IDS.CURSED_BAMBOO] || 0) > 0;
      const hasTrue = (deck.handCounts[IDS.TRUE_BAMBOO] || 0) > 0;
      const hasGolden = (deck.handCounts[IDS.GOLDEN_BAMBOO] || 0) > 0;
      const yotoInDeck = Number(deck.deckRemaining && deck.deckRemaining[IDS.CURSED_BAMBOO] || 0) > 0;
      const branchState = String(state && state.v5Branch && state.v5Branch.currentState || '');
      const postE10 = branchState === 'E10_EFFECT_RESOLVED';
      const canCloseSwordLink = hasYoto || (hasTrue && yotoInDeck);
      const postE10BambooDraw2Ready = postE10 && canCloseSwordLink && hasGolden;

      // Confirmed rule (2026-09-11):
      // Hornet is NOT a standalone value action in this FTK policy.
      // If Engage is not actually in our tracked GY, do not recommend Hornet at all.
      // The point of Hornet here is to create the token -> Kagari -> recover Engage line.
      if (!engageInGrave && !postE10BambooDraw2Ready) {
        continue;
      }

      // Post-E10 remains a special blocked-board case: E10 already occupies a
      // Main Monster Zone, so Hornet needs the complete Bamboo draw-2 escape
      // route.  In the ordinary state, however, Hornet -> token -> Kagari ->
      // recover Engage is already a deterministic closed resource chain.  An
      // equip Bamboo extends that chain but must never gate its entrance.
      if (postE10 && (!canCloseSwordLink || !hasGolden)) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason:
            '零梦仍在场；黄蜂会永久卡住交闪。手里必须同时有妖刀/真刀和金竹光，才能改走刀的抽2链；当前条件不完整，因此完全不推荐黄蜂。'
        });
        continue;
      }

      if (postE10BambooDraw2Ready) {
        actions.push(makeAction(card, 0.5, 'P0.5 零梦后黄蜂竹光抽2链', {
          graveGain: 0,
          reason:
            '零梦在场后黄蜂会卡死交闪，因此不计算任何交闪回收收益。' +
            `当前手里有${hasYoto ? '妖刀' : '真刀'}和金竹光：黄蜂出衍生物后先把装备刀给衍生物，` +
            '先利用仍在场的装备刀发动金竹光抽2；随后再让该衍生物单素材Link风刀并触发妖刀检索。',
          details: {
            fixedResourceChain: true,
            postE10BambooDraw2: true,
            equipFromHand: hasYoto ? IDS.CURSED_BAMBOO : IDS.TRUE_BAMBOO,
            goldenBambooInHand: true,
            recoverTarget: null
          }
        }));
        continue;
      }

      const fixedRecoveryReady = Number(state.graveSpellCount || 0) >= 3;

      if (fixedRecoveryReady) {
        const swordTail = canCloseSwordLink
          ? `；回收交闪后手里还有${hasYoto ? '妖刀' : '真刀'}，继续已验证竹光路线再拿一次固定检索`
          : '';
        actions.push(makeAction(card, 0.5, 'P0.5 大黄蜂固定资源链', {
          graveGain: 0,
          reason:
            `墓地魔法=${state.graveSpellCount}且墓地已有本回合用过的交闪；` +
            `先发动大黄蜂，固定走“衍生物→篝→回收交闪”${swordTail}。` +
            '固定资源先拿到手，再处理会产生随机追加抽牌的交闪。',
          details: {
            fixedResourceChain: true,
            recoverTarget: IDS.ENGAGE,
            bambooFollowUp: canCloseSwordLink
              ? (hasYoto ? IDS.CURSED_BAMBOO : IDS.TRUE_BAMBOO)
              : null
          }
        }));
      } else {
        actions.push(makeAction(card, 6, 'P6 大黄蜂回收交闪路线', {
          graveGain: 0,
          reason:
            `墓地已有交闪但当前墓地魔法=${state.graveSpellCount}<3；` +
            '大黄蜂只用于“衍生物→篝→回收交闪”这条确定路线，不再作为无交闪时的独立展开。'
        }));
      }
      continue;
    }

    // P90：暂时休战。虽然也是抽1，但不进入普通抽1池；安全的普通滤抽/确定资源先做。
    // 特殊例外：如果抵价交易只能牺牲仍需被目录检索的白龙，或交闪尚未满3魔法，
    // 则先休战，保留这些确定资源。
    if (card.id === IDS.ONE_DAY) {
      if (deckCardCount < 1) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '牌组已空，无法结算抽1；本动作已硬性屏蔽。'
        });
      } else {
        actions.push(makeAction(card, 90, 'P90 暂时休战低优先级', {
          graveGain: normalSpellGraveGain(card.id, state),
          reason: '暂时休战优先级很低：安全的普通抽1、正常抽2/2换2和确定资源路线先做；但如果抵价交易只能牺牲未完成目录链的青眼卡通龙，或交闪尚未满3魔法，则先休战保留这些资源。'
        }));
      }
      continue;
    }

    // P100 normally: Mallet is the last resort.  The explicit exception is a
    // stranded Toon Table plus Toon Dragon in hand: keep Table, shuffle Dragon
    // back, then Table regains a deterministic target.  That conversion must
    // precede a protected-Dragon Trade-In which would destroy the same target.
    if (card.id === IDS.MALLET) {
      const mallet = buildMalletKeepPolicy(deck, cards, state);
      if (mallet.returnableCount > 0) {
        const { tier, tierLabel } = malletPriorityForPolicy(mallet);
        actions.push(makeAction(card, tier, tierLabel, {
          graveGain: 1,
          reason: mallet.fixedSearchRestartReady
            ? `当前固定检索/固定装备链的目标被卡在手中；${mallet.reason}` +
              '万宝槌先把目标送回牌组，同时保护发动端与确定收益牌，使固定链重新可用。'
            : mallet.engageThirdSpellSetupReady
              ? mallet.reason
            : `万宝槌是保护性兜底：先完成其它可用抽牌（包括有安全除外目标的诱惑）及检索/回收；${mallet.reason}`,
          details: { mallet }
        }));
      } else {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '按当前万宝槌保护规则，除万宝槌自身外没有可返回的手牌，因此不建议发动。'
        });
      }
      continue;
    }

    // 妖刀/真刀等当前不进入“只考虑魔法”的简单决策池。
    holds.push({
      slot: card.index,
      id: card.id,
      name: card.name,
      reason: '该牌属于尚未完成的竹光/闪刀场面联动，本版只识别状态，不自动排入简单魔法决策。'
    });
  }

  // The third-Spell Mallet exception requires no other available ordinary
  // resource. Check after collecting every legal action: hand order
  // must not let an early Mallet hide a later Into the Void or Chicken Game.
  for (const action of actions.filter(row => row.id === IDS.MALLET)) {
    const priority = malletPriorityForPolicy(action.details.mallet, { actions, runtimeState: state });
    if (priority.tier === 100 && actions.some(row => row.id === IDS.ALLURE && row.details.banishTarget)) {
      action.details.malletDeferredForSafeAllure = true;
      action.reason = `当前有安全除外目标的暗之诱惑可执行，先发诱惑；万宝槌保留作保护性兜底。${action.details.mallet.reason}`;
    }
    if (priority.tier === 100 && action.tier < 100) {
      action.details.malletDeferredForOtherResources = true;
      action.reason = '当前仍有其它可执行的抽牌/检索资源，先完成这些动作，万宝槌靠后。' + action.reason;
    }
    Object.assign(action, priority);
  }

  // 排序规则：
  // 1. tier越小越优先；
  // 2. P2普通抽1早于P3抽2/2换2；暂时休战被单独放到P90，不参与普通抽1。
  // 3. 墓地<3时，同为普通抽1的P2里优先自然增加墓地魔法的动作；其余按手牌从左到右。
  // 4. P99可用诱惑在P100普通兜底万宝槌之前；固定链重启也要等当前合法赚卡/滤抽耗尽。
  //    补交闪第3魔法的特例仅在没有其它可推进的普通动作时提升优先级。
  // With Chicken Game available, defer Burial within ordinary draw1. This
  // keeps a total ordering and preserves fixed searches and every other tier.
  const chickenAvailable = actions.some(action => action.id === IDS.CHICKEN_GAME && action.tier === 2);
  actions.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 2 && chickenAvailable) {
      const burialRank = action => action.id === IDS.FOOLISH_GOODS ? 1 : 0;
      if (burialRank(a) !== burialRank(b)) return burialRank(a) - burialRank(b);
    }

    if (a.tier === 2 && state.graveSpellCount < 3 && a.graveGain !== b.graveGain) {
      return b.graveGain - a.graveGain;
    }

    return a.slot - b.slot;
  });

  return {
    state,
    deck,
    actions,
    holds,
    selected: actions.length ? actions[0] : null,
    engageTargets: searchableEngageTargets(deck, state)
  };
}

function formatRemaining(deck, ids) {
  return ids.map(id => `${nameOf(deck, id)}=${deck.deckRemaining[id] || 0}`).join(', ');
}

function printDecision(result) {
  const s = result.state;
  const d = result.deck;

  console.log('\n============================================================');
  console.log('v12 魔法决策测试（只输出，不发动）');
  console.log('============================================================');
  console.log(`墓地魔法数: ${s.graveSpellCount}`);
  console.log(`当前场地记录: ${s.fieldSpell ? nameOf(d, s.fieldSpell) : '无/未记录'}`);
  console.log('闪刀可检索牌组剩余: ' + formatRemaining(d, [IDS.RAYE, IDS.HAMP, IDS.HORNET]));
  console.log('目录链关键牌组剩余: ' + formatRemaining(d, [IDS.TOON_TABLE, IDS.TOON_DRAGON]));

  console.log('\n候选动作（已先过滤魔法黄框与组合条件）：');
  if (!result.actions.length) {
    console.log('  无');
  } else {
    for (let i = 0; i < result.actions.length; i++) {
      const a = result.actions[i];
      const gainText = s.graveSpellCount < 3 ? `  预计自然堆墓+${a.graveGain}` : '';
      console.log(`  ${i + 1}. ${a.tierLabel} | 手牌${a.slot} ${a.name}${gainText}`);
      console.log(`     原因: ${a.reason}`);

      if (a.details.searchTarget) {
        console.log(`     目录检索目标: ${a.details.searchTarget.name}`);
      }
      if (a.details.searchableTargets) {
        console.log('     交闪可检索: ' + a.details.searchableTargets.map(x => `${x.name}×${x.remaining}`).join(' / '));
        if (a.details.searchTarget) console.log(`     交闪目标建议: ${a.details.searchTarget.name}`);
      }
      if (a.details.discardTarget) {
        console.log(`     抵价交易代价: ${a.details.discardTarget.name}`);
      }
      if (a.details.banishTarget) {
        console.log(`     暗之诱惑除外: ${a.details.banishTarget.name}`);
      }
      if (a.details.note) {
        console.log(`     备注: ${a.details.note}`);
      }
      if (a.details.mallet) {
        console.log(`     万宝保护: ${a.details.mallet.keepNames.join(' / ') || '无'}；预计返回=${a.details.mallet.returnableCount}张`);
      }
    }
  }

  if (result.holds.length) {
    console.log('\n当前黄框牌中被战略层暂缓/不自动处理的牌：');
    for (const h of result.holds) {
      console.log(`  - 手牌${h.slot} ${h.name}: ${h.reason}`);
    }
  }

  console.log('\n------------------------------------------------------------');
  if (result.selected) {
    console.log(`>>> 程序决定下一张应该使用：手牌${result.selected.slot} ${result.selected.name} [${result.selected.id}]`);
    console.log(`>>> 原因：${result.selected.reason}`);
  } else {
    console.log('>>> 当前没有本版能够安全自动决定的魔法动作。');
  }
  console.log('>>> v11只做决策测试，不会发动这张牌。');
  console.log('============================================================');
}


// PATCH_V5_ATOMIC_BAMBOO_POLICY_V1
function v5FindHandCard(cards, id) {
  const list = Array.isArray(cards) ? cards : [];
  for (let i = 0; i < list.length; i++) {
    const card = list[i];
    if (card && card.id === id) {
      return { ...card, index: Number.isInteger(card.index) ? card.index : i + 1 };
    }
  }
  return null;
}

function v5AtomicBambooAction(card, state, reason, phase) {
  return {
    slot: card.index,
    x: card.x,
    y: card.y,
    id: card.id,
    name: card.name,
    tier: -1,
    tierLabel: 'P-1 已验证竹光资源链',
    usable: true,
    graveGain: 0,
    reason,
    details: {
      v5AtomicBranchPreference: true,
      phase,
      branchState: state && state.v5Branch ? state.v5Branch.currentState : null
    }
  };
}

function collectActionsV5AtomicBambooPolicy(cards, library, runtimeState) {
  const result = collectActions(cards, library, runtimeState);
  const state = runtimeState || result.state || {};
  const branchState = state && state.v5Branch ? String(state.v5Branch.currentState || '') : '';
  const yotoInDeck = Number(
    result && result.deck && result.deck.deckRemaining && result.deck.deckRemaining.M19 || 0
  ) > 0;
  const trueSwordInDeck = Number(
    result && result.deck && result.deck.deckRemaining && result.deck.deckRemaining.M20 || 0
  ) > 0;

  const preserveKagariEntrance = Boolean(planTrueBambooGain(cards, state, result.deck));

  let preferred = null;
  let reason = '';
  let phase = null;

  // Constructible Golden stays P3 at ANY completed carrier node, except a
  // proven fixed search+replacement chain still belongs to the fixed layer.
  const goldenSetup = planGoldenBambooSetup(cards, state, result.deck);
  const trueConversion = planTrueBambooConversionSetup(cards, state, result.deck);
  if (goldenSetup?.sword.id === 'M19' && !goldenSetup.fixedContinuationReady && !trueConversion) return result;

  const bambooPlan = planEquippedBambooContinuation(result.deck.deckRemaining, cards,
    { runtime: state, byId: result.deck.byId, deck: result.deck });
  if (bambooPlan.firstTrueGoldenSetup && bambooPlan.carrierId &&
      !['HORNET_TOKEN_READY', 'POST_E10_HORNET_TOKEN_READY'].includes(branchState) &&
      !(result.selected && result.selected.id === IDS.TOON_TABLE)) {
    preferred = v5FindHandCard(cards, 'M20');
    phase = 'FIRST_TRUE_GOLDEN_FIXED_EQUIP';
    reason = '首次遇到装备是手牌真刀＋金竹光，妖刀仍全部在牌组。先真刀装备现有载体，再固定换装牌组妖刀；换装结算后回到普通决策，仍先处理交闪等固定检索，再考虑金竹光抽2，不把换装与抽牌绑成连续动作。';
  } else if (branchState === 'RAYE_NORMAL_SUMMONED') {
    const yoto = v5FindHandCard(cards, 'M19');
    const trueSword = v5FindHandCard(cards, 'M20');
    const preparation = planEquippedBambooContinuation(result.deck.deckRemaining, cards,
      { runtime: state, byId: result.deck.byId, deck: result.deck });
    if (preparation.prepareEquipId === 'M19') {
      preferred = yoto;
      phase = 'RAYE_YOTO_BEFORE_DIRECT_E10_DUAL_SEARCH';
      reason = '零衣已经通常召唤；先把手牌妖刀装备给零衣，再由零衣自身效果直出零梦，进入妖刀CL1、零梦CL2的双效果池。妖刀仍有合法竹光检索目标即可，不要求金竹光已在手，也不要求备用装备；零梦不能再作为Link素材，不能到零梦场上才贴刀准备送墓。';
    } else if (preparation.prepareEquipId === 'M20') {
      preferred = trueSword;
      phase = 'RAYE_LAST_CARRIER_TRUE_BEFORE_EFFECT';
      reason = '零衣已经通常召唤且是当前最后的装备载体；一旦先发动零衣自身效果，本回合将失去把竹光送墓并触发检索的机会。先把真刀装备给零衣，再由真刀从牌组装备妖刀，最后才发动零衣效果进入妖刀CL1、零梦CL2。';
    }
  } else if (branchState === 'KAGARI_RECOVERY_DONE' &&
    !(result.selected && result.selected.id === IDS.TOON_TABLE)) {
    const yoto = v5FindHandCard(cards, 'M19');
    const trueSword = v5FindHandCard(cards, 'M20');
    if (shouldPreferPostKagariYoto({ yoto, trueSwordInDeck })) {
      preferred = yoto;
      phase = 'POST_KAGARI_RECOVERY_YOTO_FIRST';
      reason = '篝已经把交闪回收到手；当前手牌有妖刀且牌组仍有真刀。先把这张妖刀装备给当前篝，再 Link 非火刀把妖刀送墓，随后用妖刀检索真刀。此路线不要求牌组还剩另一张妖刀，此时不先发动交闪。';
    } else if (trueSword && yotoInDeck) {
      preferred = trueSword;
      phase = 'POST_KAGARI_RECOVERY_TRUE_FIRST';
      reason = '篝已经把交闪回收到手；当前有真刀且牌组仍有妖刀。先把真刀装备给当前篝，后续按 T20 原子节点从牌组装备妖刀，再进入妖刀 carrier 节点。此时不先发动交闪。';
    }
  } else if (branchState === 'YOTO_SEARCH_DONE') {
    const reservedYoto = v5FindHandCard(cards, 'M19');
    const golden = v5FindHandCard(cards, 'M14');
    const trueSword = v5FindHandCard(cards, 'M20');
    const carrierId = String(state && state.v5Branch && state.v5Branch.carrierId || '');
    // Evaluate AFTER consuming this copy so immediate Golden draw readiness
    // cannot count the searched-away Yoto as its own spare. A legal fixed
    // Golden search remains valuable even when its draw must be deferred.
    const afterYotoEquip = (Array.isArray(cards) ? cards : []).filter((card, i) =>
      !reservedYoto || (Number.isInteger(card.index) ? card.index : i + 1) !== reservedYoto.index
    );
    const repeatPlan = planEquippedBambooContinuation(
      result.deck.deckRemaining,
      afterYotoEquip,
      { runtime: { ...state, bambooSwordEquipped: true, equippedBambooId: 'M19' },
        byId: result.deck.byId, deck: result.deck }
    );
    const hornetBambooDraw2 = Boolean(
      state && state.v5Branch && (
        state.v5Branch.hornetBambooDraw2 === true ||
        state.v5Branch.postE10HornetBambooDraw2 === true
      )
    );
    if (hornetBambooDraw2 && state.v5Branch.reservedYotoInHand === true && reservedYoto && golden && !repeatPlan.shouldLink) {
      preferred = reservedYoto;
      phase = 'POST_HORNET_WIND_EQUIP_RESERVED_YOTO';
      reason = '风刀已经让牌组妖刀送墓并检索到黄金竹光；现在先把一直保留在手的妖刀装备给风刀，使黄金竹光具备抽2条件。此时保留这张装备中的妖刀用于抽2，不抢先把载体Link掉。';
    } else if (trueSword && yotoInDeck && !preserveKagariEntrance) {
      preferred = trueSword;
      phase = 'POST_YOTO_SEARCH_TRUE_EQUIP';
      reason = '妖刀检索已经拿到真刀，且牌组仍有妖刀可被真刀装备；先把真刀装备到当前 Link 载体。真刀装备完成后再回到普通决策层。';
    } else if (
      reservedYoto && carrierId &&
      state.bambooSwordEquipped !== true &&
      repeatPlan.shouldLink &&
      !(result.selected && result.selected.id === IDS.TOON_TABLE)
    ) {
      preferred = reservedYoto;
      phase = 'POST_YOTO_SEARCH_HAND_YOTO_REPEAT_SEARCH';
      reason = `妖刀检索已结束，场上仍有载体${carrierId}，手里还有另一张妖刀。` +
        '先装备这张手牌妖刀，再由成熟Y1/Y2/Y3继续Link并检索竹光；妖刀检索没有每回合次数限制。' +
        (repeatPlan.deferredGoldenSearch
          ? '延后检索金竹光：牌组仍有装备，先检索，等待装备实际上手后再补装；当前不能发动金竹光。'
          : `确定续接：${repeatPlan.steps.join(' -> ')}；定向检索与确定补装高于普通金竹光抽2。`);
    } else if (
      (reservedYoto || trueSword) &&
      golden &&
      carrierId &&
      state.bambooSwordEquipped !== true
    ) {
      // This is a constructible draw-2, not a dead Equip Spell.  Keep the
      // user's ordinary draw-1 > draw-2 ordering by assigning P3, but place
      // the setup far ahead of P100 Mallet.  Once equipped, the main loop
      // switches to GOLDEN_BAMBOO_DRAW_READY instead of Linking the carrier.
      const setupSword = reservedYoto || trueSword;
      const action = makeAction(setupSword, 3, 'P3 构造金竹光抽2', {
        usable: true,
        graveGain: 0,
        reason:
          `当前场上仍有载体${carrierId}，手里同时有${setupSword.name}和金黄色竹光。` +
          '先把装备竹光装备给现有载体，即可让金黄色竹光合法抽2；此资源动作必须先于万宝槌。',
        details: {
          v5AtomicBranchPreference: true,
          phase: setupSword.id === 'M19'
            ? 'POST_YOTO_SEARCH_EQUIP_YOTO_FOR_GOLDEN_DRAW2'
            : 'POST_YOTO_SEARCH_EQUIP_TRUE_FOR_GOLDEN_DRAW2',
          branchState,
          carrierId,
          enablesGoldenDraw2: true
        }
      });
      result.actions = [
        ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
          !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
        ),
        action
      ].sort((left, right) => {
        if (left.tier !== right.tier) return left.tier - right.tier;
        return left.slot - right.slot;
      });
      result.selected = result.actions[0] || null;
      result.v5GoldenDrawSetupPolicy = {
        applied: true,
        branchState,
        carrierId,
        setupCardId: setupSword.id,
        goldenCardId: 'M14'
      };
      return result;
    }
  } else if (branchState === 'GOLDEN_BAMBOO_DRAW_READY') {
    // This state protects the equipped Yoto/carrier from being Linked away;
    // it does NOT promote Golden Bamboo above the ordinary priority table.
    // Confirmed policy: deterministic searches (especially Toon Table) stay
    // highest, Engage's search+random draw-1 is below that fixed-search layer,
    // ordinary draw-1 follows, and Golden Bamboo remains an ordinary draw-2.
    // The base collector already ranks an activatable M14 at P3, so returning
    // the unmodified result preserves exactly that ordering.
    result.v5GoldenBambooReadyPolicy = {
      applied: true,
      forcedGolden: false,
      preservesEquippedYoto: state.bambooSwordEquipped === true,
      branchState
    };
  }

  // Keep completed-node diagnostic metadata, but never promote any fixed
  // Bamboo/Raye preparation above Toon's established absolute priority.
  if (result.selected?.id === IDS.TOON_TABLE) return result;

  if (!preferred && trueConversion && !preserveKagariEntrance) {
    preferred = trueConversion.sword;
    phase = trueConversion.phase;
    reason = `当前手牌真刀、载体${trueConversion.carrierId}与牌组妖刀已确定；不论真刀来自抽牌还是检索、上一完成节点叫什么，先装备并按成熟T20换装，不因未进入特定支线而漏掉固定资源动作。`;
  }

  if (!preferred && goldenSetup?.sword.id === 'M19' && goldenSetup.fixedContinuationReady &&
      !(result.selected && result.selected.id === IDS.TOON_TABLE)) {
    preferred = goldenSetup.sword;
    phase = 'EQUIP_YOTO_FOR_FIXED_SEARCH';
    reason = '当前妖刀可装备现有载体，送墓检索后有确定的装备续接；这是定向资源连锁，优先于普通金竹抽2。不能把只在牌组等待随机上手的备用刀当成确定补装。';
  }

  if (!preferred) {
    if (preserveKagariEntrance && v5FindHandCard(cards, 'M20')) {
      result.v5UnequippedKagariEntrance = { preserved: true,
        reason: '火刀回收尚未使用，检索到真刀不自动抢先装备；先兑现其它资源，再判断交闪/火刀收益' };
    }
    return result;
  }

  const action = v5AtomicBambooAction(preferred, state, reason, phase);
  result.actions = [
    action,
    ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
      !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
    )
  ];
  result.selected = action;
  result.v5AtomicBambooPolicy = { applied: true, phase, branchState };
  return result;
}

function shouldPreferPostKagariYoto({ yoto, trueSwordInDeck }) {
  // The equipped hand copy itself is the card that will be sent by the next
  // non-fire Link.  Its GY effect searches M20, so another M19 in Deck is not a
  // prerequisite for this immediate recovery route.
  return Boolean(yoto && trueSwordInDeck);
}


// PATCH_V5_HORNET_YOTO_FIXED_RESOURCE_PRIORITY_V1
function v5FixedResourceFindHandCard(cards, id) {
  const list = Array.isArray(cards) ? cards : [];
  for (let i = 0; i < list.length; i++) {
    const card = list[i];
    if (card && card.id === id) {
      return { ...card, index: Number.isInteger(card.index) ? card.index : i + 1 };
    }
  }
  return null;
}

function isHornetBambooFollowUpPhase(phase) {
  return new Set([
    'START_HORNET_TRUE_YOTO_WIND_FIXED_RESOURCE',
    'START_HORNET_YOTO_TRUE_YOTO_GOLDEN_FIXED_RESOURCE',
    'START_HORNET_YOTO_FIXED_SEARCH',
    // Engage is already in the GY: Hornet first makes Kagari, then the same
    // fixed Yoto -> True -> Deck Yoto -> Golden continuation runs on Kagari.
    'START_HORNET_YOTO_FIXED_RESOURCE'
  ]).has(String(phase || ''));
}

function v5FixedResourceAction(card, state, reason, phase) {
  return {
    slot: card.index,
    x: card.x,
    y: card.y,
    id: card.id,
    name: card.name,
    tier: -2,
    tierLabel: 'P-2 大黄蜂固定检索/竹光资源链',
    usable: true,
    graveGain: 0,
    reason,
    details: {
      v5HornetYotoFixedResource: true,
      bambooFollowUp: isHornetBambooFollowUpPhase(phase),
      phase,
      branchState: state && state.v5Branch ? state.v5Branch.currentState : null
    }
  };
}

function describeEngageHornetKagariBambooDrawBridge(cards, deck, state = {}) {
  const handCounts = countById(cards);
  const remaining = deck && deck.deckRemaining || {};
  const branchState = String(state && state.v5Branch && state.v5Branch.currentState || '');
  const noActiveFieldBranch = !branchState ||
    branchState === 'NONE' ||
    branchState === 'IDLE' ||
    branchState === 'BRANCH_COMPLETE';

  if (!noActiveFieldBranch || state.engageBlockedByMainMonster === true) return null;
  if (Number(handCounts[IDS.ENGAGE] || 0) < 1) return null;
  if (Number(handCounts[IDS.CURSED_BAMBOO] || 0) < 1) return null;
  if (Number(handCounts[IDS.GOLDEN_BAMBOO] || 0) < 1) return null;
  if (Number(remaining[IDS.HORNET] || 0) < 1) return null;
  if (Number(remaining[IDS.TRUE_BAMBOO] || 0) < 1) return null;
  if (Number(remaining[IDS.CURSED_BAMBOO] || 0) < 1) return null;

  // The first Engage removes Hornet from Deck.  The recovered Engage must
  // still have a different real target for its later search + bonus draw.
  const laterEngageTargets =
    Number(remaining[IDS.RAYE] || 0) +
    Number(remaining[IDS.HAMP] || 0) +
    Math.max(0, Number(remaining[IDS.HORNET] || 0) - 1);
  if (laterEngageTargets < 1) return null;

  // Known Deck exits before completion: Hornet search, True search, Deck Yoto
  // equip, Golden draw2, then the recovered Engage search + bonus draw1.
  if (mainDeckRemainingCount(deck) < 7) return null;

  return {
    phase: 'START_ENGAGE_HORNET_KAGARI_YOTO_TRUE_YOTO_GOLDEN_BONUS',
    firstSearchTarget: IDS.HORNET,
    laterEngageTargets,
    graveSpellCountBefore: Number(state.graveSpellCount || 0),
    reasonCode: 'ENGAGE_HORNET_KAGARI_BAMBOO_UNLOCKS_GOLDEN_AND_BONUS_DRAW'
  };
}

function shouldPreferKagariMalletThirdSpell({
  branchState,
  malletPolicy,
  toonTableAlreadyWins,
  ordinaryThirdSpellBuilder,
  atomicBambooAlreadyWins
} = {}) {
  return Boolean(
    branchState === 'KAGARI_RECOVERY_DONE' &&
    malletPolicy &&
    malletPolicy.engageThirdSpellSetupReady &&
    malletPolicy.returnableCount > 0 &&
    !toonTableAlreadyWins &&
    !ordinaryThirdSpellBuilder &&
    !atomicBambooAlreadyWins
  );
}

function shouldPreferKagariRecoveredBonusEngage({
  branchState,
  graveSpellCount,
  recoveredEngage,
  engageTarget,
  toonTableAlreadyWins,
  atomicBambooAlreadyWins
} = {}) {
  return Boolean(
    branchState === 'KAGARI_RECOVERY_DONE' &&
    Number(graveSpellCount || 0) >= 3 &&
    recoveredEngage &&
    engageTarget &&
    !toonTableAlreadyWins &&
    !atomicBambooAlreadyWins
  );
}

function collectActionsV5HornetYotoFixedResourcePolicy(cards, library, runtimeState) {
  const baseCollector = typeof collectActionsV5AtomicBambooPolicy === 'function'
    ? collectActionsV5AtomicBambooPolicy
    : collectActions;
  const result = baseCollector(cards, library, runtimeState);
  const state = runtimeState || result.state || {};
  const gain = buildTrueBambooGainAction(cards, state, result.deck);
  if (gain) {
    // The new gain window does not demote the established Toon fixed-search
    // layer. Secure an actually legal Toon search before Engage's random bonus.
    const toon = (result.actions || []).find(a => a.id === IDS.TOON_TABLE);
    result.actions = [...(toon ? [toon] : []), gain,
      ...(result.actions || []).filter(a => a !== toon && !(a.id === gain.id && a.slot === gain.slot))];
    result.selected = toon || gain;
    result.trueBambooGainPolicy = { applied: true, phase: gain.details.phase };
    return result;
  }
  // Fixed True conversion retains its ordering. Any completed proven carrier
  // can equip a held sword for ordinary Golden, regardless of spare count.
  // Expand the real action pool before recalculating Mallet's gain-first tier.
  if (!result.v5AtomicBambooPolicy?.applied && !result.v5GoldenDrawSetupPolicy?.applied) {
    const setup = planGoldenBambooSetup(cards, state, result.deck);
    if (setup) {
      const action = makeAction(setup.sword, 3, 'P3 构造金竹光抽2', {
        usable: true, graveGain: 0,
        reason: `当前载体${setup.carrierId}、手牌${setup.sword.name}与金竹光已齐；先装备再抽2，不因完成节点名称或牌组没有备用装备而漏掉收益。`,
        details: { ...setup, sword: undefined, v5AtomicBranchPreference: true }
      });
      result.actions = [...result.actions.filter(a => !(a.id === action.id && a.slot === action.slot)), action];
      result.actions.sort((a, b) => a.tier - b.tier || a.slot - b.slot);
      result.selected = result.actions[0] || null;
      result.v5GoldenDrawSetupPolicy = { applied: true, ...setup, sword: undefined, setupCardId: setup.sword.id };
    }
  }
  if (result.v5GoldenDrawSetupPolicy?.applied) {
    for (const mallet of result.actions.filter(a => a.id === IDS.MALLET)) {
      Object.assign(mallet, malletPriorityForPolicy(mallet.details?.mallet,
        { actions: result.actions, runtimeState: state }));
    }
    result.actions.sort((a, b) => a.tier - b.tier || a.slot - b.slot);
    result.selected = result.actions[0] || null;
  }
  const branchState = state && state.v5Branch
    ? String(state.v5Branch.currentState || '')
    : '';
  const hornet = v5FixedResourceFindHandCard(cards, 'M22');
  const yoto = v5FixedResourceFindHandCard(cards, 'M19');
  const trueSword = v5FixedResourceFindHandCard(cards, 'M20');
  const trueSwordInDeck = Boolean(
    result && result.deck && result.deck.deckRemaining &&
    Number(result.deck.deckRemaining.M20 || 0) > 0
  );
  const yotoInDeck = Boolean(
    result && result.deck && result.deck.deckRemaining &&
    Number(result.deck.deckRemaining.M19 || 0) > 0
  );
  const goldenInDeck = Boolean(
    result && result.deck && result.deck.deckRemaining &&
    Number(result.deck.deckRemaining.M14 || 0) > 0
  );
  const goldenInHand = Boolean(v5FixedResourceFindHandCard(cards, 'M14'));
  const toonTableAlreadyWins = Boolean(result && result.selected && result.selected.id === 'M10');
  const engageInGrave = Number(state && state.usedCounts && state.usedCounts.M17 || 0) > 0;
  const atomicBambooAlreadyWins = Boolean(result && result.v5AtomicBambooPolicy && result.v5AtomicBambooPolicy.applied);
  const noActiveFieldBranch = !branchState ||
    branchState === 'NONE' ||
    branchState === 'IDLE' ||
    branchState === 'BRANCH_COMPLETE';

  // A constructible Bamboo search is deterministic and must be secured before
  // Engage's random bonus draw, even when three grave Spells are already ready.
  // Promote the recovered Engage only after those fixed routes are exhausted;
  // the historical Kagari label is not proof that a Mallet bridge was used.
  const recoveredBonusEngage = v5FixedResourceFindHandCard(cards, IDS.ENGAGE);
  const recoveredBonusEngageTargets = searchableEngageTargets(result.deck, state);
  const recoveredBonusEngageTarget = chooseEngageTarget(result.deck, state);
  if (shouldPreferKagariRecoveredBonusEngage({
    branchState,
    graveSpellCount: state.graveSpellCount,
    recoveredEngage: recoveredBonusEngage,
    engageTarget: recoveredBonusEngageTarget,
    toonTableAlreadyWins,
    atomicBambooAlreadyWins
  })) {
    const action = makeAction(recoveredBonusEngage, -4, 'P-4 篝回收后的三魔法交闪', {
      usable: true,
      graveGain: 1,
      reason:
        `篝已回收交闪且墓地魔法=${state.graveSpellCount}，已经满足检索后抽1。` +
        '当前没有可先完成的竹光固定检索，先兑现交闪检索+追加抽1；已有竹光固定路线时先完成竹光。',
      details: {
        searchableTargets: recoveredBonusEngageTargets,
        searchTarget: recoveredBonusEngageTarget,
        recoveredByKagari: true,
        bonusDrawReady: true
      }
    });
    result.actions = [
      action,
      ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
        !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
      )
    ];
    result.selected = action;
    result.v5KagariRecoveredBonusEngagePolicy = { applied: true, branchState };
    return result;
  }

  // Kagari recovery leaves the opening spell and Hornet in the GY while
  // Engage returns to hand: exactly two grave Spells.  If no ordinary live
  // spell can supply the third count, Mallet is the deliberate bridge.  This
  // bridge applies only when no deterministic Bamboo continuation is ready.
  // It yields to every other available ordinary resource, including a first
  // Chicken Game or a deferred field draw which adds no immediate grave Spell.
  const mallet = v5FixedResourceFindHandCard(cards, IDS.MALLET);
  const engageThirdSpellMallet = mallet
    ? buildMalletKeepPolicy(result.deck, cards, state)
    : null;
  const ordinaryThirdSpellBuilder = hasAvailableResourceBeforeMallet(
    Array.isArray(result.actions) ? result.actions : [], state
  );

  if (mallet && shouldPreferKagariMalletThirdSpell({
    branchState,
    malletPolicy: engageThirdSpellMallet,
    toonTableAlreadyWins,
    ordinaryThirdSpellBuilder,
    atomicBambooAlreadyWins
  })) {
    const action = makeAction(mallet, -3, 'P-3 篝回收后万宝槌补第3张魔法', {
      usable: true,
      graveGain: 1,
      reason:
        '篝已回收交闪，墓地现有2张魔法；当前没有其它可推进的普通抽牌/检索资源。' +
        engageThirdSpellMallet.reason,
      details: {
        mallet: engageThirdSpellMallet,
        kagariRecoveredEngageThirdSpellBridge: true,
        phase: 'POST_KAGARI_MALLET_THIRD_SPELL_THEN_ENGAGE'
      }
    });
    result.actions = [
      action,
      ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
        !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
      )
    ];
    result.selected = action;
    result.v5KagariMalletThirdSpellPolicy = {
      applied: true,
      branchState,
      protectEngage: engageThirdSpellMallet.protectEngageForThirdSpell,
      engageMustReturn: engageThirdSpellMallet.engageMustReturnToMallet
    };
    return result;
  }

  // A live Extra Deck carrier means Hornet cannot start the old token->Kagari
  // resource line.  Its token would occupy our Main Monster Zone and disable
  // the Engage still in hand.  Keep it out of both the ordinary pool and every
  // legacy fixed-resource promotion, even if Engage is already tracked in GY.
  if (hornet && hornetBlockedByExtraDeckMonster(state)) {
    result.actions = (Array.isArray(result.actions) ? result.actions : [])
      .filter(action => !(action && action.id === IDS.HORNET));
    result.selected = result.actions[0] || null;
    result.v5HornetExtraMonsterGuard = {
      applied: true,
      carrierId: String(state.v5Branch && state.v5Branch.carrierId || ''),
      branchState
    };
    return result;
  }

  let preferred = null;
  let phase = null;
  let reason = '';

  const engageBridge = describeEngageHornetKagariBambooDrawBridge(cards, result.deck, state);
  if (engageBridge && !toonTableAlreadyWins) {
    const engage = v5FixedResourceFindHandCard(cards, IDS.ENGAGE);
    const searchTarget = chooseEngageTarget(result.deck, state);
    const searchableTargets = searchableEngageTargets(result.deck, state);
    if (engage && searchTarget && searchTarget.id === IDS.HORNET) {
      const action = makeAction(engage, -2, 'P-2 交闪启动黄蜂/竹光固定资源链', {
        usable: true,
        graveGain: 1,
        reason:
          `当前墓地魔法=${engageBridge.graveSpellCountBefore}，但这张交闪不是无收益保底：` +
          '先固定检索大黄蜂，大黄蜂生成衍生物并由火刀回收交闪；' +
          '再把手牌妖刀装备给火刀，依次完成妖刀检索真刀、真刀从牌组装备另一张妖刀、金竹光抽2。' +
          '这些已知魔法入墓后，回收的交闪满足三魔法并可再检索+抽1。',
        details: {
          searchableTargets,
          searchTarget,
          fixedResourceChain: true,
          engageHornetKagariBambooBridge: true,
          phase: engageBridge.phase,
          laterEngageTargets: engageBridge.laterEngageTargets
        }
      });
      result.actions = [
        action,
        ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
          !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
        )
      ];
      result.selected = action;
      result.v5EngageHornetKagariBambooBridgePolicy = {
        applied: true,
        ...engageBridge
      };
      return result;
    }
  }

  // H3's targeted single-gain proof intentionally avoids a full hand scan, so
  // the recovered Engage can have usable=null.  KAGARI_RECOVERY_DONE is exact
  // evidence that M17 is in hand and the mature executor will still re-prove
  // both identity and the activation button before input.  Restore it to P1
  // only when no deterministic Bamboo continuation or Toon Table already wins,
  // and a sub-three-Spell Engage does not preempt another available resource.
  if (
    branchState === 'KAGARI_RECOVERY_DONE' &&
    !atomicBambooAlreadyWins &&
    !toonTableAlreadyWins &&
    !(Number(state.graveSpellCount || 0) < 3 && ordinaryThirdSpellBuilder)
  ) {
    const recoveredEngage = v5FixedResourceFindHandCard(cards, 'M17');
    const engageTargets = searchableEngageTargets(result.deck, state);
    const engageTarget = chooseEngageTarget(result.deck, state);
    if (recoveredEngage && engageTarget && engageTargets.length > 0) {
      const action = makeAction(recoveredEngage, 1, 'P1 篝回收后的交闪', {
        usable: true,
        graveGain: 1,
        reason:
          '篝回收已完成并定向证明交闪回手；当前没有更优先的竹光确定续行。' +
          '交闪执行器会在发动前重新证明卡名与发动按钮，因此优先交闪而不是抵价交易等随机抽牌。',
        details: {
          searchableTargets: engageTargets,
          searchTarget: engageTarget,
          recoveredByKagari: true
        }
      });
      result.actions = [
        action,
        ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
          !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
        )
      ];
      result.selected = action;
      result.v5KagariRecoveredEngagePolicy = { applied: true, branchState };
      return result;
    }
  }

  const trueYotoWindReady = Boolean(
    hornet && trueSword && yoto && yotoInDeck && goldenInDeck
  );
  const yotoTrueYotoGoldenReady = Boolean(
    hornet && yoto && goldenInHand && trueSwordInDeck && yotoInDeck
  );
  const yotoFixedSearchReady = Boolean(
    hornet && yoto && trueSwordInDeck
  );

  // Once Engage is in the GY, Hornet's token must become Kagari first so the
  // deterministic Bamboo extension retains the recovered Engage bonus draw.
  // The direct token-equip route is only valid when there is no Engage to recover.
  if (noActiveFieldBranch && hornet && engageInGrave && !toonTableAlreadyWins) {
    preferred = hornet;
    if (yoto && trueSwordInDeck && yotoInDeck) {
      phase = 'START_HORNET_YOTO_FIXED_RESOURCE';
      reason = '墓地已有交闪；当前同时有大黄蜂与妖刀，且牌组仍有真刀和另一张妖刀。先走“大黄蜂→衍生物→篝→回收交闪”，再延长竹光固定链。';
    } else {
      phase = 'START_HORNET_KAGARI_RECOVERY';
      reason = '墓地已有交闪；先发动大黄蜂，固定走“衍生物→篝→回收交闪”。这条确定检索/回收链优先于抵价交易等随机抽牌；竹光只决定回收后的延长路线，不是入口条件。';
    }
  } else if (
    noActiveFieldBranch && hornet && !toonTableAlreadyWins &&
    (trueYotoWindReady || yotoTrueYotoGoldenReady || yotoFixedSearchReady)
  ) {
    preferred = hornet;
    if (trueYotoWindReady) {
      phase = 'START_HORNET_TRUE_YOTO_WIND_FIXED_RESOURCE';
      reason = '当前有大黄蜂、真刀和可保留的手牌妖刀，牌组仍有另一张妖刀与黄金竹光。大黄蜂提供确定载体；完整竹光固定链不依赖交闪已经发动。';
    } else if (yotoTrueYotoGoldenReady) {
      phase = 'START_HORNET_YOTO_TRUE_YOTO_GOLDEN_FIXED_RESOURCE';
      reason = '当前有大黄蜂、妖刀和金黄色竹光，牌组仍有真刀与另一张妖刀。先由大黄蜂生成载体，把手牌妖刀装备给衍生物并Link非火刀；妖刀检索真刀，真刀再从牌组装备妖刀，使金黄色竹光抽2。这条固定资源链不依赖墓地已有交闪。';
    } else {
      phase = 'START_HORNET_YOTO_FIXED_SEARCH';
      reason = '当前有大黄蜂和妖刀，且牌组仍有真刀。先由大黄蜂生成衍生物，把手牌妖刀装备给衍生物并Link非火刀，稳定触发妖刀检索真刀；这次确定检索必须先于无之炼狱等随机抽1。该入口只承诺检索，不假定已经具备金竹光抽2。';
    }
  }

  if (!preferred) return result;

  const action = v5FixedResourceAction(preferred, state, reason, phase);
  result.actions = [
    action,
    ...(Array.isArray(result.actions) ? result.actions : []).filter(row =>
      !(row && row.id === action.id && Number(row.slot) === Number(action.slot))
    )
  ];
  result.selected = action;
  result.v5HornetYotoFixedResourcePolicy = {
    applied: true,
    phase,
    branchState,
    trueSwordInDeck,
    trueSwordInHand: Boolean(trueSword),
    yotoInDeck,
    goldenInDeck,
    goldenInHand,
    engageInGrave
  };
  return result;
}

module.exports = {
  IDS,
  countById,
  spellCardIsUsable,
  buildDeckState,
  searchableEngageTargets,
  buildEngageTargetPriority,
  chooseEngageTarget,
  toonTableTarget,
  mainDeckRemainingCount,
  buildMalletKeepPolicy,
  malletPriorityForPolicy,
  hornetBlockedByExtraDeckMonster,
  isHornetBambooFollowUpPhase,
  describeEngageHornetKagariBambooDrawBridge,
  shouldPreferKagariMalletThirdSpell,
  shouldPreferKagariRecoveredBonusEngage,
  shouldPreferPostKagariYoto,
  collectActions: collectActionsV5HornetYotoFixedResourcePolicy,
  printDecision
};
