'use strict';

const fs = require('fs');
const path = require('path');
const { countRuntimeCardIds, changeRuntimeCardCount, canonicalRuntimeCardId, normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const { beginAtomicLogObservation, completeAtomicLogObservation } = require('../core/atomic-log-observation');
const { observeCompletion } = require('../core/observer-completion');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm17-engage-bonus-draw'));
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
  resumeSelectedM17Search,
  confirmM17BonusDrawPrompt
} = require(path.join(ROOT, 'execution', 'core', 'm17-engage-search'));
const {
  markExecutionBranchPass,
  markExecutionCardSealed
} = require(path.join(ROOT, 'execution', 'core', 'verified-branch-status'));

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

function verifyFinalMultiset({ baseline, searchedId, drawId, finalCards }) {
  const expected = countIds(baseline.cards);
  addCount(expected, card.id, -1);
  addCount(expected, searchedId, 1);
  addCount(expected, drawId, 1);
  const actual = countIds(finalCards);
  const all = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [];
  for (const id of all) {
    const e = expected.get(id) || 0;
    const a = actual.get(id) || 0;
    if (e !== a) mismatches.push(`${id}:${e}->${a}`);
  }
  if (mismatches.length) {
    throw new Error(`M17_BONUS_FINAL_HAND_MULTISET_INVALID:${mismatches.join(',')}`);
  }
}

function verifyM17BonusObserverResult({ baseline, searchProof, attemptDir }) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const engageBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (engageBlocks.length !== 1) {
    throw new Error(`M17_BONUS_LOG_OPERATION_INVALID:${engageBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(
      `M17_BONUS_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`
    );
  }

  const gains = (engageBlocks[0].details || []).filter(detail =>
    detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  );
  const searchedId = searchProof && searchProof.selected && searchProof.selected.id;
  if (gains.length !== 2) {
    throw new Error(`M17_BONUS_RIGHT_LOG_GAIN_COUNT_INVALID:${gains.length}/2`);
  }
  if (detailCardId(gains[0]) !== searchedId) {
    throw new Error(
      `M17_BONUS_SEARCH_GAIN_INVALID:${detailCardId(gains[0]) || 'NONE'};expected=${searchedId}`
    );
  }
  const drawId = detailCardId(gains[1]);
  if (!drawId) throw new Error('M17_BONUS_DRAW_CARD_UNKNOWN_IN_RIGHT_LOG');

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M17_BONUS_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const after = incremental.after || {};
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`M17_BONUS_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 2) {
    throw new Error(`M17_BONUS_ADDED_COUNT_INVALID:${addedCount}/2`);
  }
  if (after.handCount !== baseline.handCount + 1) {
    throw new Error(
      `M17_BONUS_HAND_COUNT_INVALID:${baseline.handCount}->${after.handCount};` +
      `expected=${baseline.handCount + 1}`
    );
  }
  if (!Array.isArray(after.cards) || after.cards.length !== after.handCount) {
    throw new Error(
      `M17_BONUS_AFTER_HAND_SEQUENCE_INVALID:${after.cards && after.cards.length}/${after.handCount}`
    );
  }

  verifyFinalMultiset({
    baseline,
    searchedId,
    drawId,
    finalCards: after.cards
  });

  // 当前低/高手牌 observer 都通常会给出两张 insertedCards；
  // 但完整手牌 multiset + 右栏两张 HAND_GAIN 才是最终硬证据。
  if (inserted.length && inserted.length !== 2) {
    throw new Error(`M17_BONUS_INSERTED_CARD_COUNT_INVALID:${inserted.length}/2`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    beforeCount: baseline.handCount,
    afterCount: after.handCount,
    searched: {
      id: searchedId,
      name: gains[0].card && gains[0].card.name || searchedId
    },
    bonusDraw: normalizeExodiaComponentCard({
      id: drawId,
      name: gains[1].card && gains[1].card.name || drawId
    }),
    inserted,
    finalHand: after.cards,
    operation: engageBlocks[0]
  };
}

async function main() {
  assertSupportedNode();
  const resume = process.argv.includes('--resume-current-search');
  const resumeStatePath = path.join(ROOT, 'debug/m17-search-resume/state.json');
  let resumeTicket;
  if (resume) {
    resumeTicket = readJson(process.env.MD_AUTOTEST_RESUME_TICKET);
    require('../../../autotest/resume-m17').validateResumeTicket(resumeTicket, ROOT);
    if (fs.existsSync(resumeStatePath)) throw new Error('AUTOTEST_RESUME_M17_CHECKPOINT_ALREADY_EXISTS');
  }

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    'M17_engage_bonus_draw',
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;
  let searchProof;
  let bonusProof;
  let priorityPlan;
  let logTransaction;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    baseline = resume ? resumeTicket.baseline : await establishCurrentObserverBaseline({
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
    if (!resume) logTransaction = await beginAtomicLogObservation({ bridge, info, baseline, activationKey: card.id });

    if (resume) {
      console.log('交闪局内恢复：沿用发动前保存基线，不扫描手牌、不重新发动、不点击候选牌。');
      console.log(`当前计划最高目标=${priorityPlan.targets[0].name}[${priorityPlan.targets[0].id}]；只恢复已选中卡的提交和追加抽1。`);
    } else {
    console.log('\n交闪本轮计划：');
    console.log(`  发动: ${card.name}[${card.id}] @手牌${slot}`);
    console.log('  本轮分支: 检索1 + 追加抽1');
    console.log(`  检索策略: ${priorityPlan.reason}`);
    console.log(
      `  检索优先级: ${priorityPlan.targets.map(target => `${target.name}[${target.id}]`).join(' > ')}`
    );
    console.log('  专用检索窗口仍从左向右逐候选精确认；普通部分与刚刚PASS的无追加抽1分支完全一致。');

    console.log('\n============================================================');
    console.log('准备自动操作：闪刀起动－交闪[M17]（追加抽1分支）');
    console.log('前半段完全复用刚刚PASS的M17无追加抽1：observer基线 -> 实测位置发动 -> 同一检索策略。');
    console.log('唯一新增阶段：必须稳定识别追加抽1确认框 -> 等650ms复核 -> 点击“是”。');
    console.log('如果“是”未响应，只允许补点“是”1次；绝不重新点击检索候选。');
    console.log('确认后纯等待，再由正式observer验证“检索1 + 额外抽1”，最终手牌 +1。');
    console.log('============================================================');

    }
    if (resume) {
      const checkpoint = stage => writeJson(resumeStatePath, { stage, attemptDir,
        sourceAttempt: resumeTicket.sourceAttempt, updatedAt: new Date().toISOString() });
      selected = { selected: first, slot, resumed: true };
      actionProof = { resumed: true, sourceAttempt: resumeTicket.sourceAttempt, activationReplayed: false };
      searchProof = await resumeSelectedM17Search({ bridge, info, library, templates, baseline,
        priorityPlan, debugDir: attemptDir,
        sourceCandidatePath: path.join(resumeTicket.sourceAttempt, 'm17_search_candidates_latest.png'),
        beforeSubmit: () => checkpoint('SUBMIT_IN_FLIGHT') });
      checkpoint('SEARCH_SUBMITTED');
    } else {
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
    }

    console.log(
      `交闪检索确认完成: ${searchProof.selected.name}[${searchProof.selected.id}]；` +
      '现在只截图等待追加抽1确认框。'
    );

    bonusProof = await confirmM17BonusDrawPrompt({
      bridge,
      info,
      debugDir: attemptDir,
      beforeYes: resume ? () => writeJson(resumeStatePath, { stage: 'BONUS_IN_FLIGHT', attemptDir,
        sourceAttempt: resumeTicket.sourceAttempt, searchProof, updatedAt: new Date().toISOString() }) : null,
      timeoutMs: card.bonusPromptTimeoutMs
    });

    console.log(
      `追加抽1已确认；纯等待${card.settleAfterBonusConfirmMs}ms让检索牌和额外抽牌全部结算。`
    );
    await sleep(card.settleAfterBonusConfirmMs);

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      branch: card.branch,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      priorityPlan,
      selected,
      actionProof,
      searchProof,
      bonusProof
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  const transactionArgs = completeAtomicLogObservation(logTransaction, {
    selected, actionProof, gainCount: 2, firstGainId: searchProof.selected.id,
    confirmationProofs: [searchProof.selected.accepted === true,
      Number(searchProof.confirmProof?.yellowPixels) > 0, bonusProof.clicked === true]
  }, attemptDir);
  const completion = observeCompletion(() => runNodeFromRoot('runtime/observer/run-live-incremental.js',
    ['--adjacent-checkpoint-only', ...transactionArgs]));
  if (completion.kind === 'TERMINAL_VICTORY') {
    writeJson(path.join(attemptDir, 'result.json'), { status: 'PASS_TERMINAL_VICTORY',
      completedAt: new Date().toISOString(), target: { id: card.id, name: card.name }, completion });
    console.log('M17执行终局 PASS：严格胜利替代普通手牌验收，不读取旧增量结果。');
    return;
  }

  const verified = verifyM17BonusObserverResult({
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
    bonusProof,
    observerVerification: verified
  });
  if (resume) writeJson(resumeStatePath, { stage: 'VERIFIED', attemptDir,
    sourceAttempt: resumeTicket.sourceAttempt, verifiedAt: new Date().toISOString() });

  markExecutionBranchPass({
    id: card.id,
    name: card.name,
    branch: card.branch,
    testEntry: 'execution\\live\\run-m17-engage-bonus-draw.cmd',
    evidenceDir: attemptDir,
    scope:
      '1~12手牌；前半段完全复用M17:NO_BONUS_DRAW已现场PASS的发动/检索；' +
      '追加抽1确认沿用旧M17成熟ROI=(1040,590,290,80)、YES=(1183,630)，稳定3帧+650ms复核后才点击；' +
      '按钮未响应只补点YES一次；正式observer验证M17离手+检索1+追加抽1+最终手牌净+1'
  });

  markExecutionCardSealed({
    id: card.id,
    name: card.name,
    requiredBranches: ['NO_BONUS_DRAW', 'BONUS_DRAW'],
    testEntry: 'execution\\live\\run-m17-engage-bonus-draw.cmd',
    evidenceDir: attemptDir,
    scope:
      'M17两个现场分支均PASS：NO_BONUS_DRAW=检索1/净0；BONUS_DRAW=检索1+追加抽1/净+1；' +
      '普通发动和检索逻辑共用，整卡可封板'
  });

  console.log('\n============================================================');
  console.log('M17执行测试 PASS: 闪刀起动－交闪（追加抽1）');
  console.log(`实际检索: ${verified.searched.name}[${verified.searched.id}]`);
  console.log(`额外抽到: ${verified.bonusDraw.name}[${verified.bonusDraw.id}]`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  if (verified.inserted.length) {
    console.log(
      `observer新增: ${verified.inserted.map(item =>
        `${item.card.name}[${item.card.id}]@手牌${item.slot}`
      ).join(' / ')}`
    );
  }
  console.log(`测试记录: ${attemptDir}`);
  console.log('如果此前NO_BONUS_DRAW分支已在本工程PASS，本次会同时把M17整卡标记为SEALED。');
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM17追加抽1执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
