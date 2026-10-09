'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../live-config');
const { writeJson } = require('../../lib/runtime-files');
const { validateMasterDuelClient } = require('../../lib/live-client-guard');
const { absoluteComponentEstimate } = require('../../lib/live-hand-geometry');
const {
  medianSpacing,
  geometryDelta,
  geometryStable,
  chooseOverlap,
  mergeWindows,
  mergeBoundaryWindows,
  mergeAnchoredThreeWindows,
  compareSweeps
} = require('../../lib/dense-hand-segmenter');
const {
  MdFastBridge,
  captureReferenceRoi,
  mapReferencePoint,
  blueScoreFromRoi,
  sleep
} = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { normalizeExodiaComponentCard, sameRuntimeCardIdentity } = require('../../lib/exodia-policy');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const {
  INFO_SIDES,
  extractInfoDigitSamples,
  loadInfoDigitTemplates,
  readPngSync,
  recognizeInfoHandCount,
  saveInfoDigitTemplate
} = require('../../lib/hand-info-overlay');
const { runFastOwnAutoHold, runAutoHold } = require('./test-hand-info-live');
const { detectHandCountFromImage } = require('../../lib/hand-state');
const { resolveDenseMeasuredWindow } = require('../../lib/dense-hand-geometry');
const { recognizeCurrentCard, saveRgbaPng } = require('./scan-state');
const { planDenseTargetWindows } = require('../../lib/dense-hand-targeting');

const ROOT = path.resolve(__dirname, '..', '..');
const FULL_CLIENT_ROI = { x: 0, y: 0, width: config.screen.width, height: config.screen.height };
const HAND_CAPTURE_ROI = { x: 260, y: 790, width: 1520, height: 362 };

// Dense-hand mode deliberately trusts only the middle of the fan.  The outer
// cards are first dragged into this region before they are clicked.
const SAFE_X_MIN = 640;
const SAFE_X_MAX = 1460;
const SAFE_CLICK_Y = 1006;
const SAFE_MAX_CARDS = 5;
const SAFE_Y_OFFSET = 20;
const SAFE_Y_MIN = 992;
const SAFE_Y_MAX = 1045;
const DRAG_Y = 1032;
const DENSE_WINDOW_STATE_KEY = '__mdDenseHandWindow';

function getKnownDenseWindow(bridge) {
  const value = bridge && bridge[DENSE_WINDOW_STATE_KEY];
  return value === 'LEFT_EDGE' || value === 'RIGHT_EDGE' || value === 'MIDDLE'
    ? value
    : null;
}

function setKnownDenseWindow(bridge, value) {
  if (!bridge) return;
  bridge[DENSE_WINDOW_STATE_KEY] = value || null;
}


function argNumber(name, fallback = null) {
  const args = process.argv.slice(2);
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1));
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}

function timestampId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizedRecognition(result) {
  const best = result && result.judged && result.judged.best;
  return {
    accepted: Boolean(result && result.judged && result.judged.accepted && best),
    id: best ? best.id : 'UNKNOWN',
    name: best ? best.name : 'UNKNOWN',
    mad: best ? best.mad : null,
    rmse: best ? best.rmse : null,
    margin: result && result.judged ? result.judged.margin : null,
    top3: (result && result.ranked || []).slice(0, 3).map(row => ({
      id: row.id,
      name: row.name,
      mad: row.mad,
      rmse: row.rmse,
      dhash: row.dhash
    }))
  };
}

function localRoiForImage(image) {
  return { x: 0, y: 0, width: image.width, height: image.height };
}

function learnMissingTwoDigitTemplates(expectedCount, fallbackDebugDir) {
  if (!Number.isInteger(expectedCount) || expectedCount < 10 || expectedCount > 12) return null;

  const digits = String(expectedCount).split('').map(Number);
  const missingDigits = [...new Set(digits)].filter(digit =>
    !fs.existsSync(path.join(ROOT, config.handFan.infoOverlay.templateDir, `hand_count_info_${digit}.png`))
  );
  if (!missingDigits.length) return null;

  const roiPath = path.join(fallbackDebugDir, 'own_roi.png');
  if (!fs.existsSync(roiPath)) return null;
  const image = readPngSync(roiPath);
  const extracted = extractInfoDigitSamples(
    image,
    { side: INFO_SIDES.OWN, roi: localRoiForImage(image) },
    2
  );
  if (extracted.status !== 'OK' || !Array.isArray(extracted.samples) || extracted.samples.length !== 2) {
    return null;
  }

  const created = [];
  try {
    for (let index = 0; index < digits.length; index++) {
      const digit = digits[index];
      const templatePath = path.join(
        ROOT,
        config.handFan.infoOverlay.templateDir,
        `hand_count_info_${digit}.png`
      );
      if (fs.existsSync(templatePath)) continue;
      saveInfoDigitTemplate(extracted.samples[index], templatePath);
      created.push(templatePath);
    }

    const refreshedTemplates = loadInfoDigitTemplates(ROOT);
    const verified = recognizeInfoHandCount(image, {
      side: INFO_SIDES.OWN,
      roi: localRoiForImage(image),
      templates: refreshedTemplates
    });
    if (verified.status !== 'OK' || verified.handCount !== expectedCount) {
      throw new Error(
        `AUTO_INFO_TEMPLATE_VERIFY_FAILED:status=${verified.status};` +
        `recognized=${verified.handCount};expected=${expectedCount}`
      );
    }

    return { created, templates: refreshedTemplates, verified };
  } catch (error) {
    for (const filePath of created) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    return { error };
  }
}

async function readOwnHandCount(bridge, digitTemplates, captureDir, expectedCount = null, options = {}) {
  const expected = Number.isInteger(expectedCount) ? { own: expectedCount } : {};
  const finish = result => options.returnEvidence === true
    ? require('../../lib/hand-count-read-proof').issueHandCountReadProof(
      bridge, result, config.handFan.infoOverlay.infoAutoHoldMaxMs)
    : result.own.handCount;
  try {
    const out = await runFastOwnAutoHold(bridge, expected, digitTemplates, {
      debugDir: path.join(captureDir, 'info_fast')
    });
    const own = out && out.result && out.result.own;
    if (own && own.status === 'OK' && Number.isInteger(own.handCount) &&
        (!Number.isInteger(expectedCount) || own.handCount === expectedCount)) {
      return finish(out.result);
    }
  } catch (error) {
    console.log(`FAST OWN INFO 失败(${error.code || error.message})，回退完整 INFO。`);
  }

  const fallbackDebugDir = path.join(captureDir, 'info_fallback');
  const out = await runAutoHold(bridge, expected, digitTemplates, {
    debugDir: fallbackDebugDir,
    skipCountdown: true
  });
  const own = out && out.result && out.result.own;
  if (own && own.status === 'OK' && Number.isInteger(own.handCount) &&
      (!Number.isInteger(expectedCount) || own.handCount === expectedCount)) {
    return finish(out.result);
  }

  // The historical INFO template set was built from 2~9, so the first real
  // two-digit test can legitimately lack digit 1/0.  During this explicit
  // calibration test --count is authoritative, allowing us to learn only the
  // missing glyph templates from the captured two-digit INFO ROI.  Newly
  // learned templates are verified against the same ROI before being kept.
  if (Number.isInteger(expectedCount) && expectedCount >= 10 && expectedCount <= 12) {
    const learned = learnMissingTwoDigitTemplates(expectedCount, fallbackDebugDir);
    if (learned && learned.created && learned.created.length) {
      console.log(
        `INFO两位数模板自动标定成功：${learned.created.map(filePath => path.basename(filePath)).join(', ')}; ` +
        `复识别=${learned.verified.handCount}`
      );
      return finish({ ...out.result, own: { status: 'OK', handCount: learned.verified.handCount },
        verifiedTwoDigitCalibration: true });
    }
    if (learned && learned.error) {
      console.log(`INFO两位数模板自动标定失败：${learned.error.message}`);
    }
  }

  throw new Error(`HAND_SCROLL_INFO_UNAVAILABLE:${own && own.status || 'NONE'}`);
}

async function detectGeometry(bridge, info) {
  const detectImage = await captureReferenceRoi(bridge, info, config.handFan.detectRoi);
  const detected = detectHandCountFromImage(detectImage, null);
  const estimate = absoluteComponentEstimate(detected, { includeY: true });
  const centers = estimate ? estimate.components.map(component => Math.round(component.centerX)) : [];
  const geometry = {
    componentCount: estimate ? estimate.count : 0,
    centers,
    components: estimate ? estimate.components : [],
    spacing: medianSpacing(centers),
    fanBestCount: detected.best ? detected.best.count : null,
    fanBestValid: Boolean(detected.best && detected.best.valid)
  };
  Object.defineProperty(geometry, 'titleImage', { value: detectImage });
  return geometry;
}

async function clearDenseInteraction(bridge, info) {
  await bridge.mouseUp();
  const point = mapReferencePoint(info, config.handFan.slotResetMousePoint || { x: 856, y: 195 });
  await bridge.move(point.x, point.y);
  await bridge.key('ESC');
}

async function resolveDenseClick(bridge, info, geometry, strategy, relative, dir) {
  const prepared = repairDenseInternalTitleGap(geometry).geometry;
  let roi = config.handFan.detectRoi, image = geometry.titleImage;
  let proof = resolveDenseMeasuredWindow(prepared, strategy, relative, image, roi);
  if (!proof) {
    // Exception only: inspect a wider TITLE band, never rescan card identities.
    roi = { x: 580, y: 860, width: 960, height: 205 };
    image = await captureReferenceRoi(bridge, info, roi);
    proof = resolveDenseMeasuredWindow(prepared, strategy, relative, image, roi, true);
  }
  if (!proof) {
    if (dir) {
      saveRgbaPng(image, path.join(dir, 'dense_layout_uncertain.png'));
      writeJson(path.join(dir, 'dense_layout_uncertain.json'), {
        strategy, relative, roi, centers: prepared.centers, components: prepared.components
      });
    }
    throw new Error(`DENSE_CURRENT_SLOT_MAPPING_UNPROVEN:${strategy}:${relative}`);
  }
  Object.defineProperty(proof, 'image', { value: image });
  proof.roi = roi;
  return proof;
}

async function captureGeometry(bridge, info, dir, label, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const geometry = await detectGeometry(bridge, info);
  if (options.saveImages !== false) {
    const hand = await captureReferenceRoi(bridge, info, HAND_CAPTURE_ROI);
    await saveRgbaPng(hand, path.join(dir, `${label}_hand.png`));
    geometry.files = {
      hand: path.relative(ROOT, path.join(dir, `${label}_hand.png`))
    };
    if (options.saveFull) {
      const full = await captureReferenceRoi(bridge, info, FULL_CLIENT_ROI);
      await saveRgbaPng(full, path.join(dir, `${label}_full.png`));
      geometry.files.full = path.relative(ROOT, path.join(dir, `${label}_full.png`));
    }
  }
  return geometry;
}

function medianNumbers(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// Reuse the same mature idea as the low-hand TITLE_COMPONENTS internal-gap
// repair: a selected/occluded card can lose only its title component while
// both neighbours remain measurable.  In DENSE edge windows this matters
// because blindly taking five detected components can shift the entire
// right-hand window by one card.
function repairDenseInternalTitleGap(geometry) {
  const components = (geometry && geometry.components || [])
    .filter(component => Number.isFinite(Number(component.centerX)))
    .sort((a, b) => Number(a.centerX) - Number(b.centerX))
    .map(component => ({ ...component }));

  if (components.length < 4) {
    return {
      geometry: { ...(geometry || {}), components },
      inference: null
    };
  }

  const gaps = components.slice(1).map((component, index) =>
    Number(component.centerX) - Number(components[index].centerX)
  );
  let largestIndex = 0;
  for (let index = 1; index < gaps.length; index++) {
    if (gaps[index] > gaps[largestIndex]) largestIndex = index;
  }

  const normalGaps = gaps.filter((_, index) => index !== largestIndex);
  const normalSpacing = medianNumbers(normalGaps);
  const largestGap = gaps[largestIndex];

  // Mature hand-title spacing is roughly 100~175 px.  Only infer one missing
  // internal component when one gap is very close to two normal gaps.  This
  // is deliberately fail-closed: ordinary edge spacing and weak geometry do
  // not get synthesized.
  if (!Number.isFinite(normalSpacing) || normalSpacing < 100 || normalSpacing > 175 ||
      !Number.isFinite(largestGap) ||
      largestGap < normalSpacing * 1.75 || largestGap > normalSpacing * 2.35) {
    return {
      geometry: { ...(geometry || {}), components },
      inference: null
    };
  }

  const left = components[largestIndex];
  const right = components[largestIndex + 1];
  const centerX = Math.round((Number(left.centerX) + Number(right.centerX)) / 2);
  const leftY = Number(left.centerY);
  const rightY = Number(right.centerY);
  const centerY = Number.isFinite(leftY) && Number.isFinite(rightY)
    ? Math.round((leftY + rightY) / 2)
    : Number.isFinite(leftY)
      ? Math.round(leftY)
      : Number.isFinite(rightY)
        ? Math.round(rightY)
        : SAFE_CLICK_Y - SAFE_Y_OFFSET;

  if (centerX < SAFE_X_MIN || centerX > SAFE_X_MAX) {
    return {
      geometry: { ...(geometry || {}), components },
      inference: null
    };
  }

  const inferred = {
    centerX,
    centerY,
    inferred: true,
    inferenceSource: 'DENSE_INTERNAL_TITLE_GAP',
    inferredBetween: [Math.round(Number(left.centerX)), Math.round(Number(right.centerX))]
  };
  components.splice(largestIndex + 1, 0, inferred);

  return {
    geometry: {
      ...(geometry || {}),
      components,
      componentCount: components.length,
      centers: components.map(component => Math.round(Number(component.centerX))),
      spacing: medianSpacing(components.map(component => Number(component.centerX)))
    },
    inference: {
      centerX,
      centerY,
      gapPx: largestGap,
      normalSpacingPx: normalSpacing,
      insertIndex: largestIndex + 1
    }
  };
}

function pickSafeComponents(geometry, maxCards = SAFE_MAX_CARDS, strategy = 'center') {
  const components = (geometry.components || [])
    .filter(component => component.centerX >= SAFE_X_MIN && component.centerX <= SAFE_X_MAX)
    .sort((a, b) => a.centerX - b.centerX);

  if (components.length <= maxCards) return components;
  if (strategy === 'left') return components.slice(0, maxCards);
  if (strategy === 'right') return components.slice(-maxCards);

  let best = components.slice(0, maxCards);
  let bestScore = Infinity;
  for (let start = 0; start <= components.length - maxCards; start++) {
    const group = components.slice(start, start + maxCards);
    const centre = (group[0].centerX + group[group.length - 1].centerX) / 2;
    const score = Math.abs(centre - config.handFan.centerX);
    if (score < bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best;
}

function safeClickY(component) {
  const titleY = Number(component && component.centerY);
  if (!Number.isFinite(titleY)) return SAFE_CLICK_Y;
  return Math.max(SAFE_Y_MIN, Math.min(SAFE_Y_MAX, Math.round(titleY + SAFE_Y_OFFSET)));
}

async function recognizeCentralWindow({ bridge, info, library, templates, geometry, dir, label, strategy = 'center' }) {
  const initial = await resolveDenseClick(bridge, info, geometry, strategy, 0, dir);
  const targets = initial.components;
  const rows = [];
  for (let index = 0; index < targets.length; index++) {
    const original = targets[index];
    let proof = initial;
    if (index > 0) {
      await clearDenseInteraction(bridge, info);
      await sleep(90);
      const rawGeometry = await detectGeometry(bridge, info);
      proof = await resolveDenseClick(bridge, info, rawGeometry, strategy, index, dir);
    }
    const component = proof.target;
    if (Math.abs(component.centerX - original.centerX) > 45) {
      throw new Error(`DENSE_SCAN_SLOT_MAPPING_CHANGED:${index + 1}`);
    }
    const clickY = Math.round(component.centerY);
    const point = mapReferencePoint(info, { x: component.centerX, y: clickY });
    let recognized;
    let errorMessage = null;
    try {
      await bridge.click(point.x, point.y);
      await sleep(90);
      const result = await recognizeCurrentCard(bridge, info, library, templates, {
        stableAcceptedSamples: 2
      });
      recognized = normalizedRecognition(result);
      if (result && result.query) {
        await saveRgbaPng(result.query, path.join(dir, `${label}_card_${index + 1}_roi.png`));
      }
    } catch (error) {
      errorMessage = error.message;
      recognized = { accepted: false, id: 'UNKNOWN', name: 'UNKNOWN', mad: null, rmse: null, margin: null, top3: [] };
    } finally {
      await bridge.key('ESC').catch(() => {});
      await sleep(90);
    }
    rows.push({
      ordinal: index + 1,
      targetCenterX: Math.round(original.centerX),
      actualCenterX: Math.round(component.centerX),
      clickReference: { x: Math.round(component.centerX), y: clickY },
      inferredTitleComponent: Boolean(original.inferred || component.inferred),
      recognition: recognized,
      error: errorMessage
    });
    console.log(
      `      中央${index + 1}: x=${Math.round(component.centerX)} -> ` +
      `${recognized.name}[${recognized.id}] ${recognized.accepted ? 'PASS' : 'FAIL'}` +
      `${original.inferred || component.inferred ? ' [INFERRED_TITLE_CENTER]' : ''}`
    );
  }
  return rows;
}

async function dragReference(bridge, info, from, to, options = {}) {
  const a = mapReferencePoint(info, from);
  const b = mapReferencePoint(info, to);
  await bridge.drag(a.x, a.y, b.x, b.y, options);
  await clearDenseInteraction(bridge, info);
  await sleep(options.settleMs == null ? 130 : options.settleMs);
  return { from, to, distancePx: Math.abs(to.x - from.x) };
}

async function dragHand(bridge, info, direction, distancePx, options = {}) {
  // Any free horizontal drag invalidates the previously proven edge/window.
  // dragToEdge()/positionTargetWindow() will set a new proven state only after
  // the movement has been independently confirmed.
  setKnownDenseWindow(bridge, null);
  const d = Math.max(80, Math.min(650, Math.round(distancePx)));
  const fromX = direction === 'right' ? 980 : 1240;
  const toX = direction === 'right' ? fromX + d : fromX - d;
  return dragReference(
    bridge,
    info,
    { x: fromX, y: DRAG_Y },
    { x: toX, y: DRAG_Y },
    { durationMs: options.durationMs || 155, steps: options.steps || 10, settleMs: options.settleMs || 120 }
  );
}

async function dragToEdge(bridge, info, direction, dir) {
  const attempts = [];
  let previous = await captureGeometry(bridge, info, dir, `edge_${direction}_0`, { saveFull: false });
  let stableHits = 0;
  for (let attempt = 1; attempt <= 7; attempt++) {
    const drag = await dragHand(bridge, info, direction, 540, { settleMs: 110 });
    const current = await captureGeometry(bridge, info, dir, `edge_${direction}_${attempt}`, { saveImages: attempt === 1 || attempt >= 6 });
    const delta = geometryDelta(previous.centers, current.centers);
    const stable = geometryStable(previous.centers, current.centers, 7);
    attempts.push({ attempt, drag, beforeCenters: previous.centers, afterCenters: current.centers, delta, stable });
    console.log(`    ${direction === 'right' ? '向右' : '向左'}探边${attempt}: delta=${Number.isFinite(delta) ? delta.toFixed(1) : 'NA'} ${stable ? 'STABLE' : 'MOVED'}`);
    if (stable) stableHits++;
    else stableHits = 0;
    previous = current;
    if (stableHits >= 2) {
      // Dragging the fan to the right exposes the left-side anchored hand
      // window; dragging it to the left exposes the right-side window.
      const knownWindow = direction === 'right' ? 'LEFT_EDGE' : 'RIGHT_EDGE';
      setKnownDenseWindow(bridge, knownWindow);
      return { reached: true, attempts, geometry: current, knownWindow };
    }
  }
  setKnownDenseWindow(bridge, null);
  return { reached: false, attempts, geometry: previous, knownWindow: null };
}

function windowCards(recognitions, windowInfo = {}) {
  return (recognitions || []).map(row => ({
    ...(row.recognition || {}),
    denseWitness: {
      window: windowInfo.windowId || null,
      strategy: windowInfo.strategy || 'center',
      ordinal: row.ordinal,
      clickReference: row.clickReference || null,
      targetCenterX: row.targetCenterX,
      actualCenterX: row.actualCenterX,
      inferredTitleComponent: Boolean(row.inferredTitleComponent)
    }
  }));
}

async function collectWindow({ bridge, info, library, templates, sweepDir, index, dragDistancePx = 0, correction = null, strategy = 'center', windowId = null }) {
  const dir = path.join(sweepDir, `window_${String(index).padStart(2, '0')}${correction ? `_${correction}` : ''}`);
  const geometry = await captureGeometry(bridge, info, dir, 'window', { saveFull: index === 1 });
  console.log(
    `    窗口${index}${correction ? `(${correction})` : ''}: components=${geometry.componentCount}; ` +
    `centers=[${geometry.centers.join(', ')}]; spacing=${geometry.spacing == null ? 'NA' : geometry.spacing.toFixed(1)}`
  );
  const recognitions = await recognizeCentralWindow({ bridge, info, library, templates, geometry, dir, label: 'window', strategy });
  return {
    index,
    correction,
    geometry,
    medianSpacingPx: geometry.spacing,
    dragDistancePx,
    strategy,
    windowId,
    recognitions,
    cards: windowCards(recognitions, { windowId, strategy })
  };
}

function overlapSummary(prevWindow, currentWindow) {
  return chooseOverlap(prevWindow.cards, currentWindow.cards, {
    medianSpacingPx: currentWindow.medianSpacingPx || prevWindow.medianSpacingPx,
    dragDistancePx: currentWindow.dragDistancePx
  });
}

async function collectAdaptiveNextWindow(ctx) {
  const {
    bridge, info, library, templates, sweepDir, previousWindow, index, stepPx
  } = ctx;

  const before = await detectGeometry(bridge, info);
  const drag = await dragHand(bridge, info, 'left', stepPx, { settleMs: 125 });
  const after = await detectGeometry(bridge, info);
  const movement = geometryDelta(before.centers, after.centers);
  if (geometryStable(before.centers, after.centers, 7)) {
    console.log(`    左边界已到：本次拖动后几何基本不变(delta=${movement.toFixed(1)})。`);
    return { reachedEdge: true, movement, drag };
  }

  let current = await collectWindow({
    bridge, info, library, templates, sweepDir, index, dragDistancePx: drag.distancePx
  });
  let overlap = overlapSummary(previousWindow, current);
  console.log(`      overlap=${overlap.overlap}; candidates=[${overlap.candidates.join(',')}]; expected=${overlap.expectedOverlap == null ? 'NA' : overlap.expectedOverlap}`);

  // If a large drag skipped all card overlap, pull the fan back slightly and
  // retry.  If the overlap is almost the whole window, advance a little more.
  if (overlap.overlap === 0) {
    console.log('      无重叠：向右回拉120px后重采该窗口。');
    await dragHand(bridge, info, 'right', 120, { settleMs: 110 });
    const retry = await collectWindow({
      bridge, info, library, templates, sweepDir, index, dragDistancePx: Math.max(1, drag.distancePx - 120), correction: 'back120'
    });
    const retryOverlap = overlapSummary(previousWindow, retry);
    if (retryOverlap.overlap > overlap.overlap) {
      current = retry;
      overlap = retryOverlap;
    }
  } else if (overlap.overlap >= Math.max(2, previousWindow.cards.length - 1)) {
    console.log('      重叠过多：再向左推进120px后重采该窗口。');
    await dragHand(bridge, info, 'left', 120, { settleMs: 110 });
    const retry = await collectWindow({
      bridge, info, library, templates, sweepDir, index, dragDistancePx: drag.distancePx + 120, correction: 'forward120'
    });
    const retryOverlap = overlapSummary(previousWindow, retry);
    if (retryOverlap.overlap > 0 && retryOverlap.overlap < overlap.overlap) {
      current = retry;
      overlap = retryOverlap;
    }
  }

  current.overlapFromPrevious = overlap;
  current.geometryMovementPx = movement;
  return { reachedEdge: false, movement, drag, window: current };
}


async function positionTargetWindow({ bridge, info, window, stepPx, dir }) {
  const knownWindow = getKnownDenseWindow(bridge);
  if (knownWindow === window.id) {
    console.log(
      `    手牌位置复用: 当前已确认=${knownWindow}; 目标窗口=${window.id}; 跳过重复探边。`
    );
    return detectGeometry(bridge, info);
  }

  if (window.id === 'LEFT_EDGE') {
    const edge = await dragToEdge(bridge, info, 'right', path.join(dir, 'edge_right'));
    if (!edge.reached) throw new Error('DENSE_TARGET_LEFT_EDGE_UNPROVEN');
  } else if (window.id === 'RIGHT_EDGE') {
    const edge = await dragToEdge(bridge, info, 'left', path.join(dir, 'edge_left'));
    if (!edge.reached) throw new Error('DENSE_TARGET_RIGHT_EDGE_UNPROVEN');
  } else if (window.id === 'MIDDLE') {
    const edge = await dragToEdge(bridge, info, 'right', path.join(dir, 'edge_right_for_middle'));
    if (!edge.reached) throw new Error('DENSE_TARGET_MIDDLE_ANCHOR_UNPROVEN');
    await dragHand(bridge, info, 'left', stepPx, { settleMs: 125 });
    setKnownDenseWindow(bridge, 'MIDDLE');
  } else {
    throw new Error(`DENSE_TARGET_WINDOW_UNKNOWN:${window.id}`);
  }
  return detectGeometry(bridge, info);
}

async function recognizeDenseTargetSlots(options = {}) {
  const bridge = options.bridge;
  const info = options.info;
  const library = options.library;
  const templates = options.templates;
  const handCount = Number(options.handCount);
  const stepPx = Math.max(220, Math.min(560, Number(options.stepPx || 420)));
  const targetSlots = (options.targetSlots || []).map(Number).sort((a, b) => a - b);
  const outputDir = options.outputDir || path.join(ROOT, 'debug', 'hand-change-live', 'dense_targeted');
  // Execution callers may need the last verified card to stay selected so the
  // activation button can be clicked without selecting the same card twice.
  // Default remains false so all existing observer/material callers keep their
  // old ESC-after-recognition behavior.
  const keepFinalSelection = options.keepFinalSelection === true;
  fs.mkdirSync(outputDir, { recursive: true });
  const plan = planDenseTargetWindows(handCount, targetSlots);
  const recognized = [];

  if (!plan.windows.length) {
    return { success: true, handCount, targetSlots, plan, recognized, clickedSlots: [] };
  }

  console.log(
    `高手牌定点识别：仅点击新增槽位=${targetSlots.join(',')}; ` +
    `窗口=${plan.windows.map(window => window.id).join(' -> ')}`
  );

  for (const window of plan.windows) {
    const windowDir = path.join(outputDir, window.id.toLowerCase());
    fs.mkdirSync(windowDir, { recursive: true });
    let geometry = await positionTargetWindow({ bridge, info, window, stepPx, dir: windowDir });
    for (const slot of window.slots) {
      await clearDenseInteraction(bridge, info);
      await sleep(90);
      geometry = await detectGeometry(bridge, info);
      const relative = slot - window.startSlot;
      const proof = await resolveDenseClick(bridge, info, geometry, window.strategy, relative, windowDir);
      const component = proof.target;
      // One small current-frame witness, overwritten for a multi-target call.
      // Normal-game retention removes it; failed games preserve this exact basis.
      saveRgbaPng(proof.image, path.join(windowDir, 'click_basis.png'));
      writeJson(path.join(windowDir, 'click_basis.json'), {
        handCount, slot, window: window.id, startSlot: window.startSlot, roi: proof.roi,
        source: proof.source, centers: proof.components.map(c => c.centerX), target: component
      });
      const clickY = Math.round(component.centerY);
      const point = mapReferencePoint(info, { x: component.centerX, y: clickY });
      if (options.onBeforeSelect) {
        await options.onBeforeSelect({ bridge, info, slot,
          clickReference: { x: component.centerX, y: clickY } });
      }
      await bridge.click(point.x, point.y);
      await sleep(90);
      const result = await recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 });
      const normalized = normalizedRecognition(result);
      if (!normalized.accepted || !normalized.id || normalized.id === 'UNKNOWN') {
        throw new Error(`DENSE_TARGET_CARD_NOT_ACCEPTED:${slot}:${window.id}`);
      }
      recognized.push({
        slot,
        card: { id: normalized.id, name: normalized.name },
        window: window.id,
        clickReference: { x: Math.round(component.centerX), y: clickY },
        recognition: normalized
      });
      console.log(`    新增手牌定点点击: 手牌${slot} ${normalized.name}[${normalized.id}] (${window.id})`);
      const isFinalTarget = recognized.length === targetSlots.length;
      if (!(keepFinalSelection && isFinalTarget)) {
        await bridge.key('ESC').catch(() => {});
        await sleep(90);
      }
    }
  }

  recognized.sort((a, b) => a.slot - b.slot);
  return {
    success: recognized.length === targetSlots.length,
    handCount,
    targetSlots,
    plan,
    recognized,
    clickedSlots: recognized.map(row => row.slot),
    selectionKept: Boolean(keepFinalSelection && recognized.length === targetSlots.length && recognized.length > 0),
    finalKnownWindow: getKnownDenseWindow(bridge)
  };
}

async function selectDenseObservedWitness(options = {}) {
  const {
    bridge,
    info,
    library,
    templates,
    expectedId,
    witness,
    outputDir
  } = options;
  const stepPx = Math.max(220, Math.min(560, Number(options.stepPx || 420)));

  if (!witness || !witness.window || !Number.isInteger(Number(witness.ordinal))) {
    throw new Error(`DENSE_OBSERVED_WITNESS_INVALID:${expectedId || 'UNKNOWN'}`);
  }
  const ordinal = Number(witness.ordinal);
  const strategy = witness.strategy || (witness.window === 'LEFT_EDGE' ? 'left' : witness.window === 'RIGHT_EDGE' ? 'right' : 'center');
  if (ordinal < 1 || ordinal > SAFE_MAX_CARDS) {
    throw new Error(`DENSE_OBSERVED_WITNESS_ORDINAL_INVALID:${ordinal}`);
  }

  const dir = outputDir || path.join(ROOT, 'debug', 'execution', 'dense_observed_witness');
  fs.mkdirSync(dir, { recursive: true });
  const window = { id: witness.window, strategy };

  // Restore only the exact DENSE window that produced the baseline evidence.
  // No global slot->x mapping and no adjacent-slot fallback is used here.
  let geometry = await positionTargetWindow({ bridge, info, window, stepPx, dir });
  await clearDenseInteraction(bridge, info);
  await sleep(90);
  geometry = await detectGeometry(bridge, info);
  const proof = await resolveDenseClick(bridge, info, geometry, strategy, ordinal - 1, dir);
  const component = proof.target;
  const clickY = Math.round(component.centerY);
  const clickReference = { x: Math.round(component.centerX), y: clickY };
  const baselineRef = witness.clickReference;
  const driftPx = baselineRef && Number.isFinite(Number(baselineRef.x)) && Number.isFinite(Number(baselineRef.y))
    ? Math.hypot(clickReference.x - Number(baselineRef.x), clickReference.y - Number(baselineRef.y))
    : null;
  if (Number.isFinite(driftPx) && driftPx > 70) {
    throw new Error(
      `DENSE_OBSERVED_WITNESS_DRIFT_TOO_LARGE:${witness.window}:ordinal=${ordinal};` +
      `baseline=(${baselineRef.x},${baselineRef.y});current=(${clickReference.x},${clickReference.y});` +
      `drift=${driftPx.toFixed(1)}`
    );
  }

  const point = mapReferencePoint(info, clickReference);
  await bridge.click(point.x, point.y);
  await sleep(90);
  const result = await recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 });
  const normalized = normalizedRecognition(result);
  if (!normalized.accepted || !sameRuntimeCardIdentity(expectedId, normalized)) {
    await bridge.key('ESC').catch(() => {});
    throw new Error(
      `DENSE_OBSERVED_WITNESS_CARD_MISMATCH:${witness.window}:ordinal=${ordinal};` +
      `expected=${expectedId};actual=${normalized.name}[${normalized.id}]`
    );
  }

  console.log(
    `执行定位复用DENSE实测证据: ${normalized.name}[${normalized.id}] ` +
    `window=${witness.window}; ordinal=${ordinal}; ` +
    `baseline=(${baselineRef && baselineRef.x},${baselineRef && baselineRef.y}); ` +
    `current=(${clickReference.x},${clickReference.y}); ` +
    `drift=${Number.isFinite(driftPx) ? driftPx.toFixed(1) : 'NA'}px`
  );

  return {
    success: true,
    card: { id: normalized.id, name: normalized.name },
    recognition: normalized,
    clickReference,
    window: witness.window,
    strategy,
    ordinal,
    baselineWitness: witness,
    currentInferredTitleComponent: Boolean(component.inferred),
    driftPx,
    selectionKept: true,
    finalKnownWindow: getKnownDenseWindow(bridge)
  };
}

async function runOneSweep({ bridge, info, library, templates, rootDir, repeat, handCount, stepPx, maxWindows }) {
  const sweepDir = path.join(rootDir, `repeat_${repeat}`);
  fs.mkdirSync(sweepDir, { recursive: true });
  console.log(`\n===== 分段识别轮 ${repeat} =====`);
  console.log('  1) 向右拖到边界，只识别左侧锚定窗口。');
  const rightEdge = await dragToEdge(bridge, info, 'right', path.join(sweepDir, 'edge_right'));
  if (!rightEdge.reached) throw new Error('DENSE_SCAN_LEFT_EDGE_UNPROVEN');

  const windows = [];
  const first = await collectWindow({
    bridge, info, library, templates, sweepDir, index: 1, dragDistancePx: 0, strategy: 'left', windowId: 'LEFT_EDGE'
  });
  windows.push(first);

  if (handCount <= 10) {
    console.log('  2) 直接向左拖到另一侧边界，只识别右侧锚定窗口。');
    const leftEdge = await dragToEdge(bridge, info, 'left', path.join(sweepDir, 'edge_left'));
    if (!leftEdge.reached) throw new Error('DENSE_SCAN_RIGHT_EDGE_UNPROVEN');
    const last = await collectWindow({
      bridge, info, library, templates, sweepDir, index: 2, dragDistancePx: 0, strategy: 'right', windowId: 'RIGHT_EDGE'
    });
    windows.push(last);
    const stitched = mergeBoundaryWindows(first.cards, last.cards, handCount);
    console.log(
      `      边界拼接=${stitched.cards.map(card => card.id).join('>') || '无'} ` +
      `(${stitched.cards.length}/${handCount}, ${stitched.confidence}); ` +
      `固定重叠=${stitched.overlap}; 匹配=${stitched.overlapMatches}/${stitched.overlap}`
    );
    return { repeat, rightEdge, leftEdge, windows, stitched, success: stitched.complete };
  }

  console.log('  2) 11~12张：先采一个中央窗口，再到左边界采右侧锚定窗口。');
  await dragHand(bridge, info, 'left', stepPx, { settleMs: 125 });
  const middle = await collectWindow({
    bridge, info, library, templates, sweepDir, index: 2, dragDistancePx: stepPx, strategy: 'center', windowId: 'MIDDLE'
  });
  windows.push(middle);

  const leftEdge = await dragToEdge(bridge, info, 'left', path.join(sweepDir, 'edge_left'));
  if (!leftEdge.reached) throw new Error('DENSE_SCAN_RIGHT_EDGE_UNPROVEN');
  const last = await collectWindow({
    bridge, info, library, templates, sweepDir, index: 3, dragDistancePx: stepPx, strategy: 'right', windowId: 'RIGHT_EDGE'
  });
  windows.push(last);

  // 11~12 张使用三个绝对语义窗口整体拼接，而不是把最后一次“到左边界”的
  // 实际位移误当成固定 stepPx。这样重复卡存在时，INFO 总数会参与全局消歧。
  let stitched = mergeAnchoredThreeWindows(first, middle, last, handCount);
  if (!stitched.complete) {
    stitched.sequentialFallback = mergeWindows(windows, handCount);
    stitched.boundaryAnchor = mergeBoundaryWindows(first.cards, last.cards, handCount);
  }
  console.log(
    `      三窗拼接=${stitched.cards.map(card => card.id).join('>') || '无'} ` +
    `(${stitched.cards.length}/${handCount}, ${stitched.confidence}); ` +
    `重叠=${Array.isArray(stitched.chosenOverlaps) ? stitched.chosenOverlaps.join('+') : 'NA'}; ` +
    `候选=${Array.isArray(stitched.candidates) ? stitched.candidates.length : 0}`
  );
  return { repeat, rightEdge, leftEdge, windows, stitched, success: stitched.complete };
}

async function runDenseHandScan(options = {}) {
  const requestedCount = Number.isInteger(options.expectedCount) ? options.expectedCount : null;
  const authoritativeCount = Number.isInteger(options.authoritativeCount) ? options.authoritativeCount : null;
  const repeats = Math.max(1, Math.min(2, Number(options.repeats || 1)));
  const stepPx = Math.max(220, Math.min(560, Number(options.stepPx || 420)));
  const maxWindowsArg = Number.isInteger(options.maxWindows) ? options.maxWindows : null;
  const captureId = options.captureId || timestampId();
  const library = options.library || loadLibrary(ROOT);
  const templates = options.templates || await loadTemplates(ROOT, library);
  const digitTemplates = options.digitTemplates || loadInfoDigitTemplates(ROOT);
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  if (ownsBridge) await bridge.start();

  try {
    const activation = options.info
      ? { info: options.info }
      : options.skipActivation
        ? { info: await bridge.info() }
        : await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    validateMasterDuelClient(info, { requireTitle: true, errorMessage: 'MASTER_DUEL_CLIENT_NOT_SAFE' });

    let turnScore = null;
    if (options.verifyOwnTurn !== false) {
      const turnImage = await captureReferenceRoi(bridge, info, config.ownTurnRoi);
      turnScore = blueScoreFromRoi(turnImage);
      if (turnScore < config.ownTurnBlueThreshold) {
        throw new Error(`OWN_TURN_NOT_CONFIRMED:${turnScore.toFixed(4)}`);
      }
    }

    const tempDir = options.outputDir || path.join(
      ROOT,
      'materials',
      'hand-layout',
      'dense_segment',
      `${captureId}_${requestedCount || authoritativeCount || 'auto'}`
    );
    fs.mkdirSync(tempDir, { recursive: true });

    const actualCount = authoritativeCount != null
      ? authoritativeCount
      : await readOwnHandCount(bridge, digitTemplates, tempDir, requestedCount);
    if (requestedCount != null && requestedCount !== actualCount) {
      throw new Error(`HAND_SCROLL_COUNT_MISMATCH:requested=${requestedCount},actual=${actualCount}`);
    }
    if (actualCount < 8 || actualCount > 12) {
      throw new Error(`HAND_SCROLL_TEST_REQUIRES_8_TO_12:${actualCount}`);
    }

    const maxWindows = maxWindowsArg != null
      ? Math.max(2, Math.min(10, maxWindowsArg))
      : (actualCount <= 10 ? 2 : 3);

    console.log(`INFO确认：当前我方手牌=${actualCount}`);
    console.log(`参数：repeat=${repeats}; step=${stepPx}px; maxWindows=${maxWindows}; safeX=${SAFE_X_MIN}~${SAFE_X_MAX}`);

    const result = {
      version: 3,
      mode: options.mode || 'DENSE_HAND_SEGMENTED_SCROLL',
      capturedAt: new Date().toISOString(),
      captureId,
      handCount: actualCount,
      ownTurnScore: turnScore,
      repeats,
      stepPx,
      maxWindows,
      safeRegion: { xMin: SAFE_X_MIN, xMax: SAFE_X_MAX, clickYFallback: SAFE_CLICK_Y, yOffset: SAFE_Y_OFFSET, maxCards: SAFE_MAX_CARDS },
      legacyCalibrationPresent:
        fs.existsSync(path.join(ROOT, 'material', 'research', 'legacy-hand-calibration')) ||
        fs.existsSync(path.join(ROOT, 'materials', 'legacy-hand-calibration')),
      sweeps: []
    };

    for (let repeat = 1; repeat <= repeats; repeat++) {
      await bridge.key('ESC').catch(() => {});
      await sleep(100);
      const sweep = await runOneSweep({
        bridge, info, library, templates, rootDir: tempDir,
        repeat, handCount: actualCount, stepPx, maxWindows
      });
      result.sweeps.push(sweep);
      console.log(
        `  轮${repeat}结果: ${sweep.stitched.cards.map(card => `${card.name}[${card.id}]`).join(' | ') || '未拼接'}\n` +
        `  完整=${sweep.stitched.complete}; confidence=${sweep.stitched.confidence}`
      );
    }

    if (result.sweeps.length >= 2) {
      result.repeatComparison = compareSweeps(result.sweeps[0].stitched, result.sweeps[1].stitched);
      console.log('\n===== 两轮一致性 =====');
      console.log(
        `${result.repeatComparison.samePositions}/${result.repeatComparison.total} 位置一致; ` +
        `${result.repeatComparison.equal ? 'PASS' : 'CHECK'}`
      );
      if (result.repeatComparison.mismatches.length) {
        for (const row of result.repeatComparison.mismatches) {
          console.log(`  slot${row.index}: ${row.a} != ${row.b}`);
        }
      }
    }

    const primary = result.sweeps[0] && result.sweeps[0].stitched;
    if (!primary || primary.complete !== true) {
      throw new Error(`DENSE_HAND_SCAN_INCOMPLETE:${primary && primary.cards ? primary.cards.length : 0}/${actualCount}`);
    }

    await bridge.key('ESC').catch(() => {});
    await sleep(90);
    const baselineDetect = await captureReferenceRoi(bridge, info, config.handFan.detectRoi);
    const baselineHandImagePath = path.join(tempDir, 'baseline_hand_detect.png');
    await saveRgbaPng(baselineDetect, baselineHandImagePath);
    result.baselineHandImagePath = path.relative(ROOT, baselineHandImagePath);

    const resultPath = path.join(tempDir, 'result.json');
    writeJson(resultPath, result);
    if (options.writeLatest !== false) {
      writeJson(path.join(ROOT, 'debug', 'hand-layout-live', 'dense_segment_latest.json'), result);
    }
    const cards = primary.cards.map((card, index) => normalizeExodiaComponentCard({
      index: index + 1,
      id: card.id,
      name: card.name,
      accepted: card.accepted !== false,
      denseRecognition: {
        mad: card.mad == null ? null : card.mad,
        rmse: card.rmse == null ? null : card.rmse,
        margin: card.margin == null ? null : card.margin
      },
      denseWitness: card.denseWitness ? { ...card.denseWitness } : null
    }));

    return {
      result,
      resultPath,
      tempDir,
      baselineHandImagePath,
      scan: {
        status: 'PASS',
        handCount: actualCount,
        cards,
        layoutMode: 'DENSE_HAND_SEGMENTED_SCROLL',
        confidence: primary.confidence,
        source: resultPath
      }
    };
  } finally {
    await bridge.mouseUp().catch(() => {});
    if (ownsBridge) await bridge.stop();
  }
}

async function main() {
  const requestedCount = argNumber('--count', null);
  const repeats = Math.max(1, Math.min(2, argNumber('--repeat', 1) || 1));
  const stepPx = Math.max(220, Math.min(560, argNumber('--step', 420) || 420));
  const maxWindowsArg = argNumber('--max-windows', null);

  console.log('============================================================');
  console.log('8~12手牌：横向拖拽 + 中央窗口分段识别测试');
  console.log('原则：不再点击扇形两端；所有牌先拖入中央安全区，再识别。');
  console.log('流程：默认只跑1轮；8~10张直接左右边界双窗口，11~12张增加1个中央窗口。');
  console.log('只点击手牌查看卡名，不发动卡，不修改 observer/session/checkpoint。');
  console.log('============================================================');

  const out = await runDenseHandScan({
    expectedCount: requestedCount,
    repeats,
    stepPx,
    maxWindows: Number.isInteger(maxWindowsArg) ? maxWindowsArg : null
  });

  console.log('\n============================================================');
  console.log('8~12手牌分段识别测试完成');
  console.log(`素材目录: ${out.tempDir}`);
  console.log(`结果JSON: ${out.resultPath}`);
  console.log('正常情况下只需要把终端完整输出发给我；如果仍有漏牌，再补 result.json。');
  console.log('需要双轮复核时手动加 --repeat 2；默认不再跑两轮。');
  console.log('============================================================');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  runDenseHandScan,
  recognizeDenseTargetSlots,
  selectDenseObservedWitness,
  repairDenseInternalTitleGap,
  runOneSweep,
  readOwnHandCount
};
