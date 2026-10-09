'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { cropImage } = require('../../lib/png-utils');

const ROOT = path.resolve(__dirname, '..', '..');
const SETTLEMENT_HEADER_ROI = { x: 0, y: 0, width: 300, height: 130 };
const SETTLEMENT_REWARD_PANEL_ROI = { x: 920, y: 240, width: 530, height: 710 };
const REFERENCE_GEM_ICON_ROI = { x: 973, y: 273, width: 96, height: 96 };
const GEM_COUNT_RELATIVE_ROI = { x: 32, y: 92, width: 70, height: 40 };
const SETTLEMENT_DIGIT_TEMPLATE_SOURCES = [
  {
    file: 'duel-settlement-01-gems-79.png',
    roi: { x: 1004, y: 364, width: 70, height: 40 },
    text: '79'
  },
  {
    file: 'duel-settlement-02-gems-94.png',
    roi: { x: 1004, y: 364, width: 70, height: 40 },
    text: '94'
  },
  {
    file: 'duel-settlement-03-gems-106-plus-10.png',
    roi: { x: 84, y: 124, width: 70, height: 40 },
    text: '106'
  },
  {
    file: 'duel-settlement-03-gems-106-plus-10.png',
    roi: { x: 192, y: 124, width: 70, height: 40 },
    text: '10'
  },
  {
    // Real 2026-10-03 reward panel: same settlement font, not INFO font.
    // Keep the original confidence/margin gates; teach the missing glyph 8.
    file: 'duel-settlement-04-gems-108-plus-10.png',
    roi: { x: 84, y: 124, width: 70, height: 40 },
    text: '108'
  },
  {
    file: 'duel-settlement-05-gems-115-plus-15.png',
    roi: { x: 84, y: 124, width: 70, height: 40 },
    text: '115'
  },
  {
    file: 'duel-settlement-05-gems-115-plus-15.png',
    roi: { x: 192, y: 124, width: 70, height: 40 },
    text: '15'
  }
];
const SETTLEMENT_CONTINUE_ROI = { x: 1600, y: 995, width: 440, height: 105 };
const SETTLEMENT_CONTINUE_REFERENCE = { x: 1824, y: 1052 };
const REWARD_ANIMATION_REFERENCE = { x: 1024, y: 1000 };
const REWARD_ANIMATION_DURATION_MS = 5000;
const REWARD_ANIMATION_CLICK_INTERVAL_MS = 200;
const GEM_LEDGER_PATH = path.join(ROOT, 'debug', 'settlement-rewards', 'daily-gems.json');

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sampledRatio(image, predicate, step = 1) {
  let matched = 0;
  let total = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) matched += 1;
      total += 1;
    }
  }
  return total ? matched / total : 0;
}

function isWhiteDigit(r, g, b) {
  return Math.min(r, g, b) > 130 && Math.max(r, g, b) - Math.min(r, g, b) < 90;
}

function connectedWhiteComponents(image) {
  const width = image.width;
  const height = image.height;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isWhiteDigit(image.data[i], image.data[i + 1], image.data[i + 2])) {
        mask[y * width + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let pixels = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels += 1;
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
          const next = ny * width + nx;
          if (!mask[next] || seen[next]) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    const component = {
      pixels,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
    if (
      component.pixels >= 35 &&
      component.width >= 4 && component.width <= 22 &&
      component.height >= 12 && component.height <= 28
    ) {
      components.push(component);
    }
  }
  // The ROI intentionally includes the right edge of the multiplication sign
  // so horizontal UI drift does not cut the first digit.  It always occupies
  // the leftmost <8 reference pixels; reward digits begin to its right.
  return {
    mask,
    width,
    height,
    components: components.filter(component => component.x >= 8).sort((a, b) => a.x - b.x)
  };
}

function normalizeComponent(maskData, component, outWidth = 28, outHeight = 36) {
  const out = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sx = component.x + Math.min(
        component.width - 1,
        Math.floor((x / outWidth) * component.width)
      );
      const sy = component.y + Math.min(
        component.height - 1,
        Math.floor((y / outHeight) * component.height)
      );
      out[y * outWidth + x] = maskData.mask[sy * maskData.width + sx];
    }
  }
  return out;
}

function loadDigitTemplates(rootDir = ROOT) {
  const rows = [];
  for (let digit = 0; digit <= 9; digit++) {
    const filePath = path.join(rootDir, 'templates', 'ui', `hand_count_info_${digit}.png`);
    if (!fs.existsSync(filePath)) continue;
    const png = PNG.sync.read(fs.readFileSync(filePath));
    const data = new Uint8Array(png.width * png.height);
    for (let i = 0; i < data.length; i++) data[i] = png.data[i * 4] > 127 ? 1 : 0;
    rows.push({ digit, width: png.width, height: png.height, data });
  }
  return rows;
}

// Supplemental same-font features, not a second OCR/font fallback. The bank
// carries normalized pixels and provenance, so runtime never reads archives.
function parseVerifiedSettlementGlyphBank(bank) {
  if (bank?.version !== 1 || bank.font !== 'MASTER_DUEL_SETTLEMENT' ||
      bank.normalization?.width !== 28 || bank.normalization?.height !== 36 ||
      !Array.isArray(bank.entries) || !bank.entries.length) {
    throw new Error('SETTLEMENT_GLYPH_BANK_INVALID');
  }
  return bank.entries.map(row => {
    const proof = row?.proof;
    if (!Number.isInteger(row?.digit) || row.digit < 0 || row.digit > 9 ||
        row.verified !== true || typeof row.data !== 'string' ||
        !/^[01]{1008}$/.test(row.data) ||
        proof?.kind !== 'VISUAL_REVIEW_SAVED_REWARD_PANEL' ||
        !/^[a-f0-9]{64}$/.test(proof.imageSha256 || '') ||
        !/^\d{1,3}$/.test(proof.text || '') ||
        !Number.isInteger(proof.componentIndex) || proof.componentIndex < 0 ||
        Number(proof.text[proof.componentIndex]) !== row.digit) {
      throw new Error('SETTLEMENT_GLYPH_BANK_ENTRY_UNPROVEN');
    }
    const data = Uint8Array.from(row.data, Number);
    if (crypto.createHash('sha256').update(data).digest('hex') !== row.dataSha256) {
      throw new Error('SETTLEMENT_GLYPH_BANK_DATA_CHANGED');
    }
    return { digit: row.digit, data, source: 'SETTLEMENT_GLYPH_BANK:' + row.source };
  });
}

function describeSettlementDigitCoverage(templates) {
  const supportedDigits = [...new Set(templates.map(row => row.digit))].sort((a, b) => a - b);
  return { font: 'MASTER_DUEL_SETTLEMENT', supportedDigits,
    missingDigits: Array.from({ length: 10 }, (_, n) => n).filter(n => !supportedDigits.includes(n)) };
}

function loadSettlementDigitTemplates(rootDir = ROOT) {
  const rows = [];
  for (const source of SETTLEMENT_DIGIT_TEMPLATE_SOURCES) {
    const filePath = path.join(rootDir, 'material', 'verified', source.file);
    if (!fs.existsSync(filePath)) continue;
    const image = PNG.sync.read(fs.readFileSync(filePath));
    const countImage = cropImage(image, source.roi);
    const extracted = connectedWhiteComponents(countImage);
    if (extracted.components.length !== source.text.length) {
      throw new Error(
        `SETTLEMENT_DIGIT_TEMPLATE_COMPONENT_MISMATCH:${source.file}:${source.text}:` +
        `${extracted.components.length}`
      );
    }
    extracted.components.forEach((component, index) => {
      rows.push({
        digit: Number(source.text[index]),
        data: normalizeComponent(extracted, component),
        source: source.file,
        component: { ...component }
      });
    });
  }
  const bankPath = path.join(rootDir, 'templates/ui/settlement-glyph-bank.json');
  if (!fs.existsSync(bankPath)) throw new Error('SETTLEMENT_GLYPH_BANK_MISSING');
  rows.push(...parseVerifiedSettlementGlyphBank(readJson(bankPath)));
  if (!rows.length) throw new Error('SETTLEMENT_DIGIT_TEMPLATES_MISSING');
  return rows;
}

function compareBinary(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) mismatch += 1;
  return 1 - mismatch / left.length;
}

function rankDigitTemplates(sample, templates) {
  const bestByDigit = new Map();
  for (const template of templates) {
    const confidence = compareBinary(sample, template.data);
    const previous = bestByDigit.get(template.digit);
    if (!previous || confidence > previous.confidence) {
      bestByDigit.set(template.digit, {
        digit: template.digit,
        confidence,
        source: template.source || 'HAND_COUNT_LEGACY'
      });
    }
  }
  return [...bestByDigit.values()].sort((a, b) => b.confidence - a.confidence);
}

function recognitionCandidate(ranked, thresholds, source) {
  const best = ranked[0] || { digit: null, confidence: 0 };
  const runnerUp = ranked[1] || { confidence: 0 };
  const margin = best.confidence - runnerUp.confidence;
  return {
    accepted: best.digit != null && best.confidence >= thresholds.confidence && margin >= thresholds.margin,
    digit: best.digit,
    confidence: best.confidence,
    margin,
    source,
    ranked: ranked.slice(0, 3)
  };
}

function recognizeGemCount(image, templates = loadSettlementDigitTemplates()) {
  const extracted = connectedWhiteComponents(image);
  if (extracted.components.length < 1 || extracted.components.length > 3) {
    return { pass: false, reason: 'GEM_DIGIT_COMPONENT_COUNT', components: extracted.components };
  }
  const settlementDigits = new Set(templates.map(template => template.digit));
  const legacyTemplates = loadDigitTemplates();
  const digits = extracted.components.map(component => {
    const sample = normalizeComponent(extracted, component);
    const settlement = recognitionCandidate(
      rankDigitTemplates(sample, templates),
      // Open-set recognition: a margin over an incomplete alphabet is not
      // proof. Also require a close match to the actual reward-font glyph.
      { confidence: 0.90, margin: 0.04 },
      'SETTLEMENT_VERIFIED'
    );
    const legacy = recognitionCandidate(
      rankDigitTemplates(sample, legacyTemplates),
      { confidence: 0.66, margin: 0.05 },
      'HAND_COUNT_LEGACY_FALLBACK'
    );
    // INFO is a different font. It may veto an unsupported competing class,
    // but must NEVER supply a reward identity or authorize a ledger write.
    const unsupportedCompetitor = legacy.accepted && !settlementDigits.has(legacy.digit);
    const selected = { ...settlement,
      accepted: settlement.accepted && !unsupportedCompetitor };
    return {
      digit: selected.digit,
      confidence: selected.confidence,
      margin: selected.margin,
      source: selected.source,
      accepted: selected.accepted,
      component,
      ranked: selected.ranked,
      legacyFallback: null,
      unsupportedCompetitor: unsupportedCompetitor ? legacy : null
    };
  });
  const confident = digits.every(row => row.accepted === true);
  const text = digits.map(row => row.digit).join('');
  const value = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  const rangeOk = Number.isInteger(value) && value >= 0 && value <= 999;
  return {
    pass: confident && rangeOk,
    reason: confident ? (rangeOk ? 'PASS' : 'GEM_COUNT_OUT_OF_RANGE') : 'GEM_DIGIT_LOW_CONFIDENCE',
    value: rangeOk ? value : null,
    text,
    digits,
    components: extracted.components,
    alphabet: describeSettlementDigitCoverage(templates)
  };
}

function loadReferenceGemIcon(rootDir = ROOT) {
  const referencePath = path.join(
    rootDir,
    'material',
    'verified',
    'duel-settlement-01-gems-79.png'
  );
  if (!fs.existsSync(referencePath)) throw new Error('SETTLEMENT_GEM_REFERENCE_MISSING');
  const full = PNG.sync.read(fs.readFileSync(referencePath));
  return cropImage(full, REFERENCE_GEM_ICON_ROI);
}

function gemTemplatePoints(template) {
  const points = [];
  for (let y = 4; y < template.height - 4; y += 3) {
    for (let x = 4; x < template.width - 4; x += 3) {
      const i = (y * template.width + x) * 4;
      const r = template.data[i];
      const g = template.data[i + 1];
      const b = template.data[i + 2];
      if (b > 95 && b - r > 18 && Math.max(r, g, b) - Math.min(r, g, b) > 25) {
        points.push({ x, y, r, g, b });
      }
    }
  }
  return points;
}

function gemMatchMad(panel, originX, originY, points) {
  let sum = 0;
  for (const point of points) {
    const i = ((originY + point.y) * panel.width + originX + point.x) * 4;
    sum += Math.abs(panel.data[i] - point.r);
    sum += Math.abs(panel.data[i + 1] - point.g);
    sum += Math.abs(panel.data[i + 2] - point.b);
  }
  return points.length ? sum / (points.length * 3 * 255) : Infinity;
}

function findGemIconMatches(panel, template = loadReferenceGemIcon()) {
  const points = gemTemplatePoints(template);
  if (points.length < 20) return [];
  const candidates = [];
  const maxX = panel.width - template.width;
  const maxY = panel.height - (GEM_COUNT_RELATIVE_ROI.y + GEM_COUNT_RELATIVE_ROI.height);
  for (let y = 0; y <= maxY; y += 2) {
    for (let x = 0; x <= maxX; x += 2) {
      const mad = gemMatchMad(panel, x, y, points);
      if (mad <= 0.19) candidates.push({ x, y, width: template.width, height: template.height, mad });
    }
  }
  candidates.sort((a, b) => a.mad - b.mad);
  const accepted = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some(row => {
      const dx = (row.x + row.width / 2) - (candidate.x + candidate.width / 2);
      const dy = (row.y + row.height / 2) - (candidate.y + candidate.height / 2);
      return Math.hypot(dx, dy) < 60;
    });
    if (!overlaps) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.y - b.y || a.x - b.x);
}

function recognizeSettlementGemRewards(panel, options = {}) {
  const templates = options.digitTemplates || loadSettlementDigitTemplates();
  const matches = findGemIconMatches(panel, options.gemTemplate || loadReferenceGemIcon());
  if (!matches.length) return { pass: false, reason: 'NO_GEM_REWARD_SLOT', rewards: [], total: null };
  const rewards = matches.map(match => {
    const roi = {
      x: match.x + GEM_COUNT_RELATIVE_ROI.x,
      y: match.y + GEM_COUNT_RELATIVE_ROI.y,
      width: GEM_COUNT_RELATIVE_ROI.width,
      height: GEM_COUNT_RELATIVE_ROI.height
    };
    if (roi.x + roi.width > panel.width || roi.y + roi.height > panel.height) {
      return { match, roi, count: { pass: false, reason: 'GEM_COUNT_ROI_OUT_OF_PANEL' } };
    }
    return { match, roi, count: recognizeGemCount(cropImage(panel, roi), templates) };
  });
  const pass = rewards.every(row => row.count.pass);
  return {
    pass,
    reason: pass ? 'PASS' : 'ONE_OR_MORE_GEM_COUNTS_UNPROVEN',
    rewards,
    total: pass ? rewards.reduce((sum, row) => sum + row.count.value, 0) : null
  };
}

function detectSettlementPage(header, continueButton) {
  const headerDarkRatio = sampledRatio(header, (r, g, b) => Math.max(r, g, b) < 60, 2);
  const headerWhiteRatio = sampledRatio(
    header,
    (r, g, b) => Math.min(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 90,
    2
  );
  const buttonDarkRatio = sampledRatio(continueButton, (r, g, b) => Math.max(r, g, b) < 60, 2);
  const buttonLimeRatio = sampledRatio(
    continueButton,
    (r, g, b) => r > 100 && g > 110 && g > b * 1.5 && r > b * 1.5,
    2
  );
  return {
    pass: headerDarkRatio >= 0.65 && headerWhiteRatio >= 0.02 &&
      buttonDarkRatio >= 0.80 && buttonLimeRatio >= 0.015,
    detector: 'DUEL_SETTLEMENT_PAGE_AND_CONTINUE_V2',
    headerDarkRatio,
    headerWhiteRatio,
    buttonDarkRatio,
    buttonLimeRatio,
    reference: { ...SETTLEMENT_CONTINUE_REFERENCE }
  };
}

function shanghaiDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function commitGemReward(options) {
  const ledgerPath = options.ledgerPath || GEM_LEDGER_PATH;
  const now = options.now || new Date();
  const dateKey = shanghaiDateKey(now);
  const fingerprint = String(options.fingerprint || '');
  const value = Number(options.value);
  // Each recognized slot is range checked separately. Multiple slots may
  // sum above the nominal cap; retain the actual observation without clamping.
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_GEM_REWARD:${value}`);
  const settlementId = String(options.settlementId || '');
  let ledger = { version: 1, timezone: 'Asia/Shanghai', nominalDailyCap: 100, days: {} };
  if (fs.existsSync(ledgerPath)) {
    try { ledger = readJson(ledgerPath); } catch (_) {}
  }
  if (!ledger.days || typeof ledger.days !== 'object') ledger.days = {};
  if (settlementId) {
    for (const [recordedDate, recordedDay] of Object.entries(ledger.days)) {
      const previous = (recordedDay.entries || []).find(entry => entry.settlementId === settlementId);
      if (!previous) continue;
      let corrected = false;
      if (Number(previous.value) !== value) {
        if (options.allowProvisionalCorrection !== true) throw new Error('SETTLEMENT_REWARD_CHANGED_FOR_ID');
        previous.previousValue = previous.value;
        previous.value = value;
        previous.fingerprint = fingerprint;
        previous.correctedAfterAnimationAt = now.toISOString();
        recordedDay.observedTotal = recordedDay.entries.reduce((sum, entry) => sum + Number(entry.value || 0), 0);
        recordedDay.nominalCapRemaining = Math.max(0, 100 - recordedDay.observedTotal);
        ledger.updatedAt = now.toISOString();
        writeJsonAtomic(ledgerPath, ledger);
        corrected = true;
      }
      return { duplicate: true, dateKey: recordedDate, observedTotal: recordedDay.observedTotal,
        nominalCapRemaining: Math.max(0, 100 - Number(recordedDay.observedTotal || 0)), ledgerPath, corrected };
    }
  }
  const day = ledger.days[dateKey] || { observedTotal: 0, entries: [] };
  if (!Array.isArray(day.entries)) day.entries = [];
  // A retry of the same still-open settlement can produce slightly different
  // pixels because particles animate.  Suppress only an immediate same-value
  // retry; identical rewards from a later duel must still be counted.
  const duplicateWindowMs = 30000;
  const duplicate = day.entries.some(entry => {
    if (settlementId) return entry.settlementId === settlementId;
    const at = Date.parse(String(entry.recognizedAt || ''));
    return Number(entry.value) === value && Number.isFinite(at) && now.getTime() - at < duplicateWindowMs;
  });
  if (!duplicate) {
    day.entries.push({
      value,
      fingerprint,
      ...(settlementId ? { settlementId } : {}),
      recognizedAt: now.toISOString(),
      source: options.source || 'DUEL_SETTLEMENT'
    });
    day.observedTotal = day.entries.reduce((sum, entry) => sum + Number(entry.value || 0), 0);
  }
  day.nominalCapRemaining = Math.max(0, 100 - Number(day.observedTotal || 0));
  ledger.days[dateKey] = day;
  ledger.updatedAt = now.toISOString();
  writeJsonAtomic(ledgerPath, ledger);
  return { duplicate, dateKey, observedTotal: day.observedTotal, nominalCapRemaining: day.nominalCapRemaining, ledgerPath };
}

async function safeForeground(bridge, label) {
  const activation = await activateAndVerifyMasterDuel(bridge, {
    requireSelfPriorityBlue: false,
    priorityLabel: label
  });
  return activation.info;
}

async function captureSettlement(bridge, info, options = {}) {
  const [header, rewardPanel, continueButton] = await Promise.all([
    captureReferenceRoi(bridge, info, SETTLEMENT_HEADER_ROI),
    captureReferenceRoi(bridge, info, SETTLEMENT_REWARD_PANEL_ROI),
    captureReferenceRoi(bridge, info, SETTLEMENT_CONTINUE_ROI)
  ]);
  let gems;
  try { gems = recognizeSettlementGemRewards(rewardPanel); }
  catch (error) {
    // Only a pure reward-digit parsing failure is optional. Foreground,
    // captures, page proof and evidence writes remain mandatory.
    if (options.recordFirst !== true) throw error;
    gems = { pass: false, reason: 'GEM_RECOGNITION_ERROR', total: null,
      rewards: [], error: String(error.message || error) };
  }
  return {
    header,
    rewardPanel,
    continueButton,
    page: detectSettlementPage(header, continueButton),
    gems
  };
}

async function captureSettlementPage(bridge, info) {
  const [header, continueButton] = await Promise.all([
    captureReferenceRoi(bridge, info, SETTLEMENT_HEADER_ROI),
    captureReferenceRoi(bridge, info, SETTLEMENT_CONTINUE_ROI)
  ]);
  return { header, continueButton, page: detectSettlementPage(header, continueButton) };
}

async function waitForSettlementPage(bridge, options = {}) {
  const deadline = Date.now() + (Number(options.timeoutMs) || 20000);
  let stable = 0;
  let last;
  while (Date.now() < deadline) {
    const info = await safeForeground(bridge, 'WAIT_SETTLEMENT_PAGE_AND_BUTTON');
    last = await captureSettlementPage(bridge, info);
    stable = last.page.pass ? stable + 1 : 0;
    if (stable >= 2) return info;
    await sleep(180);
  }
  if (last && options.debugDir) {
    saveRgbaPng(last.header, path.join(options.debugDir, 'settlement_header_before_animation_failed.png'));
    saveRgbaPng(last.continueButton, path.join(options.debugDir, 'settlement_button_before_animation_failed.png'));
  }
  throw new Error('SETTLEMENT_PAGE_AND_BUTTON_NOT_PROVEN_BEFORE_ANIMATION');
}

async function accelerateSettlementRewards(bridge, options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + REWARD_ANIMATION_DURATION_MS;
  let clicks = 0;
  while (Date.now() < deadline && clicks < 25) {
    const info = await safeForeground(bridge, 'BEFORE_REWARD_ANIMATION_CLICK');
    const current = await captureSettlementPage(bridge, info);
    if (!current.page.pass) throw new Error('SETTLEMENT_PAGE_CHANGED_DURING_REWARD_ANIMATION');
    if (Date.now() >= deadline) break;
    // Empty lower hand area, well left of the result-page continue button.
    // The button is proof only; it must not receive any acceleration clicks.
    const point = mapReferencePoint(info, REWARD_ANIMATION_REFERENCE);
    await bridge.click(point.x, point.y);
    clicks++;
    await sleep(Math.min(REWARD_ANIMATION_CLICK_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  const result = { clicks, elapsedMs: Date.now() - startedAt, reference: { ...REWARD_ANIMATION_REFERENCE } };
  if (options.debugDir) writeJsonAtomic(path.join(options.debugDir, 'reward_animation.json'), result);
  console.log(`奖励动画加速完成：底部手牌区域(${REWARD_ANIMATION_REFERENCE.x},${REWARD_ANIMATION_REFERENCE.y})；` +
    `点击=${clicks}次；耗时=${result.elapsedMs}ms；现在才读取所有钻石奖励。`);
  return result;
}

function settlementRewardSignature(gems) {
  return JSON.stringify((gems.rewards || []).map(row => ({
    x: row.match.x, y: row.match.y, value: row.count.value
  })));
}

async function runDuelSettlement(options = {}) {
  const recordFirst = options.rewardPolicy === 'record-first';
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  const debugDir = options.debugDir || path.join(
    ROOT,
    'debug',
    'execution',
    'duel-settlement',
    timestampForPath()
  );
  fs.mkdirSync(debugDir, { recursive: true });
  try {
    if (ownsBridge) await bridge.start();
    let info = await waitForSettlementPage(bridge, { debugDir, timeoutMs: options.timeoutMs });
    if (options.skipRewardAnimation !== true) {
      const animation = await accelerateSettlementRewards(bridge, { debugDir });
      if (options.onRewardAnimationDone) await options.onRewardAnimationDone(animation);
    } else {
      console.log('保存点已完成奖励动画加速；直接重读最终奖励，不重复5秒点击。');
    }
    info = await safeForeground(bridge, 'AFTER_REWARD_ANIMATION_BEFORE_RECOGNITION');
    let last = null;
    let stable = 0;
    let pageStable = 0;
    let previousSignature = null;
    const deadline = Date.now() + (Number(options.timeoutMs) || 20000);
    while (Date.now() < deadline) {
      last = await captureSettlement(bridge, info, { recordFirst });
      pageStable = last.page.pass ? pageStable + 1 : 0;
      const pass = last.page.pass && last.gems.pass;
      const signature = pass ? settlementRewardSignature(last.gems) : null;
      stable = pass ? (signature === previousSignature ? stable + 1 : 1) : 0;
      previousSignature = signature;
      if (stable >= 2 || (recordFirst && pageStable >= 2)) break;
      await sleep(180);
      info = await safeForeground(bridge, 'WAIT_DUEL_SETTLEMENT');
    }
    if (!last || (stable < 2 && (!recordFirst || pageStable < 2))) {
      if (last) {
        saveRgbaPng(last.header, path.join(debugDir, 'settlement_header_failed.png'));
        saveRgbaPng(last.rewardPanel, path.join(debugDir, 'settlement_reward_panel_failed.png'));
        saveRgbaPng(last.continueButton, path.join(debugDir, 'settlement_continue_failed.png'));
        writeJsonAtomic(path.join(debugDir, 'settlement_recognition_failed.json'), {
          page: last.page, gems: last.gems, stableReads: stable,
          capturedAt: new Date().toISOString()
        });
      }
      throw new Error(
        `DUEL_SETTLEMENT_NOT_PROVEN:page=${last && last.page.pass};gems=${last && last.gems.reason}`
      );
    }

    saveRgbaPng(last.header, path.join(debugDir, 'settlement_header.png'));
    saveRgbaPng(last.rewardPanel, path.join(debugDir, 'settlement_reward_panel.png'));
    saveRgbaPng(last.continueButton, path.join(debugDir, 'settlement_continue.png'));
    const fingerprint = crypto.createHash('sha256')
      .update(last.rewardPanel.data)
      .digest('hex');
    const gemsVerified = stable >= 2;
    const gems = gemsVerified ? last.gems.total : null;
    const rewardStatus = gemsVerified ? 'VERIFIED' : 'UNKNOWN';
    const rewardEvidencePath = path.join(debugDir, 'settlement_reward_record.json');
    const confirmedSubtotal = (last.gems.rewards || []).reduce((sum, row) =>
      sum + (row.count.pass && Number.isInteger(row.count.value) ? row.count.value : 0), 0);
    // Preserve actual pixels and all rejected candidates, not a guessed total.
    // Unknown is NOT zero and must never reach commitGemReward's ledger.
    writeJsonAtomic(rewardEvidencePath, {
      version: 1, settlementId: options.settlementId || null,
      capturedAt: new Date().toISOString(), policy: recordFirst ? 'record-first' : 'strict',
      rewardStatus, gems, confirmedSubtotal, pageStableReads: pageStable,
      digitStableReads: stable, fingerprint, page: last.page, recognition: last.gems,
      rewardPanelPath: path.join(debugDir, 'settlement_reward_panel.png')
    });
    const ledger = gemsVerified ? commitGemReward({
      value: last.gems.total,
      fingerprint,
      source: options.source || 'DUEL_SETTLEMENT',
      ledgerPath: options.ledgerPath,
      settlementId: options.settlementId,
      allowProvisionalCorrection: options.allowProvisionalCorrection
    }) : null;
    if (gemsVerified) console.log(
      `结算宝石识别 PASS: slots=${last.gems.rewards.length}; gems=${last.gems.total}; ` +
      `digits=${last.gems.rewards.map(row => row.count.digits.map(digit => `d${digit.digit}:${digit.confidence.toFixed(3)}`).join('/')).join(' | ')}; ` +
      `今日观察累计=${ledger.observedTotal}; nominalCapRemaining=${ledger.nominalCapRemaining}; ` +
      `duplicate=${ledger.duplicate}`
    );
    else console.log('结算页已连续确认；钻石数量未确认，仅保存截图/识别记录，不计入累计，继续结算。');
    const reward = { gems, ledger, debugDir, rewardStatus, rewardEvidencePath, confirmedSubtotal };
    if (options.onRewardRecorded) await options.onRewardRecorded(reward);
    else if (gemsVerified && options.onRewardCommitted) await options.onRewardCommitted(reward);
    if (options.beforeContinue && !await options.beforeContinue(reward)) {
      return { status: 'DUEL_SETTLEMENT_PAUSED', ...reward };
    }

    info = await safeForeground(bridge, 'BEFORE_SETTLEMENT_CONTINUE_CLICK');
    const current = recordFirst ? await captureSettlementPage(bridge, info) : await captureSettlement(bridge, info);
    if (!current.page.pass || (!recordFirst && (!current.gems.pass ||
        settlementRewardSignature(current.gems) !== previousSignature))) {
      throw new Error('DUEL_SETTLEMENT_CHANGED_BEFORE_CLICK');
    }
    writeJsonAtomic(path.join(debugDir, 'settlement_continue_page_proof.json'), {
      capturedAt: new Date().toISOString(), page: current.page, rewardStatus
    });
    const point = mapReferencePoint(info, last.page.reference);
    await bridge.click(point.x, point.y);
    // The final Enter authorizes one verified button click and ends this flow.
    // Loading or menu frames after that click are outside settlement handling.
    return {
      status: 'DUEL_SETTLEMENT_CONFIRMED',
      ...reward
    };
  } finally {
    if (ownsBridge) await bridge.stop().catch(() => {});
  }
}

module.exports = {
  SETTLEMENT_HEADER_ROI,
  SETTLEMENT_REWARD_PANEL_ROI,
  SETTLEMENT_CONTINUE_ROI,
  GEM_LEDGER_PATH,
  REWARD_ANIMATION_REFERENCE,
  REWARD_ANIMATION_DURATION_MS,
  waitForSettlementPage,
  accelerateSettlementRewards,
  loadSettlementDigitTemplates,
  parseVerifiedSettlementGlyphBank,
  describeSettlementDigitCoverage,
  recognizeGemCount,
  findGemIconMatches,
  recognizeSettlementGemRewards,
  detectSettlementPage,
  commitGemReward,
  settlementRewardSignature,
  runDuelSettlement
};
