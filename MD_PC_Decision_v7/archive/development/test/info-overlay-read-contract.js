'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const config = require('../../../engine/live-config');
const source = fs.readFileSync(path.resolve(__dirname, '../../../engine/runtime/observer/test-hand-info-live.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const ok = n => ({ status: 'OK', handCount: n }), missing = { status: 'HAND_COUNT_INFO_NOT_FOUND' };
let cases = 0;
async function exercise(samples, expected, timeout = false) {
  let clock = 0, reads = 0, held = false, writesHeld = 0, capturesHeld = 0, nextTimer = 0;
  const timers = new Map(), files = new Map(), pixels = { width: 1, height: 1, data: Buffer.alloc(4) };
  const advance = ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } };
  const bridge = { info: async () => ({ title: 'masterduel' }), move: async () => {},
    mouseDown: async () => { held = true; }, mouseUp: async () => { held = false; } };
  const ctx = vm.createContext({ config, path, console: { log() {} }, AUTO_DEBUG_DIR: 'MEMORY',
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: clock + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    fs: { mkdirSync() {}, writeFileSync: (p, value) => { if (held) writesHeld++; files.set(p, value); } },
    sleep: async ms => advance(ms), validateClient() {}, mapReferencePoint: (_, p) => p, toPng: x => x,
    writePngSync: (image, p) => { if (held) writesHeld++; files.set(p, image); }, recognitionSummary: x => x,
    captureFullClient: async () => { if (held) capturesHeld++; return pixels; },
    readOwnHandCountFromInfoOverlay: () => missing, readOpponentHandCountFromInfoOverlay: () => missing,
    validateInfoHandCountSides: own => ({ status: own.status === 'OK' ? 'OK' : 'FAIL' }),
    readOverlayRois: async () => { advance(25); const row = samples[Math.min(reads++, samples.length - 1)];
      return { ...row, ownImage: pixels, opponentImage: pixels }; }
  });
  vm.runInContext(section('async function waitForOverlay(', 'async function runFastOwnAutoHold('), ctx);
  vm.runInContext(section('async function runAutoHold(', 'async function main('), ctx);
  if (timeout) await assert.rejects(() => ctx.runAutoHold(bridge, expected, [], { skipCountdown: true }), /INFO_OVERLAY_APPEAR_TIMEOUT/);
  else {
    const result = await ctx.runAutoHold(bridge, expected, [], { skipCountdown: true });
    assert.equal(result.result.own.handCount, expected.own); assert.equal(result.result.stableReads, 2);
    assert(result.result.holdDurationMs < config.handFan.infoOverlay.infoAutoHoldMaxMs);
  }
  assert.equal(held, false); assert.equal(writesHeld, 0); assert.equal(capturesHeld, 0);
  assert.equal(timers.size, 0);
  if (timeout) assert(files.has(path.join('MEMORY', 'own_roi_last.png')), 'preserve failed own ROI after release');
  cases++; return { reads };
}
async function run() {
  const lateOwn = await exercise([{ own: missing, opponent: ok(5) }, { own: ok(0), opponent: ok(5) },
    { own: ok(1), opponent: missing }, { own: ok(1), opponent: missing }], { own: 1 });
  assert.equal(lateOwn.reads, 4, 'opponent readiness and wrong own value never complete our read');
  for (const n of [0, 1, 2, 10, 12]) await exercise([{ own: ok(n), opponent: missing }], { own: n });
  await exercise([{ own: ok(0), opponent: ok(5) }], { own: 1 }, true);
  await exercise([{ own: missing, opponent: ok(5) }], { own: 2 }, true);
  await exercise([{ own: ok(1), opponent: ok(5) }], { own: 10 }, true);
  console.log('V7_INFO_OVERLAY_READ_CONTRACT_PASS; cases=' + cases + '; actual fallback body; own stable/expected; no opponent shortcut; release before evidence; bounded timeout');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
