'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const config = require('../../live-config'), hs = require('../../lib/hand-state');
const { absoluteComponentEstimate } = require('../../lib/live-hand-geometry');
const { medianSpacing } = require('../../lib/dense-hand-segmenter');
const { planDenseTargetWindows } = require('../../lib/dense-hand-targeting');
const { resolveDenseMeasuredWindow } = require('../../lib/dense-hand-geometry');
const source = fs.readFileSync(path.join(ROOT, 'runtime/observer/capture-hand-scroll-segments-live.js'), 'utf8');
function segment(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
function crop(image, roi, origin = { x: 0, y: 0 }) {
  const result = { width: roi.width, height: roi.height, data: Buffer.alloc(roi.width * roi.height * 4) };
  for (let y = 0; y < roi.height; y++) {
    const from = ((y + roi.y - origin.y) * image.width + roi.x - origin.x) * 4;
    image.data.copy(result.data, y * roi.width * 4, from, from + roi.width * 4);
  }
  return result;
}
async function replay(name, slot, expectedId, bounds) {
  const image = PNG.sync.read(fs.readFileSync(path.join(ROOT, `material/issues/issue-135-${name}.png`)));
  const origin = name === 'dense-hover-failure' ? { x: 260, y: 790 } : { x: 0, y: 0 };
  const captures = [], clicks = [], sleeps = [], events = [];
  let queries = 0;
  const bridge = { mouseUp: async () => events.push('UP'), move: async (x, y) => {
    assert.ok(y < 300, 'neutral pointer must leave hand'); events.push('MOVE');
  }, key: async key => events.push(key), click: async (x, y) => { events.push('HAND_CLICK'); clicks.push({ x, y }); } };
  const ctx = vm.createContext({ ROOT, config, path, console: { log() {} },
    SAFE_X_MIN: 640, SAFE_X_MAX: 1460, SAFE_CLICK_Y: 1006,
    fs: { mkdirSync() {} }, writeJson() {}, saveRgbaPng() {},
    detectHandCountFromImage: hs.detectHandCountFromImage, absoluteComponentEstimate, medianSpacing,
    resolveDenseMeasuredWindow, planDenseTargetWindows,
    mapReferencePoint: (_, point) => point, sleep: async ms => sleeps.push(ms),
    captureReferenceRoi: async (_, __, roi) => { captures.push(roi); return crop(image, roi, origin); },
    getKnownDenseWindow: () => 'RIGHT_EDGE', normalizedRecognition: x => x,
    recognizeCurrentCard: async () => {
      queries++;
      const point = clicks.at(-1);
      assert.ok(point.x >= bounds[0] && point.x <= bounds[1], `actual title X: ${point.x}`);
      assert.ok(point.y >= bounds[2] && point.y <= bounds[3], `actual title Y: ${point.y}`);
      return { accepted: true, id: expectedId, name: expectedId };
    }
  });
  vm.runInContext(segment('function medianNumbers(', 'function safeClickY(') +
    segment('async function detectGeometry(', 'async function captureGeometry(') +
    segment('async function recognizeDenseTargetSlots(', 'async function selectDenseObservedWitness('), ctx);
  // Position is already cached; production still clears state and recaptures
  // once before the target. Frozen real images model a hover that persists.
  ctx.positionTargetWindow = async () => ctx.detectGeometry(bridge, {});
  const began = performance.now();
  const result = await ctx.recognizeDenseTargetSlots({ bridge, info: {}, library: {}, templates: [],
    handCount: 8, targetSlots: [slot], keepFinalSelection: true, outputDir: 'MEMORY',
    onBeforeSelect: async ({ clickReference }) => {
      assert.strictEqual(clicks.length, 0);
      assert.ok(clickReference.x >= bounds[0] && clickReference.x <= bounds[1]);
      events.push('BEFORE_SELECT');
    } });
  assert.strictEqual(result.success, true);
  assert.strictEqual(queries, 1, 'one target identity, never whole-hand rescan');
  assert.strictEqual(clicks.length, 1);
  assert.deepStrictEqual(events.slice(0, 3), ['UP', 'MOVE', 'ESC']);
  assert.ok(events.indexOf('BEFORE_SELECT') < events.indexOf('HAND_CLICK'), 'dense callback before physical selection');
  assert.deepStrictEqual(sleeps, [90, 90], 'reuse short waits; no extra settling loop');
  assert.strictEqual(captures.filter(roi => roi.y === 860).length, name === 'user-hover' ? 0 : 1);
  console.log(`DENSE_REAL_FRAME ${name}: ${Math.round(performance.now() - began)}ms; queries=1; target=${JSON.stringify(clicks[0])}`);
  return { image, origin, ctx, bridge, clicks, captures };
}
async function run() {
  const failed = await replay('dense-hover-failure', 7, 'M15', [1220, 1250, 990, 1035]);
  const failedNarrow = crop(failed.image, config.handFan.detectRoi, failed.origin);
  const oldGeometry = absoluteComponentEstimate(hs.detectHandCountFromImage(failedNarrow, null));
  assert.ok(oldGeometry.components.slice(-5)[3].centerX < 1120,
    'reproduce old ordinal shift: relative 3 picked Trade-In, not Void');
  const hover = await replay('user-hover', 8, 'M21', [1370, 1420, 960, 1000]);
  vm.runInContext(segment('async function recognizeCentralWindow(', 'async function dragReference('), hover.ctx);
  hover.clicks.length = 0; hover.captures.length = 0;
  const labels = [823, 962, 1097, 1232, 1396], ids = ['M17', 'M17', 'M17', 'M20', 'M21'];
  hover.ctx.recognizeCurrentCard = async () => {
    const point = hover.clicks.at(-1), i = labels.findIndex(x => Math.abs(x - point.x) < 5);
    assert.ok(i >= 0 && point.y >= 960 && point.y <= 1040);
    return { accepted: true, id: ids[i], name: ids[i] };
  };
  const scan = await hover.ctx.recognizeCentralWindow({ bridge: hover.bridge, info: {}, library: {},
    templates: [], geometry: await hover.ctx.detectGeometry(hover.bridge, {}), dir: 'MEMORY',
    label: 'window', strategy: 'right' });
  assert.deepStrictEqual(Array.from(scan, row => row.recognition.id), ids);
  assert.strictEqual(hover.clicks.length, 5, 'full scan retains five real ordinals including duplicates');
  assert.strictEqual(hover.captures.filter(roi => roi.y === 860).length, 0);
  const selected = await replay('user-selected', 8, 'M19', [1370, 1420, 925, 970]);
  const roi = config.handFan.detectRoi;
  const narrow = crop(selected.image, roi);
  const geometry = absoluteComponentEstimate(hs.detectHandCountFromImage(narrow, null), { includeY: true });
  assert.strictEqual(resolveDenseMeasuredWindow(geometry, 'right', 4, narrow, roi), null,
    'five projected titles without the real right endpoint cannot prove slots 4..8');
  const wide = { x: 580, y: 860, width: 960, height: 205 };
  const blank = { width: wide.width, height: wide.height, data: Buffer.alloc(wide.width * wide.height * 4) };
  assert.strictEqual(resolveDenseMeasuredWindow(geometry, 'right', 3, blank, wide, true), null,
    'predicted endpoint alone must never become a click');
  const twoMissing = { components: geometry.components.slice(0, -1) };
  assert.strictEqual(resolveDenseMeasuredWindow(twoMissing, 'right', 3, crop(selected.image, wide), wide, true), null);
  const drag = segment('async function dragReference(', 'async function dragHand(');
  assert.match(drag, /await bridge\.drag[\s\S]*await clearDenseInteraction[\s\S]*await sleep/,
    'release/move/ESC after drag before existing settle');
  const cached = segment('async function positionTargetWindow(', 'async function recognizeDenseTargetSlots(');
  assert.doesNotMatch(cached.slice(0, cached.indexOf("if (window.id === 'LEFT_EDGE')")), /await sleep/,
    'cached target positioning must not add a fixed delay');
  console.log('PASS test-dense-lifted-endpoint-offline; real images; gameInputs=0; stateWrites=0');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
