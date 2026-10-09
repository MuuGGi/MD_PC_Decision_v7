const fs = require('fs');
const path = require('path');
const { writeJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { validateMasterDuelClient } = require('../../lib/live-client-guard');
const config = require('../../live-config');
const {
  MdFastBridge,
  captureReferenceRoi,
  blueScoreFromRoi,
  sleep
} = require('../../lib/win-fast');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const {
  INFO_SIDES,
  extractInfoDigitSample,
  loadInfoDigitTemplates,
  readPngSync,
  saveInfoDigitTemplate,
  writePngSync
} = require('../../lib/hand-info-overlay');
const { detectHandCountFromImage, getHandLayout } = require('../../lib/hand-state');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { scanOneState } = require('./scan-state');
const { runFastOwnAutoHold, runAutoHold } = require('./test-hand-info-live');
const { consumeHandCountReadProof } = require('../../lib/hand-count-read-proof');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI_VERBOSE = process.argv.includes('--verbose');

function readExpected(argv) {
  const index = argv.indexOf('--expected');
  const value = index >= 0 ? argv[index + 1] : null;
  if (value === 'auto') return null;
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1 || expected > 8) {
    throw new Error('Use --expected auto or one independent round from 1 through 8.');
  }
  return expected;
}

function learnMissingPreparedDigitTemplate(count, infoDebugDir, roiFile = 'own_roi.png') {
  if (!Number.isInteger(count) || count < 0 || count > 9) return null;
  const templatePath = path.join(ROOT, config.handFan.infoOverlay.templateDir, `hand_count_info_${count}.png`);
  if (fs.existsSync(templatePath)) return null;
  const roiPath = path.join(infoDebugDir, roiFile);
  if (!fs.existsSync(roiPath)) return null;
  const image = readPngSync(roiPath);
  const extracted = extractInfoDigitSample(image, { side: INFO_SIDES.OWN,
    roi: { x: 0, y: 0, width: image.width, height: image.height } });
  if (extracted.status !== 'OK' || !extracted.sample ||
      !extracted.groups || extracted.groups[0].components.length !== 1) {
    return null;
  }
  saveInfoDigitTemplate(extracted.sample, templatePath);
  return templatePath;
}

function toPng(image) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return png;
}

function validateClient(info) {
  return validateMasterDuelClient(info, {
    errorMessage: 'MD client size, aspect ratio, or visibility is invalid.'
  });
}

async function captureErrorState(bridge, info, debugDir) {
  if (!info) return;
  const image = await captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: config.screen.width,
    height: config.screen.height
  });
  writePngSync(toPng(image), path.join(debugDir, 'error_state.png'));
}

async function runLiveScan(options = {}) {
  const argv = process.argv.slice(2);
  let expected = Number.isInteger(options.expected) ? options.expected : readExpected(argv);
  const preparedBaseline = options.preparedBaseline != null
    ? Boolean(options.preparedBaseline)
    : argv.includes('--prepared-baseline');
  const verbose = options.verbose != null ? Boolean(options.verbose) : CLI_VERBOSE;
  const observerFast = options.observerFast != null
    ? Boolean(options.observerFast)
    : argv.includes('--observer-fast');
  const fastOpening = options.fastOpening != null
    ? Boolean(options.fastOpening)
    : argv.includes('--fast-opening');
  const persistObserverBaseline = options.persistObserverBaseline != null
    ? Boolean(options.persistObserverBaseline)
    : true;
  const debugDir = path.join(
    ROOT,
    'debug',
    'scan-state-live',
    preparedBaseline ? 'prepared' : `hand_${expected}`
  );
  const infoDebugDir = path.join(debugDir, 'info');
  const resultPath = path.join(debugDir, 'result.json');
  const library = loadLibrary(ROOT);
  const cardTemplates = await loadTemplates(ROOT, library);
  const digitTemplates = loadInfoDigitTemplates(ROOT);
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  let info = null;

  console.log('============================================================');
  console.log(`Independent live hand scan: expected OWN=${expected}`);
  console.log('The program activates and verifies Master Duel by itself; no manual window switching is needed.');
  console.log(fastOpening && expected === 5
    ? 'Opening fast proof: exact five visible title components skip i; INFO remains the fallback.'
    : 'The program holds i once, releases it, then selects each hand slot only for recognition.');
  console.log('It never clicks an activation button, drags a card, or continues to another hand-count round.');
  console.log('============================================================');

  await bridge.start();
  try {
    const activation = options.skipActivation
      ? { info: await bridge.info() }
      : await activateAndVerifyMasterDuel(bridge);
    info = activation.info;
    validateClient(info);
    console.log(`Master Duel activated and verified: ${info.title}`);
    let preparedCountSource = null;
    let infoOutput = null;
    const countProofReused = options.handCountProof != null;
    if (countProofReused) {
      infoOutput = consumeHandCountReadProof(bridge, options.handCountProof, expected);
      preparedCountSource = 'LIVE_OWN_INFO_REUSED';
      console.log('复用本次已释放鼠标的INFO权威数量；不再第二次按i，扫描现有手牌图仍核对数量。');
    }
    if (!infoOutput && fastOpening && expected === 5 && !preparedBaseline) {
      await bridge.key('ESC');
      await sleep(Math.min(90, config.handFan.slotResetSettleMs));
      const fastImage = await captureReferenceRoi(bridge, info, config.handFan.detectRoi);
      const fastDetected = detectHandCountFromImage(fastImage, 5);
      const componentCount = fastDetected.componentEstimate && fastDetected.componentEstimate.count;
      const expectedCandidate = fastDetected.candidates.find(candidate => candidate.count === 5);
      if (componentCount === 5 && expectedCandidate && expectedCandidate.valid === true) {
        preparedCountSource = 'TITLE_COMPONENTS_FAST_OPENING';
        infoOutput = {
          result: {
            status: 'SKIPPED',
            reason: 'EXPECTED_FIVE_WITH_VALIDATED_TITLE_COMPONENTS',
            own: null,
            mouseReleased: true,
            failSafeTriggered: false,
            holdDurationMs: 0
          }
        };
        console.log('开局快速确认: expected=5 且底部标题组件严格=5；跳过 i 手牌数读取。');
      } else {
        console.log(
          `开局快速确认不足: 标题组件=${componentCount == null ? 'NONE' : componentCount}，` +
          `候选5=${expectedCandidate && expectedCandidate.valid ? 'PASS' : 'FAIL'}；回退 INFO。`
        );
      }
    }
    if (!infoOutput) {
      try {
        infoOutput = await runFastOwnAutoHold(bridge, Number.isInteger(expected) ? { own: expected } : {},
          digitTemplates, { debugDir: infoDebugDir, saveOwnRoi: expected == null && preparedBaseline });
      } catch (error) {
        if (/AUTOTEST_STOP|MOUSE_INTERFERENCE|FOREGROUND_|MASTER_DUEL_WINDOW_CHANGED|WINDOW_NOT_FOUND|CLIENT_UNSAFE|GUARD_/.test(String(error.code || '') + ' ' + error.message)) throw error;
        // Preserve explicit calibration/recovery, but not a second routine
        // hold after a valid proof. The legacy fallback releases before writes.
        infoOutput = await runAutoHold(bridge, Number.isInteger(expected) ? { own: expected } : {},
          digitTemplates, { debugDir: infoDebugDir, skipCountdown: true });
      }
    }
    const ownInfo = infoOutput.result.own;
    if (expected == null) {
      const detectedCount = ownInfo && ownInfo.handCount;
      // Always cross-check prepared-mode i output against the visible hand
      // titles. The overlay can return a syntactically valid but stale value
      // (observed live: i=8 while exactly three titles were present).
      info = await bridge.info();
      validateClient(info);
      await bridge.key('ESC');
      await sleep(config.handFan.slotResetSettleMs);
      const handImage = await captureReferenceRoi(bridge, info, config.handFan.detectRoi);
      const visual = detectHandCountFromImage(handImage, null);
      const componentCount = visual.componentEstimate && visual.componentEstimate.count;
      const matchingCandidate = Number.isInteger(componentCount)
        ? visual.candidates.find((candidate) => candidate.count === componentCount)
        : null;
      const visualCountValid = Number.isInteger(componentCount) && componentCount >= 1 &&
        componentCount <= 8 && matchingCandidate && matchingCandidate.valid === true;
      const infoCountValid = Number.isInteger(detectedCount) && detectedCount >= 1 && detectedCount <= 8;
      if (visualCountValid && (!infoCountValid || componentCount !== detectedCount)) {
        expected = componentCount;
        preparedCountSource = infoCountValid ? 'TITLE_COMPONENTS_CONFLICT' : 'TITLE_COMPONENTS';
        console.log(infoCountValid
          ? `i 手牌数=${detectedCount} 与当前画面冲突；调配模式由底部标题组件确认当前手牌数: ${expected}`
          : `i 手牌数不可用；调配模式由底部标题组件确认当前手牌数: ${expected}`);
        const learnedTemplate = learnMissingPreparedDigitTemplate(expected, infoDebugDir,
          infoOutput.result.fastOwnOnly === true ? 'own_roi_confirmed.png' : 'own_roi.png');
        if (learnedTemplate) {
          console.log(`已从本次真实 i 覆盖层补建数字 ${expected} 模板: ${learnedTemplate}`);
        }
      } else if (infoCountValid) {
        expected = detectedCount;
        preparedCountSource = 'INFO';
        console.log(`调配模式自动读取当前手牌数: ${expected}`);
      } else {
        throw new Error(
          `PREPARED_HAND_COUNT_UNSUPPORTED:${detectedCount}; ` +
          `titleComponents=${componentCount}; titleValid=${Boolean(visualCountValid)}`
        );
      }
    }
    if (!String(preparedCountSource || '').startsWith('TITLE_COMPONENTS') &&
        (!ownInfo || ownInfo.status !== 'OK' || ownInfo.handCount !== expected)) {
      const actual = ownInfo && ownInfo.handCount;
      const error = new Error(`HAND_COUNT_MISMATCH: expected=${expected}, actual=${actual}`);
      error.code = 'HAND_COUNT_MISMATCH';
      throw error;
    }
    if (infoOutput.result.mouseReleased !== true) {
      const error = new Error('MOUSE_RELEASE_NOT_CONFIRMED');
      error.code = 'MOUSE_RELEASE_NOT_CONFIRMED';
      throw error;
    }
    if (
      infoOutput.result.failSafeTriggered === true ||
      infoOutput.result.holdDurationMs > config.handFan.infoOverlay.infoAutoHoldMaxMs
    ) {
      const error = new Error('INFO_AUTO_HOLD_MAX_TIMEOUT');
      error.code = 'INFO_AUTO_HOLD_MAX_TIMEOUT';
      throw error;
    }

    const layout = getHandLayout(expected);
    if (layout.status !== 'OK' || layout.layoutMode !== 'FIXED_FAN' || layout.slots.length !== expected) {
      const error = new Error(`HAND_LAYOUT_INVALID: ${JSON.stringify(layout)}`);
      error.code = 'HAND_LAYOUT_INVALID';
      throw error;
    }

    info = await bridge.info();
    const report = validateClient(info);
    const turnImage = await captureReferenceRoi(bridge, info, config.ownTurnRoi);
    const turnScore = blueScoreFromRoi(turnImage);
    if (turnScore < config.ownTurnBlueThreshold) {
      const error = new Error(`OWN_TURN_NOT_CONFIRMED: score=${turnScore.toFixed(4)}`);
      error.code = 'OWN_TURN_NOT_CONFIRMED';
      throw error;
    }

    if (expected <= 7) {
      const rp = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
      console.log(`低手牌中性复位点: 对手魔法/陷阱区域安全点=(${rp.x},${rp.y}); 仅用于清选择/复位，不替代真实目标点击。`);
    }

    const handState = await scanOneState(bridge, info, library, cardTemplates, {
      previousCount: null,
      authoritativeCount: expected,
      requireCurrentCountMatch: countProofReused,
      debugDir,
      failOnUnknown: true,
      saveSlotDebug: verbose,
      saveSlotScreens: expected !== 5,
      slotScreenRoi: { x: 400, y: 850, width: 1260, height: 302 },
      saveLayoutOverlay: verbose,
      // Reset a raised/selected hand card by clicking the opponent-side
      // spell/trap zone indicated by the live test.  This point is deliberately
      // outside our monster zones, so a prepared baseline with an existing
      // carrier (e.g. Yoto Bamboo) cannot accidentally select our monster.
      // Keep the mature click -> ESC -> recapture behavior for both opening
      // scans and prepared/current-state low-hand scans.
      openingHandClickReset: expected <= 7,
      observerFast,
      checkUsability: !observerFast,
      initialCardSettleMs: observerFast ? 90 : config.mouseSettleMs,
      stableAcceptedSamples: observerFast ? 2 : 1
    });
    if (handState.count !== expected || handState.cards.length !== expected) {
      const error = new Error(`SCAN_SLOT_COUNT_MISMATCH: expected=${expected}, scanned=${handState.cards.length}`);
      error.code = 'SCAN_SLOT_COUNT_MISMATCH';
      error.partialState = handState;
      throw error;
    }

    const result = {
      status: expected === 5 || preparedBaseline ? 'PASS' : 'CAPTURED_FOR_REVIEW',
      expectedOwn: expected,
      windowTitle: info.title,
      client: report.client,
      ownTurnScore: turnScore,
      info: infoOutput.result,
      handCount: handState.count,
      layoutMode: handState.layoutMode,
      slotsScanned: handState.cards.length,
      layoutSlots: handState.layout.slots,
      cards: handState.cards
    };
    writeJson(resultPath, result);
    if ((expected === 5 || preparedBaseline) && persistObserverBaseline) {
      // A verified five-card opening scan is the positional baseline for the
      // current duel. Later transition tests compare the actual bottom-hand
      // sequence against this snapshot; the duel log is only supporting
      // evidence and never supplies click coordinates.
      writeJsonAtomic(path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json'), {
        version: 1,
        capturedAt: new Date().toISOString(),
        revision: 0,
        handCount: result.handCount,
        cards: result.cards,
        handImagePath: path.join(debugDir, 'hand_detect.png'),
        source: resultPath
      }, { trailingNewline: true });
      // A verified opening hand marks a new duel. Establish continuity before
      // the first Main1 operation even if the right panel is still closed.
      writeJsonAtomic(path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json'), {
        version: 1,
        capturedAt: new Date().toISOString(),
        baseline: 'EMPTY_MAIN1',
        checkpoint: null,
        initialHand: result.cards.map(card => card.id)
      }, { trailingNewline: true });
    }
    if (verbose) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${preparedBaseline ? '调配后' : '新开局'}初始扫描成功: 手牌=${result.handCount}`);
      console.log(`初始手牌: ${result.cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`);
      console.log(persistObserverBaseline
        ? '已重建增量手牌基线；接下来将打开右侧信息栏并建立日志检查点。'
        : '本次仅返回初始手牌识别结果；不写 observer 手牌基线或右栏 checkpoint。');
    }
    console.log(`完整详情: ${resultPath}`);
    return result;
  } catch (error) {
    try {
      info = info || await bridge.info();
      await captureErrorState(bridge, info, debugDir);
    } catch (_) {}
    const failure = {
      status: 'FAIL',
      expectedOwn: expected,
      error: error.code || error.message,
      message: error.message,
      partialState: error.partialState || null
    };
    writeJson(resultPath, failure);
    console.error(JSON.stringify(failure, null, 2));
    throw error;
  } finally {
    if (ownsBridge) await bridge.stop();
  }
}

if (require.main === module) {
  runLiveScan().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { readExpected, runLiveScan };
