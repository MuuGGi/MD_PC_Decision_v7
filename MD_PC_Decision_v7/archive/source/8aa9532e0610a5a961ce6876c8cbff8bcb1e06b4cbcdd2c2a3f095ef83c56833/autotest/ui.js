'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { cropImage } = require('../engine/lib/png-utils');
const { blueScoreFromRoi } = require('../engine/lib/win-fast');
const victory = require('../engine/execution/core/duel-result-confirm');
const surrender = require('../engine/execution/core/deadlock-surrender');
const settlement = require('../engine/execution/core/duel-settlement');
const ROIS = { title: { x: 122, y: 49, width: 207, height: 39 },
  start: { x: 1646, y: 1044, width: 150, height: 35 },
  main1: { x: 1517, y: 500, width: 116, height: 38 },
  phase: { x: 1470, y: 440, width: 165, height: 155 } };
const templates = Object.fromEntries(['starter-title', 'start-button', 'main1-text'].map(name =>
  [name, PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.png`)))]));
const isWhite = (r, g, b) => Math.min(r, g, b) > 160;
const isLime = (r, g, b) => r > 100 && g > 110 && b < 120 && g > b * 1.6;
function maskMatch(image, template, predicate) {
  let best = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    let intersection = 0, union = 0;
    for (let y = 3; y < image.height - 3; y++) for (let x = 3; x < image.width - 3; x++) {
      const a = (y * image.width + x) * 4, b = ((y + dy) * template.width + x + dx) * 4;
      const aa = predicate(image.data[a], image.data[a + 1], image.data[a + 2]);
      const bb = predicate(template.data[b], template.data[b + 1], template.data[b + 2]);
      if (aa && bb) intersection++; if (aa || bb) union++;
    }
    best = Math.max(best, union ? intersection / union : 0);
  }
  return best;
}
function detectStarter(frame) {
  const title = maskMatch(cropImage(frame, ROIS.title), templates['starter-title'], isWhite);
  const button = maskMatch(cropImage(frame, ROIS.start), templates['start-button'], isLime);
  return { pass: title >= 0.70 && button >= 0.70, title, button, reference: { x: 1715, y: 1062 } };
}
function detectMain1(frame) {
  const text = maskMatch(cropImage(frame, ROIS.main1), templates['main1-text'], isWhite);
  const blue = blueScoreFromRoi(cropImage(frame, ROIS.phase));
  const gear = surrender.detectDuelGear(cropImage(frame, surrender.GEAR_ROI));
  return { pass: text >= 0.65 && blue >= 0.12 && gear.pass, text, blue, gear };
}
function classifyPage(frame) {
  const starter = detectStarter(frame); if (starter.pass) return { page: 'STARTER', proof: starter };
  const win = victory.detectVictoryResultConfirm(cropImage(frame, victory.VICTORY_TITLE_ROI),
    cropImage(frame, victory.VICTORY_CROWN_ROI), cropImage(frame, victory.RESULT_CONFIRM_ROI));
  if (win.pass) return { page: 'VICTORY', proof: win };
  const defeat = surrender.detectSurrenderDefeatResult(cropImage(frame, surrender.DEFEAT_TITLE_ROI),
    cropImage(frame, surrender.DEFEAT_CONFIRM_ROI));
  if (defeat.pass) return { page: 'DEFEAT', proof: defeat };
  const reward = settlement.detectSettlementPage(cropImage(frame, settlement.SETTLEMENT_HEADER_ROI),
    cropImage(frame, settlement.SETTLEMENT_CONTINUE_ROI));
  if (reward.pass) return { page: 'SETTLEMENT', proof: reward };
  if (detectMain1(frame).pass) return { page: 'MAIN1' };
  return { page: 'UNKNOWN' };
}
module.exports = { ROIS, maskMatch, detectStarter, detectMain1, classifyPage };
