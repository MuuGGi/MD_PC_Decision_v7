'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');
const { chooseDecision, choosePrompt, classifyFailure, summarize, classifyEnd } = require('./policy');
const { playOne } = require('./session');
const { TestStore, snapshot } = require('./store');
const { copyTreeAsync } = require('./runner');
const { createRequire } = require('module');
const ui = require('./ui');
async function test() {
  // Exercise the actual startup dispatch with a deliberate barrier BEFORE the
  // lock/write/bridge phase. Any readline import or native operation fails.
  const runnerFile = path.join(__dirname, 'runner.js'), runnerSource = fs.readFileSync(runnerFile, 'utf8');
  function startup(argv, version = '20.11.1') {
    let reachedLock = 0;
    const messages = [], module = { exports: {} }, native = createRequire(runnerFile);
    const context = vm.createContext({ module, __dirname, console: { log: text => messages.push(text) },
      process: { argv: ['node', runnerFile, ...argv], versions: { node: version } },
      require: id => {
        if (id.startsWith('readline')) throw new Error('STARTUP_MUST_NOT_READ_STDIN');
        if (id === 'fs') return {
          existsSync: file => file === path.join(__dirname, 'engine/runtime/main-v6.js'),
          openSync: () => { reachedLock++; throw new Error('STARTUP_OFFLINE_BOUNDARY'); }
        };
        if (id === 'child_process') return { spawn() { throw new Error('NATIVE_INPUT_FORBIDDEN'); },
          spawnSync() { throw new Error('NATIVE_INPUT_FORBIDDEN'); } };
        if (id.startsWith('./engine/')) throw new Error('LIVE_ENGINE_FORBIDDEN');
        return native(id);
      } });
    vm.runInContext(runnerSource, context, { filename: runnerFile });
    return { run: () => module.exports.run(), messages, get reachedLock() { return reachedLock; } };
  }
  for (const args of [[], ['--max-games=5'], ['--start', '--max-games=5']]) {
    const direct = startup(args); await assert.rejects(direct.run(), /STARTUP_OFFLINE_BOUNDARY/);
    assert.strictEqual(direct.reachedLock, 1, 'starts without any additional input');
  }
  for (const args of [['--max-games=bad'], ['--unknown']]) {
    const invalid = startup(args); await assert.rejects(invalid.run(), /UNKNOWN_ARGUMENT/);
    assert.strictEqual(invalid.reachedLock, 0);
  }
  const oldNode = startup(['--max-games=5'], '12.18.4');
  await assert.rejects(oldNode.run(), /NODE_MUST_BE_20_11_1/); assert.strictEqual(oldNode.reachedLock, 0);
  for (const args of [['--help'], ['--stats']]) {
    const query = startup(args); await query.run(); assert.strictEqual(query.reachedLock, 0);
  }
  assert.match(runnerSource, /await waitPage\('STARTER'\)/);
  assert.ok(runnerSource.includes('store.state.games.length < maxGames'));
  console.log('AUTOTEST_DIRECT_START_OFFLINE_PASS; default/max5/legacy-start no stdin; help/stats no start; unknown args/old Node closed; Starter and maxGames gates preserved; nativeInputs=0/diskWrites=0');
  await require('./tests-m17-resume').test();
  await require('./tests-true-bamboo').test();
  assert.strictEqual(chooseDecision({ selected: { id: 'M17' } }), '');
  assert.strictEqual(chooseDecision({ strategicDeadlock: { terminal: true } }), 'x');
  assert.strictEqual(chooseDecision({ fieldAction: 'R1' }), 'f');
  assert.throws(() => chooseDecision({}), /NO_PROVEN_DECISION/);
  for (const prompt of ['V5[M19_EQUIPPED]> ', 'V6[胜利后续]> ', 'V6[万宝槌后续]> ']) assert.strictEqual(choosePrompt(prompt), '');
  assert.throws(() => choosePrompt('V6[选择本次原子Link]> '), /UNKNOWN_PROMPT/);
  assert.strictEqual(choosePrompt('开局前最后是否用了已结算的万宝槌？[y=是，只记最后抽卡 / n=否，普通基线]：'), 'n');
  assert.throws(() => choosePrompt('要删除所有日志吗？'), /UNKNOWN_PROMPT/);
  assert.throws(() => choosePrompt('V5[NEW_UNREVIEWED_NODE]> '), /UNKNOWN_PROMPT/);
  assert.throws(() => choosePrompt('V6[选择本次原子Link]> V5[UNKNOWN_NODE]> '), /UNKNOWN_PROMPT/);
  // Execute the actual isolated formal decision-reader, not a surrogate
  // strategy. Hand/field/deadlock decisions must bypass human questions.
  const mainSource = fs.readFileSync(path.join(__dirname, 'engine/runtime/main-v6.js'), 'utf8');
  const from = mainSource.indexOf('function parseCommand('), to = mainSource.indexOf('function printHelp(', from);
  const controller = vm.createContext({ process: { env: { MD_AUTOTEST_RUN: 'OFFLINE', MD_AUTOTEST_HOOK: 'MEMORY' } },
    require: () => ({ decision: chooseDecision }), currentFieldActionLabel: () => null });
  vm.runInContext(mainSource.slice(from, to), controller);
  const noQuestion = { question() { throw new Error('HUMAN_QUESTION_IN_AUTOMATIC_MODE'); } };
  const auto = { choose: () => ({ automatic: false }) };
  const reader = controller.readDecisionCommand;
  const chosen = await reader({ revision: 25, handCount: 7 }, { selected: { slot: 7, id: 'M17' } }, noQuestion, auto);
  assert.strictEqual(chosen.command.type, 'PLAY_SLOT'); assert.strictEqual(chosen.command.slot, 7);
  const dead = await reader({ revision: 25, handCount: 7 }, { strategicDeadlock: { terminal: true } }, noQuestion, auto);
  assert.strictEqual(dead.command.type, 'SURRENDER');
  controller.currentFieldActionLabel = () => 'R1';
  assert.strictEqual((await reader({ revision: 25 }, {}, noQuestion, auto)).command.type, 'FIELD');
  for (const message of ['MOUSE_INTERFERENCE', 'Foreground window is not Master Duel', 'USER_STOP', 'CLIENT_UNSAFE',
    'CopyFromScreen failed', 'AUTOTEST_GUARD_WRITE_FAILED', 'GUARD_MUTEX_TIMEOUT']) {
    assert.strictEqual(classifyFailure(new Error(message)), 'STOP_TEST');
  }
  assert.strictEqual(classifyFailure(new Error('M12_FINAL_HAND_MULTISET_INVALID')), 'ARCHIVE_AND_SURRENDER');
  assert.strictEqual(classifyEnd({ victoryProven: true, stopped: true }), 'INTERRUPTED');
  const starter = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures/starter-full.png')));
  const main1 = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures/main1-full.png')));
  assert.strictEqual(ui.classifyPage(starter).page, 'STARTER');
  assert.strictEqual(ui.classifyPage(main1).page, 'MAIN1');
  assert.strictEqual(ui.detectMain1(starter).pass, false);
  assert.strictEqual(ui.detectStarter(main1).pass, false);
  const blank = { width: 2048, height: 1152, data: Buffer.alloc(2048 * 1152 * 4) };
  assert.strictEqual(ui.classifyPage(blank).page, 'UNKNOWN');
  const altered = { ...main1, data: Buffer.from(main1.data) };
  for (let y = 500; y < 538; y++) for (let x = 1517; x < 1633; x++) altered.data.fill(0, (y * 2048 + x) * 4, (y * 2048 + x + 1) * 4);
  assert.strictEqual(ui.detectMain1(altered).pass, false, 'blue priority alone is not Main1 proof');
  assert.deepStrictEqual(summarize([{ outcome: 'WIN', gems: 79 }, { outcome: 'SURRENDER', gems: 0 },
    { outcome: 'LOSS', gems: null }, { outcome: 'INTERRUPTED' }]), {
    started: 4, completed: 3, wins: 1, losses: 2, surrenders: 1, interrupted: 1, unresolved: 0,
    errorGames: 0, errorSurrenders: 0, gems: 79, unknownGemGames: 1
  });
  fs.mkdirSync(path.join(__dirname, 'test-evidence'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(__dirname, 'test-evidence', 'offline-'));
  const copySource = path.join(tmp, 'copy-source'), copyDestination = path.join(tmp, 'copy-destination');
  fs.mkdirSync(path.join(copySource, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(copySource, 'nested', 'evidence.txt'), 'immutable-source');
  let eventLoopAdvanced = false;
  const copyPromise = copyTreeAsync(copySource, copyDestination, { recursive: true });
  await new Promise(resolve => setImmediate(() => { eventLoopAdvanced = true; resolve(); }));
  const copyResult = await copyPromise;
  assert.strictEqual(copyResult.ok, true); assert.strictEqual(eventLoopAdvanced, true);
  assert.strictEqual(fs.readFileSync(path.join(copyDestination, 'nested', 'evidence.txt'), 'utf8'), 'immutable-source');
  // Temporary evidence is retained; no destructive cleanup against a computed path.
  function harness(name, options = {}) {
    const store = new TestStore(path.join(tmp, name)); let stopped = false; const calls = [];
    const adapters = { stopped: () => stopped,
      start: async () => { calls.push('START'); }, waitMain1: async () => { calls.push('MAIN1'); },
      play: async () => { calls.push('PLAY'); if (options.error) throw new Error(options.error);
        return { outcome: 'WIN', proven: true, gems: 79 }; },
      archive: async (_, label) => { calls.push(`ARCHIVE:${label}`); if (options.stopDuringArchive) stopped = true;
        if (options.archiveFails) throw new Error('DISK_FULL'); },
      observeEnd: async () => { calls.push('OBSERVE'); return options.alreadyWon ? { outcome: 'WIN', proven: true } : null; },
      surrender: async () => { calls.push('SURRENDER'); return { outcome: 'SURRENDER', proven: true }; },
      finishBoard: async () => { calls.push('FINISH'); if (options.finishFails) throw new Error('REWARD_UNKNOWN'); return { gems: options.error ? 0 : 79 }; }
    }; return { store, adapters, calls };
  }
  const normal = harness('normal'); await playOne(normal.store, normal.adapters);
  assert.deepStrictEqual(normal.calls, ['START', 'MAIN1', 'PLAY', 'FINISH', 'ARCHIVE:completed']);
  assert.strictEqual(normal.store.state.totals.wins, 1);
  normal.store.finish(normal.store.state.games[0], 'WIN', { gems: 79 });
  assert.strictEqual(normal.store.state.totals.gems, 79, 'no double-count after repeated outcome commit');
  const failed = harness('failed', { error: 'M12_FINAL_HAND_MULTISET_INVALID' });
  const recovered = await playOne(failed.store, failed.adapters);
  assert.strictEqual(recovered.stop, false);
  assert.deepStrictEqual(failed.calls, ['START', 'MAIN1', 'PLAY', 'ARCHIVE:before-recovery', 'OBSERVE', 'SURRENDER', 'FINISH', 'ARCHIVE:completed']);
  assert.strictEqual(failed.store.state.totals.losses, 1); assert.strictEqual(failed.store.state.totals.surrenders, 1);
  assert.strictEqual(failed.store.state.totals.unresolved, 0);
  assert.strictEqual(failed.store.state.games[0].errorSurrender, true);
  assert.strictEqual(failed.store.state.totals.errorSurrenders, 1);
  const interference = harness('mouse', { error: 'MOUSE_INTERFERENCE' });
  assert.strictEqual((await playOne(interference.store, interference.adapters)).stop, true);
  assert.ok(!interference.calls.includes('SURRENDER')); assert.strictEqual(interference.store.state.totals.completed, 0);
  const duringArchive = harness('archive-stop', { error: 'M11_FRAME_INVALID', stopDuringArchive: true });
  assert.strictEqual((await playOne(duringArchive.store, duringArchive.adapters)).stop, true);
  assert.ok(!duringArchive.calls.includes('SURRENDER'));
  const archiveFailed = harness('archive-failed', { error: 'M11_FRAME_INVALID', archiveFails: true });
  await assert.rejects(playOne(archiveFailed.store, archiveFailed.adapters), /DISK_FULL/);
  assert.ok(!archiveFailed.calls.includes('SURRENDER'), 'cannot discard a duel before its evidence is saved');
  const alreadyWon = harness('already-win', { error: 'NORMAL_LOG_AFTER_VICTORY', alreadyWon: true });
  await playOne(alreadyWon.store, alreadyWon.adapters);
  assert.ok(!alreadyWon.calls.includes('SURRENDER'));
  const rewardFailed = harness('reward', { finishFails: true });
  assert.strictEqual((await playOne(rewardFailed.store, rewardFailed.adapters)).stop, true);
  assert.strictEqual(rewardFailed.store.state.totals.wins, 1, 'confirmed win is retained if navigation fails');
  assert.strictEqual(rewardFailed.store.state.totals.errorGames, 1, 'settlement errors must not disappear from error totals');
  const source = path.join(tmp, 'fake-engine'); fs.mkdirSync(path.join(source, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(source, 'decision-state.json'), JSON.stringify({ branch: 'PENDING' }));
  fs.writeFileSync(path.join(source, 'debug/evidence.json'), JSON.stringify({ transaction: 'SELECTED' }));
  const destination = path.join(tmp, 'replay'); const manifest = snapshot(source, destination, { label: 'before-surrender' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(destination, 'debug/evidence.json'))), { transaction: 'SELECTED' });
  assert.ok(manifest.files['decision-state.json']);
  const { replay } = require('./replay');
  assert.strictEqual(replay(destination).status, 'PRE_BASELINE_ARCHIVE');
  const replaySource = path.join(tmp, 'saved-engine');
  fs.mkdirSync(path.join(replaySource, 'debug/hand-change-live'), { recursive: true });
  fs.mkdirSync(path.join(replaySource, 'debug/main-deck-ledger'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'engine/lib'), path.join(replaySource, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'engine/card-library.json'), path.join(replaySource, 'card-library.json'));
  for (const [fixture, target] of [
    ['issue-122-hand.json', 'debug/hand-change-live/session_state.json'],
    ['issue-122-ledger.json', 'debug/main-deck-ledger/state.json'],
    ['issue-122-decision.json', 'decision-state.json']
  ]) fs.copyFileSync(path.join(__dirname, 'engine/material/issues', fixture), path.join(replaySource, target));
  const fullArchive = path.join(tmp, 'full-replay');
  const savedManifest = snapshot(replaySource, fullArchive, { label: 'before-recovery', error: 'OFFLINE_FIXTURE' });
  const fullReplay = replay(fullArchive);
  assert.strictEqual(fullReplay.status, 'OFFLINE_REPLAY');
  assert.strictEqual(fullReplay.handRevision, 25);
  assert.strictEqual(fullReplay.ledgerRevision, 25);
  assert.strictEqual(fullReplay.deckRemaining.M19, 1);
  assert.strictEqual(fullReplay.deckRemaining.M20, 0);
  assert.strictEqual(fullReplay.error, 'OFFLINE_FIXTURE');
  const { sha } = require('./store');
  for (const [rel, hash] of Object.entries(savedManifest.files)) {
    assert.strictEqual(sha(path.join(fullArchive, rel)), hash, 'offline replay must not write archived state');
  }
  fs.appendFileSync(path.join(fullArchive, 'decision-state.json'), '\n ');
  assert.throws(() => replay(fullArchive), /REPLAY_HASH_INVALID/);
  const aggregateDir = path.join(tmp, 'runs'); fs.mkdirSync(aggregateDir, { recursive: true });
  const statisticsPath = path.join(tmp, 'statistics.json');
  const firstRun = new TestStore(path.join(aggregateDir, 'first'), { aggregateDir, statisticsPath });
  const firstGame = firstRun.begin(); firstGame.duelStarted = true;
  firstRun.finish(firstGame, 'WIN', { gems: 79 });
  const secondRun = new TestStore(path.join(aggregateDir, 'second'), { aggregateDir, statisticsPath });
  const secondGame = secondRun.begin(); secondGame.duelStarted = true;
  secondRun.finish(secondGame, 'SURRENDER', { gems: 0 });
  secondRun.finish(secondGame, 'SURRENDER', { gems: 0 });
  const totals = JSON.parse(fs.readFileSync(statisticsPath)).totals;
  assert.strictEqual(totals.gems, 79); assert.strictEqual(totals.completed, 2);
  assert.strictEqual(totals.wins, 1); assert.strictEqual(totals.losses, 1); assert.strictEqual(totals.surrenders, 1);
  console.log(`AUTOTEST_OFFLINE_PASS; starter/Main1 strict; archive-before-error-surrender; human stop no restart; counts/gems/replay; GUI_INPUTS=0; evidence=${tmp}`);
}
if (require.main === module) test().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { test };
