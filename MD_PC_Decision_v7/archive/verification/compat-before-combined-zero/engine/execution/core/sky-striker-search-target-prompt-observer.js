'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { imageDarkRatio } = require('./image-metrics');
const config = require(path.join(ROOT, 'live-config'));
const { captureReferenceRoi } = require(path.join(ROOT, 'lib', 'win-fast'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(ROOT, 'execution', 'core', 'prompt-candidate-centers'));

// The summoned Sky Striker monster's optional effect enters the ordinary card-candidate selection family, not
// the optional-effect pool. Reuse the live-PASS M10/M17 candidate strip
// geometry, but do NOT reuse their card-specific header template. This probe
// is intentionally passive: pixels only, no candidate click, no confirm.
const SEARCH_DIALOG = config.toonChain && config.toonChain.searchDialog || {};
const SKY_STRIKER_TARGET_PROMPT = {
  headerRoi: SEARCH_DIALOG.signature && SEARCH_DIALOG.signature.roi || { x: 680, y: 725, width: 690, height: 70 },
  bodyRoi: { x: 600, y: 800, width: 840, height: 255 },
  candidateRoi: SEARCH_DIALOG.candidateRoi || { x: 620, y: 830, width: 800, height: 200 },
  candidateY: SEARCH_DIALOG.candidateY || 925,
  minHeaderDark: 0.58,
  minBodyDark: 0.30
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}


function loadAllowedSkyStrikerTargets() {
  const dbPath = path.join(ROOT, 'card-library.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const allowed = new Set(['M17', 'M22']);
  return (db.cards || [])
    .filter(card => card && allowed.has(String(card.id || '')))
    .map(card => ({ id: card.id, name: card.name, count: Number(card.count || 0) }));
}

async function probeSkyStrikerSearchTargetPrompt({ bridge, info, debugDir = null, suffix = 'latest' }) {
  const header = await captureReferenceRoi(bridge, info, SKY_STRIKER_TARGET_PROMPT.headerRoi);
  const body = await captureReferenceRoi(bridge, info, SKY_STRIKER_TARGET_PROMPT.bodyRoi);
  const candidatesImage = await captureReferenceRoi(bridge, info, SKY_STRIKER_TARGET_PROMPT.candidateRoi);

  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(header, path.join(debugDir, `sky_striker_target_header_${suffix}.png`));
    saveRgbaPng(body, path.join(debugDir, `sky_striker_target_body_${suffix}.png`));
    saveRgbaPng(candidatesImage, path.join(debugDir, `sky_striker_target_candidates_${suffix}.png`));
  }

  const headerDark = imageDarkRatio(header, 92);
  const bodyDark = imageDarkRatio(body, 92);
  let points = [];
  try {
    points = detectCandidateCenters(
      candidatesImage,
      SKY_STRIKER_TARGET_PROMPT.candidateRoi,
      SKY_STRIKER_TARGET_PROMPT.candidateY,
      { mode: 'components' }
    ) || [];
  } catch (_) {
    points = [];
  }
  points = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const allowedTargets = loadAllowedSkyStrikerTargets();

  return {
    visible:
      headerDark >= SKY_STRIKER_TARGET_PROMPT.minHeaderDark &&
      bodyDark >= SKY_STRIKER_TARGET_PROMPT.minBodyDark &&
      points.length >= 1,
    headerDark,
    bodyDark,
    candidateCount: points.length,
    candidateCenters: points.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })),
    allowedTargets,
    detector: 'SKY_STRIKER_MONSTER_TARGET_PROMPT_PASSIVE_V1',
    geometrySource: 'M10_M17_LIVE_PROVEN_SEARCH_CANDIDATE_STRIP'
  };
}

module.exports = {
  SKY_STRIKER_TARGET_PROMPT,
  probeSkyStrikerSearchTargetPrompt,
  loadAllowedSkyStrikerTargets
};
