'use strict';
const path = require('path');
const fs = require('fs');
const { readOwnedJson, atomicWriteJson, safeId, insidePath, clone } = require('./json-store');
const { ContractError } = require('./errors');
const { withFileLockSync } = require('./file-lock');
function buildConfirmedVictoryProof(session, outcome, nowMs = Date.now()) {
  const start = Date.parse(session?.startedAt), at = Date.parse(outcome?.checkedAt);
  if (session?.startProven !== true || !session.duelId || !Number.isFinite(start) ||
      !Number.isFinite(at) || at < start || at > nowMs ||
      (outcome?.duelId && outcome.duelId !== session.duelId) ||
      outcome?.terminal !== true || outcome.type !== 'VICTORY' ||
      outcome.strictEvidence?.matched !== true ||
      outcome.strictEvidence?.reasonText?.matched !== true ||
      outcome.strictEvidence?.exodiaLastFive?.matched !== true)
    throw new ContractError('DUEL_CURRENT_STRICT_VICTORY_REQUIRED');
  safeId(session.duelId);
  return { proven: true, type: 'VICTORY', duelId: session.duelId,
    source: 'V7_STRICT_CURRENT_DUEL_VICTORY', sessionStartedAt: session.startedAt,
    checkedAt: outcome.checkedAt, outcome: clone(outcome),
    ordinarySettlementDisposition: 'VOID_AFTER_CONFIRMED_VICTORY',
    countsAsExecutionPass: false, canCommitHandDelta: false };
}
function journalDir(root) { return path.join(root, 'debug/v7/transactions'); }
function file(root, folder, id) { return insidePath(root, path.join(journalDir(root), folder, safeId(id) + '.json')); }
function validate(tx) {
  if (!tx || typeof tx !== 'object' || !tx.id || !tx.duelId || !tx.actionType || !tx.instanceKey ||
      !Array.isArray(tx.steps) || !tx.steps.length || !['ACTIVE', 'COMMITTED', 'ABANDONED'].includes(tx.status))
    throw new ContractError('TRANSACTION_JOURNAL_SCHEMA_INVALID');
  safeId(tx.id); safeId(tx.duelId);
  return tx;
}
function readFolder(root, folder) {
  const directory = path.join(journalDir(root), folder);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name =>
    validate(readOwnedJson(insidePath(root, path.join(directory, name)))));
}
function createJournal(root) {
  return {
    lockPath: path.join(journalDir(root), 'execution.lock'),
    load(id) { const tx = readOwnedJson(file(root, 'active', id)); return tx ? validate(tx) : null; },
    save(tx) { validate(tx); atomicWriteJson(file(root, 'active', tx.id), tx); return tx; },
    archive(tx) {
      validate(tx);
      if (!['COMMITTED', 'ABANDONED'].includes(tx.status)) throw new ContractError('UNFINISHED_TRANSACTION_CANNOT_ARCHIVE');
      atomicWriteJson(file(root, 'archive', tx.id), tx);
      const source = file(root, 'active', tx.id);
      if (fs.existsSync(source)) fs.unlinkSync(source);
    },
    listActive(duelId) { return readFolder(root, 'active').filter(tx => tx.duelId === duelId && tx.status === 'ACTIVE'); },
    listAllActive() { return readFolder(root, 'active').filter(tx => tx.status === 'ACTIVE'); },
    closedProof(duelId) { return readOwnedJson(file(root, 'closed', duelId)); },
    findActiveByInstanceKey(key) { return readFolder(root, 'active').find(tx => tx.instanceKey === key) || null; },
    findArchivedByInstanceKey(key) { return readFolder(root, 'archive').find(tx => tx.instanceKey === key) || null; },
    nextSequence(duelId) {
      safeId(duelId);
      const records = [...readFolder(root, 'active'), ...readFolder(root, 'archive')].filter(tx => tx.duelId === duelId);
      return records.reduce((max, tx) => Math.max(max, Number((/-T(\d+)$/.exec(tx.id) || [])[1]) || 0), 0) + 1;
    },
    closeDuel(duelId, terminalProof) {
      if (!terminalProof || terminalProof.proven !== true) throw new ContractError('DUEL_TERMINAL_PROOF_REQUIRED');
      safeId(duelId);
      if (terminalProof.duelId && terminalProof.duelId !== duelId)
        throw new ContractError('DUEL_TERMINAL_PROOF_ID_MISMATCH');
      if (terminalProof.type === 'VICTORY') {
        const checked = buildConfirmedVictoryProof(
          { duelId, startProven: true, startedAt: terminalProof.sessionStartedAt }, terminalProof.outcome);
        if (terminalProof.checkedAt !== checked.checkedAt || terminalProof.countsAsExecutionPass !== false ||
            terminalProof.canCommitHandDelta !== false)
          throw new ContractError('DUEL_TERMINAL_PROOF_DISPOSITION_INVALID');
      }
      return withFileLockSync(this.lockPath, () => {
        const pending = readFolder(root, 'active').filter(tx => tx.duelId === duelId);
        // Validate ALL current transactions before writing a close marker.
        if (terminalProof.type === 'VICTORY') for (const tx of pending) {
          const latest = Math.max(Date.parse(tx.createdAt), ...tx.steps.map(step =>
            step.noReplayAt ? Date.parse(step.noReplayAt) : Date.parse(tx.createdAt)));
          if (!Number.isFinite(latest) || Date.parse(terminalProof.checkedAt) < latest)
            throw new ContractError('DUEL_TERMINAL_PROOF_PREDATES_TRANSACTION');
        }
        // Persist the terminal boundary FIRST: a crash during archive must not
        // allow another ordinary action or replay against a changed baseline.
        const marker = this.closedProof(duelId) || { version: 1, duelId,
          terminalProof: clone(terminalProof), closedAt: new Date().toISOString() };
        atomicWriteJson(file(root, 'closed', duelId), marker);
        for (const tx of pending) {
          tx.status = tx.status === 'COMMITTED' ? 'COMMITTED' : 'ABANDONED';
          tx.terminalProof = clone(marker.terminalProof); tx.closedAt = marker.closedAt;
          this.archive(tx);
        }
        return marker;
      });
    }
  };
}
module.exports = { createJournal, buildConfirmedVictoryProof };
