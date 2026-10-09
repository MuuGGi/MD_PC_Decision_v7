'use strict';

const fs = require('fs');
const { loadPendingM21Transaction } = require('../lib/m21-field-transaction');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { planTrueBambooGain } = require('../lib/true-bamboo-gain-policy');
const { planKagariSwordPreparation } = require('../lib/kagari-sword-plan');
const { chooseEquippedRayeLink } = require('../lib/double-link-policy');
const { planGoldenBambooSetup } = require('../lib/golden-bamboo-setup-policy');
const { assertAutomaticExecutionResult } = require('../lib/simple-draw-continuation-policy');
const { readJson, writeJsonAtomic } = require(path.join(ROOT, 'lib', 'runtime-files'));
const { voidOrdinarySettlement } = require('../execution/core/observer-completion');
const { resetCompositeRouteSession } = require(path.join(ROOT, 'lib', 'duel-session-reset'));
const { createRuntimeSourceFreshnessGuard } = require(path.join(ROOT, 'lib', 'runtime-source-freshness'));
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const {
  planEquippedBambooContinuation
} = require(path.join(ROOT, 'lib', 'yoto-search-value'));
const { MALLET_RESUME_STATUSES, committedSelectionState } = require(
  path.join(ROOT, 'execution', 'core', 'm11-mallet-completion')
);
const { PENDING_OBSERVER_PATH, loadPendingIncrementalObservation } = require(
  path.join(ROOT, 'lib', 'incremental-observer-transaction')
);
const { VERIFIED_STATUS_PATH: VERIFIED_PATH } = require(path.join(ROOT, 'lib', 'project-storage'));
const {
  EXODIA_COMPONENT_IDS,
  EXODIA_UNKNOWN_ID,
  isExactExodiaComponentId,
  countExodiaComponents,
  adjustedMainDeckRemainingCount
} = require(path.join(ROOT, 'lib', 'exodia-policy'));
const {
  TRADE_IN_COST_IDS,
  isTradeInCostId
} = require(path.join(ROOT, 'lib', 'trade-in-policy'));
const {
  PRODUCTION_ENTRYPOINTS
} = require(path.join(ROOT, 'execution', 'production-entrypoints'));
const {
  atomicContinuationDecision
} = require(path.join(ROOT, 'lib', 'atomic-response-continuation-policy'));
const {
  runConfirmedDeadlockSurrender
} = require(path.join(ROOT, 'execution', 'core', 'deadlock-surrender'));
const {
  runPostVictorySettlement, createPostDuelTerminalPrompt
} = require(path.join(ROOT, 'execution', 'core', 'post-duel-victory'));
const { buildLastResortAllureAction } = require(path.join(ROOT, 'lib', 'allure-policy'));
const { createSimpleDrawAutoController } = require(path.join(ROOT, 'lib', 'simple-draw-continuation-policy'));
const { STATE_PATH: ALLURE_LAST_RESORT_STATE_PATH, loadLastResortAllureState,
  isLastResortAllurePending } = require(path.join(ROOT, 'execution', 'core', 'm13-last-resort'));
const {
  runHornetTokenToKagariLinkAtomic,
  runKagariEffectToRecoveryPromptAtomic,
  runKagariRecoveryCurrentPromptAtomic,
  recoverResolvedKagariAtomic,
  resumeSwordEquipTargetAtomic,
  dismissSelectedHandActionMenuAtomic,
  runM20FieldEffectToDeckPromptAtomic,
  runM20SelectYotoFromDeckAtomic,
  runM20EquipSelectedYotoAtomic,
  runEquippedYotoLinkToOptionalAtomic,
  recoverYotoLinkResolvedOptionalAtomic,
  runYotoOptionalToBambooPromptAtomic,
  runBambooPromptToResolvedAtomic,
  recoverClosedBambooPromptAtomic,
  runDualSelectM19CL1Atomic,
  runDualSelectE10CL2ToTargetPromptAtomic,
  runDualE10TargetToBambooPromptAtomic,
  runRayeEffectToE10OptionalAtomic,
  runSelectedRayeE10SubmitToOptionalAtomic,
  runE10OptionalToTargetPromptAtomic,
  runE10TargetToResolvedAtomic,
  equipSwordFromHand,
  normalSummonRaye,
  loadTrueRouteStage,
  clearTrueRouteStage,
  TRUE_ROUTE_STATE_PATH
} = require(path.join(ROOT, 'execution', 'core', 'atomic-route-executor'));

const REQUIRED_NODE = '20.11.1';
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const INCREMENTAL_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const DECISION_STATE_PATH = path.join(ROOT, 'decision-state.json');
const PRELOAD_PATH = path.join(ROOT, 'execution', 'core', 'executor-preload.js');
const M18_ROUTE_STATE_PATH = path.join(ROOT, 'debug', 'execution', 'M18_foolish_burial', 'route_state.json');
const M11_RESUME_STATE_PATH = path.join(
  ROOT,
  'debug',
  'execution',
  'M11_mallet_keep_weapon',
  '_resume',
  'resume_state.json'
);
const M21_EXECUTOR_PATH = PRODUCTION_ENTRYPOINTS.M21;
const M17_BONUS_EXECUTION_ROOT = path.join(ROOT, 'debug', 'execution', 'M17_engage_bonus_draw');
const DUEL_LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const DUEL_OUTCOME_RESULT_PATH = path.join(ROOT, 'debug', 'duel-outcome-live', 'latest_result.json');
const AUTO_RESYNC_AFTER_RESOLVED_IDS = new Set(['M09', 'M10', 'M14', 'M15', 'M16', 'M17']);
const RUNTIME_SOURCE_FRESHNESS = createRuntimeSourceFreshnessGuard({ rootDir: ROOT });

const HOLD_ONLY = new Set([...EXODIA_COMPONENT_IDS, EXODIA_UNKNOWN_ID, ...TRADE_IN_COST_IDS]);
const NEED_ROUTE_DECISION = new Set();
const STRATEGIC_SPELL_IDS = new Set([
  'M09', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16',
  'M17', 'M18', 'M19', 'M20', 'M21', 'M22'
]);
const GRAVE_AFTER_RESOLVE = new Set([
  'M09', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M22'
]);

const M17_BRANCH = {
  n: {
    label: '无追加抽1',
    script: PRODUCTION_ENTRYPOINTS.M17_NO_BONUS
  },
  b: {
    label: '追加抽1',
    script: PRODUCTION_ENTRYPOINTS.M17_BONUS
  }
};

function assertEnvironment() {
  if (String(process.versions.node || '') !== REQUIRED_NODE) {
    throw new Error(
      `NODE_VERSION_MISMATCH:${process.versions.node || 'UNKNOWN'}; V6固定使用 Node v${REQUIRED_NODE}`
    );
  }

  const mustExist = [
    path.join(ROOT, 'lib', 'win-fast.js'),
    path.join(ROOT, 'lib', 'md-foreground.js'),
    path.join(ROOT, 'lib', 'recognizer.js'),
    path.join(ROOT, 'lib', 'decision-engine.js'),
    path.join(ROOT, 'execution', 'core', 'observer-current-baseline.js'),
    path.join(ROOT, 'execution', 'core', 'hand-target.js'),
    PRELOAD_PATH,
    VERIFIED_PATH
  ];

  const missing = mustExist.filter(file => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      'V5_BASE_PROJECT_INCOMPLETE:\n' +
      missing.map(file => `  - ${path.relative(ROOT, file)}`).join('\n')
    );
  }
}



function countExactCardMentions(node, card) {
  if (node == null) return 0;
  if (typeof node === 'string') {
    return node === String(card && card.id || '') || node === String(card && card.name || '') ? 1 : 0;
  }
  if (typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countExactCardMentions(item, card), 0);
  return Object.values(node).reduce((sum, value) => sum + countExactCardMentions(value, card), 0);
}

function snapshotDuelLogForCard(card) {
  try {
    if (!fs.existsSync(DUEL_LOG_RESULT_PATH)) return { exists: false, mtimeMs: 0, mentions: 0 };
    const stat = fs.statSync(DUEL_LOG_RESULT_PATH);
    const log = readJson(DUEL_LOG_RESULT_PATH);
    return {
      exists: true,
      mtimeMs: Number(stat.mtimeMs || 0),
      mentions: countExactCardMentions(log, card)
    };
  } catch (_) {
    return { exists: false, mtimeMs: 0, mentions: 0 };
  }
}

function snapshotVictoryOutcome() {
  try {
    if (!fs.existsSync(DUEL_OUTCOME_RESULT_PATH)) return { mtimeMs: 0, terminal: false };
    const stat = fs.statSync(DUEL_OUTCOME_RESULT_PATH);
    const result = readJson(DUEL_OUTCOME_RESULT_PATH);
    return {
      mtimeMs: Number(stat.mtimeMs || 0),
      terminal: Boolean(result && result.terminal === true && result.type === 'VICTORY'),
      result
    };
  } catch (_) {
    return { mtimeMs: 0, terminal: false };
  }
}

function recoverCurrentTerminalVictory() {
  const before = snapshotVictoryOutcome();
  const startedAt = Date.now();
  const observerPath = path.join(ROOT, 'runtime/observer/run-live-incremental.js');
  if (!fs.existsSync(observerPath)) {
    throw new Error('V5_RESUME_TERMINAL_VICTORY_OBSERVER_MISSING');
  }

  console.log('\n============================================================');
  console.log('当前终局恢复：只检测已经出现的艾克佐迪亚胜利画面。');
  console.log('不重放抽牌、不扫描手牌、不按 i、不进入普通决策层。');
  console.log('动画尚未成熟时只被动轮询；严格胜利成立后立即停止。');
  console.log('============================================================');

  const out = spawnSync(process.execPath, [observerPath], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      MD_V5_EXODIA_VICTORY_RISK: '1',
      MD_V5_EXODIA_VICTORY_CERTAIN: '1',
      MD_V5_EXODIA_COMPONENT_COUNT: '4',
      MD_V5_RANDOM_DRAW_CAPACITY: '1'
    }
  });
  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(`V5_RESUME_TERMINAL_VICTORY_OBSERVER_FAILED:${out.status}`);
  }

  const after = snapshotVictoryOutcome();
  const checkedAtMs = Date.parse(String(after.result && after.result.checkedAt || ''));
  const strictMatched = Boolean(
    after.result &&
    after.result.strictEvidence &&
    after.result.strictEvidence.matched === true
  );
  if (
    !after.terminal ||
    !(after.mtimeMs > before.mtimeMs) ||
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs < startedAt - 1000 ||
    !strictMatched
  ) {
    throw new Error(
      'V5_RESUME_TERMINAL_VICTORY_NOT_FRESH_STRICT;' +
      `terminal=${after.terminal};fresh=${after.mtimeMs > before.mtimeMs};` +
      `checkedAt=${after.result && after.result.checkedAt || 'NONE'};strict=${strictMatched}`
    );
  }
  return after.result;
}

async function confirmDetectedVictoryResult(context, rl) {
  try {
    const result = await runPostVictorySettlement({
      source: context || 'V6_TERMINAL_VICTORY',
      resume: context === 'V6_RESUME_TERMINAL_VICTORY',
      requestContinue: createPostDuelTerminalPrompt(rl)
    });
    console.log(`胜利后续状态：${result.status}`);
    return result.status !== 'POST_VICTORY_PAUSED';
  } catch (error) {
    console.error(
      `胜利后续结算停止: ${error && error.stack ? error.stack : error}`
    );
    console.error('胜利已成立；保留结算进度。可用 --resume-victory-settlement 继续当前结果/结算页，不重放抽牌。');
    return false;
  }
}

function randomDrawCapacity(relativeScript, card, extraArgs = []) {
  const id = String(card && card.id || '');
  const script = String(relativeScript || '').replace(/\\/g, '/').toLowerCase();
  // M13 draws before its mandatory banish, but Master Duel completes that
  // selection before presenting the Exodia terminal screen.  Its executor
  // reaches the common observer only after the banish submit, so the same
  // post-resolution victory-risk watcher must cover its draw 2 as well.
  if (id === 'M12' || id === 'M13' || id === 'M14') return 2;
  if (id === 'M17') return script.includes('bonus-draw') ? 1 : 0;
  if (id === 'M21' && extraArgs.includes('--v5-field-only')) return 0;
  if (['M09', 'M15', 'M16', 'M18', 'M21'].includes(id)) return 1;
  return 0;
}

function exodiaVictoryRisk(relativeScript, card, extraArgs = []) {
  let state = null;
  try { state = loadObserverSessionState(); } catch (_) { return null; }
  const heldCount = countExodiaComponents(state.cards);
  const held = state.cards
    .filter(item => item && (item.persistentExodia === true ||
      isExactExodiaComponentId(item.id) || item.id === EXODIA_UNKNOWN_ID))
    .map(item => String(item.id || EXODIA_UNKNOWN_ID));
  const requestedDraws = randomDrawCapacity(relativeScript, card, extraArgs);
  let deckRemaining = null;
  let deck = null;
  try {
    const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
    const decision = require(path.join(ROOT, 'lib', 'decision-engine'));
    deck = decision.buildDeckState(loadLibrary(ROOT), state.cards, loadDecisionState());
    deckRemaining = decision.mainDeckRemainingCount(deck);
  } catch (_) {
    // The executor must not invent certainty when the authoritative Deck
    // ledger cannot be read.  Keep the older possible-risk gate as fallback.
    deckRemaining = null;
  }
  const randomDraws = Number.isFinite(deckRemaining)
    ? Math.min(requestedDraws, deckRemaining)
    : requestedDraws;
  const missingCount = Math.max(0, 5 - heldCount);
  const missing = Array.from({ length: missingCount }, () => EXODIA_UNKNOWN_ID);
  const possible = randomDraws > 0 && heldCount + randomDraws >= 5;
  const guaranteed = Boolean(
    possible &&
    Number.isFinite(deckRemaining) &&
    deckRemaining <= randomDraws
  );
  return {
    held,
    heldCount,
    missing,
    requestedDraws,
    randomDraws,
    deckRemaining,
    possible,
    guaranteed
  };
}

function repairResolvedSingleCardAccounting(card) {
  if (!card || !AUTO_RESYNC_AFTER_RESOLVED_IDS.has(card.id)) return loadDecisionState();
  const state = loadDecisionState();
  incrementUsedCount(state, card.id);
  if (GRAVE_AFTER_RESOLVE.has(card.id)) {
    state.graveSpellCount = Number(state.graveSpellCount || 0) + 1;
  }
  state.effectUsageMeta = {
    ...(state.effectUsageMeta || {}),
    RESOLVED_OBSERVER_RECOVERY: {
      cardId: card.id,
      cardName: card.name,
      source: 'FORMAL_V5_AUTO_RESYNC_AFTER_LOG_PROOF',
      updatedAt: new Date().toISOString()
    }
  };
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  return state;
}

function isStrategicallyUsable(card, state, runtime) {
  if (!card) return false;

  // Golden Bamboo Sword is not a generic draw-2.  It is dead until a Bamboo
  // equip is actually on our field.  Never let the strategic layer mark it
  // usable merely because it is a Spell card in hand.
  if (card.id === 'M14') return runtime.bambooSwordEquipped === true;

  // Raye is the only monster normal-summon entry in this FTK policy.  Once the
  // normal summon is spent, an in-hand Raye must not be offered as a fallback.
  if (card.id === 'M06') return runtime.normalSummonUsed !== true;

  return STRATEGIC_SPELL_IDS.has(card.id) ? true : Boolean(card.usable);
}

function defaultDecisionState() {
  return {
    graveSpellCount: 0,
    fieldSpell: null,
    chickenGameDrawUsed: false,
    chickenGameDrawPending: false,
    bambooSwordEquipped: false,
    equippedBambooId: null,
    equipSentToGraveCount: 0,
    engageBlockedByMainMonster: false,
    rayeNormalSummoned: false,
    normalSummonUsed: false,
    usedCounts: {},
    effectUsage: { M19_SEARCH: 0 },
    effectUsageMeta: {},
    notes: 'V5 runtime decision state'
  };
}

function resetDecisionStateForNewDuel() {
  const state = defaultDecisionState();
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });

  // A new V5 duel must never inherit an unfinished M18 modal-route state from
  // the previous duel. Normal --resume sessions intentionally keep it.
  fs.rmSync(M18_ROUTE_STATE_PATH, { force: true });
  // A normal new duel must not inherit a CONFIRMED/partial M11 checkpoint.
  // Explicit --resume-m11-selection skips this reset and retains it on purpose.
  fs.rmSync(M11_RESUME_STATE_PATH, { force: true });
  fs.rmSync(ALLURE_LAST_RESORT_STATE_PATH, { force: true });
  // A fresh duel must never inherit a partially completed M20->M19 Link branch.
  try { clearTrueRouteStage(); } catch (_) {}
  // ISSUE-075: composite-route is current-duel evidence, not cross-duel history.
  // Keep its directory and any archived evidence, but clear the two live files.
  resetCompositeRouteSession(ROOT);
  return state;
}

function loadPendingM18Route() {
  if (!fs.existsSync(M18_ROUTE_STATE_PATH)) return null;
  try {
    const route = readJson(M18_ROUTE_STATE_PATH);
    const status = String(route && route.status || '');
    if (!status || status === 'COMPLETE') return null;
    if (!status.startsWith('WAITING_FOR_')) return null;
    return route;
  } catch (_) {
    return null;
  }
}

function pendingM18Slot(route, state) {
  const savedSlot = Number(
    route && route.selectedM18 && route.selectedM18.slot
  );
  if (Number.isInteger(savedSlot) && savedSlot >= 1) return savedSlot;

  const cards = normalizeCards(state);
  const index = cards.findIndex(card => card.id === 'M18');
  return index >= 0 ? index + 1 : null;
}

function loadDecisionState() {
  if (!fs.existsSync(DECISION_STATE_PATH)) return defaultDecisionState();
  try {
    const state = { ...defaultDecisionState(), ...readJson(DECISION_STATE_PATH) };
    const branch = state.v5Branch || {};
    if (
      String(branch.currentState || '') === 'M19_EQUIPPED_BRANCH_DONE' &&
      state.bambooSwordEquipped === true &&
      /M19_SEARCH_ALREADY_USED/.test(String(branch.source || ''))
    ) {
      state.v5Branch = {
        ...branch,
        active: true,
        currentState: 'M19_EQUIPPED',
        source: 'MIGRATED_REPEATABLE_M19_FROM_OLD_TURN_LOCK'
      };
    }
    return state;
  } catch (_) {
    return defaultDecisionState();
  }
}

function saveDecisionState(state) {
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  return state;
}

function branchCarrierId(branch) {
  return String(branch && (branch.carrierId || branch.carrierCardId) || '');
}

function setAtomicBranch(node, extra = {}) {
  const runtime = loadDecisionState();
  // These nodes are reached only after the replacement monster/effect pool
  // proves the old equipped carrier left. Do not keep a phantom field equip
  // until the later search finishes; accounting for its GY spell stays Y3's.
  if (['Y1_LINK_RESOLVED_RECOVERY_PENDING', 'YOTO_LINK_RESOLVED', 'DUAL_OPTIONAL_PENDING'].includes(node)) {
    runtime.bambooSwordEquipped = false;
    runtime.equippedBambooId = null;
    runtime.equippedBambooCounts = {};
    runtime.bambooEquipResources = null;
  }
  runtime.v5Branch = {
    ...(runtime.v5Branch || {}),
    active: node !== 'IDLE' && node !== 'YOTO_SEARCH_DONE' && node !== 'E10_EFFECT_RESOLVED',
    currentState: node,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  if (['E10_OPTIONAL_PENDING', 'DUAL_OPTIONAL_PENDING', 'E10_EFFECT_RESOLVED'].includes(node) &&
      runtime.v5Branch.carrierId === 'E10') {
    runtime.effectUsage = runtime.effectUsage || {};
    runtime.effectUsage.E10_SUMMON = 1;
  }
  saveDecisionState(runtime);
  return runtime;
}

function clearAtomicBranch(node = 'IDLE') {
  return setAtomicBranch(node, { active: false, carrierId: null });
}

function buildEquippedBambooContinuationPlan(state, runtime = loadDecisionState()) {
  const cards = Array.isArray(state && state.cards) ? state.cards : [];
  try {
    const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
    const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
    const deck = buildDeckState(loadLibrary(ROOT), cards, runtime);
    if (!deck || !deck.deckRemaining) throw new Error('BAMBOO_DECK_EVIDENCE_MISSING');
    return planEquippedBambooContinuation(deck.deckRemaining, cards, { runtime, byId: deck.byId, deck });
  } catch (_) {
    return { shouldLink: false, shouldContinue: false, reason: 'BAMBOO_DECK_EVIDENCE_UNKNOWN', equipResources: null };
  }
}

function normalizeEquippedYotoGoldenDrawPriority(state) {
  const runtime = loadDecisionState();
  const branch = runtime.v5Branch || {};
  const node = String(branch.currentState || '');
  // Completed field-decision nodes only: never rewrite a pending modal/Link.
  if (!['M19_EQUIPPED', 'GOLDEN_BAMBOO_DRAW_READY', 'EQUIPPED_YOTO_NO_SEARCH_TARGET'].includes(node)) return runtime;
  // Old saves need affirmative branch provenance to infer the field identity.
  if (!runtime.equippedBambooId && (branch.goldenDrawEquipId === 'M20' ||
      (node === 'EQUIPPED_YOTO_NO_SEARCH_TARGET' && !/^FORMAL_|^MIGRATED_/.test(String(branch.source || ''))))) return runtime;
  const plan = buildEquippedBambooContinuationPlan(state, runtime);
  if (plan.fieldId === 'M20') return runtime; // True Sword belongs to T20, not Y1.
  const nextNode = plan.shouldContinue ? 'M19_EQUIPPED'
    : plan.goldenDrawReady ? 'GOLDEN_BAMBOO_DRAW_READY'
      : 'EQUIPPED_YOTO_NO_SEARCH_TARGET';
  const source = 'FORMAL_V6_CURRENT_BAMBOO_CONTINUATION_PLAN';
  const changed = node !== nextNode || branch.active !== plan.shouldContinue ||
    branch.source !== source || JSON.stringify(runtime.bambooContinuationPlan) !== JSON.stringify(plan);
  if (!changed) return runtime;
  runtime.bambooEquipResources = plan.equipResources;
  runtime.bambooContinuationPlan = plan;
  runtime.v5Branch = { ...branch, active: plan.shouldContinue, currentState: nextNode,
    source, updatedAt: new Date().toISOString() };
  saveDecisionState(runtime);
  const equipment = plan.equipResources;
  if (equipment) {
    console.log(`竹光装备统计：牌组=${equipment.deckCount}；手牌=${equipment.handCount}；场上=${equipment.fieldCount}；墓地/其他已离场=${equipment.outsideHandFieldCount ?? '未知'}。`);
  }
  console.log(plan.shouldContinue
    ? `${plan.deferredGoldenSearch ? '竹光延后检索' : '确定竹光续接'}：${plan.steps.join(' -> ')}；` +
      (plan.routeKind === 'RAYE_DIRECT_DUAL' ? '零衣自身效果进入妖刀/零梦双效果池，不使用零梦做Link素材。'
        : plan.deferredGoldenSearch ? '先检索金竹光，等待牌组剩余装备上手；检索后回到普通决策，不假定已补装、不立即发动金竹光。'
        : `本路线送墓装备${plan.projectedEquipSentToGraveCount}张，最终留场${plan.projectedFieldEquipId}。`) +
      '回车执行下一原子动作，不重放已完成动作。'
    : plan.goldenDrawReady
      ? '金竹光抽2已可用且当前没有更高的定向续接：回到普通抽牌优先级，先兑现手中抽2；每次结算后重新判断送墓检索，不以等待随机补装的路线抢先送刀。'
      : `保留当前装备与载体；无确定的送墓检索续接路线（${plan.reason}）。随机抽牌与万宝槌不算备用装备。`);
  return runtime;
}


const TRANSACTION_PENDING_NODES = new Set([
  'HORNET_TOKEN_READY',
  'HORNET_KAGARI_LINK_IN_FLIGHT',
  'POST_E10_HORNET_TOKEN_READY',
  'M20_EQUIP_TARGET_PENDING',
  'M20_EXTRA_EQUIP_TARGET_PENDING',
  'M19_EQUIP_TARGET_PENDING',
  'HAND_MENU_DISMISS_PENDING',
  'Y1_LINK_RESOLVED_RECOVERY_PENDING',
  // True Bamboo owns T20-1/2/3. Every newly equipped Cursed Bamboo owns a new
  // Y1/Y2/Y3 transaction; M19's graveyard search is repeatable in one turn.
  'M20_EQUIPPED',
  'KAGARI_EFFECT_PENDING',
  'KAGARI_LINK_BEFORE_TRUE_IN_FLIGHT',
  'KAGARI_SWORD_EQUIP_IN_FLIGHT',
  'KAGARI_SECOND_YOTO_EQUIP_IN_FLIGHT',
  'KAGARI_SWORD_LINK_IN_FLIGHT',
  'KAGARI_DUAL_RECOVERY_SUBMITTED_IN_FLIGHT',
  'KAGARI_RECOVERY_PROMPT',
  'M20_FIELD_EFFECT_ACTIVATED',
  'M19_SELECTED_FROM_DECK',
  'M19_EQUIPPED',
  'YOTO_LINK_RESOLVED',
  'YOTO_SEARCH_PROMPT',
  'DUAL_OPTIONAL_PENDING',
  'DUAL_M19_CL1_SELECTED',
  'TRIPLE_M19_CL2_SELECTED',
  'DUAL_E10_TARGET_PROMPT',
  'DUAL_M19_BAMBOO_PROMPT',
  'TRIPLE_SECOND_BAMBOO_PROMPT',
  'RAYE_SECOND_MATERIAL_READY',
  'E10_OPTIONAL_PENDING',
  'E10_TARGET_PROMPT',
  'RAYE_E10_SELECTED_PENDING'
]);

function currentAtomicNode() {
  const runtime = loadDecisionState();
  return String(runtime && runtime.v5Branch && runtime.v5Branch.currentState || '');
}

function isTransactionPendingNode(node = currentAtomicNode()) {
  return TRANSACTION_PENDING_NODES.has(String(node || ''));
}

function saveAtomicBranchExtra(extra = {}) {
  const runtime = loadDecisionState();
  runtime.v5Branch = {
    ...(runtime.v5Branch || {}),
    ...extra,
    updatedAt: new Date().toISOString()
  };
  saveDecisionState(runtime);
  return runtime;
}

function hornetTrueYotoWindPlan(state, runtime = null) {
  try {
    const officialState = state || loadObserverSessionState();
    const cards = Array.isArray(officialState && officialState.cards) ? officialState.cards : [];
    const decisionState = runtime || loadDecisionState();
    // If Engage has already resolved, Kagari recovery owns the Hornet token.
    // The Bamboo chain is continued on Kagari after H3; equipping the token
    // here would spend the carrier and strand the known Engage in the GY.
    if (Number(decisionState && decisionState.usedCounts && decisionState.usedCounts.M17 || 0) > 0) {
      return null;
    }
    const trueSword = cards.find(card => card && card.id === 'M20');
    const reservedYoto = cards.find(card => card && card.id === 'M19');
    const golden = cards.find(card => card && card.id === 'M14');
    if (!reservedYoto) return null;

    const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
    const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
    const deck = buildDeckState(loadLibrary(ROOT), cards, decisionState);
    const yotoInDeck = Number(deck.deckRemaining && deck.deckRemaining.M19 || 0);
    const trueSwordInDeck = Number(deck.deckRemaining && deck.deckRemaining.M20 || 0);
    const goldenInDeck = Number(deck.deckRemaining && deck.deckRemaining.M14 || 0);
    if (yotoInDeck <= 0) return null;

    if (trueSword && goldenInDeck > 0) {
      return {
        plannedSwordId: 'M20',
        reservedYotoInHand: true,
        hornetBambooDraw2: true,
        targetLinkId: null,
        yotoInDeck,
        goldenInDeck,
        route: 'TRUE_TO_DECK_YOTO_LINK_THEN_RESERVED_YOTO_GOLDEN'
      };
    }

    if (golden && trueSwordInDeck > 0) {
      return {
        plannedSwordId: 'M19',
        reservedYotoInHand: false,
        hornetBambooDraw2: true,
        targetLinkId: null,
        yotoInDeck,
        trueSwordInDeck,
        goldenInHand: true,
        route: 'YOTO_LINK_SEARCH_TRUE_TO_DECK_YOTO_GOLDEN'
      };
    }

    if (trueSwordInDeck > 0) {
      return {
        plannedSwordId: 'M19',
        reservedYotoInHand: false,
        hornetBambooDraw2: false,
        hornetYotoFixedSearch: true,
        targetLinkId: null,
        trueSwordInDeck,
        route: 'YOTO_LINK_SEARCH_TRUE_FIXED_RESOURCE'
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

function isHornetTokenSwordRoute(branch) {
  return Boolean(
    branch && (
      branch.hornetBambooDraw2 === true ||
      branch.postE10HornetBambooDraw2 === true ||
      branch.hornetYotoFixedSearch === true ||
      (branch.kagariSwordLink === true && branch.materialCarrierId === 'TOKEN_SKY_STRIKER')
    )
  );
}

function currentFieldActionLabel() {
  const runtime = loadDecisionState();
  const branch = runtime.v5Branch || {};
  const node = String(branch.currentState || '');
  const carrier = branchCarrierId(branch);
  const labels = {
    HORNET_TOKEN_READY: (() => {
      const plan = hornetTrueYotoWindPlan(null, runtime);
      if (!plan) return 'H1：准备Link火刀；有安全可送墓装备时先装刀，否则直接Link';
      return plan.plannedSwordId === 'M19'
        ? 'B1Y：只把手牌妖刀装备给黄蜂衍生物；随后Link非火刀检索真刀'
        : 'B1：只把手牌真刀装备给黄蜂衍生物；保留手牌妖刀';
    })(),
    POST_E10_HORNET_TOKEN_READY: 'EH1：把计划中的装备刀只装备给黄蜂衍生物；不碰零梦',
    HORNET_KAGARI_LINK_IN_FLIGHT: 'H1在途：禁止重放召唤；尚无完整成功回执，需要只读诊断',
    M20_EQUIP_TARGET_PENDING: 'B1R：真刀已经发动；只选择中央黄蜂衍生物并确认装备',
    M20_EXTRA_EQUIP_TARGET_PENDING: 'EQ20-R：真刀已经发动；只选择额外怪兽区Link的固定区域中心并确认装备',
    M19_EQUIP_TARGET_PENDING: 'EQ-R：妖刀已经发动，只选择当前额外区篝并确认装备',
    HAND_MENU_DISMISS_PENDING: 'HM-R：只关闭误点手牌留下的操作菜单；随后仍停在Y1前',
    Y1_LINK_RESOLVED_RECOVERY_PENDING: 'Y1R：只被动验收已完成的实际Link怪兽与当前妖刀效果池',
    KAGARI_EFFECT_PENDING: 'H2：只发动篝效果；停在回收对象窗口',
    KAGARI_RECOVERY_PROMPT: 'H3：只选择交闪并验收回手',
    M20_EQUIPPED: 'T20-1：只发动场上真刀；停在妖刀牌组选卡窗口',
    M20_FIELD_EFFECT_ACTIVATED: 'T20-2：只选择牌组妖刀；停在装备对象窗口',
    M19_SELECTED_FROM_DECK: 'T20-3：只选择装备对象并确认；验收M19_EQUIPPED',
    YOTO_LINK_RESOLVED: 'Y2：只发动妖刀效果；停在竹光检索窗口',
    YOTO_SEARCH_PROMPT: 'Y3：只选择竹光并验收入手',
    DUAL_OPTIONAL_PENDING: 'D1：双效果池只选择妖刀为CL1',
    DUAL_M19_CL1_SELECTED: branch.m19EffectCount === 2 ? 'KT2：只选择第二把妖刀为CL2'
      : branch.dualSecondEffectId === 'E02' ? 'KD2：只发动火刀为CL2；停在交闪回收窗口' : 'D2：只选择零梦为CL2；停在零梦目标窗口',
    DUAL_E10_TARGET_PROMPT: branch.dualSecondEffectId === 'E02' ? 'KD3：火刀回收交闪；停在妖刀检索窗口' : 'D3：只处理零梦目标；停在妖刀检索窗口',
    DUAL_M19_BAMBOO_PROMPT: 'D4：只选择竹光并验收双效果最终结果',
    TRIPLE_M19_CL2_SELECTED: 'KT3：两次妖刀已选，只发动火刀CL3',
    TRIPLE_SECOND_BAMBOO_PROMPT: 'KT5：真刀已检索，只检索金竹并验收三张收益',
    RAYE_SECOND_MATERIAL_READY: 'R7-1：已有Link＋零衣双素材Link零梦；停在零梦单效果池',
    RAYE_NORMAL_SUMMONED: 'R1：只发动零衣自身效果并直出零梦；停在零梦效果池',
    RAYE_E10_SELECTED_PENDING: 'R1S：只提交当前已经选中的零梦；停在双效果池',
    E10_OPTIONAL_PENDING: 'R2：只发动零梦效果；停在目标窗口',
    E10_TARGET_PROMPT: 'R3：只选择零梦目标并验收入手'
  };
  if (node === 'M19_EQUIPPED') {
    if (branch.kagariSwordLink === true) return 'KD：带妖刀素材Link火刀；进入妖刀/火刀双效果池';
    if (carrier === 'M06') return 'R1D：带妖刀零衣发动自身效果直出零梦；停在双效果池';
    if (runtime.rayeNormalSummoned === true) return 'Y1：选择任意合法非火刀单素材Link或双素材零梦；本次只完成Link并停在效果池';
    return 'Y1：妖刀carrier选择任意合法非火刀单素材Link；只验收Link并停在妖刀效果池';
  }
  return labels[node] || null;
}

function commitSwordEquipped(cardId, carrier, overrides = {}) {
  const runtime = loadDecisionState();
  const previousEquipCounts = runtime.equippedBambooCounts ||
    (runtime.bambooSwordEquipped ? { [runtime.equippedBambooId || 'M19']: 1 } : {});
  if (overrides.additionalEquip === true &&
      (cardId !== 'M19' || previousEquipCounts.M19 !== 1 || previousEquipCounts.M20 ||
       runtime.v5Branch?.carrierId !== overrides.carrierId || overrides.extra?.m19EffectCount !== 2)) {
    throw new Error('SECOND_YOTO_EQUIP_RECEIPT_INVALID');
  }
  incrementUsedCount(runtime, cardId);
  runtime.bambooSwordEquipped = true;
  runtime.equippedBambooId = cardId;
  runtime.equippedBambooCounts = overrides.additionalEquip === true
    ? { ...previousEquipCounts, [cardId]: Number(previousEquipCounts[cardId] || 0) + 1 }
    : { [cardId]: 1 };
  runtime.bambooEquipResources = null;
  let carrierId = String(
    carrier && carrier.recognized && carrier.recognized.id ||
    carrier && carrier.identity && carrier.identity.id ||
    carrier && carrier.card && carrier.card.id ||
    carrier && carrier.id ||
    ''
  );
  if (!carrierId && runtime.rayeNormalSummoned === true) {
    const zoneName = String(carrier && carrier.zoneName || '');
    if (!zoneName.includes('额外怪兽区')) carrierId = 'M06';
  }
  carrierId = String(overrides.carrierId || carrierId || '');
  const trueSwordForGoldenDraw = Boolean(
    cardId === 'M20' && overrides.extra && overrides.extra.goldenDrawSetup === true
  );
  runtime.v5Branch = {
    active: !trueSwordForGoldenDraw,
    currentState: trueSwordForGoldenDraw ? 'GOLDEN_BAMBOO_DRAW_READY'
      : (cardId === 'M20' ? 'M20_EQUIPPED' : 'M19_EQUIPPED'),
    carrierId: carrierId || null,
    updatedAt: new Date().toISOString(),
    source: overrides.source || 'FORMAL_V5_ATOMIC_MAIN',
    ...(overrides.extra || {})
  };
  saveDecisionState(runtime);
  return runtime;
}

function commitRayeNormalSummonAtomic(options = {}) {
  const runtime = loadDecisionState();
  const previousBranch = runtime.v5Branch && typeof runtime.v5Branch === 'object'
    ? { ...runtime.v5Branch }
    : {};
  const rayeOnlyMonster = !knownNonRayeMonsterPresent(runtime);
  incrementUsedCount(runtime, 'M06');
  runtime.rayeNormalSummoned = true;
  runtime.normalSummonUsed = true;
  runtime.v5Branch = options.doubleLinkRecovery === true
    ? {
        active: true,
        currentState: 'RAYE_SECOND_MATERIAL_READY',
        carrierId: String(options.carrierId || previousBranch.carrierId || ''),
        rayeOnlyMonster: false,
        doubleLinkTargetId: 'E10',
        e10EngageSource: String(options.e10EngageSource || 'GRAVE'),
        updatedAt: new Date().toISOString(),
        source: 'FORMAL_V5_RAYE_DOUBLE_LINK_ENGAGE_RECOVERY'
      }
    : rayeOnlyMonster
    ? {
        active: true,
        currentState: 'RAYE_NORMAL_SUMMONED',
        carrierId: 'M06',
        rayeOnlyMonster: true,
        updatedAt: new Date().toISOString(),
        source: 'FORMAL_V5_ATOMIC_MAIN'
      }
    : {
        active: false,
        currentState: 'RAYE_NORMAL_SUMMONED_WITH_OTHER_MONSTER',
        carrierId: previousBranch.carrierId || null,
        rayeOnlyMonster: false,
        updatedAt: new Date().toISOString(),
        source: 'FORMAL_V5_RAYE_ZONE_GUARD'
      };
  saveDecisionState(runtime);
  return runtime;
}

function knownNonRayeMonsterPresent(runtime = {}) {
  if (runtime.bambooSwordEquipped === true) return true;
  const branch = runtime.v5Branch && typeof runtime.v5Branch === 'object'
    ? runtime.v5Branch
    : {};
  const carrierId = String(branch.carrierId || '');
  return Boolean(carrierId && carrierId !== 'M06');
}

function commitAfterYotoResolution(accounting = {}) {
  const runtime = loadDecisionState();
  for (const id of accounting.usedAdd || []) incrementUsedCount(runtime, id);
  for (const id of accounting.usedRemove || []) decrementUsedCount(runtime, id);
  runtime.graveSpellCount = Math.max(0, Number(runtime.graveSpellCount || 0) + Number(accounting.graveSpellDelta || 0));
  runtime.bambooSwordEquipped = false;
  runtime.equippedBambooId = null;
  runtime.equippedBambooCounts = {};
  runtime.bambooEquipResources = null;
  if (accounting.consumeRaye === true) runtime.rayeNormalSummoned = false;
  if (accounting.preserveRaye === true) runtime.rayeNormalSummoned = true;
  if (accounting.m19SearchUsed) {
    const searchCount = Number(accounting.m19SearchCount || 1);
    runtime.equipSentToGraveCount = Number(runtime.equipSentToGraveCount || 0) + searchCount;
    const resolvedCount = Number(runtime.effectUsage && runtime.effectUsage.M19_SEARCH || 0) + searchCount;
    runtime.effectUsage = { ...(runtime.effectUsage || {}), M19_SEARCH: resolvedCount };
    runtime.effectUsageMeta = {
      ...(runtime.effectUsageMeta || {}),
      M19_SEARCH: {
        resolvedCount,
        repeatable: true,
        source: 'FORMAL_V5_ATOMIC_MAIN',
        updatedAt: new Date().toISOString()
      }
    };
  }
  if (accounting.kagariRecovery === true) {
    runtime.effectUsage = { ...(runtime.effectUsage || {}),
      KAGARI_RECOVERY: Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) + 1 };
  }
  runtime.v5Branch = {
    active: false,
    currentState: accounting.kagariRecovery === true ? 'KAGARI_RECOVERY_DONE' : 'YOTO_SEARCH_DONE',
    carrierId: accounting.carrierId || null,
    updatedAt: new Date().toISOString(),
    source: 'FORMAL_V5_ATOMIC_MAIN',
    hornetBambooDraw2: accounting.hornetBambooDraw2 === true,
    postE10HornetBambooDraw2: accounting.postE10HornetBambooDraw2 === true,
    reservedYotoInHand: accounting.reservedYotoInHand === true,
    trueBambooGainBeforeEquip: accounting.kagariRecovery === true
  };
  saveDecisionState(runtime);
  return runtime;
}

function normalizeCards(state) {
  const cards = Array.isArray(state && state.cards) ? state.cards : [];
  return cards.map((card, index) => ({
    ...card,
    index: index + 1,
    id: String(card && card.id || ''),
    name: String(card && card.name || card && card.id || 'UNKNOWN')
  }));
}

function validateHandState(state, sourceLabel) {
  const handCount = Number(state && state.handCount);
  const cards = normalizeCards(state);
  if (!Number.isInteger(handCount) || handCount < 0 || handCount > 12) {
    throw new Error(`${sourceLabel}_HAND_COUNT_INVALID:${handCount}`);
  }
  if (cards.length !== handCount) {
    throw new Error(`${sourceLabel}_CARD_COUNT_INVALID:${cards.length}/${handCount}`);
  }
  if (cards.some(card => !card.id || card.id === 'UNKNOWN')) {
    throw new Error(`${sourceLabel}_HAS_UNKNOWN_CARD`);
  }
  return { ...state, handCount, cards };
}

function loadObserverSessionState() {
  if (!fs.existsSync(HAND_STATE_PATH)) {
    throw new Error('V5_OBSERVER_SESSION_STATE_MISSING');
  }
  return validateHandState(readJson(HAND_STATE_PATH), 'SESSION_STATE');
}

function sameHandIdentitySequence(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((card, index) =>
    String(card && card.id || '') === String(b[index] && b[index].id || '')
  );
}

function repairLatestLedgerFromObserverState(state) {
  if (!fs.existsSync(INCREMENTAL_PATH)) {
    throw new Error('V5_LEDGER_REPAIR_INCREMENTAL_RESULT_MISSING');
  }
  const incrementalResult = readJson(INCREMENTAL_PATH);
  if (!incrementalResult || incrementalResult.status !== 'PASS') {
    throw new Error(`V5_LEDGER_REPAIR_RESULT_NOT_PASS:${incrementalResult && incrementalResult.status || 'MISSING'}`);
  }

  const after = validateHandState(incrementalResult.after, 'LEDGER_REPAIR_AFTER');
  if (Number(after.revision || 0) !== Number(state.revision || 0)) {
    throw new Error(
      `V5_LEDGER_REPAIR_REVISION_MISMATCH:${after.revision || 0}/${state.revision || 0}`
    );
  }
  if (!sameHandIdentitySequence(after.cards, state.cards)) {
    throw new Error('V5_LEDGER_REPAIR_HAND_SEQUENCE_MISMATCH');
  }

  const log = fs.existsSync(DUEL_LOG_RESULT_PATH) ? readJson(DUEL_LOG_RESULT_PATH) : {};
  const { applyIncrementalResultToMainDeckLedger } = require(path.join(ROOT, 'lib', 'main-deck-ledger'));
  const ledger = applyIncrementalResultToMainDeckLedger({ incrementalResult, log });
  if (!ledger) throw new Error('V5_LEDGER_REPAIR_COMMIT_REJECTED');
  return {
    revision: Number(after.revision || 0),
    mode: String(incrementalResult.mode || 'PASS'),
    inserted: (incrementalResult.insertedCards || []).map(item => ({
      id: String(item && item.card && item.card.id || ''),
      name: String(item && item.card && item.card.name || item && item.card && item.card.id || '')
    }))
  };
}

function loadPendingMalletCheckpoint(state) {
  if (!fs.existsSync(M11_RESUME_STATE_PATH)) return null;
  const checkpoint = readJson(M11_RESUME_STATE_PATH);
  if (!checkpoint || checkpoint.version !== 2 || !MALLET_RESUME_STATUSES.includes(checkpoint.status)) {
    throw new Error('V6_M11_PENDING_CHECKPOINT_INVALID');
  }
  const baselineIds = (checkpoint.baseline && checkpoint.baseline.cards || []).map(card => card.id).join('>');
  const handIds = (state && state.cards || []).map(card => card.id).join('>');
  if (!baselineIds || baselineIds !== checkpoint.baselineFingerprint || baselineIds !== handIds ||
      Number(checkpoint.baseline.handCount) !== Number(state.handCount)) {
    throw new Error('V6_M11_PENDING_BASELINE_MISMATCH');
  }
  committedSelectionState(checkpoint);
  return checkpoint;
}

async function resumePendingMalletAtDecision(state, rl) {
  const checkpoint = loadPendingMalletCheckpoint(state);
  if (!checkpoint) return null;
  console.log('万宝槌恢复锁：' + checkpoint.status + '；保留完整提交记录，禁止普通手牌建议。');
  console.log('当前内部手牌是发动前基线；回车只恢复万宝槌验收/剩余选择，q退出，不允许r重扫。');
  const answer = String(await rl.question('V6[万宝槌后续]> ')).trim().toLowerCase();
  if (['q', 'quit', 'exit'].includes(answer)) return { state, quit: true };
  if (answer !== '' && answer !== 'f') return { state, quit: false };
  assertFreshRuntimeBeforeGameAction();
  try {
    runExecutor(PRODUCTION_ENTRYPOINTS.M11, checkpoint.malletSlot, { id: 'M11', name: '万宝槌' },
      ['--keep=' + (checkpoint.keepIds || []).join(','), '--resume-current-selection']);
    state = loadObserverSessionState();
  } catch (error) {
    if (error && error.terminalVictory) {
      await confirmDetectedVictoryResult('V6_M11_RECOVERY_TERMINAL_VICTORY', rl);
      return { state, quit: true };
    }
    console.error('万宝槌后续停止：' + (error.stack || error));
    console.error('保留万宝槌恢复锁，不重新发动、不重选已提交牌、不进入普通手牌决策。');
  }
  return { state, quit: false };
}

async function resumePendingIncrementalAtDecision(state, rl) {
  const pending = loadPendingIncrementalObservation(state);
  if (!pending) return null;
  console.log('增量验收恢复锁：' + pending.activationKey + '已执行；仅恢复当前底部验收，不重新发动/支付费用、不重扫旧手牌。');
  const answer = String(await rl.question('V6[增量验收后续]> ')).trim().toLowerCase();
  if (['q', 'quit', 'exit'].includes(answer)) return { state, quit: true };
  if (answer !== '' && answer !== 'f') return { state, quit: false };
  assertFreshRuntimeBeforeGameAction();
  try {
    runExecutor('runtime/observer/run-live-incremental.js', pending.slot,
      { id: pending.activationKey, name: pending.activationKey + '结算验收' });
    fs.unlinkSync(PENDING_OBSERVER_PATH);
    return { state: loadObserverSessionState(), quit: false };
  } catch (error) {
    if (error && error.terminalVictory) {
      fs.unlinkSync(PENDING_OBSERVER_PATH);
      await confirmDetectedVictoryResult('V6_INCREMENTAL_RECOVERY_TERMINAL_VICTORY', rl);
      return { state, quit: true };
    }
    console.error('增量验收恢复停止：' + error.message + '；继续保留恢复锁。');
    return { state, quit: false };
  }
}

function loadCurrentDecisionWithoutRescan() {
  const state = loadObserverSessionState();
  const runtime = loadDecisionState();
  const pendingM18 = loadPendingM18Route();
  if (pendingM18) {
    throw new Error(`V5_CURRENT_DECISION_HAS_PENDING_M18:${pendingM18.status}`);
  }

  const node = String(runtime && runtime.v5Branch && runtime.v5Branch.currentState || '');
  if (isTransactionPendingNode(node)) {
    throw new Error(`V5_CURRENT_DECISION_IS_ATOMIC_TRANSACTION:${node}`);
  }

  const ledgerPath = path.join(ROOT, 'debug', 'main-deck-ledger', 'state.json');
  if (!fs.existsSync(ledgerPath)) {
    throw new Error('V5_CURRENT_DECISION_LEDGER_MISSING');
  }
  const ledger = readJson(ledgerPath);
  const stateRevision = Number(state.revision || 0);
  const ledgerRevision = Number(ledger.lastHandRevision || 0);
  if (stateRevision !== ledgerRevision) {
    throw new Error(
      `V5_CURRENT_DECISION_REVISION_MISMATCH:hand=${stateRevision};ledger=${ledgerRevision}`
    );
  }

  const handCounts = {};
  for (const card of state.cards || []) {
    handCounts[card.id] = Number(handCounts[card.id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(handCounts)) {
    const outside = id === EXODIA_UNKNOWN_ID
      ? Number(ledger.unknownExodiaOutsideCount || 0)
      : Number(ledger.outsideDeckCounts && ledger.outsideDeckCounts[id] || 0);
    if (count > outside) {
      throw new Error(
        `V5_CURRENT_DECISION_HAND_LEDGER_MISMATCH:${id};hand=${count};outside=${outside}`
      );
    }
  }

  return { state, runtime, ledger };
}

function cardAtUserSlot(state, slot) {
  const normalized = validateHandState(state, 'SELECT');
  if (!Number.isInteger(slot) || slot < 1 || slot > normalized.handCount) {
    throw new Error(`V5_SLOT_OUT_OF_RANGE:${slot};handCount=${normalized.handCount}`);
  }
  return normalized.cards[slot - 1];
}

async function establishOpeningState() {
  const { MdFastBridge } = require(path.join(ROOT, 'lib', 'win-fast'));
  const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
  const { establishCurrentObserverBaseline } = require(path.join(
    ROOT,
    'execution',
    'core',
    'observer-current-baseline'
  ));

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const baseline = await establishCurrentObserverBaseline({
      bridge,
      info: activation.info,
      outputDir: path.join(ROOT, 'debug', 'v5', 'opening')
    });
    return validateHandState(baseline, 'OPENING_BASELINE');
  } finally {
    await bridge.stop().catch(() => {});
  }
}

function resolveVerifiedExecutor(cardId) {
  const verified = readJson(VERIFIED_PATH);
  const record = verified && verified.cards && verified.cards[cardId];
  if (!record || !/^PASS|SEALED/.test(String(record.status || ''))) return null;
  if (!record.testEntry) return null;

  let relative = String(record.testEntry).replace(/\\/g, path.sep).replace(/\//g, path.sep);
  if (/\.cmd$/i.test(relative)) relative = relative.replace(/\.cmd$/i, '.js');

  // Stage 19 compatibility: verified registries created before production
  // layout cleanup may still point at execution/tests.
  const legacyPrefix = path.join('execution', 'tests') + path.sep;
  if (relative.startsWith(legacyPrefix)) {
    const candidate = path.join('execution', 'live', path.basename(relative));
    if (fs.existsSync(path.join(ROOT, candidate))) relative = candidate;
  }

  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) return null;
  return { relative, full, record };
}

function buildDecisionSuggestion(state) {
  const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
  const { collectActions } = require(path.join(ROOT, 'lib', 'decision-engine'));
  const { analyzeReachableResourceDeadlock } = require(path.join(ROOT, 'lib', 'deadlock-detector'));

  const library = loadLibrary(ROOT);
  const runtime = loadDecisionState();

  // V5 does not re-click every old card merely to refresh yellow-frame flags.
  // This is therefore a STRATEGIC suggestion, not an activation proof.
  // The selected executor still proves the actual card and its action button before clicking.
  const cardsForDecision = state.cards.map(card => ({
    ...card,
    usable: isStrategicallyUsable(card, state, runtime)
  }));

  const result = collectActions(cardsForDecision, library, runtime);
  let selected = result && result.selected ? result.selected : null;
  let strategicDeadlock = analyzeReachableResourceDeadlock({
    cards: state.cards,
    runtime,
    decisionResult: result
  });
  const rayeCloseout = strategicDeadlock.rayeCloseout || { ready: false };
  if (result.trueBambooGainPolicy && result.trueBambooGainPolicy.applied) {
    strategicDeadlock = { terminal: false, type: 'NONE', reason: 'PROVEN_TRUE_BAMBOO_GAIN_ROUTE' };
  }
  if (strategicDeadlock.terminal === true) selected = null;
  const lastResortAllure = buildLastResortAllureAction(state.cards, result, strategicDeadlock);
  if (lastResortAllure) {
    selected = lastResortAllure;
    result.actions = [...result.actions, lastResortAllure];
    result.selected = lastResortAllure;
    strategicDeadlock = { terminal: false, type: 'NONE', reason: 'LAST_RESORT_ALLURE_RAYE_CHANCE',
      prerequisite: strategicDeadlock };
  }

  // Dedicated live regression route: start from any opening-hand size as long
  // as both Raye and True Bamboo are present.  Force only the first strategic
  // choice (normal summon Raye); every later transition uses the same formal
  // V5 atomic states and executors as production.
  if (
    runtime.v5TestMode === 'RAYE_TRUE_DUAL' &&
    runtime.normalSummonUsed !== true &&
    !knownNonRayeMonsterPresent(runtime)
  ) {
    const raye = state.cards.find(card => card.id === 'M06');
    const trueSword = state.cards.find(card => card.id === 'M20');
    if (raye && trueSword) {
      selected = {
        slot: raye.index,
        id: raye.id,
        name: raye.name,
        tier: -100,
        reason: '双效果专项测试：只强制测试入口先通常召唤零衣；之后完全进入正式真刀→妖刀→零梦逐原子状态机。',
        details: { v5TestMode: 'RAYE_TRUE_DUAL' }
      };
    }
  }

  // Dedicated fresh-duel regression: force only Hornet as the entry action.
  // Every following step is the production B1/T20-1/T20-2/T20-3/Y1 atom.
  if (
    runtime.v5TestMode === 'HORNET_TRUE_YOTO_LINK' &&
    Number(runtime.usedCounts && runtime.usedCounts.M22 || 0) <= 0
  ) {
    const hornet = state.cards.find(card => card.id === 'M22');
    const trueSword = state.cards.find(card => card.id === 'M20');
    const reservedYoto = state.cards.find(card => card.id === 'M19');
    if (hornet && trueSword && reservedYoto) {
      selected = {
        slot: hornet.index,
        id: hornet.id,
        name: hornet.name,
        tier: -100,
        reason: '黄蜂真刀妖刀专项测试：只强制入口发动黄蜂；Y1现场选择任意合法非火刀。',
        details: { v5TestMode: 'HORNET_TRUE_YOTO_LINK' }
      };
    }
  }

  // M21 may already be face-up with its draw-1 intentionally deferred.  The field
  // draw is a random +1, so fixed searches/recoveries must still go first:
  // Toon Table(P0), Hornet->Kagari fixed recovery(P0.5), Engage(P1).  Once those
  // are gone, resume the already-earned M21 draw before ordinary hand draw/filter actions.
  if (runtime.chickenGameDrawPending === true) {
    const pending = {
      specialAction: 'M21_FIELD_DRAW',
      id: 'M21',
      name: '试胆竞速',
      tier: 1.5,
      reason: '场上试胆竞速的抽1此前为固定检索让路；当前没有更高优先级的固定检索/回收动作，先把这次场上抽1结算。',
      details: { pendingFieldDraw: true }
    };
    if (!selected || Number(selected.tier) > pending.tier) selected = pending;
  }

  // A productive double-material Zero is a current gain route once the
  // shared sword plan is finished. Fixed searches still outrank it.
  const lastGoldenMalletException = selected && selected.id === 'M11' &&
    Number(result && result.deck && result.deck.deckRemaining && result.deck.deckRemaining.M14) === 1 &&
    (rayeCloseout.source === 'GRAVE' || rayeCloseout.sourcePolicy?.deckEngagePreferred === true);

  // ISSUE-111: ISSUE-061 correctly forbids using Raye's own effect while
  // another monster remains, because that direct summon can put E10 in a Main
  // Monster Zone and keep Engage blocked.  It did not expose the already
  // verified R7 route that consumes BOTH the existing Extra-Zone Link and the
  // newly normal-summoned Raye as materials for E10.  Offer that route only
  // when it deterministically recovers a real GY Engage with bonus draw live.
  if ((!selected || lastGoldenMalletException || Number(selected.tier) > 2.5) && strategicDeadlock.terminal !== true) {
    const raye = state.cards.find(card => card.id === 'M06');
    const branch = runtime.v5Branch && typeof runtime.v5Branch === 'object'
      ? runtime.v5Branch
      : {};
    const carrierId = String(branch.carrierId || branch.carrierCardId || '');
    const engageTargets = Array.isArray(result && result.engageTargets)
      ? result.engageTargets
      : [];
    const routeReady = rayeCloseout.ready && rayeCloseout.mode === 'DOUBLE_LINK';
    if (routeReady) {
      selected = {
        slot: raye.index,
        id: raye.id,
        name: raye.name,
        tier: 2.5,
        reason:
          (lastGoldenMalletException ? '牌组恰好只剩一张金竹，按浮动优先级先兑现零梦交闪抽1；' : '') +
          `当前额外怪兽区已有${carrierId}，通常召唤尚未使用，且${rayeCloseout.source === 'GRAVE' ? '墓地交闪可回收' : '牌组交闪可检索'}。` +
          '通召零衣后用两只怪兽Link零梦，必须把现有Link和零衣都作为素材；' +
          '零梦取得交闪，再发动交闪检索并追加抽1。',
        details: {
          phase: 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY',
          existingCarrierId: carrierId,
          e10EngageSource: rayeCloseout.source,
          engageTargets,
          graveSpellCount: Number(runtime.graveSpellCount || 0)
        }
      };
    }
  }

  // The legacy decision engine was intentionally magic-only. If it has no magic
  // suggestion but Raye exists, expose Raye as a reviewable fallback rather than
  // pretending the decision layer has nothing to say.
  if ((!selected || (lastGoldenMalletException && selected.id === 'M11' && rayeCloseout.bonusDraw)) &&
      strategicDeadlock.terminal !== true) {
    const raye = state.cards.find(card => card.id === 'M06');
    if (
      raye &&
      rayeCloseout.ready && rayeCloseout.mode === 'DIRECT' &&
      runtime.normalSummonUsed !== true &&
      !knownNonRayeMonsterPresent(runtime)
    ) {
      selected = {
        slot: raye.index,
        id: raye.id,
        name: raye.name,
        reason:
          (lastGoldenMalletException ? '牌组恰好只剩一张金竹且交闪追加抽1路线可用，先于万宝；' :
            '普通抽牌/滤抽和固定资源动作都走完、且我方场上没有其它怪兽时，') +
          '零衣才作为低优先级收尾入口；通招后保持零衣为唯一怪兽，再考虑直出零梦。',
        v5Fallback: true
      };
    }
  }


  return { result, selected, runtime, strategicDeadlock };
}

function shortExtraForDecision(selected) {
  const details = selected && selected.details || {};
  if (details.searchTarget) return `；目标建议=${details.searchTarget.name}`;
  if (details.discardTarget) return `；代价建议=${details.discardTarget.name}`;
  if (details.banishTarget) return `；除外建议=${details.banishTarget.name}`;
  if (details.mallet) {
    const keep = Array.isArray(details.mallet.keepNames) ? details.mallet.keepNames.join('/') : '';
    return `；万宝保护=${keep || '无'}`;
  }
  return '';
}

function printDecisionPoint(state, title = '下一步', simpleAuto = null) {
  const normalized = validateHandState(state, 'DECISION_POINT');
  const suggestion = buildDecisionSuggestion(normalized);
  const automatic = simpleAuto && simpleAuto.inspect(normalized, suggestion).automatic === true;
  const fieldAction = currentFieldActionLabel();
  console.log('\n------------------------------------------------------------');
  console.log(`${title}：当前内部手牌=${normalized.handCount}张（不重新逐张扫描）`);
  if (suggestion.strategicDeadlock && suggestion.strategicDeadlock.terminal === true) {
    const deadlock = suggestion.strategicDeadlock;
    const searchable = deadlock.searchable || {};
    console.log('必定死局：所有当前合法动作及固定检索/回收路线都无法再产生抽牌资源。');
    console.log(`  主卡组剩余=${deadlock.deckRemaining}；手牌没有可结算的抽牌动作。`);
    if (searchable.engage) {
      console.log(
        `  交闪牌组目标：零衣=${searchable.engage.M06}, H.A.M.P.=${searchable.engage.M08}, ` +
        `大黄蜂=${searchable.engage.M22}。`
      );
    }
    if (searchable.toon) {
      console.log(`  目录牌组目标：卡通目录=${searchable.toon.M10}, 青眼卡通龙=${searchable.toon.M07}。`);
    }
    if (searchable.bamboo) {
      console.log(`  竹光牌组目标：妖刀=${searchable.bamboo.M19}, 真刀=${searchable.bamboo.M20}。`);
    }
    if ((deadlock.legalButUnproductive || []).length) {
      console.log(`  仍可点击但无资源收益：${[...new Set(deadlock.legalButUnproductive)].join(', ')}；不再误判为续行。`);
    }
    console.log('输入 x 一次即可投降并确认结果页；输入 q 退出V6。');
    suggestion.deadEnd = true;
  } else if (suggestion.selected) {
    if (suggestion.selected.specialAction === 'KAGARI_LINK_BEFORE_TRUE') {
      console.log('我的建议：装真刀前，先用当前未装备的非火刀Link篝');
      console.log(`原因：${suggestion.selected.reason}`);
      console.log('回车=只执行Link并验收效果池；回收交闪与装刀仍分别执行原子节点。');
    } else if (suggestion.selected.specialAction === 'M21_FIELD_DRAW') {
      console.log('我的建议：继续场上试胆竞速[M21]尚未使用的“抽1”效果');
      console.log(`原因：${suggestion.selected.reason}`);
      console.log(automatic ? '简单抽牌自动接续：直接结算场上抽1。'
        : '回车=采用我的建议并只执行场上抽1；输入数字=改用你指定的当前手牌。');
    } else {
      console.log(
        `我的建议：手牌${suggestion.selected.slot} ${suggestion.selected.name}[${suggestion.selected.id}]` +
        shortExtraForDecision(suggestion.selected)
      );
      console.log(`原因：${suggestion.selected.reason || '按当前决策层优先级排序。'}`);
      console.log(automatic ? '简单抽牌自动接续：按现有优先级执行，完成验收后再判断下一张。'
        : '回车=采用我的建议；输入数字=改用你指定的当前手牌。');
    }
  } else if (!fieldAction) {
    const runtime = suggestion.runtime || loadDecisionState();
    const lockedGolden = normalized.cards.filter(card => card.id === 'M14').length;
    const hasRaye = normalized.cards.some(card => card.id === 'M06');
    console.log('当前没有可执行的手牌节点或已提交场上续行；尚未取得完整死局证明。');
    if (lockedGolden > 0 && runtime.bambooSwordEquipped !== true) {
      console.log(`  金黄色的竹光[M14] x${lockedGolden}：场上没有竹光装备，不能发动。`);
    }
    if (!hasRaye) console.log('  手牌没有闪刀姬－零衣[M06]，不存在零衣通常召唤入口。');
    else if (runtime.normalSummonUsed === true) console.log('  零衣虽然在手，但本回合通常召唤已经使用。');
    console.log('本轮不会自动点击任何牌。输入 r 可重建现场；输入 q 可退出V6。');
    suggestion.deadEnd = true;
  } else {
    console.log('当前没有新的手牌动作；请用 f 继续已经提交的场上节点。');
  }
  if (fieldAction) console.log(`场上续行：输入 f = ${fieldAction}`);
  console.log('------------------------------------------------------------');
  return suggestion;
}

function printInternalHand(state) {
  const normalized = validateHandState(state, 'PRINT');
  console.log('\n当前V6内部手牌：');
  normalized.cards.forEach((card, index) => {
    console.log(`  ${index + 1}. ${card.name}[${card.id}]`);
  });
}

function printPendingM18Route(route) {
  console.log('\n============================================================');
  console.log('V6确定性支线锁定：愚蠢的重葬[M18]尚未完整结算。');
  console.log(`当前内部阶段=${route.status}`);
  console.log('M18不是新的战略决策：送迦楼拉 -> 确认 -> 迦楼拉效果 -> 确认 -> 抽1 -> observer，必须作为同一个动作闭环。');
  console.log('此时禁止选择其他手牌，避免在额外卡组/效果窗口中误操作。');
  console.log('回车/c = 继续当前M18支线；r = 放弃该支线状态并重新完整观察；q = 退出。');
  console.log('============================================================');
}

function assertFreshRuntimeBeforeGameAction() {
  try {
    return RUNTIME_SOURCE_FRESHNESS.assertFresh();
  } catch (error) {
    const pending = isTransactionPendingNode(currentAtomicNode());
    const resume = pending ? '--resume-current-atomic' : '--resume-current-decision';
    throw new Error(
      `${error.message};旧Node进程已停止在发送游戏输入之前。` +
      `请退出后执行 .\\run-v6.cmd ${resume}，让磁盘上的新代码重新载入。`
    );
  }
}

function runExecutor(relativeScript, slot, card, extraArgs = [], options = {}) {
  const full = path.join(ROOT, relativeScript);
  if (!fs.existsSync(full)) throw new Error(`V5_EXECUTOR_NOT_FOUND:${relativeScript}`);

  console.log(`\nV6执行：手牌${slot} ${card.name}[${card.id}]`);

  const decisionBefore = loadDecisionState();
  const logBefore = snapshotDuelLogForCard(card);
  const outcomeBefore = snapshotVictoryOutcome();
  const victoryRisk = exodiaVictoryRisk(relativeScript, card, extraArgs);
  if (victoryRisk && victoryRisk.possible) {
    console.log(
      `艾克佐迪亚胜利风险门: 当前不同组件=${victoryRisk.heldCount}/5 ` +
      `(${victoryRisk.held.join(',')}); 牌组剩余=${victoryRisk.deckRemaining == null ? '?' : victoryRisk.deckRemaining}; ` +
      `本动作实际抽牌容量=${victoryRisk.randomDraws}; ` +
      `类型=${victoryRisk.guaranteed ? '必然胜利' : '可能胜利'}。`
    );
    console.log('本动作结算后先纯等待胜利动画，再被动轮询成熟VICTORY判断；期间禁止右栏滚动。');
  }
  const out = spawnSync(
    process.execPath,
    ['--require', PRELOAD_PATH, full, ...extraArgs],
    {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: false,
      env: {
        ...process.env,
        MD_V5_REUSE_BASELINE: '1',
        // ISSUE-076: every production executor is one bounded atom. Its nested
        // incremental observer may validate only the current bottom result.
        MD_V5_ATOMIC_OBSERVER: '1',
        MD_V5_SELECTED_SLOT: String(slot),
        MD_V5_SELECTED_CARD_ID: card.id,
        MD_V5_SELECTED_CARD_NAME: card.name,
        MD_V5_EXODIA_VICTORY_RISK: victoryRisk && victoryRisk.possible ? '1' : '0',
        MD_V5_EXODIA_VICTORY_CERTAIN: victoryRisk && victoryRisk.guaranteed ? '1' : '0',
        MD_V5_EXODIA_COMPONENT_COUNT: String(victoryRisk && victoryRisk.heldCount || 0),
        MD_V5_RANDOM_DRAW_CAPACITY: String(victoryRisk && victoryRisk.randomDraws || 0)
      }
    }
  );

  if (out.error) throw out.error;
  const outcomeAfter = snapshotVictoryOutcome();
  if (outcomeAfter.terminal && outcomeAfter.mtimeMs > outcomeBefore.mtimeMs) {
    const ordinarySettlement = voidOrdinarySettlement(outcomeAfter.result, {
      status: out.status === 0 ? 'PROCESS_RETURNED_ZERO' : 'PROCESS_FAILED',
      exitCode: out.status, action: { id: card.id, name: card.name, slot, script: relativeScript }
    });
    writeJsonAtomic(path.join(ROOT, 'debug', 'v5', 'last-settlement-void.json'), ordinarySettlement,
      { trailingNewline: true });
    console.log('已独立确认对局胜利：最后一次普通结算验收作废，不计动作成功/失败，不提交普通手牌记账。');
    if (extraArgs.includes('--last-resort-raye')) {
      const pending = loadLastResortAllureState();
      if (isLastResortAllurePending(pending)) {
        writeJsonAtomic(ALLURE_LAST_RESORT_STATE_PATH, { ...pending, stage: 'COMPLETE_VICTORY',
          result: { status: 'TERMINAL_VICTORY', terminalOutcome: outcomeAfter.result },
          updatedAt: new Date().toISOString() });
      }
    }
    const terminal = new Error('V5_DUEL_TERMINAL_VICTORY');
    terminal.terminalVictory = true;
    terminal.outcome = outcomeAfter.result;
    terminal.ordinarySettlement = ordinarySettlement;
    throw terminal;
  }
  if (out.status !== 0) {
    const error = new Error(
      `V5_EXECUTOR_FAILED:${card.id};exit=${out.status == null ? 'UNKNOWN' : out.status}`
    );
    error.failClosed = true;

    const logAfter = snapshotDuelLogForCard(card);
    error.resolvedActionEvidence = Boolean(
      AUTO_RESYNC_AFTER_RESOLVED_IDS.has(card.id) &&
      logAfter.exists &&
      logAfter.mtimeMs > logBefore.mtimeMs &&
      logAfter.mentions > logBefore.mentions
    );
    error.failedCard = { id: card.id, name: card.name };
    if (error.resolvedActionEvidence) {
      console.error(
        `V6恢复证据：右栏最新结果已新增本次 ${card.name}[${card.id}] 记录；` +
        '判定“游戏动作已结算，但增量手牌observer未能闭环”。'
      );
    }
    throw error;
  }

  if (extraArgs.includes('--last-resort-raye')) {
    const completed = loadLastResortAllureState();
    if (completed && completed.stage === 'COMPLETE_SURRENDER') {
      console.log('诱惑最后尝试没有安全暗属性，成熟投降已完成；本局立即结束，不再运行手牌observer。');
      return { terminalSurrender: true, result: completed.result };
    }
    if (!completed || !['COMPLETE_RAYE', 'COMPLETE_HAMP'].includes(completed.stage)) {
      throw new Error('M13_LAST_RESORT_COMPLETION_NOT_PROVEN');
    }
  }

  if (!options.skipDecisionUpdate) updateDecisionStateAfterSuccess(card, decisionBefore);
}


function incrementUsedCount(state, id) {
  if (!id || !/^M\d+$/.test(String(id))) return;
  state.usedCounts = { ...(state.usedCounts || {}) };
  state.usedCounts[id] = Number(state.usedCounts[id] || 0) + 1;
}

function updateDecisionStateAfterSuccess(card, beforeState) {
  let state = loadDecisionState();
  const externalChanged = JSON.stringify(state) !== JSON.stringify(beforeState);

  // Even when a mature route changed its own decision-state fields, keep those changes.
  // Fill only the generic accounting that the single-card executors usually do not own.
  let incremental = null;
  try {
    if (fs.existsSync(INCREMENTAL_PATH)) incremental = readJson(INCREMENTAL_PATH);
  } catch (_) {}

  // 万宝槌把其它手牌返回牌组，不等于那些牌“被使用/进入墓地”。
  // 只记录万宝槌自身；返回牌会通过FULL RESYNC后的真实手牌自然重新计入deckRemaining。
  if (card.id === 'M11') {
    incrementUsedCount(state, 'M11');
    state.graveSpellCount = Number(state.graveSpellCount || 0) + 1;
    writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
    return;
  }

  if (card.id === 'M13') {
    const { accountM13DecisionState } = require(path.join(ROOT, 'lib', 'm13-observer-verification'));
    const log = readJson(path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json'));
    state = accountM13DecisionState({ state, log, incremental });
    writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
    return;
  }

  if (card.id === 'M21' && state.effectUsageMeta?.M21_DRAW?.fieldPlacementTransaction) {
    // The staged executor owns placement and draw accounting. Never increment
    // the activation count or replacement grave spell a second time.
    return;
  }

  const removedIds = [];
  const consumed = incremental && incremental.inference && incremental.inference.consumed;
  if (consumed && consumed.id) removedIds.push(consumed.id);
  const costs = incremental && incremental.inference && incremental.inference.costConsumed;
  if (Array.isArray(costs)) {
    for (const item of costs) if (item && item.id) removedIds.push(item.id);
  }

  if (!removedIds.includes(card.id)) removedIds.unshift(card.id);
  for (const id of removedIds) incrementUsedCount(state, id);

  if (card.id === 'M06') {
    state.rayeNormalSummoned = true;
    state.normalSummonUsed = true;
  }

  if (GRAVE_AFTER_RESOLVE.has(card.id)) {
    state.graveSpellCount = Number(state.graveSpellCount || 0) + 1;
  } else if (card.id === 'M21') {
    if (!externalChanged) {
      if (state.fieldSpell === 'M21') {
        state.graveSpellCount = Number(state.graveSpellCount || 0) + 1;
      }
      state.fieldSpell = 'M21';
      state.chickenGameDrawUsed = true;
      state.chickenGameDrawPending = false;
    }
  }

  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
}

function m21ReplacementUnlocksEngage(state) {
  const runtime = loadDecisionState();
  if (runtime.fieldSpell !== 'M21') return null;

  const graveAfterReplacement = Number(runtime.graveSpellCount || 0) + 1;
  if (graveAfterReplacement < 3) return null;

  const engage = normalizeCards(state).find(card => card.id === 'M17');
  if (!engage) return null;

  const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
  const { buildDeckState, searchableEngageTargets } = require(path.join(ROOT, 'lib', 'decision-engine'));
  const library = loadLibrary(ROOT);
  const deck = buildDeckState(library, state.cards, runtime);
  const targets = searchableEngageTargets(deck, runtime);
  if (!targets.length) return null;

  return {
    engage,
    targets,
    graveBefore: Number(runtime.graveSpellCount || 0),
    graveAfter: graveAfterReplacement
  };
}

function commitM21FieldOnlyAccounting(beforeRuntime) {
  const state = loadDecisionState();
  if (state.effectUsageMeta?.M21_DRAW?.fieldPlacementTransaction &&
      state.effectUsageMeta.M21_DRAW.fieldPlacementTransaction !== beforeRuntime.effectUsageMeta?.M21_DRAW?.fieldPlacementTransaction) return state;
  incrementUsedCount(state, 'M21');
  if (beforeRuntime.fieldSpell === 'M21') {
    state.graveSpellCount = Number(beforeRuntime.graveSpellCount || 0) + 1;
  } else {
    state.graveSpellCount = Number(beforeRuntime.graveSpellCount || 0);
  }
  state.fieldSpell = 'M21';
  state.chickenGameDrawUsed = false;
  state.chickenGameDrawPending = true;
  state.effectUsageMeta = {
    ...(state.effectUsageMeta || {}),
    M21_DRAW: {
      pending: true,
      source: 'V5_FIELD_REPLACEMENT_UNLOCKED_FIXED_SEARCH',
      updatedAt: new Date().toISOString()
    }
  };
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  return state;
}

function commitM21PendingDrawResolved() {
  const state = loadDecisionState();
  state.chickenGameDrawPending = false;
  state.chickenGameDrawUsed = true;
  state.effectUsageMeta = {
    ...(state.effectUsageMeta || {}),
    M21_DRAW: {
      pending: false,
      resolved: true,
      source: 'V5_DEFERRED_FIELD_DRAW_RESOLVED',
      updatedAt: new Date().toISOString()
    }
  };
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  return state;
}

function runPendingM21DrawExecutor() {
  const full = path.join(ROOT, M21_EXECUTOR_PATH);
  if (!fs.existsSync(full)) throw new Error(`V5_EXECUTOR_NOT_FOUND:${M21_EXECUTOR_PATH}`);

  const outcomeBefore = snapshotVictoryOutcome();
  console.log('\nV6执行：继续场上试胆竞速[M21]此前搁置的抽1。');
  const out = spawnSync(process.execPath, [full, '--v5-draw-only'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
    env: {
      ...process.env,
      MD_V5_ATOMIC_OBSERVER: '1',
      MD_V5_EXPECTED_ATOMIC_ACTIVATION: 'M21'
    }
  });
  const outcomeAfter = snapshotVictoryOutcome();
  if (outcomeAfter.terminal && outcomeAfter.mtimeMs > outcomeBefore.mtimeMs) {
    const error = new Error('V5_DUEL_TERMINAL_VICTORY');
    error.terminalVictory = true; error.outcome = outcomeAfter.result; throw error;
  }
  if (out.error) throw out.error;
  if (out.status !== 0) {
    const error = new Error(`V5_M21_DRAW_CONTINUATION_FAILED:exit=${out.status == null ? 'UNKNOWN' : out.status}`);
    error.failClosed = true;
    throw error;
  }
  commitM21PendingDrawResolved();
  return loadObserverSessionState();
}

async function resumePendingM21AtDecision(state, rl) {
  const pending = loadPendingM21Transaction();
  if (!pending) return null;
  console.log('\nM21未完成阶段=' + pending.stage + '；回车只恢复后续，q退出；禁止重放手牌/完整扫描。');
  const raw = String(await rl.question('\nV6[M21后续]> ')).trim().toLowerCase();
  if (raw === 'q') return { state, quit: true };
  if (raw !== '' && raw !== 'f') return { state };
  assertFreshRuntimeBeforeGameAction();
  const outcomeBefore = snapshotVictoryOutcome();
  try {
    const out = spawnSync(process.execPath, [path.join(ROOT, M21_EXECUTOR_PATH), '--resume-m21-stage'], {
      cwd: ROOT, stdio: 'inherit', windowsHide: false,
      env: { ...process.env, MD_V5_ATOMIC_OBSERVER: '1', MD_V5_EXPECTED_ATOMIC_ACTIVATION: 'M21' }
    });
    const outcomeAfter = snapshotVictoryOutcome();
    if (outcomeAfter.terminal && outcomeAfter.mtimeMs > outcomeBefore.mtimeMs) return { state, terminalVictory: true };
    if (out.error) throw out.error;
    if (out.status !== 0) throw new Error('M21_STAGE_RESUME_FAILED:' + out.status);
  } catch (error) { console.error('M21后续停止：' + error.message + '；保留阶段，不重放输入。'); }
  return { state: loadObserverSessionState() };
}

function decrementUsedCount(state, id) {
  state.usedCounts = { ...(state.usedCounts || {}) };
  const current = Number(state.usedCounts[id] || 0);
  if (current <= 1) delete state.usedCounts[id];
  else state.usedCounts[id] = current - 1;
}

function commitKagariRecoveryAccounting(cardId) {
  const state = loadDecisionState();
  decrementUsedCount(state, cardId);
  state.graveSpellCount = Math.max(0, Number(state.graveSpellCount || 0) - 1);
  state.effectUsage = state.effectUsage || {};
  state.effectUsage.KAGARI_RECOVERY = Number(state.effectUsage.KAGARI_RECOVERY || 0) + 1;
  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  console.log(`决策状态同步：${cardId}已从墓地回手；墓地魔法数 -> ${state.graveSpellCount}`);
  return state;
}

function canRecoverEngageAfterHornet(runtime) {
  return Number(runtime && runtime.usedCounts && runtime.usedCounts.M17 || 0) > 0;
}


function rebaselineDuelLogCurrentBottom(label = 'CURRENT_STABLE_POINT') {
  console.log(
    `\n右栏连续性重建：${label}。` +
    '当前手牌/确定性支线已经验收完成，只把当前右栏底部设为新的历史基线；不执行卡牌操作。'
  );
  const out = spawnSync(
    process.execPath,
    [path.join(ROOT, 'runtime/observer/test-duel-log-live.js'), '--rebaseline-current-bottom'],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true }
  );
  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(
      `V5_DUEL_LOG_REBASELINE_FAILED:${label};exit=${out.status == null ? 'UNKNOWN' : out.status}`
    );
  }
  console.log(`右栏连续性重建 PASS：${label}；下一动作不再向上追该节点之前的旧 checkpoint。`);
}

function latestResolvedM17BonusAttempt() {
  if (!fs.existsSync(M17_BONUS_EXECUTION_ROOT)) {
    throw new Error('V5_M17_RESUME_NO_EXECUTION_ROOT');
  }

  const dirs = fs.readdirSync(M17_BONUS_EXECUTION_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(M17_BONUS_EXECUTION_ROOT, entry.name);
      const evidencePath = path.join(dir, 'execution_click.json');
      if (!fs.existsSync(evidencePath)) return null;
      try {
        const stat = fs.statSync(evidencePath);
        return { dir, evidencePath, mtimeMs: stat.mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!dirs.length) throw new Error('V5_M17_RESUME_NO_EXECUTION_CLICK_EVIDENCE');

  const latest = dirs[0];
  const evidence = readJson(latest.evidencePath);
  const selected = evidence && evidence.searchProof && evidence.searchProof.selected;
  const bonus = evidence && evidence.bonusProof;

  if (!selected || !/^M(?:06|08|22)$/.test(String(selected.id || ''))) {
    throw new Error('V5_M17_RESUME_SEARCH_PROOF_INVALID');
  }
  if (!bonus || bonus.detected !== true || bonus.clicked !== true) {
    throw new Error('V5_M17_RESUME_BONUS_PROOF_INVALID');
  }

  return {
    ...latest,
    attemptId: path.basename(latest.dir),
    evidence,
    selected
  };
}

function repairResolvedM17DecisionAccounting(attempt) {
  const state = loadDecisionState();
  state.effectUsageMeta = { ...(state.effectUsageMeta || {}) };

  const oldMeta = state.effectUsageMeta.M17_RESOLVED_OBSERVER_RECOVERY || {};
  const applied = Array.isArray(oldMeta.appliedAttemptIds)
    ? [...oldMeta.appliedAttemptIds]
    : [];

  if (applied.includes(attempt.attemptId)) {
    console.log(`M17恢复记账已存在: ${attempt.attemptId}；不重复记账。`);
    return state;
  }

  incrementUsedCount(state, 'M17');
  state.graveSpellCount = Number(state.graveSpellCount || 0) + 1;
  applied.push(attempt.attemptId);

  state.effectUsageMeta.M17_RESOLVED_OBSERVER_RECOVERY = {
    appliedAttemptIds: applied.slice(-8),
    lastAttemptId: attempt.attemptId,
    searchedId: attempt.selected.id,
    searchedName: attempt.selected.name,
    updatedAt: new Date().toISOString()
  };

  writeJsonAtomic(DECISION_STATE_PATH, state, { trailingNewline: true });
  console.log(
    `M17已结算但observer失败的记账修复 PASS：usedCounts[M17]=${state.usedCounts.M17}; ` +
    `墓地魔法=${state.graveSpellCount}; 本次检索=${attempt.selected.name}[${attempt.selected.id}]。`
  );
  return state;
}

function malletPolicyForState(state) {
  const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
  const { buildDeckState, buildMalletKeepPolicy } = require(path.join(ROOT, 'lib', 'decision-engine'));
  const library = loadLibrary(ROOT);
  const runtime = loadDecisionState();
  const deck = buildDeckState(library, state.cards, runtime);
  return buildMalletKeepPolicy(deck, state.cards, runtime);
}

async function executeFieldTransition({
  state,
  rl,
  recoverClosedD4 = false,
  recoverResolvedKagari = false
}) {
  const runtime = loadDecisionState();
  const branch = runtime.v5Branch || {};
  const node = String(branch.currentState || '');
  const carrierId = branchCarrierId(branch);

  // IMPORTANT: every branch below performs exactly ONE atomic transition and
  // returns immediately after COMMIT.  No branch falls through to a next node.

  if (node === 'RAYE_E10_SELECTED_PENDING') {
    const equippedYoto = branch.equippedYoto !== false;
    await runSelectedRayeE10SubmitToOptionalAtomic({ state, equippedYoto });
    if (equippedYoto) {
      setAtomicBranch('DUAL_OPTIONAL_PENDING', {
        carrierId: 'E10',
        summonMode: 'RAYE_DIRECT',
        preResolutionHandCount: state.handCount,
        source: 'FORMAL_V5_R1S_RECOVERY'
      });
      console.log('STATE COMMIT: DUAL_OPTIONAL_PENDING');
    } else {
      setAtomicBranch('E10_OPTIONAL_PENDING', {
        carrierId: 'E10',
        source: 'FORMAL_V5_R1S_RECOVERY'
      });
      console.log('STATE COMMIT: E10_OPTIONAL_PENDING');
    }
    return { executed: true, state, quit: false };
  }

  if (node === 'HORNET_TOKEN_READY') {
    const combined = await prepareSwordForPlannedKagari(state, runtime, 'TOKEN_SKY_STRIKER');
    if (combined) return combined;
    const bambooPlan = hornetTrueYotoWindPlan(state, runtime);
    if (bambooPlan) {
      const planned = state.cards.find(card => card && card.id === bambooPlan.plannedSwordId);
      if (!planned) throw new Error(`V5_HORNET_BAMBOO_PLANNED_SWORD_MISSING:${bambooPlan.plannedSwordId}`);
      const debugDir = path.join(
        ROOT, 'debug', 'execution', 'V5_formal_atomic',
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${bambooPlan.plannedSwordId}_to_hornet_token`
      );
      console.log(
        bambooPlan.plannedSwordId === 'M19'
          ? '\n原子B1Y：只把手牌妖刀装备给中央黄蜂衍生物；随后由非火刀Link送墓并检索真刀。'
          : '\n原子B1：只把手牌真刀装备给中央黄蜂衍生物；手牌妖刀保留给非火刀Link后抽2。'
      );
      const equipped = await equipSwordFromHand({
        state,
        cardId: bambooPlan.plannedSwordId,
        cardName: planned.name,
        debugDir,
        requiredCarrierKind: 'CENTRAL_MAIN'
      });
      commitSwordEquipped(bambooPlan.plannedSwordId, equipped.carrier, {
        carrierId: 'TOKEN_SKY_STRIKER',
        source: bambooPlan.plannedSwordId === 'M19'
          ? (bambooPlan.hornetYotoFixedSearch === true
              ? 'FORMAL_V5_HORNET_YOTO_FIXED_SEARCH'
              : 'FORMAL_V5_HORNET_YOTO_TRUE_YOTO_GOLDEN')
          : 'FORMAL_V5_HORNET_TRUE_YOTO_WIND',
        extra: bambooPlan
      });
      console.log(
        bambooPlan.plannedSwordId === 'M19'
          ? (bambooPlan.hornetYotoFixedSearch === true
              ? 'STATE COMMIT: M19_EQUIPPED (Hornet -> Yoto -> non-Kagari Link -> fixed True-Bamboo search)'
              : 'STATE COMMIT: M19_EQUIPPED (Hornet -> Yoto -> non-Kagari Link -> search True -> deck Yoto -> Golden draw2)')
          : 'STATE COMMIT: M20_EQUIPPED (Hornet -> True -> deck Yoto -> any non-Kagari single Link)'
      );
      return { executed: true, state: equipped.state, quit: false };
    }
    console.log('\n原子H1：衍生物 -> Link篝；只验收H1，随后RETURN。');
    setAtomicBranch('HORNET_KAGARI_LINK_IN_FLIGHT');
    const commit = () => setAtomicBranch('KAGARI_EFFECT_PENDING', { carrierId: 'E02', source: 'FORMAL_V5_H1_POOL_PROVEN' });
    await runHornetTokenToKagariLinkAtomic({ state, onOptionalPoolProven: commit });
    commit();
    console.log('STATE COMMIT: KAGARI_EFFECT_PENDING');
    return { executed: true, state, quit: false };
  }

  if (node === 'POST_E10_HORNET_TOKEN_READY') {
    const plannedSwordId = String(branch.plannedSwordId || '');
    if (!['M19', 'M20'].includes(plannedSwordId)) {
      throw new Error(`POST_E10_HORNET_SWORD_PLAN_INVALID:${plannedSwordId || 'NONE'}`);
    }
    const planned = state.cards.find(card => card && card.id === plannedSwordId);
    if (!planned) throw new Error(`POST_E10_HORNET_SWORD_NOT_IN_HAND:${plannedSwordId}`);
    const debugDir = path.join(
      ROOT, 'debug', 'execution', 'V5_formal_atomic',
      `${new Date().toISOString().replace(/[:.]/g, '-')}_${plannedSwordId}_to_hornet_token`
    );
    console.log(`\n原子EH1：只把${planned.name}[${plannedSwordId}]装备给中央黄蜂衍生物；零梦不是目标。`);
    const equipped = await equipSwordFromHand({
      state,
      cardId: plannedSwordId,
      cardName: planned.name,
      debugDir,
      requiredCarrierKind: 'CENTRAL_MAIN'
    });
    commitSwordEquipped(plannedSwordId, equipped.carrier, {
      carrierId: 'TOKEN_SKY_STRIKER',
      source: 'FORMAL_V5_POST_E10_HORNET_SWORD_EQUIP',
      extra: { postE10HornetBambooDraw2: true }
    });
    console.log(`STATE COMMIT: ${plannedSwordId === 'M20' ? 'M20_EQUIPPED' : 'M19_EQUIPPED'} (post-E10 Hornet Bamboo draw2)`);
    return { executed: true, state: equipped.state, quit: false };
  }

  if (node === 'M19_EQUIP_TARGET_PENDING') {
    const equipped = await resumeSwordEquipTargetAtomic({
      state,
      cardId: 'M19',
      expectedCarrierId: 'E02'
    });
    commitSwordEquipped('M19', equipped.carrier, {
      carrierId: 'E02',
      source: 'FORMAL_V5_RESUME_EQUIP_TARGET'
    });
    console.log('STATE COMMIT: M19_EQUIPPED (resumed current equip-target prompt)');
    return { executed: true, state: equipped.state, quit: false };
  }

  if (node === 'M20_EQUIP_TARGET_PENDING') {
    const equipped = await resumeSwordEquipTargetAtomic({
      state,
      cardId: 'M20',
      expectedCarrierId: 'TOKEN_SKY_STRIKER',
      requiredCarrierKind: 'CENTRAL_MAIN'
    });
    commitSwordEquipped('M20', equipped.carrier, {
      carrierId: 'TOKEN_SKY_STRIKER',
      source: 'FORMAL_V5_RESUME_HORNET_M20_EQUIP_TARGET',
      extra: {
        plannedSwordId: 'M20',
        hornetBambooDraw2: true,
        reservedYotoInHand: true
      }
    });
    console.log('STATE COMMIT: M20_EQUIPPED (resumed Hornet True-Bamboo target prompt)');
    return { executed: true, state: equipped.state, quit: false };
  }

  if (node === 'M20_EXTRA_EQUIP_TARGET_PENDING') {
    const equipped = await resumeSwordEquipTargetAtomic({
      state,
      cardId: 'M20',
      expectedCarrierId: 'E02',
      requiredCarrierKind: 'EXTRA_LINK'
    });
    commitSwordEquipped('M20', equipped.carrier, {
      carrierId: 'E02',
      source: 'FORMAL_V5_RESUME_M20_EXTRA_EQUIP_TARGET'
    });
    console.log('STATE COMMIT: M20_EQUIPPED (resumed current True-Bamboo Extra-Zone target prompt)');
    return { executed: true, state: equipped.state, quit: false };
  }

  if (node === 'HAND_MENU_DISMISS_PENDING') {
    await dismissSelectedHandActionMenuAtomic();
    setAtomicBranch('M19_EQUIPPED', {
      carrierId: carrierId || 'TOKEN_SKY_STRIKER',
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_HAND_MENU_DISMISSED_RETURN_TO_Y1'
    });
    console.log('STATE COMMIT: M19_EQUIPPED（只完成菜单复位；下一次f才执行Y1 Link风刀）');
    return { executed: true, state, quit: false };
  }

  if (node === 'Y1_LINK_RESOLVED_RECOVERY_PENDING') {
    const expectedLinkId = String(branch.expectedLinkId || branch.targetLinkId || '');
    const recovered = await recoverYotoLinkResolvedOptionalAtomic({
      state,
      expectedLinkId: expectedLinkId || null
    });
    setAtomicBranch('YOTO_LINK_RESOLVED', {
      carrierId: recovered.targetLinkId,
      preserveRaye: branch.preserveRaye === true,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_Y1_LINK_RESOLVED_RECOVERY'
    });
    console.log('STATE COMMIT: YOTO_LINK_RESOLVED（只恢复验收；下一次f才发动妖刀效果）');
    return { executed: true, state, quit: false };
  }

  if (node === 'KAGARI_EFFECT_PENDING') {
    console.log('\n原子H2：只发动篝并证明回收窗口；随后RETURN。');
    await runKagariEffectToRecoveryPromptAtomic({ state });
    setAtomicBranch('KAGARI_RECOVERY_PROMPT', { carrierId: 'E02', source: 'FORMAL_V5_H2' });
    console.log('STATE COMMIT: KAGARI_RECOVERY_PROMPT');
    return { executed: true, state, quit: false };
  }

  if (node === 'KAGARI_RECOVERY_PROMPT') {
    console.log(
      recoverResolvedKagari
        ? '\n恢复原子H3R：回收窗口已经消失，只验收交闪回手；绝不重放选择。'
        : '\n原子H3：只处理当前篝回收窗口并验收交闪回手；随后RETURN。'
    );
    const recovered = recoverResolvedKagari
      ? await recoverResolvedKagariAtomic({ state, recoverId: 'M17' })
      : await runKagariRecoveryCurrentPromptAtomic({ state, recoverId: 'M17' });
    commitKagariRecoveryAccounting('M17');
    setAtomicBranch('KAGARI_RECOVERY_DONE', { active: false, carrierId: 'E02' });
    console.log('STATE COMMIT: KAGARI_RECOVERY_DONE');
    return { executed: true, state: recovered.state, quit: false };
  }

  if (node === 'M20_EQUIPPED') {
    console.log('\n原子T20-1：只发动场上真刀，停在妖刀牌组选卡窗口；随后RETURN。');
    await runM20FieldEffectToDeckPromptAtomic({ state });
    setAtomicBranch('M20_FIELD_EFFECT_ACTIVATED', {
      carrierId: carrierId || null,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_T20_1'
    });
    console.log('STATE COMMIT: M20_FIELD_EFFECT_ACTIVATED');
    return { executed: true, state, quit: false };
  }

  if (node === 'M20_FIELD_EFFECT_ACTIVATED') {
    console.log('\n原子T20-2：只从当前牌组窗口选择妖刀；随后RETURN。');
    await runM20SelectYotoFromDeckAtomic({ state });
    setAtomicBranch('M19_SELECTED_FROM_DECK', {
      carrierId: carrierId || null,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_T20_2'
    });
    console.log('STATE COMMIT: M19_SELECTED_FROM_DECK');
    return { executed: true, state, quit: false };
  }

  if (node === 'M19_SELECTED_FROM_DECK') {
    const hornetTokenSwordRoute = isHornetTokenSwordRoute(branch);
    console.log('\n原子T20-3：只选择当前装备对象并确认，验收真刀送墓+妖刀装备；随后RETURN。');
    await runM20EquipSelectedYotoAtomic({
      state,
      expectedCarrierId: hornetTokenSwordRoute ? null : (carrierId || null),
      requiredCarrierKind: hornetTokenSwordRoute ? 'CENTRAL_MAIN' : null
    });
    const { commitKnownDeckExit } = require(path.join(ROOT, 'lib', 'main-deck-ledger'));
    commitKnownDeckExit(
      'M19',
      `T20_3_M19_DECK_TO_FIELD:${String(branch.updatedAt || 'CURRENT')}`,
      'T20_3_PROVED_M19_DECK_TO_FIELD'
    );
    const after = loadDecisionState();
    after.graveSpellCount = Number(after.graveSpellCount || 0) + 1; // M20 entered GY here.
    after.equipSentToGraveCount = Number(after.equipSentToGraveCount || 0) + 1;
    after.bambooSwordEquipped = true;
    after.equippedBambooId = 'M19';
    after.equippedBambooCounts = { M19: 1 };
    after.bambooEquipResources = null;
    saveDecisionState(after);
    setAtomicBranch('M19_EQUIPPED', {
      carrierId: carrierId || null,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_T20_3_REPEATABLE_M19'
    });
    // T20 is a fixed Deck-to-field resource action, not a draw/search macro.
    // Re-evaluate after its proof: ordinary decisions (including Engage)
    // resume when neither immediate replacement nor deferred Golden stocking
    // with a real remaining Deck equip supports another Y1.
    normalizeEquippedYotoGoldenDrawPriority(state);
    console.log(`STATE COMMIT: ${currentAtomicNode()}（真刀换装已结算；后续重新排序，不连发金竹光）`);
    return { executed: true, state, quit: false };
  }

  if (node === 'M19_EQUIPPED') {
    if (branch.kagariSwordLink === true && branch.m19EffectCount === 2 &&
        Number(runtime.equippedBambooCounts?.M19 || 0) === 1) {
      const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
      const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
      const deck = buildDeckState(loadLibrary(ROOT), state.cards, runtime);
      const sword = state.cards.find(c => c.id === 'M19');
      if (!sword || carrierId !== branch.materialCarrierId ||
          Number(deck.deckRemaining.M20 || 0) < 1 || Number(deck.deckRemaining.M14 || 0) < 1 ||
          Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) > 0) {
        throw new Error('SECOND_YOTO_CURRENT_RESOURCES_CHANGED:zero_input=1');
      }
      setAtomicBranch('KAGARI_SECOND_YOTO_EQUIP_IN_FLIGHT');
      const equipped = await equipSwordFromHand({ state, cardId: 'M19', cardName: sword.name,
        requiredCarrierKind: branch.requiredCarrierKind,
        expectedCarrierId: carrierId === 'TOKEN_SKY_STRIKER' ? null : carrierId,
        debugDir: path.join(ROOT, 'debug', 'execution', 'V5_formal_atomic',
          `${new Date().toISOString().replace(/[:.]/g, '-')}_second_yoto`) });
      commitSwordEquipped('M19', equipped.carrier, { carrierId, additionalEquip: true,
        source: 'AUTOTEST_TWO_YOTO_KAGARI_PREPARATION', extra: branch });
      return { executed: true, state: equipped.state, quit: false };
    }
    // Recheck before any irreversible Y1 or equipped-Raye input. A stale
    // branch/direct dispatch must not bypass the last-equip resource guard.
    const linkPlan = buildEquippedBambooContinuationPlan(state, runtime);
    if (!linkPlan.shouldContinue) {
      const goldenReady = linkPlan.goldenDrawReady === true;
      runtime.bambooEquipResources = linkPlan.equipResources;
      runtime.bambooContinuationPlan = linkPlan;
      runtime.v5Branch = { ...branch, active: false,
        currentState: goldenReady ? 'GOLDEN_BAMBOO_DRAW_READY' : 'EQUIPPED_YOTO_NO_SEARCH_TARGET',
        source: 'FORMAL_V6_CURRENT_BAMBOO_CONTINUATION_PLAN', updatedAt: new Date().toISOString() };
      saveDecisionState(runtime);
      console.log(`取消Y1：${linkPlan.reason}；保留场上竹光与载体，未发送Link输入。`);
      const policyProgress = linkPlan.fieldId === 'M19';
      return { executed: policyProgress, savedObservationOnly: policyProgress, state, quit: false };
    }
    if (branch.kagariSwordLink === true) {
      if (!linkPlan.shouldLink || Number(runtime.usedCounts?.M17 || 0) <= 0 ||
          Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) > 0 ||
          (branch.m19EffectCount === 2 && !linkPlan.twoYotoKagari) ||
          !['TOKEN_SKY_STRIKER', 'E03', 'E04', 'E05'].includes(carrierId) ||
          carrierId !== branch.materialCarrierId) {
        throw new Error('KAGARI_SWORD_LINK_PREREQUISITE_CHANGED:zero_input=1');
      }
      setAtomicBranch('KAGARI_SWORD_LINK_IN_FLIGHT');
      const m19EffectCount = branch.m19EffectCount === 2 ? 2 : 1;
      if (Number(runtime.equippedBambooCounts?.M19 || 1) !== m19EffectCount) {
        throw new Error('KAGARI_EQUIP_COUNT_NOT_PROVEN:zero_input=1');
      }
      const commit = () => setAtomicBranch('DUAL_OPTIONAL_PENDING', {
        carrierId: 'E02', dualSecondEffectId: 'E02', summonMode: 'LINK', m19EffectCount,
        preResolutionHandCount: state.handCount, source: 'AUTOTEST_KAGARI_SWORD_POOL_PROVEN'
      });
      await runEquippedYotoLinkToOptionalAtomic({
        state, equippedKagari: true, equippedYoto: true, singleTargetLinkId: 'E02',
        equippedYotoCount: m19EffectCount,
        requiredCarrierKind: branch.requiredCarrierKind, materialCarrierId: carrierId,
        onOptionalPoolProven: commit
      });
      commit();
      return { executed: true, state, quit: false };
    }
    if (carrierId === 'M06') {
      console.log('\n原子R1D：带妖刀零衣只执行自身效果直出零梦，停在双效果池；随后RETURN。');
      await runRayeEffectToE10OptionalAtomic({
        state,
        equippedYoto: true,
        onE10Selected: () => setAtomicBranch('RAYE_E10_SELECTED_PENDING', {
          carrierId: 'E10',
          equippedYoto: true,
          summonMode: 'RAYE_DIRECT',
          source: 'FORMAL_V5_R1D_E10_SELECTED'
        })
      });
      setAtomicBranch('DUAL_OPTIONAL_PENDING', {
        carrierId: 'E10',
        summonMode: 'RAYE_DIRECT',
        preResolutionHandCount: state.handCount,
        source: 'FORMAL_V5_R1D'
      });
      console.log('STATE COMMIT: DUAL_OPTIONAL_PENDING');
      return { executed: true, state, quit: false };
    }

    let doubleWithRaye = false;
    if (runtime.rayeNormalSummoned === true) {
      console.log('\n当前同时存在：妖刀carrier + 场上零衣。');
      console.log('  1 = 任意合法非火刀单素材Link（本次只Link，停在妖刀效果池）');
      console.log('  2 = 双素材Link零梦（本次只Link，停在双效果池）');
      console.log('  b = 返回，不发送输入');
      let raw;
      if (process.env.MD_AUTOTEST_RUN) {
        const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
        const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
        const choice = chooseEquippedRayeLink(state.cards, runtime,
          buildDeckState(loadLibrary(), state.cards, runtime), linkPlan);
        console.log(`自动原子Link选择=${choice.answer}; ${JSON.stringify(choice)}`);
        raw = choice.answer;
      } else raw = String(await rl.question('\nV6[选择本次原子Link]> ')).trim().toLowerCase();
      if (raw === 'b' || raw === '0' || raw === '') return { executed: false, state, quit: false };
      if (raw === '2') doubleWithRaye = true;
      else if (raw !== '1') {
        console.log('输入无效，本轮没有发送游戏输入。');
        return { executed: false, state, quit: false };
      }
    }

    const postE10HornetBambooDraw2 = branch.postE10HornetBambooDraw2 === true;
    const hornetTokenSwordRoute = isHornetTokenSwordRoute(branch);
    const linkResult = await runEquippedYotoLinkToOptionalAtomic({
      state,
      doubleWithRaye,
      singleTargetLinkId: branch.targetLinkId || null,
      requiredCarrierKind: hornetTokenSwordRoute ? 'CENTRAL_MAIN' : null,
      materialCarrierId: hornetTokenSwordRoute
        ? 'TOKEN_SKY_STRIKER'
        : (carrierId || 'E02'),
      onOptionalPoolProven: ({ targetLinkId }) => {
        if (doubleWithRaye) {
          setAtomicBranch('DUAL_OPTIONAL_PENDING', {
            carrierId: targetLinkId,
            summonMode: 'LINK',
            preResolutionHandCount: state.handCount,
            source: 'FORMAL_V5_Y1D_OPTIONAL_POOL_PROVEN'
          });
          return;
        }
        setAtomicBranch('Y1_LINK_RESOLVED_RECOVERY_PENDING', {
          carrierId: targetLinkId,
          expectedLinkId: targetLinkId,
          preserveRaye: runtime.rayeNormalSummoned === true,
          postE10HornetBambooDraw2,
          hornetBambooDraw2: branch.hornetBambooDraw2 === true,
          hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
          reservedYotoInHand: branch.reservedYotoInHand === true,
          source: 'FORMAL_V5_Y1_OPTIONAL_POOL_PROVEN'
        });
        console.log(
          `IRREVERSIBLE CHECKPOINT: Y1_LINK_RESOLVED_RECOVERY_PENDING; actualLink=${targetLinkId}`
        );
      }
    });
    if (doubleWithRaye) {
      setAtomicBranch('DUAL_OPTIONAL_PENDING', {
        carrierId: linkResult.targetLinkId,
        summonMode: 'LINK',
        preResolutionHandCount: state.handCount,
        source: 'FORMAL_V5_Y1D'
      });
      console.log('STATE COMMIT: DUAL_OPTIONAL_PENDING');
    } else {
      setAtomicBranch('YOTO_LINK_RESOLVED', {
        carrierId: linkResult.targetLinkId,
        preserveRaye: runtime.rayeNormalSummoned === true,
        postE10HornetBambooDraw2,
        hornetBambooDraw2: branch.hornetBambooDraw2 === true,
        hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
        reservedYotoInHand: branch.reservedYotoInHand === true,
        source: 'FORMAL_V5_Y1'
      });
      console.log('STATE COMMIT: YOTO_LINK_RESOLVED');
    }
    return { executed: true, state, quit: false };
  }

  if (node === 'YOTO_LINK_RESOLVED') {
    if (!carrierId) {
      throw new Error('V5_YOTO_LINK_RESOLVED_CARRIER_MISSING');
    }
    await runYotoOptionalToBambooPromptAtomic({ state });
    setAtomicBranch('YOTO_SEARCH_PROMPT', {
      carrierId,
      preserveRaye: branch.preserveRaye === true,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      hornetYotoFixedSearch: branch.hornetYotoFixedSearch === true,
      reservedYotoInHand: branch.reservedYotoInHand === true,
      source: 'FORMAL_V5_Y2'
    });
    console.log('STATE COMMIT: YOTO_SEARCH_PROMPT');
    return { executed: true, state, quit: false };
  }

  if (node === 'YOTO_SEARCH_PROMPT') {
    if (!carrierId) {
      throw new Error('V5_YOTO_SEARCH_PROMPT_CARRIER_MISSING');
    }
    const resolved = await runBambooPromptToResolvedAtomic({ state, expectedGain: 1 });
    commitAfterYotoResolution({
      graveSpellDelta: 1,
      m19SearchUsed: true,
      preserveRaye: branch.preserveRaye === true,
      consumeRaye: false,
      carrierId,
      postE10HornetBambooDraw2: branch.postE10HornetBambooDraw2 === true,
      hornetBambooDraw2: branch.hornetBambooDraw2 === true,
      reservedYotoInHand: branch.reservedYotoInHand === true
    });
    console.log('STATE COMMIT: YOTO_SEARCH_DONE (decision-safe)');
    return { executed: true, state: resolved.state, quit: false };
  }

  if (node === 'RAYE_NORMAL_SUMMONED') {
    if (knownNonRayeMonsterPresent(runtime) || branch.rayeOnlyMonster === false) {
      runtime.v5Branch = {
        ...branch,
        active: false,
        currentState: 'RAYE_NORMAL_SUMMONED_WITH_OTHER_MONSTER',
        rayeOnlyMonster: false,
        updatedAt: new Date().toISOString(),
        source: 'FORMAL_V5_RAYE_ZONE_GUARD'
      };
      saveDecisionState(runtime);
      console.log('零衣不是我方场上唯一怪兽：禁止直出零梦，避免占用主怪兽区继续封锁交闪。');
      return { executed: false, state, quit: false };
    }
    const preparation = buildEquippedBambooContinuationPlan(state, runtime);
    if (preparation.prepareEquipId) {
      const slot = (state.cards || []).findIndex(card => card && card.id === preparation.prepareEquipId) + 1;
      console.log('零衣变零梦前先装备竹光，准备双效果；本次不发动零衣自身效果。');
      return executeSelected({ state, slot, rl });
    }
    if (preparation.reason === 'BAMBOO_DECK_EVIDENCE_UNKNOWN' &&
        (state.cards || []).some(card => card && ['M19', 'M20'].includes(card.id))) {
      throw new Error('RAYE_PRE_E10_EQUIP_RESOURCES_UNKNOWN');
    }
    await runRayeEffectToE10OptionalAtomic({
      state,
      equippedYoto: false,
      onE10Selected: () => setAtomicBranch('RAYE_E10_SELECTED_PENDING', {
        carrierId: 'E10',
        equippedYoto: false,
        summonMode: 'RAYE_DIRECT',
        source: 'FORMAL_V5_R1_E10_SELECTED'
      })
    });
    setAtomicBranch('E10_OPTIONAL_PENDING', {
      carrierId: 'E10',
      source: 'FORMAL_V5_R1'
    });
    console.log('STATE COMMIT: E10_OPTIONAL_PENDING');
    return { executed: true, state, quit: false };
  }

  if (node === 'RAYE_SECOND_MATERIAL_READY') {
    if (!/^E(?:0[2-9])$/.test(carrierId) || runtime.rayeNormalSummoned !== true) {
      throw new Error(
        `V5_RAYE_DOUBLE_LINK_STATE_INVALID:carrier=${carrierId || 'NONE'};` +
        `raye=${runtime.rayeNormalSummoned === true ? 1 : 0}`
      );
    }
    console.log('\n原子R7-1：已有额外区Link + 场上零衣 -> 双素材Link零梦，停在零梦单效果池。');
    await runEquippedYotoLinkToOptionalAtomic({
      state,
      doubleWithRaye: true,
      equippedYoto: false,
      requiredCarrierKind: 'EXTRA_LINK',
      materialCarrierId: carrierId,
      onOptionalPoolProven: () => {
        setAtomicBranch('E10_OPTIONAL_PENDING', {
          carrierId: 'E10',
          summonMode: 'DOUBLE_LINK',
          preResolutionHandCount: state.handCount,
          e10EngageSource: String(branch.e10EngageSource || 'GRAVE'),
          source: 'FORMAL_V5_RAYE_DOUBLE_LINK_OPTIONAL_POOL_PROVEN'
        });
        const committed = loadDecisionState();
        committed.rayeNormalSummoned = false;
        committed.engageBlockedByMainMonster = false;
        saveDecisionState(committed);
      }
    });
    console.log('STATE COMMIT: E10_OPTIONAL_PENDING (Raye double-link Engage recovery)');
    return { executed: true, state, quit: false };
  }

  if (node === 'E10_OPTIONAL_PENDING') {
    await runE10OptionalToTargetPromptAtomic({ state });
    setAtomicBranch('E10_TARGET_PROMPT', {
      carrierId: 'E10',
      source: 'FORMAL_V5_R2'
    });
    console.log('STATE COMMIT: E10_TARGET_PROMPT');
    return { executed: true, state, quit: false };
  }

  if (node === 'E10_TARGET_PROMPT') {
    const resolved = await runE10TargetToResolvedAtomic({ state });
    const { completeE10ResolutionDecision } = require(path.join(ROOT, 'lib', 'e10-resolution-policy'));
    const after = completeE10ResolutionDecision(loadDecisionState(), {
      zeroTargetId: resolved.zeroTargetId, zeroTargetSource: resolved.zeroTargetSource,
      handRevision: resolved.state.revision
    });
    saveDecisionState(after);
    console.log('STATE COMMIT: E10_EFFECT_RESOLVED (decision-safe)');
    return { executed: true, state: resolved.state, quit: false };
  }

  if (node === 'DUAL_OPTIONAL_PENDING') {
    await runDualSelectM19CL1Atomic({
      state, expectedRemaining: branch.m19EffectCount === 2 ? 2 : 1,
      onM19Selected: () => setAtomicBranch('DUAL_M19_CL1_SELECTED', {
        carrierId: branch.dualSecondEffectId === 'E02' ? 'E02' : 'E10',
        summonMode: branch.summonMode || 'LINK',
        preResolutionHandCount: branch.preResolutionHandCount || state.handCount,
        source: 'FORMAL_V5_D1_M19_SUBMITTED'
      })
    });
    setAtomicBranch('DUAL_M19_CL1_SELECTED', {
      carrierId: branch.dualSecondEffectId === 'E02' ? 'E02' : 'E10',
      summonMode: branch.summonMode || 'LINK',
      preResolutionHandCount: branch.preResolutionHandCount || state.handCount,
      source: 'FORMAL_V5_D1'
    });
    console.log('STATE COMMIT: DUAL_M19_CL1_SELECTED');
    return { executed: true, state, quit: false };
  }

  if (node === 'DUAL_M19_CL1_SELECTED') {
    if (branch.m19EffectCount === 2) {
      await runDualSelectM19CL1Atomic({ state, expectedRemaining: 1, chainLink: 2,
        onM19Selected: () => setAtomicBranch('TRIPLE_M19_CL2_SELECTED') });
      setAtomicBranch('TRIPLE_M19_CL2_SELECTED');
      return { executed: true, state, quit: false };
    }
  }

  if (node === 'DUAL_M19_CL1_SELECTED' || node === 'TRIPLE_M19_CL2_SELECTED') {
    await runDualSelectE10CL2ToTargetPromptAtomic({ state,
      secondEffectId: branch.dualSecondEffectId || 'E10',
      chainLink: branch.m19EffectCount === 2 ? 3 : 2,
      onSecondSelected: branch.dualSecondEffectId === 'E02'
        ? () => setAtomicBranch('DUAL_E10_TARGET_PROMPT', { carrierId: 'E02' }) : null
    });
    setAtomicBranch('DUAL_E10_TARGET_PROMPT', {
      carrierId: branch.dualSecondEffectId === 'E02' ? 'E02' : 'E10',
      summonMode: branch.summonMode || 'LINK',
      preResolutionHandCount: branch.preResolutionHandCount || state.handCount,
      source: 'FORMAL_V5_D2'
    });
    console.log('STATE COMMIT: DUAL_E10_TARGET_PROMPT');
    return { executed: true, state, quit: false };
  }

  if (node === 'DUAL_E10_TARGET_PROMPT') {
    const result = await runDualE10TargetToBambooPromptAtomic({ state,
      secondEffectId: branch.dualSecondEffectId || 'E10',
      onTargetSelected: branch.dualSecondEffectId === 'E02'
        ? () => setAtomicBranch('KAGARI_DUAL_RECOVERY_SUBMITTED_IN_FLIGHT') : null
    });
    setAtomicBranch('DUAL_M19_BAMBOO_PROMPT', {
      carrierId: branch.dualSecondEffectId === 'E02' ? 'E02' : 'E10',
      summonMode: branch.summonMode || 'LINK',
      preResolutionHandCount: branch.preResolutionHandCount || state.handCount,
      zeroTargetId: result.zeroTargetId || null,
      zeroTargetSource: result.zeroTargetSource || null,
      source: 'FORMAL_V5_D3'
    });
    console.log('STATE COMMIT: DUAL_M19_BAMBOO_PROMPT');
    return { executed: true, state, quit: false };
  }

  if (node === 'DUAL_M19_BAMBOO_PROMPT' && branch.m19EffectCount === 2) {
    if (recoverClosedD4) throw new Error('TRIPLE_CLOSED_FIRST_SEARCH_UNPROVEN:zero_input=1');
    await runBambooPromptToResolvedAtomic({ state, expectedGain: 3,
      secondGainActivationKey: 'E02', zeroTargetId: branch.zeroTargetId,
      zeroTargetSource: branch.zeroTargetSource, targetBambooId: 'M20', stopAtNextBamboo: true,
      onBambooSelected: extra => setAtomicBranch('TRIPLE_SECOND_BAMBOO_PROMPT', {
        bambooGainIds: [extra.bambooGainId], bambooGainId: null }) });
    return { executed: true, state, quit: false };
  }

  if (node === 'DUAL_M19_BAMBOO_PROMPT' || node === 'TRIPLE_SECOND_BAMBOO_PROMPT') {
    const triple = branch.m19EffectCount === 2;
    const resolved = recoverClosedD4 || (branch.dualSecondEffectId === 'E02' && branch.bambooGainId)
      ? await recoverClosedBambooPromptAtomic({
        state,
        expectedGain: triple ? 3 : 2,
        bambooGainIds: branch.bambooGainIds || [],
        secondGainActivationKey: branch.dualSecondEffectId || 'E10',
        bambooGainId: branch.bambooGainId || null,
        zeroTargetId: branch.zeroTargetId || null,
        zeroTargetSource: branch.zeroTargetSource || null
      })
      : await runBambooPromptToResolvedAtomic({
        state,
        expectedGain: triple ? 3 : 2,
        priorBambooGainIds: triple ? branch.bambooGainIds : [],
        targetBambooId: triple ? 'M14' : null,
        secondGainActivationKey: branch.dualSecondEffectId || 'E10',
        onBambooSelected: branch.dualSecondEffectId === 'E02'
          ? extra => saveAtomicBranchExtra(extra) : null,
        zeroTargetId: branch.zeroTargetId || null,
        zeroTargetSource: branch.zeroTargetSource || null
      });
    const direct = String(branch.summonMode || '') === 'RAYE_DIRECT';
    commitAfterYotoResolution({
      usedRemove: branch.zeroTargetId && branch.zeroTargetSource === 'GRAVE'
        ? [branch.zeroTargetId]
        : [],
      graveSpellDelta: triple ? 1 : 0,
      m19SearchUsed: true,
      m19SearchCount: triple ? 2 : 1,
      consumeRaye: branch.dualSecondEffectId !== 'E02',
      carrierId: branch.dualSecondEffectId === 'E02' ? 'E02' : null,
      kagariRecovery: branch.dualSecondEffectId === 'E02'
    });
    console.log(`STATE COMMIT: ${branch.dualSecondEffectId === 'E02' ? 'KAGARI_RECOVERY_DONE' : 'YOTO_SEARCH_DONE'} (dual ${direct ? 'Raye-direct' : 'Link'} complete)`);
    return { executed: true, state: resolved.state, quit: false };
  }

  console.log('当前没有已提交、可独立继续的场上节点；本轮没有发送游戏输入。');
  return { executed: false, state, quit: false };
}

async function executeAtomicResponseInterval(options) {
  let state = options.state;
  let result = { executed: false, state, quit: false };
  let executedNode = currentAtomicNode();
  const visitedEdges = new Set();

  for (let step = 0; step < 12; step++) {
    result = await executeFieldTransition({ ...options, state });
    state = result.state;
    if (options.automatic) assertAutomaticExecutionResult(result, executedNode || 'FIELD');
    if (!result.executed || result.quit) return { ...result, state };

    const nextNode = currentAtomicNode();
    const continuation = atomicContinuationDecision(executedNode, nextNode);
    if (!continuation.autoContinue) {
      console.log(
        `响应边界已到达：${executedNode || 'NONE'} -> ${nextNode || 'DECISION'}；` +
        '停下等待下一次我方底部淡蓝光晕与用户决策。'
      );
      return { ...result, state, responseBoundaryReached: true };
    }
    if (visitedEdges.has(continuation.edge)) {
      throw new Error(`ATOMIC_RESPONSE_INTERVAL_LOOP:${continuation.edge}`);
    }
    visitedEdges.add(continuation.edge);
    console.log(
      `同一响应区间自动续行：${continuation.edge}; ${continuation.reason}。` +
      '下一步仍须先由其输入门证明我方底部淡蓝光晕。'
    );
    executedNode = nextNode;
  }

  throw new Error('ATOMIC_RESPONSE_INTERVAL_STEP_LIMIT:12');
}

function showNeedRouteDecision(slot, card) {
  console.log('\n============================================================');
  console.log(`支线待你决定：手牌${slot} ${card.name}[${card.id}]`);
  console.log('当前没有点击发动。你告诉我接下来走哪条支线后再继续。');
  if (card.id === 'M19') {
    console.log('妖刀：需要确定装备对象/后续Link/检索路线。');
  } else {
    console.log('真刀：需要确定装备与后续转换/Link路线。');
  }
  console.log('============================================================');
}

function showNoExecutor(slot, card) {
  console.log(`\nV6暂不能独立执行：手牌${slot} ${card.name}[${card.id}]；本轮没有点击。`);
  if (card.id === 'M06') {
    const runtimeBeforeRaye = loadDecisionState();
    if (knownNonRayeMonsterPresent(runtimeBeforeRaye)) {
      console.log(
        '零衣通常召唤已拒绝：我方场上已有其它怪兽；此时零衣不是唯一怪兽，' +
        '后续零梦会占用主怪兽区并封锁交闪。'
      );
      return { executed: false, state, quit: false };
    }
    console.log('零衣通招目前仍在成熟组合路线里，还没有拆成独立V6原子入口。');
  } else if (HOLD_ONLY.has(card.id)) {
    console.log('该卡不是当前独立主动执行入口。');
  } else {
    console.log('当前 verified-cards 中没有可直接调用的成熟单卡执行器。');
  }
}

async function chooseM17Branch(rl, oneShotBranch = null) {
  // V5 rule: Engage always takes the bonus draw when it is actually available.
  // The bonus is available only when our tracked pre-activation grave already
  // contains at least 3 Spells.  No normal prompt is shown to the user anymore.
  let branch = oneShotBranch;
  if (branch) {
    branch = String(branch).trim().toLowerCase();
    if (!M17_BRANCH[branch]) {
      console.log('交闪调试分支输入无效，本轮不点击。');
      return null;
    }
    console.log(`交闪分支由本次命令显式指定：${M17_BRANCH[branch].label}`);
    return M17_BRANCH[branch];
  }

  const runtime = loadDecisionState();
  const graveSpellCount = Number(runtime.graveSpellCount || 0);
  branch = graveSpellCount >= 3 ? 'b' : 'n';
  console.log(
    graveSpellCount >= 3
      ? `交闪自动分支：墓地魔法=${graveSpellCount}，默认追加抽1。`
      : `交闪自动分支：墓地魔法=${graveSpellCount}<3，当前抽不了追加1，按无追加抽1执行。`
  );
  return M17_BRANCH[branch];
}

async function prepareSwordForPlannedKagari(state, runtime, materialId) {
  const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
  const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
  const plan = planKagariSwordPreparation(state.cards, runtime,
    buildDeckState(loadLibrary(ROOT), state.cards, runtime), materialId);
  if (!plan) return null;
  const card = state.cards.find(c => c.id === plan.plannedSwordId);
  setAtomicBranch('KAGARI_SWORD_EQUIP_IN_FLIGHT', { ...plan, carrierId: materialId });
  const equipped = await equipSwordFromHand({ state, cardId: card.id, cardName: card.name,
    requiredCarrierKind: plan.requiredCarrierKind,
    expectedCarrierId: materialId === 'TOKEN_SKY_STRIKER' ? null : materialId,
    debugDir: path.join(ROOT, 'debug', 'execution', 'V5_formal_atomic',
      `${new Date().toISOString().replace(/[:.]/g, '-')}_kagari_sword_preparation`) });
  commitSwordEquipped(card.id, equipped.carrier, {
    carrierId: materialId, source: 'AUTOTEST_KAGARI_SWORD_PREPARATION', extra: plan
  });
  return { executed: true, state: equipped.state, quit: false };
}

async function executeKagariLinkBeforeTrue({ state }) {
  const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
  const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
  const runtime = loadDecisionState();
  const gain = planTrueBambooGain(state.cards, runtime, buildDeckState(loadLibrary(ROOT), state.cards, runtime));
  if (!gain || gain.stage !== 'KAGARI_LINK_BEFORE_TRUE') {
    throw new Error('TRUE_BAMBOO_GAIN_LINK_PREREQUISITE_CHANGED:zero_input=1');
  }
  const combined = await prepareSwordForPlannedKagari(state, runtime, gain.carrierId);
  if (combined) return combined;
  // An interrupted in-flight Link must not be offered as a fresh replay.
  setAtomicBranch('KAGARI_LINK_BEFORE_TRUE_IN_FLIGHT', {
    trueBambooGainBeforeEquip: true, source: 'AUTOTEST_TRUE_BAMBOO_GAIN', carrierId: gain.carrierId
  });
  const commit = () => setAtomicBranch('KAGARI_EFFECT_PENDING', {
    carrierId: 'E02', trueBambooGainBeforeEquip: true, source: 'AUTOTEST_TRUE_BAMBOO_GAIN_LINK_PROVEN'
  });
  const linked = await runEquippedYotoLinkToOptionalAtomic({
    state, equippedYoto: false, doubleWithRaye: false, singleTargetLinkId: 'E02',
    requiredCarrierKind: 'EXTRA_LINK', materialCarrierId: gain.carrierId, onOptionalPoolProven: commit
  });
  commit();
  return { executed: true, state: linked.state || state, quit: false };
}

async function executeSelected({ state, slot, rl, branch = null }) {
  const card = cardAtUserSlot(state, slot);
  const runtimeBeforeSelection = loadDecisionState();
  const preSelectionBranchState = String(
    runtimeBeforeSelection && runtimeBeforeSelection.v5Branch &&
    runtimeBeforeSelection.v5Branch.currentState || ''
  );
  if (preSelectionBranchState === 'KAGARI_LINK_BEFORE_TRUE_IN_FLIGHT' ||
      (card.id === 'M20' && runtimeBeforeSelection.v5Branch &&
       runtimeBeforeSelection.v5Branch.trueBambooGainBeforeEquip === true &&
       runtimeBeforeSelection.v5Branch.active === true)) {
    throw new Error(`TRUE_BAMBOO_GAIN_TRANSACTION_PENDING:${preSelectionBranchState};zero_input=1`);
  }
  if (card.id === 'M20') {
    const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
    const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
    const deck = buildDeckState(loadLibrary(ROOT), state.cards, runtimeBeforeSelection);
    const gain = planTrueBambooGain(state.cards, runtimeBeforeSelection, deck);
    if (gain) {
      console.log(`真刀装备暂缓：${gain.reason} 本轮零游戏输入。`);
      return { executed: false, state, quit: false };
    }
  }

  if (card.id === 'M22') {
    const extraCarrierId = branchCarrierId(runtimeBeforeSelection.v5Branch);
    if (/^E\d+$/.test(extraCarrierId)) {
      console.log(
        `大黄蜂禁止发动：额外怪兽区已有${extraCarrierId}；生成衍生物会占用主怪兽区并卡住交闪，` +
        '不把大黄蜂当作无收益展开。'
      );
      console.log('本轮没有发送游戏输入；保留当前手牌和局内状态。');
      return { executed: false, state, quit: false };
    }
  }

  if (card.id === 'M22' && preSelectionBranchState === 'E10_EFFECT_RESOLVED') {
    const hasEquipSword = state.cards.some(row => row && (row.id === 'M19' || row.id === 'M20'));
    const hasGolden = state.cards.some(row => row && row.id === 'M14');
    if (!hasEquipSword || !hasGolden) {
      console.log(
        '零梦后黄蜂禁止发动：交闪会被主怪兽区卡死，且当前不能闭环“装备刀→Link检索真刀→金竹光抽2”。'
      );
      console.log('本轮没有发送游戏输入。');
      return { executed: false, state, quit: false };
    }
  }

  // PATCH_V5_ALLOW_HORNET_FOR_FIXED_BAMBOO_ROUTE_V1
  // M22 is allowed without GY Engage when the decision layer selected it to start
  // the already validated Hornet-token -> Bamboo carrier fixed-resource route.


  if (card.id === 'M19' || card.id === 'M20') {
    let equipsSwordForGoldenDraw = Boolean(
      preSelectionBranchState === 'YOTO_SEARCH_DONE' &&
      state.cards.some(row => row && row.id === 'M14')
    );
    if (!equipsSwordForGoldenDraw) {
      const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
      const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
      const setup = planGoldenBambooSetup(state.cards, runtimeBeforeSelection,
        buildDeckState(loadLibrary(ROOT), state.cards, runtimeBeforeSelection));
      equipsSwordForGoldenDraw = setup?.sword.id === card.id;
    }
    if (card.id === 'M20') {
      // Preserve the mature T20 conversion while a Deck Yoto still exists.
      // Read the authoritative ledger BEFORE the equip changes the hand.
      const { loadLibrary } = require(path.join(ROOT, 'lib', 'recognizer'));
      const { buildDeckState } = require(path.join(ROOT, 'lib', 'decision-engine'));
      const deck = buildDeckState(loadLibrary(ROOT), state.cards, runtimeBeforeSelection);
      equipsSwordForGoldenDraw = Number(deck.deckRemaining.M19 || 0) <= 0;
    }
    const debugDir = path.join(
      ROOT, 'debug', 'execution', 'V5_formal_atomic',
      `${new Date().toISOString().replace(/[:.]/g, '-')}_${card.id}_equip`
    );
    console.log(`\n正式V6原子节点：手牌${slot} ${card.name}[${card.id}] -> 仅装备 -> 回决策层。`);
    const equipped = await equipSwordFromHand({ state, cardId: card.id, cardName: card.name, debugDir });
    commitSwordEquipped(card.id, equipped.carrier, equipsSwordForGoldenDraw
      ? {
          source: 'FORMAL_V6_RESOURCE_EQUIP_FOR_GOLDEN',
          extra: { goldenDrawSetup: true, goldenDrawEquipId: card.id }
        }
      : {});
    return { executed: true, state: equipped.state, quit: false };
  }

  if (card.id === 'M06') {
    const currentSuggestion = buildDecisionSuggestion(state);
    const suggested = currentSuggestion && currentSuggestion.selected;
    const doubleLinkRecovery = Boolean(
      suggested && suggested.id === 'M06' && Number(suggested.slot) === Number(slot) &&
      suggested.details && suggested.details.phase === 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY'
    );
    const debugDir = path.join(
      ROOT, 'debug', 'execution', 'V5_formal_atomic',
      `${new Date().toISOString().replace(/[:.]/g, '-')}_M06_normal_summon`
    );
    console.log(`\n正式V6原子节点：手牌${slot} 闪刀姬－零衣[M06] -> 仅通常召唤 -> 回决策层。`);
    const after = await normalSummonRaye({ state, debugDir });
    commitRayeNormalSummonAtomic(doubleLinkRecovery
      ? {
          doubleLinkRecovery: true,
          carrierId: suggested.details.existingCarrierId,
          e10EngageSource: suggested.details.e10EngageSource
        }
      : {});
    return { executed: true, state: after, quit: false };
  }

  if (card.id === 'M21') {
    const defer = m21ReplacementUnlocksEngage(state);
    if (defer) {
      const runtimeBefore = loadDecisionState();
      console.log(
        `试胆竞速替换旧场地后，墓地魔法将 ${defer.graveBefore}->${defer.graveAfter}；` +
        `手里交闪可检索=${defer.targets.map(x => x.name).join('/')}。`
      );
      console.log('按“固定资源先拿到手”规则：本次只把新试胆竞速落场，暂不发动场上抽1。');
      runExecutor(M21_EXECUTOR_PATH, slot, card, ['--v5-field-only'], { skipDecisionUpdate: true });
      const nextState = loadObserverSessionState();
      commitM21FieldOnlyAccounting(runtimeBefore);
      console.log(
        `
试胆竞速阶段1完成：抽1已搁置；observer当前手牌=${nextState.handCount}张。` +
        ` 下一决策会优先交闪/其它固定检索。`
      );
      return { executed: true, state: nextState, deferredM21Draw: true };
    }

    const executor = resolveVerifiedExecutor(card.id);
    if (!executor) {
      showNoExecutor(slot, card);
      return { executed: false, state };
    }
    runExecutor(executor.relative, slot, card);
  } else if (card.id === 'M17') {
    const selectedBranch = await chooseM17Branch(rl, branch);
    if (!selectedBranch) return { executed: false, state };
    runExecutor(selectedBranch.script, slot, card);
  } else if (card.id === 'M11') {
    const policy = malletPolicyForState(state);
    if (policy.returnableCount <= 0) {
      console.log('万宝槌按当前保护规则没有可返回手牌；本轮不发动。');
      return { executed: false, state };
    }
    const executor = resolveVerifiedExecutor(card.id);
    if (!executor) {
      showNoExecutor(slot, card);
      return { executed: false, state };
    }
    console.log(`万宝槌动态保护: ${policy.keepNames.join(' / ') || '无'}；预计返回=${policy.returnableCount}张。`);
    console.log(`原因: ${policy.reason}`);
    runExecutor(executor.relative, slot, card, [`--keep=${policy.keepIds.join(',')}`]);
  } else if (card.id === 'M13') {
    const executor = resolveVerifiedExecutor(card.id);
    if (!executor) { showNoExecutor(slot, card); return { executed: false, state }; }
    const suggestion = buildDecisionSuggestion(state);
    const lastResort = suggestion.selected && suggestion.selected.id === 'M13' &&
      suggestion.selected.details && suggestion.selected.details.allureLastResort === true;
    if (lastResort) console.log(suggestion.selected.reason);
    const outcome = runExecutor(executor.relative, slot, card, lastResort ? ['--last-resort-raye'] : []);
    if (outcome && outcome.terminalSurrender) return { executed: true, state, quit: true };
  } else {
    const executor = resolveVerifiedExecutor(card.id);
    if (!executor) {
      showNoExecutor(slot, card);
      return { executed: false, state };
    }
    runExecutor(executor.relative, slot, card);
  }

  // Mature executor has already run the official incremental observer.
  // Reuse that resulting state directly; do NOT rescan the whole hand here.
  let nextState = loadObserverSessionState();
  console.log(`\n操作完成：${card.name}[${card.id}]；observer当前手牌=${nextState.handCount}张。`);

  // The first M10 still requires the user's normal decision. After that,
  // Table -> Table -> Toon Dragon is a deterministic fixed-search chain, so
  // continue it without returning to the prompt between identical copies.
  // Each copy still runs the mature M10 executor and commits its own observer
  // and shared-ledger transition; only the repeated user confirmation is gone.
  if (card.id === 'M10') {
    const toonExecutor = resolveVerifiedExecutor('M10');
    if (!toonExecutor) throw new Error('V5_M10_CHAIN_EXECUTOR_NOT_FOUND');
    let automaticSteps = 0;
    while (automaticSteps < 3) {
      const chainSuggestion = buildDecisionSuggestion(nextState);
      const nextToon = chainSuggestion && chainSuggestion.selected;
      if (!nextToon || nextToon.id !== 'M10' || Number(nextToon.tier) !== 0) break;

      const nextCard = cardAtUserSlot(nextState, Number(nextToon.slot));
      if (!nextCard || nextCard.id !== 'M10') {
        throw new Error(`V5_M10_CHAIN_SLOT_MISMATCH:${nextToon.slot}`);
      }

      automaticSteps += 1;
      const target = nextToon.details && nextToon.details.searchTarget;
      console.log(
        `\n卡通目录自动续链 ${automaticSteps}: 手牌${nextToon.slot} 卡通目录[M10]；` +
        `目标=${target ? `${target.name}[${target.id}]` : '正式检索窗口按 M10>M07 决定'}。`
      );
      runExecutor(toonExecutor.relative, Number(nextToon.slot), nextCard);
      nextState = loadObserverSessionState();
    }

    const remainingSuggestion = buildDecisionSuggestion(nextState);
    if (remainingSuggestion && remainingSuggestion.selected && remainingSuggestion.selected.id === 'M10') {
      throw new Error('V5_M10_CHAIN_GUARD_EXCEEDED');
    }
    if (automaticSteps > 0) {
      console.log(
        `卡通目录自动续链结束：额外自动结算${automaticSteps}张目录；` +
        '牌组已无下一张可检索目录，回到正常决策。'
      );
    }
  }

  // Formal atomic main: M22 activation/token creation is one node.
  if (card.id === 'M22') {
    if (preSelectionBranchState === 'E10_EFFECT_RESOLVED') {
      const plannedSword = nextState.cards.find(row => row && row.id === 'M19') ||
        nextState.cards.find(row => row && row.id === 'M20');
      if (!plannedSword) throw new Error('POST_E10_HORNET_PLAN_LOST_EQUIP_SWORD_AFTER_M22');
      const blockedRuntime = loadDecisionState();
      blockedRuntime.engageBlockedByMainMonster = true;
      saveDecisionState(blockedRuntime);
      setAtomicBranch('POST_E10_HORNET_TOKEN_READY', {
        carrierId: 'TOKEN_SKY_STRIKER',
        plannedSwordId: plannedSword.id,
        postE10HornetBambooDraw2: true,
        source: 'FORMAL_V5_POST_E10_HORNET'
      });
      console.log(
        `大黄蜂节点完成：零梦后的交闪已视为不可发动；` +
        `下一原子只把${plannedSword.name}[${plannedSword.id}]装备给衍生物，随后走竹光抽2链。`
      );
    } else {
      const bambooPlan = hornetTrueYotoWindPlan(nextState, loadDecisionState());
      setAtomicBranch('HORNET_TOKEN_READY', {
        carrierId: 'TOKEN_SKY_STRIKER',
        ...(bambooPlan || {}),
        source: 'FORMAL_V5_ATOMIC_MAIN'
      });
      console.log(
        bambooPlan
          ? (bambooPlan.hornetYotoFixedSearch === true
              ? '大黄蜂节点完成：妖刀→非火刀Link→检索真刀的确定路线已锁定；下一原子只把手牌妖刀装备给衍生物。'
              : '大黄蜂节点完成：完整竹光固定资源链已锁定；下一原子只装备计划中的手牌竹光。')
          : '大黄蜂节点完成：衍生物已记录；当前不满足真刀/双妖刀/黄金竹光闭环，保留H1 Link篝分支。'
      );
    }
  }

  return { executed: true, state: nextState, quit: false };
}

function parseCommand(raw, suggested = null) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!text) {
    if (suggested && suggested.specialAction) {
      return {
        type: 'SPECIAL',
        specialAction: suggested.specialAction,
        details: suggested.details || {},
        acceptedSuggestion: true
      };
    }
    const suggestedSlot = suggested && Number(suggested.slot);
    if (Number.isInteger(suggestedSlot)) {
      return { type: 'PLAY_SLOT', slot: suggestedSlot, branch: null, acceptedSuggestion: true };
    }
    return { type: 'EMPTY' };
  }
  if (['q', 'quit', 'exit'].includes(text)) return { type: 'QUIT' };
  if (['r', 'refresh', 'rescan'].includes(text)) return { type: 'REFRESH' };
  if (['s', 'state', 'hand'].includes(text)) return { type: 'STATE' };
  if (['h', 'help', '?'].includes(text)) return { type: 'HELP' };
  if (['f', 'field', 'continue'].includes(text)) return { type: 'FIELD' };
  if (['x', 'surrender'].includes(text)) return { type: 'SURRENDER' };

  const match = text.match(/^(\d{1,2})(?:\s+([nb]))?$/);
  if (!match) return { type: 'INVALID' };
  return {
    type: 'PLAY_SLOT',
    slot: Number(match[1]),
    branch: match[2] || null,
    acceptedSuggestion: false
  };
}

async function readDecisionCommand(state, suggestion, rl, simpleAuto) {
  const mode = simpleAuto.choose(state, suggestion);
  const raw = process.env.MD_AUTOTEST_RUN
    ? require(process.env.MD_AUTOTEST_HOOK).decision({ ...suggestion, fieldAction: currentFieldActionLabel() })
    : mode.automatic ? '' : await rl.question('\nV6> ');
  return { command: parseCommand(raw, suggestion.selected || null), automatic: mode.automatic,
    before: { revision: Number(state.revision), handCount: state.handCount } };
}

function printHelp() {
  console.log('\nV5输入：');
  console.log('  回车   = 采用“我的建议”（若场上竞速抽1曾搁置，则只继续该场上抽1）');
  console.log('  数字   = 改用你指定的当前手牌，例如 5');
  console.log('  4 n/b  = 仅调试时强制指定交闪分支；正常直接输入4，V5会自动判断是否可追加抽1');
  console.log('  f      = 只执行当前状态的下一个原子节点；绝不会自动串到再下一节点');
  console.log('  s      = 仅查看V5内部维护的当前手牌');
  console.log('  r      = 只有状态异常时才重新完整观察');
  console.log('  x      = 必定死局已证明时，输入一次直接投降并确认结果页');
  console.log('  q      = 退出；Link大支线的每一级菜单也都可 q 立即退出');
}

async function main() {
  assertEnvironment();
  const argv = process.argv.slice(2);
  const resumeKagariTrue = argv.some(arg => arg === '--resume-kagari-true');
  const resumeKagariRecovery = argv.some(arg => arg === '--resume-kagari-recovery');
  const resumeM20YotoTarget = argv.some(arg => arg === '--resume-m20-yoto-target');
  const resumeM17Resolved = argv.some(arg => arg === '--resume-m17-resolved');
  const resumeM17Search = argv.includes('--resume-m17-search');
  const resumeRayeE10Selected = argv.some(arg => arg === '--resume-raye-e10-selected');
  const resumeCurrentAtomic = argv.some(arg => arg === '--resume-current-atomic');
  const resumeCurrentDecision = argv.some(arg => arg === '--resume-current-decision');
  const resumeTerminalVictory = argv.some(arg => arg === '--resume-terminal-victory');
  const resumeVictorySettlement = argv.some(arg => arg === '--resume-victory-settlement');
  const repairLatestLedger = argv.some(arg => arg === '--repair-latest-ledger');
  const resumeM12CostPrompt = argv.some(arg => arg === '--resume-m12-cost-prompt');
  const resumeM11Selection = argv.some(arg => arg === '--resume-m11-selection');
  const recoverClosedD4 = argv.some(arg => arg === '--recover-closed-d4');
  const recoverResolvedKagari = argv.some(arg => arg === '--recover-resolved-kagari');
  const resumeEquipTarget = argv.some(arg => arg === '--resume-equip-target');
  const resumeM20ExtraEquipTarget = argv.some(arg => arg === '--resume-m20-extra-equip-target');
  const resumeHornetM20EquipTarget = argv.some(arg => arg === '--resume-hornet-m20-equip-target');
  const resumeYotoLinkAfterHandMenu = argv.some(arg => arg === '--resume-yoto-link-after-hand-menu');
  const recoverY1LinkResolved = argv.some(arg => arg === '--recover-y1-link-resolved');
  const testRayeTrueDual = argv.some(arg => arg === '--test-raye-true-dual');
  const testHornetTrueYotoLink = argv.some(arg => arg === '--test-hornet-true-yoto-link');
  const testM11Mallet = argv.some(arg => arg === '--test-m11-mallet');
  const testM18Garura = argv.some(arg => arg === '--test-m18-garura');
  // Detect an unfinished deterministic M18 sub-route BEFORE any new-duel reset
  // or opening-hand scan.  This allows a fail-closed M18 prompt to survive a
  // V5 restart without clicking the hand or destroying the live modal state.
  // A dedicated fresh M18 regression intentionally discards the previous
  // duel's failed M18 checkpoint through the ordinary new-duel reset below.
  const startupPendingM18 = testM18Garura ? null : loadPendingM18Route();
  const startupLastResortAllure = loadLastResortAllureState();
  const startupPendingObserver = fs.existsSync(PENDING_OBSERVER_PATH);
  const startupPendingM21 = loadPendingM21Transaction();
  const resume = resumeKagariTrue || resumeKagariRecovery || resumeM20YotoTarget ||
    resumeM17Resolved || resumeM17Search || resumeRayeE10Selected || resumeCurrentAtomic || resumeCurrentDecision ||
    resumeTerminalVictory || resumeVictorySettlement || repairLatestLedger ||
    resumeM12CostPrompt || resumeM11Selection || recoverClosedD4 ||
    recoverResolvedKagari ||
    resumeEquipTarget ||
    resumeM20ExtraEquipTarget ||
    resumeHornetM20EquipTarget ||
    resumeYotoLinkAfterHandMenu ||
    recoverY1LinkResolved ||
    Boolean(startupPendingM18) || Boolean(startupPendingM21) || isLastResortAllurePending(startupLastResortAllure) ||
    argv.some(arg => arg === '--resume');

  console.log(`Node运行时: v${process.versions.node} PASS`);
  console.log('============================================================');
  console.log('MD_PC_Decision_v6：正式原子主循环；简单抽牌自动接续，装备、闪刀和支线由你回车确认。');
  console.log('先完成可用固定检索/回收及普通抽牌；无特殊组合时，可用诱惑先于保护性兜底的万宝槌。');
  console.log('开局完整识别一次；之后依靠incremental observer维护手牌。手牌动作输入数字，场上续行输入 f。');
  console.log('============================================================');

  if (!resume && !startupPendingObserver) resetDecisionStateForNewDuel();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const simpleAuto = createSimpleDrawAutoController();
  let state = null;

  try {
    if (resumeM17Search && (startupPendingM21 || startupPendingObserver || isLastResortAllurePending(startupLastResortAllure))) {
      throw new Error('AUTOTEST_RESUME_M17_OTHER_TRANSACTION_PENDING');
    }
    if (startupPendingM21) {
      state = loadObserverSessionState();
      if (!state) throw new Error('M21_STARTUP_NO_HAND_CHECKPOINT');
      console.log('检测到未完成M21阶段；跳过开局扫描和新局重置，只恢复后续。');
    } else if (startupPendingObserver) {
      state = loadObserverSessionState();
      loadPendingIncrementalObservation(state);
      console.log('检测到未完成增量验收；启动只读保存点，不扫描或重置本局。');
    } else if (resumeCurrentDecision && startupLastResortAllure &&
        startupLastResortAllure.stage === 'COMPLETE_SURRENDER') {
      console.log('本局诱惑最后尝试后的投降已经完成；恢复零输入结束。新局请使用普通run-v6.cmd。');
      return;
    } else if (isLastResortAllurePending(startupLastResortAllure)) {
      state = loadObserverSessionState();
      console.log(`诱惑最后尝试事务未完成：${startupLastResortAllure.stage}；跳过手牌扫描和重新发动。`);
    } else if (resumeVictorySettlement) {
      const result = await runPostVictorySettlement({ resume: true, source: 'V6_RESUME_VICTORY_SETTLEMENT',
        requestContinue: createPostDuelTerminalPrompt(rl) });
      console.log(`V6胜利后续恢复：${result.status}`);
      return;
    } else if (resumeTerminalVictory) {
      const outcome = recoverCurrentTerminalVictory();
      console.log('\n============================================================');
      console.log('已由成熟终局识别确认：艾克佐迪亚胜利。');
      console.log(
        `严格证据：获胜文字=${outcome.strictEvidence.reasonText && outcome.strictEvidence.reasonText.matched ? 'PASS' : 'FAIL'}; ` +
        `右栏最后5张艾克佐迪亚=${outcome.strictEvidence.exodiaLastFive && outcome.strictEvidence.exodiaLastFive.matched ? 'PASS' : 'FAIL'}; ` +
        `确认按钮(辅助)=${outcome.strictEvidence.confirmButton && outcome.strictEvidence.confirmButton.matched ? 'PASS' : 'FAIL'}`
      );
      console.log('本局立即停止普通决策；不再扫描手牌、不进入普通右栏验收。');
      await confirmDetectedVictoryResult('V6_RESUME_TERMINAL_VICTORY', rl);
      console.log('============================================================');
      console.log('V6已退出。');
      return;
    } else if (resumeM11Selection) {
      state = loadObserverSessionState();
      if (!state || !loadPendingMalletCheckpoint(state)) {
        throw new Error('V5_RESUME_M11_SELECTION_NO_CHECKPOINT');
      }
      console.log('万宝槌专项恢复：进入终端后续锁，回车才恢复；不重新发动、不丢弃READY_TO_CONFIRM。');
    } else if (resumeM12CostPrompt) {
      state = loadObserverSessionState();
      const m12Slot = state.cards.findIndex(card => card && card.id === 'M12') + 1;
      const hasLevel8Cost = state.cards.some(card => card && isTradeInCostId(card.id));
      if (m12Slot < 1 || !hasLevel8Cost) {
        throw new Error(
          `V5_RESUME_M12_COST_BASELINE_INVALID:M12slot=${m12Slot};level8=${hasLevel8Cost ? 1 : 0}`
        );
      }
      console.log('\n============================================================');
      console.log('M12费用窗口恢复：抵价交易已经发动，只继续当前8星费用选择。');
      console.log(`使用当前official observer基线 revision=${state.revision}; hand=${state.handCount}。`);
      console.log('不会扫描普通手牌、不会重新发动抵价交易、不会执行其它顶层决策。');
      console.log('============================================================');
      runExecutor(
        PRODUCTION_ENTRYPOINTS.M12,
        m12Slot,
        { id: 'M12', name: '抵价交易' },
        ['--resume-cost-prompt']
      );
      state = loadObserverSessionState();
      console.log(`M12费用及抽2已闭环；observer当前手牌=${state.handCount}张，回到正常顶层决策。`);
    } else if (repairLatestLedger) {
      state = loadObserverSessionState();
      const repaired = repairLatestLedgerFromObserverState(state);
      console.log('\n============================================================');
      console.log('共享主牌组账本恢复完成：只重放最近一次已证明的observer账本提交。');
      console.log(
        `已核对 revision=${repaired.revision} 与当前完整手牌序列一致；` +
        `增量=${repaired.inserted.map(card => `${card.name}[${card.id}]`).join(' + ') || '无新增牌'}。`
      );
      console.log('没有扫描手牌、没有点击游戏、没有重放M18或交闪；现在回到正常顶层决策。');
      console.log('============================================================');
    } else if (recoverY1LinkResolved) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'M19_EQUIPPED') {
        throw new Error(`V5_RECOVER_Y1_LINK_RESOLVED_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('Y1已完成恢复：保留当前妖刀可选效果窗口，只登记被动验收节点。');
      console.log('启动阶段不发送游戏输入；第一次f从当前相邻日志确认实际Link怪兽与效果池，第二次f才发动妖刀。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RECOVER_Y1_LINK_RESOLVED_NO_OBSERVER_STATE');
      const existingBranch = loadDecisionState().v5Branch || {};
      setAtomicBranch('Y1_LINK_RESOLVED_RECOVERY_PENDING', {
        carrierId: branchCarrierId(existingBranch) || null,
        expectedLinkId: String(existingBranch.targetLinkId || existingBranch.expectedLinkId || '') || null,
        preserveRaye: existingBranch.preserveRaye === true,
        postE10HornetBambooDraw2: existingBranch.postE10HornetBambooDraw2 === true,
        hornetBambooDraw2: existingBranch.hornetBambooDraw2 === true,
        reservedYotoInHand: existingBranch.reservedYotoInHand === true,
        source: 'FORMAL_V5_RECOVER_Y1_LINK_RESOLVED_STARTUP'
      });
    } else if (resumeYotoLinkAfterHandMenu) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'M19_EQUIPPED') {
        throw new Error(`V5_RESUME_YOTO_LINK_AFTER_HAND_MENU_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('误点手牌菜单恢复：保留已完成的真刀转妖刀与Y1路线，只登记一个菜单复位原子。');
      console.log('启动阶段不发送游戏输入；进入事务锁后第一次f只关闭菜单，第二次f才Link风刀。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RESUME_YOTO_LINK_AFTER_HAND_MENU_NO_OBSERVER_STATE');
      const existingBranch = loadDecisionState().v5Branch || {};
      setAtomicBranch('HAND_MENU_DISMISS_PENDING', {
        carrierId: branchCarrierId(existingBranch) || 'TOKEN_SKY_STRIKER',
        postE10HornetBambooDraw2: existingBranch.postE10HornetBambooDraw2 === true,
        hornetBambooDraw2: existingBranch.hornetBambooDraw2 === true,
        reservedYotoInHand: existingBranch.reservedYotoInHand === true,
        source: 'FORMAL_V5_RESUME_YOTO_LINK_AFTER_HAND_MENU_STARTUP'
      });
    } else if (resumeM20ExtraEquipTarget) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'KAGARI_RECOVERY_DONE') {
        throw new Error(`V5_RESUME_M20_EXTRA_EQUIP_TARGET_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('真刀额外区装备目标窗口恢复：真刀已经发动，只选择当前额外区Link并确认。');
      console.log('模糊视觉只判定所属区域；实际点击使用该区域固定安全中心。');
      console.log('不会扫描手牌、不会重新发动真刀、不会执行其它顶层决策。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state || !state.cards.some(card => card && card.id === 'M20')) {
        throw new Error('V5_RESUME_M20_EXTRA_EQUIP_TARGET_NO_M20_BASELINE');
      }
      setAtomicBranch('M20_EXTRA_EQUIP_TARGET_PENDING', {
        carrierId: 'E02',
        plannedSwordId: 'M20',
        source: 'FORMAL_V5_RESUME_M20_EXTRA_EQUIP_TARGET_STARTUP'
      });
    } else if (resumeHornetM20EquipTarget) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'HORNET_TOKEN_READY') {
        throw new Error(`V5_RESUME_HORNET_M20_EQUIP_TARGET_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('黄蜂真刀装备目标窗口恢复：真刀已经发动，只选择中央黄蜂衍生物并确认。');
      console.log('不会扫描手牌、不会重新发动真刀、不会执行Link或其它手牌。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state || !state.cards.some(card => card && card.id === 'M20')) {
        throw new Error('V5_RESUME_HORNET_M20_EQUIP_TARGET_NO_M20_BASELINE');
      }
      setAtomicBranch('M20_EQUIP_TARGET_PENDING', {
        carrierId: 'TOKEN_SKY_STRIKER',
        plannedSwordId: 'M20',
        hornetBambooDraw2: true,
        reservedYotoInHand: true,
        source: 'FORMAL_V5_RESUME_HORNET_M20_EQUIP_TARGET_STARTUP'
      });
    } else if (resumeEquipTarget) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'KAGARI_RECOVERY_DONE') {
        throw new Error(`V5_RESUME_EQUIP_TARGET_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('妖刀装备目标窗口恢复：妖刀已发动，只选择当前额外区篝并确认。');
      console.log('不会重新扫描手牌、不会重新发动妖刀、不会点击中央空怪兽区。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state || !state.cards.some(card => card && card.id === 'M19')) {
        throw new Error('V5_RESUME_EQUIP_TARGET_NO_M19_BASELINE');
      }
      setAtomicBranch('M19_EQUIP_TARGET_PENDING', {
        carrierId: 'E02',
        source: 'FORMAL_V5_RESUME_EQUIP_TARGET_STARTUP'
      });
    } else if (recoverResolvedKagari) {
      const savedNode = currentAtomicNode();
      if (savedNode !== 'KAGARI_RECOVERY_PROMPT') {
        throw new Error(`V5_RECOVER_RESOLVED_KAGARI_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('H3已结算恢复：只验收交闪已经回手，不重放篝回收窗口。');
      console.log('跳过启动手牌扫描和右栏重建；进入事务锁后，回车/f执行H3R完整手牌证明。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RECOVER_RESOLVED_KAGARI_NO_OBSERVER_STATE');
    } else if (recoverClosedD4) {
      const savedNode = currentAtomicNode();
      if (!['DUAL_M19_BAMBOO_PROMPT', 'TRIPLE_SECOND_BAMBOO_PROMPT'].includes(savedNode)) {
        throw new Error(`V5_RECOVER_CLOSED_D4_WRONG_NODE:${savedNode || 'NONE'}`);
      }
      console.log('\n============================================================');
      console.log('D4窗口消失恢复：只验收已经发生的双效果结算，不重放任何选择点击。');
      console.log('跳过手牌扫描启动流程、跳过右栏重建、不修改已提交状态。');
      console.log('进入事务锁后，回车/f执行D4R：固定等待后完整重建手牌并核对两张收益。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RECOVER_CLOSED_D4_NO_OBSERVER_STATE');
    } else if (resumeCurrentDecision) {
      const savedNode = currentAtomicNode();
      if (isTransactionPendingNode(savedNode)) {
        // A persisted atomic lock is more authoritative than the caller's
        // generic "decision" wording.  Auto-route to the zero-input atomic
        // startup instead of failing or, worse, falling through to a strategic
        // decision that could replay an irreversible action.
        state = loadObserverSessionState();
        if (!state) throw new Error('V5_RESUME_CURRENT_DECISION_ATOMIC_NO_OBSERVER_STATE');
        console.log('\n============================================================');
        console.log(`检测到未完成原子事务：${savedNode}`);
        console.log('已将 --resume-current-decision 安全转入 --resume-current-atomic 语义。');
        console.log('跳过手牌扫描、跳过右栏重建、不修改已提交状态、不发送游戏输入。');
        console.log('进入事务锁后，回车/f只执行保存节点的下一原子动作。');
        console.log('============================================================');
      } else {
        const restored = loadCurrentDecisionWithoutRescan();
        state = restored.state;
        const node = String(restored.runtime && restored.runtime.v5Branch && restored.runtime.v5Branch.currentState || 'IDLE');
        console.log('\n============================================================');
        console.log('当前决策点无扫描恢复：完整保留本局手牌、墓地/场上状态与共享牌组账本。');
        console.log(
          `一致性校验 PASS：handRevision=${state.revision}; ledgerRevision=${restored.ledger.lastHandRevision}; ` +
          `hand=${state.handCount}; branch=${node}.`
        );
        console.log('本次启动不按 INFO/i、不点击手牌、不重建右栏baseline、不重置任何本局计数。');
        console.log('简单抽牌自动执行；装备、交闪和万宝槌等复杂决策等待回车。');
        console.log('============================================================');
      }
    } else if (resumeCurrentAtomic) {
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RESUME_CURRENT_ATOMIC_NO_OBSERVER_STATE');
      const savedNode = currentAtomicNode();
      console.log('\n============================================================');
      const safePostGoldenDecisionResume = savedNode === 'EQUIPPED_YOTO_NO_SEARCH_TARGET';
      if (!isTransactionPendingNode(savedNode) && !safePostGoldenDecisionResume) {
        throw new Error(`V5_RESUME_CURRENT_ATOMIC_NOT_PENDING:${savedNode || 'NONE'}`);
      }
      if (safePostGoldenDecisionResume) {
        console.log('已装备妖刀的关闭保存点恢复：重新核对合法竹光检索目标。');
        console.log('复用已提交手牌与牌组账本；不扫手牌、不重建右栏、不发送游戏输入。');
        console.log('有合法目标则接回Y1，否则保持顶层手牌决策；均等待用户确认。');
      } else {
        console.log(`当前原子窗口恢复：${savedNode}`);
        console.log('跳过手牌扫描、跳过右栏重建、不修改已提交状态、不发送游戏输入。');
        console.log('进入事务锁后，回车/f只执行保存节点的下一原子动作。');
      }
      console.log('============================================================');
    } else if (resumeRayeE10Selected) {
      console.log('\n============================================================');
      console.log('零梦选卡窗口恢复：跳过手牌重扫，保留当前模态窗口。');
      console.log('只恢复 RAYE_E10_SELECTED_PENDING；不会重新发动零衣或点击零梦候选。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RESUME_RAYE_E10_SELECTED_NO_OBSERVER_STATE');
      setAtomicBranch('RAYE_E10_SELECTED_PENDING', {
        carrierId: 'E10',
        equippedYoto: true,
        summonMode: 'RAYE_DIRECT',
        source: 'FORMAL_V5_RESUME_RAYE_E10_SELECTED'
      });
    } else if (resumeM17Search) {
      const ticket = readJson(process.env.MD_AUTOTEST_RESUME_TICKET);
      require('../../resume-m17').validateResumeTicket(ticket, ROOT);
      state = loadObserverSessionState();
      if (!state) throw new Error('AUTOTEST_RESUME_M17_NO_OBSERVER_STATE');
      const target = state.cards.find(c => c.id === 'M17');
      runExecutor('execution/live/run-m17-engage-bonus-draw.js', target.index || state.cards.indexOf(target) + 1,
        { id: 'M17', name: '闪刀起动－交闪' }, ['--resume-current-search'], { skipDecisionUpdate: true });
      const checkpointPath = path.join(ROOT, 'debug/m17-search-resume/state.json');
      const checkpoint = readJson(checkpointPath);
      if (!checkpoint || checkpoint.stage !== 'VERIFIED') throw new Error('AUTOTEST_RESUME_M17_NOT_VERIFIED');
      const evidence = readJson(path.join(checkpoint.attemptDir, 'execution_click.json'));
      repairResolvedM17DecisionAccounting({ attemptId: path.basename(checkpoint.attemptDir),
        evidence, selected: evidence.searchProof.selected });
      state = loadObserverSessionState();
      writeJsonAtomic(checkpointPath, { ...checkpoint, stage: 'COMPLETE', completedAt: new Date().toISOString() });
      console.log('AUTOTEST_M17_RESUME_COMPLETE：交闪检索+追加抽1已验收，恢复正常决策。');
    } else if (resumeM17Resolved) {
      console.log('\n============================================================');
      console.log('V5现场恢复：上一张交闪已经真正检索+追加抽1完成，只是增量observer右栏连续性失败。');
      console.log('不会重新发动交闪，也不会重新点检索候选/“是”。');
      console.log('只做：当前真实手牌完整重建 -> 当前右栏底部重建baseline -> 补记这次M17已进墓。');
      console.log('============================================================');

      const attempt = latestResolvedM17BonusAttempt();
      console.log(
        `恢复证据: attempt=${attempt.attemptId}; ` +
        `检索=${attempt.selected.name}[${attempt.selected.id}]; bonusDraw=YES已提交。`
      );

      state = await establishOpeningState();
      const runtime = repairResolvedM17DecisionAccounting(attempt);

      console.log(
        `\nM17现场恢复完成：当前真实手牌=${state.handCount}张；墓地魔法=${runtime.graveSpellCount}。`
      );
      console.log('已回到正常V5顶层决策；本局可以继续，不重放刚才那张交闪。');
    } else if (resumeM20YotoTarget) {
      console.log('\n真刀->妖刀现场恢复：只恢复原子状态 M19_SELECTED_FROM_DECK，不发送任何游戏输入。');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RESUME_M20_YOTO_TARGET_NO_OBSERVER_STATE');
      setAtomicBranch('M19_SELECTED_FROM_DECK', { source: 'FORMAL_V5_RESUME_ATOMIC' });
    } else if (resumeKagariRecovery) {
      console.log('\n篝回收现场恢复：只恢复原子状态 KAGARI_RECOVERY_PROMPT，不发送任何游戏输入。');
      state = loadObserverSessionState();
      if (!state) throw new Error('V5_RESUME_KAGARI_RECOVERY_NO_OBSERVER_STATE');
      setAtomicBranch('KAGARI_RECOVERY_PROMPT', { carrierId: 'E02', source: 'FORMAL_V5_RESUME_ATOMIC' });
    } else if (startupPendingM18) {
      console.log('\n============================================================');
      console.log('启动检测到未完成的M18确定性支线：跳过开局手牌扫描和右栏重建。');
      console.log(`当前M18阶段=${startupPendingM18.status}`);
      console.log('保留当前游戏窗口；进入V5[M18]锁定恢复，只允许继续该支线。');
      console.log('============================================================');
      state = loadObserverSessionState();
      if (!state) {
        throw new Error('V5_STARTUP_PENDING_M18_NO_OBSERVER_STATE');
      }
    } else {
      console.log(
        resumeKagariTrue
          ? '\n续跑模式：先重建当前真实手牌基线，然后只从“场上已有篝 + 手牌真刀”这一节点继续。'
          : '\n开局只建立一次真实手牌基线。'
      );
      state = await establishOpeningState();
    }

    if (testRayeTrueDual) {
      const hasRaye = state.cards.some(card => card.id === 'M06');
      const hasTrueSword = state.cards.some(card => card.id === 'M20');
      if (!hasRaye || !hasTrueSword) {
        throw new Error(
          `V5_DUAL_TEST_NEEDS_RAYE_AND_TRUE_BAMBOO:` +
          `M06=${hasRaye ? 1 : 0};M20=${hasTrueSword ? 1 : 0}`
        );
      }
      const testRuntime = loadDecisionState();
      testRuntime.v5TestMode = 'RAYE_TRUE_DUAL';
      testRuntime.v5TestStartedAt = new Date().toISOString();
      saveDecisionState(testRuntime);
      console.log('\n============================================================');
      console.log('V5双效果专项测试已启用：手牌数量不限，已确认零衣[M06] + 真刀竹光[M20]。');
      console.log('入口只强制通常召唤零衣；之后每次回车/f只执行正式状态机的一个原子节点。');
      console.log('目标顺序：M06通招 -> M20装备 -> T20-1/2/3 -> R1D/R1S -> D1/2/3/4。');
      console.log('============================================================');
    }

    if (testHornetTrueYotoLink) {
      const required = ['M22', 'M20', 'M19'];
      const missing = required.filter(id => !state.cards.some(card => card.id === id));
      if (missing.length > 0) {
        throw new Error(`V5_HORNET_TRUE_YOTO_TEST_MISSING_HAND:${missing.join(',')}`);
      }
      const testRuntime = loadDecisionState();
      testRuntime.v5TestMode = 'HORNET_TRUE_YOTO_LINK';
      testRuntime.v5TestStartedAt = new Date().toISOString();
      saveDecisionState(testRuntime);
      console.log('\n============================================================');
      console.log(
        'V5黄蜂真刀妖刀专项测试已启用：Y1排除火刀，现场选择任意合法非火刀；' +
        '手牌数量与其它卡不限。'
      );
      console.log('每次回车只执行正式状态机的一个原子：M22 -> B1 -> T20-1 -> T20-2 -> T20-3 -> Y1。');
      console.log('Y1只完成一个合法非火刀单素材Link并按实际选中ID验收，随后停在妖刀单效果池，不发动妖刀。');
      console.log('============================================================');
    }

    if (testM18Garura) {
      const m18Slot = state.cards.findIndex(card => card && card.id === 'M18') + 1;
      if (m18Slot < 1) {
        throw new Error('V5_M18_DEDICATED_TEST_NEEDS_M18_IN_HAND');
      }

      console.log('\n============================================================');
      console.log('V5愚蠢的重葬专项测试：只运行正式M18→迦楼拉→可选效果→抽1闭环。');
      console.log(`已确认愚蠢的重葬[M18]在当前手牌${m18Slot}。`);
      console.log('本入口已按新局重置旧M18恢复点；不会继承上一局错误的WAITING_FOR_FINAL_OBSERVER。');
      console.log('迦楼拉效果窗口必须通过：正常单卡宽度+三帧稳定+右侧选择按钮两帧证明。');
      console.log('左侧取消、手牌黄框和底部黄色碎片全部禁止点击。');
      console.log('============================================================');
      runExecutor(
        PRODUCTION_ENTRYPOINTS.M18,
        m18Slot,
        { id: 'M18', name: '愚蠢的重葬' }
      );
      state = loadObserverSessionState();
      console.log(`\nM18专项测试完成；observer当前手牌=${state.handCount}张。`);
      console.log('V6已退出。');
      return;
    }

    if (testM11Mallet) {
      const m11Slot = state.cards.findIndex(card => card && card.id === 'M11') + 1;
      if (m11Slot < 1) {
        throw new Error('V5_M11_DEDICATED_TEST_NEEDS_M11_IN_HAND');
      }
      const policy = malletPolicyForState(state);
      if (policy.returnableCount <= 0) {
        throw new Error('V5_M11_DEDICATED_TEST_HAS_NO_RETURNABLE_CARD');
      }

      console.log('\n============================================================');
      console.log('V5万宝槌专项测试：直接复用正式动态保护策略与正式M11执行器。');
      console.log(`保护不返回=${policy.keepNames.join(' / ') || '无'}；预计返回=${policy.returnableCount}张。`);
      console.log(`原因: ${policy.reason}`);
      console.log('本入口强制清除旧M11恢复点；不会继承上一局的选择/确认状态。');
      console.log('============================================================');
      runExecutor(
        PRODUCTION_ENTRYPOINTS.M11,
        m11Slot,
        { id: 'M11', name: '万宝槌' },
        [`--keep=${policy.keepIds.join(',')}`, '--fresh']
      );
      state = loadObserverSessionState();
      console.log(`M11专项测试完成；observer当前手牌=${state.handCount}张，回到正常顶层决策。`);
    }

    if (resumeKagariTrue) {
      const savedTrueRoute = loadTrueRouteStage();
      console.log('\n真刀现场恢复：禁止整条路线续跑，只恢复一个已证明的原子状态。');
      if (savedTrueRoute && String(savedTrueRoute.stage || '') === 'M20_CONVERTED_TO_M19') {
        setAtomicBranch('M19_EQUIPPED', { source: 'FORMAL_V5_RESUME_ATOMIC_TRUE' });
        console.log('恢复为 M19_EQUIPPED；下一次 f 只执行一个后续原子节点。');
      } else if (savedTrueRoute && String(savedTrueRoute.stage || '') === 'M20_EQUIPPED') {
        setAtomicBranch('M20_EQUIPPED', { source: 'FORMAL_V5_RESUME_ATOMIC_TRUE' });
        console.log('恢复为 M20_EQUIPPED；下一次 f 只执行 T20-1。');
      } else {
        console.log('没有足够阶段证据恢复真刀场上状态；保持当前手牌基线，不发送输入。');
      }
    }

    while (true) {
      const pendingAllure = loadLastResortAllureState();
      if (isLastResortAllurePending(pendingAllure)) {
        console.log(`\n诱惑最后尝试保存阶段=${pendingAllure.stage}；回车只恢复后续，q退出；禁止重新发动。`);
        const answer = String(await rl.question('V6[诱惑后续]> ')).trim();
        if (answer.toLowerCase() === 'q') break;
        if (answer !== '') continue;
        try {
          assertFreshRuntimeBeforeGameAction();
          const executor = resolveVerifiedExecutor('M13');
          if (!executor) throw new Error('M13_LAST_RESORT_RESUME_EXECUTOR_MISSING');
          const outcome = runExecutor(executor.relative, pendingAllure.slot,
            { id: 'M13', name: '暗之诱惑' }, ['--last-resort-raye', '--resume-last-resort']);
          if (outcome && outcome.terminalSurrender) break;
          state = loadObserverSessionState();
        } catch (error) {
          if (error && error.terminalVictory) {
            await confirmDetectedVictoryResult('V6_LAST_RESORT_ALLURE_TERMINAL_VICTORY', rl);
            break;
          }
          console.error(`诱惑后续停止：${error && error.message || error}；保留事务，不重放输入。`);
        }
        continue;
      }
      const pendingM18 = loadPendingM18Route();
      if (pendingM18) {
        printPendingM18Route(pendingM18);
        const rawPending = String(await rl.question('\nV5[M18]> ')).trim().toLowerCase();

        if (['q', 'quit', 'exit'].includes(rawPending)) break;

        if (['r', 'refresh', 'rescan'].includes(rawPending)) {
          assertFreshRuntimeBeforeGameAction();
          fs.rmSync(M18_ROUTE_STATE_PATH, { force: true });
          state = await establishOpeningState();
          console.log('已放弃旧M18恢复状态，并重新建立当前完整基线。');
          continue;
        }

        if (rawPending === '' || rawPending === 'c' || rawPending === 'continue') {
          assertFreshRuntimeBeforeGameAction();
          const slot = pendingM18Slot(pendingM18, state);
          if (!Number.isInteger(slot)) {
            console.error('M18恢复失败：无法从当前内部手牌确定原愚蠢的重葬槽位；未发送任何输入。');
            continue;
          }

          const m18Card = {
            id: 'M18',
            name: '愚蠢的重葬'
          };

          try {
            runExecutor(
              PRODUCTION_ENTRYPOINTS.M18,
              slot,
              m18Card
            );
            state = loadObserverSessionState();
            console.log(`\nM18确定性支线完整结束；observer当前手牌=${state.handCount}张。`);
          } catch (error) {
            console.error(`\nM18支线继续停止: ${error && error.stack ? error.stack : error}`);
            console.error('FAIL-CLOSED：仍保持M18支线锁定，不允许跳去执行其他手牌。');
          }
          continue;
        }

        console.log('M18支线未完成；这里只接受 回车/c、r 或 q，本轮没有点击。');
        continue;
      }

      const m21Recovery = await resumePendingM21AtDecision(state, rl);
      if (m21Recovery) {
        state = m21Recovery.state;
        if (m21Recovery.quit) break;
        if (m21Recovery.terminalVictory) {
          await confirmDetectedVictoryResult('V6_M21_FIELD_TERMINAL_VICTORY', rl);
          break;
        }
        continue;
      }
      const incrementalRecovery = await resumePendingIncrementalAtDecision(state, rl);
      if (incrementalRecovery) {
        state = incrementalRecovery.state;
        if (incrementalRecovery.quit) break;
        continue;
      }
      const malletRecovery = await resumePendingMalletAtDecision(state, rl);
      if (malletRecovery) {
        state = malletRecovery.state;
        if (malletRecovery.quit) break;
        continue;
      }
      normalizeEquippedYotoGoldenDrawPriority(state);
      const pendingAtomicNode = currentAtomicNode();
      if (isTransactionPendingNode(pendingAtomicNode)) {
        const hornetRouteLocked = pendingAtomicNode === 'HORNET_TOKEN_READY';
        console.log('\n============================================================');
        console.log(`${hornetRouteLocked ? '固定路线锁定' : '事务锁定'}：${pendingAtomicNode}`);
        console.log(`下一原子动作：${currentFieldActionLabel() || '继续当前事务节点'}`);
        console.log(
          hornetRouteLocked
            ? '大黄蜂衍生物已生成；先完成篝Link与回收链，禁止其它手牌抢先。'
            : '当前屏幕存在未完成交互，禁止出其它手牌、禁止完整重扫。'
        );
        console.log('回车/f = 只执行下一个原子节点；s = 查看内部手牌；q = 退出脚本但不点击游戏。');
        console.log('============================================================');
        const pendingRaw = String(await rl.question(`\nV5[${pendingAtomicNode}]> `)).trim().toLowerCase();
        if (['q', 'quit', 'exit'].includes(pendingRaw)) break;
        if (['s', 'state', 'hand'].includes(pendingRaw)) {
          printInternalHand(state);
          continue;
        }
        if (!(pendingRaw === '' || ['f', 'field', 'continue', 'c'].includes(pendingRaw))) {
          console.log('事务未完成：这里只接受 回车/f、s 或 q；本轮没有发送游戏输入。');
          continue;
        }
        assertFreshRuntimeBeforeGameAction();
        try {
          const result = await executeAtomicResponseInterval({
            state,
            rl,
            automatic: Boolean(process.env.MD_AUTOTEST_RUN),
            recoverClosedD4,
            recoverResolvedKagari
          });
          state = result.state;
          if (result.quit) break;
        } catch (error) {
          console.error(`\nV5原子事务停止: ${error && error.stack ? error.stack : error}`);
          console.error('FAIL-CLOSED：已完成节点保持提交；不会自动进入下一节点，不会切换路线。');
          try {
            const latest = loadObserverSessionState();
            if (latest) state = latest;
          } catch (_) {}
        }
        continue;
      }

      const suggestion = printDecisionPoint(state, '决策点', simpleAuto);
      const { command, automatic, before: automaticBefore } =
        await readDecisionCommand(state, suggestion, rl, simpleAuto);

      if (command.type === 'QUIT') break;
      if (command.type === 'EMPTY') continue;
      if (command.type === 'HELP') {
        printHelp();
        continue;
      }
      if (command.type === 'STATE') {
        printInternalHand(state);
        continue;
      }
      if (command.type === 'REFRESH') {
        assertFreshRuntimeBeforeGameAction();
        state = await establishOpeningState();
        console.log('已重新建立完整基线。');
        continue;
      }
      if (command.type === 'INVALID') {
        console.log('输入无法识别；本轮没有点击。输入 ? 查看格式。');
        continue;
      }

      if (command.type === 'SURRENDER') {
        const terminalDeadlock = suggestion.strategicDeadlock &&
          suggestion.strategicDeadlock.terminal === true;
        if (!terminalDeadlock) {
          console.log('当前没有“必定死局”证明；拒绝进入投降流程，本轮没有点击。');
          continue;
        }

        // The user's single-letter x is the confirmation. The current proof
        // above still gates the mature foreground-verified surrender executor.
        assertFreshRuntimeBeforeGameAction();
        try {
          const result = await runConfirmedDeadlockSurrender({ source: 'V6_TERMINAL_DEADLOCK' });
          console.log('\n投降结果页的“确认”已点击；正式投降节点完成。');
          console.log(`状态: ${result.status}`);
          console.log(`完成后调试截图: ${result.afterPath}`);
          console.log('本局已经结束；V6停止本局决策并安全退出。');
          break;
        } catch (error) {
          console.error(`\n投降流程停止: ${error && error.stack ? error.stack : error}`);
          console.error('FAIL-CLOSED：不会自动重试，不会继续点击。');
          continue;
        }
      }

      assertFreshRuntimeBeforeGameAction();

      if (command.type === 'FIELD') {
        try {
          const result = await executeAtomicResponseInterval({
            state,
            rl,
            automatic: Boolean(process.env.MD_AUTOTEST_RUN),
            recoverClosedD4,
            recoverResolvedKagari
          });
          state = result.state;
          if (result.quit) break;
        } catch (error) {
          console.error(`\nV5场上节点停止: ${error && error.stack ? error.stack : error}`);
          console.error('FAIL-CLOSED：不切换路线、不自动重试、不继续点击。');
          try {
            const latest = loadObserverSessionState();
            if (latest) state = latest;
          } catch (_) {}
        }
        continue;
      }

      if (command.type === 'SPECIAL' && command.specialAction === 'KAGARI_LINK_BEFORE_TRUE') {
        try {
          await executeKagariLinkBeforeTrue({ state });
        } catch (error) {
          console.error(`\n装真刀前的篝Link停止: ${error && error.stack || error}`);
          console.error('FAIL-CLOSED：不重放Link、不继续装刀。');
        }
        continue;
      }

      if (command.type === 'SPECIAL' && command.specialAction === 'M21_FIELD_DRAW') {
        try {
          console.log('采用我的建议：先结算场上试胆竞速[M21]此前搁置的抽1。');
          state = runPendingM21DrawExecutor();
          if (automatic) simpleAuto.completed(automaticBefore, state);
          console.log(`\n试胆竞速搁置抽1已完成；observer当前手牌=${state.handCount}张。`);
        } catch (error) {
          if (error && error.terminalVictory) {
            console.log('\n已确认艾克佐迪亚胜利；本局停止普通决策，只处理胜利结果页确认。');
            await confirmDetectedVictoryResult('V6_M21_FIELD_TERMINAL_VICTORY', rl);
            break;
          }
          simpleAuto.stop();
          console.error(`\nV6执行停止: ${error && error.stack ? error.stack : error}`);
          console.error('FAIL-CLOSED：场上M21抽1仍保持pending，不自动重试、不继续点击。');
        }
        continue;
      }


      let attemptedCard = null;
      try {
        attemptedCard = cardAtUserSlot(state, command.slot);
        if (command.acceptedSuggestion) {
          console.log(`采用我的建议：手牌${command.slot} ${attemptedCard.name}[${attemptedCard.id}]`);
        } else {
          console.log(`采用你的决策：手牌${command.slot} ${attemptedCard.name}[${attemptedCard.id}]`);
        }

        const result = await executeSelected({
          state,
          slot: command.slot,
          rl,
          branch: command.branch
        });
        if (process.env.MD_AUTOTEST_RUN) assertAutomaticExecutionResult(result, attemptedCard.id);
        state = result.state;
        if (result.quit) break;
        if (automatic) simpleAuto.completed(automaticBefore, state);
      } catch (error) {
        simpleAuto.stop();
        if (error && error.terminalVictory) {
          console.log('\n============================================================');
          console.log('已由成熟终局识别确认：艾克佐迪亚胜利。');
          console.log('本局立即停止决策；不再扫描手牌、不再读取/滚动右栏。');
          await confirmDetectedVictoryResult('V6_CARD_EXECUTOR_TERMINAL_VICTORY', rl);
          console.log('============================================================');
          break;
        }
        console.error(`\nV6执行停止: ${error && error.stack ? error.stack : error}`);
        console.error('FAIL-CLOSED：不自动重试、不换牌、不继续点击。');
        if (fs.existsSync(PENDING_OBSERVER_PATH)) {
          state = loadObserverSessionState();
          console.error('本次动作验收未完成：进入增量恢复锁，禁止旧手牌建议或自动完整重扫。');
          continue;
        }
        if (attemptedCard && attemptedCard.id === 'M11' && fs.existsSync(M11_RESUME_STATE_PATH)) {
          console.error('万宝槌事务尚未完成：下一轮只恢复当前保存阶段，不再使用发动前手牌建议。');
          continue;
        }

        // If the right log was updated during this executor and contains one
        // additional occurrence of the attempted action card, the game action
        // itself has already resolved.  The failure is only the incremental hand
        // observer.  In that narrow case a full current-state rebuild is safer
        // than returning to the menu with the stale pre-action hand.
        if (error && error.resolvedActionEvidence && attemptedCard) {
          try {
            repairResolvedSingleCardAccounting(attemptedCard);
            console.error(
              `本次 ${attemptedCard.name}[${attemptedCard.id}] 已由右栏证明结算；` +
              '现在自动完整重建当前手牌/右栏基线，不要求你手动输入 r。'
            );
            state = await establishOpeningState();
            console.error(
              `AUTO FULL RESYNC PASS：当前真实手牌=${state.handCount}张。` +
              '下一决策将只依据重建后的真实状态。'
            );
            continue;
          } catch (recoverError) {
            console.error(
              `自动重建失败: ${recoverError && recoverError.stack ? recoverError.stack : recoverError}`
            );
            console.error('保持FAIL-CLOSED；不会猜测当前手牌，请确认现场后输入 r。');
          }
        }

        // A nested deterministic branch may have already completed one or more
        // official observer checkpoints before a later node failed.  Always
        // resync the V5 top-level hand from the latest official session so the
        // next menu never falls back to the stale pre-branch hand.
        try {
          const latest = loadObserverSessionState();
          const oldRevision = Number(state && state.revision || 0);
          const newRevision = Number(latest && latest.revision || 0);
          if (latest && newRevision >= oldRevision) {
            state = latest;
            console.error(
              `V6顶层已同步到最新observer手牌：${state.handCount}张；` +
              `revision=${newRevision}。`
            );
          }
        } catch (_) {}

        if (loadPendingM21Transaction()) {
          console.error('M21阶段已保存；下一轮只恢复后续，不显示发动前手牌建议。');
        } else if (loadPendingM18Route()) {
          console.error('已检测到M18尚在确定性子支线中；下一轮进入M18锁定恢复，不会再显示普通手牌决策。');
        } else {
          console.error('现场确认后可输入 r 重建一次完整状态。');
        }
      }
    }
  } finally {
    rl.close();
  }

  console.log('V6已退出。');
}

main().catch(error => {
  console.error(`\nV6启动失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
