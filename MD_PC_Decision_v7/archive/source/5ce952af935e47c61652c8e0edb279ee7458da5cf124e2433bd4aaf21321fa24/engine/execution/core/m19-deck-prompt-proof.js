'use strict';

const { cropImage } = require('../../lib/png-utils');
const { detectCandidateCenters } = require('./prompt-candidate-centers');
const PROMPT_ROI = Object.freeze({ x: 620, y: 725, width: 800, height: 305 });
const CANDIDATE_ROI = Object.freeze({ x: 620, y: 830, width: 800, height: 200 });

function darkRatio(image, roi) {
  let dark = 0, total = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += 2) {
    for (let x = roi.x; x < roi.x + roi.width; x += 2) {
      const o = (y * image.width + x) * 4;
      if (Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) < 75) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}

// Priority blue is not a modal-ready signal. Prove the dark modal header and
// both body edges in the SAME frame as bounded card components. Historical
// T20-1 PASS frames contain field animation/hand cards and fail this proof.
function classifyM19DeckPrompt(image, bodyEdges = {
  left: { x: 82, y: 110, width: 32, height: 185 },
  right: { x: 695, y: 110, width: 32, height: 185 }
}) {
  if (!image || image.width !== 800 || image.height !== 305 || !image.data) {
    return { pass: false, points: [], reason: 'INVALID_PROMPT_FRAME' };
  }
  const header = darkRatio(image, { x: 85, y: 12, width: 625, height: 48 });
  const left = darkRatio(image, bodyEdges.left);
  const right = darkRatio(image, bodyEdges.right);
  const candidateImage = cropImage(image, { x: 0, y: 105, width: 800, height: 200 });
  const points = detectCandidateCenters(candidateImage, CANDIDATE_ROI, 925, { mode: 'components' })
    .filter(p => Number.isFinite(p.x) && p.width >= 60 && p.width <= 170 && p.x >= 750 && p.x <= 1300)
    .sort((a, b) => a.x - b.x);
  return { pass: header >= 0.80 && left >= 0.90 && right >= 0.90 && points.length > 0,
    points, headerDarkRatio: header, leftDarkRatio: left, rightDarkRatio: right };
}

// Grave search can contain four cards. Its blue candidate tray overlaps the
// old single-Yoto inner edges: prove the outer dark modal rails instead. Keep
// the original True -> Yoto detector unchanged, including its thresholds.
function classifyBambooSearchPrompt(image) {
  return classifyM19DeckPrompt(image, {
    left: { x: 68, y: 110, width: 20, height: 185 },
    right: { x: 725, y: 110, width: 20, height: 185 }
  });
}

function sameCandidates(a, b) {
  return Boolean(a && b && a.pass && b.pass && a.points.length === b.points.length &&
    a.points.every((p, i) => Math.abs(p.x - b.points[i].x) <= 3 && Math.abs(p.width - b.points[i].width) <= 4));
}

// A single selected search card stays bright; MD dims every other card. The
// brightness-component widths of those OTHER cards are not their physical
// bounds. Keep strict sampling above for readiness, but validate the selected
// transaction against invariant slot order/centers and the active card frame.
function sameBambooSelectionLayout(a, b, selectedReference) {
  if (!a || !b || !a.pass || !b.pass || !selectedReference ||
      a.points.length !== b.points.length) return false;
  const index = a.points.findIndex(p => p.x === selectedReference.x && p.y === selectedReference.y);
  if (index < 0) return false;
  return a.points.every((p, i) => Math.abs(p.x - b.points[i].x) <= 3 && p.y === b.points[i].y) &&
    Math.abs(a.points[index].width - b.points[index].width) <= 4;
}

function createPromptStabilityGate(requiredFrames = 3) {
  let previous = null, stable = 0;
  return proof => {
    stable = proof.pass ? (sameCandidates(previous, proof) ? stable + 1 : 1) : 0;
    previous = proof;
    return { ...proof, stableFrames: stable, ready: stable >= requiredFrames };
  };
}

module.exports = { PROMPT_ROI, classifyM19DeckPrompt, classifyBambooSearchPrompt, sameCandidates,
  sameBambooSelectionLayout, createPromptStabilityGate };
