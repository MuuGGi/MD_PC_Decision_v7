'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureDir,
  readJson,
  readJsonIfExists,
  writeJsonAtomic: writeJson,
  restoreBuffer,
  appendJsonLine
} = require('../../lib/runtime-files');
const {
  cleanCards,
  createInitialSession,
  buildObservationStep,
  applyObservationStep,
  flattenStageMetrics
} = require('../../lib/duel-observer-session');
const { buildHornetPreviousAdoption } = require('../../lib/observer-hornet-recovery');
const { validateMalletFullRescan } = require('../../lib/mallet-material-flow');
const { detectDeadlock } = require('../../lib/deadlock-detector');
const { normalizeExodiaComponentCard, isExodiaComponentId, sameRuntimeCardIdentity } = require('../../lib/exodia-policy');

const ROOT = path.resolve(__dirname, '..', '..');
const OBSERVER_DIR = path.join(ROOT, 'debug', 'duel-observer');
const SESSION_PATH = path.join(OBSERVER_DIR, 'session.json');
const LATEST_STEP_PATH = path.join(OBSERVER_DIR, 'latest_step.json');
const PERFORMANCE_JSONL = path.join(OBSERVER_DIR, 'performance.jsonl');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const LOG_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const OUTCOME_RESULT_PATH = path.join(ROOT, 'debug', 'duel-outcome-live', 'latest_result.json');
const PREPARED_SCAN_RESULT_PATH = path.join(ROOT, 'debug', 'scan-state-live', 'prepared', 'result.json');
const DENSE_SCAN_RESULT_PATH = path.join(ROOT, 'debug', 'hand-layout-live', 'dense_segment_latest.json');
const SCAN_RESULT_PATH = path.join(ROOT, 'debug', 'scan-state-live', 'hand_5', 'result.json');
const PERF_DIR = path.join(ROOT, 'debug', 'performance');
const PERF_LOG_PATH = path.join(PERF_DIR, 'latest-duel-log-live.json');
const PERF_HAND_PATH = path.join(PERF_DIR, 'latest-hand-change-incremental.json');
const PERF_OPENING_SHARED_PATH = path.join(PERF_DIR, 'latest-opening-shared.json');

const args = process.argv.slice(2);
const forceNew = args.includes('--new') || args.includes('--reset');
const repairCurrent = args.includes('--repair-current') || args.includes('--resync-current');
const preparedCurrent = args.includes('--prepared') || args.includes('--baseline-current');
const adoptHornetPrevious = args.includes('--adopt-hornet-previous') || args.includes('--resume-kagari-recovery');
const verbose = args.includes('--verbose');

function elapsedMs(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1e6;
}

function run(script, childArgs = []) {
  console.log(`\n===== ${script} =====`);
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...childArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  const ms = elapsedMs(started);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${script} 运行失败，exit=${result.status}`);
    error.exitCode = result.status || 1;
    error.script = script;
    error.elapsedMs = ms;
    throw error;
  }
  return ms;
}

function cleanObserverDirForNewDuel() {
  if (!fs.existsSync(OBSERVER_DIR)) return;
  for (const name of ['session.json', 'latest_step.json', 'performance.jsonl']) {
    const filePath = path.join(OBSERVER_DIR, name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function handText(cards) {
  return (cards || []).map(card => `${card.name}[${card.id}]`).join(' | ');
}

function denseResultToScan(dense) {
  const sweep = dense && Array.isArray(dense.sweeps) ? dense.sweeps[0] : null;
  const stitched = sweep && sweep.stitched;
  const handCount = Number(dense && dense.handCount);
  if (!Number.isInteger(handCount) || handCount < 8 || handCount > 12 ||
      !stitched || stitched.complete !== true || !Array.isArray(stitched.cards) ||
      stitched.cards.length !== handCount) {
    throw new Error(`DENSE_OBSERVER_SCAN_NOT_PASS:${handCount}/${stitched && stitched.complete}`);
  }
  const cards = stitched.cards.map((card, index) => normalizeExodiaComponentCard({
    index: index + 1,
    id: card.id,
    name: card.name,
    accepted: card.accepted !== false,
    denseRecognition: {
      mad: card.mad == null ? null : card.mad,
      rmse: card.rmse == null ? null : card.rmse,
      margin: card.margin == null ? null : card.margin
    }
  }));
  if (cards.some(card => !card.id || card.id === 'UNKNOWN' || card.accepted === false)) {
    throw new Error('DENSE_OBSERVER_SCAN_CONTAINS_UNKNOWN_CARD');
  }
  const relativeHand = dense && dense.baselineHandImagePath
    ? dense.baselineHandImagePath
    : sweep.windows && sweep.windows[0] && sweep.windows[0].geometry &&
      sweep.windows[0].geometry.files && sweep.windows[0].geometry.files.hand;
  return {
    status: 'PASS',
    handCount,
    cards,
    layoutMode: 'DENSE_HAND_SEGMENTED_SCROLL',
    confidence: stitched.confidence,
    source: DENSE_SCAN_RESULT_PATH,
    handImagePath: relativeHand ? path.join(ROOT, relativeHand) : null
  };
}

function writeDenseHandBaseline(scan, reason) {
  writeJson(HAND_STATE_PATH, {
    version: 2,
    capturedAt: new Date().toISOString(),
    revision: 0,
    handCount: scan.handCount,
    cards: scan.cards,
    handImagePath: scan.handImagePath || null,
    source: scan.source || DENSE_SCAN_RESULT_PATH,
    denseHandBaseline: true,
    reason
  });
}

function printRecognitionTimings(rows, prefix = '识别') {
  if (!rows || !rows.length) {
    console.log(`${prefix}耗时: 本轮无新增手牌点击识别`);
    return;
  }
  console.log(`${prefix}耗时:`);
  for (const row of rows) {
    const total = Number(row.totalMs || 0);
    const recognize = Number(row.recognizeMs || 0);
    const locate = Number(row.locateMs || 0);
    const click = Number(row.clickAndSettleMs || 0);
    console.log(
      `  手牌${row.slot} ${row.name}[${row.id}] total=${total.toFixed(1)}ms` +
      `；定位=${locate.toFixed(1)}ms；点击等待=${click.toFixed(1)}ms；模板识别=${recognize.toFixed(1)}ms`
    );
  }
}

function printSlowStages(metrics, limit = 5) {
  const rows = flattenStageMetrics(metrics)
    .filter(row => row.name !== 'TOTAL')
    .slice(0, limit);
  if (!rows.length) return;
  console.log('本轮最慢阶段:');
  for (const row of rows) {
    console.log(`  ${row.group}.${row.name} = ${row.ms.toFixed(1)}ms`);
  }
}

function initDuel() {
  cleanObserverDirForNewDuel();
  ensureDir(OBSERVER_DIR);
  console.log('============================================================');
  console.log('完整牌局观察器：建立开局 5 手牌基线');
  console.log('只在开局完整点击识别 5 张；后续每轮只处理上一步之后的增量变化。');
  console.log('程序不执行出牌、选对象、装备对象、Link 素材等游戏操作。');
  console.log('============================================================');

  const wholeStarted = process.hrtime.bigint();
  const resetMs = run('tools/reset-duel-state.js');
  const openingSharedMs = run('runtime/observer/run-opening-observer-fast.js', verbose ? ['--verbose'] : []);
  const totalMs = elapsedMs(wholeStarted);
  const openingSharedPerf = readJsonIfExists(PERF_OPENING_SHARED_PATH);
  const scanMs = openingSharedPerf ? Number(openingSharedPerf.scanMs || 0) : openingSharedMs;
  const logMs = openingSharedPerf ? Number(openingSharedPerf.logMs || 0) : 0;
  const openingSharedOverheadMs = openingSharedPerf
    ? Math.max(0, openingSharedMs - scanMs - logMs)
    : 0;

  const scan = readJson(SCAN_RESULT_PATH);
  if (scan.status !== 'PASS' || scan.handCount !== 5) {
    throw new Error(`OPENING_FIVE_SCAN_NOT_PASS:${scan.status}/${scan.handCount}`);
  }
  const logPerf = readJsonIfExists(PERF_LOG_PATH);
  const metrics = {
    observer: {
      totalMs,
      stages: [
        { name: 'reset_duel_state', ms: resetMs },
        { name: 'opening_shared_bridge_overhead', ms: openingSharedOverheadMs },
        { name: 'opening_full_scan', ms: scanMs },
        { name: 'opening_log_checkpoint', ms: logMs }
      ]
    },
    duelLog: logPerf
  };
  const session = createInitialSession(scan, metrics);
  writeJson(SESSION_PATH, session);
  const initialPerf = {
    type: 'OPENING_FULL_SCAN',
    step: 0,
    capturedAt: new Date().toISOString(),
    totalMs,
    handCount: 5,
    recognitionTimings: session.initialRecognitionTimings,
    metrics
  };
  appendJsonLine(PERFORMANCE_JSONL, initialPerf);

  console.log('\n============================================================');
  console.log('开局基线建立完成。');
  console.log(`当前手牌: ${handText(session.cards)}`);
  console.log(`开局总耗时: ${totalMs.toFixed(1)}ms`);
  printRecognitionTimings(session.initialRecognitionTimings, '开局逐牌');
  printSlowStages(metrics);
  const openingDeadlock = detectDeadlock(session);
  if (openingDeadlock.terminal === true && openingDeadlock.type === 'DEADLOCK') {
    return commitTerminalDeadlock(session, openingDeadlock, totalMs);
  }
  console.log('现在由你手动完成一个游戏动作；稳定后再次运行完全相同的命令。');
  console.log(`观察器状态: ${SESSION_PATH}`);
  console.log(`逐轮性能记录: ${PERFORMANCE_JSONL}`);
  console.log('============================================================');
}

function initPreparedCurrentBaseline() {
  cleanObserverDirForNewDuel();
  ensureDir(OBSERVER_DIR);
  console.log('============================================================');
  console.log('完整牌局观察器：从当前局面建立调配基线');
  console.log('不要求新开局，也不要求5张手牌；自动识别当前实际手牌 1~12 张。');
  console.log('右侧信息栏此刻已经发生的操作全部视为既有历史；下一轮只处理此后新增操作。');
  console.log('============================================================');

  const wholeStarted = process.hrtime.bigint();
  const preparedMs = run('runtime/observer/run-prepared-baseline-flex.js', verbose ? ['--verbose'] : []);
  const totalMs = elapsedMs(wholeStarted);
  const scan = readJson(PREPARED_SCAN_RESULT_PATH);
  const log = readJson(LOG_RESULT_PATH);
  if (scan.status !== 'PASS' || !Number.isInteger(scan.handCount) ||
      !Array.isArray(scan.cards) || scan.cards.length !== scan.handCount) {
    throw new Error(`PREPARED_CURRENT_SCAN_NOT_PASS:${scan.status}/${scan.handCount}/${scan.cards && scan.cards.length}`);
  }

  const preexistingBlocks = (log.newOperationBlocks || log.newActivationBlocks || []);
  const metrics = {
    observer: {
      totalMs,
      stages: [{ name: 'prepared_current_baseline', ms: preparedMs }]
    },
    duelLog: readJsonIfExists(PERF_LOG_PATH)
  };
  const session = createInitialSession(scan, metrics);
  session.baselineMode = 'PREPARED_CURRENT_STATE';
  session.preexistingOperationCount = preexistingBlocks.length;
  session.preexistingOperations = preexistingBlocks.map(block => block.activationKey || null).filter(Boolean);
  writeJson(SESSION_PATH, session);
  appendJsonLine(PERFORMANCE_JSONL, {
    type: 'PREPARED_CURRENT_BASELINE',
    step: 0,
    capturedAt: new Date().toISOString(),
    totalMs,
    handCount: scan.handCount,
    preexistingOperationCount: preexistingBlocks.length,
    recognitionTimings: session.initialRecognitionTimings,
    metrics
  });

  console.log('\n============================================================');
  console.log('当前局面基线建立完成。');
  console.log(`当前手牌数: ${scan.handCount}`);
  console.log(`当前手牌: ${handText(session.cards)}`);
  console.log(`右栏既有历史操作: ${preexistingBlocks.length}` +
    (preexistingBlocks.length ? `（${preexistingBlocks.map(block => block.activationKey).join('>')}）` : ''));
  console.log('这些右栏操作已经封存为历史；下一次 observer 只识别从现在开始的新动作。');
  console.log('现在可以测试：通常召唤零衣 -> observer -> 装备妖刀 -> observer。');
  console.log('============================================================');
}

function repairCurrentHand() {
  const session = readJsonIfExists(SESSION_PATH);
  if (!session || session.status !== 'ACTIVE') {
    throw new Error('DUEL_OBSERVER_ACTIVE_SESSION_REQUIRED_FOR_REPAIR');
  }
  const observerStateBefore = fs.existsSync(LOG_STATE_PATH)
    ? fs.readFileSync(LOG_STATE_PATH)
    : null;
  const wholeStarted = process.hrtime.bigint();
  console.log('============================================================');
  console.log('牌局观察器：一次性修复当前手牌基线');
  console.log('只重新扫描当前手牌；保留已经建立的右侧日志检查点和牌局步数。');
  console.log('============================================================');
  try {
    const scanMs = run('runtime/observer/test-scan-state-live.js', ['--prepared-baseline', ...(verbose ? ['--verbose'] : [])]);
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);
    if (scan.status !== 'PASS' || !Number.isInteger(scan.handCount)) {
      throw new Error(`CURRENT_HAND_REPAIR_SCAN_NOT_PASS:${scan.status}/${scan.handCount}`);
    }
    const next = {
      ...session,
      handCount: scan.handCount,
      cards: scan.cards,
      updatedAt: new Date().toISOString(),
      repairs: [
        ...(session.repairs || []),
        {
          repairedAt: new Date().toISOString(),
          reason: 'MANUAL_CURRENT_HAND_RESYNC',
          previousHandCount: session.handCount,
          handCount: scan.handCount
        }
      ]
    };
    writeJson(SESSION_PATH, next);
    const totalMs = elapsedMs(wholeStarted);
    appendJsonLine(PERFORMANCE_JSONL, {
      type: 'CURRENT_HAND_REPAIR',
      step: session.step || 0,
      capturedAt: new Date().toISOString(),
      totalMs,
      scanMs,
      previousHandCount: session.handCount,
      handCount: scan.handCount
    });
    console.log('\n============================================================');
    console.log('当前手牌基线已修复。');
    console.log(`修复前记录手牌数: ${session.handCount}`);
    console.log(`当前实际手牌数: ${scan.handCount}`);
    console.log(`当前手牌: ${handText(scan.cards)}`);
    console.log('右侧日志检查点已恢复，不会把历史操作重新当作新操作。');
    console.log('下一步请先手动执行一个新的游戏动作，再运行 .\\tools\\launchers\\run-duel-observer.cmd。');
    console.log('============================================================');
  } catch (error) {
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);
    throw error;
  }
}


function adoptAlreadyCompletedHornetPreviousStep() {
  const session = readJsonIfExists(SESSION_PATH);
  const handState = readJsonIfExists(HAND_STATE_PATH);
  const log = readJsonIfExists(LOG_RESULT_PATH);
  const observerState = readJsonIfExists(LOG_STATE_PATH);
  if (!log) {
    throw new Error('HORNET_ADOPT_LATEST_DUEL_LOG_REQUIRED:先保留刚才失败时已经识别出的 M22/E02 日志');
  }

  const adopted = buildHornetPreviousAdoption({
    session,
    handState,
    log,
    observerState,
    capturedAt: new Date().toISOString()
  });
  writeJson(SESSION_PATH, adopted.nextSession);
  writeJson(HAND_STATE_PATH, adopted.nextHandState);
  writeJson(LOG_STATE_PATH, adopted.nextObserverState);
  writeJson(LATEST_STEP_PATH, adopted.syntheticStep);
  appendJsonLine(PERFORMANCE_JSONL, {
    type: 'RECOVER_PREVIOUS_HORNET_NODE',
    step: adopted.syntheticStep.step,
    capturedAt: adopted.syntheticStep.observedAt,
    totalMs: 0,
    handCount: adopted.nextHandState.handCount,
    checkpoint: adopted.checkpoint
  });

  console.log('\n============================================================');
  console.log('已补记“当前状态的上一步”：大黄蜂发动 → 特殊召唤衍生物。');
  console.log('这不是重新识别当前一步，也不会点击手牌。');
  console.log(`补记后手牌数: ${adopted.nextHandState.handCount}`);
  console.log(`补记后手牌: ${handText(adopted.nextHandState.cards)}`);
  console.log('右侧日志 checkpoint 已改为 M22 → 衍生物。');
  console.log('现在立即继续检查当前这一步：衍生物 Link 火刀 + 火刀回收。');
  console.log('============================================================');
}

function continuePendingMalletFullResync(session) {
  const pending = session && session.pendingMallet;
  if (!pending || pending.status !== 'WAITING_FOR_FULL_RESYNC') {
    throw new Error('MALLET_PENDING_STATE_INVALID');
  }

  const observerStateBefore = fs.existsSync(LOG_STATE_PATH)
    ? fs.readFileSync(LOG_STATE_PATH)
    : null;
  const handStateBefore = fs.existsSync(HAND_STATE_PATH)
    ? fs.readFileSync(HAND_STATE_PATH)
    : null;
  const wholeStarted = process.hrtime.bigint();

  console.log('============================================================');
  console.log('万宝槌待结算：执行 FULL RESYNC');
  console.log('本轮不解析槽位增量；像开局一样重新逐张识别当前全部手牌。');
  console.log('只有最终手牌数 = 万宝槌发动前手牌数 - 1 时才提交。');
  console.log('============================================================');

  try {
    const expectedFinalCount = Number(pending.beforeCount) - 1;
    let scanMs;
    let scan;
    if (expectedFinalCount >= 8 && expectedFinalCount <= 12) {
      console.log(`万宝槌结算后预计手牌=${expectedFinalCount}：启用已验证的 8~12 张横向拖拽分段 FULL RESYNC。`);
      scanMs = run('runtime/observer/capture-hand-scroll-segments-live.js', [
        '--count', String(expectedFinalCount),
        ...(verbose ? ['--verbose'] : [])
      ]);
      scan = denseResultToScan(readJson(DENSE_SCAN_RESULT_PATH));
      writeDenseHandBaseline(scan, 'M11_DENSE_FULL_RESYNC');
    } else {
      scanMs = run('runtime/observer/test-scan-state-live.js', [
        '--expected', 'auto',
        '--prepared-baseline',
        '--observer-fast',
        ...(verbose ? ['--verbose'] : [])
      ]);
      scan = readJson(PREPARED_SCAN_RESULT_PATH);
    }

    // The fixed full scanner intentionally rebuilds the hand baseline and also
    // resets duel-log observer_state.json to EMPTY_MAIN1. M11 activation has
    // already been checkpointed, so restore that right-log checkpoint.
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);

    const verified = validateMalletFullRescan(Number(pending.beforeCount), scan);

    // M11 resolution can add a very long right-log processing chain. Once the
    // full hand rescan has authoritatively succeeded, the pre-M11 log tail is
    // no longer useful for hand-state continuity. Rebuild the log baseline at
    // the CURRENT absolute bottom so the next observer run never has to scroll
    // upward through the entire Magical Mallet history.
    const logRebaselineMs = run('runtime/observer/test-duel-log-live.js', [
      '--observer-fast',
      '--rebaseline-current-bottom',
      ...(verbose ? ['--verbose'] : [])
    ]);

    const totalMs = elapsedMs(wholeStarted);
    const recognitionTimings = (scan.cards || []).map((card, index) => ({
      slot: index + 1,
      id: card.id,
      name: card.name,
      ...(card.timingMs || {})
    }));
    const nextStepNumber = Number(session.step || 0) + 1;
    const observedAt = new Date().toISOString();
    const step = {
      step: nextStepNumber,
      observedAt,
      mode: 'MALLET_FULL_RESYNC',
      reason: 'M11_RESOLUTION_FULL_HAND_RESYNC',
      operations: [],
      logicalNodes: [{
        type: 'MALLET_FULL_RESYNC',
        activationKey: 'M11',
        name: '万宝槌完整结算重同步',
        handDelta: verified.delta,
        from: 'HAND_BEFORE_M11',
        to: 'HAND_AFTER_M11',
        gainedCard: null,
        evidence: ['M11_ACTIVATION_CHECKPOINT', 'FULL_HAND_RESCAN', 'FINAL_COUNT_MINUS_ONE']
      }],
      handBefore: {
        handCount: Number(pending.beforeCount),
        cards: cleanCards(session.cards)
      },
      handAfter: {
        handCount: scan.handCount,
        cards: cleanCards(scan.cards)
      },
      removedCards: [{ id: 'M11', name: '万宝槌' }],
      insertedCards: [],
      recognitionTimings,
      metrics: {
        observer: {
          totalMs,
          stages: [
          { name: 'mallet_full_resync_scan', ms: scanMs },
          { name: 'mallet_post_resync_log_rebaseline', ms: logRebaselineMs }
        ]
        }
      }
    };
    const next = {
      ...session,
      updatedAt: observedAt,
      step: nextStepNumber,
      handCount: scan.handCount,
      cards: cleanCards(scan.cards),
      malletPostResyncLogBaseline: {
        fullResyncStep: nextStepNumber,
        capturedAt: observedAt,
        reason: 'M11_POST_FULL_RESYNC_CURRENT_BOTTOM'
      },
      history: [...(session.history || []), step]
    };
    delete next.pendingMallet;

    writeJson(SESSION_PATH, next);
    writeJson(LATEST_STEP_PATH, step);
    appendJsonLine(PERFORMANCE_JSONL, {
      type: 'MALLET_FULL_RESYNC',
      step: step.step,
      capturedAt: observedAt,
      totalMs,
      scanMs,
      logRebaselineMs,
      beforeCount: pending.beforeCount,
      handCount: scan.handCount,
      recognitionTimings
    });

    console.log('\n============================================================');
    console.log(`牌局观察第 ${step.step} 步完成：万宝槌 FULL RESYNC`);
    console.log(`手牌数: ${pending.beforeCount} -> ${scan.handCount}`);
    console.log(`当前手牌: ${handText(next.cards)}`);
    printRecognitionTimings(recognitionTimings, '万宝槌结算后完整重扫');
    console.log(`本轮总耗时: ${totalMs.toFixed(1)}ms`);
    console.log('万宝槌旧槽位身份已废弃；后续增量识别从这份新完整手牌基线继续。');
    console.log('右栏也已在万宝槌结算后的当前底部重建 baseline；下一轮不会再追万宝槌之前的旧末尾。');
    console.log(`M11 后右栏重基线耗时: ${logRebaselineMs.toFixed(1)}ms`);
    console.log('你可以继续手动完成下一步；稳定后再次运行同一命令。');
    console.log(`本步详情: ${LATEST_STEP_PATH}`);
    console.log('============================================================');
    return;
  } catch (error) {
    // A premature run while the M11 selection UI is still open must not destroy
    // either the old hand baseline or the already committed M11 log checkpoint.
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);
    restoreBuffer(HAND_STATE_PATH, handStateBefore);
    throw error;
  }
}

function continuePendingNadirFullResolution(session) {
  const pending = session && session.pendingNadir;
  if (!pending || pending.status !== 'WAITING_FOR_FULL_RESOLUTION') {
    throw new Error('NADIR_PENDING_STATE_INVALID');
  }

  const observerStateBefore = fs.existsSync(LOG_STATE_PATH)
    ? fs.readFileSync(LOG_STATE_PATH)
    : null;
  const handStateBeforeBuffer = fs.existsSync(HAND_STATE_PATH)
    ? fs.readFileSync(HAND_STATE_PATH)
    : null;
  const wholeStarted = process.hrtime.bigint();

  console.log('============================================================');
  console.log('愚蠢的重葬待完整结算：进入 M18 -> 迦楼拉 -> 抽1 收尾。');
  console.log('这一轮只允许在迦楼拉询问与抽卡动画全部结束、正常手牌扇形恢复后运行。');
  console.log('先在内部暂记 M18 离手 -1，再用真实 INFO + 新增手牌识别确认迦楼拉抽1 +1。');
  console.log('============================================================');

  try {
    const baselineState = readJson(HAND_STATE_PATH);
    const baselineCount = Number(pending.beforeCount);
    if (!Number.isInteger(baselineCount) || baselineCount < 1 ||
        Number(baselineState.handCount) !== baselineCount ||
        !Array.isArray(baselineState.cards) || baselineState.cards.length !== baselineCount) {
      throw new Error(`NADIR_PENDING_BASELINE_INVALID:${baselineState.handCount}/${baselineCount}`);
    }

    const consumedIndex = baselineState.cards.findIndex(card => card && card.id === 'M18');
    if (consumedIndex < 0) throw new Error('NADIR_PENDING_M18_NOT_IN_BASELINE_HAND');
    const consumed = baselineState.cards[consumedIndex];
    const stagedCards = baselineState.cards
      .filter((card, index) => index !== consumedIndex)
      .map((card, index) => ({ ...card, index: index + 1 }));
    const stagedState = {
      ...baselineState,
      capturedAt: new Date().toISOString(),
      revision: Number(baselineState.revision || 0) + 1,
      handCount: stagedCards.length,
      cards: stagedCards,
      lastOperation: {
        activationKey: 'M18',
        signature: pending.activationSignature || 'M18|DEFERRED_CONSUMPTION',
        activationOccurrence: null
      },
      lastIncremental: {
        mode: 'M18_DEFERRED_CONSUMPTION_BEFORE_FULL_RESOLUTION',
        consumed,
        costConsumed: [],
        predictedSlots: [],
        recognized: [],
        finalClicks: []
      }
    };
    writeJson(HAND_STATE_PATH, stagedState);

    // ISSUE-076 audit exception: the continuous duel observer spans arbitrary
    // user/game operations, so it may reconstruct historical continuity.
    const incrementalMs = run('runtime/observer/run-live-incremental.js', ['--observer-fast', '--nadir-full-resolution', ...(verbose ? ['--verbose'] : [])]);
    const totalMs = elapsedMs(wholeStarted);
    const outcome = readJsonIfExists(OUTCOME_RESULT_PATH);
    if (outcome && outcome.terminal === true && outcome.type === 'VICTORY') {
      // Restore the baseline hand snapshot before handing terminal processing
      // back to the normal victory path; the duel is over so no M18 commit is needed.
      restoreBuffer(HAND_STATE_PATH, handStateBeforeBuffer);
      delete session.pendingNadir;
      writeJson(SESSION_PATH, session);
      return commitTerminalVictory(session, outcome, totalMs, incrementalMs);
    }

    const log = readJson(LOG_RESULT_PATH);
    const incremental = readJson(INCREMENTAL_RESULT_PATH);
    const newBlocks = log.newOperationBlocks || [];
    const garuraBlocks = newBlocks.filter(block => block && block.activationKey === 'E01');
    if (garuraBlocks.length !== 1) {
      throw new Error(`NADIR_FULL_RESOLUTION_GARURA_OPERATION_INVALID:${garuraBlocks.length}/1`);
    }
    const gains = (garuraBlocks[0].details || []).filter(detail =>
      detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
    );
    const drawn = normalizeExodiaComponentCard(gains[0] && gains[0].card);
    if (gains.length !== 1 || !drawn || (!/^M\d+$/.test(String(drawn.id || '')) && !isExodiaComponentId(drawn.id))) {
      throw new Error(`NADIR_FULL_RESOLUTION_DRAW_INVALID:${gains.length}:${drawn && drawn.id || 'UNKNOWN'}`);
    }
    if (!incremental || incremental.status !== 'PASS') {
      throw new Error(`NADIR_FULL_RESOLUTION_INCREMENTAL_NOT_PASS:${incremental && incremental.status || 'NONE'}`);
    }

    const afterState = incremental.after || readJson(HAND_STATE_PATH);
    const incrementalBeforeCount = incremental.before && incremental.before.handCount;
    const inserted = incremental.insertedCards || [];
    if (Number(incrementalBeforeCount) !== baselineCount - 1) {
      throw new Error(`NADIR_FULL_RESOLUTION_INTERMEDIATE_COUNT_INVALID:${incrementalBeforeCount}/${baselineCount - 1}`);
    }
    if (Number(afterState.handCount) !== baselineCount) {
      throw new Error(`NADIR_FULL_RESOLUTION_FINAL_COUNT_INVALID:${afterState.handCount}/${baselineCount}`);
    }
    if (inserted.length !== 1 || !inserted.some(item =>
      item && item.card && sameRuntimeCardIdentity(item.card, drawn)
    )) {
      throw new Error(`NADIR_FULL_RESOLUTION_INSERTED_INVALID:${inserted.length}/${drawn.id}`);
    }

    const visibleBlocks = log.operationBlocks || log.activationBlocks || [];
    const sendEvidence = visibleBlocks.some(block =>
      block && block.activationKey === 'M18' && (block.details || []).some(detail =>
        detail && detail.card && detail.card.id === 'E01' &&
        detail.rawType === 'SEND_EXTRA_DECK_TO_GRAVEYARD'
      )
    );

    const logPerf = readJsonIfExists(PERF_LOG_PATH);
    const handPerf = readJsonIfExists(PERF_HAND_PATH);
    const metrics = {
      observer: {
        totalMs,
        stages: [{ name: 'nadir_full_resolution_incremental', ms: incrementalMs }]
      },
      duelLog: logPerf,
      handIncremental: handPerf
    };
    const syntheticIncremental = {
      ...incremental,
      status: 'PASS',
      mode: 'NADIR_FULL_RESOLUTION',
      reason: 'M18_LOG_ONLY_PENDING_THEN_GARURA_DRAW',
      before: baselineState,
      after: afterState,
      inference: {
        activationKey: 'E01',
        consumed,
        costConsumed: [],
        addedCount: 1,
        predictedSlots: incremental.inference && incremental.inference.predictedSlots || []
      },
      logicalNodes: [
        {
          type: 'M18_DEFERRED_HAND_CONSUMPTION',
          activationKey: 'M18',
          name: '愚蠢的重葬离手',
          handDelta: -1,
          from: `HAND_${baselineCount}`,
          to: `HAND_${baselineCount - 1}`,
          gainedCard: null,
          evidence: ['M18_ACTIVATION_PREVIOUSLY_CONFIRMED', 'DEFERRED_DURING_UNSAFE_UI']
        },
        {
          type: 'GARURA_DRAW',
          activationKey: 'E01',
          name: '共命之翼 迦楼拉抽1',
          handDelta: 1,
          from: `HAND_${baselineCount - 1}`,
          to: `HAND_${baselineCount}`,
          gainedCard: drawn,
          evidence: [
            'E01_NEW_OPERATION',
            'HAND_GAIN_CANDIDATE_X1',
            'INFO_FINAL_COUNT_MATCH',
            'INSERTED_CARD_MATCH',
            sendEvidence ? 'M18_TO_E01_SEND_VISIBLE' : 'M18_TO_E01_SEND_NOT_REQUIRED_CURRENT_VIEW'
          ]
        }
      ]
    };

    const step = buildObservationStep(session, log, syntheticIncremental, metrics);
    const next = applyObservationStep(session, step);
    delete next.pendingNadir;
    writeJson(SESSION_PATH, next);
    writeJson(LATEST_STEP_PATH, step);
    appendJsonLine(PERFORMANCE_JSONL, {
      type: 'NADIR_FULL_RESOLUTION',
      step: step.step,
      capturedAt: step.observedAt,
      totalMs,
      recognitionTimings: step.recognitionTimings,
      metrics
    });

    console.log('\n============================================================');
    console.log(`牌局观察第 ${step.step} 步完成：愚蠢的重葬完整结算`);
    console.log(`M18离手并由迦楼拉抽1: ${baselineCount} -> ${baselineCount - 1} -> ${afterState.handCount}`);
    console.log(`抽到: ${drawn.name}[${drawn.id}]`);
    console.log(`当前手牌: ${handText(next.cards)}`);
    console.log(`M18送E01右栏细节: ${sendEvidence ? '当前仍可见' : '当前未完整可见；由已确认M18 + E01独立发动闭环'}`);
    console.log('M18待结算标记已清除；下一轮恢复普通增量观察。');
    console.log(`本步详情: ${LATEST_STEP_PATH}`);
    console.log('============================================================');

    const deadlock = detectDeadlock(next);
    if (deadlock.terminal === true && deadlock.type === 'DEADLOCK') {
      return commitTerminalDeadlock(next, deadlock, totalMs);
    }
    return next;
  } catch (error) {
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);
    restoreBuffer(HAND_STATE_PATH, handStateBeforeBuffer);
    throw error;
  }
}

function isStaleMalletPendingContamination(session) {
  if (!session || !session.pendingMallet || session.pendingMallet.status !== 'WAITING_FOR_FULL_RESYNC') {
    return false;
  }
  const history = Array.isArray(session.history) ? session.history : [];
  if (history.length < 2) return false;
  const last = history[history.length - 1];
  const previous = history[history.length - 2];
  return Boolean(
    last && last.mode === 'MALLET_ACTIVATION_PENDING_FULL_RESYNC' &&
    (!Array.isArray(last.operations) || last.operations.length === 0) &&
    previous && previous.mode === 'MALLET_FULL_RESYNC'
  );
}

function recoverStaleMalletPendingContamination(session) {
  const observerStateBefore = fs.existsSync(LOG_STATE_PATH)
    ? fs.readFileSync(LOG_STATE_PATH)
    : null;
  const history = Array.isArray(session.history) ? session.history : [];
  const bogusStep = history[history.length - 1];
  const previousRealStep = history[history.length - 2];
  const wholeStarted = process.hrtime.bigint();

  console.log('============================================================');
  console.log('检测到 M11 后空操作轮误复用了上一轮 incremental 结果。');
  console.log('这会错误重新进入“万宝槌待 FULL RESYNC”并回退旧手牌状态；现在自动修复当前局。');
  console.log('修复方式：完整重扫当前手牌，并保留当前右栏 baseline；不会重新发动任何卡。');
  console.log('============================================================');

  try {
    const expectedRecoveryCount = Number(previousRealStep && previousRealStep.handAfter && previousRealStep.handAfter.handCount);
    let scanMs;
    let scan;
    if (Number.isInteger(expectedRecoveryCount) && expectedRecoveryCount >= 8 && expectedRecoveryCount <= 12) {
      console.log(`M11 污染恢复基线=${expectedRecoveryCount}张：使用横向拖拽分段完整重扫。`);
      scanMs = run('runtime/observer/capture-hand-scroll-segments-live.js', [
        '--count', String(expectedRecoveryCount),
        ...(verbose ? ['--verbose'] : [])
      ]);
      scan = denseResultToScan(readJson(DENSE_SCAN_RESULT_PATH));
      writeDenseHandBaseline(scan, 'STALE_M11_DENSE_RECOVERY');
    } else {
      scanMs = run('runtime/observer/test-scan-state-live.js', [
        '--expected', 'auto',
        '--prepared-baseline',
        '--observer-fast',
        ...(verbose ? ['--verbose'] : [])
      ]);
      scan = readJson(PREPARED_SCAN_RESULT_PATH);
    }

    // Full hand scan rebuilds hand state and may reset duel-log state. The
    // current log baseline is already the post-M11/current-bottom baseline, so
    // restore it exactly; otherwise a swallowed post-M11 action could be seen
    // again on the following round.
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);

    if (scan.status !== 'PASS' || !Number.isInteger(scan.handCount)) {
      throw new Error(`STALE_M11_RECOVERY_SCAN_NOT_PASS:${scan.status}/${scan.handCount}`);
    }

    const observedAt = new Date().toISOString();
    const recognitionTimings = (scan.cards || []).map((card, index) => ({
      slot: index + 1,
      id: card.id,
      name: card.name,
      ...(card.timingMs || {})
    }));
    const replacementStep = {
      step: Number(bogusStep && bogusStep.step || session.step || 0),
      observedAt,
      mode: 'STALE_M11_RESULT_RECOVERY_FULL_RESYNC',
      reason: 'NO_NEW_OPERATION_REUSED_STALE_M11_INCREMENTAL_RESULT',
      operations: [],
      logicalNodes: [{
        type: 'CURRENT_HAND_FULL_RESYNC',
        activationKey: null,
        name: 'M11后状态污染恢复',
        handDelta: Number(scan.handCount) - Number(previousRealStep && previousRealStep.handAfter && previousRealStep.handAfter.handCount || scan.handCount),
        from: 'LAST_VALID_M11_FULL_RESYNC',
        to: 'CURRENT_VISIBLE_HAND',
        gainedCard: null,
        evidence: ['STALE_INCREMENTAL_RESULT_DETECTED', 'FULL_HAND_RESCAN', 'CURRENT_LOG_BASELINE_PRESERVED']
      }],
      handBefore: previousRealStep && previousRealStep.handAfter ? previousRealStep.handAfter : null,
      handAfter: {
        handCount: scan.handCount,
        cards: cleanCards(scan.cards)
      },
      removedCards: [],
      insertedCards: [],
      recognitionTimings,
      metrics: {
        observer: {
          totalMs: elapsedMs(wholeStarted),
          stages: [{ name: 'stale_m11_current_hand_rescan', ms: scanMs }]
        }
      }
    };

    const next = {
      ...session,
      updatedAt: observedAt,
      step: replacementStep.step,
      handCount: scan.handCount,
      cards: cleanCards(scan.cards),
      history: [...history.slice(0, -1), replacementStep],
      repairs: [
        ...(session.repairs || []),
        {
          repairedAt: observedAt,
          reason: 'STALE_M11_INCREMENTAL_RESULT_CONTAMINATION',
          replacedStep: replacementStep.step,
          previousRecordedHandCount: session.handCount,
          handCount: scan.handCount
        }
      ]
    };
    delete next.pendingMallet;

    writeJson(SESSION_PATH, next);
    writeJson(LATEST_STEP_PATH, replacementStep);
    appendJsonLine(PERFORMANCE_JSONL, {
      type: 'STALE_M11_RESULT_RECOVERY_FULL_RESYNC',
      step: replacementStep.step,
      capturedAt: observedAt,
      totalMs: elapsedMs(wholeStarted),
      scanMs,
      handCount: scan.handCount,
      recognitionTimings
    });

    console.log('\n============================================================');
    console.log(`M11 后状态污染已自动修复；当前实际手牌数=${scan.handCount}`);
    console.log(`当前手牌: ${handText(next.cards)}`);
    printRecognitionTimings(recognitionTimings, '恢复重扫');
    console.log('错误的“万宝槌待 FULL RESYNC”标记已清除。');
    console.log('当前右栏 baseline 保留；下一步可以继续正常增量观察。');
    console.log('注意：已经被旧兼容重基线吸收的那一个操作不再伪造历史归因，但当前手牌状态已恢复为真实状态。');
    console.log('============================================================');
    return;
  } catch (error) {
    restoreBuffer(LOG_STATE_PATH, observerStateBefore);
    throw error;
  }
}


function commitTerminalDeadlock(session, deadlock, totalMs = 0) {
  const observedAt = new Date().toISOString();
  const stepNumber = Number(session.step || 0) + 1;
  const step = {
    step: stepNumber,
    observedAt,
    mode: 'DUEL_TERMINAL_DEADLOCK',
    reason: deadlock.reason || 'DEADLOCK',
    operations: [],
    logicalNodes: [{
      type: 'DUEL_OUTCOME',
      activationKey: null,
      name: '死局',
      handDelta: 0,
      from: 'ACTIVE_DUEL',
      to: 'DEADLOCK',
      gainedCard: null,
      evidence: [
        'NO_SAFE_HAND_ACTION',
        'NO_RAYE',
        'NO_KNOWN_FIELD_CONTINUATION',
        `CONFIDENCE:${deadlock.confidence || 'UNKNOWN'}`,
        `HAND:${(deadlock.handIds || []).join('>') || 'EMPTY'}`
      ]
    }],
    handBefore: { handCount: session.handCount, cards: cleanCards(session.cards) },
    handAfter: { handCount: session.handCount, cards: cleanCards(session.cards) },
    removedCards: [],
    insertedCards: [],
    recognitionTimings: [],
    outcome: deadlock
  };
  const next = {
    ...session,
    status: 'DEADLOCK',
    updatedAt: observedAt,
    step: stepNumber,
    outcome: {
      type: 'DEADLOCK',
      detectedAt: observedAt,
      action: 'SURRENDER',
      reason: deadlock.reason || 'DEADLOCK',
      confidence: deadlock.confidence || null,
      handIds: deadlock.handIds || []
    },
    surrenderRequired: true,
    history: [...(session.history || []), step]
  };
  writeJson(SESSION_PATH, next);
  writeJson(LATEST_STEP_PATH, step);
  appendJsonLine(PERFORMANCE_JSONL, {
    type: 'DUEL_DEADLOCK',
    step: stepNumber,
    capturedAt: observedAt,
    totalMs,
    action: 'SURRENDER',
    reason: deadlock.reason || 'DEADLOCK',
    confidence: deadlock.confidence || null,
    handIds: deadlock.handIds || []
  });

  console.log('\n============================================================');
  console.log(`牌局观察第 ${stepNumber} 步：判定死局（DEADLOCK）`);
  console.log(`当前手牌: ${handText(session.cards)}`);
  console.log('判定依据: 无安全可继续动作 + 手牌无零衣 + 无已知可继续场上效果。');
  console.log(`死局置信度: ${deadlock.confidence || 'UNKNOWN'}`);
  console.log('终局动作: SURRENDER（投降）');
  console.log('本局状态已写为 DEADLOCK；观察器不再继续读取日志或点击手牌。');
  console.log('当前观察器模式不会替你点击投降；执行器接入时读取 surrenderRequired=true 即可执行投降。');
  console.log(`观察器状态: ${SESSION_PATH}`);
  console.log('============================================================');
  return next;
}

function commitTerminalVictory(session, outcome, totalMs, detectorRoundMs) {
  const observedAt = new Date().toISOString();
  const stepNumber = Number(session.step || 0) + 1;
  const step = {
    step: stepNumber,
    observedAt,
    mode: 'DUEL_TERMINAL_VICTORY',
    reason: 'VICTORY_UI_MATERIAL_MATCH',
    operations: [],
    logicalNodes: [{
      type: 'DUEL_OUTCOME',
      activationKey: null,
      name: '胜利',
      handDelta: 0,
      from: 'ACTIVE_DUEL',
      to: 'VICTORY',
      gainedCard: null,
      evidence: [
        `MATERIAL:${outcome.materialId || 'UNKNOWN'}`,
        `RECALL:${Number(outcome.metrics && outcome.metrics.recall || 0).toFixed(4)}`,
        `IOU:${Number(outcome.metrics && outcome.metrics.iou || 0).toFixed(4)}`,
        `VICTORY_REASON_TEXT:${outcome.strictEvidence && outcome.strictEvidence.reasonText && outcome.strictEvidence.reasonText.matched ? 'PASS' : 'FAIL'}`,
        `VICTORY_EXODIA_LAST5:${outcome.strictEvidence && outcome.strictEvidence.exodiaLastFive && outcome.strictEvidence.exodiaLastFive.matched ? 'PASS' : 'FAIL'}`,
        `VICTORY_CONFIRM_BUTTON_AUX:${outcome.strictEvidence && outcome.strictEvidence.confirmButton && outcome.strictEvidence.confirmButton.matched ? 'PASS' : 'FAIL'}`
      ]
    }],
    handBefore: { handCount: session.handCount, cards: cleanCards(session.cards) },
    handAfter: { handCount: session.handCount, cards: cleanCards(session.cards) },
    removedCards: [],
    insertedCards: [],
    recognitionTimings: [],
    outcome
  };
  const next = {
    ...session,
    status: 'WON',
    updatedAt: observedAt,
    step: stepNumber,
    outcome: {
      type: 'VICTORY',
      detectedAt: observedAt,
      materialId: outcome.materialId || null,
      metrics: outcome.metrics || null
    },
    history: [...(session.history || []), step]
  };
  writeJson(SESSION_PATH, next);
  writeJson(LATEST_STEP_PATH, step);
  appendJsonLine(PERFORMANCE_JSONL, {
    type: 'DUEL_VICTORY',
    step: stepNumber,
    capturedAt: observedAt,
    totalMs,
    detectorRoundMs,
    materialId: outcome.materialId || null,
    metrics: outcome.metrics || null
  });

  console.log('\n============================================================');
  console.log(`牌局观察第 ${stepNumber} 步：检测到胜利`);
  console.log(`胜利素材: ${outcome.materialName || outcome.materialId || 'VICTORY'}`);
  console.log(
    `匹配强度: recall=${Number(outcome.metrics && outcome.metrics.recall || 0).toFixed(3)}, ` +
    `IoU=${Number(outcome.metrics && outcome.metrics.iou || 0).toFixed(3)}`
  );
  if (outcome.strictEvidence) {
    console.log(
      `胜利严格证据: 获胜文字=${outcome.strictEvidence.reasonText && outcome.strictEvidence.reasonText.matched ? 'PASS' : 'FAIL'}; ` +
      `右栏最后5张艾克佐迪亚=${outcome.strictEvidence.exodiaLastFive && outcome.strictEvidence.exodiaLastFive.matched ? 'PASS' : 'FAIL'}; ` +
      `确认按钮(辅助)=${outcome.strictEvidence.confirmButton && outcome.strictEvidence.confirmButton.matched ? 'PASS' : 'FAIL'}`
    );
  }
  console.log('本局状态已写为 WON；不再读取右侧日志，也不点击手牌。');
  console.log(`观察器状态: ${SESSION_PATH}`);
  console.log('============================================================');
}

function recoverMalletPostResyncSwallowedFirstAction(session) {
  const history = Array.isArray(session && session.history) ? session.history : [];
  if (!history.length) return session;

  // Look backward across any number of empty observer rounds.  The old M11
  // empty-bottom rebaseline bug could produce one or more no-op steps before
  // the first real post-M11 activation was swallowed as BASELINE_ESTABLISHED.
  let malletIndex = history.length - 1;
  while (malletIndex >= 0) {
    const item = history[malletIndex];
    if (item && item.mode === 'MALLET_FULL_RESYNC') break;
    const hasOperations = Boolean(item && Array.isArray(item.operations) && item.operations.length);
    const handChanged = Boolean(item && item.handBefore && item.handAfter &&
      Number(item.handBefore.handCount) !== Number(item.handAfter.handCount));
    if (hasOperations || handChanged) return session;
    malletIndex -= 1;
  }
  if (malletIndex < 0 || malletIndex === history.length - 1) return session;

  const latestLog = readJsonIfExists(LOG_RESULT_PATH);
  if (!latestLog || latestLog.continuity !== 'BASELINE_ESTABLISHED') return session;
  const visibleBlocks = Array.isArray(latestLog.operationBlocks) ? latestLog.operationBlocks : [];
  const newBlocks = Array.isArray(latestLog.newOperationBlocks) ? latestLog.newOperationBlocks : [];
  if (!visibleBlocks.length || newBlocks.length) return session;

  const malletStep = history[malletIndex];
  const repairedAt = new Date().toISOString();
  const repairedSession = {
    ...session,
    updatedAt: repairedAt,
    step: Number(malletStep.step || malletIndex + 1),
    history: history.slice(0, malletIndex + 1),
    malletPostResyncLogBaseline: {
      fullResyncStep: Number(malletStep.step || malletIndex + 1),
      capturedAt: repairedAt,
      reason: 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM_SELF_HEAL'
    }
  };

  writeJson(LOG_STATE_PATH, {
    version: 1,
    capturedAt: repairedAt,
    checkpoint: null,
    tailBlocks: [],
    baseline: 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM',
    rebaselineReason: 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM_SELF_HEAL'
  });
  writeJson(SESSION_PATH, repairedSession);

  console.log('============================================================');
  console.log('检测到 M11 FULL RESYNC 后首个真实操作被旧空 checkpoint 吞成 BASELINE_ESTABLISHED。');
  console.log(`已回退 ${history.length - malletIndex - 1} 个空观察步，并恢复“M11后已验证空底部”baseline。`);
  console.log(`当前可见操作=${visibleBlocks.map(block => block.activationKey).join('>') || '无'}；本轮将立即重新识别为新操作。`);
  console.log('不会重新发动万宝槌，也不会重扫旧手牌。');
  console.log('============================================================');
  return repairedSession;
}

function continueDuel() {
  let session = readJson(SESSION_PATH);
  if (session.status === 'WON') {
    console.log('============================================================');
    console.log('本局已经检测并记录为胜利（WON）。');
    console.log('开始下一局时请运行 .\\tools\\launchers\\run-duel-observer.cmd --new');
    console.log('============================================================');
    return;
  }
  if (session.status === 'DEADLOCK') {
    console.log('============================================================');
    console.log('本局已经判定为死局（DEADLOCK）。');
    console.log('终局动作: SURRENDER（投降）。');
    console.log('开始下一局时请运行 .\\tools\\launchers\\run-duel-observer.cmd --new');
    console.log('============================================================');
    return;
  }
  if (session.status !== 'ACTIVE') {
    throw new Error(`DUEL_OBSERVER_NOT_ACTIVE:${session.status}`);
  }

  // Self-heal sessions produced by the old M11 empty-bottom rebaseline bug.
  // Do this before deadlock evaluation so the still-uncommitted first action
  // after Magical Mallet can be observed normally in THIS same run.
  session = recoverMalletPostResyncSwallowedFirstAction(session);

  if (isStaleMalletPendingContamination(session)) {
    return recoverStaleMalletPendingContamination(session);
  }
  if (session.pendingMallet && session.pendingMallet.status === 'WAITING_FOR_FULL_RESYNC') {
    return continuePendingMalletFullResync(session);
  }

  if (session.pendingNadir && session.pendingNadir.status === 'WAITING_FOR_FULL_RESOLUTION') {
    return continuePendingNadirFullResolution(session);
  }

  // Re-evaluate the already committed current state before touching the game.
  // This lets an already-observed dead hand terminate immediately on the next
  // run instead of creating a fake "no new operation" observation step.
  const existingDeadlock = detectDeadlock(session);
  if (existingDeadlock.terminal === true && existingDeadlock.type === 'DEADLOCK') {
    return commitTerminalDeadlock(session, existingDeadlock, 0);
  }

  // Compatibility/self-heal for a duel that completed M11 FULL RESYNC with an
  // older observer build. In that build the hand was rebuilt successfully but
  // the right-log state still pointed to the pre-M11 checkpoint, so the next
  // run could scroll upward through the entire Magical Mallet resolution.
  // Rebaseline exactly once at the current bottom before processing any later
  // action. New FULL RESYNC runs already store the matching step marker.
  const lastHistoryStep = Array.isArray(session.history) && session.history.length
    ? session.history[session.history.length - 1]
    : null;
  const savedMalletBaseline = session.malletPostResyncLogBaseline || null;
  if (lastHistoryStep && lastHistoryStep.mode === 'MALLET_FULL_RESYNC' &&
      Number(savedMalletBaseline && savedMalletBaseline.fullResyncStep) !== Number(lastHistoryStep.step)) {
    console.log('检测到万宝槌 FULL RESYNC 已完成，但右栏仍是旧 checkpoint；先原地重建 M11 后日志 baseline。');
    const repairMs = run('runtime/observer/test-duel-log-live.js', [
      '--observer-fast',
      '--rebaseline-current-bottom',
      ...(verbose ? ['--verbose'] : [])
    ]);
    session.malletPostResyncLogBaseline = {
      fullResyncStep: Number(lastHistoryStep.step),
      capturedAt: new Date().toISOString(),
      reason: 'M11_POST_FULL_RESYNC_CURRENT_BOTTOM_COMPAT_REPAIR',
      repairMs
    };
    writeJson(SESSION_PATH, session);
    console.log(`万宝槌后右栏 baseline 原地修复完成: ${repairMs.toFixed(1)}ms；继续当前牌局。`);
  }

  const beforeHand = readJsonIfExists(HAND_STATE_PATH);
  if (!beforeHand) throw new Error('DUEL_OBSERVER_HAND_BASELINE_MISSING');

  const wholeStarted = process.hrtime.bigint();
  // ISSUE-076 audit exception: this is the general continuous observer, not
  // the final verifier of one bounded executor atom.
  const incrementalMs = run('runtime/observer/run-live-incremental.js', ['--observer-fast', ...(verbose ? ['--verbose'] : [])]);
  const totalMs = elapsedMs(wholeStarted);
  const outcome = readJsonIfExists(OUTCOME_RESULT_PATH);
  if (outcome && outcome.terminal === true && outcome.type === 'VICTORY') {
    return commitTerminalVictory(session, outcome, totalMs, incrementalMs);
  }

  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const logPerf = readJsonIfExists(PERF_LOG_PATH);
  const handPerf = readJsonIfExists(PERF_HAND_PATH);
  const metrics = {
    observer: {
      totalMs,
      stages: [{ name: 'run_live_incremental', ms: incrementalMs }]
    },
    duelLog: logPerf,
    handIncremental: handPerf
  };
  const step = buildObservationStep(session, log, incremental, metrics);
  const next = applyObservationStep(session, step);
  if (incremental && incremental.mode === 'MALLET_ACTIVATION_PENDING_FULL_RESYNC') {
    next.pendingMallet = {
      status: 'WAITING_FOR_FULL_RESYNC',
      activationKey: 'M11',
      beforeCount: Number(incremental.pendingMallet && incremental.pendingMallet.beforeCount || session.handCount),
      activationSignature: incremental.pendingMallet && incremental.pendingMallet.activationSignature || null,
      activationCapturedAt: incremental.pendingMallet && incremental.pendingMallet.activationCapturedAt || step.observedAt
    };
  }
  if (incremental && incremental.mode === 'NADIR_ACTIVATION_PENDING_FULL_RESOLUTION') {
    next.pendingNadir = {
      status: 'WAITING_FOR_FULL_RESOLUTION',
      activationKey: 'M18',
      beforeCount: Number(incremental.pendingNadir && incremental.pendingNadir.beforeCount || session.handCount),
      activationSignature: incremental.pendingNadir && incremental.pendingNadir.activationSignature || null,
      activationCapturedAt: incremental.pendingNadir && incremental.pendingNadir.activationCapturedAt || step.observedAt
    };
  }
  writeJson(SESSION_PATH, next);
  writeJson(LATEST_STEP_PATH, step);
  appendJsonLine(PERFORMANCE_JSONL, {
    type: 'INCREMENTAL_OBSERVATION',
    step: step.step,
    capturedAt: step.observedAt,
    mode: step.mode,
    totalMs,
    recognitionTimings: step.recognitionTimings,
    metrics
  });

  console.log('\n============================================================');
  console.log(`牌局观察第 ${step.step} 步完成`);
  if (step.operations.length) {
    console.log(`本次新增操作: ${step.operations.map(op => `${op.name || op.activationKey}[${op.activationKey}]`).join(' -> ')}`);
  } else {
    console.log('本次新增操作: 无');
  }
  if (step.logicalNodes && step.logicalNodes.length) {
    console.log('本次逻辑节点:');
    step.logicalNodes.forEach((node, index) => {
      const delta = Number(node.handDelta || 0);
      console.log(`  节点${index + 1}: ${node.name || node.type}；手牌变化=${delta >= 0 ? '+' : ''}${delta}`);
    });
  }
  if (step.removedCards.length) {
    console.log(`移出手牌: ${step.removedCards.map(card => `${card.name}[${card.id}]`).join(' / ')}`);
  } else {
    console.log('移出手牌: 无');
  }
  if (step.insertedCards.length) {
    console.log(`新识别手牌: ${step.insertedCards.map(item => `手牌${item.slot} ${item.card.name}[${item.card.id}]`).join(' / ')}`);
  } else {
    console.log('新识别手牌: 无');
  }
  console.log(`当前手牌数: ${next.handCount}`);
  console.log(`当前手牌: ${handText(next.cards)}`);
  console.log(`本轮总耗时: ${totalMs.toFixed(1)}ms`);
  if (logPerf) console.log(`右侧日志识别: ${Number(logPerf.totalMs || 0).toFixed(1)}ms`);
  if (handPerf) console.log(`手牌增量处理: ${Number(handPerf.totalMs || 0).toFixed(1)}ms`);
  printRecognitionTimings(step.recognitionTimings, '新增牌逐张');
  printSlowStages(metrics);
  if (step.mode === 'MALLET_ACTIVATION_PENDING_FULL_RESYNC') {
    console.log('万宝槌发动已确认：本轮故意没有读取/修改底部手牌。');
    console.log('现在完成要洗回牌组的手牌选择并确认，等待万宝槌抽牌全部结算。');
    console.log('正常手牌扇形重新出现后，再运行 .\\tools\\launchers\\run-duel-observer.cmd；下一轮会自动 FULL RESYNC。');
  } else if (step.mode === 'NADIR_ACTIVATION_PENDING_FULL_RESOLUTION') {
    console.log('愚蠢的重葬发动已确认：本轮故意没有读取 i，也没有修改底部手牌。');
    console.log('现在选择共命之翼 迦楼拉送墓并选择发动其效果，等待抽1全部结算。');
    console.log('正常手牌扇形恢复后，再运行 .\\tools\\launchers\\run-duel-observer.cmd；下一轮会自动完成 M18 -> E01 -> 抽1 闭环。');
  } else {
    console.log('你可以继续手动完成下一步；稳定后再次运行同一命令。');
  }
  console.log(`本步详情: ${LATEST_STEP_PATH}`);
  console.log(`逐轮性能记录: ${PERFORMANCE_JSONL}`);
  console.log('============================================================');

  // A deadlock is the semantic terminal opposite of VICTORY. Evaluate only
  // after the current operation has been fully reconciled into the new hand
  // state. M11 pending/resync states are explicitly excluded by the detector.
  const deadlock = detectDeadlock(next);
  if (deadlock.terminal === true && deadlock.type === 'DEADLOCK') {
    return commitTerminalDeadlock(next, deadlock, totalMs);
  }
}

try {
  if (repairCurrent) repairCurrentHand();
  else if (preparedCurrent) initPreparedCurrentBaseline();
  else if (adoptHornetPrevious) {
    adoptAlreadyCompletedHornetPreviousStep();
    continueDuel();
  }
  else if (forceNew || !fs.existsSync(SESSION_PATH)) initDuel();
  else continueDuel();
} catch (error) {
  console.error(`\n牌局观察停止: ${error.message}`);
  if (verbose && error.stack) console.error(error.stack);
  process.exitCode = error.exitCode || 1;
}
