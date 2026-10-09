'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { captureReferenceRoi, mapReferencePoint, sleep } = require('./win-fast');
const { cropImage } = require('./png-utils');
const { recognizeVisibleCardEvents } = require('./duel-log-reader');
const { ensureDir, writeJson } = require('./runtime-files');
const { EXODIA_COMPONENT_IDS } = require('./exodia-policy');

function listOutcomeMaterials(rootDir) {
  const base = path.join(rootDir, 'materials', 'ui', 'outcomes');
  if (!fs.existsSync(base)) return [];
  const rows = [];
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const metaPath = path.join(dir, 'material.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const signaturePath = path.join(dir, meta.signatureImage || 'signature_001.png');
    if (!fs.existsSync(signaturePath)) continue;
    rows.push({ dir, meta, signaturePath });
  }
  return rows;
}


const EXODIA_IDS = EXODIA_COMPONENT_IDS;
const EXODIA_ID_SET = new Set(EXODIA_IDS);

function loadOutcomeCardTemplates(rootDir) {
  const libraryPath = path.join(rootDir, 'card-library.json');
  const templatesDir = path.join(rootDir, 'templates');
  if (!fs.existsSync(libraryPath) || !fs.existsSync(templatesDir)) return [];
  const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
  const files = fs.readdirSync(templatesDir).filter(name => /\.png$/i.test(name));
  const rows = [];
  for (const card of library.cards || []) {
    const file = files.find(name => name.startsWith(`${card.id}_`));
    if (!file) continue;
    try {
      rows.push({ ...card, image: PNG.sync.read(fs.readFileSync(path.join(templatesDir, file))) });
    } catch (_) {
      // Missing/corrupt ordinary card templates must not crash terminal
      // detection; the strict five-piece check will simply fail closed.
    }
  }
  return rows;
}

function detectOutcomeLogScrollbarRail(image) {
  if (!image || image.width <= 2020 || image.height <= 1028) return null;
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
    const primary = segments.slice()
      .sort((left, right) => (right.bottom - right.top) - (left.bottom - left.top))[0];
    const length = primary.bottom - primary.top + 1;
    candidates.push({ x, primary, length });
  }
  if (!candidates.length) return null;
  const best = candidates.sort((left, right) => right.length - left.length)[0];
  return best.length >= 80 ? { ...best.primary, x: best.x, railLength: best.length } : null;
}

function detectExodiaLastFiveRightLog(image, rootDir) {
  const rightPanel = { x: 1674, y: 150, width: 348, height: 886 };
  const cardTemplates = loadOutcomeCardTemplates(rootDir);
  if (!cardTemplates.length) {
    return { matched: false, reason: 'OUTCOME_CARD_TEMPLATES_MISSING', lastFiveIds: [], rows: [] };
  }

  const events = recognizeVisibleCardEvents(image, rightPanel, rightPanel.y, cardTemplates)
    .filter(event => event && event.type === 'ACTIVATE' && event.card && event.box)
    .sort((left, right) => left.box.y - right.box.y);
  const lastFive = events.slice(-5);
  const lastFiveIds = lastFive.map(event => String(event.card.id || 'UNKNOWN'));
  // Component identity is deliberately irrelevant.  Template classification
  // may confuse one limb with another; the terminal proof only needs five
  // consecutive component-class rows together with the victory overlay.
  const allFive = lastFive.length === 5 && lastFiveIds.every(id => EXODIA_ID_SET.has(id));
  const strong = allFive && lastFive.every(event => Number(event.card.mad) <= 0.36);

  return {
    matched: strong,
    reason: strong
      ? 'RIGHT_LOG_LAST_FIVE_ARE_EXODIA_COMPONENTS'
      : allFive
        ? 'RIGHT_LOG_LAST_FIVE_EXODIA_COMPONENTS_TOO_WEAK'
        : 'RIGHT_LOG_LAST_FIVE_NOT_ALL_EXODIA_COMPONENTS',
    lastFiveIds,
    expectedIds: EXODIA_IDS.slice(),
    rows: lastFive.map(event => ({
      id: event.card.id,
      name: event.card.name,
      mad: event.card.mad,
      x: event.box.x,
      y: event.box.y
    }))
  };
}

async function verifyExodiaLastFiveEvidence(options) {
  const { rootDir, sourceImage, bridge, info } = options;
  let full = sourceImage;
  let panelOpenedForCheck = false;
  let evidence = detectExodiaLastFiveRightLog(full, rootDir);
  if (evidence.matched) return { ...evidence, panelOpenedForCheck };

  // On the victory overlay, opening the history pane is a terminal-screen UI
  // action only. If the pane is clearly closed, open it once and retry. Never
  // toggle an already-open pane merely because card recognition was weak.
  const rail = detectOutcomeLogScrollbarRail(full);
  if (!rail && bridge && info) {
    const point = mapReferencePoint(info, { x: 1985, y: 1084 });
    await bridge.click(point.x, point.y);
    await sleep(500);
    full = await captureReferenceRoi(bridge, info, {
      x: 0,
      y: 0,
      width: sourceImage.width,
      height: sourceImage.height
    });
    panelOpenedForCheck = true;
    evidence = detectExodiaLastFiveRightLog(full, rootDir);
  }
  return { ...evidence, panelOpenedForCheck };
}

function isBrightNeutral(data, offset, cfg) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= Number(cfg.brightMin || 190) && (max - min) <= Number(cfg.maxChroma || 80);
}

function buildSampledMask(image, cfg) {
  const step = Math.max(1, Number(cfg.sampleStep || 2));
  const cols = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const mask = new Uint8Array(cols * rows);
  let bright = 0;
  for (let gy = 0, y = 0; y < image.height; gy++, y += step) {
    for (let gx = 0, x = 0; x < image.width; gx++, x += step) {
      const offset = (y * image.width + x) * 4;
      if (isBrightNeutral(image.data, offset, cfg)) {
        mask[gy * cols + gx] = 1;
        bright++;
      }
    }
  }
  return { mask, cols, rows, bright, total: cols * rows, step };
}

function compareBrightMasks(referenceImage, currentImage, cfg = {}) {
  if (!referenceImage || !currentImage ||
      referenceImage.width !== currentImage.width || referenceImage.height !== currentImage.height) {
    return { matched: false, reason: 'SIZE_MISMATCH', recall: 0, precision: 0, iou: 0 };
  }

  const ref = buildSampledMask(referenceImage, cfg);
  const cur = buildSampledMask(currentImage, cfg);
  const minReferenceBrightRatio = Number(cfg.minReferenceBrightRatio || 0.20);
  if (!ref.total || ref.bright / ref.total < minReferenceBrightRatio) {
    return { matched: false, reason: 'REFERENCE_MASK_TOO_SPARSE', recall: 0, precision: 0, iou: 0 };
  }

  const maxShiftPx = Math.max(0, Number(cfg.maxShiftPx || 0));
  const maxShiftCells = Math.ceil(maxShiftPx / ref.step);
  let best = null;
  for (let dy = -maxShiftCells; dy <= maxShiftCells; dy++) {
    for (let dx = -maxShiftCells; dx <= maxShiftCells; dx++) {
      let intersection = 0;
      for (let y = 0; y < ref.rows; y++) {
        const yy = y + dy;
        if (yy < 0 || yy >= cur.rows) continue;
        const refRow = y * ref.cols;
        const curRow = yy * cur.cols;
        for (let x = 0; x < ref.cols; x++) {
          if (!ref.mask[refRow + x]) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= cur.cols) continue;
          if (cur.mask[curRow + xx]) intersection++;
        }
      }
      const recall = intersection / Math.max(1, ref.bright);
      const precision = intersection / Math.max(1, cur.bright);
      const union = ref.bright + cur.bright - intersection;
      const iou = intersection / Math.max(1, union);
      const score = recall * 0.65 + iou * 0.35;
      if (!best || score > best.score) {
        best = { score, recall, precision, iou, dxCells: dx, dyCells: dy };
      }
    }
  }

  const minRecall = Number(cfg.minRecall || 0.70);
  const minIoU = Number(cfg.minIoU || 0.45);
  return {
    ...best,
    matched: Boolean(best && best.recall >= minRecall && best.iou >= minIoU),
    referenceBrightRatio: ref.bright / Math.max(1, ref.total),
    currentBrightRatio: cur.bright / Math.max(1, cur.total),
    shiftPx: best ? { x: best.dxCells * ref.step, y: best.dyCells * ref.step } : { x: 0, y: 0 }
  };
}

function classifyOutcomeImage(currentImage, material) {
  const signature = PNG.sync.read(fs.readFileSync(material.signaturePath));
  const metrics = compareBrightMasks(signature, currentImage, material.meta.detector || {});
  return {
    terminal: metrics.matched,
    type: metrics.matched ? String(material.meta.result || material.meta.id || 'UNKNOWN') : 'NONE',
    materialId: material.meta.id || null,
    materialName: material.meta.name || null,
    metrics
  };
}

function rgbDistance(aR, aG, aB, bR, bG, bB) {
  return (Math.abs(aR - bR) + Math.abs(aG - bG) + Math.abs(aB - bB)) / 3;
}

function salientPixelScore(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  // Victory reason text is bright neutral; the confirm button is bright
  // yellow/green. Mid/dark background pixels are intentionally ignored.
  if (max < 150) return -1;
  if (chroma < 28 && min < 172) return -1;
  return max + chroma * 1.7;
}

function buildTemplateSamples(template, cfg = {}) {
  const gridCols = Math.max(6, Number(cfg.gridCols || 18));
  const gridRows = Math.max(2, Number(cfg.gridRows || 5));
  const maxSamples = Math.max(24, Number(cfg.maxSamples || 96));
  const candidates = [];
  for (let gy = 0; gy < gridRows; gy++) {
    const y0 = Math.floor(gy * template.height / gridRows);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * template.height / gridRows));
    for (let gx = 0; gx < gridCols; gx++) {
      const x0 = Math.floor(gx * template.width / gridCols);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * template.width / gridCols));
      let best = null;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const off = (y * template.width + x) * 4;
          if (template.data[off + 3] < 220) continue;
          const r = template.data[off];
          const g = template.data[off + 1];
          const b = template.data[off + 2];
          const score = salientPixelScore(r, g, b);
          if (score < 0) continue;
          if (!best || score > best.score) best = { x, y, r, g, b, score };
        }
      }
      if (best) candidates.push(best);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxSamples);
}

function findTemplateInImage(image, template, cfg = {}) {
  if (!image || !template || template.width > image.width || template.height > image.height) {
    return { matched: false, reason: 'STRICT_TEMPLATE_SIZE_INVALID', matchedRatio: 0, meanDistance: 255 };
  }
  const samples = buildTemplateSamples(template, cfg);
  if (samples.length < Number(cfg.minSamples || 20)) {
    return { matched: false, reason: 'STRICT_TEMPLATE_TOO_SPARSE', matchedRatio: 0, meanDistance: 255, samples: samples.length };
  }

  const primary = samples[0];
  const prefilter = samples.slice(0, Math.min(12, samples.length));
  const anchorTolerance = Number(cfg.anchorTolerance || 42);
  const pixelTolerance = Number(cfg.pixelTolerance || 66);
  const minPrefilterRatio = Number(cfg.minPrefilterRatio || 0.72);
  const minMatchedRatio = Number(cfg.minMatchedRatio || 0.80);
  const maxMeanDistance = Number(cfg.maxMeanDistance || 54);
  let best = null;

  const maxOriginX = image.width - template.width;
  const maxOriginY = image.height - template.height;
  for (let oy = 0; oy <= maxOriginY; oy++) {
    for (let ox = 0; ox <= maxOriginX; ox++) {
      const aOff = ((oy + primary.y) * image.width + (ox + primary.x)) * 4;
      if (rgbDistance(
        image.data[aOff], image.data[aOff + 1], image.data[aOff + 2],
        primary.r, primary.g, primary.b
      ) > anchorTolerance) continue;

      let preMatched = 0;
      for (const point of prefilter) {
        const off = ((oy + point.y) * image.width + (ox + point.x)) * 4;
        const d = rgbDistance(
          image.data[off], image.data[off + 1], image.data[off + 2],
          point.r, point.g, point.b
        );
        if (d <= pixelTolerance) preMatched++;
      }
      if (preMatched / prefilter.length < minPrefilterRatio) continue;

      let matched = 0;
      let distanceSum = 0;
      for (const point of samples) {
        const off = ((oy + point.y) * image.width + (ox + point.x)) * 4;
        const d = rgbDistance(
          image.data[off], image.data[off + 1], image.data[off + 2],
          point.r, point.g, point.b
        );
        distanceSum += d;
        if (d <= pixelTolerance) matched++;
      }
      const matchedRatio = matched / samples.length;
      const meanDistance = distanceSum / samples.length;
      const score = matchedRatio - meanDistance / 1020;
      if (!best || score > best.score) {
        best = { score, matchedRatio, meanDistance, x: ox, y: oy, samples: samples.length };
      }
    }
  }

  if (!best) {
    return { matched: false, reason: 'STRICT_TEMPLATE_NOT_FOUND', matchedRatio: 0, meanDistance: 255, samples: samples.length };
  }
  return {
    ...best,
    matched: best.matchedRatio >= minMatchedRatio && best.meanDistance <= maxMeanDistance,
    reason: best.matchedRatio >= minMatchedRatio && best.meanDistance <= maxMeanDistance
      ? 'STRICT_TEMPLATE_MATCH'
      : 'STRICT_TEMPLATE_BELOW_THRESHOLD'
  };
}

async function verifyVictoryStrictEvidence(options) {
  const { rootDir, material, sourceImage, bridge, info } = options;
  const reasonPath = path.join(material.dir, 'strict_victory_reason.png');
  const confirmPath = path.join(material.dir, 'strict_confirm_button.png');
  if (!fs.existsSync(reasonPath)) {
    return {
      matched: false,
      reason: 'STRICT_VICTORY_REASON_TEMPLATE_MISSING',
      reasonText: { matched: false, reason: 'MISSING' },
      confirmButton: { matched: false, reason: fs.existsSync(confirmPath) ? 'NOT_CHECKED' : 'MISSING' },
      exodiaLastFive: { matched: false, reason: 'NOT_CHECKED', lastFiveIds: [] }
    };
  }

  let full = sourceImage || null;
  if (!full) {
    const ref = material.meta.referenceScreen || {};
    const width = Number(ref.width || 2048);
    const height = Number(ref.height || 1152);
    full = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width, height });
  }

  const reasonTemplate = PNG.sync.read(fs.readFileSync(reasonPath));
  const reasonText = findTemplateInImage(full, reasonTemplate, {
    minMatchedRatio: 0.82,
    maxMeanDistance: 50,
    pixelTolerance: 62,
    anchorTolerance: 38
  });

  let confirmButton = { matched: false, reason: fs.existsSync(confirmPath) ? 'NOT_CHECKED' : 'MISSING' };
  if (fs.existsSync(confirmPath)) {
    const confirmTemplate = PNG.sync.read(fs.readFileSync(confirmPath));
    confirmButton = findTemplateInImage(full, confirmTemplate, {
      minMatchedRatio: 0.80,
      maxMeanDistance: 54,
      pixelTolerance: 68,
      anchorTolerance: 44
    });
  }

  const exodiaLastFive = await verifyExodiaLastFiveEvidence({
    rootDir,
    sourceImage: full,
    bridge,
    info
  });
  const matched = Boolean(reasonText.matched && exodiaLastFive.matched);
  return {
    matched,
    reason: matched
      ? 'VICTORY_BASE_PLUS_REASON_TEXT_PLUS_RIGHT_LOG_LAST_FIVE_EXODIA'
      : 'VICTORY_STRICT_EXODIA_EVIDENCE_INCOMPLETE',
    reasonText,
    // Retain the confirm-button result as diagnostic evidence only. It is not
    // a hard gate because the same button renders differently across victory
    // overlay states.
    confirmButton,
    exodiaLastFive
  };
}

async function detectLiveDuelOutcome(options) {
  const rootDir = options.rootDir;
  const bridge = options.bridge;
  const info = options.info;
  const sourceImage = options.sourceImage || null;
  const verbose = Boolean(options.verbose);
  const materials = listOutcomeMaterials(rootDir);
  const outDir = path.join(rootDir, 'debug', 'duel-outcome-live');
  const resultPath = path.join(outDir, 'latest_result.json');
  ensureDir(outDir);

  if (!materials.length) {
    const result = { terminal: false, type: 'NONE', reason: 'NO_OUTCOME_MATERIALS', checkedAt: new Date().toISOString() };
    writeJson(resultPath, result);
    return result;
  }

  const checks = [];
  let rejectedVictoryCandidate = null;
  for (const material of materials) {
    const roi = material.meta.signatureRoi;
    if (!roi) continue;
    let current;
    const refScreen = material.meta.referenceScreen || null;
    const canReuseSource = Boolean(
      sourceImage && refScreen &&
      Number(sourceImage.width) === Number(refScreen.width) &&
      Number(sourceImage.height) === Number(refScreen.height)
    );
    if (canReuseSource) {
      current = cropImage(sourceImage, roi);
    } else {
      current = await captureReferenceRoi(bridge, info, roi);
    }
    const classified = classifyOutcomeImage(current, material);
    let strictEvidence = null;
    if (classified.terminal && String(classified.type) === 'VICTORY') {
      strictEvidence = await verifyVictoryStrictEvidence({
        rootDir,
        material,
        sourceImage,
        bridge,
        info
      });
      if (!strictEvidence.matched) {
        rejectedVictoryCandidate = {
          materialId: classified.materialId,
          materialName: classified.materialName,
          metrics: classified.metrics,
          strictEvidence
        };
        classified.terminal = false;
        classified.type = 'NONE';
      }
    }
    checks.push({
      materialId: classified.materialId,
      materialName: classified.materialName,
      type: classified.type,
      terminal: classified.terminal,
      metrics: classified.metrics,
      strictEvidence
    });
    if (classified.terminal) {
      const samplePath = path.join(outDir, `${String(classified.type || 'outcome').toLowerCase()}_matched.png`);
      fs.writeFileSync(samplePath, PNG.sync.write(current));
      const result = {
        terminal: true,
        type: classified.type,
        materialId: classified.materialId,
        materialName: classified.materialName,
        checkedAt: new Date().toISOString(),
        roi,
        metrics: classified.metrics,
        strictEvidence,
        samplePath,
        checks
      };
      writeJson(resultPath, result);
      return result;
    }
  }

  if (rejectedVictoryCandidate) {
    const result = {
      terminal: false,
      type: 'VICTORY_CANDIDATE_UNCONFIRMED',
      safetyStop: true,
      reason: 'BASE_VICTORY_MATCHED_BUT_STRICT_EXODIA_EVIDENCE_INCOMPLETE',
      checkedAt: new Date().toISOString(),
      materialId: rejectedVictoryCandidate.materialId,
      materialName: rejectedVictoryCandidate.materialName,
      metrics: rejectedVictoryCandidate.metrics,
      strictEvidence: rejectedVictoryCandidate.strictEvidence,
      checks
    };
    writeJson(resultPath, result);
    return result;
  }

  const result = {
    terminal: false,
    type: 'NONE',
    checkedAt: new Date().toISOString(),
    checks
  };
  writeJson(resultPath, result);
  if (verbose) {
    for (const row of checks) {
      const m = row.metrics || {};
      console.log(`终局素材检查 ${row.materialId}: recall=${Number(m.recall || 0).toFixed(3)}, IoU=${Number(m.iou || 0).toFixed(3)}`);
    }
  }
  return result;
}

module.exports = {
  listOutcomeMaterials,
  buildSampledMask,
  compareBrightMasks,
  classifyOutcomeImage,
  buildTemplateSamples,
  findTemplateInImage,
  detectExodiaLastFiveRightLog,
  verifyExodiaLastFiveEvidence,
  verifyVictoryStrictEvidence,
  detectLiveDuelOutcome
};
