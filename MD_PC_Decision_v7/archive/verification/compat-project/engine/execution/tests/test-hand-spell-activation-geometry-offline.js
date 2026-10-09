'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { yellowUsableStats } = require('../../lib/hand-state');
const { chooseActivationButton } = require('../core/hand-spell-activation');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(ROOT, 'execution/core/hand-spell-activation.js');
const fixture = PNG.sync.read(fs.readFileSync(path.join(ROOT,
  'material/issues/issue-141-m20-activation-field-rim.png')));
const hand = { x: 1231, y: 1004 };
const roi = { x: 991, y: 734, width: 340, height: 190, minComponentPixels: 500 };
const stats = yellowUsableStats(fixture);

// Reproduce the actual pre-fix decision: the clipped field rim is 16 yellow
// pixels larger than the Activate icon, and the generic largest-blob rule wins.
const oldChosen = stats.components.filter(c => c.estimatedPixels >= 500 &&
  c.width >= 20 && c.height >= 20 && c.aspect >= 1.15 && c.aspect <= 8 &&
  c.fillRatio >= 0.12 && c.centerY < 165).sort((a, b) => b.estimatedPixels - a.estimatedPixels)[0];
assert.deepStrictEqual({ x: roi.x + oldChosen.centerX, y: roi.y + oldChosen.centerY },
  { x: 1112, y: 752 });
const chosen = chooseActivationButton(stats, roi, hand, fixture);
assert.deepStrictEqual({ x: roi.x + chosen.centerX, y: roi.y + chosen.centerY },
  { x: 1142, y: 839 });
assert.strictEqual(chosen.estimatedPixels, 1704);
assert.strictEqual(chooseActivationButton({ components: [oldChosen] }, roi, hand, fixture), null);
assert.throws(() => chooseActivationButton(stats, roi), /HAND_ANCHOR_MISSING/);

// Keep the no-Set case: the same proven icon may be directly above the card.
const soloImage = PNG.sync.read(fs.readFileSync(path.join(ROOT,
  'material/verified/evidence/M11_mallet_keep_weapon/2026-10-03T09-35-49-451Z/activation_roi_attempt1.png')));
const solo = chooseActivationButton(yellowUsableStats(soloImage), roi, hand, soloImage);
assert(solo && solo.menuMode === 'ACTIVATE_ONLY_CENTERED');
assert.strictEqual(solo.pairedSet.visible, false);
// The right-hand Set position is never a spell-activation target.
assert.strictEqual(chooseActivationButton({ components: [chosen] }, roi,
  { x: 1053, y: 1004 }, fixture), null);
// Reject an intact but misplaced yellow block, not just the exact clipped rim.
assert.strictEqual(chooseActivationButton({ components: [{ ...chosen, centerY: 30 }] }, roi, hand, fixture), null);

async function productionReplay(frame, expectedClicks, expectedError, expectedCaptures) {
  const clicks = [];
  const waits = [];
  let captures = 0;
  let gates = 0;
  let invalidations = 0;
  const actualRequire = createRequire(SOURCE);
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(SOURCE),
    console: { log() {} }, require: id => {
      if (id.endsWith('win-fast')) return {
        captureReferenceRoi: async (_bridge, _info, observedRoi) => {
          captures++;
          assert.deepStrictEqual(JSON.parse(JSON.stringify(observedRoi)), roi);
          return Array.isArray(frame) ? frame[captures - 1] : frame;
        },
        mapReferencePoint: (_info, point) => point,
        sleep: async ms => { waits.push(ms); }
      };
      if (id.endsWith('self-priority-gate')) return {
        waitForSelfPriorityBlue: async () => { gates++; return { state: 'SELF_PRIORITY_BLUE' }; }
      };
      if (id === './hand-window-validity') return { invalidateHandWindow: () => { invalidations++; } };
      return actualRequire(id);
    }
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: SOURCE });
  const action = () => context.module.exports.clickSelectedHandSpellActivation({
    bridge: { click: async (x, y) => { clicks.push({ x, y }); } },
    info: {}, expectedId: 'M20', expectedName: '真刀竹光', clickReference: hand
  });
  if (expectedError) await assert.rejects(action, expectedError);
  else {
    const result = await action();
    assert.strictEqual(result.probeAttempts, expectedCaptures);
    assert.strictEqual(result.detector, 'HAND_EXPECTED_LOCAL_ACTIVATE_GLYPH_V3');
    assert(result.activationButton.glyph.pass);
  }
  assert.deepStrictEqual(clicks, expectedClicks);
  assert.strictEqual(captures, expectedCaptures);
  assert.strictEqual(gates, expectedClicks.length);
  assert.strictEqual(invalidations, expectedClicks.length);
  assert.deepStrictEqual(waits, expectedCaptures === 1 ? [] : [180]);
}

async function run() {
  await productionReplay(fixture, [{ x: 1142, y: 839 }], null, 1);
  // Replay the real field-rim pixels with no action menu. No guessed click,
  // priority gate, extra hand selection, or "activation successful" receipt.
  const rimOnly = { width: fixture.width, height: fixture.height,
    data: Buffer.alloc(fixture.data.length) };
  fixture.data.copy(rimOnly.data, 0, 0, fixture.width * 55 * 4);
  await productionReplay(rimOnly, [], /EXEC_ACTIVATION_BUTTON_NOT_PROVEN/, 2);
  await productionReplay([rimOnly, fixture], [{ x: 1142, y: 839 }], null, 2);

  // A larger yellow rectangle at another expected menu position must not beat
  // the real star. An expected position alone is likewise not click permission.
  const rectangle = { ...fixture, data: Buffer.from(fixture.data) };
  for (let y = 88; y < 134; y++) for (let x = 198; x < 282; x++) {
    const i = (y * rectangle.width + x) * 4;
    rectangle.data[i] = 235; rectangle.data[i + 1] = 230; rectangle.data[i + 2] = 50;
  }
  await productionReplay(rectangle, [{ x: 1142, y: 839 }], null, 1);
  const onlyRectangle = { ...rectangle, data: Buffer.from(rectangle.data) };
  for (let y = 50; y < 170; y++) for (let x = 94; x < 196; x++) {
    const i = (y * rectangle.width + x) * 4;
    onlyRectangle.data[i] = onlyRectangle.data[i + 1] = onlyRectangle.data[i + 2] = 0;
  }
  await productionReplay(onlyRectangle, [], /EXEC_ACTIVATION_BUTTON_NOT_PROVEN/, 2);

  // Two real glyphs in admissible positions are ambiguous: do not pick a
  // larger/closer one. Build this negative fixture in memory, not on disk.
  const ambiguous = { ...fixture, data: Buffer.from(fixture.data) };
  for (let y = 0; y < 46; y++) fixture.data.copy(ambiguous.data,
    ((88 + y) * fixture.width + 198) * 4,
    ((78 + y) * fixture.width + 110) * 4, ((78 + y) * fixture.width + 194) * 4);
  await productionReplay(ambiguous, [], /AMBIGUOUS_ACTIVATE_ICONS/, 2);

  // Existing successful paired menus remain valid, using their original pixels.
  for (const relative of [
    'material/verified/candidates/D1_m19_equip_existing_link/2026-09-09T08-21-08-447Z/01_m19_activation/activation_roi_attempt1.png',
    'material/verified/candidates/Raye_yoto_double_effect/2026-09-10T12-54-32-725Z/02/activation_roi_attempt1.png',
    'material/verified/candidates/M14_golden_bamboo_sword/2026-09-22T15-40-53-123Z/activation_roi_attempt1.png'
  ]) {
    const image = PNG.sync.read(fs.readFileSync(path.join(ROOT, relative)));
    assert(chooseActivationButton(yellowUsableStats(image),
      { x: 0, y: 0, width: image.width, height: image.height, minComponentPixels: 500 },
      { x: 240, y: 270 }, image), relative);
  }
  console.log('PASS hand local icon: real M20; real shifted solo; larger nearby rectangle rejected; missing/ambiguous icons zero input; normal path one ROI, no added wait.');
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
