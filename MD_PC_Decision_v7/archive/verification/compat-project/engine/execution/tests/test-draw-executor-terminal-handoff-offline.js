'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { voidOrdinarySettlement } = require('../core/observer-completion');
const ROOT = path.resolve(__dirname, '../..');
const OUTCOME = path.join(ROOT, 'debug/duel-outcome-live/latest_result.json');
const HAND = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const LEDGER = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const LOG = path.join(ROOT, 'debug/duel-log-live/latest_result.json');
const INCREMENTAL = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
const CASES = [
  { id: 'M09', script: 'execution/live/run-m09-upstart.js',
    archive: '../runs/2026-10-05T15-11-16-735Z/game-00002/completed', draws: 1 },
  { id: 'M14', script: 'execution/live/run-m14-golden-bamboo-sword.js',
    archive: '../runs/2026-10-05T13-47-45-925Z/game-00004/completed', draws: 2 }
];
function harness(c, mode, archived = false) {
  const archive = path.resolve(ROOT, c.archive), disk = new Map(), reads = [], writes = [], events = [], messages = [];
  const actual = rel => fs.readFileSync(path.join(archive, rel));
  const baseline = JSON.parse(actual('debug/hand-change-live/session_state.json'));
  const victory = JSON.parse(actual('debug/duel-outcome-live/latest_result.json'));
  assert.ok(baseline.cards.some(row => row.id === c.id));
  assert.strictEqual(victory.strictEvidence.matched, true);
  for (const [file, rel] of [[HAND, 'debug/hand-change-live/session_state.json'],
    [LEDGER, 'debug/main-deck-ledger/state.json'], [LOG, 'debug/duel-log-live/latest_result.json'],
    [INCREMENTAL, 'debug/hand-change-live/latest_incremental_result.json']]) disk.set(file, Buffer.from(actual(rel)));
  const protectedBefore = [HAND, LEDGER].map(file => [file, Buffer.from(disk.get(file))]);
  let clock = Date.parse(victory.checkedAt) - 20000, mtime = 10, observerCalls = 0, marks = 0, observed = false;
  const put = (file, value) => { file = path.resolve(file); disk.set(file, Buffer.from(JSON.stringify(value))); writes.push(file); };
  put(OUTCOME, { ...victory, checkedAt: new Date(clock - 60000).toISOString() });
  writes.length = 0;
  const memoryFs = { existsSync: file => disk.has(path.resolve(file)), mkdirSync() {},
    statSync: file => { assert.strictEqual(path.resolve(file), OUTCOME); return { mtimeMs: mtime }; },
    readFileSync: (file, encoding) => {
      file = path.resolve(file); reads.push(file); const value = disk.get(file);
      if (!value) throw new Error('UNEXPECTED_ARTIFACT_READ:' + file);
      return encoding ? value.toString(encoding) : Buffer.from(value);
    }, copyFileSync: (source, target) => { disk.set(path.resolve(target), Buffer.from(disk.get(path.resolve(source)))); writes.push(path.resolve(target)); } };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const gui = name => { assert.strictEqual(observed, false, 'no GUI after observer terminal handoff'); events.push(name); };
  class FakeBridge { async start() { gui('START'); } async stop() { gui('STOP'); } }
  const runtime = { readJson: file => JSON.parse(memoryFs.readFileSync(file, 'utf8')), writeEvidenceJson: put };
  function load(relative, extra = {}, transform = text => text) {
    const file = path.join(ROOT, relative), native = createRequire(file), module = { exports: {} };
    vm.runInNewContext(transform(fs.readFileSync(file, 'utf8')), { module, __dirname: path.dirname(file),
      Buffer, Date: FakeDate, process: { execPath: process.execPath, versions: process.versions, env: {} },
      console: { log: (...values) => messages.push(values.join(' ')), error: (...values) => messages.push(values.join(' ')) },
      require: id => {
        if (id === 'fs') return memoryFs;
        if (Object.hasOwn(extra, id)) return extra[id];
        const n = id.replace(/\\/g, '/');
        if (n.endsWith('runtime-files')) return runtime;
        if (n.endsWith('win-fast')) return { MdFastBridge: FakeBridge, sleep: async () => gui('WAIT') };
        if (n.endsWith('md-foreground')) return { activateAndVerifyMasterDuel: async () => { gui('FOREGROUND'); return { info: {} }; } };
        if (n.endsWith('recognizer')) return { loadLibrary: () => ({}), loadTemplates: async () => [] };
        if (n.endsWith('observer-current-baseline')) return { establishCurrentObserverBaseline: async () => baseline };
        if (n.endsWith('hand-target')) return { selectObservedHandCard: async () => { gui('SELECT'); return {
          selected: { id: c.id, name: c.id }, slot: baseline.cards.findIndex(row => row.id === c.id) + 1,
          duplicateCount: 1, clickReference: { x: 0, y: 0 } }; } };
        if (n.endsWith('hand-spell-activation')) return { clickSelectedHandSpellActivation: async () => { gui('ACTIVATE'); return { pass: true }; } };
        if (n.endsWith('verified-status')) return { markExecutionPass: () => { marks++; } };
        return native(id);
      }
    }, { filename: file });
    return module.exports;
  }
  const completion = load('execution/core/observer-completion.js');
  const fakeChild = { spawnSync: (_, args) => {
    assert.ok(args[0].endsWith('runtime/observer/run-live-incremental.js') || args[0].endsWith('runtime\\observer\\run-live-incremental.js'));
    assert.ok(args.includes('--adjacent-checkpoint-only')); observerCalls++; observed = true; events.push('OBSERVER');
    clock += 20000;
    if (mode !== 'unchanged') {
      mtime++;
      put(OUTCOME, { ...victory, checkedAt: new FakeDate(mode === 'old-time' ? clock - 60000 : clock).toISOString(),
        type: mode === 'defeat' ? 'DEFEAT' : 'VICTORY',
        terminal: mode !== 'ordinary' && mode !== 'bad-delta',
        strictEvidence: { ...victory.strictEvidence, matched: mode !== 'weak' } });
    }
    if (mode === 'ordinary' || mode === 'bad-delta') {
      const consumedIndex = baseline.cards.findIndex(row => row.id === c.id), consumed = baseline.cards[consumedIndex];
      const gains = Array.from({ length: c.draws }, (_, i) => ({ id: i === 0 ? 'M03' : 'M12', name: i === 0 ? 'M03' : 'M12' }));
      const finalHand = baseline.cards.filter((_, i) => i !== consumedIndex).concat(gains);
      put(LOG, { newOperationBlocks: [{ activationKey: c.id,
        details: gains.map(card => ({ side: 'SELF', role: 'HAND_GAIN_CANDIDATE', rawType: 'HAND_GAIN', card })) }] });
      put(INCREMENTAL, { status: 'PASS', inference: { consumed, addedCount: c.draws },
        after: { handCount: mode === 'bad-delta' ? 99 : finalHand.length, cards: finalHand },
        insertedCards: gains.map((card, i) => ({ card, slot: baseline.handCount + i, actualSlot: baseline.handCount + i })) });
    }
    return { status: mode === 'observer-error' ? 1 : 0 };
  } };
  const sourceFile = archived ? path.join(path.dirname(path.dirname(archive)), 'engine-source', c.script) : path.join(ROOT, c.script);
  const executor = load(c.script, { child_process: fakeChild, '../core/observer-completion': completion }, () => {
    const source = fs.readFileSync(sourceFile, 'utf8'), end = source.lastIndexOf('\nmain().catch');
    assert.ok(end > 0); return source.slice(0, end) + '\nmodule.exports = { main };';
  });
  return { run: executor.main, reads, writes, events, messages, disk, protectedBefore, victory,
    get observerCalls() { return observerCalls; }, get marks() { return marks; },
    result: () => { const file = writes.find(p => p.endsWith(path.sep + 'result.json')); return file && JSON.parse(disk.get(file)); } };
}
function assertParentHandoff(outcome, exitCode = 0, confirmed = true) {
  // Real parent runExecutor must prefer the new strict victory even when the
  // fixed child now exits 0. It must NOT run ordinary decision-state accounting.
  const source = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
  const start = source.indexOf('function runExecutor('), end = source.indexOf('function incrementUsedCount(', start);
  let snapshots = 0, accounted = 0; const invalidated = [];
  const ctx = vm.createContext({ ROOT, path, fs: { existsSync: () => true }, process: { execPath: process.execPath, env: {} },
    console: { log() {} }, PRELOAD_PATH: 'MEMORY', loadDecisionState: () => ({}), snapshotDuelLogForCard: () => ({}),
    snapshotVictoryOutcome: () => ++snapshots === 1 ? { terminal: false, mtimeMs: 10 } : { terminal: confirmed, mtimeMs: 11, result: outcome },
    exodiaVictoryRisk: () => null, spawnSync: () => ({ status: exitCode }), voidOrdinarySettlement,
    writeJsonAtomic: (file, value) => invalidated.push({ file, value }), AUTO_RESYNC_AFTER_RESOLVED_IDS: new Set(),
    updateDecisionStateAfterSuccess: () => { accounted++; } });
  vm.runInContext(source.slice(start, end), ctx);
  const run = () => ctx.runExecutor('execution/live/run-m09-upstart.js', 1, { id: 'M09', name: 'M09' });
  if (confirmed) {
    assert.throws(run, e => e.terminalVictory === true && e.outcome === outcome &&
      e.message === 'V5_DUEL_TERMINAL_VICTORY' && e.ordinarySettlement.status === 'VOID_AFTER_CONFIRMED_VICTORY');
    assert.strictEqual(accounted, 0); assert.strictEqual(invalidated.length, 1);
    assert.strictEqual(invalidated[0].value.previousVerdict.exitCode, exitCode);
    assert.strictEqual(invalidated[0].value.countsAsExecutionPass, false);
    assert.strictEqual(invalidated[0].value.countsAsActionFailure, false);
    assert.strictEqual(invalidated[0].value.canCommitHandDelta, false);
    assert.ok(invalidated[0].file.endsWith(path.join('debug', 'v5', 'last-settlement-void.json')));
  } else {
    if (exitCode) { assert.throws(run, /V5_EXECUTOR_FAILED/); assert.strictEqual(accounted, 0); }
    else { run(); assert.strictEqual(accounted, 1); }
    assert.strictEqual(invalidated.length, 0, 'ordinary success/failure is not voided without confirmed WIN');
  }
}
async function test() {
  for (const c of CASES) {
    const old = harness(c, 'victory', true);
    await assert.rejects(old.run(), new RegExp(`EXEC_${c.id}_LOG_OPERATION_INVALID:0/1`));
    // Restored executors keep their original ordinary settlement error. The
    // parent decides WIN first, then retires that final verdict; never fake PASS.
    const current = harness(c, 'victory');
    await assert.rejects(current.run(), new RegExp(`EXEC_${c.id}_LOG_OPERATION_INVALID:0/1`));
    assert.strictEqual(current.result(), undefined, 'do not turn ordinary failure into action PASS');
    assert.strictEqual(current.observerCalls, 1); assert.strictEqual(current.marks, 0);
    assert.ok(current.reads.includes(LOG), 'original settlement flow restored');
    assert.ok(!current.reads.some(p => p === HAND || p === LEDGER));
    for (const [file, before] of current.protectedBefore) assert.ok(before.equals(current.disk.get(file)), 'terminal changes no hand/ledger');
    assertParentHandoff(current.victory);
    assertParentHandoff(current.victory, 1);
    assertParentHandoff(current.victory, 0, false);
    assertParentHandoff(current.victory, 1, false);
    for (const mode of ['unchanged', 'old-time', 'weak', 'defeat']) {
      const invalid = harness(c, mode);
      await assert.rejects(invalid.run(), new RegExp(`EXEC_${c.id}_LOG_OPERATION_INVALID`));
      assert.strictEqual(invalid.result(), undefined, 'stale/weak/defeat cannot bypass ordinary validation');
    }
    const failure = harness(c, 'observer-error'); await assert.rejects(failure.run(), /运行失败/);
    assert.strictEqual(failure.result(), undefined); assert.ok(!failure.reads.includes(LOG));
    const ordinary = harness(c, 'ordinary'); await ordinary.run();
    assert.strictEqual(ordinary.result().status, 'PASS'); assert.ok(ordinary.reads.includes(LOG));
    const badDelta = harness(c, 'bad-delta'); await assert.rejects(badDelta.run(), /HAND_COUNT_INVALID/);
    assert.strictEqual(badDelta.result(), undefined);
  }
  for (const status of ['PASS', 'FAIL', 'NOT_EVALUATED']) {
    const prior = { status, message: 'original evidence' }, snapshot = JSON.stringify(prior);
    const outcome = harness(CASES[0], 'victory').victory;
    const result = voidOrdinarySettlement(outcome, prior);
    assert.strictEqual(result.status, 'VOID_AFTER_CONFIRMED_VICTORY');
    assert.strictEqual(result.previousVerdict, prior); assert.strictEqual(JSON.stringify(prior), snapshot);
    for (const invalid of [{ ...outcome, terminal: false }, { ...outcome, type: 'DEFEAT' },
      { ...outcome, strictEvidence: { matched: false } }, { ...outcome, checkedAt: null }]) {
      assert.throws(() => voidOrdinarySettlement(invalid, prior), /REQUIRES_CONFIRMED_VICTORY/);
    }
  }
  console.log('DRAW_TERMINAL_HANDOFF_OFFLINE_PASS; M09/M14 original settlement/error restored; parent confirms strict WIN THEN voids final ordinary PASS/FAIL, not action PASS; exit0/exit1 no accounting; unconfirmed outcomes stay valid/fail-closed; hand/ledger unchanged; nativeInputs=0/diskWrites=0');
}
test().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
