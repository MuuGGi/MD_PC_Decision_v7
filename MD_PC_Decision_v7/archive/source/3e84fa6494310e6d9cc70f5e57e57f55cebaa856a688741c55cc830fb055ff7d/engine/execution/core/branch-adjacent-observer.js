'use strict';

const fs = require('fs');
const path = require('path');
const {
  readJsonIfExistsSafe: readJsonIfExists,
  readBufferIfExists: readBytesIfExists,
  restoreBuffer: restoreBytes,
  writeJsonAtomic
} = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DUEL_LOG_FILE = path.join(ROOT, 'runtime/observer/test-duel-log-live.js');
const HAND_OBSERVER_FILE = path.join(ROOT, 'runtime/observer/observe-hand-change-incremental-live.js');
const OBSERVER_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const COMPOSITE_STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const COMPOSITE_RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

const { runDuelLogLive } = require(DUEL_LOG_FILE);
const { runIncrementalHandChange } = require(HAND_OBSERVER_FILE);
const { sleep } = require(path.join(ROOT, 'lib', 'win-fast'));



function compactDetail(detail) {
  if (!detail) return null;
  const card = detail.card || {};
  return {
    role: String(detail.role || detail.rawType || detail.type || ''),
    rawType: String(detail.rawType || detail.type || detail.role || ''),
    side: String(detail.side || ''),
    cardId: String(card.id || ''),
    cardName: String(card.name || '')
  };
}

function compactBlock(block) {
  if (!block) return null;
  return {
    activationKey: String(block.activationKey || ''),
    signature: block.signature || null,
    details: Array.isArray(block.details) ? block.details.map(compactDetail).filter(Boolean) : []
  };
}

function compactObserverState(state) {
  if (!state) return null;
  return {
    version: state.version || null,
    capturedAt: state.capturedAt || null,
    checkpoint: state.checkpoint || null,
    tailBlocks: Array.isArray(state.tailBlocks) ? state.tailBlocks : [],
    baseline: state.baseline || null,
    rebaselineReason: state.rebaselineReason || null
  };
}

function currentCheckpointKey(state) {
  return String(state && state.checkpoint && state.checkpoint.activationKey || 'EMPTY');
}

function tailKeys(state) {
  return (Array.isArray(state && state.tailBlocks) ? state.tailBlocks : [])
    .map(block => String(block && block.activationKey || ''))
    .filter(Boolean);
}

function resultBlocks(result, which) {
  if (which === 'extended') {
    return Array.isArray(result && result.extendedOperationBlocks)
      ? result.extendedOperationBlocks
      : [];
  }
  return Array.isArray(result && result.newOperationBlocks)
    ? result.newOperationBlocks
    : Array.isArray(result && result.newActivationBlocks)
      ? result.newActivationBlocks
      : [];
}

function findExpectedBlock(result, activationKey, mode) {
  const key = String(activationKey || '');
  const fresh = resultBlocks(result, 'new');
  const extended = resultBlocks(result, 'extended');
  const inNew = fresh.find(block => String(block && block.activationKey || '') === key) || null;
  const inExtended = extended.find(block => String(block && block.activationKey || '') === key) || null;

  if (mode === 'new') return { block: inNew, source: inNew ? 'NEW_BLOCK' : null };
  if (mode === 'extended') return { block: inExtended, source: inExtended ? 'EXTENDED_BLOCK' : null };
  if (inNew) return { block: inNew, source: 'NEW_BLOCK' };
  if (inExtended) return { block: inExtended, source: 'EXTENDED_BLOCK' };
  return { block: null, source: null };
}

function detailMatches(block, requirement) {
  const cardId = String(requirement && requirement.cardId || '');
  const roleIncludes = String(requirement && requirement.roleIncludes || '').toUpperCase();
  const details = Array.isArray(block && block.details) ? block.details : [];
  return details.some(detail => {
    if (!detail) return false;
    const card = detail.card || {};
    const id = String(card.id || '');
    const semanticRoles = [detail.rawType, detail.type, detail.role]
      .map(value => String(value || '').toUpperCase())
      .filter(Boolean);
    if (cardId && id !== cardId) return false;
    // One visible result may be rendered as raw RETURN_TO_HAND while the mature
    // parser normalizes its semantic role to HAND_GAIN_CANDIDATE.  Match the
    // requirement against every representation instead of discarding the
    // normalized semantic role just because rawType is present.
    if (roleIncludes && !semanticRoles.some(role => role.includes(roleIncludes))) return false;
    return true;
  });
}

function findUniqueBlockByRequiredDetails(result, mode, requiredDetails) {
  if (!Array.isArray(requiredDetails) || requiredDetails.length === 0) {
    return { block: null, source: null, candidates: 0 };
  }
  const pools = [];
  if (mode !== 'extended') pools.push({ source: 'NEW_BLOCK_BY_DETAILS', blocks: resultBlocks(result, 'new') });
  if (mode !== 'new') pools.push({ source: 'EXTENDED_BLOCK_BY_DETAILS', blocks: resultBlocks(result, 'extended') });
  const matches = [];
  for (const pool of pools) {
    for (const block of pool.blocks) {
      if (requiredDetails.every(requirement => detailMatches(block, requirement))) {
        matches.push({ block, source: pool.source });
      }
    }
  }
  if (matches.length === 1) return { ...matches[0], candidates: 1 };
  return { block: null, source: null, candidates: matches.length };
}

function assertNoHistoricalBacktrack(result, label) {
  const scroll = result && result.scrollBacktracking || {};
  const upwardSteps = Number(scroll.upwardSteps || 0);
  if (upwardSteps !== 0 || scroll.performed === true) {
    throw new Error(`${label}_HISTORICAL_BACKTRACK_FORBIDDEN:upwardSteps=${upwardSteps}`);
  }
}

function buildProof(label, beforeState, afterState, result, match, extra = {}) {
  return {
    mode: 'ADJACENT_BOTTOM_ONLY',
    label,
    capturedAt: new Date().toISOString(),
    previousCheckpoint: currentCheckpointKey(beforeState),
    currentCheckpoint: currentCheckpointKey(afterState),
    previousTail: tailKeys(beforeState),
    currentTail: tailKeys(afterState),
    continuity: result && result.continuity || null,
    matchedAnchor: result && result.matchedContinuityAnchor || null,
    newOperationKeys: resultBlocks(result, 'new').map(block => String(block && block.activationKey || '')).filter(Boolean),
    extendedOperationKeys: resultBlocks(result, 'extended').map(block => String(block && block.activationKey || '')).filter(Boolean),
    acceptedBlockSource: match && match.source || null,
    acceptedBlock: compactBlock(match && match.block),
    upwardBacktrackSteps: Number(result && result.scrollBacktracking && result.scrollBacktracking.upwardSteps || 0),
    backtrackAllowed: false,
    observerState: compactObserverState(afterState),
    ...extra
  };
}

function captureCarryForwardProof(label, reason) {
  const state = readJsonIfExists(OBSERVER_STATE_PATH);
  if (!state) throw new Error(`${label}_OBSERVER_STATE_MISSING_FOR_CARRY_FORWARD`);
  return {
    mode: 'CARRY_FORWARD_NO_LOG_CHANGE',
    label,
    reason,
    capturedAt: new Date().toISOString(),
    previousCheckpoint: currentCheckpointKey(state),
    currentCheckpoint: currentCheckpointKey(state),
    previousTail: tailKeys(state),
    currentTail: tailKeys(state),
    continuity: 'NO_LOG_CHANGE_EXPECTED',
    matchedAnchor: null,
    newOperationKeys: [],
    extendedOperationKeys: [],
    upwardBacktrackSteps: 0,
    backtrackAllowed: false,
    observerState: compactObserverState(state)
  };
}

function captureBaselineProof(label) {
  const state = readJsonIfExists(OBSERVER_STATE_PATH);
  const result = readJsonIfExists(LOG_RESULT_PATH);
  if (!state) throw new Error(`${label}_BASELINE_OBSERVER_STATE_MISSING`);
  assertNoHistoricalBacktrack(result, label);
  return {
    mode: 'CURRENT_BOTTOM_BASELINE',
    label,
    capturedAt: new Date().toISOString(),
    previousCheckpoint: null,
    currentCheckpoint: currentCheckpointKey(state),
    previousTail: [],
    currentTail: tailKeys(state),
    continuity: result && result.continuity || 'CURRENT_BOTTOM_BASELINE',
    matchedAnchor: result && result.matchedContinuityAnchor || null,
    newOperationKeys: [],
    extendedOperationKeys: [],
    upwardBacktrackSteps: 0,
    backtrackAllowed: false,
    observerState: compactObserverState(state)
  };
}

async function observeAdjacentLog({
  bridge,
  label,
  expectedActivationKey,
  expectedMode = 'new-or-extended',
  requiredDetails = [],
  allowMergedDetailBlock = false
}) {
  if (!bridge) throw new Error(`${label}_BRIDGE_REQUIRED`);
  const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
  await waitForSelfPriorityBlue({
    bridge,
    label: `${label}_RESOLUTION_RESPONSE_BOUNDARY`,
    timeoutMs: 30000,
    recoverForeground: true
  });
  const beforeStateBytes = readBytesIfExists(OBSERVER_STATE_PATH);
  const beforeResultBytes = readBytesIfExists(LOG_RESULT_PATH);
  const beforeState = readJsonIfExists(OBSERVER_STATE_PATH);
  if (!beforeState) throw new Error(`${label}_PREVIOUS_OBSERVER_STATE_MISSING`);

  try {
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      verbose: false,
      allowBacktrack: false,
      // An atomic branch owns its just-submitted bottom operation.  Pass that
      // operation as the local boundary instead of asking the global observer
      // to prove an older checkpoint (for H3 that stale checkpoint was M22
      // while the newly resolved Kagari block is E02).
      expectedAtomicActivationKey: expectedActivationKey
    });

    const result = readJsonIfExists(LOG_RESULT_PATH);
    const afterState = readJsonIfExists(OBSERVER_STATE_PATH);
    if (!result || !afterState) throw new Error(`${label}_ADJACENT_LOG_RESULT_MISSING`);
    assertNoHistoricalBacktrack(result, label);

    let match = findExpectedBlock(result, expectedActivationKey, expectedMode);
    if (!match.block && allowMergedDetailBlock) {
      const detailMatch = findUniqueBlockByRequiredDetails(result, expectedMode, requiredDetails);
      if (detailMatch.candidates > 1) {
        throw new Error(
          `${label}_MERGED_DETAIL_BLOCK_AMBIGUOUS:${expectedActivationKey};candidates=${detailMatch.candidates}`
        );
      }
      if (detailMatch.block) match = detailMatch;
    }
    if (!match.block) {
      const newKeys = resultBlocks(result, 'new').map(block => block && block.activationKey).filter(Boolean).join('>') || 'NONE';
      const extendedKeys = resultBlocks(result, 'extended').map(block => block && block.activationKey).filter(Boolean).join('>') || 'NONE';
      throw new Error(
        `${label}_EXPECTED_ADJACENT_BLOCK_NOT_FOUND:${expectedActivationKey};` +
        `mode=${expectedMode};new=${newKeys};extended=${extendedKeys}`
      );
    }

    for (const requirement of requiredDetails) {
      if (!detailMatches(match.block, requirement)) {
        throw new Error(
          `${label}_EXPECTED_DETAIL_NOT_FOUND:${expectedActivationKey};` +
          `card=${requirement.cardId || 'ANY'};role=${requirement.roleIncludes || 'ANY'}`
        );
      }
    }

    const proof = buildProof(label, beforeState, afterState, result, match, {
      expectedActivationKey: String(expectedActivationKey),
      expectedMode,
      requiredDetails,
      allowMergedDetailBlock
    });

    console.log(
      `BRANCH LOG PASS: ${label}; predecessor=${proof.previousCheckpoint}; ` +
      `current=${proof.currentCheckpoint}; new=${proof.newOperationKeys.join('>') || 'NONE'}; ` +
      `extended=${proof.extendedOperationKeys.join('>') || 'NONE'}; backtrack=0`
    );
    return {
      proof,
      rawBlock: match.block
    };
  } catch (error) {
    restoreBytes(OBSERVER_STATE_PATH, beforeStateBytes);
    restoreBytes(LOG_RESULT_PATH, beforeResultBytes);
    throw error;
  }
}


function isExpectedAdjacentNotReady(error, label) {
  const message = String(error && error.message || error || '');
  return message.includes(`${label}_EXPECTED_ADJACENT_BLOCK_NOT_FOUND`);
}

async function observeAdjacentLogEventuallyBase({
  settleBeforeFirstMs = 0,
  retryWaitMs = 650,
  maxAttempts = 3,
  ...options
}) {
  const label = String(options.label || 'BRANCH_ADJACENT');
  if (settleBeforeFirstMs > 0) {
    console.log(`BRANCH PURE WAIT: ${label}; ${settleBeforeFirstMs}ms before first bottom-only check.`);
    await sleep(settleBeforeFirstMs);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const observed = await observeAdjacentLog(options);
      observed.proof.pollAttempt = attempt;
      observed.proof.pollMaxAttempts = maxAttempts;
      return observed;
    } catch (error) {
      lastError = error;
      if (!isExpectedAdjacentNotReady(error, label) || attempt >= maxAttempts) throw error;
      console.log(
        `BRANCH PURE WAIT: ${label}; bottom has no expected block yet ` +
        `(attempt ${attempt}/${maxAttempts}); zero input, wait ${retryWaitMs}ms.`
      );
      await sleep(retryWaitMs);
    }
  }
  throw lastError || new Error(`${label}_ADJACENT_POLL_EXHAUSTED`);
}

// PATCH_V5_YOTO_Y1_BOTTOM_ONLY_RETRY_V3
// Y1 has already finished all physical Link input before this observer runs.
// Master Duel can expose the E04 right-log block later than the optional-effect pool.
// On that single passive checkpoint-lag error, retry only the observer with zero game input.
async function observeAdjacentLogEventually(...args) {
  const outerMaxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= outerMaxAttempts; attempt++) {
    try {
      return await observeAdjacentLogEventuallyBase(...args);
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || '');
      const passiveBottomLag = message.startsWith('DUEL_LOG_BOTTOM_ONLY_CHECKPOINT_NOT_PROVEN:');
      if (!passiveBottomLag || attempt >= outerMaxAttempts) throw error;
      console.log(
        'BRANCH PURE WAIT: Y1 bottom-only checkpoint is not visible yet; ' +
        'zero game input, preserve the current optional-effect prompt, retry ' +
        attempt + '/' + outerMaxAttempts + ' after 900ms.'
      );
      await new Promise(resolve => setTimeout(resolve, 900));
    }
  }
  throw lastError;
}


async function observeAdjacentLogAndHand({
  bridge,
  label,
  expectedActivationKey,
  expectedMode = 'new-or-extended',
  requiredDetails = [],
  handPrependBlocks = []
}) {
  const beforeStateBytes = readBytesIfExists(OBSERVER_STATE_PATH);
  const beforeResultBytes = readBytesIfExists(LOG_RESULT_PATH);
  const beforeHandStateBytes = readBytesIfExists(HAND_STATE_PATH);
  const beforeIncrementalBytes = readBytesIfExists(INCREMENTAL_RESULT_PATH);
  const beforeCompositeStateBytes = readBytesIfExists(COMPOSITE_STATE_PATH);
  const beforeCompositeResultBytes = readBytesIfExists(COMPOSITE_RESULT_PATH);

  try {
    const observed = await observeAdjacentLog({
      bridge,
      label,
      expectedActivationKey,
      expectedMode,
      requiredDetails
    });

    // The right-log checkpoint advances at every semantic node, while the hand
    // reconciler may intentionally run less often.  When it finally runs, feed
    // it the exact accumulated field/result blocks since the previous hand
    // commit.  This keeps hand accounting mature without forcing the right-log
    // observer to retain an old global checkpoint.
    const actualLogBytes = readBytesIfExists(LOG_RESULT_PATH);
    const actualLog = readJsonIfExists(LOG_RESULT_PATH);
    const projectedBlocks = [
      ...(Array.isArray(handPrependBlocks) ? handPrependBlocks.filter(Boolean) : []),
      observed.rawBlock
    ].filter(Boolean);
    if (projectedBlocks.length > 1 || observed.proof.acceptedBlockSource === 'EXTENDED_BLOCK') {
      const projected = {
        ...actualLog,
        newOperationBlocks: projectedBlocks,
        newActivationBlocks: projectedBlocks,
        handReconciliationProjection: {
          source: 'V5_BRANCH_ADJACENT_OBSERVER',
          label,
          operationKeys: projectedBlocks.map(block => String(block && block.activationKey || '')).filter(Boolean)
        }
      };
      writeJsonAtomic(LOG_RESULT_PATH, projected);
      console.log(
        `HAND RECONCILE PROJECTION: ${label}; operations=` +
        `${projected.handReconciliationProjection.operationKeys.join('>') || 'NONE'}`
      );
    }

    if (fs.existsSync(INCREMENTAL_RESULT_PATH)) fs.unlinkSync(INCREMENTAL_RESULT_PATH);
    await runIncrementalHandChange({
      bridge,
      skipActivation: true,
      verbose: false
    });
    // Keep the official duel-log result as the real bottom-only observation;
    // the synthetic projection exists only for the hand transaction call.
    restoreBytes(LOG_RESULT_PATH, actualLogBytes);
    if (!fs.existsSync(INCREMENTAL_RESULT_PATH)) {
      throw new Error(`${label}_INCREMENTAL_RESULT_NOT_WRITTEN`);
    }
    const handState = readJsonIfExists(HAND_STATE_PATH);
    if (!handState) throw new Error(`${label}_HAND_SESSION_STATE_MISSING`);

    return {
      proof: {
        ...observed.proof,
        handObserverCommitted: true,
        handProjectionOperationKeys: projectedBlocks.map(block => String(block && block.activationKey || '')).filter(Boolean)
      },
      handState,
      incrementalResult: readJsonIfExists(INCREMENTAL_RESULT_PATH)
    };
  } catch (error) {
    // The branch state has not been committed yet. Roll every observer artifact
    // back to the previous committed node so a retry cannot inherit a half-step.
    restoreBytes(OBSERVER_STATE_PATH, beforeStateBytes);
    restoreBytes(LOG_RESULT_PATH, beforeResultBytes);
    restoreBytes(HAND_STATE_PATH, beforeHandStateBytes);
    restoreBytes(INCREMENTAL_RESULT_PATH, beforeIncrementalBytes);
    restoreBytes(COMPOSITE_STATE_PATH, beforeCompositeStateBytes);
    restoreBytes(COMPOSITE_RESULT_PATH, beforeCompositeResultBytes);
    console.error(`BRANCH OBSERVER ROLLBACK: ${label}; restored previous committed checkpoint.`);
    throw error;
  }
}


async function observeAdjacentLogAndHandEventually({
  settleBeforeFirstMs = 0,
  retryWaitMs = 650,
  maxAttempts = 3,
  ...options
}) {
  const label = String(options.label || 'BRANCH_ADJACENT_HAND');
  if (settleBeforeFirstMs > 0) {
    console.log(`BRANCH PURE WAIT: ${label}; ${settleBeforeFirstMs}ms before first bottom-only check.`);
    await sleep(settleBeforeFirstMs);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const observed = await observeAdjacentLogAndHand(options);
      observed.proof.pollAttempt = attempt;
      observed.proof.pollMaxAttempts = maxAttempts;
      return observed;
    } catch (error) {
      lastError = error;
      if (!isExpectedAdjacentNotReady(error, label) || attempt >= maxAttempts) throw error;
      console.log(
        `BRANCH PURE WAIT: ${label}; final semantic block not visible yet ` +
        `(attempt ${attempt}/${maxAttempts}); zero input, wait ${retryWaitMs}ms.`
      );
      await sleep(retryWaitMs);
    }
  }
  throw lastError || new Error(`${label}_ADJACENT_HAND_POLL_EXHAUSTED`);
}


async function rebaselineCurrentBottomAndHand({
  bridge,
  label,
  expectedActivationKey,
  previousFieldCheckpoint = 'FIELD:E02'
}) {
  if (!bridge) throw new Error(`${label}_BRIDGE_REQUIRED`);
  const beforeStateBytes = readBytesIfExists(OBSERVER_STATE_PATH);
  const beforeResultBytes = readBytesIfExists(LOG_RESULT_PATH);
  const beforeHandStateBytes = readBytesIfExists(HAND_STATE_PATH);
  const beforeIncrementalBytes = readBytesIfExists(INCREMENTAL_RESULT_PATH);
  const beforeCompositeStateBytes = readBytesIfExists(COMPOSITE_STATE_PATH);
  const beforeCompositeResultBytes = readBytesIfExists(COMPOSITE_RESULT_PATH);

  try {
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      rebaselineCurrentBottom: true,
      allowBacktrack: false,
      verbose: false
    });

    const result = readJsonIfExists(LOG_RESULT_PATH);
    const afterState = readJsonIfExists(OBSERVER_STATE_PATH);
    if (!result || !afterState) throw new Error(`${label}_REBASELINE_RESULT_MISSING`);
    assertNoHistoricalBacktrack(result, label);

    const checkpoint = currentCheckpointKey(afterState);
    const expected = String(expectedActivationKey || '');
    if (checkpoint !== expected) {
      throw new Error(`${label}_REBASELINE_CHECKPOINT_MISMATCH:${checkpoint};expected=${expected}`);
    }

    const blocks = Array.isArray(result.operationBlocks)
      ? result.operationBlocks
      : Array.isArray(result.activationBlocks)
        ? result.activationBlocks
        : [];
    const expectedBlock = blocks.slice().reverse().find(block =>
      String(block && block.activationKey || '') === expected
    ) || null;
    if (!expectedBlock) {
      throw new Error(`${label}_REBASELINE_EXPECTED_BLOCK_MISSING:${expected}`);
    }

    // The first branch action is now the trusted local baseline.  Reconcile the
    // hand with ONLY that already-proven action; do not perform a second full
    // TITLE_COMPONENTS/DENSE scan.  INFO count remains authoritative inside the
    // mature incremental hand observer.
    const officialLogBytes = readBytesIfExists(LOG_RESULT_PATH);
    const projected = {
      ...result,
      newOperationBlocks: [expectedBlock],
      newActivationBlocks: [expectedBlock],
      extendedOperationBlocks: [],
      handReconciliationProjection: {
        source: 'V5_FIRST_ACTION_REBASELINE',
        label,
        operationKeys: [expected]
      }
    };
    writeJsonAtomic(LOG_RESULT_PATH, projected);
    if (fs.existsSync(INCREMENTAL_RESULT_PATH)) fs.unlinkSync(INCREMENTAL_RESULT_PATH);
    await runIncrementalHandChange({
      bridge,
      skipActivation: true,
      verbose: false
    });
    restoreBytes(LOG_RESULT_PATH, officialLogBytes);

    const handState = readJsonIfExists(HAND_STATE_PATH);
    if (!handState) throw new Error(`${label}_HAND_SESSION_STATE_MISSING`);

    const proof = {
      mode: 'FIRST_ACTION_CURRENT_BOTTOM_REBASELINE',
      label,
      capturedAt: new Date().toISOString(),
      previousCheckpoint: previousFieldCheckpoint,
      currentCheckpoint: checkpoint,
      previousTail: [],
      currentTail: tailKeys(afterState),
      continuity: 'FIRST_BRANCH_ACTION_REBASELINED_FROM_CURRENT_BOTTOM;OLD_RIGHT_LOG_HISTORY_IGNORED',
      matchedAnchor: null,
      newOperationKeys: [expected],
      extendedOperationKeys: [],
      acceptedBlockSource: 'CURRENT_BOTTOM_REBASELINE',
      acceptedBlock: compactBlock(expectedBlock),
      upwardBacktrackSteps: 0,
      backtrackAllowed: false,
      handObserverCommitted: true,
      handProjectionOperationKeys: [expected],
      observerState: compactObserverState(afterState)
    };

    console.log(
      `BRANCH FIRST-ACTION REBASELINE PASS: ${label}; ` +
      `current=${checkpoint}; hand=incremental-only; full-hand-rescan=0; backtrack=0`
    );
    return {
      proof,
      rawBlock: expectedBlock,
      handState,
      incrementalResult: readJsonIfExists(INCREMENTAL_RESULT_PATH)
    };
  } catch (error) {
    restoreBytes(OBSERVER_STATE_PATH, beforeStateBytes);
    restoreBytes(LOG_RESULT_PATH, beforeResultBytes);
    restoreBytes(HAND_STATE_PATH, beforeHandStateBytes);
    restoreBytes(INCREMENTAL_RESULT_PATH, beforeIncrementalBytes);
    restoreBytes(COMPOSITE_STATE_PATH, beforeCompositeStateBytes);
    restoreBytes(COMPOSITE_RESULT_PATH, beforeCompositeResultBytes);
    console.error(`BRANCH OBSERVER ROLLBACK: ${label}; restored previous committed checkpoint.`);
    throw error;
  }
}

function assertAdjacentObserverSupport() {
  if (typeof runDuelLogLive !== 'function') throw new Error('BRANCH_OBSERVER_RUN_DUEL_LOG_EXPORT_MISSING');
  if (typeof runIncrementalHandChange !== 'function') throw new Error('BRANCH_OBSERVER_HAND_EXPORT_MISSING');
  const source = fs.readFileSync(DUEL_LOG_FILE, 'utf8');
  if (!source.includes('allowBacktrack')) {
    throw new Error('BRANCH_OBSERVER_BOTTOM_ONLY_MODE_NOT_SUPPORTED_BY_BASE_PROJECT');
  }
  if (!source.includes('rebaselineCurrentBottom')) {
    throw new Error('BRANCH_OBSERVER_CURRENT_BOTTOM_REBASELINE_NOT_SUPPORTED_BY_BASE_PROJECT');
  }
}

module.exports = {
  assertAdjacentObserverSupport,
  captureBaselineProof,
  captureCarryForwardProof,
  observeAdjacentLog,
  observeAdjacentLogEventually,
  observeAdjacentLogAndHand,
  observeAdjacentLogAndHandEventually,
  rebaselineCurrentBottomAndHand,
  compactObserverState
};
