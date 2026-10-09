'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module'), { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const RUN = path.resolve(ROOT, '../runs/2026-10-04T13-30-57-202Z');
const SNAP = path.join(RUN, 'game-00001/before-recovery');
const hs = require('../../lib/hand-state'), config = require('../../live-config');
const { absoluteComponentEstimate } = require('../../lib/live-hand-geometry');
const library = require('../../card-library.json');
function segment(file, start, end) {
  const source = fs.readFileSync(file, 'utf8'), a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
function testFanEvidenceBoundary() {
  // Explicit boundary injection, separate from the real pixel replays below.
  let centers = [364, 504, 637, 770, 917, 1071], outlined = 2, absent = -1;
  const ctx = vm.createContext({ config, Number,
    getHandLayout: hs.getHandLayout, resolveExposedFanSlots: hs.resolveExposedFanSlots,
    estimateHandCountByTitleComponents: () => ({ count: centers.length,
      components: centers.map((centerX, index) => ({ centerX, index })) }),
    measureTitlePatch: (_, component, rim) => component.index === absent || (rim && component.index >= outlined)
      ? null : { ...component, centerY: 60, title2D: true } });
  vm.runInContext(segment(path.join(ROOT, 'lib/hand-state.js'),
    'function estimateClickableHandTitles(', '// A projected green/brown column'), ctx);
  const estimate = () => ctx.estimateClickableHandTitles({}, 7);
  assert.strictEqual(estimate().evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES');
  outlined = 1;
  assert.notStrictEqual(estimate()?.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES', 'one rim cannot prove a fan');
  outlined = 2; absent = 3;
  assert.notStrictEqual(estimate()?.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES', 'every visible title must have a real 2D patch');
  absent = -1; centers = [364, 504, 637, 770, 917];
  assert.notStrictEqual(estimate()?.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES', 'two missing titles rejected');
  centers = [364, 504, 637, 800, 870, 1071];
  assert.notStrictEqual(estimate()?.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES', 'irregular grass-like components rejected');
  centers = [224, 364, 504, 637, 770, 917];
  const right = estimate();
  assert.strictEqual(right.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES');
  const resolved = hs.resolveExposedFanSlots(hs.getHandLayout(7), absoluteComponentEstimate({ componentEstimate: right }));
  assert.strictEqual(resolved.source, 'TITLE_COMPONENTS_INFERRED_RIGHT');
  assert.strictEqual(resolved.slots[6].measuredTitle2D, undefined, 'right inference is not click proof either');
}
async function test() {
  testFanEvidenceBoundary();
  // Read the real successful Mallet transaction, then its six actual failed
  // continuation frames. No new screenshots, state writes or native input.
  const malletDir = path.join(SNAP, 'debug/execution/M11_mallet_keep_weapon/2026-10-04T13-38-06-391Z');
  const result = JSON.parse(fs.readFileSync(path.join(malletDir, 'result.json')));
  const resync = JSON.parse(fs.readFileSync(path.join(malletDir, 'final_full_resync.json')));
  const baseline = JSON.parse(fs.readFileSync(path.join(SNAP, 'debug/hand-change-live/session_state.json')));
  assert.strictEqual(result.status, 'PASS'); assert.strictEqual(resync.status, 'PASS');
  assert.strictEqual(result.afterHandCount, 7); assert.strictEqual(baseline.handCount, 7);
  const cards = baseline.cards;
  assert.deepStrictEqual(cards.map(c => c.id), ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M06', 'M08', 'M14', 'M14', 'M17']);
  assert.strictEqual(cards[4].usable, true); assert.strictEqual(cards[5].usable, true);
  const old = require(path.join(RUN, 'engine-source/lib/hand-state'));
  const file = path.join(ROOT, 'execution/core/executor-preload.js'), native = createRequire(file);
  let frame, clicks = [], queries = 0, wrong = false;
  const bridge = { info: async () => ({}), key: async () => {}, click: async (x, y) => clicks.push({ x, y }) };
  function recognize() {
    queries++;
    const point = clicks.at(-1), x = point.x - config.handFan.detectRoi.x;
    const slot = [null, 364, 504, 637, 770, 917, 1071].findIndex(cx => cx !== null && Math.abs(cx - x) <= 10);
    assert.ok(slot >= 1, 'target must be a real labelled title, never the inferred first card');
    assert.ok(point.y >= 978 && point.y <= 1036, 'target Y must be on its actual title');
    return { accepted: true, id: wrong ? 'M13' : cards[slot].id, name: cards[slot].name };
  }
  function lowContext(detector) {
    const ctx = vm.createContext({ ROOT, path, console: { log() {} }, normalizeRecognized: x => x,
      sameRuntimeCardIdentity: (id, row) => id === row.id,
      require: id => {
        const normalized = id.replace(/\\/g, '/');
        if (normalized.endsWith('lib/hand-state')) return detector;
        if (normalized.endsWith('lib/win-fast')) return { sleep: async () => {}, mapReferencePoint: (_, p) => p, captureReferenceRoi: async () => frame };
        if (normalized.endsWith('observer/scan-state')) return { saveRgbaPng() { throw new Error('DISK_WRITE_FORBIDDEN'); }, recognizeCurrentCard: async () => recognize() };
        return native(id);
      } });
    vm.runInContext(segment(file, 'async function selectExactLowHandOrdinal(', 'function installExactSlotSelection('), ctx);
    return ctx;
  }
  const current = lowContext(hs), archived = lowContext(old);
  const atomic = vm.createContext({ ROOT, path, config, console: { log() {} }, require: createRequire(file),
    getHandLayout: hs.getHandLayout, detectHandCountFromImage: hs.detectHandCountFromImage,
    resolveExposedFanSlots: hs.resolveExposedFanSlots, mapReferencePoint: (_, p) => p,
    sleep: async () => {}, captureReferenceRoi: async () => frame, normalizeRecognized: x => x,
    recognizeCurrentCard: async () => recognize() });
  vm.runInContext(segment(path.join(ROOT, 'execution/core/atomic-route-executor.js'),
    'async function selectCurrentObservedHandCard(', 'function runObserver('), atomic);
  const options = { bridge, info: {}, library, templates: [], baseline };
  let selections = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    frame = PNG.sync.read(fs.readFileSync(path.join(SNAP,
      `debug/execution/M14_golden_bamboo_sword/2026-10-04T13-39-00-377Z/v5_current_title_target_0${attempt}.png`)));
    assert.strictEqual(old.estimateHandCountByTitleComponents(frame).count, 6);
    assert.strictEqual(old.estimateClickableHandTitles(frame, 7).count, 5, 'reproduce compound projection/rim regression');
    if (attempt === 1) {
      clicks = []; const before = queries;
      await assert.rejects(archived.selectExactLowHandOrdinal(options, 5, 'M14', cards), /NOT_MEASURED/);
      assert.strictEqual(queries, before); assert.strictEqual(clicks.length, 6, 'old code only performs six neutral resets');
    }
    const passive = hs.estimateHandCountByTitleComponents(frame);
    assert.deepStrictEqual(passive, old.estimateHandCountByTitleComponents(frame), 'passive count semantics unchanged');
    const detected = hs.detectHandCountFromImage(frame, 7, { purpose: 'CLICK_TARGET' });
    assert.strictEqual(detected.componentEstimate.count, 6, 'retain every actually measured title including grey Engage');
    assert.strictEqual(detected.componentEstimate.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES');
    const exposed = hs.resolveExposedFanSlots(hs.getHandLayout(7), absoluteComponentEstimate(detected), { baselineCards: cards });
    assert.strictEqual(exposed.source, 'TITLE_COMPONENTS_INFERRED_LEFT');
    assert.strictEqual(exposed.slots[0].measuredTitle2D, undefined, 'inference never manufactures click evidence');
    assert.ok(Math.abs(exposed.slots[4].x - 1090) <= 10, 'real Golden title, not the old guessed x=1167');
    for (let slot = 2; slot <= 7; slot++) {
      clicks = [];
      const selected = await current.selectExactLowHandOrdinal(options, slot, cards[slot - 1].id, cards);
      assert.strictEqual(selected.slot, slot); assert.strictEqual(clicks.length, 2);
      assert.strictEqual(selected.clickReference.x, exposed.slots[slot - 1].x);
      assert.strictEqual(selected.clickReference.y, exposed.slots[slot - 1].titleY); selections++;
    }
    for (const id of ['M06', 'M08', 'M14', 'M17']) {
      clicks = []; const selected = await atomic.selectCurrentObservedHandCard({ ...options, expectedId: id });
      assert.strictEqual(selected.slot, cards.findIndex(c => c.id === id) + 1);
      assert.strictEqual(clicks.length, 2); selections++;
    }
  }
  clicks = []; let before = queries;
  await assert.rejects(current.selectExactLowHandOrdinal(options, 1, cards[0].id, cards), /NOT_MEASURED/);
  assert.strictEqual(queries, before); assert.strictEqual(clicks.length, 6, 'inferred edge never receives target input');
  wrong = true; clicks = [];
  await assert.rejects(current.selectExactLowHandOrdinal(options, 5, 'M14', cards), /HAND_SELECTION_MISMATCH/);
  assert.strictEqual(clicks.length, 2, 'wrong identity stops before activation');
  clicks = []; await assert.rejects(atomic.selectCurrentObservedHandCard({ ...options, expectedId: 'M14' }), /HAND_SELECTION_MISMATCH/);
  assert.strictEqual(clicks.length, 2);
  const twoMissing = hs.estimateClickableHandTitles(frame, 8);
  assert.notStrictEqual(twoMissing?.evidence, 'PARTIAL_FAN_COUNT_AND_MEASURED_PATCHES', 'two missing titles cannot use the edge contract');
  frame = { width: frame.width, height: frame.height, data: Buffer.alloc(frame.data.length) };
  before = queries; clicks = [];
  await assert.rejects(current.selectExactLowHandOrdinal(options, 5, 'M14', cards), /NOT_MEASURED/);
  assert.strictEqual(queries, before); assert.strictEqual(clicks.length, 6);
  console.log(`M11_NEXT_HAND_TARGET_OFFLINE_PASS; successful real Mallet resync -> six actual failed continuation frames; archived failure reproduced; ${selections} production selections; both Golden ordinals; grey Engage retained; inferred/blank targets rejected; identity guard; diskWrites=0/nativeInputs=0`);
}
if (require.main === module) test().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { test };
