'use strict';

const fs = require('fs');
const path = require('path');
const { countRuntimeCardIds, changeRuntimeCardCount, canonicalRuntimeCardId, normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const { readFreshVictoryOutcome } = require('../core/simple-draw-spell-test');

const ROOT = path.resolve(__dirname, '..', '..');
const { isTradeInCostId } = require(path.join(ROOT, 'lib', 'trade-in-policy'));
const { buildTradeInCostPolicy } = require(path.join(ROOT, 'lib', 'trade-in-policy'));
const card = require(path.join(ROOT, 'execution', 'cards', 'm12-trade-in'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(
  ROOT,
  'execution',
  'core',
  'observer-current-baseline'
));
const { selectObservedHandCard } = require(path.join(
  ROOT,
  'execution',
  'core',
  'hand-target'
));
const { clickSelectedHandSpellActivation } = require(path.join(
  ROOT,
  'execution',
  'core',
  'hand-spell-activation'
));
const { selectM12CostTarget } = require(path.join(
  ROOT,
  'execution',
  'core',
  'm12-trade-in-cost-selection'
));
const { markExecutionPass } = require(path.join(
  ROOT,
  'execution',
  'core',
  'verified-status'
));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);
const PREPARED_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'scan-state-live',
  'prepared',
  'result.json'
);
const HAND_STATE_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'session_state.json'
);
const DECISION_STATE_PATH = path.join(ROOT, 'decision-state.json');

const RESUME_COST_PROMPT = process.argv.includes('--resume-cost-prompt');

function assertSupportedNode() {
  const major = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(
      `NODE_VERSION_TOO_OLD:${process.versions.node || 'UNKNOWN'};需要 Node >= 20。`
    );
  }
  console.log(`Node运行时: v${process.versions.node} PASS`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}


function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runNodeFromRoot(script, args = []) {
  console.log(`\n===== ${script} =====`);
  const out = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
  }
}

function loadTradeInCostPolicy(cards) {
  let runtime = {};
  try {
    if (fs.existsSync(DECISION_STATE_PATH)) runtime = readJson(DECISION_STATE_PATH) || {};
  } catch (_) {
    runtime = {};
  }

  const handCounts = {};
  for (const item of cards || []) {
    if (!item || !item.id) continue;
    handCounts[item.id] = Number(handCounts[item.id] || 0) + 1;
  }

  return buildTradeInCostPolicy({
    handCounts,
    usedCounts: runtime.usedCounts || {}
  });
}

function choosePlan(baseline) {
  const cards = baseline && Array.isArray(baseline.cards) ? baseline.cards : [];
  const tradeMatches = cards.filter(item => item && item.id === card.id);
  if (!tradeMatches.length) {
    throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
  }

  const trade = tradeMatches[0];
  const tradeSlot = Number(trade.index) || cards.indexOf(trade) + 1;
  const costPolicy = loadTradeInCostPolicy(cards);

  let plannedCost = null;
  if (costPolicy.plannedCost) {
    const match = cards.find(item => item && item.id === costPolicy.plannedCost.id);
    if (match) {
      plannedCost = {
        ...costPolicy.plannedCost,
        originalSlot: Number(match.index) || cards.indexOf(match) + 1
      };
    }
  }

  if (!plannedCost) {
    throw new Error(
      'M12_ACTIVATION_FORBIDDEN_NO_LEVEL8_COST:' +
      '当前没有青眼卡通龙[M07]或闪术兵器－H.A.M.P.[M08]，不会发动抵价交易。'
    );
  }

  const remaining = cards.filter((_, index) => index + 1 !== tradeSlot);
  const eligibleCosts = remaining
    .filter(item => item && isTradeInCostId(item.id))
    .map((item, index) => ({
      ...item,
      promptOrder: index + 1
    }));

  if (!eligibleCosts.some(item => item.id === plannedCost.id)) {
    throw new Error(`M12_PLANNED_COST_NOT_IN_PROMPT_MODEL:${plannedCost.id}`);
  }

  return {
    trade: {
      id: card.id,
      name: card.name,
      slot: tradeSlot,
      duplicateCount: tradeMatches.length
    },
    cost: plannedCost,
    eligibleCosts,
    costPolicy
  };
}

function detailCardId(detail) {
  return canonicalRuntimeCardId(detail && detail.card);
}

function countIds(cards) {
  return countRuntimeCardIds(cards);
}

function addCount(map, id, delta) {
  changeRuntimeCardCount(map, id, delta);
}

function verifyFinalMultiset({ baseline, costId, drawnIds, finalCards }) {
  const expected = countIds(baseline.cards);
  addCount(expected, card.id, -1);
  addCount(expected, costId, -1);
  for (const id of drawnIds) addCount(expected, id, 1);

  const actual = countIds(finalCards);
  const all = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [];
  for (const id of all) {
    const e = expected.get(id) || 0;
    const a = actual.get(id) || 0;
    if (e !== a) mismatches.push(`${id}:${e}->${a}`);
  }
  if (mismatches.length) {
    throw new Error(`M12_FINAL_HAND_MULTISET_INVALID:${mismatches.join(',')}`);
  }
}

function verifyM12ObserverResult({ baseline, plan, costProof, attemptDir }) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const targetBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (targetBlocks.length !== 1) {
    throw new Error(`M12_LOG_OPERATION_INVALID:${targetBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(
      `M12_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`
    );
  }

  const block = targetBlocks[0];
  const costs = (block.details || []).filter(detail =>
    detail &&
    detail.side === 'SELF' &&
    detail.card &&
    (detail.rawType === 'COST_TO_GRAVEYARD' || detail.role === 'HAND_COST')
  );
  const costIds = costs.map(detailCardId).filter(Boolean);
  if (!costIds.includes(plan.cost.id)) {
    throw new Error(
      `M12_RIGHT_LOG_COST_INVALID:${costIds.join(',') || 'NONE'};expected=${plan.cost.id}`
    );
  }

  const gains = (block.details || []).filter(detail =>
    detail &&
    detail.side === 'SELF' &&
    detail.role === 'HAND_GAIN_CANDIDATE'
  );
  if (gains.length !== 2) {
    throw new Error(`M12_DRAW_COUNT_INVALID:${gains.length}/2`);
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M12_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const after = incremental.after || {};
  if (after.handCount !== baseline.handCount) {
    throw new Error(
      `M12_HAND_COUNT_INVALID:${baseline.handCount}->${after.handCount};expected=${baseline.handCount}`
    );
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  if (!consumed || consumed.id !== card.id) {
    throw new Error(`M12_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }

  const inferredCosts =
    ((incremental.inference && incremental.inference.costConsumed) || [])
      .map(item => item && item.id)
      .filter(Boolean);
  if (inferredCosts.length && !inferredCosts.includes(plan.cost.id)) {
    throw new Error(
      `M12_INFERRED_COST_INVALID:${inferredCosts.join(',')};expected=${plan.cost.id}`
    );
  }

  const physicallySelected = costProof && costProof.selected && costProof.selected.id;
  if (physicallySelected !== plan.cost.id) {
    throw new Error(
      `M12_PHYSICAL_COST_PROOF_INVALID:${physicallySelected || 'NONE'};expected=${plan.cost.id}`
    );
  }

  const drawnIds = gains.map(detailCardId).filter(Boolean);
  if (drawnIds.length !== 2) {
    throw new Error(`M12_DRAWN_IDS_INVALID:${drawnIds.join(',')}`);
  }

  const inserted = incremental.insertedCards || [];
  if (inserted.length !== 2) {
    throw new Error(`M12_INSERTED_COUNT_INVALID:${inserted.length}/2`);
  }

  verifyFinalMultiset({
    baseline,
    costId: plan.cost.id,
    drawnIds,
    finalCards: after.cards || []
  });

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(
    INCREMENTAL_RESULT_PATH,
    path.join(attemptDir, 'hand_incremental_result.json')
  );

  return {
    beforeCount: baseline.handCount,
    afterCount: after.handCount,
    paidCost: {
      id: plan.cost.id,
      name: plan.cost.name
    },
    drawn: gains.map(detail => normalizeExodiaComponentCard({
      id: detailCardId(detail),
      name: detail.card && detail.card.name || detailCardId(detail)
    })),
    insertedCards: inserted,
    finalHand: after.cards || [],
    operation: block
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    RESUME_COST_PROMPT ? 'M12_trade_in_resume_cost' : 'M12_trade_in',
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let plan;
  let selected;
  let actionProof;
  let costProof;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    if (RESUME_COST_PROMPT) {
      // The V5 fast-continuation path intentionally reuses session_state and
      // may leave scan-state-live/prepared from an older duel.  A live modal
      // recovery must therefore use only the current official observer state.
      if (!fs.existsSync(HAND_STATE_PATH)) {
        throw new Error('M12_RESUME_BASELINE_MISSING');
      }
      baseline = readJson(HAND_STATE_PATH);
      if (!baseline || !Number.isInteger(baseline.revision) ||
          !Number.isInteger(baseline.handCount) ||
          !Array.isArray(baseline.cards) ||
          baseline.cards.length !== baseline.handCount ||
          !baseline.cards.some(item => item && item.id === 'M12') ||
          !baseline.cards.some(item => item && isTradeInCostId(item.id))) {
        throw new Error('M12_RESUME_BASELINE_INVALID');
      }
      plan = choosePlan(baseline);

      console.log('\n============================================================');
      console.log('M12恢复：抵价交易已经发动，当前应停在8星费用专用选择窗口。');
      console.log('不会重新读普通手牌、不会重新发动抵价交易。');
      console.log(`恢复基线: official session_state revision=${baseline.revision}; hand=${baseline.handCount}。`);
      console.log(`费用候选仍从左向右遍历；本轮优先级 ${plan.costPolicy.priority.map(x => `${x.name}[${x.id}]`).join(' > ')}。`);
      console.log('============================================================');

      costProof = await selectM12CostTarget({
        bridge,
        info,
        library,
        templates,
        plannedCost: plan.cost,
        eligibleCosts: plan.eligibleCosts,
        debugDir: attemptDir
      });
    } else {
      baseline = await establishCurrentObserverBaseline({
        bridge,
        info,
        outputDir: path.join(attemptDir, 'observer_baseline')
      });

      if (baseline.handCount < card.minHandCountBeforeActivation) {
        throw new Error(
          `M12_HAND_COUNT_BELOW_ACTIVATION_MIN:` +
          `${baseline.handCount}<${card.minHandCountBeforeActivation}`
        );
      }

      plan = choosePlan(baseline);

      console.log('\n抵价交易本轮计划：');
      console.log(`  发动: 抵价交易[M12] @手牌${plan.trade.slot}`);
      console.log(`  费用优先级: ${plan.costPolicy.priority.map(x => `${x.name}[${x.id}]`).join(' > ')}`);
      console.log(`  卡通目录入墓: ${plan.costPolicy.toonTablesInGrave}/3；${plan.costPolicy.protectToonDragon ? '未全部入墓，优先保护青眼卡通龙' : '已全部入墓，可优先支付青眼卡通龙'}`);
      console.log(
        `  计划费用: ${plan.cost.name}[${plan.cost.id}] @原手牌${plan.cost.originalSlot}`
      );
      console.log(
        `  专用窗口候选顺序模型: ` +
        `${plan.eligibleCosts.map(item => `${item.name}[${item.id}]`).join(' | ')}`
      );

      console.log('\n============================================================');
      console.log('准备自动操作：抵价交易[M12]');
      console.log('普通部分完全复用封板M09/M15：observer基线 -> observer真实定位 -> 发动。');
      console.log('特殊部分沿用旧M12专用费用窗口，只把选择方式统一成从左向右逐候选精确认。');
      console.log('费用确认后纯等待抽2，再由正式observer验收。');
      console.log('============================================================');

      selected = await selectObservedHandCard({
        bridge,
        info,
        library,
        templates,
        baseline,
        expectedId: card.id,
        debugDir: attemptDir
      });
      console.log(
        `发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS ` +
        `@手牌${selected.slot}`
      );

      actionProof = await clickSelectedHandSpellActivation({
        bridge,
        info,
        expectedId: card.id,
        expectedName: card.name,
        clickReference: selected.clickReference,
        debugDir: attemptDir
      });

      console.log(
        '已点击“发动”：抵价交易[M12]；零输入等待8星费用专用窗口出现。'
      );

      costProof = await selectM12CostTarget({
        bridge,
        info,
        library,
        templates,
        plannedCost: plan.cost,
        eligibleCosts: plan.eligibleCosts,
        debugDir: attemptDir
      });
    }

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      resumeCostPrompt: RESUME_COST_PROMPT,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      plan,
      selected,
      actionProof,
      costProof
    });

    console.log(
      `抵价交易费用确认完成: ${costProof.selected.name}[${costProof.selected.id}]；` +
      `纯等待${card.settleAfterCostMs}ms让抽2动画稳定。`
    );
    await sleep(card.settleAfterCostMs);
  } finally {
    await bridge.stop().catch(() => {});
  }

  const outcomePath = path.join(ROOT, 'debug/duel-outcome-live/latest_result.json');
  const previousOutcomeMtime = fs.existsSync(outcomePath) ? fs.statSync(outcomePath).mtimeMs : 0;
  const observerStartedAt = Date.now();
  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
  const terminalOutcome = readFreshVictoryOutcome(previousOutcomeMtime, observerStartedAt);
  if (terminalOutcome) {
    copyIfExists(outcomePath, path.join(attemptDir, 'duel_outcome_result.json'));
    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'TERMINAL_VICTORY', completedAt: new Date().toISOString(),
      target: { id: card.id, name: card.name }, baseline, plan, selected, actionProof, costProof, terminalOutcome
    });
    markExecutionPass({ id: card.id, name: card.name,
      testEntry: 'execution\\live\\run-m12-trade-in.cmd', evidenceDir: attemptDir,
      scope: '当前M12结算由新鲜严格艾克佐迪亚胜利证据确认；不读取旧手牌增量' });
    console.log('M12严格胜利已确认：普通抽牌验收作废，不再验证旧手牌或读取INFO。');
    return;
  }

  const verified = verifyM12ObserverResult({
    baseline,
    plan,
    costProof,
    attemptDir
  });

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    plan,
    selected,
    actionProof,
    costProof,
    observerVerification: verified
  });

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m12-trade-in.cmd',
    evidenceDir: attemptDir,
    scope:
      '1~12手牌；发动定位复用封板公共执行；M12专用费用窗口左->右逐候选精确认；' +
      '费用动态优先：3张卡通目录未全部入墓时M08>M07，全部入墓后M07>M08；正式observer验证M12+费用离手、抽2、最终手牌净变化0'
  });

  console.log('\n============================================================');
  console.log('M12执行测试 PASS: 抵价交易');
  console.log(`实际支付: ${verified.paidCost.name}[${verified.paidCost.id}]`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(
    `实际抽到: ${verified.drawn.map(item => `${item.name}[${item.id}]`).join(' / ')}`
  );
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nM12执行测试停止: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  choosePlan,
  verifyM12ObserverResult,
  verifyFinalMultiset
};
