'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { cropImage } = require('./engine/lib/png-utils');
const { validateVictorySettlementCheckpoint } = require('./runner');
const { summarize } = require('./policy');
const { playOne } = require('./session');
const ENGINE = path.join(__dirname, 'engine');
const RUN = path.join(__dirname, 'runs/2026-10-03T14-13-02-688Z');
const CP = path.join(ENGINE, 'debug/post-duel-victory/state.json');
const LEDGER = path.join(ENGINE, 'debug/settlement-rewards/daily-gems.json');
const summary = JSON.parse(fs.readFileSync(path.join(RUN, 'summary.json')));
const game = summary.games[1];
const checkpoint = JSON.parse(fs.readFileSync(path.join(RUN, 'game-00002/finish-stopped/debug/post-duel-victory/state.json')));
const frame = PNG.sync.read(fs.readFileSync(path.join(RUN, 'game-00002/finish-stopped/last-guarded-frame.png')));
const panel = PNG.sync.read(fs.readFileSync(path.join(RUN, 'game-00002/settlement/settlement_reward_panel_failed.png')));
const protectedFiles = [path.join(__dirname, 'statistics.json'), path.join(__dirname, 'latest-run.json'),
  path.join(RUN, 'summary.json'), path.join(RUN, 'events.jsonl'), CP, LEDGER];
const original = protectedFiles.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
const runnerSource = fs.readFileSync(path.join(__dirname, 'runner.js'), 'utf8');
const begin = runnerSource.indexOf('  async function finishBoard(');
const end = runnerSource.indexOf('\n  try {\n    // Exactly one explicit activation', begin);
assert.ok(begin >= 0 && end > begin);

function harness(saved = checkpoint, capturedFrame = frame, roiImages = new Map(), rewardPolicy = 'record-first') {
  const disk = new Map(), clicks = [], messages = [];
  let now = 1000, page = 'SETTLEMENT', missingEight = false, stopped = false, genericCalls = 0;
  const put = (file, value) => disk.set(path.resolve(file), Buffer.from(JSON.stringify(value)));
  const readJson = file => JSON.parse(disk.get(path.resolve(file)).toString());
  if (saved) put(CP, saved);
  const safe = async () => { if (stopped) throw new Error('AUTOTEST_STOP:USER_STOP'); return {}; };
  const bridge = { click: async (x, y) => {
    await safe(); clicks.push({ x, y });
    if (x === 1824 && y === 1052) page = 'STARTER';
    else assert.deepStrictEqual({ x, y }, { x: 1024, y: 1000 }, 'only animation/verified continue inputs are allowed');
  } };
  const png = { saveRgbaPng: (image, file) => disk.set(path.resolve(file), PNG.sync.write(image)) };
  const runtimeFiles = { readJson, writeJsonAtomic: put };
  const isAsset = file => ['material', 'templates'].some(dir =>
    path.resolve(file).startsWith(path.join(ENGINE, dir) + path.sep));
  const memoryFs = {
    existsSync: file => {
      if (missingEight && String(file).endsWith('duel-settlement-04-gems-108-plus-10.png')) return false;
      return disk.has(path.resolve(file)) || (isAsset(file) && fs.existsSync(file));
    },
    readFileSync: (file, encoding) => {
      const value = disk.get(path.resolve(file));
      if (value) return encoding ? value.toString(encoding) : Buffer.from(value);
      if (isAsset(file)) return fs.readFileSync(file, encoding);
      throw new Error('TEST_UNEXPECTED_DISK_READ:' + file);
    }, mkdirSync() {}
  };
  class FakeDate extends Date { static now() { return now; } }
  const win = {
    MdFastBridge: class { constructor() { throw new Error('NATIVE_BRIDGE_FORBIDDEN'); } },
    captureReferenceRoi: async (_, __, roi) => {
      await safe(); return roiImages.get(JSON.stringify(roi)) || cropImage(capturedFrame, roi);
    },
    mapReferencePoint: (_, point) => point,
    sleep: async ms => {
      await safe();
      // Advance the virtual timeout during the repeated failed-font case;
      // still run the actual pixel classifier on each captured real frame.
      now += missingEight ? Math.max(ms, 5000) : ms;
    }
  };
  function load(rel, extras = {}) {
    const file = path.join(ENGINE, rel), native = createRequire(file), module = { exports: {} };
    const context = vm.createContext({ __dirname: path.dirname(file), module, Buffer, Date: FakeDate,
      console: { log: (...args) => messages.push(args.join(' ')) },
      require: id => {
        if (Object.hasOwn(extras, id)) return extras[id];
        if (id === 'fs') return memoryFs;
        if (id.endsWith('win-fast')) return win;
        if (id.endsWith('md-foreground')) return { activateAndVerifyMasterDuel: async () => ({ info: await safe() }) };
        if (id.endsWith('scan-state')) return png;
        if (id.endsWith('runtime-files')) return runtimeFiles;
        return native(id);
      } });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return module.exports;
  }
  const settlement = load('execution/core/duel-settlement.js');
  const post = load('execution/core/post-duel-victory.js', { './duel-settlement': settlement });
  const context = vm.createContext({ bridge, path, runDir: RUN, currentDir: 'MEMORY_ONLY',
    frame: async () => ({ image: { page }, info: await safe() }),
    ui: { classifyPage: image => ({ page: image.page }) },
    safe, sleep: win.sleep, waitPage: async target => { await safe(); assert.strictEqual(page, target); },
    json: file => disk.has(path.resolve(file)) ? readJson(file) : null,
    validateVictorySettlementCheckpoint,
    postVictory: { ...post, CHECKPOINT_PATH: CP,
      runPostVictorySettlement: options => post.runPostVictorySettlement({ ...options, rewardPolicy }) },
    settlement: { runDuelSettlement: () => { genericCalls++; throw new Error('FRESH_REWARD_TRANSACTION_FORBIDDEN'); } },
    surrender: { runConfirmedDeadlockSurrender: () => { throw new Error('SURRENDER_AFTER_WIN_FORBIDDEN'); } } });
  vm.runInContext(runnerSource.slice(begin, end), context);
  return { disk, clicks, messages, readJson, settlement,
    finish: (target = game, result = { outcome: 'WIN', gems: null }) => context.finishBoard(target, result),
    setMissingEight: value => { missingEight = value; }, setStop: () => { stopped = true; },
    get genericCalls() { return genericCalls; } };
}

async function test() {
  const current = require('./engine/execution/core/duel-settlement');
  const oldFile = path.join(RUN, 'engine-source/execution/core/duel-settlement.js');
  const oldNative = createRequire(oldFile), oldModule = { exports: {} };
  const oldContext = vm.createContext({ module: oldModule, __dirname: path.dirname(oldFile), console,
    require: id => {
      // Archived source deliberately excludes mutable decision state. Its pure
      // pixel classifier needs neither that state nor a native bridge adapter.
      if (id.endsWith('scan-state') || id.endsWith('win-fast') || id.endsWith('md-foreground')) return {};
      return oldNative(id);
    } });
  vm.runInContext(fs.readFileSync(oldFile, 'utf8'), oldContext, { filename: oldFile });
  const old = oldModule.exports;
  const oldResult = old.recognizeSettlementGemRewards(panel);
  assert.strictEqual(oldResult.pass, false);
  assert.strictEqual(oldResult.rewards[0].count.text, '106', 'reproduce real 8 -> 6 ranking error');
  const fixed = current.recognizeSettlementGemRewards(panel);
  assert.strictEqual(fixed.pass, true);
  assert.deepStrictEqual(fixed.rewards.map(row => row.count.value), [108, 10]);
  assert.strictEqual(fixed.total, 118);
  assert.strictEqual(fixed.rewards[0].count.digits[2].source, 'SETTLEMENT_VERIFIED');
  const otherFrame = PNG.sync.read(fs.readFileSync(path.join(RUN,
    'game-00002/finish-stopped/debug/post-duel-victory/2026-10-03T14-27-06-564Z/settlement/settlement_reward_panel_failed.png')));
  assert.strictEqual(current.recognizeSettlementGemRewards(otherFrame).total, 118);
  assert.strictEqual(current.recognizeSettlementGemRewards(panel, {
    digitTemplates: current.loadSettlementDigitTemplates().filter(row => row.digit !== 8) }).pass, false,
  'missing-glyph ambiguity must still reject; do not lower margin gates');
  assert.strictEqual(current.recognizeSettlementGemRewards({ ...panel, data: Buffer.alloc(panel.data.length) }).pass, false);

  const latestRun = path.join(__dirname, 'runs/2026-10-03T15-12-58-130Z');
  const latestPanel = PNG.sync.read(fs.readFileSync(path.join(latestRun,
    'game-00002/completed/debug/post-duel-victory/2026-10-03T15-25-27-062Z/settlement/settlement_reward_panel.png')));
  // The previous source silently accepted the nearest class from an incomplete
  // alphabet. Test its old 5->6 false acceptance, not merely our new template.
  const archivedFile = path.join(latestRun, 'engine-source/execution/core/duel-settlement.js');
  const archivedNative = createRequire(archivedFile), archivedModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(archivedFile, 'utf8'), {
    module: archivedModule, __dirname: path.dirname(archivedFile), console,
    require: id => id.endsWith('scan-state') || id.endsWith('win-fast') || id.endsWith('md-foreground')
      ? {} : archivedNative(id)
  }, { filename: archivedFile });
  const wrong132 = archivedModule.exports.recognizeSettlementGemRewards(latestPanel);
  assert.strictEqual(wrong132.pass, true); assert.strictEqual(wrong132.total, 132);
  const correct130 = current.recognizeSettlementGemRewards(latestPanel);
  assert.strictEqual(correct130.pass, true); assert.strictEqual(correct130.total, 130);
  assert.deepStrictEqual(correct130.rewards.map(row => row.count.value), [115, 15]);
  assert.strictEqual(current.recognizeSettlementGemRewards(latestPanel, {
    digitTemplates: current.loadSettlementDigitTemplates().filter(row => row.digit !== 5)
  }).pass, false, 'missing class must reject, not map 5 to 6 or silently accept INFO font');
  // Completed guarded frame is Starter, not the reward page. Replay the three
  // exact settlement captures from this game, rather than a later page.
  const latestDir = path.join(latestRun,
    'game-00002/completed/debug/post-duel-victory/2026-10-03T15-25-27-062Z/settlement');
  const roiImages = new Map([
    [current.SETTLEMENT_HEADER_ROI, 'settlement_header.png'],
    [current.SETTLEMENT_REWARD_PANEL_ROI, 'settlement_reward_panel.png'],
    [current.SETTLEMENT_CONTINUE_ROI, 'settlement_continue.png']
  ].map(([roi, file]) => [JSON.stringify(roi), PNG.sync.read(fs.readFileSync(path.join(latestDir, file)))]));
  const recovered130 = harness(checkpoint, frame, roiImages);
  assert.strictEqual((await recovered130.finish()).gems, 130);
  assert.strictEqual(Object.values(recovered130.readJson(LEDGER).days)[0].observedTotal, 130);
  assert.strictEqual((await recovered130.finish(game, { outcome: 'WIN', gems: 130 })).gems, 130);
  assert.strictEqual(recovered130.clicks.length, 1);

  // Actual runner -> actual post-victory -> actual reward recognizer/ledger,
  // seeded with the real failed checkpoint. All writes and input stay in memory.
  const recovered = harness();
  const reward = await recovered.finish();
  assert.strictEqual(reward.gems, 118);
  assert.strictEqual(recovered.readJson(CP).settlementId, checkpoint.settlementId);
  assert.strictEqual(recovered.readJson(CP).stage, 'COMPLETE');
  assert.deepStrictEqual(recovered.clicks, [{ x: 1824, y: 1052 }], 'no repeated victory/animation inputs');
  assert.strictEqual(recovered.genericCalls, 0);
  assert.strictEqual((await recovered.finish(game, { outcome: 'WIN', gems: 118 })).gems, 118);
  assert.strictEqual(recovered.clicks.length, 1, 'completed handoff must not click again');
  const ledger = recovered.readJson(LEDGER), day = Object.values(ledger.days)[0];
  assert.strictEqual(day.observedTotal, 118); assert.strictEqual(day.entries.length, 1);
  assert.strictEqual(day.entries[0].settlementId, checkpoint.settlementId);

  const committed = harness({ ...checkpoint, stage: 'REWARD_RECORDED', gems: 118 });
  committed.settlement.commitGemReward({ value: 118, fingerprint: 'already-committed', settlementId: checkpoint.settlementId });
  assert.strictEqual((await committed.finish()).gems, 118);
  assert.strictEqual(Object.values(committed.readJson(LEDGER).days)[0].entries.length, 1, 'same ID deduplicates reward handoff');
  assert.strictEqual(committed.clicks.length, 1);

  const fresh = harness(null);
  assert.strictEqual((await fresh.finish()).gems, 118);
  assert.ok(fresh.clicks.length > 1, 'without completed animation checkpoint, the original animation still runs');
  assert.ok(fresh.readJson(CP).settlementId);

  for (const invalid of [{ ...checkpoint, startedAt: '2026-10-02T00:00:00Z' },
    { ...checkpoint, stage: 'UNKNOWN' }, { ...checkpoint, settlementId: '' }, { ...checkpoint, version: 9 }]) {
    const stale = harness(invalid);
    await assert.rejects(stale.finish(), /CHECKPOINT_NOT_CURRENT_GAME/);
    assert.strictEqual(stale.clicks.length, 0); assert.strictEqual(stale.disk.size, 1);
  }

  const failed = harness(checkpoint, frame, new Map(), 'strict'); failed.setMissingEight(true);
  const failedGame = { ...game, gems: null }; delete failedGame.finishError;
  const calls = [], store = { save() {}, finish: (_, outcome, details) => Object.assign(failedGame, details, { outcome }) };
  const result = await playOne(store, { stopped: () => false,
    play: async () => ({ outcome: 'WIN', proven: true }), finishBoard: () => failed.finish(),
    archive: async (_, label) => calls.push(label) }, failedGame);
  assert.strictEqual(result.stop, true); assert.strictEqual(failedGame.outcome, 'WIN');
  assert.deepStrictEqual(calls, ['finish-stopped']); assert.strictEqual(failed.clicks.length, 0);
  assert.strictEqual(failed.disk.has(LEDGER), false, 'unknown counts cannot write even a partial reward');
  assert.deepStrictEqual(failed.readJson(CP), checkpoint);
  assert.strictEqual(summarize([failedGame]).errorGames, 1);
  assert.strictEqual(summarize([{ ...failedGame, error: 'OTHER_ERROR' }]).errorGames, 1, 'two errors in one game count once');
  assert.strictEqual(summarize([failedGame]).unknownGemGames, 1);
  assert.ok([...failed.disk.keys()].some(file => file.endsWith('settlement_recognition_failed.json')));

  const stop = harness(); stop.setStop(); await assert.rejects(stop.finish(), /USER_STOP/);
  assert.strictEqual(stop.clicks.length, 0); assert.strictEqual(stop.disk.size, 1);
  for (const [file, before] of original) assert.ok(before ? before.equals(fs.readFileSync(file)) : !fs.existsSync(file),
    'real archive/runtime/statistics unchanged: ' + file);
  console.log('SETTLEMENT_REGRESSION_PASS; real 108+10=118 and 115+15=130; old 8->6 and silent 132 reproduced; missing 5/8 closed; actual runner/post/reward transaction; no repeated animation; same-ID dedup; stale checkpoint/unknown reward/user stop closed; finishError counted; diskWrites=0/nativeInputs=0');
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { test, harness, CP, LEDGER };
