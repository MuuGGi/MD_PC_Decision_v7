'use strict';
const path = require('path');
const fs = require('fs');
const { readOwnedJson, atomicWriteJson, safeId, insidePath } = require('./json-store');
const { ContractError } = require('./errors');
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
    findActiveByInstanceKey(key) { return readFolder(root, 'active').find(tx => tx.instanceKey === key) || null; },
    findArchivedByInstanceKey(key) { return readFolder(root, 'archive').find(tx => tx.instanceKey === key) || null; },
    nextSequence(duelId) {
      safeId(duelId);
      const records = [...readFolder(root, 'active'), ...readFolder(root, 'archive')].filter(tx => tx.duelId === duelId);
      return records.reduce((max, tx) => Math.max(max, Number((/-T(\d+)$/.exec(tx.id) || [])[1]) || 0), 0) + 1;
    },
    closeDuel(duelId, terminalProof) {
      if (!terminalProof || terminalProof.proven !== true) throw new ContractError('DUEL_TERMINAL_PROOF_REQUIRED');
      for (const tx of readFolder(root, 'active').filter(tx => tx.duelId === duelId)) {
        tx.status = tx.status === 'COMMITTED' ? 'COMMITTED' : 'ABANDONED';
        tx.terminalProof = terminalProof; tx.closedAt = new Date().toISOString();
        this.archive(tx);
      }
    }
  };
}
module.exports = { createJournal };
