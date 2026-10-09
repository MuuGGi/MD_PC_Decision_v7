'use strict';

const fs = require('fs');
const path = require('path');
const { countRuntimeCardIds, changeRuntimeCardCount, canonicalRuntimeCardId } = require('../../lib/exodia-policy');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const { beginAtomicLogObservation, completeAtomicLogObservation } = require('../core/atomic-log-observation');
const { observeCompletion } = require('../core/observer-completion');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm17-engage'));
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
const {
  buildSearchPriority,
  selectM17SearchTarget,
  verifyNoBonusDrawPrompt
} = require(path.join(ROOT, 'execution', 'core', 'm17-engage-search'));
const { markExecutionBranchPass } = require(path.join(
  ROOT,
  'execution',
  'core',
  'verified-branch-status'
));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);

function assertSupportedNode() {
  const major = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`NODE_VERSION_TOO_OLD:${process.versions.node || 'UNKNOWN'};需要 Node >= 20。`);
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
  if (out.status !== 0) throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
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

function verifyFinalMultiset({ baseline, searchedId, finalCards }) {
  const expected = countIds(baseline.cards);
  addCount(expected, card.id, -1);
  addCount(expected, searchedId, 1);
  const actual = countIds(finalCards);
  const all = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [];
  for (const id of all) {
    const e = expected.get(id) || 0;
    const a = actual.get(id) || 0;
    if (e !== a) mismatches.push(`${id}:${e}->${a}`);
  }
  if (mismatches.length) {
    throw new Error(`M17_FINAL_HAND_MULTISET_INVALID:${mismatches.join(',')}`);
  }
}

function verifyM17ObserverResult({ baseline, searchProof, attemptDir }) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const engageBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (engageBlocks.length !== 1) {
    throw new Error(`M17_LOG_OPERATION_INVALID:${engageBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(
      `M17_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`
    );
  }

  const gains = (engageBlocks[0].details || []).filter(detail =>
    detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  );
  const searchedId = searchProof && searchProof.selected && searchProof.selected.id;
  if (gains.length !== 1 || detailCardId(gains[0]) !== searchedId) {
    throw new Error(
      `M17_NO_BONUS_RIGHT_LOG_GAIN_INVALID:` +
      `${gains.map(detailCardId).join(',') || 'NONE'};expected=${searchedId || 'NONE'}`
    );
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M17_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const inserted = incremental.insertedCards || [];
  const after = incremental.after || {};

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`M17_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 1 || inserted.length !== 1) {
    throw new Error(
      `M17_NO_BONUS_BRANCH_INVALID:added=${addedCount};inserted=${inserted.length};` +
      'expected=1 searched card and no bonus draw'
    );
  }
  if (!inserted[0].card || inserted[0].card.id !== searchedId) {
    throw new Error(
      `M17_INSERTED_TARGET_INVALID:${inserted[0] && inserted[0].card && inserted[0].card.id || 'NONE'};` +
      `expected=${searchedId}`
    );
  }
  if (after.handCount !== baseline.handCount) {
    throw new Error(
      `M17_HAND_COUNT_INVALID:${baseline.handCount}->${after.handCount};expected=${baseline.handCount}`
    );
  }

  verifyFinalMultiset({
    baseline,
    searchedId,
    finalCards: after.cards || []
  });

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    beforeCount: baseline.handCount,
    afterCount: after.handCount,
    searched: {
      id: searchedId,
      name: gains[0].card && gains[0].card.name || searchedId
    },
    inserted: inserted[0],
    finalHand: after.cards || [],
    operation: engageBlocks[0]
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    'M17_engage_no_bonus_draw',
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;
  let searchProof;
  let noBonusProof;
  let priorityPlan;
  let logTransaction;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, 'observer_baseline')
    });

    const matches = (baseline.cards || []).filter(item => item && item.id === card.id);
    if (!matches.length) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }
    const first = matches[0];
    const slot = Number(first.index) || baseline.cards.indexOf(first) + 1;
    priorityPlan = buildSearchPriority(baseline);
    logTransaction = await beginAtomicLogObservation({ bridge, info, baseline, activationKey: card.id });

    console.log('\n交闪本轮计划：');
    console.log(`  发动: ${card.name}[${card.id}] @手牌${slot}`);
    console.log(`  本轮分支: 无追加抽1`);
    console.log(`  检索策略: ${priorityPlan.reason}`);
    console.log(
      `  检索优先级: ${priorityPlan.targets.map(target => `${target.name}[${target.id}]`).join(' > ')}`
    );
    console.log('  专用检索窗口: 从左向右逐候选精确认；非最终目标同点取消选中。');

    console.log('\n============================================================');
    console.log('准备自动操作：闪刀起动－交闪[M17]（无追加抽1分支）');
    console.log('普通发动完全复用目前封板公共执行：observer基线 -> observer真实位置 -> 发动。');
    console.log('特殊部分参考旧M17实战PASS：专用检索窗口选目标；若出现追加抽1确认框则绝不点击并安全停止。');
    console.log('候选精确认后统一等待600ms再点击“选择/确认”；结算阶段只截图/纯等待。');
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
      `@手牌${selected.slot}${selected.duplicateCount > 1 ? `（同名${selected.duplicateCount}张，取最左）` : ''}`
    );

    actionProof = await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: card.id,
      expectedName: card.name,
      clickReference: selected.clickReference,
      debugDir: attemptDir
    });
    console.log(`已点击“发动”：${card.name}[${card.id}]；零输入等待专用检索窗口。`);

    searchProof = await selectM17SearchTarget({
      bridge,
      info,
      library,
      templates,
      baseline,
      priorityPlan,
      debugDir: attemptDir
    });

    console.log(
      `交闪检索确认完成: ${searchProof.selected.name}[${searchProof.selected.id}]；` +
      '现在只截图确认没有出现追加抽1询问。'
    );

    noBonusProof = await verifyNoBonusDrawPrompt({
      bridge,
      info,
      debugDir: attemptDir,
      durationMs: card.noBonusProbeMs
    });

    console.log(`无追加抽1分支已证明；纯等待${card.settleAfterSearchMs}ms让结算动画稳定。`);
    await sleep(card.settleAfterSearchMs);

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      branch: card.branch,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      priorityPlan,
      selected,
      actionProof,
      searchProof,
      noBonusProof
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  const transactionArgs = completeAtomicLogObservation(logTransaction, {
    selected, actionProof, gainCount: 1, firstGainId: searchProof.selected.id,
    confirmationProofs: [searchProof.selected.accepted === true,
      Number(searchProof.confirmProof?.yellowPixels) > 0, noBonusProof.detected === false]
  }, attemptDir);
  const completion = observeCompletion(() => runNodeFromRoot('runtime/observer/run-live-incremental.js',
    ['--adjacent-checkpoint-only', ...transactionArgs]));
  if (completion.kind === 'TERMINAL_VICTORY') {
    writeJson(path.join(attemptDir, 'result.json'), { status: 'PASS_TERMINAL_VICTORY', completion });
    return;
  }

  const verified = verifyM17ObserverResult({
    baseline,
    searchProof,
    attemptDir
  });

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    branch: card.branch,
    baselineHandCount: baseline.handCount,
    baselineHand: baseline.cards,
    priorityPlan,
    selected,
    actionProof,
    searchProof,
    noBonusProof,
    observerVerification: verified
  });

  markExecutionBranchPass({
    id: card.id,
    name: card.name,
    branch: card.branch,
    testEntry: 'execution\\live\\run-m17-engage-no-bonus-draw.cmd',
    evidenceDir: attemptDir,
    scope:
      '1~12手牌；普通发动复用封板TITLE_COMPONENTS/DENSE实测位置；交闪专用检索窗口左->右逐候选精确认；' +
      '非最终候选同点取消；点卡后延迟600ms再提交；若追加抽1确认框出现则零输入安全停止；' +
      '正式observer验证M17离手+仅检索1张+手牌数不变'
  });

  console.log('\n============================================================');
  console.log('M17执行测试 PASS: 闪刀起动－交闪（无追加抽1）');
  console.log(`实际检索: ${verified.searched.name}[${verified.searched.id}]`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(
    `新增手牌: ${verified.inserted.card.name}[${verified.inserted.card.id}] ` +
    `@手牌${verified.inserted.slot}`
  );
  console.log(`测试记录: ${attemptDir}`);
  console.log('注意：这里只封 M17:NO_BONUS_DRAW 分支；追加抽1分支尚未在V2现场复测。');
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM17无追加抽1执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
