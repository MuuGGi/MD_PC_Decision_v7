'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  VICTORY_TITLE_ROI,
  VICTORY_CROWN_ROI,
  RESULT_CONFIRM_ROI,
  detectVictoryResultConfirm
} = require('../core/duel-result-confirm');

const ROOT = path.resolve(__dirname, '..', '..');

function load(rel) {
  return PNG.sync.read(fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
}

function crop(image, roi) {
  const data = Buffer.alloc(roi.width * roi.height * 4);
  for (let y = 0; y < roi.height; y++) {
    const from = ((roi.y + y) * image.width + roi.x) * 4;
    const to = y * roi.width * 4;
    image.data.copy(data, to, from, from + roi.width * 4);
  }
  return { width: roi.width, height: roi.height, data };
}

function detect(image) {
  return detectVictoryResultConfirm(
    crop(image, VICTORY_TITLE_ROI),
    crop(image, VICTORY_CROWN_ROI),
    crop(image, RESULT_CONFIRM_ROI)
  );
}

const victory = detect(load('material/verified/duel-result-01-victory.png'));
assert.strictEqual(victory.pass, true, `victory should pass: ${JSON.stringify(victory)}`);
assert.deepStrictEqual(victory.reference, { x: 1024, y: 1037 });

const defeat = detect(load('material/verified/deadlock-surrender-04-defeat-result.png'));
assert.strictEqual(defeat.pass, false, 'defeat must not be accepted by the victory-only detector');

const hoverImages = ['title', 'crown', 'confirm'].map(name =>
  load(`material/verified/issue-091-victory-${name}-hover.png`));
const hover = detectVictoryResultConfirm(...hoverImages);
assert.strictEqual(hover.pass, true, JSON.stringify(hover));
assert.strictEqual(hover.buttonMode, 'HOVERED');
assert.ok(hover.confirmDarkRatio < 0.75);
const dark = image => ({ width: image.width, height: image.height, data: Buffer.alloc(image.data.length) });
assert.strictEqual(detectVictoryResultConfirm(dark(hoverImages[0]), hoverImages[1], hoverImages[2]).pass, false);
assert.strictEqual(detectVictoryResultConfirm(hoverImages[0], dark(hoverImages[1]), hoverImages[2]).pass, false);
assert.strictEqual(detectVictoryResultConfirm(hoverImages[0], hoverImages[1], dark(hoverImages[2])).pass, false);

const mainSource = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
assert.match(mainSource, /runPostVictorySettlement/);
assert.match(mainSource, /V6_RESUME_TERMINAL_VICTORY/);
assert.match(mainSource, /V6_M21_FIELD_TERMINAL_VICTORY/);
assert.match(mainSource, /V6_CARD_EXECUTOR_TERMINAL_VICTORY/);
assert.doesNotMatch(mainSource, /不点击确认按钮/);

assert.ok(fs.existsSync(path.join(ROOT, 'execution/live/run-victory-result-confirm.js')));

console.log(
  `DUEL RESULT CONFIRM OFFLINE PASS; victoryWhite=${victory.titleWhiteRatio.toFixed(4)}; ` +
  `leftCrown=${victory.leftCrownGoldRatio.toFixed(4)}; ` +
  `confirm=${victory.confirmLimeRatio.toFixed(4)}; defeatRejected=PASS`
);
