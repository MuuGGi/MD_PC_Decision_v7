'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ContractError } = require('./errors');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v) ?? 'null').join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
function hashValue(value) {
  const encoded = stableStringify(value);
  if (encoded === undefined) throw new ContractError('JSON_VALUE_UNDEFINED');
  return crypto.createHash('sha256').update(encoded).digest('hex');
}
function readJsonStrict(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readJsonFact(file, options = {}) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { status: 'UNKNOWN', reason: 'NOT_REGULAR_FILE', path: file, data: null };
    const data = readJsonStrict(file), ageMs = Date.now() - st.mtimeMs;
    if (Number.isFinite(options.maxAgeMs) && ageMs > options.maxAgeMs)
      return { status: 'UNKNOWN', reason: 'STALE', path: file, mtimeMs: st.mtimeMs, ageMs, data: null };
    return { status: 'KNOWN', path: file, mtimeMs: st.mtimeMs, size: st.size, data, hash: hashValue(data) };
  } catch (error) {
    return { status: 'UNKNOWN', reason: error.code === 'ENOENT' ? 'MISSING' : 'READ_OR_PARSE_FAILED',
      path: file, error: String(error.message || error), data: null };
  }
}
function readOwnedJson(file) {
  const fact = readJsonFact(file);
  if (fact.status === 'KNOWN') return fact.data;
  if (fact.reason === 'MISSING') return null;
  throw new ContractError('PERSISTED_STATE_UNREADABLE', undefined, fact);
}
function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))
    throw new ContractError('PERSISTED_ID_INVALID', undefined, { id });
  return id;
}
function insidePath(root, file) {
  const absolute = path.resolve(file), rel = path.relative(path.resolve(root), absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ContractError('STATE_PATH_OUTSIDE_ROOT', undefined, { file });
  let parent = absolute;
  while (parent !== path.resolve(root)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new ContractError('STATE_LINK_FORBIDDEN', undefined, { parent });
    parent = path.dirname(parent);
  }
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new ContractError('STATE_ROOT_LINK_FORBIDDEN');
  return absolute;
}
function atomicWriteJson(file, value) {
  hashValue(value);
  ensureDir(path.dirname(file));
  const temporary = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
module.exports = { ensureDir, stableStringify, hashValue, readJsonStrict, readJsonFact, readOwnedJson,
  atomicWriteJson, clone, safeId, insidePath };
