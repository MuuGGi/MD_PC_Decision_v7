'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
const { PNG } = require('pngjs');
const { classifyFailure } = require('../../../policy');
const engine = path.resolve(__dirname, '../..'), controller = path.resolve(engine, '..');
const source = rel => fs.readFileSync(path.join(controller, rel), 'utf8');
const nativeFrame = fs.readFileSync(path.join(controller, 'fixtures/main1-full.png'));
const disk = new Map(); let writes = 0;
const moduleContext = { module: { exports: {} }, Buffer, process: { pid: 12 },
  require: id => id === 'fs' ? { readFileSync: file => {
    if (!disk.has(file)) throw new Error('MISSING'); return disk.get(file);
  } } : id === 'pngjs' ? { PNG } : { writeJsonAtomic: (file, value) => { writes++; disk.set(file, JSON.stringify(value)); } } };
vm.runInNewContext(source('diagnostics.js'), moduleContext);
const { recordGuardedFullCapture, readRollingFrame } = moduleContext.module.exports;
const command = { cmd: 'captureRoi', x: 0, y: 0, width: 2048, height: 1152 };
const game = { id: 1, startedAt: '2026-10-06T06:14:03.118Z' };
const response = { guardedCapture: true, pngBase64: nativeFrame.toString('base64'), width: 2048, height: 1152,
  client: { width: 2048, height: 1152 }, hwnd: 264432, pid: 56, title: 'masterduel', capturedAt: '2026-10-06T06:18:22.100Z' };
const at = Date.parse('2026-10-06T06:18:25.245Z');
for (const [cmd, result] of [[{ ...command, width: 100 }, response], [{ ...command, x: 5 }, response],
  [command, { ...response, guardedCapture: false }], [command, { ...response, pid: null }]]) {
  assert.strictEqual(recordGuardedFullCapture('rolling', cmd, result), false);
}
assert.strictEqual(writes, 0, 'hand/INFO ROI never writes a rolling full frame');
assert.strictEqual(recordGuardedFullCapture('rolling', command, response), true);
recordGuardedFullCapture('rolling', command, { ...response, capturedAt: '2026-10-06T06:18:23.100Z' });
assert.strictEqual(disk.size, 1, 'two captures replace ONE artifact, no picture history');
const old = { at: '2026-10-06T06:14:19.469Z', image: PNG.sync.read(nativeFrame) };
let chosen = readRollingFrame('rolling', game, old, at);
assert.strictEqual(chosen.selected.source, 'EXECUTOR_LAST_SAFE_FULL_CLIENT');
assert.strictEqual(chosen.evidence.freshness, 'RECENT_LAST_SAFE_FRAME');
assert.strictEqual(chosen.evidence.ageMs, 2145);
assert.strictEqual(chosen.evidence.isFailureMomentScreenshot, false, 'never label an earlier safe frame as the failure instant');
for (const bad of [{ ...response, capturedAt: '2026-10-05T00:00:00Z' },
  { ...response, capturedAt: '2026-10-07T00:00:00Z' }, { ...response, width: 100 },
  { ...response, pngBase64: 'corrupt' }, { ...response, guardedCapture: false }]) {
  disk.set('rolling', JSON.stringify({ version: 1, ...bad }));
  chosen = readRollingFrame('rolling', game, old, at);
  assert.strictEqual(chosen.selected.source, 'SUPERVISOR_LAST_SAFE_FRAME');
  assert.strictEqual(chosen.evidence.freshness, 'STALE_LAST_SAFE_FRAME');
}
assert.strictEqual(readRollingFrame('missing', game, null, at).evidence.freshness, 'MISSING');
recordGuardedFullCapture('rolling', command, response);

async function main() {
  // Actual hook integration; original bridge is replaced, not launched.
  let bridgeCommands = 0;
  class Bridge { async command() { bridgeCommands++; return response; } }
  const hookEvents = [], hook = vm.createContext({ path, __dirname: controller,
    process: { env: { MD_AUTOTEST_FRAME: 'rolling' } }, check() {}, record: (type, details) => hookEvents.push({ type, details }),
    recordGuardedFullCapture, require: () => ({ MdFastBridge: Bridge }) });
  const hookSource = source('auto-hook.js');
  vm.runInContext(hookSource.slice(hookSource.indexOf('const bridgeFile ='), hookSource.indexOf('function decision(')), hook);
  const countBefore = writes;
  await new Bridge().command({ ...command, width: 116, height: 38 });
  assert.strictEqual(writes, countBefore, 'normal ROI has zero diagnostic writes');
  await new Bridge().command(command);
  assert.strictEqual(writes, countBefore + 1); assert.strictEqual(bridgeCommands, 2, 'no extra capture/input call');

  // Actual archive function: already stopped => ZERO safe/frame calls. It
  // picks the executor snapshot and includes immutable native failure data.
  const runner = source('runner.js'), captures = [], snapshots = [];
  const failure = { reason: 'FOREGROUND_LOST', command: 'guardCheck', foregroundPid: 78, processName: 'Codex' };
  const ctx = vm.createContext({ path, currentDir: 'mock', ENGINE: engine, guardPath: 'guard', rollingFramePath: 'rolling',
    lastFrame: old, stopPath: 'STOP', stopped: () => true, frame: () => { throw new Error('UNSAFE_GUI_CAPTURE'); },
    json: () => failure, fs: { readFileSync: () => 'FOREGROUND_LOST' },
    readRollingFrame: (file, g, fallback) => readRollingFrame(file, g, fallback, at),
    snapshot: (_, dir, metadata) => snapshots.push(metadata), saveRgbaPng: (_, file) => captures.push(file),
    writeJsonAtomic() {}, store: { event() {} } });
  vm.runInContext(runner.slice(runner.indexOf('  async function captureArchive('), runner.indexOf('  async function runChild(')), ctx);
  await ctx.captureArchive(game, 'before-recovery', new Error('FIRST_ERROR'));
  assert.strictEqual(snapshots[0].frameEvidence.source, 'EXECUTOR_LAST_SAFE_FULL_CLIENT');
  assert.strictEqual(snapshots[0].guardFailure.processName, 'Codex');
  assert.strictEqual(captures.length, 1);

  // Real bridge response handling, simulated stdout/stdin. Never spawn PS.
  const fakeProcess = new EventEmitter(); fakeProcess.stdout = new EventEmitter(); fakeProcess.stderr = new EventEmitter();
  fakeProcess.stdout.setEncoding = fakeProcess.stderr.setEncoding = () => {};
  fakeProcess.stdin = { write() {}, end() {} };
  const win = vm.createContext({ __dirname: path.join(engine, 'lib'), Buffer, setTimeout, clearTimeout,
    module: { exports: {} }, require: id => id === 'path' ? path : id === 'child_process' ? { spawn: () => fakeProcess }
      : id === 'pngjs' ? { PNG } : id === './png-utils' ? {} : { screen: { width: 2048, height: 1152 } } });
  vm.runInContext(source('engine/lib/win-fast.js'), win);
  const bridge = new win.module.exports.MdFastBridge(), starting = bridge.start();
  fakeProcess.stdout.emit('data', '{"ok":true,"event":"ready"}\n'); await starting;
  const pending = bridge.command({ cmd: 'guardCheck' }); await new Promise(resolve => setImmediate(resolve));
  fakeProcess.stdout.emit('data', JSON.stringify({ ok: false, error: 'AUTOTEST_STOP:FOREGROUND_LOST', code: 'FOREGROUND_LOST', guardFailure: failure }) + '\n');
  await assert.rejects(pending, error => error.code === 'FOREGROUND_LOST' && error.guardFailure.processName === 'Codex' && error.bridgeCommand === 'guardCheck');

  // Actual shared atomic observer wrapper no longer mislabels M06 as Hornet;
  // native stop reason remains an explicit cause across the process boundary.
  const atomic = source('engine/execution/core/atomic-route-executor.js');
  const observer = vm.createContext({ path, ROOT: engine, HAND_STATE_PATH: 'hand',
    process: { execPath: 'mock', env: { MD_AUTOTEST_STOP: 'STOP', MD_AUTOTEST_GUARD: 'guard' } },
    buildIncrementalObserverArgs: () => [], spawnSync: () => ({ status: 1 }),
    fs: { existsSync: () => true, readFileSync: () => 'FOREGROUND_LOST' }, readJsonIfExists: () => failure });
  vm.runInContext(atomic.slice(atomic.indexOf('function runObserver('), atomic.indexOf('function collectM20FieldConversionEvidence(')), observer);
  assert.throws(() => observer.runObserver({ expectedAtomicActivationKey: 'M06' }), error => {
    assert.strictEqual(error.activationKey, 'M06'); assert.match(error.message, /ATOMIC_OBSERVER_FAILED:activation=M06/);
    assert.strictEqual(classifyFailure(error), 'STOP_TEST'); assert.strictEqual(error.cause.guardFailure.processName, 'Codex'); return true;
  });
  for (const reason of ['MASTER_DUEL_WINDOW_CHANGED', 'FOREGROUND_IDENTITY_UNPROVEN']) {
    assert.strictEqual(classifyFailure(new Error(reason)), 'STOP_TEST');
  }
  const server = source('engine/scripts/md-server.ps1');
  assert.match(server, /GuardCheck\(\)\s*\r?\n\s*\r?\n\s*Write-JsonResponse/);
  assert.match(server, /SetGuardOperation\(\$cmd\)/);
  console.log('GUARD_DIAGNOSTICS_OFFLINE_PASS; latest child frame replaces stale opening; ROI writes0/no added captures; one rolling artifact; archive after stop inputs0; bridge native first cause; M06 no Hornet mislabel; liveStateWrites0');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
