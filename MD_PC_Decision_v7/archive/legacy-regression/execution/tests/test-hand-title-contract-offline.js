'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { performance } = require('perf_hooks'), { PNG } = require('pngjs'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..'), config = require('../../live-config');
const hs = require('../../lib/hand-state'), geometry = require('../../lib/live-hand-geometry');
function section(file, start, end) {
  const text = fs.readFileSync(file, 'utf8'), a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return text.slice(a, b);
}
const fixtures = [
  { name: 'seven-HAMP', file: 'material/issues/issue-138-seven-card-one-unmeasured-title.png',
    ids: ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M07', 'M08', 'M08', 'M10', 'M18'], full: true },
  { name: 'two-grass', file: '../runs/2026-10-03T11-15-45-311Z/game-00002/before-recovery/debug/execution/V5_formal_atomic/2026-10-03T11-27-18-131Z_M19_equip/hand_target/v5_link_current_title_01.png',
    ids: ['M14', 'M19'], full: true },
  { name: 'seven-Mallet-grey', file: '../runs/2026-10-04T13-30-57-202Z/game-00001/before-recovery/debug/execution/M14_golden_bamboo_sword/2026-10-04T13-39-00-377Z/v5_current_title_target_01.png',
    ids: ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M06', 'M08', 'M14', 'M14', 'M17'], full: false }
];
async function test() {
  let publicSelections = 0, scanSelections = 0;
  for (const f of fixtures) {
    const count = f.ids.length, cards = f.ids.map((id, i) => ({ id, name: id, index: count - i }));
    const baseline = { handCount: count, cards };
    // Deliberately reversed stale card.index and NO old x/y: current array order
    // and this frame's measured title must decide the public selector too.
    const image = PNG.sync.read(fs.readFileSync(path.resolve(ROOT, f.file)));
    let frame = image, clicks = [], queries = 0, captures = 0, wrong = false, hooks = 0;
    const proven = geometry.resolveMeasuredHandTarget(image, count, 1).exposed;
    const bridge = { info: async () => ({}), key: async () => {}, move: async () => {},
      click: async (x, y) => clicks.push({ x, y }) };
    const win = { sleep: async () => {}, mapReferencePoint: (_, p) => p,
      captureReferenceRoi: async () => { captures++; return frame; } };
    const recognize = async () => {
      queries++; const point = clicks.at(-1);
      const slot = proven.slots.findIndex(s => s.measuredTitle2D && s.x === point.x && s.titleY === point.y);
      assert.ok(slot >= 0, 'never click inferred/grass/guessed Y');
      const best = { id: wrong ? 'M13' : cards[slot].id, name: cards[slot].name, mad: 0, rmse: 0, dhash: 0 };
      return { accepted: true, id: best.id, name: best.name, judged: { accepted: true, best, margin: 1 }, ranked: [best] };
    };
    const lowFile = path.join(ROOT, 'execution/core/low-hand-target.js'), native = createRequire(lowFile);
    const lowCtx = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(lowFile),
      console: { log() {} }, require: id => {
        const n = id.replace(/\\/g, '/');
        if (n.endsWith('lib/win-fast')) return win;
        if (n.endsWith('observer/scan-state')) return { recognizeCurrentCard: recognize, saveRgbaPng() { throw new Error('UNEXPECTED_WRITE'); } };
        return native(id);
      } });
    vm.runInContext(fs.readFileSync(lowFile, 'utf8'), lowCtx);
    const low = lowCtx.module.exports;
    const handFile = path.join(ROOT, 'execution/core/hand-target.js'), handNative = createRequire(handFile);
    const handCtx = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(handFile),
      console: { log() {} }, require: id => {
        if (id === './low-hand-target') return low;
        if (id.includes('capture-hand-scroll-segments-live')) return { recognizeDenseTargetSlots() { throw new Error('UNEXPECTED_DENSE_SCAN'); } };
        return handNative(id);
      } });
    vm.runInContext(fs.readFileSync(handFile, 'utf8'), handCtx);
    const options = { bridge, info: {}, library: {}, templates: [], baseline, onBeforeSelect: async () => { hooks++; } };
    for (let i = 0; i < count; i++) {
      if (!geometry.resolveMeasuredHandTarget(image, count, i + 1).clickable) continue;
      if (cards.findIndex(c => c.id === cards[i].id) !== i) continue;
      clicks = []; queries = 0; captures = 0; hooks = 0;
      const selected = await handCtx.module.exports.selectObservedHandCard({ ...options, expectedId: cards[i].id });
      assert.strictEqual(selected.slot, i + 1); assert.strictEqual(clicks.length, 2);
      assert.strictEqual(captures, 1); assert.strictEqual(queries, 1); assert.strictEqual(hooks, 1);
      assert.strictEqual(selected.positioning.driftPx, null); publicSelections++;
    }
    const available = cards.findIndex((c, i) => geometry.resolveMeasuredHandTarget(image, count, i + 1).clickable && cards.findIndex(row => row.id === c.id) === i);
    wrong = true; clicks = [];
    await assert.rejects(low.selectObservedLowHandCard({ ...options, expectedId: cards[available].id }), /HAND_SELECTION_MISMATCH/);
    assert.strictEqual(clicks.length, 2); wrong = false;
    clicks = []; await assert.rejects(low.selectObservedLowHandCard({ ...options, baseline: { ...baseline, cards: cards.slice(1) }, expectedId: cards[available].id }), /BASELINE_INVALID/);
    assert.strictEqual(clicks.length, 0);
    frame = { ...image, data: Buffer.alloc(image.data.length) }; queries = 0; clicks = [];
    await assert.rejects(low.selectObservedLowHandCard({ ...options, expectedId: cards[available].id }), /NOT_PROVEN/);
    assert.strictEqual(queries, 0); assert.ok(clicks.every(p => p.y < 940)); frame = image;
    // Actual full observer scan, not just a geometry helper or fake selection.
    // Card classification is stubbed; real pixels decide every physical slot.
    if (f.full) {
      const scanFile = path.join(ROOT, 'runtime/observer/scan-state.js');
      const ctx = vm.createContext({ path, __dirname: path.dirname(scanFile), performance, config,
        console: { log() {} }, ...win, ...hs, resolveMeasuredHandTarget: geometry.resolveMeasuredHandTarget,
        normalizeScanOptions: opts => ({ initialCardSettleMs: 0, stableAcceptedSamples: 2, observerFast: true, failOnUnknown: true, ...opts }),
        normalizeExodiaComponentCard: c => c, recognizeCurrentCard: recognize, recognitionConfidence: () => 1,
        printTop3() {}, saveRgbaPng() {}, saveLayoutOverlay() { throw new Error('UNEXPECTED_FULL_CAPTURE'); } });
      vm.runInContext(section(scanFile, 'async function scanOneState(', 'async function main('), ctx);
      clicks = []; queries = 0; captures = 0;
      const scan = await ctx.scanOneState(bridge, {}, {}, [], { authoritativeCount: count });
      assert.deepStrictEqual(Array.from(scan.cards, c => c.id), f.ids);
      assert.strictEqual(scan.cards.length, count); assert.strictEqual(captures, count + 1);
      assert.strictEqual(queries, count); assert.strictEqual(clicks.length, count); scanSelections += count;
    }
    const started = performance.now(); geometry.resolveMeasuredHandTarget(image, count, count);
    console.log(`HAND_TITLE_CONTRACT_FRAME ${f.name}: ${(performance.now() - started).toFixed(0)}ms; one supplied ROI, no additional capture`);
  }
  // All four consumers must reference the same pure geometry gate. UI reset,
  // sleeps and identity checks stay in the original caller-owned workflow.
  for (const rel of ['execution/core/low-hand-target.js', 'execution/core/executor-preload.js',
    'execution/core/atomic-route-executor.js', 'runtime/observer/scan-state.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('resolveMeasuredHandTarget('), rel);
  }
  console.log(`HAND_TITLE_CONTRACT_OFFLINE_PASS; public selections=${publicSelections}; actual full-scan slots=${scanSelections}; stale index/no old XY guarded; long-name/rim/grass/grey evidence; wrong identity/blank/bad baseline stopped; nativeInputs=0/diskWrites=0`);
}
test().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
