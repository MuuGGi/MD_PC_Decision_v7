'use strict';
const fs = require('fs');
const path = require('path');
const { readOwnedJson, atomicWriteJson, hashValue, clone, safeId, insidePath } = require('./json-store');
const { withFileLockSync } = require('./file-lock');
const { CommitConflictError, ContractError } = require('./errors');
function createCommitCoordinator(root) {
  const directory = path.join(root, 'debug/v7/commits');
  const planPath = id => insidePath(root, path.join(directory, safeId(id) + '.json'));
  const target = file => insidePath(root, file);
  function readTarget(file, allowMissing = false) {
    const value = readOwnedJson(target(file));
    if (value === null && !fs.existsSync(file)) {
      if (!allowMissing) throw new ContractError('COMMIT_TARGET_MISSING_NOT_AUTHORIZED', undefined, { file });
      return { hash: 'MISSING', value: null };
    }
    return { hash: hashValue(value), value };
  }
  function validate(plan) {
    if (!plan || plan.version !== 2 || !['PLANNED', 'COMMITTED'].includes(plan.status) ||
        !Array.isArray(plan.operations) || !plan.operations.length) throw new ContractError('COMMIT_PLAN_SCHEMA_INVALID');
    safeId(plan.commitId);
    const seen = new Set(), targets = new Set();
    for (const op of plan.operations) {
      if (!op.operationKey || seen.has(op.operationKey) || targets.has(target(op.targetPath)) ||
          !['PLANNED', 'APPLIED'].includes(op.status) || hashValue(op.afterValue) !== op.afterHash)
        throw new ContractError('COMMIT_OPERATION_SCHEMA_INVALID');
      seen.add(op.operationKey); targets.add(op.targetPath);
    }
    return plan;
  }
  function load(id) { const plan = readOwnedJson(planPath(id)); return plan ? validate(plan) : null; }
  function save(plan) { validate(plan); atomicWriteJson(planPath(plan.commitId), plan); }
  function prepare({ commitId, operations }) {
    if (!commitId || !Array.isArray(operations) || !operations.length) throw new ContractError('COMMIT_PLAN_INVALID');
    return withFileLockSync(path.join(directory, 'commit.lock'), () => {
      const existing = load(commitId);
      if (existing) {
        const basis = operations.map(op => ({ operationKey: op.operationKey, targetPath: target(op.targetPath) }));
        const saved = existing.operations.map(op => ({ operationKey: op.operationKey, targetPath: op.targetPath }));
        if (hashValue(basis) !== hashValue(saved)) throw new ContractError('COMMIT_ID_REUSED_WITH_DIFFERENT_OPERATIONS');
        return existing;
      }
      const planned = operations.map((op, index) => {
        if (!op.operationKey || !op.targetPath || typeof op.transform !== 'function') throw new ContractError('COMMIT_OPERATION_INVALID', undefined, { index });
        const file = target(op.targetPath), before = readTarget(file, op.allowCreate === true), after = op.transform(clone(before.value));
        return { operationKey: op.operationKey, targetPath: file, allowCreate: op.allowCreate === true,
          beforeHash: before.hash, afterHash: hashValue(after), afterValue: after, status: 'PLANNED' };
      });
      const plan = { version: 2, commitId, status: 'PLANNED', createdAt: new Date().toISOString(), operations: planned };
      save(plan); return plan;
    });
  }
  function apply(commitId, options = {}) {
    return withFileLockSync(path.join(directory, 'commit.lock'), () => {
      const plan = load(commitId);
      if (!plan) throw new ContractError('COMMIT_PLAN_NOT_FOUND');
      if (plan.status === 'COMMITTED') return plan;
      for (let i = 0; i < plan.operations.length; i++) {
        const op = plan.operations[i];
        if (op.status === 'APPLIED') continue;
        const current = readTarget(op.targetPath, op.allowCreate);
        if (current.hash !== op.beforeHash && current.hash !== op.afterHash)
          throw new CommitConflictError('COMMIT_TARGET_CONFLICT', undefined, { operationKey: op.operationKey, actual: current.hash });
        if (current.hash !== op.afterHash) {
          if (options.crashHook) options.crashHook('BEFORE_TARGET_WRITE', op, i);
          atomicWriteJson(op.targetPath, op.afterValue);
          if (options.crashHook) options.crashHook('AFTER_TARGET_WRITE_BEFORE_JOURNAL', op, i);
        } else op.recoveredAfterWrite = true;
        op.status = 'APPLIED'; op.appliedAt = new Date().toISOString(); save(plan);
        if (options.crashHook) options.crashHook('AFTER_OPERATION_JOURNAL', op, i);
      }
      plan.status = 'COMMITTED'; plan.committedAt = new Date().toISOString(); save(plan);
      return plan;
    });
  }
  function hasIncomplete() {
    if (!fs.existsSync(directory)) return false;
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    return files.map(name => validate(readOwnedJson(insidePath(root, path.join(directory, name))))).some(plan => plan.status !== 'COMMITTED');
  }
  return { prepare, load, apply, hasIncomplete };
}
module.exports = { createCommitCoordinator };
