'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, readJsonIfExistsSafe, writeJsonAtomic, restoreBuffer } = require('./runtime-files');
const { commitIncrementalObserverResult } = require('./incremental-observer-transaction');
const ROOT = path.resolve(__dirname, '..');
const M21_TRANSACTION_PATH = path.join(ROOT, 'debug/execution/M21_chicken_game/pending_field_activation.json');
const HAND_PATH = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const RESULT_PATH = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
const DECISION_PATH = path.join(ROOT, 'decision-state.json');
const LOG_STATE_PATH = path.join(ROOT, 'debug/duel-log-live/observer_state.json');
const STAGES = new Set(['HAND_ACTIVATION_STARTED', 'PLACEMENT_COMMITTED', 'FIELD_EFFECT_STARTED',
  'DRAW_CONFIRM_STARTED', 'OBSERVER_STARTED']);

function loadPendingM21Transaction() {
  const value = readJsonIfExistsSafe(M21_TRANSACTION_PATH);
  if (!value) {
    if (fs.existsSync(M21_TRANSACTION_PATH)) throw new Error('M21_TRANSACTION_UNREADABLE');
    return null;
  }
  if (value.stage === 'COMPLETE') return null;
  if (value.version !== 1 || !STAGES.has(value.stage) || !value.before || !value.decisionBefore || !value.id) {
    throw new Error('M21_TRANSACTION_INVALID');
  }
  return value;
}

function saveM21Stage(pending, stage, extra = {}) {
  const next = { ...pending, ...extra, stage, updatedAt: new Date().toISOString() };
  writeJsonAtomic(M21_TRANSACTION_PATH, next, { trailingNewline: true });
  return next;
}

function beginM21Transaction({ before, decisionBefore, selectedSlot, attemptDir, fieldOnly = false, drawOnly = false }) {
  if (loadPendingM21Transaction()) throw new Error('M21_PENDING_TRANSACTION_NO_REACTIVATION');
  if (drawOnly && (decisionBefore.fieldSpell !== 'M21' || decisionBefore.chickenGameDrawPending !== true ||
      decisionBefore.chickenGameDrawUsed === true)) throw new Error('M21_FIELD_DRAW_NOT_PENDING');
  if (!before || before.cards?.length !== before.handCount ||
      (!drawOnly && before.cards[Number(selectedSlot) - 1]?.id !== 'M21')) throw new Error('M21_TRANSACTION_HAND_INVALID');
  const pending = { version: 1, id: `${before.revision}:${attemptDir}`, before, decisionBefore,
    selectedSlot: Number(selectedSlot), attemptDir, fieldOnly, drawOnly,
    observerBefore: readJsonIfExistsSafe(LOG_STATE_PATH),
    recoveryPolicy: 'SAVED_STAGE_ONLY_NO_HAND_REPLAY_NO_FULL_SCAN' };
  return saveM21Stage(pending, drawOnly ? 'PLACEMENT_COMMITTED' : 'HAND_ACTIVATION_STARTED',
    drawOnly ? { beforeDraw: before } : {});
}

function accountM21Placement(state, pending) {
  if (state.effectUsageMeta?.M21_DRAW?.fieldPlacementTransaction === pending.id) return state;
  if (JSON.stringify(state) !== JSON.stringify(pending.decisionBefore)) throw new Error('M21_PLACEMENT_ACCOUNTING_CHANGED');
  return { ...state, usedCounts: { ...state.usedCounts, M21: Number(state.usedCounts?.M21 || 0) + 1 },
    graveSpellCount: Number(state.graveSpellCount || 0) + (state.fieldSpell === 'M21' ? 1 : 0),
    fieldSpell: 'M21', chickenGameDrawUsed: false, chickenGameDrawPending: true,
    effectUsageMeta: { ...state.effectUsageMeta, M21_DRAW: { pending: true,
      fieldPlacementTransaction: pending.id, source: 'M21_VERIFIED_FIELD_PLACEMENT', updatedAt: new Date().toISOString() } } };
}

function commitM21Placement(pending, log, block) {
  const { commitKnownM21Consumption } = require('../execution/core/m21-chicken-game-route');
  const current = readJson(HAND_PATH);
  const after = commitKnownM21Consumption(pending.before, block, { id: 'M21' }, pending.selectedSlot);
  const currentIsBefore = JSON.stringify(current) === JSON.stringify(pending.before);
  const already = current.revision === after.revision && current.handCount === after.handCount &&
    current.cards.every((c, i) => c.id === after.cards[i].id) &&
    readJson(DECISION_PATH).effectUsageMeta?.M21_DRAW?.fieldPlacementTransaction === pending.id;
  if (already) return saveM21Stage(pending, 'PLACEMENT_COMMITTED', { beforeDraw: current });
  if (!currentIsBefore) throw new Error('M21_PLACEMENT_BASELINE_CHANGED');
  const runtime = accountM21Placement(readJson(DECISION_PATH), pending);
  const paths = [HAND_PATH, RESULT_PATH, DECISION_PATH, M21_TRANSACTION_PATH,
    path.join(ROOT, 'debug/main-deck-ledger/state.json')];
  const buffers = paths.map(p => fs.existsSync(p) ? fs.readFileSync(p) : null);
  try {
    const incrementalResult = { status: 'PASS', source: 'M21_VERIFIED_FIELD_PLACEMENT',
      before: pending.before, after,
      inference: { activationKey: 'M21', consumed: pending.before.cards[pending.selectedSlot - 1],
        costConsumed: [], addedCount: 0, predictedSlots: [] }, insertedCards: [], finalClicks: [] };
    commitIncrementalObserverResult({ incrementalResult, log, statePath: HAND_PATH, resultPath: RESULT_PATH });
    writeJsonAtomic(DECISION_PATH, runtime, { trailingNewline: true });
    return saveM21Stage(pending, 'PLACEMENT_COMMITTED', { beforeDraw: after });
  } catch (error) {
    paths.forEach((p, i) => restoreBuffer(p, buffers[i]));
    throw error;
  }
}

function completeM21Transaction(pending, { fieldOnly = false } = {}) {
  if (!fieldOnly) {
    const state = readJson(DECISION_PATH);
    if (state.fieldSpell !== 'M21') throw new Error('M21_DRAW_WITHOUT_COMMITTED_FIELD');
    writeJsonAtomic(DECISION_PATH, { ...state, chickenGameDrawPending: false, chickenGameDrawUsed: true,
      effectUsageMeta: { ...state.effectUsageMeta, M21_DRAW: { ...state.effectUsageMeta?.M21_DRAW,
        pending: false, resolved: true, updatedAt: new Date().toISOString() } } }, { trailingNewline: true });
  }
  return saveM21Stage(pending, 'COMPLETE', { completedAt: new Date().toISOString() });
}

module.exports = { M21_TRANSACTION_PATH, loadPendingM21Transaction, beginM21Transaction,
  saveM21Stage, accountM21Placement, commitM21Placement, completeM21Transaction, LOG_STATE_PATH };
