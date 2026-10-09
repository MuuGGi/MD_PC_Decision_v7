'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../live-config');
const { restoreBuffer } = require('../../lib/runtime-files');
const { recordFailedIncrementalObservation } = require('../../lib/incremental-observer-transaction');
const { MdFastBridge, captureReferenceRoi, clientReport, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { runDuelLogLive } = require('./test-duel-log-live');
const { runIncrementalHandChange } = require('./observe-hand-change-incremental-live');
const { detectLiveDuelOutcome } = require('../../lib/duel-outcome-detector');
const { loadInfoDigitTemplates } = require('../../lib/hand-info-overlay');
const { runFastOwnAutoHold } = require('./test-hand-info-live');
const { waitForAtomicDrawResolution, expectedResolvedHandCount } = require('../../lib/atomic-draw-resolution');
const { TERMINAL_YIELD, isStrictVictory, createTerminalObservationGuard } = require('../../lib/terminal-observation-guard');
const { validateTransaction } = require('../../lib/atomic-log-transaction');
const {
  ALLOW_HISTORICAL_BACKTRACK_ARG,
  expectedAtomicActivationKey,
  shouldUseAdjacentCheckpointOnly
} = require('../../lib/incremental-observer-policy');

const root = path.resolve(__dirname, '..', '..');
const observerStatePath = path.join(root, 'debug', 'duel-log-live', 'observer_state.json');
const incrementalResultPath = path.join(root, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const compositeRouteStatePath = path.join(root, 'debug', 'composite-route-live', 'session_state.json');
const compositeRouteResultPath = path.join(root, 'debug', 'composite-route-live', 'latest_result.json');
const verbose = process.argv.includes('--verbose');
const observerFast = process.argv.includes('--observer-fast');
// Keep performance-only shortcuts separate from OBSERVER_FAST because the
// latter also owns a few semantic field-transition/deferred-hand policies.
// Production atoms may skip only the unused debug PNG and obsolete Main1 scan.
const productionAtomicPerformanceFast = process.env.MD_V5_ATOMIC_OBSERVER === '1';
const nadirFullResolution = process.argv.includes('--nadir-full-resolution');
const exodiaVictoryRisk = process.env.MD_V5_EXODIA_VICTORY_RISK === '1';
const exodiaVictoryCertain = process.env.MD_V5_EXODIA_VICTORY_CERTAIN === '1';
const EXODIA_RISK_TOTAL_WAIT_MS = exodiaVictoryCertain ? 120000 : 12000;
const EXODIA_RISK_POLL_MS = 250;
const allowHistoricalBacktrack = process.argv.includes(ALLOW_HISTORICAL_BACKTRACK_ARG);

function elapsedMs(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1e6;
}

async function main() {
  const handStatePath = path.join(root, 'debug/hand-change-live/session_state.json');
  const ledgerStatePath = path.join(root, 'debug/main-deck-ledger/state.json');
  const decisionStatePath = path.join(root, 'decision-state.json');
  const handStateBefore = fs.existsSync(handStatePath) ? fs.readFileSync(handStatePath) : null;
  const ledgerStateBefore = fs.existsSync(ledgerStatePath) ? fs.readFileSync(ledgerStatePath) : null;
  const incrementalResultBefore = fs.existsSync(incrementalResultPath) ? fs.readFileSync(incrementalResultPath) : null;
  const decisionBefore = fs.existsSync(decisionStatePath) ? JSON.parse(fs.readFileSync(decisionStatePath, 'utf8')) : null;
  const observerStateBefore = fs.existsSync(observerStatePath)
    ? fs.readFileSync(observerStatePath)
    : null;
  let observerStateMeta = null;
  if (observerStateBefore) {
    try { observerStateMeta = JSON.parse(observerStateBefore.toString('utf8')); }
    catch (_) { observerStateMeta = null; }
  }
  const adjacentCheckpointOnly = shouldUseAdjacentCheckpointOnly({
    argv: process.argv.slice(2),
    observerStateMeta,
    env: process.env
  });
  const expectedAtomicActivation = adjacentCheckpointOnly
    ? expectedAtomicActivationKey({ argv: process.argv.slice(2), env: process.env })
    : null;
  const receiptArg = process.argv.find(arg => arg.startsWith('--atomic-log-transaction='));
  const atomicLogTransaction = receiptArg ? validateTransaction(
    JSON.parse(fs.readFileSync(receiptArg.slice('--atomic-log-transaction='.length), 'utf8')),
    { baseline: handStateBefore ? JSON.parse(handStateBefore.toString('utf8')) : null,
      logBefore: observerStateMeta, activationKey: expectedAtomicActivation }) : null;
  const compositeRouteStateBefore = fs.existsSync(compositeRouteStatePath)
    ? fs.readFileSync(compositeRouteStatePath)
    : null;
  const compositeRouteResultBefore = fs.existsSync(compositeRouteResultPath)
    ? fs.readFileSync(compositeRouteResultPath)
    : null;

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    // One activation for the whole observation round. The right-log reader and
    // hand reconciler reuse this same PowerShell process and only re-check HWND.
    const verified = await activateAndVerifyMasterDuel(bridge);
    let outcomeWatchStartedAt = Date.now();
    let prefetchedFastOwnInfo = null;

    if (exodiaVictoryRisk) {
      console.log(
        `\n艾克佐迪亚胜利风险观察: 已有组件=${process.env.MD_V5_EXODIA_COMPONENT_COUNT || '?'}; ` +
        `本动作实际抽牌容量=${process.env.MD_V5_RANDOM_DRAW_CAPACITY || '?'}; ` +
        `模式=${exodiaVictoryCertain ? '必然胜利' : '可能胜利'}。`
      );
      if (exodiaVictoryCertain) {
        console.log(
          `立即开始每${EXODIA_RISK_POLL_MS}ms被动检测终局；` +
          `最长安全窗口=${EXODIA_RISK_TOTAL_WAIT_MS}ms；` +
          '动画快则立即停止，动画卡顿则继续轮询，全程不发送 INFO、键鼠或滚轮输入。'
        );
      } else {
        console.log(
          '先检查一张严格终局帧；若尚未命中，则用一次受保护 FAST OWN INFO 探针测试 i 是否有响应。' +
          'INFO 数量必须符合本动作预期；无响应或数量不符则进入 12 秒严格终局轮询。'
        );
      }
    }

    // One reference-sized frame is reused by both the terminal detector and
    // the right-log reader. This removes the old per-round duplicate screen
    // capture (VICTORY ROI first, full client immediately after).
    const sharedCaptureStarted = process.hrtime.bigint();
    let sharedInitialFrame = await captureReferenceRoi(bridge, verified.info, {
      x: 0,
      y: 0,
      width: config.screen.width,
      height: config.screen.height
    });
    const sharedCaptureMs = elapsedMs(sharedCaptureStarted);

    console.log('\n===== duel-outcome-live =====');
    const outcomeStarted = process.hrtime.bigint();
    let outcome = await detectLiveDuelOutcome({
      rootDir: root,
      bridge,
      info: verified.info,
      sourceImage: sharedInitialFrame,
      verbose
    });
    let outcomeClassifyMs = elapsedMs(outcomeStarted);
    console.log(
      `TIMING duel-outcome-live: shared_client_capture=${sharedCaptureMs.toFixed(1)}ms; ` +
      `classify_from_shared_frame=${outcomeClassifyMs.toFixed(1)}ms`
    );

    const retryableVictoryCandidate = () => Boolean(
      outcome && outcome.safetyStop && outcome.type === 'VICTORY_CANDIDATE_UNCONFIRMED'
    );

    let shouldPollVictoryRisk = exodiaVictoryCertain || retryableVictoryCandidate();
    if (
      exodiaVictoryRisk &&
      !exodiaVictoryCertain &&
      !outcome.terminal &&
      !outcome.safetyStop
    ) {
      try {
        const expectedOwn = expectedResolvedHandCount(
          handStateBefore ? JSON.parse(handStateBefore.toString('utf8')) : null,
          expectedAtomicActivation || process.env.MD_V5_SELECTED_CARD_ID,
          atomicLogTransaction?.gainCount ?? (Number(process.env.MD_V5_RANDOM_DRAW_CAPACITY) + 1)
        );
        if (expectedOwn === null) throw new Error('VICTORY_RISK_INFO_EXPECTATION_UNKNOWN');
        const digitTemplates = loadInfoDigitTemplates(root);
        prefetchedFastOwnInfo = await runFastOwnAutoHold(
          bridge,
          { own: expectedOwn },
          digitTemplates,
          {
            debugDir: path.join(root, 'debug', 'hand-info-auto', 'victory-risk-fast-own'),
            verbose,
            saveOwnRoi: true
          }
        );
        if (prefetchedFastOwnInfo?.result?.own?.handCount !== expectedOwn) {
          throw new Error('VICTORY_RISK_INFO_COUNT_MISMATCH:expected=' + expectedOwn);
        }
        console.log(
          '可能胜利 INFO 数量符合本动作预期；仍需新帧复核终局和右栏界面；' +
          '复用本次 FAST OWN INFO，直接进入右栏/增量验收，不再第二次按住 i。'
        );
      } catch (error) {
        prefetchedFastOwnInfo = null;
        await bridge.mouseUp().catch(() => {});
        shouldPollVictoryRisk = true;
        outcomeWatchStartedAt = Date.now();
        console.log(
          `可能胜利 INFO 未通过动作数量验收（${error.code || error.message}）：` +
          `这只作为终局动画触发信号，不能单独判胜；` +
          `从现在开始每${EXODIA_RISK_POLL_MS}ms严格轮询，最长${EXODIA_RISK_TOTAL_WAIT_MS}ms。`
        );
      }
    }

    if (
      exodiaVictoryRisk &&
      shouldPollVictoryRisk &&
      !outcome.terminal &&
      (!outcome.safetyStop || retryableVictoryCandidate())
    ) {
      let nextProgressAt = Date.now() + 5000;
      let pollCount = 0;
      while (Date.now() - outcomeWatchStartedAt < EXODIA_RISK_TOTAL_WAIT_MS) {
        const elapsedBeforePoll = Date.now() - outcomeWatchStartedAt;
        const remainingBeforePoll = EXODIA_RISK_TOTAL_WAIT_MS - elapsedBeforePoll;
        if (remainingBeforePoll <= 0) break;
        await sleep(Math.min(EXODIA_RISK_POLL_MS, remainingBeforePoll));
        pollCount++;
        const pollWallStartedAt = Date.now();
        sharedInitialFrame = await captureReferenceRoi(bridge, verified.info, {
          x: 0,
          y: 0,
          width: config.screen.width,
          height: config.screen.height
        });
        const pollStarted = process.hrtime.bigint();
        outcome = await detectLiveDuelOutcome({
          rootDir: root,
          bridge,
          info: verified.info,
          sourceImage: sharedInitialFrame,
          verbose: false
        });
        outcomeClassifyMs += elapsedMs(pollStarted);
        const elapsedAfterPoll = Date.now() - outcomeWatchStartedAt;
        const remainingAfterPoll = Math.max(0, EXODIA_RISK_TOTAL_WAIT_MS - elapsedAfterPoll);
        if (outcome.terminal) {
          console.log(
            `胜利检测命中时序: poll=${pollCount}; elapsed=${elapsedAfterPoll}ms; ` +
            `本轮耗时=${Date.now() - pollWallStartedAt}ms; 阈值余量=${remainingAfterPoll}ms。`
          );
          break;
        }
        if (outcome.safetyStop && !retryableVictoryCandidate()) break;
        if (Date.now() >= nextProgressAt) {
          console.log(
            `胜利风险被动等待中: poll=${pollCount}; elapsed=${elapsedAfterPoll}ms; ` +
            `本轮耗时=${Date.now() - pollWallStartedAt}ms; 阈值余量=${remainingAfterPoll}ms; ` +
            (retryableVictoryCandidate()
              ? '已见胜利候选，严格证据尚在成熟；仍未操作右栏。'
              : '尚未出现终局画面；仍未操作右栏。')
          );
          nextProgressAt = Date.now() + 5000;
        }
      }
      if (!outcome.terminal && !outcome.safetyStop) {
        if (exodiaVictoryCertain || !prefetchedFastOwnInfo) {
          throw new Error(
            `VICTORY_RISK_UNRESOLVED_WITHIN_${EXODIA_RISK_TOTAL_WAIT_MS}MS;` +
            '无严格终局或可靠普通数量证据，禁止回落到右栏/手牌验收'
          );
        }
        console.log(
          `可能胜利观察${EXODIA_RISK_TOTAL_WAIT_MS}ms内未出现终局；` +
          '现在才进入普通右栏与手牌验收。'
        );
      }
    }
    if (outcome.safetyStop && outcome.type === 'VICTORY_CANDIDATE_UNCONFIRMED') {
      const strict = outcome.strictEvidence || {};
      console.log(
        `胜利候选未通过严格证据：获胜文字=${strict.reasonText && strict.reasonText.matched ? 'PASS' : 'FAIL'}; ` +
        `右栏最后5张艾克佐迪亚=${strict.exodiaLastFive && strict.exodiaLastFive.matched ? 'PASS' : 'FAIL'}; ` +
        `确认按钮(辅助)=${strict.confirmButton && strict.confirmButton.matched ? 'PASS' : 'FAIL'}。`
      );
      throw new Error('VICTORY_STRICT_EXODIA_EVIDENCE_INCOMPLETE');
    }

    if (isStrictVictory(outcome)) {
      console.log(
        `检测到胜利界面：素材=${outcome.materialId}; ` +
        `recall=${Number(outcome.metrics && outcome.metrics.recall || 0).toFixed(3)}; ` +
        `IoU=${Number(outcome.metrics && outcome.metrics.iou || 0).toFixed(3)}`
      );
      if (outcome.strictEvidence) {
        console.log(
          `胜利严格证据: 获胜文字=${outcome.strictEvidence.reasonText && outcome.strictEvidence.reasonText.matched ? 'PASS' : 'FAIL'}; ` +
          `右栏最后5张艾克佐迪亚=${outcome.strictEvidence.exodiaLastFive && outcome.strictEvidence.exodiaLastFive.matched ? 'PASS' : 'FAIL'}; ` +
          `确认按钮(辅助)=${outcome.strictEvidence.confirmButton && outcome.strictEvidence.confirmButton.matched ? 'PASS' : 'FAIL'}`
        );
      }
      return;
    }
    if (outcome.terminal || outcome.safetyStop) throw new Error('ATOMIC_DRAW_UNEXPECTED_TERMINAL');

    try {
    console.log('\n===== test-duel-log-live.js =====');
    if (!allowHistoricalBacktrack) {
      const adjacent = observerStateMeta && observerStateMeta.materialAdjacentStep || {};
      console.log(
        `底部验收模式: ${adjacent.step ? `仅确认相邻上一步 #${adjacent.step} ${adjacent.stageLabel || ''}` : '定位本次发动并只读其结算'}; ` +
        '全局禁止向上滚动追旧 checkpoint。'
      );
    }
    const observationBoundary = exodiaVictoryRisk ? createTerminalObservationGuard({
      detect: (sourceImage, info) => detectLiveDuelOutcome({ rootDir: root, bridge,
        info, sourceImage, verbose: false }),
      capture: async () => {
        const info = await bridge.info();
        const title = String(info.title || '').toLowerCase();
        const report = clientReport(info);
        if ((!title.includes('masterduel') && !title.includes('master duel')) ||
            !report.clientFullyVisible || report.aspectError > 0.03) {
          throw new Error('MASTER_DUEL_FOREGROUND_LOST_TERMINAL_OBSERVATION');
        }
        const image = await captureReferenceRoi(bridge, info, {
          x: 0, y: 0, width: config.screen.width, height: config.screen.height
        });
        return { info, image };
      },
      delay: sleep,
      onSuspend: stage => console.log(`右栏观察边界${stage}失去普通界面/出现终局候选；停止右栏输入，仅被动等待严格终局。`)
    }) : null;
    const observeCurrentLog = initialScreenshot => runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast,
      performanceFast: observerFast || productionAtomicPerformanceFast,
      verbose,
      initialScreenshot,
      initialInfo: verified.info,
      knownPendingNadirFullResolution: nadirFullResolution,
      allowBacktrack: allowHistoricalBacktrack,
      expectedAtomicActivationKey: expectedAtomicActivation,
      atomicLogTransaction,
      checkObservationBoundary: observationBoundary
    });

    // INFO responding does not mean the draw animation has finished. The
    // shared frame predates that probe; never validate its activation-only log.
    if (prefetchedFastOwnInfo) {
      sharedInitialFrame = await captureReferenceRoi(bridge, verified.info, {
        x: 0, y: 0, width: config.screen.width, height: config.screen.height
      });
      const refreshedOutcome = await detectLiveDuelOutcome({ rootDir: root, bridge,
        info: verified.info, sourceImage: sharedInitialFrame, verbose: false });
      if (refreshedOutcome.terminal) {
        if (refreshedOutcome.type !== 'VICTORY' || refreshedOutcome.strictEvidence?.matched !== true) throw new Error('ATOMIC_DRAW_UNEXPECTED_TERMINAL');
        return;
      }
      if (refreshedOutcome.safetyStop) throw new Error('ATOMIC_DRAW_TERMINAL_SAFETY_STOP');
    }
    await observeCurrentLog(sharedInitialFrame);
    const resolution = await waitForAtomicDrawResolution({
      activationKey: expectedAtomicActivation,
      expectedGainCount: atomicLogTransaction?.gainCount,
      readLog: () => JSON.parse(fs.readFileSync(path.join(root, 'debug/duel-log-live/latest_result.json'), 'utf8')),
      delay: sleep,
      onPending: (proof, polls) => {
        if (polls === 0) console.log(`本次${proof.activationKey}只见${proof.observed}/${proof.expected}张获卡；等待当前结算，不重发动、不支付费用、不追旧日志。`);
        prefetchedFastOwnInfo = null;
      },
      refresh: async () => {
        const frame = await captureReferenceRoi(bridge, verified.info, {
          x: 0, y: 0, width: config.screen.width, height: config.screen.height
        });
        const terminal = await detectLiveDuelOutcome({ rootDir: root, bridge,
          info: verified.info, sourceImage: frame, verbose: false });
        if (terminal.terminal) {
          if (terminal.type !== 'VICTORY' || terminal.strictEvidence?.matched !== true) throw new Error('ATOMIC_DRAW_UNEXPECTED_TERMINAL');
          return terminal;
        }
        if (terminal.safetyStop) throw new Error('ATOMIC_DRAW_TERMINAL_SAFETY_STOP');
        restoreBuffer(observerStatePath, observerStateBefore);
        await observeCurrentLog(frame);
        return null;
      }
    });
    if (resolution.terminal) return;
    console.log('\n===== observe-hand-change-incremental-live.js =====');
      // Never allow a PASS path that writes no result to leak a previous round's
      // M11/full-resync state into the current observation. Every current PASS
      // path is required to write a fresh latest_incremental_result.json.
      if (fs.existsSync(incrementalResultPath)) fs.unlinkSync(incrementalResultPath);
      for (let attempt = 1; ; attempt++) {
        try {
          await runIncrementalHandChange({ bridge, skipActivation: true, verbose, prefetchedFastOwnInfo });
          break;
        } catch (error) {
          if (!String(error.message).startsWith('NEW_HAND_IDENTITY_UNRESOLVED_NO_CLICK:') || attempt >= 3) throw error;
          console.log('新增身份尚不确定：纯等待300ms后重读当前右栏，不点击新手牌 (' + attempt + '/3)。');
          // Retry the same transaction against its original checkpoint. No
          // hand/ledger was committed and no game action is replayed.
          restoreBuffer(observerStatePath, observerStateBefore);
          restoreBuffer(compositeRouteStatePath, compositeRouteStateBefore);
          restoreBuffer(compositeRouteResultPath, compositeRouteResultBefore);
          await sleep(300);
          await observeCurrentLog(null);
        }
      }
      if (!fs.existsSync(incrementalResultPath)) {
        throw new Error('INCREMENTAL_RESULT_NOT_WRITTEN_THIS_ROUND');
      }
    } catch (error) {
      if (error.code === TERMINAL_YIELD && isStrictVictory(error.outcome)) {
        console.log('右栏观察期间已严格确认胜利；直接移交终局，不写普通手牌/日志检查点。');
        return;
      }
      // INFO is unavailable during the victory animation.  After any
      // incremental failure, release a possible guarded hold and give the
      // mature strict terminal detector one fresh frame before rolling back.
      // This is read-only apart from the detector's already-validated ability
      // to open the terminal history pane when it is closed.
      await bridge.mouseUp().catch(() => {});
      try {
        const fallbackInfo = await bridge.info();
        const fallbackFrame = await captureReferenceRoi(bridge, fallbackInfo, {
          x: 0,
          y: 0,
          width: config.screen.width,
          height: config.screen.height
        });
        const fallbackOutcome = await detectLiveDuelOutcome({
          rootDir: root,
          bridge,
          info: fallbackInfo,
          sourceImage: fallbackFrame,
          verbose: false
        });
        if (
          fallbackOutcome.terminal === true &&
          fallbackOutcome.type === 'VICTORY' &&
          fallbackOutcome.strictEvidence &&
          fallbackOutcome.strictEvidence.matched === true
        ) {
          console.log(
            '增量/INFO验收未完成，但成熟终局检测已严格确认胜利；' +
            '跳过手牌数、普通抽牌增量和后续 i 输入。'
          );
          return;
        }
      } catch (terminalCheckError) {
        console.log(
          `增量失败后的终局复核未得到严格胜利证据：` +
          `${terminalCheckError.code || terminalCheckError.message}`
        );
      }

      restoreBuffer(handStatePath, handStateBefore);
      restoreBuffer(ledgerStatePath, ledgerStateBefore);
      restoreBuffer(incrementalResultPath, incrementalResultBefore);
      restoreBuffer(observerStatePath, observerStateBefore);
      restoreBuffer(compositeRouteStatePath, compositeRouteStateBefore);
      restoreBuffer(compositeRouteResultPath, compositeRouteResultBefore);
      const failureLogPath = path.join(root, 'debug/duel-log-live/latest_result.json');
      recordFailedIncrementalObservation({ activationKey: expectedAtomicActivation,
        selectedCardId: process.env.MD_V5_SELECTED_CARD_ID,
        selectedSlot: process.env.MD_V5_SELECTED_SLOT,
        before: handStateBefore ? JSON.parse(handStateBefore.toString('utf8')) : null,
        decisionBefore, log: fs.existsSync(failureLogPath) ? JSON.parse(fs.readFileSync(failureLogPath, 'utf8')) : null,
        error });
      console.error('增量阶段失败：手牌/账本/结果/日志检查点/复合支线已一同回滚；只允许恢复本次验收，不重新发动。');
      throw error;
    }
  } finally {
    await bridge.stop();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { main };
