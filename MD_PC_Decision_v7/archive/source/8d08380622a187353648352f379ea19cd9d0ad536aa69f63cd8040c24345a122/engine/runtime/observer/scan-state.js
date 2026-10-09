const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const config = require('../../live-config');
const {
  MdFastBridge,
  sleep,
  captureReferenceRoi,
  blueScoreFromRoi,
  clientReport,
  mapReferencePoint
} = require('../../lib/win-fast');
const {
  loadLibrary,
  loadTemplates,
  rankQuery,
  classify
} = require('../../lib/recognizer');
const {
  getHandLayout,
  resolveExposedFanSlots,
  detectHandCountFromImage,
  yellowUsableStats,
  isSpellCardId
} = require('../../lib/hand-state');
const {
  collectActions,
  printDecision
} = require('../../lib/decision-engine');
// Runtime state is not an import-time configuration/cache. Read only when needed.
function loadRuntimeDecisionState() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../decision-state.json'), 'utf8'));
}
const { loadInfoDigitTemplates } = require('../../lib/hand-info-overlay');
const { normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const { resolveMeasuredHandTarget } = require('../../lib/live-hand-geometry');
const { runAutoHold } = require('./test-hand-info-live');
const { PNG } = require('pngjs');

function printTop3(ranked) {
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const c = ranked[i];
    console.log(`    Top${i + 1}: ${c.name}  MAD=${c.mad.toFixed(4)}  RMSE=${c.rmse.toFixed(4)}  dHash=${c.dhash}`);
  }
}

function saveRgbaPng(image, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

async function recognizeCurrentCard(bridge, info, library, templates, options = {}) {
  const start = performance.now();
  let attempts = 0;
  let last = null;
  let stableAcceptedId = null;
  let stableAcceptedCount = 0;
  const stableAcceptedSamples = Math.max(1, Number(options.stableAcceptedSamples || 1));

  while (performance.now() - start <= config.panelMaxWaitMs) {
    attempts++;

    const captureStart = performance.now();
    const query = await captureReferenceRoi(bridge, info, library.template_roi);
    const captureMs = performance.now() - captureStart;

    const matchStart = performance.now();
    const ranked = rankQuery(query, templates);
    const judged = classify(ranked, config.recognize);
    const matchMs = performance.now() - matchStart;

    last = {
      query,
      ranked,
      judged,
      attempts,
      captureMs,
      matchMs,
      totalMs: performance.now() - start
    };

    if (judged.accepted) {
      const acceptedId = judged.best && judged.best.id || null;
      if (acceptedId && acceptedId === stableAcceptedId) stableAcceptedCount += 1;
      else {
        stableAcceptedId = acceptedId;
        stableAcceptedCount = 1;
      }
      if (stableAcceptedCount >= stableAcceptedSamples) return last;
    } else {
      stableAcceptedId = null;
      stableAcceptedCount = 0;
    }
    await sleep(config.panelPollIntervalMs);
  }

  return last;
}

function normalizeScanOptions(previousCountOrOptions) {
  if (previousCountOrOptions && typeof previousCountOrOptions === 'object') {
    return {
      previousCount: null,
      authoritativeCount: null,
      debugDir: null,
      failOnUnknown: false,
      saveSlotDebug: false,
      saveSlotScreens: false,
      slotScreenRoi: null,
      saveLayoutOverlay: false,
      openingHandClickReset: false,
      observerFast: false,
      checkUsability: true,
      initialCardSettleMs: config.mouseSettleMs,
      stableAcceptedSamples: 1,
      ...previousCountOrOptions
    };
  }
  return {
    previousCount: previousCountOrOptions,
    authoritativeCount: null,
    debugDir: null,
    failOnUnknown: false,
    saveSlotDebug: false,
    saveSlotScreens: false,
    slotScreenRoi: null,
    saveLayoutOverlay: false,
    openingHandClickReset: false,
    observerFast: false,
    checkUsability: true,
    initialCardSettleMs: config.mouseSettleMs,
    stableAcceptedSamples: 1
  };
}

function recognitionConfidence(judged) {
  if (!judged || !judged.best || !Number.isFinite(judged.best.mad)) return 0;
  return Math.max(0, Math.min(1, 1 - judged.best.mad));
}

function drawMarker(image, centerX, centerY, radius, color) {
  const setPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const i = (y * image.width + x) * 4;
    image.data[i] = color.r;
    image.data[i + 1] = color.g;
    image.data[i + 2] = color.b;
    image.data[i + 3] = 255;
  };
  for (let d = -radius; d <= radius; d++) {
    setPixel(centerX + d, centerY);
    setPixel(centerX, centerY + d);
  }
  for (let degree = 0; degree < 360; degree += 2) {
    const radians = degree * Math.PI / 180;
    setPixel(
      Math.round(centerX + Math.cos(radians) * radius),
      Math.round(centerY + Math.sin(radians) * radius)
    );
  }
}

async function saveLayoutOverlay(bridge, info, slots, outputPath) {
  const image = await captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: config.screen.width,
    height: config.screen.height
  });
  for (const slot of slots) {
    drawMarker(image, slot.x, slot.clickY, 22, { r: 255, g: 60, b: 60 });
  }
  saveRgbaPng(image, outputPath);
}

async function scanOneState(bridge, info, library, templates, previousCountOrOptions = null) {
  const options = normalizeScanOptions(previousCountOrOptions);
  // Only the opening five-card full scan is allowed to click this known-empty
  // central field point. Incremental scans keep using state/empty-slot logic.
  if (options.openingHandClickReset) {
    const resetPoint = mapReferencePoint(info, config.handFan.slotResetMousePoint);
    await bridge.click(resetPoint.x, resetPoint.y);
    await sleep(config.handFan.slotResetClickSettleMs);
  }
  // ESC收起之前被抬高/选中的手牌，让扇形回到统一状态。
  await bridge.key('ESC');
  await sleep(config.handFan.slotResetSettleMs);

  const detectRoi = config.handFan.detectRoi;
  const handImage = await captureReferenceRoi(bridge, info, detectRoi);
  const debugDir = options.debugDir ? path.resolve(options.debugDir) : null;
  const handDetectPath = debugDir
    ? path.join(debugDir, 'hand_detect.png')
    : path.join(__dirname, config.debugHandRoi);
  saveRgbaPng(handImage, handDetectPath);

  const detected = detectHandCountFromImage(handImage, options.previousCount);
  // Reusing a just-read INFO proof saves a second hold, not current-image
  // verification. Use this existing capture, before selecting any hand card.
  if (options.requireCurrentCountMatch === true &&
      (!Number.isInteger(options.authoritativeCount) ||
       detected.componentEstimate?.count !== options.authoritativeCount)) {
    throw new Error(`LIVE_HAND_COUNT_CURRENT_IMAGE_MISMATCH:${options.authoritativeCount}/${detected.componentEstimate?.count ?? 'UNKNOWN'}`);
  }
  if (detected.componentEstimate) {
    console.log(
      `标题块估算手牌数: ${detected.componentEstimate.count} ` +
      `centers=[${detected.componentEstimate.components.map(c => c.centerX + detectRoi.x).join(', ')}]`
    );
  } else {
    console.log('标题块估算手牌数: 未得到可靠结果');
  }

  console.log('\n手牌数量候选：');
  for (const c of detected.candidates) {
    const scores = c.slotScores.map(x => x.toFixed(2)).join(', ');
    console.log(
      `  N=${String(c.count).padStart(2)}  min=${c.min.toFixed(2)}  mean=${c.mean.toFixed(2)}  ` +
      `${c.valid ? 'PASS' : '----'}  slots=[${scores}]`
    );
  }

  const count = Number.isInteger(options.authoritativeCount)
    ? options.authoritativeCount
    : detected.best.count;
  if (Number.isInteger(options.authoritativeCount)) {
    console.log(`\n=> INFO 权威手牌数 = ${count}（扇形视觉候选=${detected.best.count}）`);
  } else {
    console.log(`\n=> 自动判断当前手牌数 = ${count}`);
  }
  if (!detected.best.valid) {
    console.log('   警告：没有候选完全通过阈值，本次使用最高质量候选；请把日志发回来校准。');
  }

  const baseLayout = getHandLayout(count);
  // componentEstimate is measured inside handImage, which itself is cropped
  // from detectRoi. Convert those local x coordinates back to client x before
  // using them for hand clicks. Previously x=274 was used as if it were an
  // absolute point; the actual first seven-card title center is x=594.
  const componentEstimate = detected.componentEstimate && {
    ...detected.componentEstimate,
    components: detected.componentEstimate.components.map(component => ({
      ...component,
      x: component.x + detectRoi.x,
      centerX: component.centerX + detectRoi.x,
      centerY: Number.isFinite(component.centerY) ? component.centerY + detectRoi.y : undefined
    }))
  };
  const exposed = resolveExposedFanSlots(baseLayout, componentEstimate);
  const layout = { ...baseLayout, slots: exposed.slots, slotSource: exposed.source };
  if (layout.status !== 'OK') {
    throw new Error(`手牌布局不可用: count=${count}, mode=${layout.layoutMode}, status=${layout.status}`);
  }

  const positions = layout.slots;
  const cards = [];
  const usedPositions = [];
  console.log(`手牌点击位置来源: ${layout.slotSource}`);

  if (options.saveLayoutOverlay && debugDir) {
    await saveLayoutOverlay(bridge, info, positions, path.join(debugDir, 'layout_overlay.png'));
  }

  for (let i = 0; i < positions.length; i++) {
    const slotStarted = performance.now();
    console.log('\n------------------------------------------------------------');
    console.log(`手牌 ${i + 1}/${count}`);

    // One ESC is not always enough after selecting an outer card or a monster:
    // the first press may only close its action bubbles while the fan remains
    // shifted. Re-press ESC and recapture until all title components return.
    let liveHandImage = null;
    let liveDetected = null;
    let liveEstimate = null;
    let liveExposed = null;
    const resetAttempts = config.handFan.slotResetMaxAttempts || 3;
    const resetMousePoint = mapReferencePoint(info, config.handFan.slotResetMousePoint || { x: 856, y: 195 });
    for (let resetAttempt = 1; resetAttempt <= resetAttempts; resetAttempt++) {
      if (options.openingHandClickReset) {
        await bridge.click(resetMousePoint.x, resetMousePoint.y);
        await sleep(config.handFan.slotResetClickSettleMs);
      } else {
        await bridge.move(resetMousePoint.x, resetMousePoint.y);
      }
      await bridge.key('ESC');
      await sleep(config.handFan.slotResetSettleMs * resetAttempt);
      liveHandImage = await captureReferenceRoi(bridge, info, detectRoi);
      const geometry = resolveMeasuredHandTarget(liveHandImage, count, i + 1, {
        detector: { detectHandCountFromImage, getHandLayout, resolveExposedFanSlots }
      });
      liveDetected = geometry.detected;
      liveEstimate = geometry.estimate;
      liveExposed = geometry.exposed;
      const target = liveExposed.slots[i];
      if (geometry.clickable) break;
      if (resetAttempt < resetAttempts) {
        console.log(
          `手牌目标尚未实测（slot=${i + 1}; 标题=${liveEstimate ? liveEstimate.count : 0}; ` +
          `source=${liveExposed.source}; target2D=${target && target.measuredTitle2D === true}），` +
          `重复 ESC ${resetAttempt + 1}/${resetAttempts}`
        );
      }
    }
    const slot = liveExposed.slots[i];
    const layoutProven = liveExposed.slots.length === count && liveExposed.source !== 'FIXED_FAN_GEOMETRY';
    if (!layoutProven || !slot || slot.measuredTitle2D !== true ||
        !Number.isFinite(slot.x) || !Number.isFinite(slot.titleY)) {
      if (debugDir) {
        saveRgbaPng(liveHandImage, path.join(debugDir, `live_layout_uncertain_slot_${String(i + 1).padStart(2, '0')}.png`));
        fs.writeFileSync(path.join(debugDir, `live_layout_uncertain_slot_${String(i + 1).padStart(2, '0')}.json`),
          JSON.stringify({ count, ordinal: i + 1, source: liveExposed.source,
            componentEstimate: liveEstimate, target: slot, attempts: resetAttempts }, null, 2));
      }
      console.log(`实时标题中心: ${liveEstimate ? liveEstimate.components.map(c => c.centerX).join(', ') : '无'}`);
      const code = layoutProven ? 'HAND_CLICK_TITLE_2D_UNPROVEN' : 'HAND_LIVE_LAYOUT_UNCERTAIN';
      const error = new Error(`${code}:slot=${i + 1};titleComponents=${liveEstimate ? liveEstimate.count : 0}`);
      error.code = code;
      throw error;
    }
    const locateMs = performance.now() - slotStarted;
    usedPositions.push(slot);
    console.log(`实时位置来源: ${liveExposed.source}, x=${slot.x}, titleY=${slot.titleY}`);
    const actual = mapReferencePoint(info, { x: slot.x, y: slot.titleY });
    const clickStarted = performance.now();
    const click = await bridge.click(actual.x, actual.y);
    await sleep(Math.max(0, Number(options.initialCardSettleMs)));
    const clickAndSettleMs = performance.now() - clickStarted;

    const recognizeStarted = performance.now();
    const rec = await recognizeCurrentCard(bridge, info, library, templates, {
      stableAcceptedSamples: options.stableAcceptedSamples
    });
    const recognizeMs = performance.now() - recognizeStarted;
    if (!rec || !rec.judged || !rec.judged.best) {
      const unknown = { index: i + 1, id: 'UNKNOWN', name: 'UNKNOWN', usable: null, confidence: 0 };
      cards.push(unknown);
      console.log('  => UNKNOWN');
      await bridge.key('ESC');
      await sleep(config.handFan.slotResetSettleMs);
      if (options.failOnUnknown) {
        const error = new Error(`HAND_SLOT_RECOGNITION_FAILED: slot=${i + 1}`);
        error.code = 'HAND_SLOT_RECOGNITION_FAILED';
        error.partialState = { count, layoutMode: layout.layoutMode, cards };
        throw error;
      }
      continue;
    }

    if (options.saveSlotDebug && debugDir && rec.query) {
      saveRgbaPng(rec.query, path.join(debugDir, `slot_${String(i + 1).padStart(2, '0')}_card_roi.png`));
    }

    printTop3(rec.ranked);
    const accepted = rec.judged.accepted;
    const best = rec.judged.best;

    let usable = null;
    let yellowStats = null;
    const usabilityStarted = performance.now();

    if (options.checkUsability && accepted && isSpellCardId(best.id)) {
      const u = config.usableMagic;
      const usableRoi = {
        x: Math.round(slot.x + u.roiOffsetX),
        y: Math.round(slot.clickY + u.roiOffsetY),
        width: u.roiWidth,
        height: u.roiHeight
      };

      // ROI如果靠边则轻微裁切到客户区内。
      usableRoi.x = Math.max(0, Math.min(config.screen.width - usableRoi.width, usableRoi.x));
      usableRoi.y = Math.max(0, Math.min(config.screen.height - usableRoi.height, usableRoi.y));

      const usableImage = await captureReferenceRoi(bridge, info, usableRoi);
      if (options.saveSlotDebug && debugDir) {
        saveRgbaPng(usableImage, path.join(debugDir, `slot_${String(i + 1).padStart(2, '0')}_usable_roi.png`));
      }
      yellowStats = yellowUsableStats(usableImage);
      usable = yellowStats.usable;
    }

    if (accepted) {
      console.log(`  => ${best.name} [${best.id}]`);
      if (isSpellCardId(best.id) && options.checkUsability) {
        console.log(
          `     魔法黄框/发动按钮: ${usable ? '可用' : '未确认可用'}  ` +
          `yellowPixels≈${yellowStats.estimatedYellowPixels}, ratio=${yellowStats.yellowRatio.toFixed(4)}`
        );
      } else if (isSpellCardId(best.id)) {
        console.log('     observer-fast: 跳过魔法黄框/发动按钮检查');
      } else {
        console.log('     怪兽卡：本阶段不做“魔法黄框可用性”判断');
      }
    } else {
      console.log(`  => UNKNOWN  Top1=${best.name} MAD=${best.mad.toFixed(4)}`);
    }

    const usabilityMs = performance.now() - usabilityStarted;

    const recognizedCard = normalizeExodiaComponentCard({ id: best.id, name: best.name });
    const cardResult = {
      index: i + 1,
      x: slot.x,
      y: slot.titleY,
      id: accepted ? recognizedCard.id : 'UNKNOWN',
      name: accepted ? recognizedCard.name : 'UNKNOWN',
      ...(accepted && recognizedCard.persistentExodia ? {
        persistentExodia: true,
        candidateIds: recognizedCard.candidateIds
      } : {}),
      accepted,
      confidence: recognitionConfidence(rec.judged),
      mad: best.mad,
      rmse: best.rmse,
      dhash: best.dhash,
      margin: rec.judged.margin,
      usable,
      yellowPixels: yellowStats ? yellowStats.estimatedYellowPixels : null,
      yellowRatio: yellowStats ? yellowStats.yellowRatio : null,
      top3: rec.ranked.slice(0, 3),
      timingMs: {
        locateMs: Number(locateMs.toFixed(3)),
        clickAndSettleMs: Number(clickAndSettleMs.toFixed(3)),
        recognizeMs: Number(recognizeMs.toFixed(3)),
        usabilityMs: Number(usabilityMs.toFixed(3)),
        resetMs: null,
        totalMs: null
      }
    };
    cards.push(cardResult);

    if (options.saveSlotScreens && debugDir) {
      const slotScreenRoi = options.slotScreenRoi || {
        x: 0,
        y: 0,
        width: config.screen.width,
        height: config.screen.height
      };
      const slotScreen = await captureReferenceRoi(bridge, info, slotScreenRoi);
      saveRgbaPng(slotScreen, path.join(debugDir, `slot_${String(i + 1).padStart(2, '0')}_hand.png`));
    }

    // In observer-fast mode the next slot begins with its own guarded reset
    // and fresh title-component capture, so waiting for a second full reset
    // here is redundant. Keep the legacy wait outside observer-fast mode.
    const resetStarted = performance.now();
    await bridge.key('ESC');
    if (!options.observerFast || i + 1 === positions.length) {
      await sleep(config.handFan.slotResetSettleMs);
    }
    const resetMs = performance.now() - resetStarted;
    const totalMs = performance.now() - slotStarted;
    cardResult.timingMs.resetMs = Number(resetMs.toFixed(3));
    cardResult.timingMs.totalMs = Number(totalMs.toFixed(3));

    if (!accepted && options.failOnUnknown) {
      const error = new Error(`HAND_SLOT_RECOGNITION_FAILED: slot=${i + 1}, top1=${best.name}, mad=${best.mad.toFixed(4)}`);
      error.code = 'HAND_SLOT_RECOGNITION_FAILED';
      error.partialState = { count, layoutMode: layout.layoutMode, cards };
      throw error;
    }

    console.log(
      `     点击到完成: ${cardResult.timingMs.totalMs.toFixed(1)} ms` +
      `（定位=${cardResult.timingMs.locateMs.toFixed(1)}, 点击等待=${cardResult.timingMs.clickAndSettleMs.toFixed(1)}, ` +
      `识别=${cardResult.timingMs.recognizeMs.toFixed(1)}, 可用性=${cardResult.timingMs.usabilityMs.toFixed(1)}）`
    );
  }

  return {
    count,
    layoutMode: layout.layoutMode,
    layout: { ...layout, slots: usedPositions, slotSource: 'LIVE_TITLE_COMPONENTS_PER_SLOT' },
    cards,
    detection: detected
  };
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const library = loadLibrary(root);
  const templates = await loadTemplates(root, library);

  console.log('============================================================');
  console.log('Master Duel 动态手牌 + 魔法决策测试 v7');
  console.log('功能：动态手牌数量 -> 卡名 -> 魔法黄框 -> 当前牌组剩余 -> 下一张魔法决策');
  console.log('本测试会逐张选择卡牌做识别，但不会发动/使用任何牌；最后只输出建议动作。');
  console.log('============================================================');

  const bridge = new MdFastBridge();
  const ready = bridge.start();

  for (let s = Math.ceil(config.startupDelayMs / 1000); s >= 1; s--) {
    console.log(`${s} 秒后开始，请切换到 Master Duel...`);
    await sleep(1000);
  }

  await ready;

  try {
    const info = await bridge.info();
    const report = clientReport(info);
    console.log(`\n前台窗口标题: ${info.title}`);
    console.log(`MD客户区: ${JSON.stringify(report.client)}`);
    console.log(`scaleX=${report.scaleX.toFixed(4)}, scaleY=${report.scaleY.toFixed(4)}`);

    if (!report.clientFullyVisible || report.aspectError > 0.03) {
      throw new Error('MD客户区尺寸/可见性异常，为避免误点停止。');
    }

    const turnImage = await captureReferenceRoi(bridge, info, config.ownTurnRoi);
    const turnScore = blueScoreFromRoi(turnImage);
    console.log(`Turn1蓝色检测分数: ${turnScore.toFixed(3)} (阈值 ${config.ownTurnBlueThreshold.toFixed(3)})`);
    if (turnScore < config.ownTurnBlueThreshold) {
      throw new Error('未确认自己的蓝色 Turn1 / Main1，本次不扫描手牌。');
    }

    const infoTemplates = loadInfoDigitTemplates(root);
    const scanDebugDir = path.join(root, 'debug', 'scan-state-live');
    const infoRead = await runAutoHold(bridge, {}, infoTemplates, {
      skipCountdown: true,
      debugDir: path.join(scanDebugDir, 'hand-count')
    });
    const own = infoRead && infoRead.result && infoRead.result.own;
    if (!own || own.status !== 'OK' || !Number.isInteger(own.handCount)) {
      throw new Error('INFO_HAND_COUNT_UNAVAILABLE: scan-state will not choose hand geometry from visual candidates.');
    }
    if (infoRead.result.mouseReleased !== true || infoRead.result.failSafeTriggered === true) {
      throw new Error('INFO_HAND_COUNT_RELEASE_UNSAFE');
    }
    console.log(
      `INFO 权威手牌数: ${own.handCount}（置信度=${Number(own.confidence || 0).toFixed(3)}）`
    );

    const result = await scanOneState(bridge, info, library, templates, {
      previousCount: own.handCount,
      authoritativeCount: own.handCount,
      debugDir: scanDebugDir,
      failOnUnknown: true,
      saveSlotDebug: true,
      saveLayoutOverlay: true,
      openingHandClickReset: own.handCount === 5
    });

    console.log('\n============================================================');
    console.log(`动态手牌状态：${result.count} 张`);
    console.log('============================================================');
    for (const c of result.cards) {
      let flag = '';
      if (c.usable === true) flag = '  [魔法可用]';
      else if (c.usable === false) flag = '  [魔法当前不可用]';
      console.log(`${c.index}. (${c.x},${c.y})  ${c.name} [${c.id}]${flag}`);
    }
    console.log('============================================================');

    const decision = collectActions(result.cards, library, loadRuntimeDecisionState());
    printDecision(decision);

    console.log(`手牌数量调试图: ${path.join(root, config.debugHandRoi)}`);
    console.log(`决策状态文件: ${path.join(root, 'decision-state.json')}`);
  } finally {
    await bridge.stop();
  }
}

module.exports = {
  saveRgbaPng,
  recognizeCurrentCard,
  scanOneState
};

if (require.main === module) {
  main().catch(err => {
    console.error('\n程序异常：');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
