'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  GEAR_ROI,
  SETTINGS_HEADER_ROI,
  SURRENDER_ROI,
  SURRENDER_CONFIRM_ALERT_ROI,
  SURRENDER_CONFIRM_YES_ROI,
  DEFEAT_TITLE_ROI,
  DEFEAT_CONFIRM_ROI,
  detectDuelGear,
  detectSurrenderSettings,
  detectSurrenderConfirmation,
  detectSurrenderDefeatResult
} = require('../core/deadlock-surrender');

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

const duel = load('material/verified/deadlock-surrender-01-duel-screen.png');
const settings = load('material/verified/deadlock-surrender-02-settings-menu.png');
const confirmation = load('material/verified/deadlock-surrender-03-confirm-dialog.png');
const defeat = load('material/verified/deadlock-surrender-04-defeat-result.png');

const gear = detectDuelGear(crop(duel, GEAR_ROI));
assert.strictEqual(gear.pass, true, `duel gear should pass: ${JSON.stringify(gear)}`);

const noSettings = detectSurrenderSettings(
  crop(duel, SETTINGS_HEADER_ROI),
  crop(duel, SURRENDER_ROI)
);
assert.strictEqual(noSettings.pass, false, 'ordinary duel screen must not look like surrender settings');

const settingsProof = detectSurrenderSettings(
  crop(settings, SETTINGS_HEADER_ROI),
  crop(settings, SURRENDER_ROI)
);
assert.strictEqual(settingsProof.pass, true, `settings should pass: ${JSON.stringify(settingsProof)}`);
assert.ok(settingsProof.reference.x >= 250 && settingsProof.reference.x <= 350);
assert.ok(settingsProof.reference.y >= 1010 && settingsProof.reference.y <= 1070);

const confirmationProof = detectSurrenderConfirmation(
  crop(confirmation, SURRENDER_CONFIRM_ALERT_ROI),
  crop(confirmation, SURRENDER_CONFIRM_YES_ROI)
);
assert.strictEqual(
  confirmationProof.pass,
  true,
  `surrender confirmation should pass: ${JSON.stringify(confirmationProof)}`
);
assert.deepStrictEqual(confirmationProof.reference, { x: 1218, y: 697 });

const defeatProof = detectSurrenderDefeatResult(
  crop(defeat, DEFEAT_TITLE_ROI),
  crop(defeat, DEFEAT_CONFIRM_ROI)
);
assert.strictEqual(defeatProof.pass, true, `defeat result should pass: ${JSON.stringify(defeatProof)}`);
assert.deepStrictEqual(defeatProof.reference, { x: 1024, y: 1037 });

const blank = {
  width: GEAR_ROI.width,
  height: GEAR_ROI.height,
  data: Buffer.alloc(GEAR_ROI.width * GEAR_ROI.height * 4)
};
assert.strictEqual(detectDuelGear(blank).pass, false, 'blank ROI must not prove gear');

const mainSource = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
assert.match(mainSource, /terminalDeadlock/);
// ISSUE-104: the user now confirms with a single x. The actual command/gate/
// executor behavior is covered by test-deadlock-one-key-offline.js.
assert.match(mainSource, /runConfirmedDeadlockSurrender/);
assert.match(mainSource, /本局已经结束/);

const executorSource = fs.readFileSync(
  path.join(ROOT, 'execution', 'core', 'deadlock-surrender.js'),
  'utf8'
);
assert.match(executorSource, /await sleep\(4000\)/, 'formal surrender must preserve the 4s pure wait');
assert.match(executorSource, /status: 'SURRENDER_COMPLETE'/);
assert.doesNotMatch(executorSource, /status: 'SURRENDER_.*PENDING'/);
assert.ok(
  fs.existsSync(path.join(ROOT, 'execution', 'live', 'run-deadlock-surrender.js')),
  'canonical live surrender regression entry must exist'
);
assert.ok(
  !fs.existsSync(path.join(ROOT, 'execution', 'tests', 'run-deadlock-surrender.js')),
  'live surrender entry must not leak into the offline test directory'
);

console.log(
  `DEADLOCK SURRENDER OFFLINE PASS; gear=${gear.cyanRatio.toFixed(4)}; ` +
  `settingsDark=${settingsProof.headerDarkRatio.toFixed(4)}; red=${settingsProof.redRatio.toFixed(4)}; ` +
  `button=(${settingsProof.reference.x},${settingsProof.reference.y}); ` +
  `confirmRed=${confirmationProof.alertRedRatio.toFixed(4)}; ` +
  `yesLime=${confirmationProof.yesLimeRatio.toFixed(4)}; ` +
  `defeatWhite=${defeatProof.titleWhiteRatio.toFixed(4)}; ` +
  `resultConfirm=${defeatProof.confirmLimeRatio.toFixed(4)}`
);
