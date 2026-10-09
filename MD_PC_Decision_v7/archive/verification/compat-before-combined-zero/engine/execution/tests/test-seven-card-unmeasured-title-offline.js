'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { PNG } = require('pngjs'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..'), hs = require('../../lib/hand-state');
const config = require('../../live-config'), { absoluteComponentEstimate } = require('../../lib/live-hand-geometry');
const old = require('../../../runs/2026-10-05T05-32-24-567Z/engine-source/lib/hand-state');
function segment(file, start, end) {
  const s = fs.readFileSync(file, 'utf8'), a = s.indexOf(start), b = s.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return s.slice(a, b);
}
async function test() {
  let frame = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/issues/issue-138-seven-card-one-unmeasured-title.png')));
  assert.strictEqual(old.estimateClickableHandTitles(frame, 7).count, 4);
  assert.deepStrictEqual(hs.estimateHandCountByTitleComponents(frame), old.estimateHandCountByTitleComponents(frame));
  const detected = hs.detectHandCountFromImage(frame, 7, { purpose: 'CLICK_TARGET' });
  assert.strictEqual(detected.componentEstimate.evidence, 'FULL_FAN_COUNT_AND_MEASURED_PATCHES');
  assert.strictEqual(detected.componentEstimate.components[4].titleEvidence, 'BOUNDED_PATCH_AND_CARD_RIM');
  const exposed = hs.resolveExposedFanSlots(hs.getHandLayout(7), absoluteComponentEstimate(detected));
  assert.strictEqual(exposed.source, 'TITLE_COMPONENTS');
  assert.strictEqual(exposed.slots[4].measuredTitle2D, true);
  assert.strictEqual(exposed.slots[6].measuredTitle2D, true);
  assert.strictEqual(exposed.slots[6].x, 1430);
  assert.strictEqual(exposed.slots[6].titleY, 1028);
  const cards = ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M07', 'M08', 'M08', 'M10', 'M18'].map(id => ({ id }));
  const baseline = { handCount: 7, cards }, file = path.join(ROOT, 'execution/core/executor-preload.js'), native = createRequire(file);
  let clicks = [], queries = 0, wrong = false;
  const bridge = { info: async () => ({}), key: async () => {}, click: async (x, y) => clicks.push({ x, y }) };
  const recognize = async () => {
    queries++; const point = clicks.at(-1);
    const slot = exposed.slots.findIndex(s => s.x === point.x && s.titleY === point.y);
    assert.ok(slot >= 0, 'only an actual measured patch is clickable');
    return { accepted: true, id: wrong ? 'M13' : cards[slot].id };
  };
  const ctx = vm.createContext({ ROOT, path, console: { log() {} }, normalizeRecognized: x => x,
    sameRuntimeCardIdentity: (id, row) => id === row.id, require: id => {
      const n = id.replace(/\\/g, '/');
      if (n.endsWith('lib/hand-state')) return hs;
      if (n.endsWith('lib/win-fast')) return { sleep: async () => {}, mapReferencePoint: (_, p) => p, captureReferenceRoi: async () => frame };
      if (n.endsWith('observer/scan-state')) return { saveRgbaPng() { throw new Error('UNEXPECTED_DISK_WRITE'); }, recognizeCurrentCard: recognize };
      return native(id);
    } });
  vm.runInContext(segment(file, 'async function selectExactLowHandOrdinal(', 'function installExactSlotSelection('), ctx);
  const options = { bridge, info: {}, baseline, library: require('../../card-library.json'), templates: [] };
  const selected = await ctx.selectExactLowHandOrdinal(options, 7, 'M18', cards);
  assert.strictEqual(selected.slot, 7); assert.strictEqual(clicks.length, 2); assert.strictEqual(queries, 1);
  const atomic = vm.createContext({ ROOT, path, config, console: { log() {} }, require: native,
    getHandLayout: hs.getHandLayout, detectHandCountFromImage: hs.detectHandCountFromImage,
    resolveExposedFanSlots: hs.resolveExposedFanSlots, mapReferencePoint: (_, p) => p,
    sleep: async () => {}, captureReferenceRoi: async () => frame, normalizeRecognized: x => x,
    recognizeCurrentCard: recognize });
  vm.runInContext(segment(path.join(ROOT, 'execution/core/atomic-route-executor.js'),
    'async function selectCurrentObservedHandCard(', 'function runObserver('), atomic);
  clicks = []; await atomic.selectCurrentObservedHandCard({ ...options, expectedId: 'M18' });
  assert.strictEqual(clicks.length, 2); assert.strictEqual(queries, 2);
  clicks = []; let before = queries;
  const hamp = await ctx.selectExactLowHandOrdinal(options, 5, 'M08', cards);
  assert.strictEqual(hamp.slot, 5); assert.strictEqual(queries, before + 1); assert.strictEqual(clicks.length, 2);
  wrong = true; clicks = [];
  await assert.rejects(ctx.selectExactLowHandOrdinal(options, 7, 'M18', cards), /HAND_SELECTION_MISMATCH/);
  assert.strictEqual(clicks.length, 2);
  frame = { ...frame, data: Buffer.alloc(frame.data.length) }; before = queries; clicks = [];
  await assert.rejects(ctx.selectExactLowHandOrdinal(options, 7, 'M18', cards), /NOT_MEASURED/);
  assert.strictEqual(queries, before);
  // Explicit synthetic evidence boundary; no made-up pixels in the real replay.
  let absent = [4], outlined = 2, centers = [282, 415, 548, 683, 822, 960, 1110];
  const boundary = vm.createContext({ config, getHandLayout: hs.getHandLayout, resolveExposedFanSlots: hs.resolveExposedFanSlots,
    estimateHandCountByTitleComponents: () => ({ count: centers.length, components: centers.map((centerX, index) => ({ centerX, index })) }),
    measureTitlePatch: (_, c, rim) => absent.includes(c.index) || (rim && c.index >= outlined) ? null : { ...c, centerY: 60, title2D: true } });
  vm.runInContext(segment(path.join(ROOT, 'lib/hand-state.js'), 'function estimateClickableHandTitles(', '// A projected green/brown column'), boundary);
  const evidence = n => boundary.estimateClickableHandTitles({}, n)?.evidence;
  assert.strictEqual(evidence(7), 'FULL_FAN_ONE_UNMEASURED_TITLE');
  absent = [3, 4]; assert.notStrictEqual(evidence(7), 'FULL_FAN_ONE_UNMEASURED_TITLE');
  absent = [4]; outlined = 1; assert.notStrictEqual(evidence(7), 'FULL_FAN_ONE_UNMEASURED_TITLE');
  outlined = 2; centers[3] = 590; assert.notStrictEqual(evidence(7), 'FULL_FAN_ONE_UNMEASURED_TITLE');
  centers = [282, 415]; absent = [1]; assert.notStrictEqual(evidence(2), 'FULL_FAN_ONE_UNMEASURED_TITLE');
  for (const count of [3, 4, 5, 6]) {
    centers = Array.from({ length: count }, (_, i) => 282 + 133 * i); absent = [count - 1]; outlined = 2;
    assert.strictEqual(evidence(count), 'FULL_FAN_ONE_UNMEASURED_TITLE', 'uniform full-fan ordinal proof, not a seven-card exception');
    const estimate = boundary.estimateClickableHandTitles({}, count);
    const resolved = hs.resolveExposedFanSlots(hs.getHandLayout(count), { ...estimate,
      components: estimate.components.map(c => ({ ...c, centerX: c.centerX + config.handFan.detectRoi.x,
        centerY: Number.isFinite(c.centerY) ? c.centerY + config.handFan.detectRoi.y : undefined })) });
    assert.strictEqual(resolved.slots.at(-1).measuredTitle2D, undefined, 'ordering evidence never grants click permission');
    assert.strictEqual(resolved.slots[0].measuredTitle2D, true);
  }
  console.log('SEVEN_CARD_TITLE_OFFLINE_PASS; actual old four-title failure reproduced; M18 plus HAMP bounded real patch; both production selectors; unmeasured synthetic/blank/wrong identity rejected; count semantics unchanged; no added capture/wait; nativeInputs=0/diskWrites=0');
}
test().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
