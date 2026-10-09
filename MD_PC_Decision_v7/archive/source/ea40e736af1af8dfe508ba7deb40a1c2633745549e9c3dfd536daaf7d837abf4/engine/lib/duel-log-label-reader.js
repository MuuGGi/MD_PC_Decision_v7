'use strict';

const path = require('path');
const { readPng } = require('./png-utils');

const LABEL_SPECS = Object.freeze({
  ACTIVATE: { file: 'duel_log_label_activate.png', minX: 70, maxX: 175, threshold: 0.13 },
  // ISSUE-074: the live Hornet-token row rendered at MAD=0.114701 while the
  // label was plainly visible and the rest of the M22 transaction was exact.
  // The old generic 0.075 gate silently dropped that row and stranded the
  // already-summoned token.  Match the proven live tolerance used by the Link
  // label; card/operation grouping remains responsible for semantic context.
  SPECIAL_SUMMON: { file: 'duel_log_label_special_summon.png', minX: 105, maxX: 175, threshold: 0.12 },
  DESTROY: { file: 'duel_log_label_destroy.png', minX: 60, maxX: 125 },
  // Live history can render this label slightly dimmer/thicker than the
  // captured template. 0.12 recognizes both verified Kagari rows (0.108 and
  // 0.115 MAD) while the matching baseline/equip-only viewports stay empty.
  LINK_SUMMON: { file: 'duel_log_label_link_summon.png', minX: 90, maxX: 155, threshold: 0.12 },
  TARGET: { file: 'duel_log_label_target.png', minX: 20, maxX: 90 },
  RETURN_TO_HAND: { file: 'duel_log_label_return_to_hand.png', minX: 150, maxX: 230 }
});

function luminance(data, index) {
  return (data[index] * 3 + data[index + 1] * 6 + data[index + 2]) / 10;
}

function brightMask(template) {
  const points = [];
  for (let y = 0; y < template.height; y++) {
    for (let x = 0; x < template.width; x++) {
      const index = (y * template.width + x) * 4;
      const weighted = template.data[index] * 3 + template.data[index + 1] * 6 + template.data[index + 2];
      const value = weighted / 10;
      if (value >= 145) points.push({ x, y, value, weighted });
    }
  }
  return points;
}

function buildWeightedLuminance(image) {
  const weighted = new Uint16Array(image.width * image.height);
  for (let source = 0, target = 0; source < image.data.length; source += 4, target++) {
    weighted[target] = image.data[source] * 3 + image.data[source + 1] * 6 + image.data[source + 2];
  }
  return { width: image.width, height: image.height, data: weighted };
}

function maskedMadAtWeighted(weightedImage, templateMask, x, y) {
  let sum = 0;
  const width = weightedImage.width;
  const data = weightedImage.data;
  for (const point of templateMask) {
    const value = data[(y + point.y) * width + x + point.x];
    sum += Math.abs(value - point.weighted);
  }
  return templateMask.length ? sum / (templateMask.length * 2550) : Infinity;
}

function maskedMadAt(image, templateMask, x, y) {
  let sum = 0;
  for (const point of templateMask) {
    const index = ((y + point.y) * image.width + x + point.x) * 4;
    sum += Math.abs(luminance(image.data, index) - point.value);
  }
  return templateMask.length ? sum / (templateMask.length * 255) : Infinity;
}

function findLabelMatches(panelImage, template, spec, options = {}) {
  const mask = options.templateMask || brightMask(template);
  const weightedImage = options.weightedImage || null;
  const threshold = options.threshold == null ? (spec.threshold || 0.075) : options.threshold;
  const candidates = [];
  const maxX = Math.min(spec.maxX, panelImage.width - template.width);
  const maxY = panelImage.height - template.height;
  for (let y = 0; y <= maxY; y++) {
    for (let x = spec.minX; x <= maxX; x++) {
      const mad = weightedImage
        ? maskedMadAtWeighted(weightedImage, mask, x, y)
        : maskedMadAt(panelImage, mask, x, y);
      if (mad <= threshold) candidates.push({ x, y, mad });
    }
  }
  const kept = [];
  for (const candidate of candidates.sort((a, b) => a.mad - b.mad)) {
    if (kept.some(item => Math.abs(item.x - candidate.x) <= 16 && Math.abs(item.y - candidate.y) <= 24)) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.y - b.y);
}

async function loadDuelLogLabelTemplates(rootDir) {
  const directory = path.join(rootDir, 'templates', 'ui');
  const loaded = {};
  for (const [type, spec] of Object.entries(LABEL_SPECS)) {
    loaded[type] = {
      spec,
      image: await readPng(path.join(directory, spec.file))
    };
    loaded[type].mask = brightMask(loaded[type].image);
  }
  return loaded;
}

function recognizeDuelLogLabels(panelImage, templates, options = {}) {
  const labels = [];
  const weightedImage = buildWeightedLuminance(panelImage);
  for (const [type, entry] of Object.entries(templates)) {
    for (const match of findLabelMatches(panelImage, entry.image, entry.spec, {
      ...options,
      templateMask: entry.mask || brightMask(entry.image),
      weightedImage
    })) {
      labels.push({ type, ...match, width: entry.image.width, height: entry.image.height });
    }
  }
  return labels.sort((a, b) => a.y - b.y || a.x - b.x);
}

module.exports = {
  LABEL_SPECS,
  brightMask,
  maskedMadAt,
  buildWeightedLuminance,
  maskedMadAtWeighted,
  findLabelMatches,
  loadDuelLogLabelTemplates,
  recognizeDuelLogLabels
};
