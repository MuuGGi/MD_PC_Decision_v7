'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const { proveFirstDrawTab } = require('../core/m21-chicken-game-route');
const card = require('../cards/m21-chicken-game');
const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(ROOT, 'execution/core/m21-chicken-game-route.js');
const evidence = path.join(ROOT, 'material/verified/evidence/M21_chicken_game/2026-10-06T00-55-33-280Z');
const body = PNG.sync.read(fs.readFileSync(path.join(evidence, '04_draw_option/m21_draw_option_body_latest.png')));
const field = PNG.sync.read(fs.readFileSync(path.join(evidence, '03_field_effect/m21_field_effect_button.png')));
const tabs = cropImage(body, { x: 60, y: 115, width: 1020, height: 49 });
assert(proveFirstDrawTab(body).selected);
assert(proveFirstDrawTab(tabs, { x: 60, y: 115 }).selected);

const wrongBody = { ...body, data: Buffer.from(body.data) };
for (const [cx, rgb] of [[226, [20, 50, 75]], [568, [130, 180, 20]]]) {
  for (let y = 125; y < 150; y++) for (let x = cx - 72; x < cx + 72; x++) {
    const i = (y * body.width + x) * 4;
    wrongBody.data[i] = rgb[0]; wrongBody.data[i + 1] = rgb[1]; wrongBody.data[i + 2] = rgb[2];
  }
}
assert.strictEqual(proveFirstDrawTab(wrongBody).selected, false);
const wrongTabs = cropImage(wrongBody, { x: 60, y: 115, width: 1020, height: 49 });
const partialBody = { ...body, data: Buffer.from(body.data) };
for (let y = 125; y < 150; y++) for (let x = 154; x < 298; x++) {
  const i = (y * body.width + x) * 4;
  partialBody.data[i] = 20; partialBody.data[i + 1] = 50; partialBody.data[i + 2] = 75;
}
assert.strictEqual(proveFirstDrawTab(partialBody).selectedTab, null, 'animation is not proof of wrong effect');
const nonModal = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/issues/issue-137-after-failed-click.png')));
assert.strictEqual(proveFirstDrawTab(cropImage(nonModal, card.drawOptionDialog.bodyRoi)).selected, false,
  'ordinary field colours are not selected tabs');

async function replay(mode) {
  const captures = [], clicks = [], waits = [];
  let submissions = 0;
  let bodyCaptures = 0;
  const actualRequire = createRequire(SOURCE);
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(SOURCE),
    console: { log() {} }, require: id => {
      if (id.endsWith('win-fast')) return {
        captureReferenceRoi: async (_bridge, _info, roi) => {
          captures.push(roi);
          if (roi.width === 130) return field;
          if (roi.width === 1135) {
            bodyCaptures++;
            return mode === 'WRONG_INITIAL' ? wrongBody : mode === 'PARTIAL' && bodyCaptures === 1 ? partialBody : body;
          }
          assert.strictEqual(roi.width, 1020, 'only final tab strip, not a new full hand/board capture');
          assert.strictEqual(roi.height, 49);
          return mode === 'CHANGED' ? wrongTabs : tabs;
        },
        mapReferencePoint: (_, point) => point, sleep: async ms => waits.push(ms)
      };
      if (id.endsWith('self-priority-gate')) return { waitForSelfPriorityBlue: async () => ({ safeForRecognitionAndControl: true }) };
      return actualRequire(id);
    }
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: SOURCE });
  const options = { bridge: { click: async (x, y) => clicks.push({ x, y }) }, info: {}, card,
    beforeSubmit: () => { submissions++; } };
  if (mode === 'FIELD') {
    const result = await context.module.exports.clickFieldEffectButton(options);
    assert(result.glyphProof.chosen.glyph.pass);
    assert.deepStrictEqual(clicks, [{ x: 555, y: 564 }]);
    assert.strictEqual(captures.length, 1);
  } else {
    const action = () => context.module.exports.confirmDefaultDrawOne(options);
    if (mode === 'WRONG_INITIAL') await assert.rejects(action, /M21_DRAW_ONE_NOT_SELECTED/);
    else if (mode === 'CHANGED') await assert.rejects(action, /M21_DRAW_ONE_SELECTION_CHANGED/);
    else {
      const result = await action();
      assert(result.drawOneProof.selected && result.finalDrawOneProof.selected);
      assert.deepStrictEqual(clicks, [{ x: 1024, y: 790 }]);
    }
    assert.strictEqual(captures.length, mode === 'WRONG_INITIAL' ? 1 : mode === 'PARTIAL' ? 3 : 2);
    if (!['PASS', 'PARTIAL'].includes(mode)) assert.deepStrictEqual(clicks, []);
    assert.deepStrictEqual(waits, mode === 'PASS' ? [1000, 1200] : mode === 'PARTIAL' ? [120, 1000, 1200] : mode === 'CHANGED' ? [1000] : []);
  }
  assert.strictEqual(submissions, ['PASS', 'PARTIAL', 'FIELD'].includes(mode) ? 1 : 0);
}
(async () => {
  for (const mode of ['FIELD', 'PASS', 'PARTIAL', 'WRONG_INITIAL', 'CHANGED']) await replay(mode);
  console.log('PASS Chicken Game evidence: actual field Activate glyph; same-frame body/OK/selected Draw1; final tab recheck replaces redundant OK capture; other/changed effect zero input; no added normal capture count or wait, no game/state writes.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
