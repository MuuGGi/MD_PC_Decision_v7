'use strict';
const fs = require('fs');
const path = require('path');
const { sha } = require('./store');
const STATE_FILES = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json'];
function fail(reason) { throw new Error(`AUTOTEST_RESUME_M17:${reason}`); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function prepareResume(latest, runs, engine, isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}) {
  if (!latest) fail('NO_LAST_RUN');
  const runDir = path.resolve(latest.runDir), rel = path.relative(runs, runDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('RUN_OUTSIDE_ISOLATION');
  if (isAlive(latest.pid)) fail('PREVIOUS_PROCESS_ALIVE');
  // Only the original human-stop epoch is eligible. A failed recovery needs
  // its own stage-aware diagnosis; repeating this command must never replay.
  if (path.resolve(latest.stopPath) !== path.join(runDir, 'STOP')) fail('ALREADY_RESUMED_EPOCH');
  const reason = fs.readFileSync(latest.stopPath, 'utf8').trim();
  if (!/^(MOUSE_INTERFERENCE|FOREGROUND_LOST|USER_STOP)$/.test(reason)) fail('NOT_HUMAN_STOP');
  const summary = read(path.join(runDir, 'summary.json')), game = summary.games.at(-1);
  if (!game || game.outcome !== 'INTERRUPTED' || game.duelStarted !== true) fail('GAME_NOT_INTERRUPTED');
  const gameDir = path.join(runDir, `game-${String(game.id).padStart(5, '0')}`);
  const archive = path.join(gameDir, 'before-recovery'), stateHashes = {};
  for (const name of STATE_FILES) {
    const current = path.join(engine, name), saved = path.join(archive, name);
    if (!fs.existsSync(current) || !fs.existsSync(saved) || sha(current) !== sha(saved)) fail(`STATE_CHANGED:${name}`);
    stateHashes[name] = sha(current);
  }
  const baseline = read(path.join(engine, 'debug/hand-change-live/session_state.json'));
  if (!Array.isArray(baseline.cards) || baseline.cards.length !== baseline.handCount ||
      !baseline.cards.some(c => c.id === 'M17')) fail('NO_PENDING_M17_BASELINE');
  const runtime = read(path.join(engine, 'decision-state.json'));
  if (Number(runtime.graveSpellCount) < 3 || runtime.v5Branch?.active === true) fail('NOT_BONUS_HAND_BRANCH');
  const root = path.join(engine, 'debug/execution/M17_engage_bonus_draw');
  const names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  const sourceAttempt = path.join(root, names.at(-1) || 'missing');
  if (fs.existsSync(path.join(sourceAttempt, 'execution_click.json')) || fs.existsSync(path.join(sourceAttempt, 'result.json')) ||
      !fs.existsSync(path.join(sourceAttempt, 'm17_search_dialog_signature.png'))) fail('LATEST_ATTEMPT_NOT_OPEN_SEARCH');
  const sourceHashes = {};
  for (const name of ['m17_search_candidates_latest.png', 'm17_search_dialog_signature.png']) {
    const file = path.join(sourceAttempt, name);
    if (!fs.existsSync(file)) fail(`SOURCE_PROOF_MISSING:${name}`);
    sourceHashes[name] = sha(file);
  }
  const actions = fs.readFileSync(path.join(gameDir, 'actions.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const inputs = actions.filter(e => /^INPUT_(REQUEST|COMPLETE)$/.test(e.type));
  const last = inputs.at(-1), requested = inputs.at(-2);
  const attemptTime = Date.parse(path.basename(sourceAttempt).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z$/, 'T$1:$2:$3.$4Z'));
  if (!last || last.type !== 'INPUT_COMPLETE' || requested?.type !== 'INPUT_REQUEST' ||
      JSON.stringify(last.command) !== JSON.stringify(requested.command) ||
      last.command.cmd !== 'click' || last.command.y !== 903 || last.command.x < 750 || last.command.x > 1300 ||
      !Number.isFinite(attemptTime) || !Number.isFinite(Date.parse(last.at)) || Date.parse(last.at) < attemptTime) {
    fail('LAST_ACTION_NOT_CANDIDATE_CLICK');
  }
  if (last.pid && isAlive(last.pid)) fail('PREVIOUS_EXECUTOR_ALIVE');
  const lock = path.join(engine, 'debug/m17-search-resume/state.json');
  if (fs.existsSync(lock)) fail('RECOVERY_CHECKPOINT_ALREADY_EXISTS');
  return { runDir, gameId: game.id, gameDir, sourceAttempt, sourceHashes, baseline, stateHashes, stopReason: reason };
}
function validateResumeTicket(ticket, engine) {
  if (!ticket || !ticket.baseline || !ticket.stateHashes || !ticket.sourceAttempt || !ticket.sourceHashes) fail('TICKET_MISSING');
  for (const name of STATE_FILES) if (sha(path.join(engine, name)) !== ticket.stateHashes[name]) fail(`TICKET_STATE_CHANGED:${name}`);
  for (const [name, hash] of Object.entries(ticket.sourceHashes)) if (sha(path.join(ticket.sourceAttempt, name)) !== hash) fail('SOURCE_PROOF_CHANGED');
  if (fs.existsSync(path.join(ticket.sourceAttempt, 'execution_click.json'))) fail('SOURCE_ALREADY_SUBMITTED');
  return ticket.baseline;
}
module.exports = { prepareResume, validateResumeTicket, STATE_FILES };
