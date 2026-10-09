'use strict';

const fs = require('fs');
const path = require('path');
const { isExodiaComponentId, sameRuntimeCardIdentity, normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const {readJson, writeJsonAtomic, restoreBuffer, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const { observeCompletion } = require('../core/observer-completion');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm18-extra-foolish-burial'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));
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
  GARURA_ID,
  GARURA_NAME,
  prepareGaruraExtraDeckSelection,
  confirmPreparedGaruraExtraDeckSelection,
  prepareGaruraEffectSelection,
  confirmPreparedGaruraEffectSelection
} = require(path.join(
  ROOT,
  'execution',
  'core',
  'm18-garura-route'
));
const { markExecutionPass } = require(path.join(
  ROOT,
  'execution',
  'core',
  'verified-status'
));

const HAND_STATE_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'session_state.json'
);
const LOG_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'duel-log-live',
  'latest_result.json'
);
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);
const ROUTE_DIR = path.join(ROOT, 'debug', 'execution', 'M18_foolish_burial');
const ROUTE_STATE_PATH = path.join(ROUTE_DIR, 'route_state.json');

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

function detailCardId(detail) {
  return String(detail && detail.card && detail.card.id || '');
}

function validateActivationOnlyStage(log) {
  const newBlocks = log.newOperationBlocks || [];
  const m18Blocks = newBlocks.filter(block => block && block.activationKey === card.id);
  if (m18Blocks.length !== 1) {
    throw new Error(`M18_ACTIVATION_STAGE_OPERATION_INVALID:${m18Blocks.length}/1`);
  }

  const activation = m18Blocks[0];
  const alreadySent = (activation.details || []).some(detail =>
    detail &&
    detail.card &&
    detail.card.id === GARURA_ID &&
    detail.rawType === 'SEND_EXTRA_DECK_TO_GRAVEYARD'
  );
  if (alreadySent) {
    throw new Error('M18_ACTIVATION_STAGE_TOO_LATE:E01_ALREADY_SENT');
  }

  const gains = newBlocks
    .flatMap(block => block.details || [])
    .filter(detail =>
      detail &&
      detail.side === 'SELF' &&
      detail.role === 'HAND_GAIN_CANDIDATE'
    );
  if (gains.length) {
    throw new Error(`M18_ACTIVATION_STAGE_TOO_LATE:DRAW_ALREADY_VISIBLE:${gains.length}`);
  }

  return activation;
}

function commitKnownM18Consumption(beforeState, operation) {
  const consumedIndex = (beforeState.cards || []).findIndex(
    item => item && item.id === card.id
  );
  if (consumedIndex < 0) {
    throw new Error('M18_DEFERRED_CONSUMPTION_NOT_IN_HAND');
  }

  const consumed = beforeState.cards[consumedIndex];
  const cards = beforeState.cards
    .filter((_, index) => index !== consumedIndex)
    .map((item, index) => ({ ...item, index: index + 1 }));

  if (!Number.isInteger(beforeState.handCount) || cards.length !== beforeState.handCount - 1) {
    throw new Error(
      `M18_DEFERRED_HAND_INVALID:${beforeState.handCount}/${cards.length}`
    );
  }

  return {
    ...beforeState,
    capturedAt: new Date().toISOString(),
    revision: Number(beforeState.revision || 0) + 1,
    handCount: cards.length,
    cards,
    lastOperation: {
      activationKey: card.id,
      signature: operation && operation.signature
        ? operation.signature
        : 'M18|KNOWN_CONSUMPTION',
      activationOccurrence: operation && operation.activationOccurrence
        ? operation.activationOccurrence
        : null
    },
    lastIncremental: {
      mode: 'M18_DEFERRED_CONSUMPTION_BEFORE_E01_DRAW',
      consumed,
      costConsumed: [],
      predictedSlots: [],
      recognized: [],
      finalClicks: []
    }
  };
}

function validateFinalM18Resolution({ routeState, attemptDir }) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const visibleBlocks = log.operationBlocks || log.activationBlocks || newBlocks;

  const resolvedM18 = visibleBlocks.find(block =>
    block &&
    block.activationKey === card.id &&
    (block.details || []).some(detail =>
      detail &&
      detail.card &&
      detail.card.id === GARURA_ID &&
      detail.rawType === 'SEND_EXTRA_DECK_TO_GRAVEYARD'
    )
  );

  if (!resolvedM18) {
    throw new Error('M18_FINAL_GARURA_SEND_EVIDENCE_MISSING:M18->E01');
  }

  const e01Blocks = newBlocks.filter(block => block && block.activationKey === GARURA_ID);
  if (e01Blocks.length !== 1) {
    throw new Error(`M18_FINAL_E01_OPERATION_INVALID:${e01Blocks.length}/1`);
  }

  const gains = (e01Blocks[0].details || []).filter(detail =>
    detail &&
    detail.side === 'SELF' &&
    detail.role === 'HAND_GAIN_CANDIDATE'
  );
  const drawn = normalizeExodiaComponentCard(gains[0] && gains[0].card);
  if (gains.length !== 1 || !drawn || (!/^M\d+$/.test(String(drawn.id || '')) && !isExodiaComponentId(drawn.id))) {
    throw new Error(
      `M18_FINAL_DRAW_INVALID:${gains.length}:${drawn && drawn.id || 'UNKNOWN'}`
    );
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M18_FINAL_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const baselineCount = routeState.baselineHandCount;
  const beforeCount = incremental.before && incremental.before.handCount;
  const after = incremental.after || {};
  const inserted = incremental.insertedCards || [];

  if (beforeCount !== baselineCount - 1) {
    throw new Error(
      `M18_FINAL_INTERMEDIATE_COUNT_INVALID:${beforeCount}/${baselineCount - 1}`
    );
  }
  if (after.handCount !== baselineCount) {
    throw new Error(
      `M18_FINAL_HAND_COUNT_INVALID:${after.handCount}/${baselineCount}`
    );
  }
  if (inserted.length !== 1 ||
      !inserted.some(item => item && item.card && sameRuntimeCardIdentity(item.card, drawn))) {
    throw new Error(`M18_FINAL_INSERTED_INVALID:${inserted.length}/${drawn.id}`);
  }

  const m18SendId = (resolvedM18.details || [])
    .map(detailCardId)
    .find(id => id === GARURA_ID);
  if (m18SendId !== GARURA_ID) {
    throw new Error(`M18_FINAL_SEND_TARGET_INVALID:${m18SendId || 'NONE'}`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'final_duel_log.json'));
  copyIfExists(
    INCREMENTAL_RESULT_PATH,
    path.join(attemptDir, 'final_hand_incremental.json')
  );

  return {
    m18Resolved: resolvedM18,
    e01Operation: e01Blocks[0],
    drawn,
    beforeCount,
    afterCount: after.handCount,
    finalHand: after.cards || []
  };
}

async function runFreshActivationStage() {
  const attemptDir = path.join(ROUTE_DIR, timestampId());
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;
  let activationOperation;

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

    const target = (baseline.cards || []).find(item => item && item.id === card.id);
    if (!target) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }
    const slot = Number(target.index) || baseline.cards.indexOf(target) + 1;

    console.log('\n============================================================');
    console.log('准备自动操作：愚蠢的重葬[M18]');
    console.log('普通发动复用已封板M09/M15/M10：observer基线 -> observer真实位置 -> 发动。');
    console.log('特殊路线沿用旧M18实战：额外第1张迦楼拉 -> 选择 -> 迦楼拉效果 -> 选择 -> 抽1。');
    console.log('所有“点卡 -> 选择/确认”之间统一多等600ms；动画阶段不发送鼠标/键盘/INFO/滚动。');
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
      `发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS @手牌${selected.slot}`
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
      '已点击“发动”：愚蠢的重葬[M18]；先纯等待并只读右栏确认发动，不读取INFO、不点击手牌。'
    );
    await sleep(card.settleAfterActivationMs);

    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      initialInfo: info,
      allowBacktrack: false,
      expectedAtomicActivationKey: 'M18',
      verbose: false
    });

    const log = readJson(LOG_RESULT_PATH);
    activationOperation = validateActivationOnlyStage(log);
    copyIfExists(
      LOG_RESULT_PATH,
      path.join(attemptDir, 'activation_only_duel_log.json')
    );

    const routeState = {
      version: 2,
      status: 'WAITING_FOR_E01_SELECTION',
      createdAt: new Date().toISOString(),
      attemptDir,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      selectedM18: selected,
      m18ActivationOperation: activationOperation,
      actionProof
    };
    writeJsonAtomic(ROUTE_STATE_PATH, routeState, { trailingNewline: true });
    writeJson(path.join(attemptDir, 'state.json'), routeState);

    console.log('M18阶段1 PASS: 右栏只确认了愚蠢的重葬发动；尚未提前提交M18离手。');
    return routeState;
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function continueE01SelectionAndEffect(routeState) {
  const bridge = new MdFastBridge();
  await bridge.start();

  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    if (routeState.status === 'WAITING_FOR_E01_SELECTION') {
      const sendSelectionProof = await prepareGaruraExtraDeckSelection({
        bridge,
        info,
        library,
        templates,
        debugDir: routeState.attemptDir
      });

      // Persist immediately after the candidate is physically selected and
      // identity-proven.  If submit fails, rerunning the command resumes at a
      // button-only stage and never toggles the candidate off.
      routeState = {
        ...routeState,
        status: 'WAITING_FOR_E01_SEND_CONFIRM',
        e01SendCandidateSelectedAt: new Date().toISOString(),
        e01SendSelectionProof: sendSelectionProof
      };
      writeJsonAtomic(ROUTE_STATE_PATH, routeState, { trailingNewline: true });
      writeJson(path.join(routeState.attemptDir, 'state.json'), routeState);
    }

    if (routeState.status === 'WAITING_FOR_E01_SEND_CONFIRM') {
      const sendConfirmProof = await confirmPreparedGaruraExtraDeckSelection({
        bridge,
        info,
        debugDir: routeState.attemptDir
      });

      routeState = {
        ...routeState,
        status: 'WAITING_FOR_E01_EFFECT',
        e01SendConfirmedAt: new Date().toISOString(),
        e01SendConfirmProof: sendConfirmProof
      };
      writeJsonAtomic(ROUTE_STATE_PATH, routeState, { trailingNewline: true });
      writeJson(path.join(routeState.attemptDir, 'state.json'), routeState);

      console.log('共命之翼 迦楼拉[E01]已提交送墓；现在纯等待自身效果窗口。');
    }

    if (routeState.status === 'WAITING_FOR_E01_EFFECT') {
      const effectSelectionProof = await prepareGaruraEffectSelection({
        bridge,
        info,
        library,
        templates,
        debugDir: routeState.attemptDir
      });

      routeState = {
        ...routeState,
        status: 'WAITING_FOR_E01_EFFECT_CONFIRM',
        e01EffectCandidateSelectedAt: new Date().toISOString(),
        e01EffectSelectionProof: effectSelectionProof
      };
      writeJsonAtomic(ROUTE_STATE_PATH, routeState, { trailingNewline: true });
      writeJson(path.join(routeState.attemptDir, 'state.json'), routeState);
    }

    if (routeState.status === 'WAITING_FOR_E01_EFFECT_CONFIRM') {
      const effectConfirmProof = await confirmPreparedGaruraEffectSelection({
        bridge,
        info,
        debugDir: routeState.attemptDir
      });
      const effectPriority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: 'AFTER_GARURA_EFFECT_ACTIVATION_RESPONSE_BOUNDARY',
        timeoutMs: 30000
      });

      routeState = {
        ...routeState,
        status: 'WAITING_FOR_FINAL_OBSERVER',
        e01EffectConfirmedAt: new Date().toISOString(),
        e01EffectConfirmProof: effectConfirmProof,
        e01EffectResponseBoundaryPriority: effectPriority
      };
      writeJsonAtomic(ROUTE_STATE_PATH, routeState, { trailingNewline: true });
      writeJson(path.join(routeState.attemptDir, 'state.json'), routeState);

      console.log(
        `迦楼拉效果已提交：纯等待${card.settleAfterGaruraEffectMs}ms让抽1动画完成。`
      );
      await sleep(card.settleAfterGaruraEffectMs);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  return routeState;
}

async function runFinalObserver(routeState) {
  if (!fs.existsSync(HAND_STATE_PATH)) {
    throw new Error('M18_FINAL_HAND_STATE_MISSING');
  }

  const originalHandBuffer = fs.readFileSync(HAND_STATE_PATH);
  const beforeState = JSON.parse(originalHandBuffer.toString('utf8'));

  if (beforeState.handCount !== routeState.baselineHandCount) {
    throw new Error(
      `M18_FINAL_BASELINE_HAND_MISMATCH:${beforeState.handCount}/${routeState.baselineHandCount}`
    );
  }

  const staged = commitKnownM18Consumption(
    beforeState,
    routeState.m18ActivationOperation
  );
  writeJsonAtomic(HAND_STATE_PATH, staged, { trailingNewline: true });

  let completion;
  try {
    completion = observeCompletion(() => runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']));
  } catch (error) {
    restoreBuffer(HAND_STATE_PATH, originalHandBuffer);
    const retry = {
      ...routeState,
      status: 'WAITING_FOR_FINAL_OBSERVER',
      lastFinalObserverFailureAt: new Date().toISOString(),
      lastFinalObserverError: error.message
    };
    writeJsonAtomic(ROUTE_STATE_PATH, retry, { trailingNewline: true });
    writeJson(path.join(routeState.attemptDir, 'state.json'), retry);
    throw error;
  }

  if (completion.kind === 'TERMINAL_VICTORY') {
    // Staging M18's consumption is not a committed hand transaction. On a
    // terminal screen we know the outcome, not the final ordinary hand ledger.
    restoreBuffer(HAND_STATE_PATH, originalHandBuffer);
    const complete = { ...routeState, status: 'COMPLETE_TERMINAL_VICTORY',
      completedAt: new Date().toISOString(), completion };
    writeJsonAtomic(ROUTE_STATE_PATH, complete, { trailingNewline: true });
    writeJson(path.join(routeState.attemptDir, 'result.json'), complete);
    console.log('M18执行终局 PASS：严格胜利结束路线，不要求终局已隐藏的送墓日志或旧手牌结果。');
    return;
  }

  const verified = validateFinalM18Resolution({
    routeState,
    attemptDir: routeState.attemptDir
  });

  const complete = {
    ...routeState,
    status: 'COMPLETE',
    completedAt: new Date().toISOString(),
    observerVerification: verified
  };
  writeJsonAtomic(ROUTE_STATE_PATH, complete, { trailingNewline: true });
  writeJson(path.join(routeState.attemptDir, 'result.json'), complete);

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m18-foolish-burial.cmd',
    evidenceDir: routeState.attemptDir,
    scope:
      '1~12手牌；普通发动复用封板手牌执行；旧M18实战固定额外第1张E01并精确认；' +
      '点卡后延迟600ms再选择；迦楼拉单效果窗口精确认；动画零输入；最终observer验证M18->E01送墓+E01抽1，手牌n->n-1->n'
  });

  console.log('\n============================================================');
  console.log('M18执行测试 PASS: 愚蠢的重葬');
  console.log(`送墓: ${GARURA_NAME}[${GARURA_ID}]`);
  console.log(`迦楼拉抽到: ${verified.drawn.name}[${verified.drawn.id}]`);
  console.log(
    `手牌数: ${routeState.baselineHandCount} -> ` +
    `${routeState.baselineHandCount - 1} -> ${verified.afterCount}`
  );
  console.log(`测试记录: ${routeState.attemptDir}`);
  console.log('============================================================');
}

async function main() {
  assertSupportedNode();
  ensureDir(ROUTE_DIR);

  if (process.argv.includes('--reset')) {
    fs.rmSync(ROUTE_STATE_PATH, { force: true });
    console.log('已清除 M18 执行路线状态。');
    return;
  }

  let state = fs.existsSync(ROUTE_STATE_PATH)
    ? readJson(ROUTE_STATE_PATH)
    : null;

  if (!state || ['COMPLETE', 'COMPLETE_TERMINAL_VICTORY'].includes(state.status)) {
    if (state && ['COMPLETE', 'COMPLETE_TERMINAL_VICTORY'].includes(state.status)) {
      fs.rmSync(ROUTE_STATE_PATH, { force: true });
    }
    state = await runFreshActivationStage();
  }

  if (state.status === 'WAITING_FOR_E01_SELECTION' ||
      state.status === 'WAITING_FOR_E01_SEND_CONFIRM' ||
      state.status === 'WAITING_FOR_E01_EFFECT' ||
      state.status === 'WAITING_FOR_E01_EFFECT_CONFIRM') {
    state = await continueE01SelectionAndEffect(state);
  }

  if (state.status === 'WAITING_FOR_FINAL_OBSERVER') {
    await runFinalObserver(state);
  }
}

main().catch(error => {
  console.error(`\nM18执行测试停止: ${error && error.stack ? error.stack : error}`);

  let saved = null;
  try {
    saved = fs.existsSync(ROUTE_STATE_PATH) ? readJson(ROUTE_STATE_PATH) : null;
  } catch (_) {
    saved = null;
  }

  const safeResumeStates = new Set([
    'WAITING_FOR_E01_SEND_CONFIRM',
    'WAITING_FOR_E01_EFFECT_CONFIRM',
    'WAITING_FOR_FINAL_OBSERVER'
  ]);

  if (saved && safeResumeStates.has(saved.status)) {
    console.error(
      `当前已保存安全恢复阶段=${saved.status}；候选牌已经精确认。` +
      '再次运行同一命令只会继续“选择/确认”或最终observer，不会重新点击候选牌。'
    );
  } else {
    console.error(
      '当前不是已证明的“只差确认按钮”恢复阶段。请保持当前画面并把日志发来，' +
      '不要为了续跑而重复点击候选牌。'
    );
  }

  process.exitCode = 1;
});
