'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, readOwnedJson } = require('./json-store');
const { ContractError } = require('./errors');
function acquire(file) {
  ensureDir(path.dirname(file));
  const nonce = crypto.randomBytes(12).toString('hex');
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = readOwnedJson(file);
    if (!old || !Number.isInteger(old.pid) || old.pid <= 0) throw new ContractError('V7_LOCK_UNREADABLE');
    try { process.kill(old.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw new ContractError('V7_LOCK_OWNER_UNKNOWN');
      fs.renameSync(file, file + '.stale.' + crypto.randomBytes(6).toString('hex'));
      return acquire(file);
    }
    throw new ContractError('V7_TRANSACTION_BUSY', undefined, { pid: old.pid });
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return () => {
    const current = readOwnedJson(file);
    if (!current || current.nonce !== nonce) throw new ContractError('V7_LOCK_OWNERSHIP_CHANGED');
    fs.unlinkSync(file);
  };
}
async function withFileLock(file, fn) { const release = acquire(file); try { return await fn(); } finally { release(); } }
function withFileLockSync(file, fn) { const release = acquire(file); try { return fn(); } finally { release(); } }
module.exports = { withFileLock, withFileLockSync };
