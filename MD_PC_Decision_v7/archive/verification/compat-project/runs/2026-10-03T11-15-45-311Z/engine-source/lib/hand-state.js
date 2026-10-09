const config = require('../live-config');

const HAND_COUNT_INFO_NOT_FOUND = 'HAND_COUNT_INFO_NOT_FOUND';
const HAND_COUNT_INFO_AMBIGUOUS = 'HAND_COUNT_INFO_AMBIGUOUS';
const HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED = 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED';
const HAND_COUNT_SIDE_MISMATCH = 'HAND_COUNT_SIDE_MISMATCH';
const HAND_COUNT_FAN_LOW_CONFIDENCE = 'HAND_COUNT_FAN_LOW_CONFIDENCE';
const HAND_COUNT_MISMATCH = 'HAND_COUNT_MISMATCH';
const HAND_LAYOUT_UNSUPPORTED_COUNT = 'HAND_LAYOUT_UNSUPPORTED_COUNT';
const HAND_LAYOUT_LOW_CONFIDENCE = 'HAND_LAYOUT_LOW_CONFIDENCE';
const HAND_SLOT_UNSAFE = 'HAND_SLOT_UNSAFE';
const FIXED_FAN = 'FIXED_FAN';
const DENSE_HAND = 'DENSE_HAND';
const DENSE_HAND_RECOVERY_NOT_IMPLEMENTED = 'DENSE_HAND_RECOVERY_NOT_IMPLEMENTED';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  return {
    h: h / 2,          // 与OpenCV 0..179接近
    s: s * 255,
    v: max * 255
  };
}

function rgbAt(image, x, y) {
  x = clamp(Math.round(x), 0, image.width - 1);
  y = clamp(Math.round(y), 0, image.height - 1);
  const i = (y * image.width + x) * 4;
  return {
    r: image.data[i],
    g: image.data[i + 1],
    b: image.data[i + 2]
  };
}

function makeFanPositions(count) {
  const f = config.handFan;
  const out = [];
  const spacing = Math.max(
    f.minSpacing || f.spacing,
    f.spacing - Math.max(0, count - 5) * (f.spacingShrinkPerExtraCard || 0)
  );

  for (let i = 0; i < count; i++) {
    const d = i - (count - 1) / 2;
    out.push({
      index: i,
      d,
      x: Math.round(f.centerX + d * spacing),
      clickY: Math.round(f.clickBaseY + f.clickCurve * d * d),
      titleY: Math.round(f.titleBaseY + f.titleCurve * d * d),
      titleSlope: f.titleSlopePerSlot * d
    });
  }

  return out;
}

function getHandLayout(count) {
  const f = config.handFan;
  const n = Number(count);
  const fixedFanMax = f.fixedFanMax || 8;
  const denseHandMinCount = f.denseHandMinCount || (fixedFanMax + 1);

  if (!Number.isInteger(n) || n < f.minCount) {
    return {
      status: HAND_LAYOUT_UNSUPPORTED_COUNT,
      layoutMode: null,
      count,
      slots: []
    };
  }

  if (n >= denseHandMinCount) {
    return {
      status: DENSE_HAND_RECOVERY_NOT_IMPLEMENTED,
      layoutMode: DENSE_HAND,
      count: n,
      slots: []
    };
  }

  if (n > fixedFanMax) {
    return {
      status: HAND_LAYOUT_UNSUPPORTED_COUNT,
      layoutMode: null,
      count: n,
      slots: []
    };
  }

  return {
    status: 'OK',
    layoutMode: FIXED_FAN,
    count: n,
    slots: makeFanPositions(n)
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scoreEdgeHypothesis(candidateCenters, baselineCards, count) {
  const anchors = (Array.isArray(baselineCards) ? baselineCards : [])
    .map((card, fallbackIndex) => ({
      slot: Number(card && card.index) || fallbackIndex + 1,
      x: card && card.x != null ? Number(card.x) : Number.NaN
    }))
    .filter(anchor =>
      Number.isInteger(anchor.slot) && anchor.slot >= 1 && anchor.slot <= count &&
      Number.isFinite(anchor.x) && Number.isFinite(candidateCenters[anchor.slot - 1])
    )
    .map(anchor => ({
      ...anchor,
      drift: Math.abs(candidateCenters[anchor.slot - 1] - anchor.x)
    }));

  if (anchors.length < 2) return null;
  return {
    anchors,
    meanDrift: anchors.reduce((sum, anchor) => sum + anchor.drift, 0) / anchors.length,
    maxDrift: Math.max(...anchors.map(anchor => anchor.drift))
  };
}

function inferMissingEdgeFromBaseline(centers, count, baselineCards) {
  if (centers.length !== count - 1 || centers.length < 2) return null;

  const gaps = centers.slice(1).map((value, index) => value - centers[index]);
  const spacing = median(gaps);
  if (!Number.isFinite(spacing) || gaps.some(gap => gap < 90 || gap > 185)) return null;

  const leftSpacing = gaps[0];
  const rightSpacing = gaps[gaps.length - 1];
  const candidates = [
    {
      edge: 'LEFT',
      centers: [Math.round(centers[0] - leftSpacing), ...centers]
    },
    {
      edge: 'RIGHT',
      centers: [...centers, Math.round(centers[centers.length - 1] + rightSpacing)]
    }
  ].map(candidate => ({
    ...candidate,
    score: scoreEdgeHypothesis(candidate.centers, baselineCards, count)
  })).filter(candidate => candidate.score);

  if (candidates.length !== 2) return null;
  candidates.sort((a, b) => a.score.meanDrift - b.score.meanDrift);
  const best = candidates[0];
  const alternate = candidates[1];

  // Existing cards can shift slightly when one card is inserted, but the
  // correct edge hypothesis must stay close to every saved real TITLE anchor
  // and must beat the opposite edge by a wide margin.  This proves only the
  // slot mapping; callers still must refuse to click the inferred slot itself.
  if (best.score.maxDrift > 45 || alternate.score.meanDrift - best.score.meanDrift < 35) {
    return null;
  }

  return best;
}

function resolveExposedFanSlots(layout, componentEstimate, options = {}) {
  if (!layout || layout.status !== 'OK' || !Array.isArray(layout.slots)) {
    return { source: 'FIXED_FAN_GEOMETRY', slots: layout && layout.slots ? layout.slots : [] };
  }

  const count = layout.slots.length;
  if (!componentEstimate || !Array.isArray(componentEstimate.components)) {
    return { source: 'FIXED_FAN_GEOMETRY', slots: layout.slots };
  }

  let centers = componentEstimate.components
    .map(component => Number(component.centerX))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let inferredEdge = null;

  // A previously selected card can lose only its title component while all
  // neighbours remain visible. In that case one gap is roughly two normal
  // gaps; insert its centre instead of discarding the live layout.
  if (centers.length === count - 1 && centers.length >= 3) {
    const gaps = centers.slice(1).map((value, index) => value - centers[index]);
    let largestIndex = 0;
    for (let i = 1; i < gaps.length; i++) {
      if (gaps[i] > gaps[largestIndex]) largestIndex = i;
    }
    const normalGaps = gaps.filter((_, index) => index !== largestIndex);
    const normalSpacing = median(normalGaps);
    if (Number.isFinite(normalSpacing) && gaps[largestIndex] >= normalSpacing * 1.75) {
      centers.splice(largestIndex + 1, 0, Math.round(
        (centers[largestIndex] + centers[largestIndex + 1]) / 2
      ));
      inferredEdge = 'INTERNAL';
    }
  }

  // Low-hand incremental gains may leave the left detail pane open.  The
  // newly gained edge card can still have a real TITLE component while the
  // oldest left title is hidden.  Counts below seven do not have a reliable
  // absolute endpoint heuristic, so choose LEFT vs RIGHT only when at least
  // two saved real card centres uniquely support one hypothesis.
  if (centers.length === count - 1 && count < 7) {
    const inferred = inferMissingEdgeFromBaseline(
      centers,
      count,
      options && options.baselineCards
    );
    if (inferred) {
      centers = inferred.centers;
      inferredEdge = `${inferred.edge}_BASELINE`;
    }
  }

  // The outermost title strip can be partly covered by the left card-detail
  // panel.  That is normal during live scans: keep the measured centres and
  // infer only the missing edge instead of throwing the whole layout away.
  // For a seven-card fan the observed live layouts are either
  //   left missing:  [687, 825, ..., 1389]
  //   right missing: [550, 687, ..., 1230]
  // The endpoint makes the edge unambiguous; ambiguous samples remain safe
  // and fall back to the fixed geometry below.
  if (centers.length === count - 1 && count >= 7) {
    const gaps = centers.slice(1).map((value, index) => value - centers[index]);
    const spacing = median(gaps);
    if (Number.isFinite(spacing) && spacing >= 100 && spacing <= 175) {
      // A fan shifted right loses its left title (first observed centre is
      // around 688+); shifted left loses its right title (first is ~636).
      // Internal misses are rejected by the gap guard below.
      const missingLeftLikely = centers[0] >= 670;
      if (missingLeftLikely) {
        // Preserve the local edge curvature rather than using the global
        // median: the outer fan gap is measurably different from the middle.
        const edgeSpacing = centers[1] - centers[0];
        centers = [Math.round(centers[0] - edgeSpacing), ...centers];
        inferredEdge = 'LEFT';
      } else {
        const edgeSpacing = centers[centers.length - 1] - centers[centers.length - 2];
        centers = [...centers, Math.round(centers[centers.length - 1] + edgeSpacing)];
        inferredEdge = 'RIGHT';
      }
    }
  }

  if (centers.length !== count) {
    return { source: 'FIXED_FAN_GEOMETRY', slots: layout.slots };
  }

  const gaps = centers.slice(1).map((value, index) => value - centers[index]);
  if (gaps.some(gap => gap < 90 || gap > 185)) {
    return { source: 'FIXED_FAN_GEOMETRY', slots: layout.slots };
  }

  return {
    source: inferredEdge ? `TITLE_COMPONENTS_INFERRED_${inferredEdge}` : 'TITLE_COMPONENTS',
    inferredEdge,
    slots: layout.slots.map((slot, index) => ({ ...slot, x: Math.round(centers[index]) }))
  };
}

function detectHandCount(handImage, options = {}) {
  const fan = detectHandCountFromImage(handImage, options.previousCount || null);
  const fanCount = fan.best ? fan.best.count : null;
  const fanConfidence = fan.best ? fan.best.quality : 0;
  const minConfidence = options.minFanConfidence || 0;

  if (!fan.best || (minConfidence && fanConfidence < minConfidence)) {
    return {
      status: HAND_COUNT_FAN_LOW_CONFIDENCE,
      handCount: null,
      handCountSource: 'FAN_GEOMETRY',
      handCountConfidence: fanConfidence,
      fan
    };
  }

  return {
    status: fan.best.valid ? 'OK' : HAND_COUNT_FAN_LOW_CONFIDENCE,
    handCount: fanCount,
    handCountSource: 'FAN_GEOMETRY',
    handCountConfidence: fanConfidence,
    fan
  };
}

function isMonsterHeader(hsv) {
  return hsv.h >= 5 && hsv.h <= 28 && hsv.s >= 55 && hsv.v >= 60 && hsv.v <= 225;
}

function isSpellHeader(hsv) {
  return hsv.h >= 76 && hsv.h <= 96 && hsv.s >= 55 && hsv.v >= 55 && hsv.v <= 215;
}

function headerScoreForSlot(handImage, detectRoi, slot) {
  const f = config.handFan;
  const localX = slot.x - detectRoi.x;
  const localY = slot.titleY - detectRoi.y;

  let best = 0;
  const halfW = f.titleSampleHalfWidth;
  const halfH = f.titleSampleHalfHeight;

  for (let oy = -halfH; oy <= halfH; oy += 2) {
    let monster = 0;
    let spell = 0;
    let total = 0;

    for (let dx = -halfW; dx <= halfW; dx++) {
      const x = localX + dx;
      const y = localY + oy + slot.titleSlope * dx;

      if (x < 0 || y < 0 || x >= handImage.width || y >= handImage.height) continue;

      const c = rgbAt(handImage, x, y);
      const hsv = rgbToHsv(c.r, c.g, c.b);
      if (isMonsterHeader(hsv)) monster++;
      if (isSpellHeader(hsv)) spell++;
      total++;
    }

    if (total > 0) {
      best = Math.max(best, monster / total, spell / total);
    }
  }

  return best;
}

function titleMaskPixel(hsv) {
  return (
    ((isMonsterHeader(hsv) || isSpellHeader(hsv)) &&
      hsv.s >= 55 &&
      hsv.v >= 55 &&
      hsv.v <= 225)
  );
}

function estimateHandCountByTitleComponents(handImage) {
  const f = config.handFan;
  const roi = f.titleComponentRoi;
  if (!roi) return null;

  const x0 = clamp(roi.x, 0, handImage.width - 1);
  const y0 = clamp(roi.y, 0, handImage.height - 1);
  const x1 = clamp(roi.x + roi.width, 0, handImage.width);
  const y1 = clamp(roi.y + roi.height, 0, handImage.height);
  const minColumnPixels = f.titleComponentMinColumnPixels || 6;
  const minWidth = f.titleComponentMinWidth || 70;
  const maxWidth = f.titleComponentMaxWidth || 190;
  const columns = [];

  for (let x = x0; x < x1; x++) {
    let hits = 0;
    for (let y = y0; y < y1; y++) {
      const c = rgbAt(handImage, x, y);
      if (titleMaskPixel(rgbToHsv(c.r, c.g, c.b))) hits++;
    }
    columns.push(hits);
  }

  const components = [];
  let active = false;
  let start = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i <= columns.length; i++) {
    if (i < columns.length && columns[i] >= minColumnPixels) {
      if (!active) {
        active = true;
        start = i;
        sum = 0;
        max = 0;
      }
      sum += columns[i];
      max = Math.max(max, columns[i]);
    } else if (active) {
      const end = i - 1;
      const width = end - start + 1;
      if (width >= minWidth && width <= maxWidth) {
        components.push({
          x: x0 + start,
          width,
          centerX: x0 + Math.round((start + end) / 2),
          sum,
          max
        });
      }
      active = false;
    }
  }

  return components.length ? {
    count: components.length,
    components
  } : null;
}

function detectHandCountFromImage(handImage, previousCount = null) {
  const f = config.handFan;
  const roi = f.detectRoi;
  const candidates = [];

  for (let count = f.minCount; count <= f.maxCount; count++) {
    const positions = makeFanPositions(count);
    const slotScores = positions.map(p => headerScoreForSlot(handImage, roi, p));
    const min = Math.min(...slotScores);
    const mean = slotScores.reduce((a, b) => a + b, 0) / slotScores.length;
    const valid = min >= f.minSlotHeaderScore && mean >= f.minMeanHeaderScore;

    // previousCount只作为轻微先验，绝不覆盖视觉结果。
    const prior = previousCount == null ? 0 : Math.max(0, 0.03 - Math.abs(count - previousCount) * 0.008);
    const quality = min * 0.68 + mean * 0.32 + prior;

    candidates.push({ count, positions, slotScores, min, mean, valid, quality });
  }

  const valid = candidates.filter(c => c.valid);
  const componentEstimate = estimateHandCountByTitleComponents(handImage);
  let best;

  if (componentEstimate) {
    const estimated = valid.find(c => c.count === componentEstimate.count);
    if (estimated) {
      best = estimated;
      best.componentEstimate = componentEstimate;
    }
  }

  if (!best && valid.length) {
    // 对同一奇偶布局，较小数量往往是较大数量的子集，因此优先取“仍然全部通过”的最大数量。
    best = valid.sort((a, b) => b.count - a.count || b.quality - a.quality)[0];
  } else {
    best = best || candidates.slice().sort((a, b) => b.quality - a.quality)[0];
  }

  return { best, candidates, componentEstimate };
}

function yellowUsableStats(image) {
  const u = config.usableMagic;
  let yellow = 0;
  let total = 0;
  const sampleStep = 2;
  const sampleWidth = Math.ceil(image.width / sampleStep);
  const sampleHeight = Math.ceil(image.height / sampleStep);
  const mask = new Uint8Array(sampleWidth * sampleHeight);

  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      const c = rgbAt(image, x, y);
      const hsv = rgbToHsv(c.r, c.g, c.b);
      if (
        hsv.h >= u.yellowHueMin &&
        hsv.h <= u.yellowHueMax &&
        hsv.s >= u.yellowSatMin &&
        hsv.v >= u.yellowValMin
      ) {
        yellow++;
        mask[Math.floor(y / sampleStep) * sampleWidth + Math.floor(x / sampleStep)] = 1;
      }
      total++;
    }
  }

  const seen = new Uint8Array(mask.length);
  const components = [];
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = sampleWidth;
    let minY = sampleHeight;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const idx = queue[head++];
      const sx = idx % sampleWidth;
      const sy = Math.floor(idx / sampleWidth);
      count++;
      sumX += sx;
      sumY += sy;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = sx + ox;
          const ny = sy + oy;
          if (nx < 0 || ny < 0 || nx >= sampleWidth || ny >= sampleHeight) continue;
          const ni = ny * sampleWidth + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          queue[tail++] = ni;
        }
      }
    }

    const width = (maxX - minX + 1) * sampleStep;
    const height = (maxY - minY + 1) * sampleStep;
    components.push({
      estimatedPixels: count * sampleStep * sampleStep,
      x: minX * sampleStep,
      y: minY * sampleStep,
      width,
      height,
      aspect: width / Math.max(1, height),
      fillRatio: count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1)),
      centerX: Math.round((sumX / count) * sampleStep),
      centerY: Math.round((sumY / count) * sampleStep)
    });
  }

  const buttonRules = (config.toonChain && config.toonChain.activationButton) || {};
  const buttonComponent = components
    .filter(c =>
      c.estimatedPixels >= (buttonRules.minComponentPixels || 80) &&
      c.aspect >= (buttonRules.minAspect || 1.15) &&
      c.aspect <= (buttonRules.maxAspect || 8.0) &&
      c.fillRatio >= (buttonRules.minFillRatio || 0.12)
    )
    .sort((a, b) => b.estimatedPixels - a.estimatedPixels)[0] || null;

  // 因为隔点采样，换算成近似原始像素数量。
  const estimatedPixels = yellow * 4;
  return {
    estimatedYellowPixels: estimatedPixels,
    yellowRatio: total ? yellow / total : 0,
    usable: estimatedPixels >= u.minYellowPixels,
    components: components.sort((a, b) => b.estimatedPixels - a.estimatedPixels),
    buttonComponent
  };
}

function isSpellCardId(id) {
  const m = /^M(\d+)$/.exec(String(id || ''));
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 9 && n <= 22;
}

module.exports = {
  HAND_COUNT_INFO_NOT_FOUND,
  HAND_COUNT_INFO_AMBIGUOUS,
  HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED,
  HAND_COUNT_SIDE_MISMATCH,
  HAND_COUNT_FAN_LOW_CONFIDENCE,
  HAND_COUNT_MISMATCH,
  HAND_LAYOUT_UNSUPPORTED_COUNT,
  HAND_LAYOUT_LOW_CONFIDENCE,
  HAND_SLOT_UNSAFE,
  FIXED_FAN,
  DENSE_HAND,
  DENSE_HAND_RECOVERY_NOT_IMPLEMENTED,
  makeFanPositions,
  getHandLayout,
  resolveExposedFanSlots,
  detectHandCount,
  estimateHandCountByTitleComponents,
  detectHandCountFromImage,
  yellowUsableStats,
  isSpellCardId
};
