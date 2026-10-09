'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TestStore, snapshot, stamp, sourceSnapshotFilter, pruneArchivedDebugImages } = require('./store');
const { playOne } = require('./session');
const { classifyFailure } = require('./policy');
const { readRollingFrame } = require('./diagnostics');
const { writeJsonAtomic } = require('../engine/lib/runtime-files');
const ENGINE = path.join(__dirname, '..', 'engine');
const RUNS = path.resolve(__dirname, '../archive/autotest/runs');
const LATEST = path.resolve(__dirname, '../debug/autotest/latest-run.json');
const STATISTICS = path.resolve(__dirname, '../debug/autotest/statistics.json');
const LOCK = path.resolve(__dirname, '../debug/autotest/active.lock');
const HOOK = path.join(__dirname, 'auto-hook.js');
function json(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
function validateVictorySettlementCheckpoint(game, checkpoint) {
  if (!checkpoint) return;
  const gameAt = Date.parse(game && game.startedAt);
  const checkpointAt = Date.parse(checkpoint.startedAt);
  if (checkpoint.version !== 1 || typeof checkpoint.settlementId !== 'string' || !checkpoint.settlementId.trim() ||
      !['VICTORY_READY', 'VICTORY_CONFIRMED', 'REWARD_RECORDED', 'COMPLETE'].includes(checkpoint.stage) ||
      !Number.isFinite(gameAt) || !Number.isFinite(checkpointAt) || checkpointAt < gameAt) {
    throw new Error('AUTOTEST_VICTORY_CHECKPOINT_NOT_CURRENT_GAME');
  }
}
function isCurrentStrictVictory(game, outcome) {
  const at = Date.parse(outcome?.checkedAt), start = Date.parse(game?.startedAt);
  return Number.isFinite(at) && Number.isFinite(start) && at >= start &&
    outcome?.terminal === true && outcome.type === 'VICTORY' &&
    outcome.strictEvidence?.reasonText?.matched === true &&
    outcome.strictEvidence?.exodiaLastFive?.matched === true;
}
function requireInside(file, root) {
  const rel = path.relative(root, path.resolve(file));
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) throw new Error('AUTOTEST_PATH_OUTSIDE_ISOLATION');
}
function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
function copyTreeAsync(source, destination, options = {}) {
  return new Promise(resolve => {
    fs.cp(source, destination, options, error => resolve(error ? { ok: false, error } : { ok: true }));
  });
}
function lock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  if (fs.existsSync(LOCK)) {
    const old = json(LOCK);
    let alive = true; try { process.kill(old.pid, 0); } catch (_) { alive = false; }
    if (alive) throw new Error('AUTOTEST_ALREADY_RUNNING');
    fs.renameSync(LOCK, `${LOCK}.stale.${stamp()}`);
  }
  const fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
}
async function run() {
  if (process.versions.node !== '20.11.1') throw new Error('AUTOTEST_NODE_MUST_BE_20_11_1');
  const args = process.argv.slice(2);
  if (args.includes('--resume-m17-search')) throw new Error('AUTOTEST_RESUME_V7_NOT_MIGRATED: preserved evidence; no input, no reopening. Start a fresh proven Starter test instead.');
  if (args.includes('--doctor')) { console.log(JSON.stringify(require('../tools/doctor-v7').doctor(), null, 2)); return; }
  if (args.includes('--preflight')) { await require('../tools/doctor-v7').preflight(); return; }
  if (args.includes('--check')) { require('./verify').verify(); return; }
  if (args.includes('--stats')) { console.log(JSON.stringify(json(STATISTICS), null, 2)); return; }
  const replayIndex = args.indexOf('--replay');
  if (replayIndex >= 0) { console.log(JSON.stringify(require('./replay').replay(args[replayIndex + 1]), null, 2)); return; }
  if (args.includes('--help')) {
    console.log('run-v7-autotest.cmd: 命令即开始，默认最多5局，无需start或额外回车；游戏需在Duel Starter。Ctrl+C或 --stop 停止；--check离线验证；--doctor静态预检；--preflight只读窗口/页面预检；--stats统计；--replay "存档目录"只读复盘；--max-games=N，N必须为正整数。--resume仅支持最近人工干扰中已提交首次装备的证据恢复，不重复发动；不支持任意局内状态。旧局 --resume-m17-search 尚未迁移，拒绝输入并保留现场。'); return;
  }
  if (args.includes('--stop')) {
    const latest = json(LATEST); if (!latest) throw new Error('AUTOTEST_NO_ACTIVE_RUN');
    requireInside(latest.stopPath, RUNS); fs.writeFileSync(latest.stopPath, 'USER_STOP'); console.log('已发送全局停止；不投降、不重开。'); return;
  }
  const resumeSearch = args.includes('--resume');
  const unknown = args.filter(arg => arg !== '--start' && arg !== '--resume' && !/^--max-games=\d+$/.test(arg));
  if (unknown.length) throw new Error(`AUTOTEST_UNKNOWN_ARGUMENT:${unknown.join(',')}`);
  const requestedMax = args.find(arg => arg.startsWith('--max-games='));
  if (requestedMax && (!Number.isSafeInteger(Number(requestedMax.split('=')[1])) || Number(requestedMax.split('=')[1]) < 1))
    throw new Error('AUTOTEST_MAX_GAMES_MUST_BE_POSITIVE_INTEGER');
  require('../tools/doctor-v7').doctor();
  if (!resumeSearch) console.log('V7全自动测试：命令即启动，无需start或额外确认；先验证Duel Starter与窗口安全。V6只作冻结参考，不参与运行。');
  if (!fs.existsSync(path.join(ENGINE, 'runtime/main-v7.js'))) throw new Error('AUTOTEST_ENGINE_MISSING');
  const resumePlan = resumeSearch ? require('./resume-unit').prepareResume(json(LATEST), RUNS, ENGINE) : null;
  lock();
  const runDir = resumePlan ? resumePlan.runDir : path.join(RUNS, stamp());
  const epochDir = resumePlan ? path.join(resumePlan.gameDir, `resume-${stamp()}`) : runDir;
  fs.mkdirSync(epochDir, { recursive: true });
  const store = new TestStore(runDir, { aggregateDir: RUNS, statisticsPath: STATISTICS, resume: resumeSearch });
  const stopPath = path.join(epochDir, 'STOP');
  const guardPath = path.join(epochDir, 'input-guard.txt');
  const rollingFramePath = path.join(epochDir, 'rolling-guarded-frame.json');
  const ticketPath = resumePlan ? path.join(epochDir, 'resume-ticket.json') : null;
  if (resumePlan) writeJsonAtomic(ticketPath, resumePlan);
  writeJsonAtomic(LATEST, { runDir, stopPath, pid: process.pid });
  process.env.MD_AUTOTEST_STOP = stopPath;
  process.env.MD_AUTOTEST_GUARD = guardPath;
  let stopping = false, child = null, lastFrame = null, currentDir = epochDir;
  let resumePending = resumeSearch, resumedGame = null;
  let engineArchivePromise = null, engineArchiveResult = null;
  const stop = reason => {
    stopping = true; if (!fs.existsSync(stopPath)) fs.writeFileSync(stopPath, reason);
    store.event('TEST_STOP_REQUEST', { reason }); killTree(child);
  };
  const onSignal = () => stop('USER_STOP');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep, clientReport } = require('../engine/lib/win-fast');
  const { activateAndVerifyMasterDuel } = require('../engine/lib/md-foreground');
  const { saveRgbaPng } = require('../engine/runtime/observer/scan-state');
  const surrender = require('../engine/execution/core/deadlock-surrender');
  const settlement = require('../engine/execution/core/duel-settlement');
  const postVictory = require('../engine/execution/core/post-duel-victory');
  const ui = require('./ui');
  const bridge = new MdFastBridge();
  const rawCommand = bridge.command.bind(bridge);
  bridge.command = async command => {
    const input = /^(?:click|move|mouseDown|drag|wheel|key)/.test(command.cmd);
    if (input) store.event('SUPERVISOR_INPUT_REQUEST', { gameId: store.state.games.at(-1)?.id, command });
    const result = await rawCommand(command);
    if (input) store.event('SUPERVISOR_INPUT_COMPLETE', { gameId: store.state.games.at(-1)?.id, command });
    return result;
  };
  const stopped = () => stopping || fs.existsSync(stopPath);
  async function safe() {
    if (stopped()) throw new Error('AUTOTEST_STOP:USER_STOP');
    await bridge.command({ cmd: 'guardCheck' });
    const info = await bridge.info(), report = clientReport(info);
    if (report.aspectError > 0.03 || !report.clientFullyVisible) { stop('CLIENT_UNSAFE'); throw new Error('CLIENT_UNSAFE'); }
    return info;
  }
  async function frame() {
    const info = await safe();
    const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
    lastFrame = { image, at: new Date().toISOString() }; return { info, image };
  }
  async function waitPage(page, timeout = 30000) {
    const end = Date.now() + timeout; let stable = 0, current;
    while (Date.now() < end) {
      current = await frame(); const detected = ui.classifyPage(current.image);
      stable = detected.page === page ? stable + 1 : 0;
      if (stable >= 2) return { ...current, detected };
      await sleep(250);
    }
    throw new Error(`AUTOTEST_PAGE_NOT_PROVEN:${page}`);
  }
  async function captureArchive(game, label, error) {
    const dir = path.join(currentDir, label);
    // Capture before surrender if safe. On human stop use the LAST guarded
    // frame only; never reactivate the game to obtain diagnostic screenshots.
    if (!stopped()) { try { await frame(); } catch (_) {} }
    let guardFailure = error?.guardFailure || null;
    if (!guardFailure) {
      try { guardFailure = json(guardPath + '.failure.json'); }
      catch (_) { guardFailure = { reason: 'GUARD_DIAGNOSTIC_UNREADABLE', inputPermission: false }; }
    }
    const { selected, evidence } = readRollingFrame(rollingFramePath, game, lastFrame);
    snapshot(ENGINE, dir, { gameId: game.id, label, error: error ? String(error.stack || error) : (game.error || game.finishError || null),
      lastFrameCapturedAt: evidence.capturedAt, frameEvidence: evidence, guardFailure,
      stopReason: stopped() ? fs.readFileSync(stopPath, 'utf8') : null });
    if (selected) saveRgbaPng(selected.image, path.join(dir, 'last-guarded-frame.png'));
    if (guardFailure) writeJsonAtomic(path.join(dir, 'guard-failure.json'), guardFailure);
    store.event('ARCHIVE_SAVED', { gameId: game.id, label, path: dir });
  }
  async function runChild(game) {
    const resuming = resumePending; resumePending = false;
    fs.mkdirSync(currentDir, { recursive: true });
    const logFile = path.join(currentDir, 'console.log'); let tail = '', done = false, exitCode = null, spawnError = null;
    const env = { ...process.env, MD_AUTOTEST_RUN: runDir, MD_AUTOTEST_HOOK: HOOK,
      MD_AUTOTEST_FRAME: rollingFramePath, MD_V7_RUN: '1', MD_V7_DUEL_ID: game.duelId,
      ...(resuming ? { MD_V7_RESUME_TICKET: ticketPath } : {}),
      MD_AUTOTEST_EVENTS: path.join(currentDir, 'actions.jsonl'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(HOOK)}`.trim() };
    child = spawn(process.execPath, [path.join(ENGINE, 'runtime/main-v7.js')], {
      cwd: ENGINE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let resumeComplete = !resuming;
    const append = chunk => { const text = String(chunk); fs.appendFileSync(logFile, text); tail = (tail + text).slice(-96000);
      if (tail.includes('AUTOTEST_V7_RESUME_COMPLETE')) resumeComplete = true; process.stdout.write(text); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { spawnError = error; done = true; });
    child.on('close', code => { exitCode = code; done = true; });
    const end = Date.now() + 15 * 60 * 1000;
    try {
      while (!done) {
        if (Date.now() > end) throw new Error(resumeComplete ? 'AUTOTEST_GAME_TIMEOUT_15_MIN' : 'AUTOTEST_RESUME_UNIT_TIMEOUT');
        await safe(); await sleep(100);
      }
    } finally {
      killTree(child); await bridge.command({ cmd: 'guardRelease' }).catch(() => {}); child = null;
    }
    if (spawnError) throw spawnError;
    if (!resumeComplete) throw new Error(`AUTOTEST_RESUME_UNIT_NOT_COMPLETED:exit=${exitCode};${tail.slice(-14000)}`);
    const checkpoint = json(postVictory.CHECKPOINT_PATH);
    if (checkpoint && checkpoint.stage === 'COMPLETE') {
      validateVictorySettlementCheckpoint(game, checkpoint);
      return { outcome: 'WIN', proven: true, gems: checkpoint.gems, proof: checkpoint };
    }
    const allure = json(path.join(ENGINE, 'debug/allure-last-resort/state.json'));
    if ((allure && allure.stage === 'COMPLETE_SURRENDER') || /状态: SURRENDER_COMPLETE/.test(tail)) {
      return { outcome: 'SURRENDER', proven: true, proof: allure || { resultConfirmedInLog: true } };
    }
    const observed = await observeEnd(game);
    if (observed) return observed;
    throw new Error(`AUTOTEST_DUEL_EXECUTOR_FAILED:exit=${exitCode};${tail.slice(-14000)}`);
  }
  async function observeEnd(game) {
    const current = await frame(), detected = ui.classifyPage(current.image);
    if (detected.page === 'VICTORY') return { outcome: 'WIN', proven: true, proof: detected.proof };
    if (detected.page === 'DEFEAT') return { outcome: 'LOSS', proven: true, proof: detected.proof };
    const checkpoint = json(postVictory.CHECKPOINT_PATH);
    if (checkpoint && checkpoint.stage === 'COMPLETE') {
      try {
        validateVictorySettlementCheckpoint(game, checkpoint);
        return { outcome: 'WIN', proven: true, gems: checkpoint.gems, proof: checkpoint };
      } catch (_) { /* A previous game's checkpoint cannot authorize a WIN. */ }
    }
    const outcome = json(path.join(ENGINE, 'debug/duel-outcome-live/latest_result.json'));
    if (isCurrentStrictVictory(game, outcome)) {
      return { outcome: 'WIN', proven: true, proof: outcome };
    }
    return null;
  }
  async function finishBoard(game, result) {
    let gems = result.gems ?? null;
    let rewardStatus = result.proof?.rewardStatus || null;
    let rewardEvidencePath = result.proof?.rewardEvidencePath || null;
    for (let step = 0; step < 6; step++) {
      const current = await frame(), detected = ui.classifyPage(current.image);
      if (detected.page === 'STARTER') {
        await waitPage('STARTER'); return {
          gems: gems ?? (rewardStatus !== 'UNKNOWN' && result.outcome !== 'WIN' ? 0 : null),
          rewardStatus, rewardEvidencePath
        };
      }
      if (result.outcome === 'WIN' && ['VICTORY', 'SETTLEMENT'].includes(detected.page)) {
        // The child may have already confirmed victory, accelerated rewards or
        // committed them. Resume its current-duel transaction, including its
        // settlement ID; never fall through to a fresh reward executor/ID.
        validateVictorySettlementCheckpoint(game, json(postVictory.CHECKPOINT_PATH));
        const final = await postVictory.runPostVictorySettlement({ bridge, resume: true,
          rewardPolicy: 'record-first',
          requestContinue: async () => { await safe(); return true; },
          source: 'AUTOTEST_VICTORY', debugDir: path.join(currentDir, 'victory-settlement') });
        gems = final.result ? final.result.gems : final.checkpoint && final.checkpoint.gems;
        rewardStatus = final.result?.rewardStatus || final.checkpoint?.rewardStatus || null;
        rewardEvidencePath = final.result?.rewardEvidencePath || final.checkpoint?.rewardEvidencePath || null;
        continue;
      }
      if (detected.page === 'DEFEAT') {
        // Existing executor verifies the already-open defeat and skips sending
        // a second surrender. A naturally lost duel is still counted as LOSS.
        await surrender.runConfirmedDeadlockSurrender({ bridge, debugDir: path.join(currentDir, 'defeat-confirm') }); continue;
      }
      if (detected.page === 'SETTLEMENT') {
        const reward = await settlement.runDuelSettlement({ bridge, settlementId: `${path.basename(runDir)}-game-${game.id}`,
          rewardPolicy: 'record-first',
          debugDir: path.join(currentDir, 'settlement'), source: 'AUTOTEST_SETTLEMENT' });
        gems = reward.gems; rewardStatus = reward.rewardStatus; rewardEvidencePath = reward.rewardEvidencePath; continue;
      }
      await sleep(750);
    }
    throw new Error('AUTOTEST_RETURN_TO_STARTER_NOT_PROVEN');
  }
  try {
    // Exactly one explicit activation at user-authorized start. All subsequent
    // engine activation calls are verification-only once the guard is armed.
    await bridge.start();
    await activateAndVerifyMasterDuel(bridge, { requireSelfPriorityBlue: false, allowTaskbarFallback: false });
    await bridge.command({ cmd: 'guardArm' });
    if (!resumeSearch) await waitPage('STARTER');
    fs.mkdirSync(path.join(epochDir, 'controller-source'), { recursive: true });
    for (const name of fs.readdirSync(__dirname).filter(name => /\.(?:js|ps1)$/.test(name))) {
      fs.copyFileSync(path.join(__dirname, name), path.join(epochDir, 'controller-source', name));
    }
    // Preserve any previous isolated run state BEFORE starting a proven new
    // duel. The formal project's debug/decision files are never addressed.
    if (resumeSearch) {
      require('./resume-unit').validateResumeTicket(resumePlan, ENGINE);
      await captureArchive(store.state.games.at(-1), 'before-resume');
      const recoveryArchive = await require('../src/integration/source-archive').archiveRuntimeSource(path.resolve(__dirname, '..'), epochDir);
      if (!recoveryArchive.ok) throw recoveryArchive.error;
      await safe();
      resumedGame = store.resumeInterruptedGame(resumePlan.gameId);
      store.event('RESUME_GUARD_EPOCH_ARMED', { gameId: resumedGame.id, epochDir, previousStopReason: resumePlan.stopReason });
    } else {
      if (fs.existsSync(path.join(ENGINE, 'debug'))) {
        const previousDebug = path.join(runDir, 'previous-isolated-debug');
        fs.renameSync(path.join(ENGINE, 'debug'), previousDebug);
        const pruned = pruneArchivedDebugImages(previousDebug, true);
        store.event('PREVIOUS_DEBUG_IMAGES_PRUNED', pruned);
      }
      if (fs.existsSync(path.join(ENGINE, 'decision-state.json'))) fs.copyFileSync(path.join(ENGINE, 'decision-state.json'), path.join(runDir, 'previous-isolated-decision.json'));
    }
    const maxArg = args.find(arg => arg.startsWith('--max-games='));
    const maxGames = maxArg ? Number(maxArg.split('=')[1]) : 5;
    const adapters = { stopped, archive: captureArchive, observeEnd, finishBoard,
      surrender: async game => {
        await safe();
        // Recheck passive terminal evidence immediately before cleanup: the
        // last draw animation may have completed while the archive was saved.
        const ended = await observeEnd(game);
        if (ended) return ended;
        if (['STARTER', 'SETTLEMENT'].includes(ui.classifyPage(lastFrame.image).page)) {
          throw new Error('AUTOTEST_ERROR_CLEANUP_NOT_IN_DUEL');
        }
        store.event('ERROR_SURRENDER_REQUEST', { gameId: game.id, reason: game.error });
        const proof = await surrender.runConfirmedDeadlockSurrender({ bridge,
          debugDir: path.join(currentDir, 'error-surrender') });
        if (proof.status !== 'SURRENDER_COMPLETE') throw new Error('AUTOTEST_ERROR_SURRENDER_NOT_PROVEN');
        store.event('ERROR_SURRENDER_CONFIRMED', { gameId: game.id, proof });
        return { outcome: 'SURRENDER', proven: true, proof };
      },
      start: async game => {
        currentDir = path.join(runDir, `game-${String(game.id).padStart(5, '0')}`); fs.mkdirSync(currentDir, { recursive: true });
        await waitPage('STARTER'); const current = await frame(), proof = ui.detectStarter(current.image);
        if (!proof.pass) throw new Error('AUTOTEST_START_BUTTON_NOT_PROVEN');
        const info = await safe(), point = mapReferencePoint(info, proof.reference);
        await bridge.click(point.x, point.y); store.event('START_CLICK_CONFIRMED', { gameId: game.id, point });
        // V7 archives immutable source once per content version, not once per game.
        // Continue the existing guarded opening wait during archival.
        if (!engineArchivePromise) {
          const startedAt = Date.now();
          store.event('ENGINE_ARCHIVE_STARTED', { gameId: game.id });
          engineArchivePromise = require('../src/integration/source-archive').archiveRuntimeSource(path.resolve(__dirname, '..'), epochDir)
            .then(result => {
              engineArchiveResult = result;
              store.event(result.ok ? 'ENGINE_ARCHIVE_COMPLETE' : 'ENGINE_ARCHIVE_FAILED', {
                gameId: game.id, elapsedMs: Date.now() - startedAt,
                error: result.ok ? undefined : String(result.error && result.error.stack || result.error)
              });
              return result;
            });
        }
      },
      waitMain1: async game => {
        // Ten-second passive opening wait, continuously checking user stop.
        for (let n = 0; n < 40; n++) { await safe(); await sleep(250); }
        await waitPage('MAIN1', 50000);
        // Normally the copy finishes inside the passive opening wait.  On a
        // slower disk, keep checking the guard instead of awaiting disk IO with
        // no foreground/mouse-interference supervision.
        while (engineArchivePromise && !engineArchiveResult) { await safe(); await sleep(100); }
        const archive = engineArchiveResult;
        if (!archive || !archive.ok) throw archive && archive.error || new Error('AUTOTEST_ENGINE_ARCHIVE_MISSING');
        // Fresh duel is now physically proven. Bootstrap JSON imports must not
        // see the prior isolated duel's decision object before main resets it.
        writeJsonAtomic(path.join(ENGINE, 'decision-state.json'), { graveSpellCount: 0,
          bambooSwordEquipped: false, normalSummonUsed: false, rayeNormalSummoned: false,
          usedCounts: {}, effectUsage: { M19_SEARCH: 0 }, v5Branch: { active: false, currentState: 'IDLE' } });
        game.duelId = 'DUEL-' + require('../src/core/json-store').hashValue({ run: runDir, game: game.id }).slice(0, 24);
        writeJsonAtomic(path.join(ENGINE, 'debug/v7/session.json'), { version: 1, duelId: game.duelId,
          gameId: game.id, startProven: true, mode: 'BOT_TEST', startedAt: game.startedAt });
        store.save(); store.event('MAIN1_PROVEN', { gameId: game.id, duelId: game.duelId });
      },
      play: runChild
    };
    while (!stopped() && (resumedGame || !maxGames || store.state.games.length < maxGames)) {
      const result = await playOne(store, adapters, resumedGame); resumedGame = null;
      if (result.game.duelId && result.game.resultProof) {
        require('../src/core/transaction-journal').createJournal(ENGINE).closeDuel(result.game.duelId,
          { proven: true, outcome: result.game.outcome, gameId: result.game.id });
      }
      console.log(`\n自动测试统计：${JSON.stringify(store.state.totals)}；日志=${runDir}`);
      console.log(`独立测试累计：${JSON.stringify(json(STATISTICS).totals)}`);
      if (result.game.testStoppedForError) {
        console.log('异常已归档，但无法安全确认投降或返回；保留现场停止，不盲点或重开。');
      } else if (result.game.errorSurrender) {
        console.log('执行/识别异常已归档并确认投降；单独标记异常投降，已返回Starter，继续下一局。');
      }
      if (result.stop) break;
      // Exactly one known rolling diagnostic file; completed evidence has
      // already been archived. No historic image directories are addressed.
      if (fs.existsSync(rollingFramePath)) fs.unlinkSync(rollingFramePath);
      // Completed, fully archived duel only: rotate isolated debug to the
      // per-duel archive so no pending modal or reward can leak into next duel.
      const debug = path.join(ENGINE, 'debug');
      if (fs.existsSync(debug)) {
        const archivedDebug = path.join(currentDir, 'runtime-debug');
        fs.renameSync(debug, archivedDebug);
        const pruned = pruneArchivedDebugImages(archivedDebug, Boolean(result.game.error || result.game.finishError));
        store.event('NONESSENTIAL_IMAGES_PRUNED', { gameId: result.game.id, ...pruned });
      }
    }
    store.state.status = stopped() ? 'INTERRUPTED' : 'STOPPED'; store.save();
  } catch (error) {
    killTree(child); child = null;
    const active = store.state.games.at(-1);
    if (active && !active.outcome) {
      if (!active.error) active.error = String(error.stack || error);
      else active.fatalError = String(error.stack || error);
      await captureArchive(active, 'fatal-stop', error);
      store.finish(active, classifyFailure(error, stopped()) === 'STOP_TEST' ? 'INTERRUPTED' : 'UNRESOLVED');
    }
    store.state.status = 'STOPPED'; store.state.stopReason = String(error.stack || error); store.save();
    console.error(`自动测试已停止，不重开：${error.stack || error}`);
    process.exitCode = 1;
  } finally {
    await bridge.command({ cmd: 'guardRelease' }).catch(() => {}); await bridge.stop().catch(() => {});
    if (fs.existsSync(LOCK) && json(LOCK).pid === process.pid) fs.unlinkSync(LOCK);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    console.log(`最终统计：${JSON.stringify(store.state.totals)}\n记录目录：${runDir}`);
  }
}
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { requireInside, killTree, copyTreeAsync, validateVictorySettlementCheckpoint, isCurrentStrictVictory, run };
