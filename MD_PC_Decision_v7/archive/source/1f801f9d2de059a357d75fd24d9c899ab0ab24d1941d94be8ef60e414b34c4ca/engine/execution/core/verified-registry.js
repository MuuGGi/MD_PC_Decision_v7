'use strict';

const fs = require('fs');
const path = require('path');
const {
  VERIFIED_STATUS_PATH: STATUS_PATH,
  ensureDir,
  promoteVerifiedEvidence
} = require('../../lib/project-storage');
const { writeJsonAtomic } = require('../../lib/runtime-files');

function emptyState() {
  return { version: 1, cards: {}, branches: {} };
}

function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return emptyState();
  if (!parsed.cards || typeof parsed.cards !== 'object') parsed.cards = {};
  if (!parsed.branches || typeof parsed.branches !== 'object') parsed.branches = {};
  if (!parsed.version) parsed.version = 1;
  return parsed;
}

function writeStatus(state) {
  ensureDir(path.dirname(STATUS_PATH));
  writeJsonAtomic(STATUS_PATH, state, { trailingNewline: true });
}

function markExecutionPass(options) {
  const { id, name, testEntry, evidenceDir, scope } = options || {};
  if (!id || !name) throw new Error('EXEC_VERIFIED_STATUS_CARD_REQUIRED');

  const state = readStatus();
  const durableEvidence = promoteVerifiedEvidence(evidenceDir, id);
  state.cards[id] = {
    name,
    status: 'PASS_LIVE',
    verifiedAt: new Date().toISOString(),
    testEntry: testEntry || null,
    evidenceDir: durableEvidence,
    scope: scope || null
  };
  writeStatus(state);
  console.log(`工程执行状态已标记: ${name}[${id}] = PASS_LIVE`);
  return state.cards[id];
}

function markExecutionBranchPass(options) {
  const { id, name, branch, testEntry, evidenceDir, scope } = options || {};
  if (!id || !name || !branch) throw new Error('EXEC_VERIFIED_BRANCH_CARD_REQUIRED');

  const state = readStatus();
  const key = `${id}:${branch}`;
  const durableEvidence = promoteVerifiedEvidence(evidenceDir, key);
  state.branches[key] = {
    id,
    name,
    branch,
    status: 'PASS_LIVE',
    verifiedAt: new Date().toISOString(),
    testEntry: testEntry || null,
    evidenceDir: durableEvidence,
    scope: scope || null
  };
  writeStatus(state);
  console.log(`工程执行分支已标记: ${name}[${id}] / ${branch} = PASS_LIVE`);
  return state.branches[key];
}

function markExecutionCardSealed(options) {
  const {
    id,
    name,
    requiredBranches,
    testEntry,
    evidenceDir,
    scope
  } = options || {};
  if (!id || !name || !Array.isArray(requiredBranches) || !requiredBranches.length) {
    throw new Error('EXEC_SEAL_BRANCHES_REQUIRED');
  }

  const state = readStatus();
  const missing = requiredBranches.filter(branch => {
    const item = state.branches[`${id}:${branch}`];
    return !item || item.status !== 'PASS_LIVE';
  });
  if (missing.length) {
    console.log(`工程整卡暂不封板: ${name}[${id}]；待验证分支=${missing.join(',')}`);
    return null;
  }

  const durableEvidence = promoteVerifiedEvidence(evidenceDir, `${id}:sealed`);
  state.cards[id] = {
    name,
    status: 'PASS_LIVE',
    sealed: true,
    verifiedAt: new Date().toISOString(),
    verifiedBranches: requiredBranches.slice(),
    testEntry: testEntry || null,
    evidenceDir: durableEvidence,
    scope: scope || null
  };
  writeStatus(state);
  console.log(
    `工程执行整卡已封板: ${name}[${id}] = PASS_LIVE / SEALED；` +
    `分支=${requiredBranches.join(' + ')}`
  );
  return state.cards[id];
}

module.exports = {
  STATUS_PATH,
  readStatus,
  writeStatus,
  markExecutionPass,
  markExecutionBranchPass,
  markExecutionCardSealed
};
