'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  bambooSearchTargetIds
} = require(path.join(ROOT, 'lib', 'bamboo-search-policy'));
const { imageDarkRatio } = require('./image-metrics');
const config = require(path.join(ROOT, 'live-config'));
const { captureReferenceRoi } = require(path.join(ROOT, 'lib', 'win-fast'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { cropImage } = require('../../lib/png-utils');
const { PROMPT_ROI, classifyBambooSearchPrompt } = require('./m19-deck-prompt-proof');

// M19's GY search enters the ordinary card-candidate selection family, not
// the optional-effect pool. Reuse the live-PASS M10/M17 candidate strip
// geometry, but do NOT reuse their card-specific header template. This probe
// is intentionally passive: pixels only, no candidate click, no confirm.
const SEARCH_DIALOG = config.toonChain && config.toonChain.searchDialog || {};
const BAMBOO_TARGET_PROMPT = {
  headerRoi: SEARCH_DIALOG.signature && SEARCH_DIALOG.signature.roi || { x: 680, y: 725, width: 690, height: 70 },
  bodyRoi: { x: 600, y: 800, width: 840, height: 255 },
  candidateRoi: SEARCH_DIALOG.candidateRoi || { x: 620, y: 830, width: 800, height: 200 },
  candidateY: SEARCH_DIALOG.candidateY || 925,
  minHeaderDark: 0.58,
  minBodyDark: 0.42
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}


function loadAllowedBambooTargets() {
  const dbPath = path.join(ROOT, 'card-library.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const allowed = new Set(bambooSearchTargetIds());
  return (db.cards || [])
    .filter(card => card && allowed.has(String(card.id || '')))
    .map(card => ({ id: card.id, name: card.name, count: Number(card.count || 0) }));
}

async function probeBambooSearchTargetPrompt({ bridge, info, debugDir = null, suffix = 'latest' }) {
  // Header, modal rails and candidates MUST come from one capture. Consecutive
  // captures during CL2/CL1 animations are not proof of a search window.
  const frame = await captureReferenceRoi(bridge, info, PROMPT_ROI);
  const modalProof = classifyBambooSearchPrompt(frame);
  const header = cropImage(frame, { x: 60, y: 0, width: 690, height: 70 });
  const body = cropImage(frame, { x: 0, y: 75, width: 800, height: 230 });
  const candidatesImage = cropImage(frame, { x: 0, y: 105, width: 800, height: 200 });

  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(frame, path.join(debugDir, `m19_target_modal_${suffix}.png`));
    saveRgbaPng(header, path.join(debugDir, `m19_target_header_${suffix}.png`));
    saveRgbaPng(body, path.join(debugDir, `m19_target_body_${suffix}.png`));
    saveRgbaPng(candidatesImage, path.join(debugDir, `m19_target_candidates_${suffix}.png`));
  }

  const headerDark = imageDarkRatio(header, 92);
  const bodyDark = imageDarkRatio(body, 92);
  const points = modalProof.points;
  const allowedTargets = loadAllowedBambooTargets();

  return {
    visible: modalProof.pass,
    modalProof,
    headerDark,
    bodyDark,
    candidateCount: points.length,
    candidateCenters: points.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })),
    allowedTargets,
    detector: 'M19_BAMBOO_TARGET_PROMPT_SAME_FRAME_V2',
    geometrySource: 'M10_M17_LIVE_PROVEN_SEARCH_CANDIDATE_STRIP'
  };
}

module.exports = {
  BAMBOO_TARGET_PROMPT,
  probeBambooSearchTargetPrompt,
  loadAllowedBambooTargets
};
