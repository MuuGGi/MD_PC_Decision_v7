'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const RUN = path.resolve(ROOT, '../runs/2026-10-03T15-12-58-130Z/game-00002/completed');
const route = JSON.parse(fs.readFileSync(path.join(RUN,
  'debug/execution/M18_foolish_burial/2026-10-03T15-24-57-364Z/state.json')));
const victory = JSON.parse(fs.readFileSync(path.join(RUN, 'debug/duel-outcome-live/latest_result.json')));
const handFile = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const outcomeFile = path.join(ROOT, 'debug/duel-outcome-live/latest_result.json');
const routeFile = path.join(ROOT, 'debug/execution/M18_foolish_burial/route_state.json');

function harness(mode) {
  const disk = new Map(), writes = [], reads = [];
  let mtime = 10, spawned = 0, passed = 0;
  const now = Date.parse(victory.checkedAt), initial = Buffer.from(JSON.stringify({
    version: 1, revision: 9, handCount: route.baselineHandCount, cards: route.baselineHand
  }));
  const put = (file, value) => { disk.set(path.resolve(file), Buffer.from(JSON.stringify(value))); writes.push(file); };
  disk.set(handFile, initial); put(outcomeFile, { ...victory, checkedAt: new Date(now - 60000).toISOString() });
  const memoryFs = { existsSync: file => disk.has(path.resolve(file)),
    statSync: file => { assert.strictEqual(path.resolve(file), outcomeFile); return { mtimeMs: mtime }; },
    readFileSync: (file, encoding) => {
      reads.push(file); const value = disk.get(path.resolve(file));
      if (!value) throw new Error('STALE_ORDINARY_ARTIFACT_READ:' + file);
      return encoding ? value.toString(encoding) : Buffer.from(value);
    }, mkdirSync() {} };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const runtime = { readJson: file => JSON.parse(memoryFs.readFileSync(file, 'utf8')),
    writeJsonAtomic: put, writeEvidenceJson: put,
    restoreBuffer: (file, buffer) => disk.set(path.resolve(file), Buffer.from(buffer)) };
  function load(rel, extras = {}, transform = text => text) {
    const file = path.join(ROOT, rel), native = createRequire(file), module = { exports: {} };
    const context = vm.createContext({ module, __dirname: path.dirname(file), Buffer, Date: FakeDate, process,
      console: { log() {} }, require: id => {
        if (Object.hasOwn(extras, id)) return extras[id];
        if (id === 'fs') return memoryFs;
        if (id.endsWith('runtime-files')) return runtime;
        if (id.endsWith('win-fast')) return { MdFastBridge: class { constructor() { throw new Error('NATIVE_INPUT_FORBIDDEN'); } } };
        if (id.endsWith('verified-status')) return { markExecutionPass: () => { passed++; } };
        return native(id);
      } });
    vm.runInContext(transform(fs.readFileSync(file, 'utf8')), context, { filename: file });
    return module.exports;
  }
  const completion = load('execution/core/observer-completion.js');
  const executor = load('execution/live/run-m18-foolish-burial.js', {
    '../core/observer-completion': completion,
    child_process: { spawnSync: () => {
      spawned++;
      const staged = JSON.parse(disk.get(handFile));
      assert.strictEqual(staged.handCount, route.baselineHandCount - 1);
      if (mode === 'observer-error') return { status: 1 };
      if (mode !== 'unchanged') {
        mtime++;
        put(outcomeFile, { ...victory,
          checkedAt: new Date(mode === 'old-time' ? now - 60000 : now).toISOString(),
          strictEvidence: { ...victory.strictEvidence, matched: mode !== 'not-strict' },
          type: mode === 'not-victory' ? 'DEFEAT' : 'VICTORY' });
      }
      return { status: 0 };
    } }
  }, source => source.slice(0, source.lastIndexOf('\nmain().catch')) +
    '\nmodule.exports = { runFinalObserver };');
  return { run: () => executor.runFinalObserver(route), disk, initial,
    get spawned() { return spawned; }, get passed() { return passed; }, reads,
    json: file => JSON.parse(disk.get(file)) };
}

async function test() {
  assert.strictEqual(victory.terminal, true); assert.strictEqual(victory.strictEvidence.matched, true);
  const terminal = harness('victory'); await terminal.run();
  assert.strictEqual(terminal.spawned, 1);
  assert.strictEqual(terminal.json(routeFile).status, 'COMPLETE_TERMINAL_VICTORY');
  assert.ok(terminal.disk.get(handFile).equals(terminal.initial), 'terminal does not commit a guessed final hand');
  assert.strictEqual(terminal.passed, 0, 'terminal success is not ordinary execution sealing');
  assert.ok(!terminal.reads.some(file => /latest_incremental_result|duel-log-live/.test(file)),
    'actual executor must branch before reading hidden/stale ordinary artifacts');
  for (const mode of ['unchanged', 'old-time', 'not-strict', 'not-victory']) {
    const invalid = harness(mode); await assert.rejects(invalid.run(), /STALE_ORDINARY_ARTIFACT_READ/);
    assert.strictEqual(invalid.disk.has(routeFile), false, 'no terminal completion from stale/weak evidence');
  }
  const failed = harness('observer-error'); await assert.rejects(failed.run(), /运行失败/);
  assert.ok(failed.disk.get(handFile).equals(failed.initial));
  assert.strictEqual(failed.json(routeFile).status, 'WAITING_FOR_FINAL_OBSERVER');
  console.log('OBSERVER_COMPLETION_OFFLINE_PASS; real M18 winning route + strict outcome; actual executor terminal branch; ordinary/stale/weak evidence closed; staged hand rollback; no ordinary seal; nativeInputs=0/diskWrites=0');
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { test };
