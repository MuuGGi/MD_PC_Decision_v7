'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..'), run = path.resolve(root, '../runs/2026-10-06T12-59-37-858Z');
const config = require('../../live-config'), library = require('../../card-library.json');
const countProof = require('../../lib/hand-count-read-proof'), hs = require('../../lib/hand-state');
const { cropImage } = require('../../lib/png-utils');
const base = path.join(run, 'game-00002/before-recovery');
const fast = JSON.parse(fs.readFileSync(path.join(base, 'debug/v5/opening/observer_hand_count/info_fast/result.json')));
const timeout = JSON.parse(fs.readFileSync(path.join(base, 'debug/scan-state-live/prepared/info/result.json')));
assert.strictEqual(fast.own.handCount, 5); assert.strictEqual(fast.holdDurationMs, 167);
assert.strictEqual(timeout.status, 'INFO_AUTO_HOLD_MAX_TIMEOUT'); assert.strictEqual(timeout.holdDurationMs, 6274);
const frame = PNG.sync.read(fs.readFileSync(path.join(base, 'debug/scan-state-live/prepared/info/error_state.png')));
const handImage = cropImage(frame, config.handFan.detectRoi);
assert.strictEqual(hs.detectHandCountFromImage(handImage, null).componentEstimate.count, 5);
const section = (source, a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const fresh = n => ({ ...fast, capturedAt: new Date().toISOString(), own: { ...fast.own, handCount: n } });

async function slowHold(source) {
  let clock = Date.now(), held = false, capturesWhileHeld = 0, writesWhileHeld = 0, nextTimer = 0;
  const timers = new Map(), files = new Map();
  const advance = ms => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } };
  const image = { width: 1, height: 1, data: Buffer.alloc(4) };
  const bridge = { info: async () => ({ title: 'masterduel' }), move: async () => {},
    mouseDown: async () => { held = true; }, mouseUp: async () => { held = false; } };
  const ctx = vm.createContext({ config, path, AUTO_DEBUG_DIR: 'MEMORY', console: { log() {} },
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    fs: { mkdirSync() {}, writeFileSync: (p, value) => files.set(p, value) },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id), sleep: async ms => advance(ms),
    validateClient() {}, mapReferencePoint: (_, p) => p, toPng: x => x,
    writePngSync: () => { if (held) writesWhileHeld++; },
    captureFullClient: async () => { if (held) capturesWhileHeld++; advance(6000); return image; },
    waitForOverlay: async () => ({ own: { status: 'OK', handCount: 5 }, opponent: { status: 'OK', handCount: 5 },
      ownImage: image, opponentImage: image, overlayAppearMs: 1 }),
    recognitionSummary: x => x, validateInfoHandCountSides: () => ({ status: 'OK' }),
    readOwnHandCountFromInfoOverlay: () => ({ status: 'NOT_VISIBLE' }),
    readOpponentHandCountFromInfoOverlay: () => ({ status: 'NOT_VISIBLE' }),
    getInfoHandCountRoi: () => ({ x: 0, y: 0, width: 1, height: 1 }), cropImage: x => x
  });
  vm.runInContext(section(source, 'async function runAutoHold(', 'async function main('), ctx);
  let error = null, output = null;
  try { output = await ctx.runAutoHold(bridge, { own: 5 }, [], { skipCountdown: true }); } catch (e) { error = e; }
  assert.strictEqual(held, false); assert.strictEqual(timers.size, 0);
  return { error, output, capturesWhileHeld, writesWhileHeld };
}

function baselineHarness(count = 5) {
  const writes = new Map(), input = [], bridge = { start: async () => {}, info: async () =>
    ({ title: 'masterduel', client: { width: 2048, height: 1152 } }), key: async key => input.push(key) };
  let fastReads = 0, legacyReads = 0, scans = 0;
  const captureSource = fs.readFileSync(path.join(root, 'runtime/observer/capture-hand-scroll-segments-live.js'), 'utf8');
  const reader = vm.createContext({ path, config, console: { log() {} },
    runFastOwnAutoHold: async () => { fastReads++; return { result: fresh(count) }; },
    runAutoHold: async () => { legacyReads++; throw new Error('DUPLICATE_SLOW_INFO'); },
    require: () => countProof });
  vm.runInContext(section(captureSource, 'async function readOwnHandCount(', 'async function detectGeometry('), reader);
  const scanSource = fs.readFileSync(path.join(root, 'runtime/observer/scan-state.js'), 'utf8');
  const guardSource = section(scanSource, '  const detected = detectHandCountFromImage(handImage, options.previousCount);', '  if (detected.componentEstimate)');
  const scanCtx = vm.createContext({ __dirname: path.join(root, 'runtime/observer'), process: { argv: [] },
    module: { exports: {} }, Buffer, console: { log() {}, error() {} },
    require: id => {
      if (id === 'fs') return { existsSync: () => false };
      if (id === 'path') return path;
      if (id.endsWith('runtime-files')) return { writeJson: (p, x) => writes.set(p, x), writeJsonAtomic: (p, x) => writes.set(p, x) };
      if (id.endsWith('live-client-guard')) return { validateMasterDuelClient: info => ({ client: info.client }) };
      if (id.endsWith('live-config')) return config;
      if (id.endsWith('win-fast')) return { MdFastBridge: class {}, captureReferenceRoi: async () => frame,
        blueScoreFromRoi: () => 1, sleep: async () => {} };
      if (id.endsWith('recognizer')) return { loadLibrary: () => library, loadTemplates: async () => [] };
      if (id.endsWith('hand-info-overlay')) return { loadInfoDigitTemplates: () => [] };
      if (id.endsWith('hand-state')) return hs;
      if (id.endsWith('md-foreground')) return { activateAndVerifyMasterDuel: async () => ({ info: await bridge.info() }) };
      if (id === './test-hand-info-live') return { runFastOwnAutoHold: async () => { fastReads++; return { result: fresh(count) }; },
        runAutoHold: async () => { legacyReads++; throw new Error('DUPLICATE_SLOW_INFO'); } };
      if (id.endsWith('hand-count-read-proof')) return countProof;
      if (id === './scan-state') return { scanOneState: async (_, __, ___, ____, options) => {
        const prelude = vm.createContext({ options, handImage, detectHandCountFromImage: hs.detectHandCountFromImage });
        vm.runInContext(guardSource, prelude); // actual current-image guard, real G2 pixels
        scans++; assert.strictEqual(options.requireCurrentCountMatch, true);
        return { count, cards: Array.from({ length: count }, (_, i) => ({ id: `M${i + 6}`, index: i + 1 })),
          layoutMode: 'FIXED_FAN', layout: { slots: [] } };
      } };
      throw new Error(`unexpected scan require ${id}`);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime/observer/test-scan-state-live.js'), 'utf8'), scanCtx);
  const baselineCtx = vm.createContext({ __dirname: path.join(root, 'execution/core'), process: { env: {} },
    module: { exports: {} }, console: { log() {} }, require: id => {
      if (id === 'fs') return { mkdirSync() {}, writeFileSync: (p, x) => writes.set(p, x),
        readFileSync: p => { const value = writes.get(p); if (value === undefined) throw new Error('MOCK_COMMIT_MISSING:' + p);
          return typeof value === 'string' ? value : JSON.stringify(value); } };
      if (id === 'path') return path;
      if (id.endsWith('runtime-files')) return { writeJsonAtomic: (p, x) => writes.set(p, x) };
      if (id.endsWith('hand-info-overlay')) return { loadInfoDigitTemplates: () => [] };
      if (id.endsWith('test-scan-state-live')) return scanCtx.module.exports;
      if (id.endsWith('capture-hand-scroll-segments-live')) return { readOwnHandCount: reader.readOwnHandCount };
      if (id.endsWith('test-duel-log-live')) return { runDuelLogLive: async () => {} };
      throw new Error(`unexpected baseline require ${id}`);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'execution/core/observer-current-baseline.js'), 'utf8'), baselineCtx);
  return { run: () => baselineCtx.module.exports.establishCurrentObserverBaseline({ bridge, info: {}, outputDir: 'MEMORY' }),
    bridge, writes, input, get fastReads() { return fastReads; }, get legacyReads() { return legacyReads; }, get scans() { return scans; } };
}

async function test() {
  const old = await slowHold(fs.readFileSync(path.join(run, 'engine-source/runtime/observer/test-hand-info-live.js'), 'utf8'));
  assert.match(old.error.message, /INFO_AUTO_HOLD_MAX_TIMEOUT/); assert.strictEqual(old.capturesWhileHeld, 1);
  const fixed = await slowHold(fs.readFileSync(path.join(root, 'runtime/observer/test-hand-info-live.js'), 'utf8'));
  assert.strictEqual(fixed.error, null); assert.strictEqual(fixed.output.result.own.handCount, 5);
  assert.strictEqual(fixed.capturesWhileHeld, 0); assert.strictEqual(fixed.writesWhileHeld, 0);
  // A genuine fast-reader failure still permits the mature ROI fallback,
  // whose result must satisfy the SAME proof contract as normal fast INFO.
  const fallbackBridge = {}, readerSource = fs.readFileSync(path.join(root, 'runtime/observer/capture-hand-scroll-segments-live.js'), 'utf8');
  const fallbackCtx = vm.createContext({ path, config, console: { log() {} },
    runFastOwnAutoHold: async () => { throw new Error('INFO_FAST_OWN_TIMEOUT'); },
    runAutoHold: async () => ({ result: { ...fixed.output.result, capturedAt: new Date().toISOString() } }),
    require: () => countProof });
  vm.runInContext(section(readerSource, 'async function readOwnHandCount(', 'async function detectGeometry('), fallbackCtx);
  const fallbackRead = await fallbackCtx.readOwnHandCount(fallbackBridge, [], 'MEMORY', 5, { returnEvidence: true });
  assert.strictEqual(countProof.consumeHandCountReadProof(fallbackBridge, fallbackRead.proof, 5).result.own.handCount, 5);
  const h = baselineHarness(); assert.strictEqual((await h.run()).status, 'PASS');
  assert.strictEqual(h.fastReads, 1); assert.strictEqual(h.legacyReads, 0); assert.strictEqual(h.scans, 1);
  const changed = baselineHarness(4); await assert.rejects(changed.run(), /CURRENT_IMAGE_MISMATCH/);
  assert.strictEqual(changed.scans, 0, 'current count conflict stops before hand-card selection');
  const b = {}, valid = countProof.issueHandCountReadProof(b, fresh(5), 1800);
  assert.strictEqual(countProof.consumeHandCountReadProof(b, valid.proof, 5).result.own.handCount, 5);
  assert.throws(() => countProof.consumeHandCountReadProof(b, valid.proof, 5), /STALE_OR_UNBOUND/);
  for (const proof of [5, fresh(5), {}, countProof.issueHandCountReadProof(b, fresh(5), 1800).proof]) {
    assert.throws(() => countProof.consumeHandCountReadProof({}, proof, 5), /STALE_OR_UNBOUND/);
  }
  for (const patch of [{ mouseReleased: false }, { failSafeTriggered: true }, { stableReads: 1 },
    { holdDurationMs: 6274 }, { capturedAt: new Date(Date.now() - 11000).toISOString() }]) {
    assert.throws(() => countProof.issueHandCountReadProof(b, { ...fresh(5), ...patch }, 1800), /PROOF_INVALID/);
  }
  console.log('OPENING_INFO_SINGLE_READ_OFFLINE_PASS; actual G2 fast5/167ms then old6274ms root; legacy positive-ROI timeout reproduced/fixed; actual baseline+scan one hold; existing current-image count guard; single-use/bridge/stale/release guards; GUI/live-state writes=0');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
