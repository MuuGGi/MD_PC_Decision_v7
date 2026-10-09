'use strict';
const fs = require('fs'), path = require('path');
const { sha } = require('./store');
const { readOwnedJson, hashValue, insidePath } = require('../src/core/json-store');
const { createJournal } = require('../src/core/transaction-journal');
const STATE_FILES = ['decision-state.json', 'debug/hand-change-live/session_state.json', 'debug/main-deck-ledger/state.json',
  'debug/duel-log-live/latest_result.json', 'debug/v7/session.json'];
function prepareResume(latest, runs, engine) {
  const fail = reason => { throw new Error('AUTOTEST_RESUME_UNIT:' + reason); };
  if (!latest) fail('LATEST_MISSING');
  try { process.kill(latest.pid, 0); fail('PREVIOUS_PROCESS_ALIVE'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  const runDir = insidePath(runs, latest.runDir), summary = readOwnedJson(path.join(runDir, 'summary.json')), game = summary?.games?.at(-1);
  const reason = fs.readFileSync(latest.stopPath, 'utf8').trim();
  if (!/^(USER_STOP|MOUSE_INTERFERENCE|FOREGROUND_LOST)$/.test(reason) || !game || game.outcome !== 'INTERRUPTED' || game.duelStarted !== true) fail('NOT_HUMAN_INTERRUPTED_DUEL');
  const gameDir = path.join(runDir, 'game-' + String(game.id).padStart(5, '0'));
  const saved = path.join(gameDir, 'before-recovery'), stateHashes = {};
  for (const rel of STATE_FILES) {
    const file = insidePath(engine, path.join(engine, rel));
    if (!fs.existsSync(file)) fail('STATE_MISSING:' + rel);
    if (rel !== 'debug/v7/session.json' && (!fs.existsSync(path.join(saved, rel)) || sha(file) !== sha(path.join(saved, rel)))) fail('STATE_CHANGED:' + rel);
    stateHashes[rel] = sha(file);
  }
  const session = readOwnedJson(path.join(engine, 'debug/v7/session.json'));
  if (session.duelId !== game.duelId || session.startProven !== true) fail('DUEL_ID_CHANGED');
  const active = createJournal(engine).listActive(game.duelId);
  if (active.length !== 1) fail('ACTIVE_TRANSACTION_NOT_UNIQUE');
  const transaction = active[0], actionsFile = path.join(gameDir, 'actions.jsonl');
  const proof = require('../src/integration/submitted-equipment-recovery').inspectSubmittedEquipment(engine, transaction, actionsFile);
  return { version: 1, kind: 'SUBMITTED_EQUIPMENT', runDir, gameDir, gameId: game.id, duelId: game.duelId,
    transactionId: transaction.id, actionType: transaction.actionType, intent: transaction.intent,
    actionsFile, stateHashes, expectedHwnd: transaction.steps[0].guardEvidence.hwnd,
    equipmentProofHash: hashValue(proof), stopReason: reason };
}
function validateResumeTicket(ticket, engine) {
  if (!ticket || ticket.kind !== 'SUBMITTED_EQUIPMENT') throw new Error('AUTOTEST_RESUME_TICKET_INVALID');
  for (const [rel, hash] of Object.entries(ticket.stateHashes)) if (sha(insidePath(engine, path.join(engine, rel))) !== hash)
    throw new Error('AUTOTEST_RESUME_TICKET_STATE_CHANGED:' + rel);
  return ticket;
}
module.exports = { prepareResume, validateResumeTicket };
