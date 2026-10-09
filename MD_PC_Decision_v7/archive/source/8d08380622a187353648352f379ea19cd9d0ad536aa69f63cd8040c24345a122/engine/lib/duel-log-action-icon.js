'use strict';

const path = require('path');
const { readPng, cropImage } = require('./png-utils');

const HAND_GAIN_SPEC = Object.freeze({
  file: 'duel_log_icon_hand_gain.png',
  threshold: 0.13,
  // Relative to the 47~53 x 67~73 card thumbnail. The exact icon position
  // shifts a few pixels with log-row height, so scan a compact local window.
  searchOffsetX: 58,
  searchOffsetY: 30,
  searchWidth: 72,
  searchHeight: 58
});

function pixelMad(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const ay = (a.data[i] * 3 + a.data[i + 1] * 6 + a.data[i + 2]) / 10;
    const by = (b.data[i] * 3 + b.data[i + 1] * 6 + b.data[i + 2]) / 10;
    sum += Math.abs(ay - by);
  }
  return sum / (pixels * 255);
}

function findTemplate(image, template, searchRoi) {
  let best = null;
  const maxX = searchRoi.x + searchRoi.width - template.width;
  const maxY = searchRoi.y + searchRoi.height - template.height;
  for (let y = searchRoi.y; y <= maxY; y++) {
    for (let x = searchRoi.x; x <= maxX; x++) {
      const sample = cropImage(image, { x, y, width: template.width, height: template.height });
      const mad = pixelMad(sample, template);
      if (!best || mad < best.mad) best = { x, y, mad };
    }
  }
  return best;
}

async function loadDuelLogActionIcons(rootDir) {
  return {
    handGain: {
      spec: HAND_GAIN_SPEC,
      image: await readPng(path.join(rootDir, 'templates', 'ui', HAND_GAIN_SPEC.file))
    }
  };
}

function clampSearchRoi(image, component, template, spec) {
  let x = Math.max(0, Math.round(component.x + spec.searchOffsetX));
  let y = Math.max(0, Math.round(component.y + spec.searchOffsetY));
  let right = Math.min(image.width, x + spec.searchWidth);
  let bottom = Math.min(image.height, y + spec.searchHeight);
  if (right - x < template.width) x = Math.max(0, right - template.width);
  if (bottom - y < template.height) y = Math.max(0, bottom - template.height);
  right = Math.min(image.width, Math.max(right, x + template.width));
  bottom = Math.min(image.height, Math.max(bottom, y + template.height));
  return { x, y, width: right - x, height: bottom - y };
}

function detectHandGainActionIcon(image, component, actionIcons) {
  const entry = actionIcons && actionIcons.handGain;
  if (!entry || !entry.image || !component) {
    return { matched: false, mad: Infinity, reason: 'NO_HAND_GAIN_ICON_TEMPLATE' };
  }
  const roi = clampSearchRoi(image, component, entry.image, entry.spec || HAND_GAIN_SPEC);
  const best = findTemplate(image, entry.image, roi);
  const threshold = (entry.spec && entry.spec.threshold) || HAND_GAIN_SPEC.threshold;
  return {
    matched: Boolean(best && best.mad <= threshold),
    mad: best ? best.mad : Infinity,
    x: best && best.x,
    y: best && best.y,
    threshold,
    roi
  };
}

module.exports = {
  HAND_GAIN_SPEC,
  pixelMad,
  findTemplate,
  loadDuelLogActionIcons,
  detectHandGainActionIcon
};
