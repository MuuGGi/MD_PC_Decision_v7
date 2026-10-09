'use strict';

const fs = require('fs');
const path = require('path');
const { buildExodiaComponentSet } = require('../../lib/exodia-policy');
const { writeJsonAtomic } = require('../../lib/runtime-files');
const config = require('../../live-config');
const {buildMalletStartupTail,matchStartupTail} = require('../../lib/startup-tail-boundary');
const { loadFieldRowTemplates, recognizeFieldRows } = require('../../lib/duel-log-field-rows');
const {
  MdFastBridge,
  captureReferenceRoi,
  clientReport,
  mapReferencePoint,
  sleep
} = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { readPng, savePng, cropImage } = require('../../lib/png-utils');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const {
  loadDuelLogLabelTemplates,
  recognizeDuelLogLabels
} = require('../../lib/duel-log-label-reader');
const {
  recognizeMain1Baseline,
  recognizeCardEventsAfterMain1,
  recognizeVisibleCardEvents,
  semanticEventsFromLabels,
  mergeSemanticEvents
} = require('../../lib/duel-log-reader');
const {
  buildActivationBlocks,
  annotateBlockRelationships,
  normalizeInterposedKagariBambooResults,
  findCheckpointMatch,
  checkpointFrom,
  reconcileActivationBlocks,
  reconcileExpectedAtomicBottom
} = require('../../lib/duel-log-state');
const {
  stitchChronologicalViewports,
  mergeOrphanDetails
} = require('../../lib/duel-log-scroll-stitch');
const {
  compactTailBlocks,
  findCrossRunTailContinuity
} = require('../../lib/duel-log-tail-continuity');
const { RunTimer } = require('../../lib/run-timer');
const { reconcileTransactionBottom } = require('../../lib/atomic-log-transaction');
const {
  sampledLocalImageDifference,
  isNoMotionProbe,
  adaptiveBottomBurstPlan
} = require('../../lib/log-bottom-probe');
const {
  findHornetLinkContinuationAtTop,
  hornetLinkTransition,
  findVisibleCheckpointExtensionAtTop,
  findForwardCheckpointGainHandoff
} = require('../../lib/observer-log-continuity');

const CLI_VERBOSE = process.argv.includes('--verbose');
const CLI_OBSERVER_FAST = process.argv.includes('--observer-fast');
const CLI_DEFER_BOTTOM_TO_HAND_CLICK = process.argv.includes('--defer-bottom-to-hand-click');
const CLI_REBASELINE_CURRENT_BOTTOM = process.argv.includes('--rebaseline-current-bottom');
const CLI_KNOWN_PENDING_NADIR_FULL_RESOLUTION = process.argv.includes('--nadir-full-resolution');
const CLI_ALLOW_HISTORICAL_BACKTRACK = process.argv.includes('--allow-historical-backtrack');
const RIGHT_LOG_PANEL = Object.freeze({ x: 1674, y: 150, width: 348, height: 886 });

function recognizeDuelLogScreenshot(sourceImage, templateBundle, options = {}) {
  const skipMain1Search = options.skipMain1Search === true;
  const phaseTemplate = templateBundle.phaseTemplate;
  let result;
  if (skipMain1Search) {
    result = {
      status: 'OK_MAIN1_SCROLLED_OUT',
      rightPanel: { ...RIGHT_LOG_PANEL },
      atomicBottomFastPath: true
    };
    result.events = recognizeVisibleCardEvents(
      sourceImage,
      result.rightPanel,
      result.rightPanel.y,
      templateBundle.cardTemplates
    );
  } else {
    result = recognizeMain1Baseline(sourceImage, phaseTemplate);
    if (result.status === 'OK') {
      result.events = recognizeCardEventsAfterMain1(
        sourceImage,
        result,
        templateBundle.cardTemplates
      );
    } else if (result.status === 'MAIN1_NOT_FOUND') {
      result.status = 'OK_MAIN1_SCROLLED_OUT';
      result.events = recognizeVisibleCardEvents(
        sourceImage,
        result.rightPanel,
        result.rightPanel.y,
        templateBundle.cardTemplates
      );
    } else result.events = [];
  }
  if (result.status === 'OK' || result.status === 'OK_MAIN1_SCROLLED_OUT') {
    const panel = cropImage(sourceImage, result.rightPanel);
    result.semanticLabels = recognizeDuelLogLabels(panel, templateBundle.labelTemplates);
    const semanticEvents = semanticEventsFromLabels(
      sourceImage,
      result.rightPanel,
      result.semanticLabels,
      templateBundle.cardTemplates
    );
    result.events = mergeSemanticEvents(result.events, semanticEvents);
    const fieldRows = recognizeFieldRows(
      sourceImage,
      result.rightPanel,
      templateBundle.fieldRowTemplates,
      templateBundle.cardTemplates
    );
    result.events = mergeSemanticEvents(result.events, fieldRows);
    result.fieldRowEvidence = fieldRows;
  }
  return result;
}

function findVisibleCheckpointByEvidenceSubset(blocks, checkpoint) {
  if (!Array.isArray(blocks) || !checkpoint) return null;
  const evidence = Array.isArray(checkpoint.evidenceCards)
    ? checkpoint.evidenceCards.filter(item => item && item.cardKey)
    : [];
  // This fallback exists only for a checkpoint that originally had concrete
  // result/processing evidence. Empty/header-only checkpoints still use the
  // strict matcher because activation-key context alone can be ambiguous.
  if (!evidence.length) return null;

  const requiredCounts = new Map();
  for (const item of evidence) {
    const key = String(item.cardKey);
    requiredCounts.set(key, (requiredCounts.get(key) || 0) + 1);
  }

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block || block.activationKey !== checkpoint.activationKey) continue;
    if (checkpoint.previousActivationKey) {
      if (index <= 0 || blocks[index - 1].activationKey !== checkpoint.previousActivationKey) continue;
    }

    const visibleCounts = new Map();
    for (const detail of block.details || []) {
      const card = detail && detail.card;
      const key = card && String(card.id || card.name || '');
      if (!key) continue;
      visibleCounts.set(key, (visibleCounts.get(key) || 0) + 1);
    }
    let allSavedEvidenceStillVisible = true;
    for (const [key, count] of requiredCounts.entries()) {
      if ((visibleCounts.get(key) || 0) < count) {
        allSavedEvidenceStillVisible = false;
        break;
      }
    }
    if (!allSavedEvidenceStillVisible) continue;

    return {
      index,
      matchType: checkpoint.previousActivationKey
        ? 'EVIDENCE_SUBSET_WITH_PREDECESSOR'
        : 'EVIDENCE_SUBSET',
      evidenceKeys: [...requiredCounts.keys()]
    };
  }
  return null;
}

function sampledImageDifference(left, right) {
  if (!left || !right || left.width !== right.width || left.height !== right.height) return Infinity;
  let total = 0;
  let samples = 0;
  for (let y = 160; y < Math.min(left.height, 1040); y += 12) {
    for (let x = 1680; x < Math.min(left.width, 2025); x += 12) {
      const offset = (y * left.width + x) * 4;
      total += Math.abs(left.data[offset] - right.data[offset]);
      total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
      total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
      samples += 3;
    }
  }
  return samples ? total / samples / 255 : Infinity;
}

function detectLogScrollbarThumb(image) {
  if (!image || image.width <= 2020 || image.height <= 1028) return null;

  // The open history panel has a long blue vertical rail on its right edge.
  // Its exact x coordinate is not a single pixel: on the 2048x1152 reference
  // client the rail is split across ~2006-2008 and ~2015-2017, while x=2011
  // can be completely dark. Scanning only x=2011 therefore falsely reported
  // CLOSED during M18's Extra Deck selection screen and caused a destructive
  // log-button click. Probe the whole narrow edge band and choose the strongest
  // long vertical segment instead.
  const candidates = [];
  for (let x = 2003; x <= 2019; x++) {
    const segments = [];
    let start = -1;
    for (let y = 150; y <= 1028; y++) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const isRailBlue = b > 70 && b > r * 1.25 && b > g * 1.02;
      if (isRailBlue && start < 0) start = y;
      if (!isRailBlue && start >= 0) {
        if (y - start >= 20) segments.push({ top: start, bottom: y - 1 });
        start = -1;
      }
    }
    if (start >= 0) segments.push({ top: start, bottom: 1028 });
    if (!segments.length) continue;
    const ordered = segments.slice().sort((left, right) => left.top - right.top);
    const primary = segments.slice()
      .sort((left, right) => (right.bottom - right.top) - (left.bottom - left.top))[0];
    const length = primary.bottom - primary.top + 1;
    candidates.push({ x, ordered, primary, length });
  }

  if (!candidates.length) return null;
  const best = candidates.sort((left, right) => right.length - left.length)[0];
  // Short blue decorations can exist even with the history closed. The real
  // history rail is a tall vertical structure, so require a conservative span.
  if (best.length < 80) return null;

  return {
    ...best.primary,
    x: best.x,
    segments: best.ordered,
    atBottom: best.ordered.length === 1,
    railLength: best.length
  };
}

function detectLogPanelState(image, previousOpenHint = false) {
  // Never toggle the history button from one fragile pixel heuristic alone.
  // During effect prompts (notably M18 -> Garura) the open history panel can
  // become brighter than the normal duel-log skin, so the old dark-ratio-only
  // test could misclassify an already-open panel as closed and click the log
  // button, which actually closes it.
  const thumb = detectLogScrollbarThumb(image);
  if (thumb) {
    return {
      open: true,
      confidence: 'HIGH',
      reason: 'VISIBLE_SCROLLBAR_RAIL',
      darkRatio: null,
      thumb
    };
  }

  let dark = 0;
  let total = 0;
  for (let y = 170; y < 1000; y += 8) {
    for (let x = 1680; x < 2005; x += 8) {
      const i = (y * image.width + x) * 4;
      const mean = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
      if (mean < 58) dark++;
      total++;
    }
  }
  const darkRatio = total ? dark / total : 0;

  // Open duel-log panels are normally very dark. Use a deliberately lower
  // open threshold than before because prompt/result rows brighten the panel.
  if (darkRatio >= 0.58) {
    return {
      open: true,
      confidence: 'HIGH',
      reason: 'DARK_PANEL_BODY',
      darkRatio,
      thumb: null
    };
  }

  // If the preceding successful observer run left the panel open and the
  // current frame is merely ambiguous, prefer NOT clicking. A mistaken click
  // on an open panel is destructive (it closes the log); a missed click can be
  // retried safely after recognition fails.
  if (previousOpenHint && darkRatio >= 0.40) {
    return {
      open: true,
      confidence: 'MEDIUM',
      reason: 'PREVIOUS_OPEN_PLUS_AMBIGUOUS_BODY',
      darkRatio,
      thumb: null
    };
  }

  // Only declare CLOSED when the right side is clearly too bright to be the
  // history panel. This makes the log-button click conservative by design.
  if (darkRatio < 0.40) {
    return {
      open: false,
      confidence: 'HIGH',
      reason: 'BRIGHT_RIGHT_SIDE',
      darkRatio,
      thumb: null
    };
  }

  // First-run ambiguous case: keep the existing panel untouched. The caller
  // will attempt recognition; this is safer than accidentally closing it.
  return {
    open: true,
    confidence: 'LOW',
    reason: 'AMBIGUOUS_PREFER_NO_TOGGLE',
    darkRatio,
    thumb: null
  };
}

function printConciseResult(result, resultPath) {
  const blocks = result.operationBlocks || [];
  const newBlocks = result.newOperationBlocks || [];
  console.log(`右侧信息栏: ${result.status}; 连续性=${result.continuity}; 可见操作=${blocks.length}; 新操作=${newBlocks.length}`);
  for (let index = 0; index < newBlocks.length; index++) {
    const block = newBlocks[index];
    const details = (block.details || []).map(detail => {
      const card = detail.card || {};
      return `${detail.rawType || detail.role}:${card.name || card.id || 'UNKNOWN'}`;
    });
    console.log(
      `  新操作${index + 1}: ${block.activation.card.name} [${block.activationKey}]` +
      (details.length ? ` -> ${details.join(' / ')}` : '')
    );
  }
  const extendedBlocks = result.extendedOperationBlocks || [];
  for (let index = 0; index < extendedBlocks.length; index++) {
    const block = extendedBlocks[index];
    const details = (block.details || []).map(detail => {
      const card = detail.card || {};
      return `${detail.rawType || detail.role}:${card.name || card.id || 'UNKNOWN'}`;
    });
    console.log(
      `  顶格扩展${index + 1}: ${block.activation && block.activation.card && block.activation.card.name || block.activationKey} [${block.activationKey}]` +
      (details.length ? ` -> ${details.join(' / ')}` : '')
    );
  }
  for (const transition of result.observerFieldTransitions || []) {
    console.log(`  场面节点: ${transition.name || transition.type}（手牌变化 ${Number(transition.handDelta || 0) >= 0 ? '+' : ''}${Number(transition.handDelta || 0)}）`);
  }
  console.log(`完整识别详情: ${resultPath}`);
}

async function runDuelLogLive(options = {}) {
  const VERBOSE = options.verbose != null ? Boolean(options.verbose) : CLI_VERBOSE;
  const OBSERVER_FAST = options.observerFast != null ? Boolean(options.observerFast) : CLI_OBSERVER_FAST;
  const PERFORMANCE_FAST = options.performanceFast != null
    ? Boolean(options.performanceFast)
    : OBSERVER_FAST;
  const DEFER_BOTTOM_TO_HAND_CLICK = options.deferBottomToHandClick != null
    ? Boolean(options.deferBottomToHandClick)
    : CLI_DEFER_BOTTOM_TO_HAND_CLICK;
  const REBASELINE_CURRENT_BOTTOM = options.rebaselineCurrentBottom != null
    ? Boolean(options.rebaselineCurrentBottom)
    : CLI_REBASELINE_CURRENT_BOTTOM;
  const KNOWN_PENDING_NADIR_FULL_RESOLUTION = options.knownPendingNadirFullResolution != null
    ? Boolean(options.knownPendingNadirFullResolution)
    : CLI_KNOWN_PENDING_NADIR_FULL_RESOLUTION;
  // ISSUE-078: current-operation settlement is the production boundary for
  // every observer, not only named atomic branches. Historical upward scrolling
  // is now a diagnostic/recovery exception that must be explicitly requested.
  const ALLOW_BACKTRACK = options.allowBacktrack != null
    ? options.allowBacktrack === true
    : CLI_ALLOW_HISTORICAL_BACKTRACK;
  const EXPECTED_ATOMIC_ACTIVATION_KEY = String(
    options.expectedAtomicActivationKey || ''
  ).trim().toUpperCase();
  const startedNs = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const root = path.resolve(__dirname, '..', '..');
  const debugDir = path.join(root, 'debug', 'duel-log-live');
  const timer = new RunTimer('duel-log-live', path.join(root, 'debug', 'performance'), {
    startedNs,
    startedAt
  });
  fs.mkdirSync(debugDir, { recursive: true });

  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  let status = 'FAIL';
  if (ownsBridge) await timer.time('bridge_start', () => bridge.start());
  else timer.timeSync('bridge_reuse', () => null);
  try {
    if (!options.skipActivation) {
      await timer.time('activate_and_verify_window', () => activateAndVerifyMasterDuel(bridge));
    } else {
      await timer.time('reuse_verified_window', () => bridge.info());
    }
    // Desktop focus can change between activation and capture. In a shared
    // observer bridge we have just completed another guarded MD operation, so
    // verify the current HWND without paying for a second activation.
    const info = await timer.time('foreground_recheck', async () => {
      if (!options.skipForegroundReactivate) await bridge.activateMasterDuel();
      return bridge.info();
    });
    const titleNow = String(info.title || '').toLowerCase();
    if (!titleNow.includes('masterduel') && !titleNow.includes('master duel')) {
      throw new Error(`MASTER_DUEL_FOREGROUND_LOST_BEFORE_CAPTURE: ${info.title || 'UNKNOWN'}`);
    }
    const report = clientReport(info);
    if (!report.clientFullyVisible || report.aspectError > 0.03) {
      throw new Error('MASTER_DUEL_CLIENT_UNSAFE_FOR_LOG_CAPTURE');
    }

    const validateSafeForegroundInfo = (foreground, reason) => {
      const title = String(foreground && foreground.title || '').toLowerCase();
      const foregroundReport = foreground ? clientReport(foreground) : null;
      if (!foregroundReport ||
          (!title.includes('masterduel') && !title.includes('master duel')) ||
          !foregroundReport.clientFullyVisible || foregroundReport.aspectError > 0.03) {
        throw new Error(`MASTER_DUEL_FOREGROUND_LOST_${reason}`);
      }
      return foreground;
    };

    const assertSafeForeground = async (reason) => {
      return validateSafeForegroundInfo(await bridge.info(), reason);
    };

    // Scrolling used to be assembled from 5~7 separate bridge calls
    // (info -> move -> info -> wheel -> info -> capture). Every bridge command
    // re-queries the MD HWND, so one tiny backtrack could cost several seconds.
    // Keep the same safety boundary, wheel count, and post-scroll capture, but
    // execute wheel + settle + capture as one guarded PowerShell transaction.
    const wheelBurstCaptureFull = async (referencePoint, delta, count, intervalMs, settleMs, reason) => {
      const captured = await bridge.wheelBurstCaptureReferenceRoi(
        referencePoint,
        delta,
        count,
        intervalMs,
        settleMs,
        { x: 0, y: 0, width: config.screen.width, height: config.screen.height }
      );
      validateSafeForegroundInfo(captured.info, reason);
      return captured.image;
    };

    const forceLogBottom = async (sourceImage, reason) => {
      let currentImage = sourceImage;
      let wheelBatchCount = 0;
      let wheelEvents = 0;
      const reasonKey = String(reason || 'bottom').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const captureCurrent = async (suffix) => {
        const captureInfo = await assertSafeForeground(`${reason}_${suffix}`);
        const image = await captureReferenceRoi(bridge, captureInfo, {
          x: 0, y: 0, width: config.screen.width, height: config.screen.height
        });
        if (VERBOSE) {
          await savePng(image, path.join(debugDir, `bottom_${reasonKey}_${suffix.toLowerCase()}.png`));
        }
        return image;
      };

      if (!currentImage) {
        currentImage = await captureCurrent('INITIAL');
      } else if (VERBOSE) {
        await savePng(currentImage, path.join(debugDir, `bottom_${reasonKey}_initial.png`));
      }

      const initialThumb = detectLogScrollbarThumb(currentImage);
      if (initialThumb && initialThumb.atBottom) {
        console.log(
          `回到底部 ${reason}: 初始滚动位置=${initialThumb.top}-${initialThumb.bottom}（已到底）；无需滚轮。`
        );
        return {
          image: currentImage,
          confirmed: true,
          confirmation: 'VISIBLE_RAIL_ALREADY_BOTTOM',
          wheelBatchCount: 0,
          wheelEvents: 0,
          thumb: initialThumb
        };
      }

      let thumb = initialThumb;
      let noMotionConfirmed = false;
      let lastDifference = Infinity;
      let burstPlan = adaptiveBottomBurstPlan(Boolean(initialThumb));

      if (!initialThumb) {
        // One tiny probe is enough to distinguish "rail detector missed it"
        // from "history is really above bottom". Wheel + render settle +
        // capture happen inside ONE bridge command; the returned full frame is
        // reused directly for recognition, so there is no second recapture.
        const probeCount = burstPlan.shift();
        const beforeProbe = currentImage;
        currentImage = await timer.time('bottom_light_probe_capture', () =>
          wheelBurstCaptureFull(
            { x: 1960, y: 600 }, -1440, probeCount, 1, 70, `${reason}_LIGHT_PROBE`
          )
        );
        wheelBatchCount++;
        wheelEvents += probeCount;
        lastDifference = sampledImageDifference(beforeProbe, currentImage);
        console.log(
          `回到底部 ${reason}: 滚动条未识别；先轻量探底=${probeCount}次×12格；` +
          `右栏变化=${lastDifference.toFixed(4)}。`
        );
        if (isNoMotionProbe(lastDifference)) {
          noMotionConfirmed = true;
          console.log(`回到底部 ${reason}: 轻量探底后右栏基本不动，确认当前已在绝对底部；不再执行重型滚轮。`);
          return {
            image: currentImage,
            confirmed: true,
            confirmation: 'DOWNWARD_LIGHT_PROBE_NO_MOVEMENT',
            wheelBatchCount,
            wheelEvents,
            thumb: null,
            probeDifference: lastDifference
          };
        }

        thumb = detectLogScrollbarThumb(currentImage);
        if (thumb && thumb.atBottom) {
          console.log(
            `回到底部 ${reason}: 轻量探底已到最底；滚动位置=${thumb.top}-${thumb.bottom}。`
          );
          return {
            image: currentImage,
            confirmed: true,
            confirmation: 'LIGHT_PROBE_RAIL_BOTTOM',
            wheelBatchCount,
            wheelEvents,
            thumb,
            probeDifference: lastDifference
          };
        }
      } else {
        console.log(
          `回到底部 ${reason}: 初始滚动位置=${initialThumb.top}-${initialThumb.bottom}（仍未到底）；` +
          `启用自适应向下滚动。`
        );
      }

      for (let burstIndex = 0; burstIndex < burstPlan.length; burstIndex++) {
        const count = burstPlan[burstIndex];
        const previousImage = currentImage;
        currentImage = await timer.time('bottom_adaptive_burst_capture', () =>
          wheelBurstCaptureFull(
            { x: 1960, y: 600 }, -1440, count, 1, 80,
            `${reason}_ADAPTIVE_${String(burstIndex + 1).padStart(2, '0')}`
          )
        );
        wheelBatchCount++;
        wheelEvents += count;
        thumb = detectLogScrollbarThumb(currentImage);
        lastDifference = sampledImageDifference(previousImage, currentImage);
        console.log(
          `回到底部 ${reason}: 自适应下滚第${burstIndex + 1}批=${count}次×12格；` +
          `累计事件=${wheelEvents}；右栏变化=${lastDifference.toFixed(4)}；滚动位置=${thumb
            ? `${thumb.top}-${thumb.bottom}${thumb.atBottom ? '（已到底）' : '（仍未到底）'}`
            : '未识别'}`
        );
        if (thumb && thumb.atBottom) break;
        if (isNoMotionProbe(lastDifference)) {
          noMotionConfirmed = true;
          console.log(`回到底部 ${reason}: 继续下滚后右栏已不再移动，按绝对底部确认并停止追加滚轮。`);
          break;
        }
      }

      return {
        image: currentImage,
        confirmed: true,
        confirmation: thumb && thumb.atBottom
          ? 'ADAPTIVE_DOWN_BURST_RAIL_BOTTOM'
          : noMotionConfirmed
            ? 'ADAPTIVE_DOWN_BURST_NO_MOVEMENT'
            : 'ADAPTIVE_DOWN_BURST_CONTINUITY_REQUIRED',
        wheelBatchCount,
        wheelEvents,
        thumb,
        probeDifference: Number.isFinite(lastDifference) ? lastDifference : null
      };
    };

    let screenshot;
    if (options.initialScreenshot &&
        Number(options.initialScreenshot.width) === Number(config.screen.width) &&
        Number(options.initialScreenshot.height) === Number(config.screen.height)) {
      screenshot = timer.timeSync('reuse_initial_client_capture', () => options.initialScreenshot);
    } else {
      screenshot = await timer.time('initial_client_capture', () => captureReferenceRoi(bridge, info, {
        x: 0, y: 0, width: config.screen.width, height: config.screen.height
      }));
    }
    let previousOpenHint = false;
    const previousResultPath = path.join(debugDir, 'latest_result.json');
    if (fs.existsSync(previousResultPath)) {
      try {
        const previousResult = JSON.parse(fs.readFileSync(previousResultPath, 'utf8'));
        previousOpenHint = previousResult && previousResult.status !== 'FAIL';
      } catch (_) {
        previousOpenHint = false;
      }
    }
    const panelState = detectLogPanelState(screenshot, previousOpenHint);
    const panelOpen = panelState.open;
    console.log(
      `右栏面板检测: ${panelOpen ? '已打开' : '未打开'}; ` +
      `依据=${panelState.reason}; 置信度=${panelState.confidence}` +
      (Number.isFinite(panelState.darkRatio) ? `; darkRatio=${panelState.darkRatio.toFixed(3)}` : '')
    );

    if (!panelOpen) {
      const foreground = await bridge.info();
      const title = String(foreground.title || '').toLowerCase();
      const foregroundReport = clientReport(foreground);
      if ((!title.includes('masterduel') && !title.includes('master duel')) ||
          !foregroundReport.clientFullyVisible || foregroundReport.aspectError > 0.03) {
        throw new Error('MASTER_DUEL_FOREGROUND_LOST_BEFORE_LOG_BUTTON');
      }
      screenshot = await timer.time('open_panel_and_recapture', async () => {
        const logButton = mapReferencePoint(foreground, { x: 1985, y: 1084 });
        await bridge.click(logButton.x, logButton.y);
        await sleep(650);
        const after = await bridge.info();
        return captureReferenceRoi(bridge, after, {
          x: 0, y: 0, width: config.screen.width, height: config.screen.height
        });
      });
    }
    const initialBottom = await forceLogBottom(screenshot, 'BEFORE_RECOGNITION');
    screenshot = initialBottom.image;
    // Full-frame PNG encoding is useful for material collection and --verbose,
    // but the production observer consumes latest_result.json rather than the
    // screenshot file. Skip this repeated 2048x1152 debug encode in fast mode.
    const keepDebugScreenshots = VERBOSE || !PERFORMANCE_FAST;
    const screenshotPath = keepDebugScreenshots ? path.join(debugDir, 'latest_client.png') : null;
    if (screenshotPath) {
      await timer.time('save_latest_client_debug', () => savePng(screenshot, screenshotPath));
    }


    const atomicBottomFastPath = Boolean(
      PERFORMANCE_FAST && EXPECTED_ATOMIC_ACTIVATION_KEY && !REBASELINE_CURRENT_BOTTOM
    );
    const templateBundle = await timer.time('load_recognition_templates', async () => {
      const phaseTemplate = atomicBottomFastPath
        ? null
        : await readPng(path.join(root, 'templates', 'ui', 'duel_log_main1_phase.png'));
      const library = loadLibrary(root);
      const loaded = await loadTemplates(root, library);
      const labelTemplates = await loadDuelLogLabelTemplates(root);
      const fieldRowTemplates = await loadFieldRowTemplates(root);
      const cardTemplates = loaded.map(item => ({ ...item.card, image: item.image }));
      return { phaseTemplate, loaded, labelTemplates, fieldRowTemplates, cardTemplates };
    });
    const recognizeScreenshot = sourceImage => recognizeDuelLogScreenshot(
      sourceImage,
      templateBundle,
      { skipMain1Search: atomicBottomFastPath }
    );
    if (atomicBottomFastPath) {
      console.log(
        `右栏原子快速路径: expected=${EXPECTED_ATOMIC_ACTIVATION_KEY}; ` +
        '跳过Main1全栏搜索，直接识别当前底部视口。'
      );
    }
    const recognized = timer.timeSync('recognize_right_log_pixels', () => recognizeScreenshot(screenshot));
    const result = recognized;
    let grouped = timer.timeSync('group_and_reconcile_events', () => buildActivationBlocks(result.events));

    const observerStatePath = path.join(debugDir, 'observer_state.json');
    let previousObserverState = null;
    if (fs.existsSync(observerStatePath)) {
      try {
        previousObserverState = JSON.parse(fs.readFileSync(observerStatePath, 'utf8'));
      } catch (_) {
        previousObserverState = null;
      }
    }
    let effectiveBlocks = grouped.blocks;
    let effectiveOrphans = grouped.orphanDetails;

    // M11 FULL RESYNC special case: after Magical Mallet has fully resolved,
    // the old right-log checkpoint can be buried far above a long sequence of
    // RETURN / DRAW processing rows. The hand has just been authoritatively
    // rebuilt, so trust the CURRENT absolute-bottom viewport as a fresh log
    // baseline instead of searching upward for the pre-M11 checkpoint.
    // This mode is intentionally opt-in and is used only by the full-duel M11
    // resync path; normal observer continuity rules remain unchanged.
    if (REBASELINE_CURRENT_BOTTOM) {
      const startupMalletTail = options.startupMalletTail === true
        ? buildMalletStartupTail(result.events,effectiveBlocks) : null;
      const startupTailOnly = Boolean(startupMalletTail);
      const capturedAt = new Date().toISOString();
      const rebasedCheckpoint = startupTailOnly ? null : checkpointFrom(effectiveBlocks) || null;
      const rebasedState = {
        version: 1,
        capturedAt,
        checkpoint: rebasedCheckpoint,
        tailBlocks: startupTailOnly ? [] : compactTailBlocks(effectiveBlocks, 6),
        ...(startupTailOnly ? {startupTailBoundary:startupMalletTail} : {}),
        rebaselineReason: 'M11_POST_FULL_RESYNC_CURRENT_BOTTOM',
        // When M11's long RETURN/DRAW tail pushes every activation header out
        // of the bottom viewport, checkpointFrom() is legitimately null.  This
        // is still a VERIFIED baseline, not an uninitialized observer state.
        // Preserve an explicit empty-bottom marker so the very next activation
        // is treated as NEW instead of being swallowed as BASELINE_ESTABLISHED.
        ...(rebasedCheckpoint ? {} : { baseline: 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM' })
      };
      writeJsonAtomic(observerStatePath, rebasedState);

      result.observerFieldTransitions = [];
      result.bottomTailContinuity = { matched: true, reason: 'M11_POST_FULL_RESYNC_REBASELINE' };
      result.operationBlocks = startupTailOnly ? [] : effectiveBlocks;
      result.activationBlocks = startupTailOnly ? [] : effectiveBlocks;
      result.orphanProcessingRows = startupTailOnly ? [] : effectiveOrphans;
      result.newActivationBlocks = [];
      result.newOperationBlocks = [];
      result.continuity = 'REBASELINED_AFTER_M11_FULL_RESYNC';
      result.previousCheckpointFound = true;
      result.matchedContinuityAnchor = {
        kind: 'M11_POST_FULL_RESYNC_CURRENT_BOTTOM',
        cardKey: rebasedState.checkpoint && rebasedState.checkpoint.activationKey || null,
        source: 'CURRENT_BOTTOM_REBASELINE',
        matchType: 'TRUST_CURRENT_BOTTOM_AFTER_FULL_HAND_RESYNC'
      };
      result.scrollBacktracking = {
        startedAtBottom: true,
        initialBottomConfirmed: initialBottom.confirmed,
        initialBottomConfirmation: initialBottom.confirmation,
        initialBottomWheelBatchCount: initialBottom.wheelBatchCount,
        initialBottomWheelEvents: initialBottom.wheelEvents,
        performed: false,
        upwardSteps: 0,
        totalUpwardWheelEvents: 0,
        restoredToBottom: true,
        reachedTop: false,
        checkpointSource: 'CURRENT_BOTTOM_REBASELINE',
        viewports: [],
        rejectedViewports: []
      };
      result.windowTitle = info.title;
      result.client = report.client;
      result.logPanelWasOpenedByScript = !panelOpen;
      result.screenshot = screenshotPath;

      const resultPath = path.join(debugDir, 'latest_result.json');
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
      status = 'PASS';
      if(startupTailOnly) console.log('用户确认开局前最后使用万宝槌：只保存最后抽卡结果 '+rebasedState.startupTailBoundary.tokens.join(' | ')+'；不保存或追溯旧发动块。');
      else console.log(
        `万宝槌 FULL RESYNC 后右栏已重建 baseline: ` +
        `当前底部操作=${effectiveBlocks.map(block => block.activationKey).join('>') || '无'}; ` +
        `checkpoint=${rebasedState.checkpoint && rebasedState.checkpoint.activationKey || 'EMPTY'}。`
      );
      if(!startupTailOnly) console.log('不会再向上追万宝槌发动前的旧 checkpoint；下一轮只识别此 baseline 之后的新操作。');
      console.log(`完整识别详情: ${resultPath}`);
      return;
    }

    if (previousObserverState && previousObserverState.materialAdjacentStep) {
      const adjacent = previousObserverState.materialAdjacentStep;
      console.log(
        `素材连续性策略: 仅确认相邻上一步 #${adjacent.step || '?'} ` +
        `${adjacent.stageLabel || ''} checkpoint=${previousObserverState.checkpoint && previousObserverState.checkpoint.activationKey || 'EMPTY_MAIN1'}；` +
        `不会再把素材第一步之前的历史当作确认前驱。`
      );
    }
    let observer = reconcileActivationBlocks(
      previousObserverState,
      effectiveBlocks,
      new Date().toISOString(),
      effectiveOrphans
    );
    const viewportCaptures = [{
      step: 0,
      direction: 'BOTTOM_INITIAL',
      screenshot: screenshotPath,
      image: screenshot,
      grouped
    }];
    // Some live log scroll steps can jump far enough that an intermediate
    // viewport has no full activation block in common with the current
    // stitched chain (for example: upper viewport only M16, bottom viewport
    // already starts at M17/M06). Do not abort immediately. Keep the image as
    // debug evidence, continue scrolling upward, and accept the first older
    // viewport that can bridge directly into the already trusted chain.
    const rejectedViewportCaptures = [];
    let previousPhysicalScrollImage = screenshot;
    let observerFastRecoveredFromBottom = false;
    const observerFieldTransitions = [];
    if(previousObserverState && previousObserverState.startupTailBoundary) {
      const tail=matchStartupTail(previousObserverState.startupTailBoundary,result.events,effectiveBlocks);
      observerFastRecoveredFromBottom=true;
      effectiveBlocks=tail.newBlocks; effectiveOrphans=[];
      observer={continuity:"CONTINUOUS_FROM_STARTUP_RESULT_TAIL",checkpointFound:true,
        matchedAnchor:{kind:"STARTUP_RESULT_TAIL",source:"VISIBLE_OPERATION_BLOCK",matchType:"EXACT_TERMINAL_ROW",tokens:tail.tokens},
        newBlocks:tail.newBlocks,state:{version:1,capturedAt:new Date().toISOString(),checkpoint:checkpointFrom(tail.newBlocks)}};
      console.log("新测试末尾衔接已确认：只处理新增操作 "+tail.newBlocks.map(b=>b.activationKey).join(">")+"；不回溯旧发动块。");
    }

    // M18 full-resolution is a deliberately staged observer state. The
    // previous round already proved the M18 activation and intentionally did
    // not touch INFO/hand UI while the Extra Deck / Garura prompt was unsafe.
    // Therefore, once the caller explicitly says we are completing that known
    // pending state, a visible E01 block with exactly one self hand-gain is the
    // forward continuation we need. Do not scroll upward just to rediscover
    // M18's predecessor; that historical proof is already stored in the duel
    // session and the current E01 draw closes the staged transition.
    if (KNOWN_PENDING_NADIR_FULL_RESOLUTION && previousObserverState &&
        previousObserverState.checkpoint && previousObserverState.checkpoint.activationKey === 'M18') {
      const garuraIndex = effectiveBlocks.findIndex(block => {
        if (!block || block.activationKey !== 'E01') return false;
        const gains = (block.details || []).filter(detail =>
          detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
        );
        return gains.length === 1;
      });
      if (garuraIndex >= 0) {
        observerFastRecoveredFromBottom = true;
        observer = {
          continuity: 'CONTINUOUS_M18_PENDING_TO_GARURA_DRAW',
          checkpointFound: true,
          matchedAnchor: {
            kind: 'M18_PENDING_TO_E01',
            cardKey: 'M18',
            source: 'KNOWN_PENDING_SESSION_STATE',
            matchType: 'M18_PENDING_PLUS_E01_HAND_GAIN'
          },
          newBlocks: effectiveBlocks.slice(garuraIndex),
          state: {
            version: 1,
            capturedAt: new Date().toISOString(),
            checkpoint: checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint
          }
        };
        console.log('M18待结算连续性已确认: 已知pending M18 + 当前E01抽1；无需上滑追M18前驱。');
      }
    }

    // Primary continuity path: compare the persisted structured tail from the
    // previous run with the CURRENT bottom viewport. This is much stronger and
    // cheaper than searching upward for one exact historical checkpoint. It
    // also naturally handles a saved block that grows in place, such as
    // M22 -> TOKEN later acquiring LINK_SUMMON:E02.
    const bottomTailMatch = previousObserverState && Array.isArray(previousObserverState.tailBlocks)
      ? findCrossRunTailContinuity(previousObserverState.tailBlocks, effectiveBlocks)
      : { matched: false, reason: 'NO_SAVED_TAIL' };
    if (bottomTailMatch.matched) {
      observerFastRecoveredFromBottom = true;
      const newBlocks = effectiveBlocks.slice(bottomTailMatch.newBlockStart);
      // A saved top-level operation block may grow in place between observer
      // passes (for example M22 -> TOKEN later gains LINK_SUMMON:E02).  This is
      // intentionally NOT a newOperationBlock: V1's activation semantics stay
      // sealed.  Expose the grown blocks separately so upper semantic
      // observers can consume the newly-visible field transition without
      // making hand reconciliation treat the old activation as new.
      const extendedBlocks = [];
      for (let offset = 0; offset < Number(bottomTailMatch.overlapLength || 0); offset++) {
        if ((bottomTailMatch.matchKinds || [])[offset] !== 'MONOTONIC_DETAIL_EXTENSION') continue;
        const block = effectiveBlocks[offset];
        if (block) extendedBlocks.push(block);
      }
      observer = {
        continuity: newBlocks.length ? 'CONTINUOUS_VIA_BOTTOM_TAIL_NEW_BLOCKS' : 'CONTINUOUS_VIA_BOTTOM_TAIL_NO_NEW_BLOCK',
        checkpointFound: true,
        matchedAnchor: {
          kind: 'CROSS_RUN_TAIL_OVERLAP',
          cardKey: bottomTailMatch.matchedKeys[bottomTailMatch.matchedKeys.length - 1] || null,
          source: 'VISIBLE_OPERATION_BLOCK',
          matchType: 'CROSS_RUN_TAIL_OVERLAP',
          overlapLength: bottomTailMatch.overlapLength,
          matchKinds: bottomTailMatch.matchKinds
        },
        newBlocks,
        extendedBlocks,
        state: {
          version: 1,
          capturedAt: new Date().toISOString(),
          checkpoint: checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint
        }
      };
      console.log(
        `底部尾部连续性已确认: overlap=${bottomTailMatch.matchedKeys.join('>') || '无'}; ` +
        `匹配=${bottomTailMatch.matchKinds.join('+')}; 无需上滑。`
      );
    }

    // Compatibility path for states created before tailBlocks existed, and for
    // the rare case where the saved tail has completely scrolled out. These
    // are strong semantic proofs and are safe for material capture too, so do
    // not restrict them to --observer-fast.
    if (!observerFastRecoveredFromBottom && previousObserverState && previousObserverState.checkpoint &&
        (!observer.checkpointFound || !observer.matchedAnchor ||
          observer.matchedAnchor.source !== 'VISIBLE_OPERATION_BLOCK')) {
      // The normal strict matcher deliberately rejects an old block when its
      // saved signature later grows extra compact-log rows. For a continuous
      // duel observer we should first prove the previous endpoint from the
      // CURRENT bottom viewport itself before scrolling anywhere. A saved
      // evidence subset + the saved predecessor is strong enough and still
      // rejects the dangerous M06>M19 grave-follow-up case because that newer
      // M19 block does not contain the old TARGET:M06 evidence.
      const bottomMatch = findVisibleCheckpointByEvidenceSubset(
        effectiveBlocks,
        previousObserverState.checkpoint
      );
      if (bottomMatch) {
        observerFastRecoveredFromBottom = true;
        const matchedBlock = effectiveBlocks[bottomMatch.index];
        const transition = hornetLinkTransition(matchedBlock, previousObserverState.checkpoint);
        if (transition && OBSERVER_FAST) observerFieldTransitions.push(transition);
        const newBlocks = effectiveBlocks.slice(bottomMatch.index + 1);
        observer = {
          continuity: newBlocks.length ? 'CONTINUOUS_NEW_BLOCKS' : 'CONTINUOUS_NO_NEW_BLOCK',
          checkpointFound: true,
          matchedAnchor: {
            kind: 'SELF_ACTIVATION',
            cardKey: previousObserverState.checkpoint.activationKey,
            source: 'VISIBLE_OPERATION_BLOCK',
            matchType: bottomMatch.matchType,
            contextMatched: Boolean(previousObserverState.checkpoint.previousActivationKey),
            evidenceKeys: bottomMatch.evidenceKeys
          },
          newBlocks,
          state: {
            version: 1,
            capturedAt: new Date().toISOString(),
            checkpoint: transition
              ? (checkpointFrom([matchedBlock]) || previousObserverState.checkpoint)
              : (checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint)
          }
        };
        console.log(
          `观察器底部已确认上一步结尾: ${previousObserverState.checkpoint.activationKey}` +
          `（${bottomMatch.matchType}; 证据=${bottomMatch.evidenceKeys.join(',') || '无'}）；无需上滑。`
        );
      }
      if (!bottomMatch) {
        // M22 is a staged checkpoint. The previous run ends immediately after
        // M22 -> TOKEN. On the next run, Master Duel may compact the same M22
        // history block so that SPECIAL_SUMMON:TOKEN is clipped above the
        // current viewport while LINK_SUMMON:E02/E10 remains visible.
        // The saved checkpoint already proves the TOKEN stage, so a first
        // visible M22 Link block is enough to confirm continuity without
        // scrolling upward to re-find the old TOKEN row or predecessor.
        const hornetContinuation = findHornetLinkContinuationAtTop(
          effectiveBlocks,
          previousObserverState.checkpoint
        );
        if (hornetContinuation) {
          observerFastRecoveredFromBottom = true;
          const newBlocks = effectiveBlocks.slice(hornetContinuation.index + 1);
          observer = {
            continuity: newBlocks.length
              ? 'CONTINUOUS_HORNET_LINK_CONTINUATION_NEW_BLOCKS'
              : 'CONTINUOUS_HORNET_LINK_CONTINUATION_ONLY',
            checkpointFound: true,
            matchedAnchor: {
              kind: 'HORNET_LINK_CONTINUATION',
              cardKey: hornetContinuation.cardKey,
              source: 'VISIBLE_OPERATION_BLOCK',
              matchType: hornetContinuation.matchType,
              linkTarget: hornetContinuation.linkTarget
            },
            newBlocks,
            state: {
              version: 1,
              capturedAt: new Date().toISOString(),
              checkpoint: checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint
            }
          };
          console.log(
            `底部已通过黄蜂阶段衔接确认上一步 M22→TOKEN：` +
            `当前 M22 已继续 Link ${hornetContinuation.linkTarget}` +
            `${hornetContinuation.tokenStillVisible ? '' : '（旧 TOKEN 行已被压出当前视口）'}；无需上滑。`
          );
        }
      }
      if (!bottomMatch && !observerFastRecoveredFromBottom) {
        // Compatibility path for the older E02-specific staged model.
        const extensionAtTop = findVisibleCheckpointExtensionAtTop(
          effectiveBlocks,
          previousObserverState.checkpoint
        );
        if (extensionAtTop) {
          observerFastRecoveredFromBottom = true;
          if (OBSERVER_FAST) observerFieldTransitions.push(extensionAtTop.transition);
          const newBlocks = effectiveBlocks.slice(extensionAtTop.index + 1);
          observer = {
            continuity: newBlocks.length ? 'CONTINUOUS_CHECKPOINT_EXTENSION_NEW_BLOCKS' : 'CONTINUOUS_CHECKPOINT_EXTENSION_ONLY',
            checkpointFound: true,
            matchedAnchor: {
              kind: 'CHECKPOINT_EXTENSION',
              cardKey: extensionAtTop.cardKey,
              source: 'VISIBLE_OPERATION_BLOCK',
              matchType: extensionAtTop.matchType
            },
            newBlocks,
            state: {
              version: 1,
              capturedAt: new Date().toISOString(),
              checkpoint: checkpointFrom([effectiveBlocks[extensionAtTop.index]]) || previousObserverState.checkpoint
            }
          };
          console.log(
            `观察器底部已确认旧 M22 块发生场面扩展（${extensionAtTop.matchType}）：` +
            `衍生物已 Link 火刀；无需上滑。`
          );
        }
      }
      if (!bottomMatch && !observerFastRecoveredFromBottom) {
        // The saved endpoint itself can already be above the current bottom
        // viewport. In a step-by-step observer, the first visible new
        // activation can still prove continuity when it is a card that the
        // saved checkpoint just added to our hand. Example: Engage added M22,
        // then the next manual action is M22 -> token -> Kagari. An older M22
        // activation cannot appear below a later, now-clipped Engage block, so
        // the chronological bottom ordering makes this a safe forward handoff.
        const forwardHandoff = findForwardCheckpointGainHandoff(
          effectiveBlocks,
          previousObserverState.checkpoint
        );
        if (forwardHandoff) {
          observerFastRecoveredFromBottom = true;
          observer = {
            continuity: 'CONTINUOUS_VIA_CHECKPOINT_GAIN_HANDOFF_NEW_BLOCKS',
            checkpointFound: true,
            matchedAnchor: {
              kind: 'CHECKPOINT_GAIN_TO_NEW_ACTIVATION',
              cardKey: forwardHandoff.cardKey,
              source: 'VISIBLE_FORWARD_HANDOFF',
              matchType: forwardHandoff.matchType,
              fromCheckpoint: previousObserverState.checkpoint.activationKey
            },
            // The first visible activation is AFTER the saved checkpoint, so
            // unlike an ordinary checkpoint match it must itself be retained.
            newBlocks: effectiveBlocks,
            state: {
              version: 1,
              capturedAt: new Date().toISOString(),
              checkpoint: checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint
            }
          };
          console.log(
            `观察器底部已通过上一步入手牌衔接: ` +
            `${previousObserverState.checkpoint.activationKey} -> ${forwardHandoff.cardKey}` +
            `（${forwardHandoff.matchType}）；当前底部全部视为新操作，无需上滑。`
          );
        }
      }
    }

    // A verified executor receipt plus a physical append boundary disambiguates
    // identical prior blocks. Generic history matching stays strict.
    if (!observerFastRecoveredFromBottom && !ALLOW_BACKTRACK && options.atomicLogTransaction) {
      const transaction = reconcileTransactionBottom(previousObserverState, effectiveBlocks,
        options.atomicLogTransaction, detectLogScrollbarThumb(screenshot));
      if (transaction) {
        observerFastRecoveredFromBottom = true;
        observer = transaction;
        console.log('底部执行事务已确认：本次操作凭独立执行凭证及日志追加证据定位，不以同名日志内容充当事务身份。');
      }
    }

    // ISSUE-078: bottom-only validation must not demand that the preceding
    // checkpoint remain visible after a completed atom has appended enough
    // rows to push it out. The formal executor supplies the exact activation
    // it just performed; accept only one unique matching bottom block and keep
    // that block as NEW. An absent, mismatched, or duplicate key still fails
    // closed and never enables historical scrolling.
    if (!observerFastRecoveredFromBottom && !ALLOW_BACKTRACK && EXPECTED_ATOMIC_ACTIVATION_KEY) {
      const atomicBoundary = reconcileExpectedAtomicBottom(
        previousObserverState,
        effectiveBlocks,
        EXPECTED_ATOMIC_ACTIVATION_KEY
      );
      if (atomicBoundary) {
        observerFastRecoveredFromBottom = true;
        observer = atomicBoundary;
        console.log(
          `底部原子边界已确认: expected=${EXPECTED_ATOMIC_ACTIVATION_KEY}; ` +
          '唯一当前激活块即本次新事务起点；不要求旧 checkpoint 可见，不向上滚动。'
        );
      }
    }
    const requiresVisibleCheckpoint = () => Boolean(
      !observerFastRecoveredFromBottom &&
      previousObserverState && previousObserverState.checkpoint &&
      (!observer.checkpointFound || !observer.matchedAnchor ||
        observer.matchedAnchor.source !== 'VISIBLE_OPERATION_BLOCK')
    );
    if (requiresVisibleCheckpoint() && !ALLOW_BACKTRACK) {
      const expectedCheckpoint = previousObserverState && previousObserverState.checkpoint
        ? previousObserverState.checkpoint.activationKey
        : 'EMPTY_MAIN1';
      const visibleKeys = effectiveBlocks.map(block => block.activationKey).join('>') || '无';
      console.log(
        `底部连续性未证明: expected=${expectedCheckpoint}; visible=${visibleKeys}; ` +
        '本调用为BOTTOM_ONLY，禁止向上滚轮追旧历史。'
      );
      throw new Error(
        `DUEL_LOG_BOTTOM_ONLY_CHECKPOINT_NOT_PROVEN:expected=${expectedCheckpoint};visible=${visibleKeys}`
      );
    }

    // Keep checkpoint backtracking deliberately fine-grained. A batch of ten
    // wheel events can jump over the one operation that bridges the current
    // bottom viewport to the saved checkpoint (for example M17/M06 -> M16),
    // leaving two otherwise valid screenshots with no shared activation block.
    // Three real wheel events per step gives the stitcher overlapping views and
    // also avoids scrolling much farther upward than needed.
    const scrollEventDelta = 120;
    const scrollEventsPerStep = 3;
    const maxScrollSteps = 8;
    let scrollSteps = 0;
    let reachedTop = false;
    if (requiresVisibleCheckpoint()) {
      try {
        for (let step = 1; step <= maxScrollSteps && requiresVisibleCheckpoint(); step++) {
          // One guarded bridge transaction now performs move + 3 fine-grained
          // wheel events + render settle + capture. This preserves viewport
          // overlap while eliminating several repeated Get-MasterDuelInfo calls.
          const scrolledImage = await timer.time('scroll_up_burst_capture', () =>
            wheelBurstCaptureFull(
              { x: 2010, y: 600 },
              scrollEventDelta,
              scrollEventsPerStep,
              2,
              100,
              `SCROLL_UP_${step}`
            )
          );
          scrollSteps++;
          const previousUpperImage = previousPhysicalScrollImage;
          const difference = sampledImageDifference(previousUpperImage, scrolledImage);
          previousPhysicalScrollImage = scrolledImage;
          const scrolledPath = keepDebugScreenshots
            ? path.join(debugDir, `scroll_up_${String(step).padStart(2, '0')}.png`)
            : null;
          if (scrolledPath) await timer.time('save_scroll_debug', () => savePng(scrolledImage, scrolledPath));
          if (difference < 0.0015) {
            reachedTop = true;
            break;
          }
          const scrolledRecognition = recognizeScreenshot(scrolledImage);
          const scrolledGrouped = buildActivationBlocks(scrolledRecognition.events);
          const checkpointProbe = findCheckpointMatch(
            scrolledGrouped.blocks,
            previousObserverState.checkpoint
          );
          const scrolledThumb = detectLogScrollbarThumb(scrolledImage);
          console.log(
            `向上检查 ${step}: 操作=${scrolledGrouped.blocks.map(block => block.activationKey).join('>') || '无'}; ` +
            `滚动条=${scrolledThumb ? `${scrolledThumb.top}-${scrolledThumb.bottom}` : '未识别'}; ` +
            `画面变化=${difference.toFixed(4)}; ` +
            `上次事件结尾=${checkpointProbe.index >= 0
              ? `已确认(${checkpointProbe.matchType})`
              : `未确认(${checkpointProbe.reason})`}`
          );
          const candidateViewport = {
            step,
            direction: 'UP',
            screenshot: scrolledPath,
            image: scrolledImage,
            recognized: scrolledRecognition,
            grouped: scrolledGrouped,
            checkpointProbe,
            differenceFromNewerViewport: difference
          };
          const candidateCaptures = [candidateViewport, ...viewportCaptures];
          const stitched = stitchChronologicalViewports(
            candidateCaptures.map(viewport => viewport.grouped.blocks)
          );
          if (!stitched.success) {
            rejectedViewportCaptures.push({
              ...candidateViewport,
              stitchReason: stitched.reason
            });
            console.log(
              `向上检查 ${step}: 当前视口与已接受日志链暂无可靠操作重叠` +
              `（${stitched.reason}），保留截图并继续向上寻找桥接视口。`
            );
            continue;
          }
          viewportCaptures.unshift(candidateViewport);
          effectiveBlocks = annotateBlockRelationships(
            normalizeInterposedKagariBambooResults(stitched.blocks)
          );
          effectiveOrphans = mergeOrphanDetails(
            viewportCaptures.map(viewport => viewport.grouped.orphanDetails)
          );
          const stitchedTailMatch = previousObserverState && Array.isArray(previousObserverState.tailBlocks)
            ? findCrossRunTailContinuity(previousObserverState.tailBlocks, effectiveBlocks)
            : { matched: false, reason: 'NO_SAVED_TAIL' };
          if (stitchedTailMatch.matched) {
            const newBlocks = effectiveBlocks.slice(stitchedTailMatch.newBlockStart);
            observer = {
              continuity: newBlocks.length ? 'CONTINUOUS_VIA_STITCHED_TAIL_NEW_BLOCKS' : 'CONTINUOUS_VIA_STITCHED_TAIL_NO_NEW_BLOCK',
              checkpointFound: true,
              matchedAnchor: {
                kind: 'CROSS_RUN_TAIL_OVERLAP',
                cardKey: stitchedTailMatch.matchedKeys[stitchedTailMatch.matchedKeys.length - 1] || null,
                source: 'VISIBLE_OPERATION_BLOCK',
                matchType: 'CROSS_RUN_STITCHED_TAIL_OVERLAP',
                overlapLength: stitchedTailMatch.overlapLength,
                matchKinds: stitchedTailMatch.matchKinds
              },
              newBlocks,
              state: {
                version: 1,
                capturedAt: new Date().toISOString(),
                checkpoint: checkpointFrom(effectiveBlocks) || previousObserverState.checkpoint
              }
            };
            console.log(
              `拼接视口已通过跨轮尾部重叠确认上一步: ` +
              `${stitchedTailMatch.matchedKeys.join('>') || '无'}；停止继续上滑。`
            );
          } else {
            observer = reconcileActivationBlocks(
              previousObserverState,
              effectiveBlocks,
              new Date().toISOString(),
              effectiveOrphans
            );
          }
          if (checkpointProbe.index >= 0 && !observer.checkpointFound) {
            throw new Error('CHECKPOINT_FOUND_IN_VIEWPORT_BUT_LOST_AFTER_STITCH');
          }
          result.scrollViewportOverlaps = stitched.overlaps;
        }
      } finally {
        const knownExodiaIds = buildExodiaComponentSet();
        const autoDeferBottomToHandClick = Boolean(
          OBSERVER_FAST &&
          observer &&
          Array.isArray(observer.newBlocks) &&
          observer.newBlocks.some(block => (block.details || []).some(detail => {
            const card = detail && detail.card;
            const key = String(card && (card.id || card.name) || '');
            return detail && detail.side === 'SELF' &&
              detail.role === 'HAND_GAIN_CANDIDATE' &&
              (!key || key === 'UNKNOWN' || !knownExodiaIds.has(key));
          }))
        );
        if (DEFER_BOTTOM_TO_HAND_CLICK || autoDeferBottomToHandClick) {
          // A real gained card is about to be clicked by the incremental hand
          // stage. Master Duel itself snaps the history panel back to bottom
          // when that hand card is selected, so a separate reverse scroll here
          // is pure duplicate work. Known Exodia-only gains are excluded because
          // their identity can be accepted without a physical hand click.
          result.bottomRestoreDeferredToHandClick = true;
          result.bottomRestoreDeferredAutomatically = autoDeferBottomToHandClick;
          console.log(
            autoDeferBottomToHandClick
              ? '右栏回底自动延后：本轮存在将被点击的新手牌；跳过 AFTER_BACKTRACK 回底，交给紧接着的手牌点击。'
              : '右栏回底已交给紧接着的新增手牌点击，跳过重复滚轮与截图。'
          );
        } else {
          // No guaranteed hand click follows this log pass, so preserve the old
          // invariant and independently restore the panel to absolute bottom.
          const restoredBottom = await timer.time('scroll_restore_bottom', () =>
            forceLogBottom(previousPhysicalScrollImage, 'AFTER_BACKTRACK')
          );
          if (keepDebugScreenshots) {
            await timer.time('save_restored_bottom_debug', () =>
              savePng(restoredBottom.image, path.join(debugDir, 'restored_bottom.png'))
            );
          }
          result.restoredBottom = {
            confirmed: restoredBottom.confirmed,
            confirmation: restoredBottom.confirmation,
            wheelBatchCount: restoredBottom.wheelBatchCount,
            wheelEvents: restoredBottom.wheelEvents,
            thumb: restoredBottom.thumb
          };
        }
      }
      if (requiresVisibleCheckpoint()) {
        throw new Error(
          `DUEL_LOG_PREVIOUS_CHECKPOINT_NOT_FOUND_AFTER_SCROLL:steps=${scrollSteps};reachedTop=${reachedTop}`
        );
      }
    }
    result.observerFieldTransitions = observerFieldTransitions;
    result.bottomTailContinuity = bottomTailMatch;
    result.operationBlocks = effectiveBlocks;
    result.activationBlocks = effectiveBlocks;
    result.orphanProcessingRows = effectiveOrphans;
    result.scrollBacktracking = {
      startedAtBottom: true,
      initialBottomConfirmed: initialBottom.confirmed,
      initialBottomConfirmation: initialBottom.confirmation,
      initialBottomWheelBatchCount: initialBottom.wheelBatchCount,
      initialBottomWheelEvents: initialBottom.wheelEvents,
      performed: scrollSteps > 0,
      upwardSteps: scrollSteps,
      wheelEventsPerStep: scrollEventsPerStep,
      totalUpwardWheelEvents: scrollSteps * scrollEventsPerStep,
      totalRestoreWheelEvents: 0,
      restoredToBottom: Boolean(result.restoredBottom && result.restoredBottom.confirmed),
      restoreDeferredToHandClick: Boolean(result.bottomRestoreDeferredToHandClick),
      reachedTop,
      checkpointSource: observer.matchedAnchor && observer.matchedAnchor.source || null,
      viewports: viewportCaptures.map(viewport => ({
        step: viewport.step,
        direction: viewport.direction,
        screenshot: viewport.screenshot,
        operationKeys: viewport.grouped.blocks.map(block => block.activationKey),
        differenceFromNewerViewport: viewport.differenceFromNewerViewport,
        checkpointProbe: viewport.checkpointProbe || null
      })),
      rejectedViewports: rejectedViewportCaptures.map(viewport => ({
        step: viewport.step,
        direction: viewport.direction,
        screenshot: viewport.screenshot,
        operationKeys: viewport.grouped.blocks.map(block => block.activationKey),
        differenceFromNewerViewport: viewport.differenceFromNewerViewport,
        checkpointProbe: viewport.checkpointProbe || null,
        stitchReason: viewport.stitchReason
      }))
    };
    result.continuity = observer.continuity;
    result.previousCheckpointFound = observer.checkpointFound;
    result.matchedContinuityAnchor = observer.matchedAnchor;
    result.newActivationBlocks = observer.newBlocks;
    result.newOperationBlocks = observer.newBlocks;
    result.extendedOperationBlocks = Array.isArray(observer.extendedBlocks) ? observer.extendedBlocks : [];
    observer.state = {
      ...(observer.state || {}),
      tailBlocks: compactTailBlocks(effectiveBlocks, 6)
    };
    writeJsonAtomic(observerStatePath, observer.state);
    result.windowTitle = info.title;
    result.client = report.client;
    result.logPanelWasOpenedByScript = !panelOpen;
    result.logPanelDetection = panelState;
    result.screenshot = screenshotPath;

    const resultPath = path.join(debugDir, 'latest_result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    status = 'PASS';
    if (VERBOSE) console.log(JSON.stringify(result, null, 2));
    else printConciseResult(result, resultPath);
  } finally {
    if (ownsBridge) await timer.time('bridge_stop', () => bridge.stop());
    timer.finish({ status });
    console.log(`TIMING ${timer.summary()}`);
  }
}

if (require.main === module) {
  runDuelLogLive().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { runDuelLogLive, recognizeDuelLogScreenshot, RIGHT_LOG_PANEL, detectLogScrollbarThumb };
