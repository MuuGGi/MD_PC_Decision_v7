'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { imageDarkRatio } = require('./image-metrics');
const { captureReferenceRoi } = require(path.join(ROOT, 'lib', 'win-fast'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(ROOT, 'execution', 'core', 'prompt-candidate-centers'));

// Reuse the already live-proven prompt geometry from M18, but treat the body
// as a generic optional-effect pool. The detector only observes pixels; it
// never clicks/selects, and candidateCount may legitimately be >1.
const OPTIONAL_EFFECT_PROMPT = {
  headerRoi: { x: 680, y: 730, width: 690, height: 70 },
  bodyRoi: { x: 690, y: 790, width: 670, height: 255 },
  candidateRoi: { x: 820, y: 810, width: 410, height: 230 },
  candidateY: 925,
  minHeaderDark: 0.72,
  minBodyDark: 0.56
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}


async function probeOptionalEffectPrompt({ bridge, info, debugDir = null, suffix = 'latest' }) {
  const header = await captureReferenceRoi(bridge, info, OPTIONAL_EFFECT_PROMPT.headerRoi);
  const body = await captureReferenceRoi(bridge, info, OPTIONAL_EFFECT_PROMPT.bodyRoi);
  const candidatesImage = await captureReferenceRoi(bridge, info, OPTIONAL_EFFECT_PROMPT.candidateRoi);

  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(header, path.join(debugDir, `optional_effect_header_${suffix}.png`));
    saveRgbaPng(body, path.join(debugDir, `optional_effect_body_${suffix}.png`));
    saveRgbaPng(candidatesImage, path.join(debugDir, `optional_effect_candidates_${suffix}.png`));
  }

  const headerDark = imageDarkRatio(header, 86);
  const bodyDark = imageDarkRatio(body, 86);
  let points = [];
  try {
    points = detectCandidateCenters(
      candidatesImage,
      OPTIONAL_EFFECT_PROMPT.candidateRoi,
      OPTIONAL_EFFECT_PROMPT.candidateY,
      { mode: 'components' }
    ) || [];
  } catch (_) {
    points = [];
  }
  points = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

  const genericVisible =
    headerDark >= OPTIONAL_EFFECT_PROMPT.minHeaderDark &&
    bodyDark >= OPTIONAL_EFFECT_PROMPT.minBodyDark &&
    points.length >= 1;

  // Live R3B evidence: after M19 is chosen as CL1, Master Duel redraws the
  // remaining single-candidate chain-build prompt with a slightly brighter
  // header than the original 1/2-candidate prompt. Keep the mature generic
  // threshold untouched and add a narrow acceptance branch for this exact
  // geometry: one real candidate, very dark body, and header still clearly
  // darker than the normal field. This avoids loosening the detector globally.
  const singleCandidateChainBuildVisible =
    points.length === 1 &&
    headerDark >= 0.68 &&
    bodyDark >= 0.75;

  return {
    visible: genericVisible || singleCandidateChainBuildVisible,
    headerDark,
    bodyDark,
    candidateCount: points.length,
    detector: singleCandidateChainBuildVisible && !genericVisible
      ? 'GENERIC_OPTIONAL_EFFECT_POOL_V2_SINGLE_CHAIN_VARIANT'
      : 'GENERIC_OPTIONAL_EFFECT_POOL_V2',
    geometrySource: 'M18_LIVE_PROVEN_PROMPT_GEOMETRY'
  };
}

module.exports = {
  OPTIONAL_EFFECT_PROMPT,
  probeOptionalEffectPrompt
};
