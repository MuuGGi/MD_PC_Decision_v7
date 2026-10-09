const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const config = require('../live-config');

const DEFAULT_TEMPLATE_SIZE = { width: 28, height: 36 };
const INFO_SIDES = Object.freeze({ OWN: 'OWN', OPPONENT: 'OPPONENT' });

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function readPngSync(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function writePngSync(image, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(image));
}

function rgbAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2] };
}

function isInfoDigitPixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max >= 180 && min >= 150 && max - min <= 85;
}

function normalizeSide(side) {
  const normalized = String(side || INFO_SIDES.OWN).toUpperCase();
  if (normalized !== INFO_SIDES.OWN && normalized !== INFO_SIDES.OPPONENT) {
    throw new Error(`Unsupported INFO hand side: ${side}`);
  }
  return normalized;
}

function getInfoHandCountRoi(side = INFO_SIDES.OWN) {
  const overlay = config.handFan.infoOverlay;
  return normalizeSide(side) === INFO_SIDES.OWN ? overlay.ownRoi : overlay.opponentRoi;
}

function buildMask(image, roi) {
  const x0 = clamp(Math.round(roi.x), 0, image.width - 1);
  const y0 = clamp(Math.round(roi.y), 0, image.height - 1);
  const width = clamp(Math.round(roi.width), 1, image.width - x0);
  const height = clamp(Math.round(roi.height), 1, image.height - y0);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = rgbAt(image, x0 + x, y0 + y);
      if (isInfoDigitPixel(c.r, c.g, c.b)) mask[y * width + x] = 1;
    }
  }
  return { x0, y0, width, height, mask };
}

function connectedComponents(maskData) {
  const { width, height, mask } = maskData;
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let pixels = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    queue[tail++] = start;
    seen[start] = 1;
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
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          queue[tail++] = ni;
        }
      }
    }
    components.push({
      pixels,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: sumX / pixels,
      centerY: sumY / pixels
    });
  }
  return components;
}

function isDigitCandidate(component) {
  return component.pixels >= 20 &&
    component.width >= 3 && component.width <= 42 &&
    component.height >= 20 && component.height <= 58;
}

function componentsCanFormInteger(left, right) {
  const gap = right.x - (left.x + left.width);
  const centerDelta = Math.abs(left.centerY - right.centerY);
  const heightRatio = Math.min(left.height, right.height) / Math.max(left.height, right.height);
  return gap >= -2 && gap <= 18 && centerDelta <= 8 && heightRatio >= 0.62;
}

function groupGeometryScore(group, maskData) {
  const left = group[0].x;
  const right = group[group.length - 1].x + group[group.length - 1].width;
  const center = (left + right) / 2;
  const expectedCenter = maskData.width * 0.62;
  const centerScore = 1 - Math.min(1, Math.abs(center - expectedCenter) / (maskData.width * 0.45));
  const meanHeight = group.reduce((sum, c) => sum + c.height, 0) / group.length;
  return centerScore * 0.7 + Math.min(1, meanHeight / 32) * 0.3;
}

function buildCandidateGroups(candidates, maskData) {
  const sorted = candidates.slice().sort((a, b) => a.x - b.x);
  const groups = sorted.map(component => [component]);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (componentsCanFormInteger(sorted[i], sorted[i + 1])) groups.push([sorted[i], sorted[i + 1]]);
  }
  return groups
    .map(components => ({ components, geometryScore: groupGeometryScore(components, maskData) }))
    .sort((a, b) => b.geometryScore - a.geometryScore);
}

function normalizeComponent(maskData, component, size = DEFAULT_TEMPLATE_SIZE) {
  const pad = 2;
  const srcX = clamp(component.x - pad, 0, maskData.width - 1);
  const srcY = clamp(component.y - pad, 0, maskData.height - 1);
  const srcW = clamp(component.width + pad * 2, 1, maskData.width - srcX);
  const srcH = clamp(component.height + pad * 2, 1, maskData.height - srcY);
  const sample = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const sx = srcX + Math.min(srcW - 1, Math.floor((x / size.width) * srcW));
      const sy = srcY + Math.min(srcH - 1, Math.floor((y / size.height) * srcH));
      sample[y * size.width + x] = maskData.mask[sy * maskData.width + sx] ? 1 : 0;
    }
  }
  return {
    width: size.width,
    height: size.height,
    data: sample,
    sourceBox: { x: maskData.x0 + srcX, y: maskData.y0 + srcY, width: srcW, height: srcH }
  };
}

function sampleToPng(sample) {
  const png = new PNG({ width: sample.width, height: sample.height });
  for (let y = 0; y < sample.height; y++) {
    for (let x = 0; x < sample.width; x++) {
      const on = sample.data[y * sample.width + x] ? 255 : 0;
      const i = (y * sample.width + x) * 4;
      png.data[i] = on;
      png.data[i + 1] = on;
      png.data[i + 2] = on;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function sampleFromPng(image) {
  const data = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      data[y * image.width + x] = image.data[i] > 127 ? 1 : 0;
    }
  }
  return { width: image.width, height: image.height, data };
}

function compareSamples(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;
  let mismatch = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) mismatch++;
  return 1 - mismatch / a.data.length;
}

function absoluteComponent(maskData, component) {
  return {
    x: maskData.x0 + component.x,
    y: maskData.y0 + component.y,
    width: component.width,
    height: component.height,
    pixels: component.pixels,
    centerX: maskData.x0 + component.centerX,
    centerY: maskData.y0 + component.centerY
  };
}

function extractInfoDigitComponents(image, options = {}) {
  const side = normalizeSide(options.side);
  const roi = options.roi || getInfoHandCountRoi(side);
  const maskData = buildMask(image, roi);
  const allComponents = connectedComponents(maskData);
  const candidates = allComponents.filter(isDigitCandidate);
  const groups = buildCandidateGroups(candidates, maskData);
  return {
    status: groups.length ? 'OK' : 'HAND_COUNT_INFO_NOT_FOUND',
    side,
    roi,
    maskData,
    components: allComponents.map(c => absoluteComponent(maskData, c)),
    digitCandidates: candidates.map(c => absoluteComponent(maskData, c)),
    groups
  };
}

function loadInfoDigitTemplates(rootDir, templateDir = config.handFan.infoOverlay.templateDir) {
  const dir = path.resolve(rootDir, templateDir);
  const templates = [];
  for (let digit = 0; digit <= 9; digit++) {
    const filePath = path.join(dir, `hand_count_info_${digit}.png`);
    if (!fs.existsSync(filePath)) continue;
    templates.push({ digit, filePath, sample: sampleFromPng(readPngSync(filePath)) });
  }
  return templates;
}

function recognizeDigitComponent(maskData, component, templates, minConfidence) {
  const sample = normalizeComponent(maskData, component);
  const ranked = templates
    .map(t => ({ digit: t.digit, confidence: compareSamples(sample, t.sample), filePath: t.filePath }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const margin = best && runnerUp ? best.confidence - runnerUp.confidence : 1;
  const minMargin = config.handFan.infoOverlay.minDigitMargin || 0;
  return {
    status: best && best.confidence >= minConfidence && margin >= minMargin
      ? 'OK'
      : margin < minMargin
        ? 'HAND_COUNT_INFO_AMBIGUOUS'
        : 'HAND_COUNT_INFO_NOT_FOUND',
    digit: best ? best.digit : null,
    confidence: best ? best.confidence : 0,
    margin,
    sample,
    ranked
  };
}

function combineRecognizedDigits(recognizedDigits) {
  if (!Array.isArray(recognizedDigits) || !recognizedDigits.length || recognizedDigits.length > 2) {
    return { status: 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED', value: null };
  }
  if (recognizedDigits.some(item => !Number.isInteger(item.digit) || item.digit < 0 || item.digit > 9)) {
    return { status: 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED', value: null };
  }
  const text = recognizedDigits.map(item => item.digit).join('');
  if (text.length > 1 && text.startsWith('0')) {
    return { status: 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED', value: null };
  }
  return { status: 'OK', value: Number(text), text };
}

function selectInfoGroup(recognizedGroups, options = {}) {
  const maxCount = Number.isInteger(options.maxCount)
    ? options.maxCount
    : Number(config.handFan.maxCount || 12);
  const groups = Array.isArray(recognizedGroups)
    ? recognizedGroups
      // Production hand-count rule: standalone 1 is not a legal INFO result.
      // It is reserved out because 11 can expose a strong singleton "1" glyph;
      // allowing value=1 back into the group competition can regress 11 -> 1.
      // The two-digit group value=11 remains legal and is still preferred below.
      .filter(group =>
        Number.isInteger(group.value) &&
        group.value >= 0 &&
        group.value <= maxCount &&
        group.value !== 1
      )
      .slice()
      .sort((a, b) => b.score - a.score)
    : [];
  if (!groups.length) return { best: null, comparisonPool: [], preferredDigitCount: null };

  // A two-digit display naturally also produces two strong one-digit groups
  // (the left and right glyph separately).  Comparing those singleton groups
  // directly against the real pair caused 10/11/12 to be reported as
  // HAND_COUNT_INFO_AMBIGUOUS even when both digits were read correctly.
  //
  // Master Duel's hand fan is guarded to maxCount (currently 12), therefore a
  // plausible two-digit hand count can only be 10..maxCount.  Prefer such a
  // pair when it scores close to the best raw candidate, then perform the
  // ambiguity check only against other candidates with the same digit count.
  const tolerance = Number.isFinite(options.multiDigitPreferenceScoreTolerance)
    ? options.multiDigitPreferenceScoreTolerance
    : Number(config.handFan.infoOverlay.multiDigitPreferenceScoreTolerance || 0.04);
  const bestOverall = groups[0];
  const plausiblePairs = groups.filter(group =>
    Array.isArray(group.digits) &&
    group.digits.length === 2 &&
    Number.isInteger(group.value) &&
    group.value >= 10 &&
    group.value <= maxCount
  );

  if (plausiblePairs.length) {
    const bestPair = plausiblePairs[0];
    if (bestPair.score >= bestOverall.score - tolerance) {
      return { best: bestPair, comparisonPool: plausiblePairs, preferredDigitCount: 2 };
    }
  }

  const digitCount = Array.isArray(bestOverall.digits) ? bestOverall.digits.length : 1;
  return {
    best: bestOverall,
    comparisonPool: groups.filter(group =>
      (Array.isArray(group.digits) ? group.digits.length : 1) === digitCount
    ),
    preferredDigitCount: digitCount
  };
}

function recognizeInfoInteger(image, options = {}) {
  const templates = options.templates || [];
  const minConfidence = options.minConfidence || config.handFan.infoOverlay.minConfidence || 0.72;
  const extracted = extractInfoDigitComponents(image, options);
  if (extracted.status !== 'OK') return extracted;
  const recognizedGroups = [];
  for (const group of extracted.groups) {
    const digits = group.components.map(component =>
      recognizeDigitComponent(extracted.maskData, component, templates, minConfidence)
    );
    if (digits.some(digit => digit.status !== 'OK')) continue;
    const combined = combineRecognizedDigits(digits);
    if (combined.status !== 'OK') continue;
    const confidence = digits.reduce((sum, digit) => sum + digit.confidence, 0) / digits.length;
    recognizedGroups.push({
      value: combined.value,
      text: combined.text,
      confidence,
      score: confidence * 0.88 + group.geometryScore * 0.12,
      geometryScore: group.geometryScore,
      digits,
      components: group.components.map(component => absoluteComponent(extracted.maskData, component))
    });
  }
  recognizedGroups.sort((a, b) => b.score - a.score);
  const selection = selectInfoGroup(recognizedGroups, options);
  const best = selection.best;
  if (!best) {
    const hasPair = extracted.groups.some(group => group.components.length === 2);
    return {
      ...extracted,
      status: hasPair ? 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED' : 'HAND_COUNT_INFO_NOT_FOUND',
      recognizedGroups
    };
  }
  const ambiguityMargin = Number.isFinite(options.groupAmbiguityMargin)
    ? options.groupAmbiguityMargin
    : 0.015;
  const conflicting = selection.comparisonPool.find(group =>
    group !== best && group.value !== best.value && best.score - group.score < ambiguityMargin
  );
  if (conflicting) {
    return {
      ...extracted,
      status: 'HAND_COUNT_INFO_AMBIGUOUS',
      recognizedGroups,
      preferredDigitCount: selection.preferredDigitCount
    };
  }
  return {
    ...extracted,
    status: 'OK',
    handCount: best.value,
    handCountSource: `INFO_OVERLAY_${extracted.side}`,
    handCountConfidence: best.confidence,
    sourceBoxes: best.digits.map(digit => digit.sample.sourceBox),
    recognizedDigits: best.digits.map(digit => ({
      digit: digit.digit,
      confidence: digit.confidence,
      sourceBox: digit.sample.sourceBox,
      ranked: digit.ranked
    })),
    preferredDigitCount: selection.preferredDigitCount,
    recognizedGroups
  };
}

function recognizeInfoHandCount(image, options = {}) {
  return recognizeInfoInteger(image, options);
}

function readOwnHandCountFromInfoOverlay(image, options = {}) {
  return recognizeInfoInteger(image, { ...options, side: INFO_SIDES.OWN });
}

function readOpponentHandCountFromInfoOverlay(image, options = {}) {
  return recognizeInfoInteger(image, { ...options, side: INFO_SIDES.OPPONENT });
}

function validateInfoHandCountSides(own, opponent, expected = {}) {
  if (!own || own.status !== 'OK') return { status: own ? own.status : 'HAND_COUNT_INFO_NOT_FOUND' };
  if (!opponent || opponent.status !== 'OK') {
    return { status: opponent ? opponent.status : 'HAND_COUNT_INFO_NOT_FOUND' };
  }

  const expectedOwn = Number(expected.own);
  const expectedOpponent = Number(expected.opponent);
  const hasExpected = Number.isInteger(expectedOwn) && Number.isInteger(expectedOpponent);
  if (!hasExpected) return { status: 'OK' };

  if (
    expectedOwn !== expectedOpponent &&
    own.handCount === expectedOpponent &&
    opponent.handCount === expectedOwn
  ) {
    return { status: 'HAND_COUNT_SIDE_MISMATCH' };
  }
  if (own.handCount !== expectedOwn || opponent.handCount !== expectedOpponent) {
    return { status: 'HAND_COUNT_MISMATCH' };
  }
  return { status: 'OK' };
}

function extractInfoDigitSamples(image, roiOrOptions, digitCount = null) {
  const options = roiOrOptions && Number.isFinite(roiOrOptions.x)
    ? { roi: roiOrOptions, side: INFO_SIDES.OWN }
    : (roiOrOptions || { side: INFO_SIDES.OWN });
  const extracted = extractInfoDigitComponents(image, options);
  if (extracted.status !== 'OK') return extracted;

  const preferredCount = Number.isInteger(digitCount) ? digitCount : null;
  const group = extracted.groups.find(candidate =>
    preferredCount == null || candidate.components.length === preferredCount
  );
  if (!group) {
    return {
      ...extracted,
      status: preferredCount && preferredCount > 1
        ? 'HAND_COUNT_INFO_MULTI_DIGIT_PARSE_FAILED'
        : 'HAND_COUNT_INFO_NOT_FOUND'
    };
  }

  return {
    ...extracted,
    group,
    components: group.components.map(component => absoluteComponent(extracted.maskData, component)),
    samples: group.components.map(component => normalizeComponent(extracted.maskData, component))
  };
}

function extractInfoDigitSample(image, roiOrOptions) {
  const extracted = extractInfoDigitSamples(image, roiOrOptions, 1);
  if (extracted.status !== 'OK' || !extracted.samples || !extracted.samples.length) return extracted;
  return {
    ...extracted,
    component: extracted.components[0],
    sample: extracted.samples[0]
  };
}

function saveInfoDigitTemplate(sample, filePath) {
  writePngSync(sampleToPng(sample), filePath);
}

module.exports = {
  DEFAULT_TEMPLATE_SIZE,
  INFO_SIDES,
  readPngSync,
  writePngSync,
  getInfoHandCountRoi,
  extractInfoDigitComponents,
  extractInfoDigitSample,
  extractInfoDigitSamples,
  recognizeDigitComponent,
  selectInfoGroup,
  combineRecognizedDigits,
  recognizeInfoInteger,
  recognizeInfoHandCount,
  readOwnHandCountFromInfoOverlay,
  readOpponentHandCountFromInfoOverlay,
  validateInfoHandCountSides,
  loadInfoDigitTemplates,
  saveInfoDigitTemplate,
  sampleToPng
};
