'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { imageDarkRatio } = require('./image-metrics');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const {
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const {
  recognizeCurrentCard,
  saveRgbaPng
} = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-candidate-centers'
));
const { waitBeforePromptSubmit } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-submit-timing'
));

const GARURA_ID = 'E01';
const GARURA_NAME = '共命之翼 迦楼拉';

// Garura is the only Fusion Monster in this Extra Deck.  The number of legal
// cards changes the horizontal layout, so no absolute point or generic
// "leftmost component" is safe.  The prompt observer below finds the real
// purple Fusion card frame on current pixels and requires it to remain stable.
const EXTRA_SEND_PROMPT = {
  candidateRoi: { x: 420, y: 820, width: 1010, height: 215 },
  candidateY: 925,
  timeoutMs: 8000
};

// Previously calibrated one-effect prompt shown when Garura reaches the GY.
const SINGLE_EFFECT_PROMPT = {
  headerRoi: { x: 680, y: 730, width: 690, height: 70 },
  bodyRoi: { x: 690, y: 790, width: 670, height: 255 },
  candidateRoi: { x: 820, y: 810, width: 410, height: 230 },
  candidatePoint: { x: 1024, y: 925 },
  minHeaderDark: 0.72,
  minBodyDark: 0.65,
  minCandidateWidth: 90,
  maxCandidateWidth: 160,
  stableSamples: 3,
  stableMs: 350,
  timeoutMs: 9000
};

const BOTTOM_SELECT_ROI = {
  x: 790,
  y: 1035,
  width: 580,
  height: 105
};

// The optional-effect prompt has two separate actions: Cancel on the left and
// Select on the right.  Never search the full bottom row for "some yellow";
// that old policy could accept Cancel or a yellow hand-card fragment after the
// modal disappeared.  The fixed click point is safely inside the right action
// and is used only after both the real effect prompt and its enabled yellow
// right-button border are proven together.
const EFFECT_RIGHT_SELECT_ROI = {
  x: 1015,
  y: 1035,
  width: 355,
  height: 105
};
const EFFECT_RIGHT_SELECT_POINT = { x: 1175, y: 1085 };

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}



async function captureCandidateCenters({ bridge, info, roi, candidateY, debugDir, name }) {
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, name));
  }

  let points = [];
  try {
    points = detectCandidateCenters(
      image,
      roi,
      candidateY,
      { mode: 'components' }
    ) || [];
  } catch (_) {
    points = [];
  }

  return points
    .filter(point =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 520 &&
      point.x <= 1520
    )
    .sort((a, b) => a.x - b.x);
}

function fusionPurplePixel(r, g, b) {
  return r >= 55 && b >= 65 && g <= 145 &&
    r >= g * 1.12 && b >= g * 1.08 && Math.abs(r - b) <= 105;
}

function evaluateFusionWindow(image, x0, y0, width = 116, height = 170) {
  let purple = 0;
  let textureSum = 0;
  let textureCount = 0;
  const x1 = Math.min(image.width, x0 + width);
  const y1 = Math.min(image.height, y0 + height);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      if (fusionPurplePixel(r, g, b)) purple++;
      if (x + 2 < x1) {
        const next = (y * image.width + x + 2) * 4;
        const l1 = (r + g + b) / 3;
        const l2 = (image.data[next] + image.data[next + 1] + image.data[next + 2]) / 3;
        textureSum += Math.abs(l1 - l2);
        textureCount++;
      }
    }
  }
  const sampled = Math.ceil((x1 - x0) / 2) * Math.ceil((y1 - y0) / 2);
  return {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    centerX: x0 + (x1 - x0) / 2,
    centerY: y0 + (y1 - y0) / 2,
    purpleRatio: sampled ? purple / sampled : 0,
    texture: textureCount ? textureSum / textureCount : 0
  };
}

function detectUniqueFusionFrame(image, referenceRoi) {
  const windowWidth = 116;
  const windowHeight = 170;
  let best = null;

  // Cards in this modal have a stable vertical band but a variable horizontal
  // layout. Scan the whole row instead of deriving x from candidate count.
  for (let y0 = 0; y0 <= Math.min(50, image.height - windowHeight); y0 += 4) {
    for (let x0 = 0; x0 + windowWidth <= image.width; x0 += 4) {
      const row = evaluateFusionWindow(image, x0, y0, windowWidth, windowHeight);
      const score = row.purpleRatio * 100 + row.texture * 0.02;
      if (!best || score > best.score) best = { ...row, score };
    }
  }

  const proven = Boolean(best && best.purpleRatio >= 0.045 && best.texture >= 10);
  if (!proven) return { proven: false, frame: best, point: null };
  return {
    proven: true,
    frame: best,
    point: {
      x: referenceRoi.x + best.centerX,
      y: referenceRoi.y + best.centerY,
      detector: 'M18_REAL_PURPLE_FUSION_FRAME_V1'
    }
  };
}

function fusionPointSignature(point) {
  if (!point) return '';
  return `${Math.round(point.x / 8) * 8},${Math.round(point.y / 8) * 8}`;
}

async function waitForExtraSendPrompt({ bridge, info, debugDir }) {
  const started = Date.now();
  let bestCount = 0;
  let lastPoints = [];
  let lastFusion = null;
  let lastSignature = '';
  let stableSamples = 0;
  let firstFusionAt = 0;
  let attempt = 0;

  // Pure observation only.  No INFO, mouse, keyboard or scroll is sent while
  // the activation animation/prompt is settling.
  while (Date.now() - started < EXTRA_SEND_PROMPT.timeoutMs) {
    attempt += 1;
    const image = await captureReferenceRoi(bridge, info, EXTRA_SEND_PROMPT.candidateRoi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, `m18_extra_prompt_${String(attempt).padStart(2, '0')}.png`));
    }
    let points = [];
    try {
      points = detectCandidateCenters(
        image,
        EXTRA_SEND_PROMPT.candidateRoi,
        EXTRA_SEND_PROMPT.candidateY,
        { mode: 'components' }
      ) || [];
    } catch (_) {
      points = [];
    }
    points = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    const fusion = detectUniqueFusionFrame(image, EXTRA_SEND_PROMPT.candidateRoi);
    lastFusion = fusion;
    bestCount = Math.max(bestCount, points.length);
    lastPoints = points;

    const signature = fusionPointSignature(fusion.point);
    if (signature) {
      if (!firstFusionAt) firstFusionAt = Date.now();
      if (signature === lastSignature) stableSamples++;
      else {
        lastSignature = signature;
        stableSamples = 1;
      }
    } else {
      lastSignature = '';
      stableSamples = 0;
      firstFusionAt = 0;
    }

    if (fusion.proven && stableSamples >= 3 && Date.now() - firstFusionAt >= 350) {
      console.log(
        `重葬额外卡组选择窗口: PASS_STABLE; genericCandidates=${points.length}; ` +
        `fusion=(${Math.round(fusion.point.x)},${Math.round(fusion.point.y)}); ` +
        `purple=${fusion.frame.purpleRatio.toFixed(3)}; texture=${fusion.frame.texture.toFixed(1)}; ` +
        `stable=${stableSamples}`
      );
      return { attempts: attempt, points, fusionPoint: fusion.point, fusionFrame: fusion.frame };
    }

    await sleep(140);
  }

  throw new Error(
    `M18_EXTRA_SEND_PROMPT_TIMEOUT:bestCandidates=${bestCount};` +
    `last=${lastPoints.map(point => Math.round(point.x)).join(',') || 'NONE'};` +
    `fusion=${lastFusion && lastFusion.frame
      ? `${lastFusion.frame.purpleRatio.toFixed(3)}/${lastFusion.frame.texture.toFixed(1)}`
      : 'NONE'}`
  );
}

async function clickEnabledYellowBottomButton({
  bridge,
  info,
  debugDir,
  label,
  timeoutMs = 4000
}) {
  const started = Date.now();
  let lastYellow = 0;

  // Candidate has already been selected and identity-proven.  If the button is
  // late, this loop retries only the submit button.  It never re-clicks E01.
  while (Date.now() - started < timeoutMs) {
    const image = await captureReferenceRoi(bridge, info, BOTTOM_SELECT_ROI);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(
        image,
        path.join(
          debugDir,
          `${label.replace(/[^\w\u4e00-\u9fff]+/g, '_')}_bottom_latest.png`
        )
      );
    }

    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    const component = (stats.components || [])
      .filter(item =>
        item.estimatedPixels >= 80 &&
        item.width >= 20 &&
        item.height >= 12
      )
      .sort((a, b) => b.estimatedPixels - a.estimatedPixels)[0] || null;

    if (component && lastYellow >= 280) {
      const reference = {
        x: BOTTOM_SELECT_ROI.x + component.centerX,
        y: BOTTOM_SELECT_ROI.y + component.centerY
      };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `${label}: 已点击黄色“选择/确认”；yellowPixels=${lastYellow}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return {
        yellowPixels: lastYellow,
        component,
        point: reference
      };
    }

    await sleep(120);
  }

  throw new Error(
    `${label}:BOTTOM_SELECT_NOT_PROVEN:yellow=${lastYellow};` +
    '候选已经选中，只允许重试选择/确认按钮，禁止重新点击候选牌。'
  );
}

async function prepareGaruraExtraDeckSelection({
  bridge,
  info,
  library,
  templates,
  debugDir
}) {
  console.log('\n===== M18选择共命之翼 迦楼拉[E01]送墓 =====');
  console.log(
    '迦楼拉是本卡组唯一融合怪兽：连续监视当前窗口的紫色融合卡实体框，' +
    '稳定后点击该实时中心；点击后仍必须读取左侧卡名精确认。'
  );

  const promptProof = await waitForExtraSendPrompt({ bridge, info, debugDir });
  const reference = promptProof.fusionPoint;
  if (!reference) throw new Error('M18_LIVE_FUSION_FRAME_MISSING_AFTER_PROMPT_PROOF');
  const physical = mapReferencePoint(info, reference);

  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 260);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const selected = normalizeRecognized(raw);

  console.log(
    `重葬额外第1张确认: ${selected.name}[${selected.id}] ` +
    `${selected.accepted ? 'PASS' : 'UNKNOWN'}`
  );

  if (!selected.accepted || selected.id !== GARURA_ID) {
    throw new Error(
      `M18_FIRST_EXTRA_IS_NOT_GARURA:` +
      `${selected.name}[${selected.id}];expected=${GARURA_NAME}[${GARURA_ID}]`
    );
  }

  console.log(
    `实际送墓目标已选中并精确认: ${GARURA_NAME}[${GARURA_ID}] PASS；` +
    '下一阶段只允许点击“选择/确认”，不再点击候选牌。'
  );

  return {
    promptProof,
    selected,
    candidateIndex: 1,
    clickReference: reference,
    policy: 'FIRST_EXTRA_ONLY_UNIQUE_FUSION'
  };
}

async function confirmPreparedGaruraExtraDeckSelection({
  bridge,
  info,
  debugDir
}) {
  await waitBeforePromptSubmit('重葬选择迦楼拉');
  return clickEnabledYellowBottomButton({
    bridge,
    info,
    debugDir,
    label: '重葬选择迦楼拉'
  });
}

async function singleEffectPromptVisible({ bridge, info, debugDir, suffix }) {
  const header = await captureReferenceRoi(
    bridge,
    info,
    SINGLE_EFFECT_PROMPT.headerRoi
  );
  const body = await captureReferenceRoi(
    bridge,
    info,
    SINGLE_EFFECT_PROMPT.bodyRoi
  );

  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(header, path.join(debugDir, `m18_e01_effect_header_${suffix}.png`));
    saveRgbaPng(body, path.join(debugDir, `m18_e01_effect_body_${suffix}.png`));
  }

  const headerDark = imageDarkRatio(header, 86);
  const bodyDark = imageDarkRatio(body, 86);
  const rawPoints = await captureCandidateCenters({
    bridge,
    info,
    roi: SINGLE_EFFECT_PROMPT.candidateRoi,
    candidateY: SINGLE_EFFECT_PROMPT.candidatePoint.y,
    debugDir: null,
    name: 'unused.png'
  });
  const points = rawPoints.filter(plausibleGaruraEffectCandidate);

  return {
    visible:
      headerDark >= SINGLE_EFFECT_PROMPT.minHeaderDark &&
      bodyDark >= SINGLE_EFFECT_PROMPT.minBodyDark &&
      points.length >= 1,
    headerDark,
    bodyDark,
    candidateCount: points.length,
    points,
    rawCandidateCount: rawPoints.length,
    rawPoints
  };
}

function plausibleGaruraEffectCandidate(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const width = Number(point.width || 0);
  return width >= SINGLE_EFFECT_PROMPT.minCandidateWidth &&
    width <= SINGLE_EFFECT_PROMPT.maxCandidateWidth &&
    point.x >= 900 && point.x <= 1150 &&
    point.y >= 860 && point.y <= 990;
}

function effectCandidateSignature(point) {
  if (!point) return '';
  return [
    Math.round(Number(point.x || 0) / 6) * 6,
    Math.round(Number(point.y || 0) / 6) * 6,
    Math.round(Number(point.width || 0) / 6) * 6
  ].join(',');
}

async function waitForGaruraEffectPrompt({ bridge, info, debugDir }) {
  console.log('\n等待迦楼拉送墓动画结束并出现自身效果窗口。');
  console.log('本阶段纯等待/截图检测：不发送鼠标、键盘、INFO或滚动输入。');

  const started = Date.now();
  let attempt = 0;
  let bestHeader = 0;
  let bestBody = 0;
  let bestCandidates = 0;
  let bestRawCandidates = 0;
  let widestRawCandidate = 0;
  let stableSamples = 0;
  let stableSince = 0;
  let lastSignature = '';
  
  while (Date.now() - started < SINGLE_EFFECT_PROMPT.timeoutMs) {
    attempt += 1;
    const probe = await singleEffectPromptVisible({
      bridge,
      info,
      debugDir,
      suffix: String(attempt).padStart(2, '0')
    });

    bestHeader = Math.max(bestHeader, probe.headerDark);
    bestBody = Math.max(bestBody, probe.bodyDark);
    bestCandidates = Math.max(bestCandidates, probe.candidateCount);
    bestRawCandidates = Math.max(bestRawCandidates, probe.rawCandidateCount || 0);
    widestRawCandidate = Math.max(
      widestRawCandidate,
      ...(probe.rawPoints || []).map(point => Number(point.width || 0)),
      0
    );

    const onlyCandidate = probe.candidateCount === 1 ? probe.points[0] : null;
    const signature = effectCandidateSignature(onlyCandidate);
    if (probe.visible && signature) {
      if (signature === lastSignature) stableSamples++;
      else {
        lastSignature = signature;
        stableSamples = 1;
        stableSince = Date.now();
      }
    } else {
      lastSignature = '';
      stableSamples = 0;
      stableSince = 0;
    }

    // This deterministic M18 sub-route reaches this prompt only after E01 was
    // physically selected, identity-proven and submitted to the GY.  Wait for
    // the actual single optional-effect candidate to be present; animation
    // frames that temporarily merge/split components are ignored.
    if (
      probe.visible &&
      probe.candidateCount === 1 &&
      stableSamples >= SINGLE_EFFECT_PROMPT.stableSamples &&
      Date.now() - stableSince >= SINGLE_EFFECT_PROMPT.stableMs
    ) {
      console.log(
        `迦楼拉自身效果窗口: PASS; ` +
        `headerDark=${probe.headerDark.toFixed(3)}; ` +
        `bodyDark=${probe.bodyDark.toFixed(3)}; ` +
        `candidates=${probe.candidateCount}; ` +
        `candidateWidth=${Math.round(probe.points[0].width)}; ` +
        `stable=${stableSamples}`
      );
      return { attempts: attempt, stableSamples, ...probe };
    }

    await sleep(150);
  }

  throw new Error(
    `M18_E01_EFFECT_PROMPT_TIMEOUT:` +
    `header=${bestHeader.toFixed(3)};body=${bestBody.toFixed(3)};` +
    `candidates=${bestCandidates};raw=${bestRawCandidates};widest=${widestRawCandidate}`
  );
}

async function clickEnabledRightEffectSelectButton({
  bridge,
  info,
  debugDir,
  timeoutMs = 4000
}) {
  const started = Date.now();
  let lastYellow = 0;
  let stable = 0;

  while (Date.now() - started < timeoutMs) {
    // The modal itself must still be present.  This prevents hand-card yellow
    // borders from satisfying the button proof after a transition frame.
    const prompt = await singleEffectPromptVisible({
      bridge,
      info,
      debugDir: null,
      suffix: 'confirm'
    });
    const image = await captureReferenceRoi(bridge, info, EFFECT_RIGHT_SELECT_ROI);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, '迦楼拉自身效果_right_select_latest.png'));
    }

    const stats = yellowUsableStats(image);
    lastYellow = Number(stats.estimatedYellowPixels || 0);
    const component = (stats.components || []).find(item =>
      item.estimatedPixels >= 80 && item.width >= 20 && item.height >= 12
    );
    if (prompt.visible && prompt.candidateCount === 1 && component && lastYellow >= 280) {
      stable++;
      if (stable >= 2) {
        const physical = mapReferencePoint(info, EFFECT_RIGHT_SELECT_POINT);
        await bridge.click(physical.x, physical.y);
        console.log(
          `迦楼拉自身效果: 右侧“选择”按钮 PASS并已点击；` +
          `yellowPixels=${lastYellow}; reference=(${EFFECT_RIGHT_SELECT_POINT.x},${EFFECT_RIGHT_SELECT_POINT.y})`
        );
        return {
          yellowPixels: lastYellow,
          component,
          point: EFFECT_RIGHT_SELECT_POINT,
          stableSamples: stable,
          policy: 'M18_EFFECT_RIGHT_SELECT_ONLY'
        };
      }
    } else {
      stable = 0;
    }
    await sleep(140);
  }

  throw new Error(
    `M18_E01_RIGHT_SELECT_NOT_PROVEN:yellow=${lastYellow};` +
    '只允许右侧选择按钮；禁止点击左侧取消、手牌黄框或底部黄色碎片。'
  );
}

async function prepareGaruraEffectSelection({
  bridge,
  info,
  library,
  templates,
  debugDir
}) {
  const promptProof = await waitForGaruraEffectPrompt({ bridge, info, debugDir });
  const reference =
    (promptProof.points && promptProof.points.length === 1 && promptProof.points[0]) ||
    SINGLE_EFFECT_PROMPT.candidatePoint;
  const physical = mapReferencePoint(info, reference);

  // IMPORTANT: do not call recognizeCurrentCard() here.
  // Master Duel's single optional-effect window does not reliably populate the
  // normal left-side card-detail panel.  The old strict check could therefore
  // read an unrelated/stale card (e.g. M16) even though the only visible effect
  // candidate is Garura.
  //
  // Identity is already established by the immediately preceding deterministic
  // M18 stage: the Extra Deck target was physically clicked and recognized as
  // E01 before it was submitted to the GY.  At this stage we require exactly one
  // real optional-effect candidate and select that candidate only.  Final proof
  // remains the mature observer result E01 -> HAND_GAIN after resolution.
  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 260);

  const selected = {
    accepted: true,
    id: GARURA_ID,
    name: GARURA_NAME,
    evidence: 'DETERMINISTIC_SINGLE_EFFECT_AFTER_E01_GY',
    candidateCount: promptProof.candidateCount
  };

  console.log(
    `迦楼拉效果候选确认: ${GARURA_NAME}[${GARURA_ID}] PASS; ` +
    `evidence=E01已精确认送墓+当前单候选; ` +
    `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
  );
  console.log(
    '单候选效果窗口不再读取普通左侧详情；候选已选中，下一阶段只提交“选择/确认”。'
  );

  return {
    promptProof,
    selected,
    clickReference: reference,
    policy: 'M18_E01_DETERMINISTIC_SINGLE_EFFECT'
  };
}

async function confirmPreparedGaruraEffectSelection({
  bridge,
  info,
  debugDir
}) {
  await waitBeforePromptSubmit('迦楼拉自身效果');
  const confirmProof = await clickEnabledRightEffectSelectButton({
    bridge,
    info,
    debugDir
  });
  console.log('已选择并发动迦楼拉自身效果；随后只等待抽1结算。');
  return confirmProof;
}

module.exports = {
  GARURA_ID,
  GARURA_NAME,
  EXTRA_SEND_PROMPT,
  SINGLE_EFFECT_PROMPT,
  prepareGaruraExtraDeckSelection,
  confirmPreparedGaruraExtraDeckSelection,
  waitForGaruraEffectPrompt,
  plausibleGaruraEffectCandidate,
  prepareGaruraEffectSelection,
  confirmPreparedGaruraEffectSelection
};
