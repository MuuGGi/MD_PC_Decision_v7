'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
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
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-candidate-centers'
));
const {
  detectEquipConfirmButton,
  captureObservedOwnLink,
  isKnownLinkMonsterId
} = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));
const { probeOptionalEffectPrompt } = require(path.join(
  ROOT,
  'execution',
  'core',
  'optional-effect-prompt-observer'
));

const EXTRA = config.toonChain.extraDeck;
const { verifySpecialSummonGlyph } = require('./hand-action-icon');

function chooseExtraDeckSummonIcon(image, stats) {
  const roi = EXTRA.summonButtonRoi;
  const expected = EXTRA.summonButtonPoint;
  const candidates = (stats.components || []).filter(c =>
    c.estimatedPixels >= 350 && c.width >= 45 && c.width <= 100 &&
    c.height >= 45 && c.height <= 90 && c.fillRatio >= 0.2 &&
    Math.abs(roi.x + c.centerX - expected.x) <= 30 &&
    Math.abs(roi.y + c.centerY - expected.y) <= 30
  ).map(c => ({ ...c, glyph: verifySpecialSummonGlyph(image, c),
    drift: Math.hypot(roi.x + c.centerX - expected.x, roi.y + c.centerY - expected.y) }))
    .filter(c => c.glyph.pass)
    .sort((a, b) => a.drift - b.drift || b.glyph.iou - a.glyph.iou);
  return { chosen: candidates.length === 1 ? candidates[0] : null, candidates,
    expectedReference: expected, detector: 'EXTRA_DECK_EXPECTED_LOCAL_SUMMON_GLYPH_V2' };
}

const BOTTOM_SUMMON_ROI = {
  x: Math.max(0, EXTRA.summonDialog.confirmPoint.x - 180),
  y: 1035,
  width: 360,
  height: 110
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function isCyan(r, g, b) {
  return b >= 120 && g >= 60 && b >= r + 30 && b >= g + 8;
}

function cyanComponents(image) {
  const width = image.width;
  const height = image.height;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isCyan(image.data[i], image.data[i + 1], image.data[i + 2])) {
        mask[y * width + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const out = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let pixels = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      pixels++;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!mask[ni] || visited[ni]) continue;
          visited[ni] = 1;
          queue[tail++] = ni;
        }
      }
    }

    out.push({
      pixels,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: sumX / pixels,
      centerY: sumY / pixels
    });
  }

  return out.sort((a, b) => b.pixels - a.pixels);
}

async function clickExtraDeckSummonButton({ bridge, info, debugDir }) {
  const pile = mapReferencePoint(info, EXTRA.point);
  await bridge.click(pile.x, pile.y);
  await sleep(config.mouseSettleMs || 230);

  const started = Date.now();
  let last = [];
  while (Date.now() - started < 3500) {
    const image = await captureReferenceRoi(bridge, info, EXTRA.summonButtonRoi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'extra_deck_summon_button_latest.png'));
    }
    const yellowStats = yellowUsableStats(image);
    const proof = chooseExtraDeckSummonIcon(image, yellowStats);
    last = proof.candidates;
    const chosen = proof.chosen;
    if (chosen) {
      const reference = {
        x: EXTRA.summonButtonRoi.x + chosen.centerX,
        y: EXTRA.summonButtonRoi.y + chosen.centerY
      };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `额外卡组“特殊召唤”按钮: PASS; detector=${proof.detector}; ` +
        `pixels=${chosen.estimatedPixels}; component=${chosen.width}x${chosen.height}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return {
        clickReference: reference,
        chosen,
        yellowPixels: yellowStats.estimatedYellowPixels,
        detector: proof.detector,
        expectedReference: proof.expectedReference
      };
    }
    await sleep(120);
  }

  throw new Error(
    `D2_EXTRA_DECK_SUMMON_BUTTON_NOT_PROVEN:yellowComponents=${last.length};` +
    '只点击了额外卡组入口，没有继续乱点。'
  );
}


function evaluateLinkCandidateWindow(image, x0, y0, width, height) {
  let blue = 0;
  let total = 0;
  let textureSum = 0;
  let textureCount = 0;

  const x1 = Math.min(image.width, x0 + width);
  const y1 = Math.min(image.height, y0 + height);
  for (let y = Math.max(0, y0); y < y1; y += 2) {
    for (let x = Math.max(0, x0); x < x1; x += 2) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (b >= 90 && b >= r + 25 && b >= g + 12 && b >= r * 1.15) blue++;
      total++;

      if (x + 2 < x1) {
        const i2 = (y * image.width + x + 2) * 4;
        const l1 = (r + g + b) / 3;
        const l2 = (image.data[i2] + image.data[i2 + 1] + image.data[i2 + 2]) / 3;
        textureSum += Math.abs(l1 - l2);
        textureCount++;
      }
      if (y + 2 < y1) {
        const i2 = ((y + 2) * image.width + x) * 4;
        const l1 = (r + g + b) / 3;
        const l2 = (image.data[i2] + image.data[i2 + 1] + image.data[i2 + 2]) / 3;
        textureSum += Math.abs(l1 - l2);
        textureCount++;
      }
    }
  }

  return {
    x: x0,
    y: y0,
    width,
    height,
    centerX: x0 + width / 2,
    centerY: y0 + height / 2,
    blueRatio: total ? blue / total : 0,
    texture: textureCount ? textureSum / textureCount : 0
  };
}

function candidateFrameScore(row) {
  return Number(row.blueRatio || 0) * 100 + Number(row.texture || 0) * 0.025;
}

// Extra Deck Link cards are blue.  The old implementation only used the
// horizontal component detector and then forced y=925.  That worked for the
// earlier two-card prompt, but a one-card prompt can sit a little higher and
// the forced point can miss the actual selectable card body.  Keep the mature
// x detector, then refine x/y by measuring the real blue card frame inside the
// current prompt image.  If the frame cannot be proven, retain the old point
// rather than guessing somewhere else.
function refineLinkCandidatePoint(image, referenceRoi, point) {
  const localX = Number(point.x) - referenceRoi.x;
  const windowWidth = 110;
  const windowHeight = 150;
  let best = null;

  for (let y0 = 0; y0 + windowHeight <= image.height; y0 += 5) {
    for (let dx = -25; dx <= 25; dx += 5) {
      const x0 = Math.round(localX + dx - windowWidth / 2);
      if (x0 < 0 || x0 + windowWidth > image.width) continue;
      const row = evaluateLinkCandidateWindow(image, x0, y0, windowWidth, windowHeight);
      if (!best || candidateFrameScore(row) > candidateFrameScore(best)) best = row;
    }
  }

  const frameProven = Boolean(
    best &&
    best.blueRatio >= 0.08 &&
    best.texture >= 12.0 &&
    Math.abs((referenceRoi.x + best.centerX) - Number(point.x)) <= 70
  );

  if (!frameProven) {
    return {
      ...point,
      detector: 'LINK_CANDIDATE_X_ONLY_FALLBACK_V1',
      frameProven: false,
      frame: best
    };
  }

  return {
    ...point,
    x: referenceRoi.x + best.centerX,
    y: referenceRoi.y + best.centerY,
    detector: 'LINK_CANDIDATE_REAL_BLUE_FRAME_V1',
    frameProven: true,
    frame: best
  };
}

function linkCandidateSignature(points) {
  return (points || [])
    .map(p => `${Math.round(Number(p.x) / 8) * 8},${Math.round(Number(p.y) / 8) * 8}`)
    .join('|');
}

function looksLikeMergedAnimatingLinkCandidate(points) {
  if (!Array.isArray(points) || points.length !== 1) return false;
  const p = points[0] || {};
  // During the Extra Deck opening animation, two Link cards can briefly overlap
  // around the center and the mature horizontal component detector sees one very
  // wide block.  Never accept that transitional block as a real one-card prompt.
  return Number(p.width || 0) >= 170;
}

async function waitForSummonCandidates({ bridge, info, debugDir }) {
  const started = Date.now();
  let attempt = 0;
  let points = [];
  let lastSignature = '';
  let stableSamples = 0;
  let firstVisibleAt = 0;
  let lastLoggedSignature = '';

  while (Date.now() - started < 6500) {
    attempt++;
    const image = await captureReferenceRoi(bridge, info, EXTRA.summonDialog.candidateRoi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, `link_candidates_${String(attempt).padStart(2, '0')}.png`));
    }
    try {
      points = detectCandidateCenters(
        image,
        EXTRA.summonDialog.candidateRoi,
        EXTRA.summonDialog.candidateY,
        { mode: 'components' }
      ) || [];
    } catch (_) {
      points = [];
    }
    points = points
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 520 && p.x <= 1520)
      .map(p => refineLinkCandidatePoint(image, EXTRA.summonDialog.candidateRoi, p))
      .sort((a, b) => a.x - b.x);

    const mergedAnimating = looksLikeMergedAnimatingLinkCandidate(points);
    const allFramesProven = points.length >= 1 && points.every(p => p.frameProven);
    const signature = mergedAnimating ? '' : linkCandidateSignature(points);

    if (signature && allFramesProven) {
      if (!firstVisibleAt) firstVisibleAt = Date.now();
      if (signature === lastSignature) stableSamples++;
      else {
        lastSignature = signature;
        stableSamples = 1;
      }

      if (signature !== lastLoggedSignature) {
        console.log(
          `Link候选窗口稳定等待: observed=${points.length}; ` +
          `centers=[${points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')}]; ` +
          `stable=${stableSamples}/3`
        );
        lastLoggedSignature = signature;
      }

      // Do not act on the first visible animation frame.  Require the same real
      // physical-card layout in three captures and at least 500 ms of settled
      // visibility.  This preserves the one-card case while preventing the
      // previous 2-cards->1-merged transient at x≈1024.
      if (stableSamples >= 3 && Date.now() - firstVisibleAt >= 500) {
        console.log(
          `Link召唤候选窗口: PASS_STABLE; candidates=${points.length}; ` +
          `centers=[${points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')}]; ` +
          `physicalFrames=${points.filter(p => p.frameProven).length}/${points.length}; ` +
          `stableSamples=${stableSamples}`
        );
        return { points, attempts: attempt, stableSamples, detector: 'LINK_PROMPT_STABLE_PHYSICAL_FRAMES_V2' };
      }
    } else {
      if (mergedAnimating && lastLoggedSignature !== 'MERGED_ANIMATION') {
        console.log(
          `Link候选窗口仍在动画: 暂检测到1个合并宽块(width=${Math.round(Number(points[0] && points[0].width || 0))})，继续纯等待，不点击。`
        );
        lastLoggedSignature = 'MERGED_ANIMATION';
      }
      lastSignature = '';
      stableSamples = 0;
      firstVisibleAt = 0;
    }

    await sleep(150);
  }
  throw new Error('D2_LINK_SUMMON_CANDIDATE_PROMPT_TIMEOUT_OR_UNSTABLE');
}

function preferredLinkIdsForCarrier(carrierId) {
  // The Extra Deck summon prompt is already filtered by Master Duel to cards
  // that are legal in the current state.  Do not hard-limit the operation layer
  // to the old E02-E05 Striker set: later routes may legitimately expose E06-E10.
  // Keep the familiar Striker Link-1 cards first only as a soft preference/debug
  // ordering; every known Link shown by the game remains eligible.
  const order = ['E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10'];
  return order.filter(id => id !== carrierId).concat(order.filter(id => id === carrierId));
}

async function selectNextLegalLink({ bridge, info, library, templates, carrierId, promptProof, debugDir, excludedLinkIds = [] }) {
  const excluded = new Set(excludedLinkIds), seen = [];
  // Read the real legal set before choosing. Never let left-to-right UI order
  // decide the strategic Link result. No irreversible submission during scan.
  for (let i = 0; i < promptProof.points.length; i++) {
    const point = promptProof.points[i], physical = mapReferencePoint(info, point);
    await bridge.click(physical.x, physical.y);
    await sleep(Math.max(420, config.mouseSettleMs || 230));
    const recognized = normalizeRecognized(await recognizeCurrentCard(bridge, info, library, templates,
      { stableAcceptedSamples: 2 }));
    if (!recognized.accepted || !isKnownLinkMonsterId(recognized.id))
      throw new Error('LINK_LEGAL_SET_IDENTITY_UNKNOWN:zero_submit=1');
    seen.push({ index: i + 1, point, recognized });
    await bridge.click(physical.x, physical.y); // restore unselected, as in mature scan
    await sleep(Math.max(360, config.mouseSettleMs || 230));
  }
  const targetId = require('../../lib/yoto-search-value').chooseBambooLinkTarget(
    seen.filter(row => !excluded.has(row.recognized.id)).map(row => row.recognized.id), { carrierId });
  const chosen = seen.find(row => row.recognized.id === targetId);
  if (!chosen) throw new Error('D2_ONLY_EXCLUDED_LINK_TARGETS:carrier=' + carrierId);
  const current = await waitForSummonCandidates({ bridge, info, debugDir });
  if (linkCandidateSignature(current.points) !== linkCandidateSignature(promptProof.points))
    throw new Error('LINK_LEGAL_SET_LAYOUT_CHANGED:zero_submit=1');
  const point = current.points[chosen.index - 1], physical = mapReferencePoint(info, point);
  await bridge.click(physical.x, physical.y);
  await sleep(Math.max(420, config.mouseSettleMs || 230));
  const recognized = normalizeRecognized(await recognizeCurrentCard(bridge, info, library, templates,
    { stableAcceptedSamples: 2 }));
  if (!recognized.accepted || recognized.id !== targetId) throw new Error('LINK_STRATEGY_TARGET_CHANGED:zero_submit=1');
  await sleep(250);
  const result = { selected: recognized, selectedPoint: point, selectedIndex: chosen.index, seen,
    strategyTargetId: targetId, excludedLinkIds: Array.from(excluded) };
  if (debugDir) writeJson(path.join(debugDir, 'selected_link_candidate.json'), result);
  return result;
}

async function clickBottomSummonSubmit({ bridge, info, debugDir }) {
  const started = Date.now();
  let lastYellow = 0;
  while (Date.now() - started < 4000) {
    const image = await captureReferenceRoi(bridge, info, BOTTOM_SUMMON_ROI);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'link_summon_submit_latest.png'));
    }
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    const expectedLocal = {
      x: EXTRA.summonDialog.confirmPoint.x - BOTTOM_SUMMON_ROI.x,
      y: EXTRA.summonDialog.confirmPoint.y - BOTTOM_SUMMON_ROI.y
    };
    const candidates = (stats.components || [])
      .filter(c => c.estimatedPixels >= 100 && c.width >= 20 && c.width <= 180 &&
        c.height >= 12 && c.height <= 50)
      .map(c => ({
        ...c,
        drift: Math.hypot(c.centerX - expectedLocal.x, c.centerY - expectedLocal.y)
      }))
      .sort((a, b) => a.drift - b.drift || b.estimatedPixels - a.estimatedPixels);
    const chosen = candidates[0] || null;
    if (chosen && lastYellow >= 250 && chosen.drift <= 40) {
      const reference = {
        x: BOTTOM_SUMMON_ROI.x + chosen.centerX,
        y: BOTTOM_SUMMON_ROI.y + chosen.centerY
      };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `Link候选“特殊召唤/选择”已点击: yellow=${lastYellow}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return { clickReference: reference, yellowPixels: lastYellow, component: chosen };
    }
    await sleep(120);
  }
  throw new Error(
    `D2_LINK_SUMMON_SUBMIT_NOT_PROVEN:yellow=${lastYellow};` +
    '候选已经选中，只允许重试提交按钮，不重新点候选卡。'
  );
}

async function proveCarrierMaterialSelectable({ bridge, info, anchorReference, debugDir, carrierMode = 'LINK' }) {
  const genericCarrier = String(carrierMode || 'LINK').toUpperCase() === 'GENERIC';
  const current = genericCarrier
    ? { visible: false, referenceCenter: null, detector: 'GENERIC_CARRIER_ANCHOR_V1' }
    : await captureObservedOwnLink({
        bridge,
        info,
        anchorReference,
        debugDir,
        label: 'carrier_material_current'
      });
  const reference = !genericCarrier && current.visible && current.referenceCenter
    ? current.referenceCenter
    : anchorReference;

  const roi = {
    x: Math.max(0, Math.round(reference.x - 110)),
    y: Math.max(0, Math.round(reference.y - 115)),
    width: 220,
    height: 230
  };
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugDir) saveRgbaPng(image, path.join(debugDir, 'carrier_material_highlight.png'));
  const yellow = yellowUsableStats(image);

  if ((!current.visible || genericCarrier) && yellow.estimatedYellowPixels < 450) {
    throw new Error(
      `D2_CARRIER_MATERIAL_NOT_PROVEN:mode=${genericCarrier ? 'GENERIC' : 'LINK'};` +
      `linkVisible=${current.visible ? 1 : 0};yellow=${yellow.estimatedYellowPixels};` +
      '只复用已经保存的真实carrier中心，不猜其它怪兽区。'
    );
  }

  console.log(
    `carrier素材可选证据: mode=${genericCarrier ? 'GENERIC' : 'LINK'}; ` +
    `linkFrame=${current.visible ? 'PASS' : 'ANCHOR_REUSE'}; ` +
    `yellowPixels=${yellow.estimatedYellowPixels}; ` +
    `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
  );
  return { reference, current, yellowPixels: yellow.estimatedYellowPixels, roi, carrierMode: genericCarrier ? 'GENERIC' : 'LINK' };
}

async function clickCarrierMaterial({ bridge, info, anchorReference, debugDir, carrierMode = 'LINK' }) {
  const proof = await proveCarrierMaterialSelectable({ bridge, info, anchorReference, debugDir, carrierMode });
  const physical = mapReferencePoint(info, proof.reference);
  await bridge.click(physical.x, physical.y);
  await sleep(220);
  console.log('已点击当前实际carrier作为Link素材；纯等待220ms后由蓝色确认按钮检测器自行轮询，不再点carrier。');
  return { ...proof, clickReference: proof.reference, afterClickWaitMs: 220 };
}

async function clickMaterialBlueConfirm({ bridge, info, anchorReference, debugDir }) {
  const started = Date.now();
  let lastProbe = null;
  let attempt = 0;
  while (Date.now() - started < 3500) {
    attempt++;
    const full = await captureReferenceRoi(bridge, info, {
      x: 0,
      y: 0,
      width: config.screen.width,
      height: config.screen.height
    });
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(full, path.join(debugDir, 'material_confirm_latest.png'));
    }
    const probe = detectEquipConfirmButton(full, anchorReference);
    lastProbe = probe;
    if (probe.visible && probe.chosen) {
      const reference = { x: probe.chosen.centerX, y: probe.chosen.centerY };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `Link素材蓝色确认: PASS; pixels=${probe.chosen.pixels}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return { clickReference: reference, probe, attempt };
    }
    await sleep(120);
  }
  throw new Error(
    `D2_MATERIAL_CONFIRM_NOT_PROVEN:passing=${lastProbe && lastProbe.passingCount || 0};` +
    'carrier已经选中，只允许重试确认按钮。'
  );
}

async function waitForPostLinkOptionalPool({ bridge, info, debugDir, timeoutMs = 9000 }) {
  const started = Date.now();
  let attempt = 0;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    last = await probeOptionalEffectPrompt({
      bridge,
      info,
      debugDir,
      suffix: `post_link_${String(attempt).padStart(2, '0')}`
    });
    if (last.visible) {
      console.log(
        `Link后可选效果池: PASS; candidates=${last.candidateCount}; ` +
        `detector=${last.detector}`
      );
      return { ...last, attempts: attempt };
    }
    await sleep(160);
  }
  throw new Error(
    `D2_POST_LINK_OPTIONAL_POOL_TIMEOUT:lastCandidates=${last && last.candidateCount || 0}`
  );
}

module.exports = {
  chooseExtraDeckSummonIcon,
  clickExtraDeckSummonButton,
  waitForSummonCandidates,
  selectNextLegalLink,
  clickBottomSummonSubmit,
  proveCarrierMaterialSelectable,
  clickCarrierMaterial,
  clickMaterialBlueConfirm,
  waitForPostLinkOptionalPool,
  preferredLinkIdsForCarrier
};
