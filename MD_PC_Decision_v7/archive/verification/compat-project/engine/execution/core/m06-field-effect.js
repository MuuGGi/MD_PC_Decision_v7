'use strict';

const fs = require('fs');
const path = require('path');
const { captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { cropImage } = require('../../lib/png-utils');
const { yellowUsableStats } = require('../../lib/hand-state');
const { recognizeCurrentCard, saveRgbaPng } = require('../../runtime/observer/scan-state');
const { waitForSelfPriorityBlue } = require('../../lib/self-priority-gate');

const FULL = { x: 0, y: 0, width: 2048, height: 1152 };
// Search bounds only. All click points come from measured components.
const MAIN_ROW = { x: 490, y: 595, width: 1030, height: 250 };

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function fieldCandidates(image) {
  // Field-specific prefilter: the ordinary yellow detector also accepts the
  // stone board. In the live failure, that joined the card glow to the ground
  // into a 274px component touching the ROI edge. Keep the mature connected
  // component implementation, but feed it only the bright gold active outline.
  // Never modify the captured evidence or relax the unique-frame guard.
  const glow = { width: image.width, height: image.height, data: Buffer.from(image.data) };
  for (let i = 0; i < glow.data.length; i += 4) {
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
    if (!(r >= 235 && g >= 185 && b <= 150 && r - b >= 85 && g - b >= 65)) {
      glow.data[i] = glow.data[i + 1] = glow.data[i + 2] = 0;
    }
  }
  const stats = yellowUsableStats(glow);
  return {
    detector: 'M06_BRIGHT_FIELD_OUTLINE_V2',
    stats,
    candidates: stats.components.filter(c =>
      c.width >= 65 && c.width <= 220 && c.height >= 65 && c.height <= 195 &&
      c.aspect >= 0.45 && c.aspect <= 1.8 && c.estimatedPixels >= 250 &&
      c.x > 1 && c.y > 1 && c.x + c.width < image.width - 1 && c.y + c.height < image.height - 1
    ).map(c => ({
      component: c,
      x: MAIN_ROW.x + c.x + c.width / 2,
      y: MAIN_ROW.y + c.y + c.height / 2
    }))
  };
}

async function identifyCurrent({ bridge, info, library, templates }, expectedId) {
  const raw = await recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 });
  const judged = raw && raw.judged;
  if (!judged || !judged.accepted || !judged.best || judged.best.id !== expectedId) {
    throw new Error(`M06_IDENTITY_NOT_PROVEN:expected=${expectedId};actual=${judged && judged.best && judged.best.id || 'UNKNOWN'}`);
  }
  return { id: judged.best.id, name: judged.best.name, mad: judged.best.mad, margin: judged.margin };
}

async function selectFieldRaye(options) {
  const { bridge, info, debugDir } = options;
  fs.mkdirSync(debugDir, { recursive: true });
  const neutral = await captureReferenceRoi(bridge, info, FULL);
  saveRgbaPng(neutral, path.join(debugDir, 'before_select_full.png'));
  const first = fieldCandidates(cropImage(neutral, MAIN_ROW));
  await sleep(220);
  const nextImage = await captureReferenceRoi(bridge, info, MAIN_ROW);
  saveRgbaPng(nextImage, path.join(debugDir, 'main_row.png'));
  const second = fieldCandidates(nextImage);
  saveJson(path.join(debugDir, 'field_frame_proof.json'), { first, second, roi: MAIN_ROW });
  // This isolated test starts with exactly one newly summoned, unequipped Raye.
  // Multiple or incomplete frames are not grounds for probing guessed zones.
  if (first.candidates.length !== 1 || second.candidates.length !== 1) {
    throw new Error(`M06_FIELD_FRAME_NOT_UNIQUE:${first.candidates.length}/${second.candidates.length}`);
  }
  const anchor = second.candidates[0];
  if (Math.hypot(anchor.x - first.candidates[0].x, anchor.y - first.candidates[0].y) > 12) {
    throw new Error('M06_FIELD_FRAME_NOT_STABLE');
  }
  const p = mapReferencePoint(info, anchor);
  await bridge.click(p.x, p.y);
  await sleep(350);
  const identity = await identifyCurrent(options, 'M06');
  await sleep(600);
  console.log(`场上零衣精确认: ${identity.name}; 实际卡框中心=(${Math.round(anchor.x)},${Math.round(anchor.y)})`);
  return { anchor: { x: anchor.x, y: anchor.y }, identity, neutral };
}

function effectRoi(anchor) {
  const x = Math.max(0, Math.round(anchor.x - 185));
  const y = Math.max(0, Math.round(anchor.y - 255));
  return { x, y, width: Math.min(370, FULL.width - x), height: Math.min(220, FULL.height - y) };
}

function effectOutlineStats(image) {
  const masked = { width: image.width, height: image.height, data: Buffer.from(image.data) };
  for (let i = 0; i < masked.data.length; i += 4) {
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
    if (!(r >= 160 && g >= 195 && g >= r * 0.93 && b <= 125 && g - b >= 90 && r - b >= 60)) {
      masked.data[i] = masked.data[i + 1] = masked.data[i + 2] = 0;
    }
  }
  return yellowUsableStats(masked);
}

function detectEffectButton(neutral, selected) {
  // Transplant M20's round yellow component geometry. The M06 live image
  // has a thin yellow-green ring: isolate that outline from yellow terrain,
  // then verify its dark button interior and bright effect icon.
  const before = effectOutlineStats(neutral);
  const after = effectOutlineStats(selected);
  const candidates = after.components.filter(c =>
    c.estimatedPixels >= 250 && c.width >= 70 && c.width <= 155 &&
    c.height >= 70 && c.height <= 155 && c.aspect >= 0.72 && c.aspect <= 1.38 &&
    c.fillRatio >= 0.025
  ).map(c => {
    let dark = 0, icon = 0, total = 0;
    const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
    for (let y = Math.ceil(cy - c.height * 0.32); y < cy + c.height * 0.32; y += 2) {
      for (let x = Math.ceil(cx - c.width * 0.32); x < cx + c.width * 0.32; x += 2) {
        const i = (y * selected.width + x) * 4;
        const r = selected.data[i], g = selected.data[i + 1], b = selected.data[i + 2];
        if (Math.max(r, g, b) < 120) dark++;
        if (r >= 160 && g >= 180 && b <= 125 && g - b >= 80) icon++;
        total++;
      }
    }
    return { ...c, centerX: cx, centerY: cy, darkRatio: dark / total, iconRatio: icon / total };
  }).filter(c => c.darkRatio >= 0.20 && c.iconRatio >= 0.08 &&
    !before.components.some(b => b.width >= 70 && b.height >= 70 &&
      Math.hypot(c.centerX - (b.x + b.width / 2), c.centerY - (b.y + b.height / 2)) < 20 &&
      Math.abs(c.width - b.width) < 20 && Math.abs(c.height - b.height) < 20));
  return { visible: candidates.length === 1, chosen: candidates.length === 1 ? candidates[0] : null,
    candidates, before, after, detector: 'M06_M20_ROUND_OUTLINE_V2' };
}

async function clickRayeEffect(options) {
  const { bridge, info, anchor, neutral, debugDir } = options;
  await identifyCurrent(options, 'M06');
  const roi = effectRoi(anchor);
  const before = cropImage(neutral, roi);
  saveRgbaPng(before, path.join(debugDir, 'effect_neutral.png'));
  let prior = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const current = await captureReferenceRoi(bridge, info, roi);
    saveRgbaPng(current, path.join(debugDir, `effect_button_${attempt}.png`));
    const proof = detectEffectButton(before, current);
    saveJson(path.join(debugDir, `effect_button_${attempt}.json`), { roi, proof });
    const chosen = proof.chosen;
    if (chosen && prior && Math.hypot(chosen.centerX - prior.centerX, chosen.centerY - prior.centerY) <= 8) {
      const reference = { x: roi.x + chosen.centerX, y: roi.y + chosen.centerY };
      const p = mapReferencePoint(info, reference);
      console.log(`零衣发动按钮确认: (${Math.round(reference.x)},${Math.round(reference.y)}); 唯一新增黄色圆形组件，连续两帧稳定`);
      await bridge.click(p.x, p.y);
      const priority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: 'AFTER_RAYE_EFFECT_ACTIVATION_RESPONSE_BOUNDARY',
        timeoutMs: 30000
      });
      return { reference, roi, chosen, detector: proof.detector, responseBoundaryPriority: priority };
    }
    prior = chosen;
    await sleep(200);
  }
  throw new Error('M06_EFFECT_BUTTON_NOT_PROVEN:保留已选中的零衣，不重复点卡');
}

const RAYE_SUBMIT_ROI = { x: 870, y: 1050, width: 310, height: 90 };

function detectRayeSubmit(image) {
  // M06 uses the mature generic centered selection dialog, not the Link
  // material dialog whose button is around x=1178. Measure the active label.
  const stats = yellowUsableStats(image);
  const parts = stats.components.filter(c => c.estimatedPixels >= 20 &&
    c.height >= 10 && c.height <= 40 && Math.abs(c.centerX - 154) <= 65 &&
    Math.abs(c.centerY - 38) <= 22);
  if (!parts.length) return { visible: false, stats };
  const left = Math.min(...parts.map(c => c.x));
  const right = Math.max(...parts.map(c => c.x + c.width));
  const top = Math.min(...parts.map(c => c.y));
  const bottom = Math.max(...parts.map(c => c.y + c.height));
  const pixels = parts.reduce((n, c) => n + c.estimatedPixels, 0);
  return { visible: pixels >= 250 && right - left >= 24 && right - left <= 130 &&
    bottom - top <= 45 && stats.estimatedYellowPixels >= 500,
    centerX: (left + right) / 2, centerY: (top + bottom) / 2, parts, pixels, stats };
}

async function clickRayeSummonSubmit({ bridge, info, debugDir }) {
  let prior = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const image = await captureReferenceRoi(bridge, info, RAYE_SUBMIT_ROI);
    saveRgbaPng(image, path.join(debugDir, `raye_submit_${attempt}.png`));
    const proof = detectRayeSubmit(image);
    saveJson(path.join(debugDir, `raye_submit_${attempt}.json`), proof);
    if (proof.visible && prior && prior.visible &&
        Math.hypot(proof.centerX - prior.centerX, proof.centerY - prior.centerY) <= 5) {
      const reference = { x: RAYE_SUBMIT_ROI.x + proof.centerX, y: RAYE_SUBMIT_ROI.y + proof.centerY };
      const point = mapReferencePoint(info, reference);
      await bridge.click(point.x, point.y);
      console.log(`零衣额外选择已提交: (${reference.x},${reference.y}); 未重复点击零梦`);
      const priority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: 'AFTER_RAYE_EXTRA_SUMMON_RESOLUTION_RESPONSE_BOUNDARY',
        timeoutMs: 30000
      });
      return {
        reference,
        detector: 'M06_CENTERED_SELECT_LABEL_V1',
        pixels: proof.pixels,
        responseBoundaryPriority: priority
      };
    }
    prior = proof;
    await sleep(150);
  }
  throw new Error('M06_SUMMON_SUBMIT_NOT_PROVEN:保留已选零梦，只重试按钮');
}

module.exports = { FULL, MAIN_ROW, fieldCandidates, detectEffectButton, selectFieldRaye, clickRayeEffect, identifyCurrent,
  RAYE_SUBMIT_ROI, detectRayeSubmit, clickRayeSummonSubmit };
