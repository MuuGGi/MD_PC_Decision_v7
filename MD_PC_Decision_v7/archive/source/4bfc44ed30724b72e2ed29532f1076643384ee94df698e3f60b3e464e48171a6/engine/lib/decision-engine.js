/**
 * Ordinary hand capabilities plus the original A/B branch decision tree.
 * One aligned ledger supplies every provider; one final V7 arbiter publishes.
 * No completed-route-name promotion or route-specific negative priority chain.
 * Mature recognition, transaction and settlement ownership is unchanged.
 */

// PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_DECISION
const { getSharedDeckState } = require('./main-deck-ledger');
const { rankCandidates, leadingCandidate, arbitrateCandidates } = require('../../src/strategy/action-order');
const { goldenFromLegacy } = require('../../src/integration/legacy-capabilities');
const { mainMonsterConstraint } = require('../../src/core/field-state');
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');
const { buildTradeInCostPolicy } = require('./trade-in-policy');
const { chooseToonTableTarget } = require('./toon-table-policy');
const { describeAllureDecision } = require('./allure-policy');
const { summarizeBambooEquipResources } = require('./yoto-search-value');
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

function collectActions(cards, library, runtimeState, branch = {}) {
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
      const engageBlockedByMainMonster = mainMonsterConstraint(state).blocked;
      if (postE10HornetBambooDraw2 || engageBlockedByMainMonster) {
        holds.push({
          slot: card.index,
          id: card.id,
          name: card.name,
          reason: '当前已知主怪兽区有怪兽；交闪不能发动，不凭旧空场标志放行。'
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
      } else if (state.graveSpellCount >= 3 || branch.engageAction) {
        actions.push(makeAction(card, branch.engageAction?.tier ?? 1, '交闪当前资源入口', {
          graveGain: 1,
          reason: branch.engageAction?.reason || (state.graveSpellCount >= 3
            ? `墓地魔法=${state.graveSpellCount}，交闪可检索并获得额外抽牌；按当前资源仲裁。`
            : '当前交闪的真实检索可补齐零衣/墓地交闪入口；先保持载体无装备，结算后重新核对零梦收益。本次尚不足三魔法，不伪造追加抽1。'),
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


    // Carrier entry belongs to the two-branch planner, not a second hand policy.
    if (card.id === IDS.HORNET) continue;

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
  actions.splice(0, actions.length, ...rankCandidates(actions, state));

  return {
    state,
    deck,
    actions,
    holds,
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


// One branch planner replaces the old chain of V5 route promotions.
function collectCandidateActions(cards, library, runtimeState = {}) {
  const deck = buildDeckState(library, cards, runtimeState);
  const branch = require('./yoto-search-value').collectBambooBranchCandidates(cards, runtimeState, deck);
  const ordinary = collectActions(cards, library, runtimeState, branch);
  const actions = [...ordinary.actions, ...branch.actions];
  for (const mallet of actions.filter(a => a.id === IDS.MALLET))
    Object.assign(mallet, malletPriorityForPolicy(mallet.details.mallet, { actions, runtimeState }));
  return { ...ordinary, actions, branchDecision: branch.branchDecision,
    equipmentOpportunity: branch.branchDecision.opportunity };
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
  collectCandidateActions,
  // Compatibility callers get one hand-only finalization. Production passes
  // unselected candidates to the shared full-context strategy authority.
  collectActions(cards, library, runtimeState) {
    const result = collectCandidateActions(cards, library, runtimeState);
    const final = arbitrateCandidates(result.actions, result.state, result.deck.handCounts);
    return { ...result, actions: final.actions, selected: final.selected };
  },
  printDecision
};
