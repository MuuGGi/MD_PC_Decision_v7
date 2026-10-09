'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { expectedResolvedHandCount } = require('../../lib/atomic-draw-resolution');
const { createTerminalObservationGuard, TERMINAL_YIELD } = require('../../lib/terminal-observation-guard');
const ROOT = path.resolve(__dirname, '../..');
const GAME = path.resolve(ROOT, '../runs/2026-10-04T07-57-08-445Z/game-00005');
const read = rel => JSON.parse(fs.readFileSync(path.join(GAME, rel), 'utf8'));
const hand = read('completed/debug/hand-change-live/session_state.json');
const infoRecord = read('runtime-debug/hand-info-auto/victory-risk-fast-own/result.json');
const victory = read('runtime-debug/duel-outcome-live/latest_result.json');
const NONE = { terminal: false, safetyStop: false, type: 'NONE' };
const WEAK = { terminal: false, safetyStop: true, type: 'VICTORY_CANDIDATE_UNCONFIRMED' };

function load(rel, memoryFs, extras, fakeProcess, FakeDate = Date) {
  const file = path.join(ROOT, rel), native = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: path.dirname(file),
    Buffer, Date: FakeDate, process: fakeProcess, console: { log() {}, error() {} },
    require: id => id === 'fs' ? memoryFs : Object.hasOwn(extras, id) ? extras[id] : native(id)
  }, { filename: file });
  return module.exports;
}

async function runMain(mode) {
  const disk = new Map(), writes = [], calls = { info: 0, log: 0, incremental: 0, detector: 0, stop: 0 };
  let now = 1000;
  const handPath = path.join(ROOT, 'debug/hand-change-live/session_state.json');
  const logPath = path.join(ROOT, 'debug/duel-log-live/latest_result.json');
  const initial = Buffer.from(JSON.stringify(hand));
  disk.set(handPath, initial);
  disk.set(logPath, Buffer.from(JSON.stringify({ newOperationBlocks: [{ activationKey: 'M12',
    details: [{ rawType: 'HAND_GAIN', side: 'SELF' }, { rawType: 'HAND_GAIN', side: 'SELF' }] }] })));
  const memoryFs = { existsSync: file => disk.has(file), readFileSync: (file, encoding) => {
    const value = disk.get(file); if (!value) throw new Error('UNEXPECTED_READ:' + file);
    return encoding ? value.toString(encoding) : Buffer.from(value);
  }, unlinkSync: file => disk.delete(file) };
  const put = (file, value) => { writes.push(file); disk.set(file, Buffer.from(JSON.stringify(value))); };
  class FakeDate extends Date { static now() { return now; } }
  const bridge = class {
    async start() {} async stop() { calls.stop++; }
    async info() { return { title: 'Master Duel' }; } async mouseUp() {}
    async click() { throw new Error('NATIVE_INPUT_FORBIDDEN'); }
    async wheelBurstCaptureReferenceRoi() { throw new Error('NATIVE_INPUT_FORBIDDEN'); }
  };
  const main = load('runtime/observer/run-live-incremental.js', memoryFs, {
    '../../lib/win-fast': { MdFastBridge: bridge,
      captureReferenceRoi: async () => ({ width: 2048, height: 1152 }),
      sleep: async ms => { now += ms; } },
    '../../lib/md-foreground': { activateAndVerifyMasterDuel: async () => ({ info: { title: 'Master Duel' } }) },
    '../../lib/runtime-files': { restoreBuffer: (file, data) => {
      if (data) disk.set(file, Buffer.from(data)); else disk.delete(file);
    } },
    '../../lib/incremental-observer-transaction': { recordFailedIncrementalObservation: () => {
      throw new Error('UNEXPECTED_FAILURE_RECORD');
    } },
    '../../lib/hand-info-overlay': { loadInfoDigitTemplates: () => ({}) },
    './test-hand-info-live': { runFastOwnAutoHold: async (_, expected, __, options) => {
      calls.info++;
      assert.strictEqual(expected.own, 8);
      assert.strictEqual(options.saveOwnRoi, true);
      return { result: { ...infoRecord, own: { ...infoRecord.own,
        handCount: ['normal', 'reader-terminal'].includes(mode) ? 8 : infoRecord.own.handCount } } };
    } },
    '../../lib/duel-outcome-detector': { detectLiveDuelOutcome: async () => {
      calls.detector++;
      if (mode === 'timeout' || mode === 'normal') return NONE;
      if (mode === 'weak-only') return calls.detector === 1 ? NONE : WEAK;
      if (mode === 'weak-then-victory' && calls.detector === 2) return WEAK;
      return calls.detector >= 3 ? victory : NONE;
    } },
    './test-duel-log-live': { runDuelLogLive: async options => {
      calls.log++;
      await options.checkObservationBoundary({ sourceImage: {}, info: {}, stage: 'BEFORE_WHEEL', panelState: { open: true } });
    } },
    './observe-hand-change-incremental-live': { runIncrementalHandChange: async options => {
      calls.incremental++;
      assert.strictEqual(options.prefetchedFastOwnInfo.result.own.handCount, 8);
      put(path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json'), { status: 'PASS' });
    } }
  }, { argv: [], env: { MD_V5_EXODIA_VICTORY_RISK: '1', MD_V5_EXODIA_VICTORY_CERTAIN: '0',
    MD_V5_ATOMIC_OBSERVER: '1', MD_V5_SELECTED_CARD_ID: 'M12', MD_V5_RANDOM_DRAW_CAPACITY: '2' }, hrtime: process.hrtime }, FakeDate);
  let error;
  try { await main.main(); } catch (caught) { error = caught; }
  assert.ok(disk.get(handPath).equals(initial), 'never guess or commit a winning final hand');
  assert.strictEqual(calls.stop, 1);
  return { calls, writes, error, now };
}

// No full INFO/movie screenshot was archived for this moment. The following
// rail/body/transition images are explicitly synthetic fault injections, NOT
// purported captures of the historical animation. Real facts above: hand 8,
// parsed INFO 4, and a later strict victory result.
function frame(kind) {
  const image = { width: 2048, height: 1152, data: Buffer.alloc(2048 * 1152 * 4,
    kind === 'closed' || kind === 'terminal' ? 220 : 20), kind };
  if (kind === 'rail' || kind === 'bottom') {
    const spans = kind === 'rail' ? [[200, 500], [700, 900]] : [[500, 1000]];
    for (const [top, bottom] of spans) for (let y = top; y <= bottom; y++) {
      const i = (y * image.width + 2007) * 4;
      image.data[i] = 10; image.data[i + 1] = 50; image.data[i + 2] = 180;
    }
  }
  return image;
}

async function runReader(mode) {
  let stage = '', now = 0, clicks = 0, wheels = 0, recognitions = 0;
  const writes = [];
  const normal = frame(mode.includes('button') ? 'closed' : mode === 'before-recognition' ? 'bottom' : mode === 'no-rail' ? 'dark' : 'rail');
  const terminal = frame('terminal');
  const info = { title: 'Master Duel' };
  const capture = async () => {
    if ((mode === 'before-button' && stage === 'BEFORE_LOG_BUTTON') ||
        (mode === 'before-wheel' && stage.startsWith('BEFORE_WHEEL')) ||
        (mode === 'before-recognition' && stage === 'BEFORE_LOG_RECOGNITION')) return terminal;
    if (mode === 'rail-lost' && stage.startsWith('BEFORE_WHEEL')) return now ? terminal : frame('dark');
    if (clicks && mode === 'after-button') return terminal;
    return normal;
  };
  const guard = createTerminalObservationGuard({
    detect: async image => image.kind === 'terminal' ? victory : NONE,
    capture: async () => ({ image: await capture(), info }), delay: async ms => { now += ms; }, now: () => now
  });
  const reader = load('runtime/observer/test-duel-log-live.js', {
    mkdirSync() {}, existsSync: () => false, writeFileSync: file => writes.push(file)
  }, {
    '../../lib/win-fast': { captureReferenceRoi: async () => capture(),
      clientReport: () => ({ clientFullyVisible: true, aspectError: 0 }),
      mapReferencePoint: (_, point) => point, sleep: async ms => { now += ms; } },
    '../../lib/png-utils': { readPng: async () => { recognitions++; throw new Error('RECOGNIZER_REACHED'); } },
    '../../lib/run-timer': { RunTimer: class {
      async time(name, fn) { return fn(); } timeSync(name, fn) { return fn(); }
      finish() {} summary() { return ''; }
    } }
  }, { argv: [], env: {}, hrtime: process.hrtime });
  const fakeBridge = { info: async () => info, click: async () => { clicks++; },
    wheelBurstCaptureReferenceRoi: async () => { wheels++; return { info, image: terminal }; } };
  // Record the last completed boundary, then run the actual production guard.
  const hook = async options => { stage = options.stage; await guard(options); };
  // At the next foreground recheck, inject a transition into that capture.
  // Production source is unmodified; these are fake bridge methods only.
  fakeBridge.info = async () => {
    if (mode === 'before-button' && stage === 'INITIAL_LOG_FRAME') stage = 'BEFORE_LOG_BUTTON';
    if (['before-wheel', 'rail-lost'].includes(mode) && stage.startsWith('BEFORE_BOTTOM')) stage = 'BEFORE_WHEEL';
    if (mode === 'foreground-lost' && stage.startsWith('BEFORE_BOTTOM')) {
      throw new Error('MASTER_DUEL_FOREGROUND_LOST_SIMULATED');
    }
    if (mode === 'before-recognition' && stage.startsWith('BEFORE_BOTTOM')) stage = 'BEFORE_LOG_RECOGNITION';
    return info;
  };
  let error;
  try { await reader.runDuelLogLive({ bridge: fakeBridge, skipActivation: true,
    skipForegroundReactivate: true, initialScreenshot: normal, performanceFast: true,
    checkObservationBoundary: hook }); } catch (caught) { error = caught; }
  return { error, clicks, wheels, recognitions, writes, now };
}

async function main() {
  assert.strictEqual(hand.handCount, 8);
  assert.strictEqual(infoRecord.own.handCount, 4);
  assert.strictEqual(expectedResolvedHandCount(hand, 'M12'), 8);
  assert.strictEqual(victory.strictEvidence.matched, true);
  const staged = { handCount: 4, cards: Array.from({ length: 4 }, () => ({ id: 'EXODIA_UNKNOWN' })) };
  assert.strictEqual(expectedResolvedHandCount(staged, 'M18'), 5);
  assert.strictEqual(expectedResolvedHandCount(staged, 'M12'), null);
  assert.strictEqual(expectedResolvedHandCount(hand, 'M21'), 9);
  assert.strictEqual(expectedResolvedHandCount({ handCount: 1, cards: [{ id: 'M21' }] }, 'M21'), 2,
    'another M21 in hand cannot be charged as the already-committed field card');
  assert.strictEqual(expectedResolvedHandCount(hand, 'UNKNOWN'), null);
  for (const mode of ['mismatch', 'weak-then-victory', 'reader-terminal']) {
    const result = await runMain(mode);
    assert.ifError(result.error);
    assert.strictEqual(result.calls.info, 1);
    assert.strictEqual(result.calls.incremental, 0);
    assert.strictEqual(result.calls.log, mode === 'reader-terminal' ? 1 : 0);
    assert.strictEqual(result.writes.length, 0);
  }
  for (const mode of ['timeout', 'weak-only']) {
    const result = await runMain(mode);
    assert.match(result.error?.message || '', /VICTORY_RISK_UNRESOLVED|STRICT_EXODIA_EVIDENCE_INCOMPLETE/);
    assert.strictEqual(result.calls.log, 0);
    assert.strictEqual(result.calls.incremental, 0);
    assert.ok(result.now >= 13000 && result.now <= 13250);
  }
  const normal = await runMain('normal');
  assert.ifError(normal.error);
  assert.strictEqual(normal.calls.log, 1);
  assert.strictEqual(normal.calls.incremental, 1);
  for (const mode of ['before-button', 'after-button', 'before-wheel', 'after-wheel', 'before-recognition', 'rail-lost']) {
    const result = await runReader(mode);
    assert.strictEqual(result.error?.code, TERMINAL_YIELD, mode + ':' + result.error?.stack);
    assert.strictEqual(result.clicks, mode === 'after-button' ? 1 : 0, mode);
    assert.strictEqual(result.wheels, mode === 'after-wheel' ? 1 : 0, mode);
    assert.strictEqual(result.recognitions, 0, mode);
    assert.strictEqual(result.writes.length, 0, mode);
  }
  const missing = await runReader('missing-button');
  assert.match(missing.error?.message || '', /ORDINARY_SURFACE_LOST/);
  assert.strictEqual(missing.clicks, 1);
  assert.strictEqual(missing.wheels, 0);
  assert.strictEqual(missing.recognitions, 0);
  const shortLog = await runReader('no-rail');
  assert.match(shortLog.error?.message || '', /RECOGNIZER_REACHED/);
  assert.strictEqual(shortLog.wheels, 0);
  const interrupted = await runReader('foreground-lost');
  assert.match(interrupted.error?.message || '', /FOREGROUND_LOST/);
  assert.strictEqual(interrupted.wheels, 0);
  assert.strictEqual(interrupted.recognitions, 0);
  for (const outcome of [{ ...victory, strictEvidence: { matched: false } },
    { ...victory, type: 'DEFEAT' }, { terminal: false, safetyStop: true, type: 'UNKNOWN' }]) {
    const guard = createTerminalObservationGuard({ detect: async () => outcome,
      capture: async () => { throw new Error('UNEXPECTED_CAPTURE'); }, delay: async () => {} });
    await assert.rejects(guard({ sourceImage: {}, info: {}, stage: 'BEFORE_COMMIT' }), /NOT_STRICT_VICTORY/);
  }
  console.log('TERMINAL_OBSERVATION_BOUNDARY_OFFLINE_PASS; real game5 hand8/INFO4/strictWIN; simulated transition at actual reader input boundaries; weak/timeout closed; normal INFO8 retained; no native input/disk state writes');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
