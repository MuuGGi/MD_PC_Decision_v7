'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');
const { yellowUsableStats } = require('../../lib/hand-state');
const { chooseExtraDeckSummonIcon } = require('../core/link-carrier-summon');
const { resolveObservedExtraZone } = require('../core/field-zone-geometry');
const { detectEquipConfirmButton } = require('../core/field-link-target');
const { choosePrompt } = require('../../../policy');
const { locateFieldActivateIcon } = require('../core/hand-action-icon');
const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
const pendingLiteral = /const TRANSACTION_PENDING_NODES = new Set\((\[[\s\S]*?\])\);/.exec(main);
assert(pendingLiteral);
for (const node of require('vm').runInNewContext(pendingLiteral[1])) {
  assert.strictEqual(choosePrompt(`V5[${node}]> `), '', node);
}
assert.throws(() => choosePrompt('V5[NEW_UNREVIEWED_NODE]> '), /UNKNOWN_PROMPT/);
const atomsSource = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
assert(!atomsSource.includes('function chooseRoundEffectButton('));
assert(!atomsSource.includes('function chooseRayeGreenRingEffectButton('));
assert(atomsSource.includes('locateFieldActivateIcon(image, stats, effectRoi, expected)'));
const yellowContext = require('vm').createContext({});
require('vm').runInContext(atomsSource.slice(atomsSource.indexOf('function chooseYellowComponent('),
  atomsSource.indexOf('async function clickYellowButton(')), yellowContext);
for (const [file, roi] of [
  ['Raye_yoto_double_effect/2026-09-10T12-54-32-725Z/07/optional_select_latest.png',
    { x: 1030, y: 1025, width: 340, height: 120 }],
  ['Hornet_kagari_raye_double_link/2026-09-10T13-11-13-229Z/03/link_summon_submit_latest.png',
    { x: 998, y: 1035, width: 360, height: 110 }]
]) {
  const image = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/verified/candidates', file)));
  const stats = yellowUsableStats(image);
  const chosen = yellowContext.chooseYellowComponent(stats, roi, { x: 1178, y: 1088 });
  assert(chosen && chosen.drift <= 40, file);
  const farBadge = stats.components.filter(c => c.centerX < 80);
  assert.strictEqual(yellowContext.chooseYellowComponent({ components: farBadge }, roi,
    { x: 1178, y: 1088 }), null, 'the larger left badge is not a submit label');
}

for (const [file, roi, expected] of [
  ['D4_m20_true_bamboo_route/2026-09-09T11-10-48-769Z/05_m20_field_effect/field_m20_effect_button_latest.png',
    { x: 830, y: 612, width: 360, height: 190 }, { x: 1022, y: 734 }],
  ['Raye_yoto_double_effect/2026-09-10T12-54-32-725Z/05/effect_button_1.png',
    { x: 840, y: 456, width: 370, height: 220 }, { x: 1025, y: 569 }],
  ['Raye_yoto_double_effect/2026-09-10T12-54-32-725Z/05/effect_button_2.png',
    { x: 840, y: 456, width: 370, height: 220 }, { x: 1025, y: 569 }]
]) {
  const image = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/verified/candidates', file)));
  const proof = locateFieldActivateIcon(image, yellowUsableStats(image), roi, expected);
  assert(proof.chosen && proof.chosen.glyph.pass, file);
  const blank = { ...image, data: Buffer.alloc(image.data.length) };
  assert.strictEqual(locateFieldActivateIcon(blank, yellowUsableStats(blank), roi, expected).chosen, null);
  const misplaced = { x: expected.x + 130, y: expected.y };
  assert.strictEqual(locateFieldActivateIcon(image, yellowUsableStats(image), roi, misplaced).chosen, null);
}

assert.deepStrictEqual(resolveObservedExtraZone({ x: 835, y: 415 }).clickReference, { x: 835, y: 515 });
assert.deepStrictEqual(resolveObservedExtraZone({ x: 1213, y: 445 }).clickReference, { x: 1213, y: 515 });
assert.throws(() => resolveObservedExtraZone({ x: 355, y: 635 }), /NOT_IN_EXTRA_MONSTER_ZONE/);
assert.throws(() => resolveObservedExtraZone({ x: 1213, y: 445 }, { x: 835, y: 415 }), /ANCHOR_MISMATCH/);
assert.throws(() => resolveObservedExtraZone({ x: NaN, y: 515 }), /REFERENCE_REQUIRED/);

const extraFiles = [
  'D2_m19_carrier_link/2026-09-09T08-22-18-124Z/01_open_extra',
  'D4_m20_true_bamboo_route/2026-09-09T11-10-48-769Z/10_extra_deck',
  'Hornet_kagari_raye_double_link/2026-09-10T13-11-13-229Z/02',
  'Hornet_kagari_raye_double_link/2026-09-10T13-11-13-229Z/12',
  'Hornet_kagari_true_bamboo_wind/2026-09-10T12-42-14-247Z/02',
  'Hornet_kagari_true_bamboo_wind/2026-09-10T12-42-14-247Z/13'
];
for (const dir of extraFiles) {
  const image = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/verified/candidates',
    dir, 'extra_deck_summon_button_latest.png')));
  const proof = chooseExtraDeckSummonIcon(image, yellowUsableStats(image));
  assert(proof.chosen && proof.chosen.glyph.pass, dir);
  assert(Math.abs(330 + proof.chosen.centerX - 392) <= 30);
  assert(Math.abs(800 + proof.chosen.centerY - 846) <= 30);
  const rectangle = { ...image, data: Buffer.alloc(image.data.length) };
  for (let y = 30; y < 95; y++) for (let x = 30; x < 100; x++) {
    const i = (y * image.width + x) * 4;
    rectangle.data[i] = 235; rectangle.data[i + 1] = 230; rectangle.data[i + 2] = 50;
  }
  assert.strictEqual(chooseExtraDeckSummonIcon(rectangle, yellowUsableStats(rectangle)).chosen, null);
}
for (const relative of [
  'D1_m19_equip_existing_link/2026-09-09T08-21-08-447Z/03_equip_confirm/equip_target_confirm_latest',
  'D4_m20_true_bamboo_route/2026-09-09T11-10-48-769Z/03_m20_equip_confirm/m20_equip_confirm_latest',
  'D4_m20_true_bamboo_route/2026-09-09T11-10-48-769Z/08_m19_equip_confirm/m19_after_m20_confirm_latest',
  'Raye_yoto_double_effect/2026-09-10T12-54-32-725Z/04/equip_target_confirm_latest'
]) {
  const base = path.join(ROOT, 'material/verified/candidates', relative);
  const stored = JSON.parse(fs.readFileSync(base + '.json', 'utf8')).probe;
  const frame = PNG.sync.read(fs.readFileSync(base + '.png'));
  const proof = detectEquipConfirmButton(frame, stored.anchorReference);
  assert(proof.chosen, relative);
  assert(Math.abs(proof.chosen.centerX - stored.anchorReference.x) <= 50);
  assert(Math.abs(proof.chosen.centerY - (stored.anchorReference.y - 140)) <= 50);
}
console.log('PASS input evidence audit: six Extra Summon + three field Activate + four Confirm originals; arbitrary colour/misplaced glyph rejects; fuzzy field centre never clicked; wrong zone/unknown auto prompt closes. No game input or state writes.');
