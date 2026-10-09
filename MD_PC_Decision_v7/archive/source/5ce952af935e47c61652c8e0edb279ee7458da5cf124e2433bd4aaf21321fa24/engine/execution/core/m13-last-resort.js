'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');

const ROOT = path.resolve(__dirname, '../..');
const { EXODIA_UNKNOWN_ID } = require('../../lib/exodia-policy');
const STATE_PATH = path.join(ROOT, 'debug/allure-last-resort/state.json');
const COMPLETE_STAGES = new Set(['COMPLETE_RAYE', 'COMPLETE_HAMP', 'COMPLETE_VICTORY', 'COMPLETE_SURRENDER']);
const DARK_IDS = new Set(['M01', 'M02', 'M03', 'M04', 'M05', EXODIA_UNKNOWN_ID, 'M06', 'M08']);
const SAFE_DARK_IDS = new Set(['M06', 'M08']);

function recoverLegacyAllurePromptCheckpoint(state, witness) {
  const seen = state && state.failureProof && state.failureProof.seen;
  const points = witness && witness.points;
  if (!state || !['SURRENDER_READY', 'SURRENDER_STARTED'].includes(state.stage) ||
      state.submitProof || state.banishProof || !state.activation ||
      !state.baseline || !Array.isArray(state.baseline.cards) ||
      state.baseline.cards[Number(state.slot) - 1]?.id !== 'M13' ||
      !Array.isArray(seen) || !seen.length || !Array.isArray(points) || points.length !== seen.length ||
      Number(witness.headerDarkRatio) < 0.68 || !witness.evidenceSource ||
      seen.some(row => !row.card || row.card.accepted !== true || !DARK_IDS.has(row.card.id)) ||
      !seen.some(row => SAFE_DARK_IDS.has(row.card.id))) {
    throw new Error('M13_LEGACY_PROMPT_RECOVERY_EVIDENCE_INVALID');
  }
  for (const row of seen) {
    const point = points[Number(row.candidateIndex) - 1];
    if (!point || !row.clickReference || Math.abs(point.x - row.clickReference.x) > 3 ||
        Math.abs(point.y - row.clickReference.y) > 3) {
      throw new Error('M13_LEGACY_PROMPT_RECOVERY_GEOMETRY_MISMATCH');
    }
  }
  return { ...state, stage: 'BANISH_PROMPT_READY', updatedAt: new Date().toISOString(),
    recoveryProof: { previousStage: state.stage, source: 'ISSUE_101_CURRENT_UNSUBMITTED_PROMPT',
      witness, safeCandidateIds: seen.filter(row => SAFE_DARK_IDS.has(row.card.id)).map(row => row.card.id),
      policy: 'M06_THEN_M08_NO_REACTIVATION_NO_SURRENDER' } };
}

function loadLastResortAllureState(file = STATE_PATH) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function isLastResortAllurePending(state) {
  return Boolean(state && state.stage && !COMPLETE_STAGES.has(state.stage));
}

async function runM13LastResort(options = {}) {
  const file = options.checkpointPath || STATE_PATH;
  let state = loadLastResortAllureState(file);
  if (options.resume) {
    if (!state) throw new Error('M13_LAST_RESORT_RESUME_STATE_MISSING');
    if (COMPLETE_STAGES.has(state.stage)) return state.result;
    if (state.stage === 'OBSERVER_STARTED' && typeof options.verifySavedObservation === 'function') {
      // The game effect may have completed before a later verifier failed.
      // Reconcile only already committed files, before creating any GUI bridge.
      const observed = await options.verifySavedObservation(state);
      if (observed?.status !== 'PASS' || observed.savedObservationOnly !== true ||
          !SAFE_DARK_IDS.has(state.banishProof?.selected?.id) ||
          observed.observerVerification?.banished?.id !== state.banishProof.selected.id) {
        throw new Error('M13_SAVED_OBSERVATION_NOT_PASS');
      }
      const debugDir = options.debugDir || path.join(ROOT, 'debug/execution/M13_last_resort_saved',
        new Date().toISOString().replace(/[:.]/g, '-'));
      const result = { ...observed, debugDir };
      state = { ...state, stage: state.banishProof.selected.id === 'M08' ? 'COMPLETE_HAMP' : 'COMPLETE_RAYE',
        result, updatedAt: new Date().toISOString() };
      writeJsonAtomic(file, state);
      writeJsonAtomic(path.join(debugDir, 'checkpoint.json'), state);
      console.log('诱惑已结算：保存的observer与账本核验完成；没有重新点击或识别手牌。');
      return result;
    }
    if (['SURRENDER_READY', 'SURRENDER_STARTED'].includes(state.stage)) {
      const seen = state.failureProof?.seen || [];
      if (seen.some(row => row.card?.accepted && SAFE_DARK_IDS.has(row.card.id)) ||
          (state.failureProof?.status === 'NO_RAYE_IN_DARK_PROMPT' &&
            (!seen.length || seen.some(row => !row.card?.accepted || !DARK_IDS.has(row.card.id))))) {
        throw new Error('M13_LEGACY_SAFE_DARK_NEEDS_CURRENT_PROMPT_REPAIR');
      }
    }
    if (['PROMPT_SCAN_STARTED', 'BANISH_SUBMIT_STARTED', 'OBSERVER_STARTED'].includes(state.stage)) {
      throw new Error(`M13_LAST_RESORT_AMBIGUOUS_STAGE_NO_REPLAY:${state.stage}`);
    }
  } else if (isLastResortAllurePending(state)) {
    throw new Error('M13_LAST_RESORT_PENDING_NO_REACTIVATION');
  } else {
    state = null;
  }

  const debugDir = options.debugDir || path.join(ROOT, 'debug/execution/M13_last_resort',
    new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(debugDir, { recursive: true });
  const save = extra => {
    state = { ...state, ...extra, updatedAt: new Date().toISOString() };
    writeJsonAtomic(file, state);
    writeJsonAtomic(path.join(debugDir, 'checkpoint.json'), state);
  };
  // Defaults all reuse existing production atoms; tests replace these dependencies.
  const { MdFastBridge, sleep } = require('../../lib/win-fast');
  const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
  const { establishCurrentObserverBaseline } = require('./observer-current-baseline');
  const { selectObservedHandCard } = require('./hand-target');
  const { clickSelectedHandSpellActivation } = require('./hand-spell-activation');
  const { selectM13BanishTarget } = require('./m13-banish-selection');
  const { runConfirmedDeadlockSurrender } = require('./deadlock-surrender');
  const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
  const { collectActions } = require('../../lib/decision-engine');
  const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  let stopped = false;
  try {
    if (ownsBridge) await bridge.start();
    const { info } = await activateAndVerifyMasterDuel(bridge,
      options.resume ? { requireSelfPriorityBlue: false } : {});
    let library;
    let templates;
    if (!state || ['ACTIVATION_STARTED', 'ACTIVATED', 'BANISH_PROMPT_READY'].includes(state.stage)) {
      library = loadLibrary(ROOT);
      templates = await loadTemplates(ROOT, library);
    }
    if (!state) {
      const baseline = await establishCurrentObserverBaseline({ bridge, info,
        outputDir: path.join(debugDir, 'observer_baseline') });
      const runtime = readJson(path.join(ROOT, 'decision-state.json'));
      const cards = baseline.cards.map(row => ({ ...row, usable: true }));
      const decision = collectActions(cards, library, runtime);
      const deadlock = analyzeReachableResourceDeadlock({ cards, runtime, decisionResult: decision });
      const action = buildLastResortAllureAction(cards, decision, deadlock);
      if (!action) throw new Error('M13_LAST_RESORT_NOT_LAST_AVAILABLE_RAYE_CHANCE');
      const selected = await selectObservedHandCard({ bridge, info, library, templates, baseline,
        expectedId: 'M13', debugDir });
      save({ version: 1, executionId: crypto.randomUUID(), stage: 'ACTIVATION_STARTED',
        baseline, slot: action.slot, action, selected, startedAt: new Date().toISOString() });
      const activation = await clickSelectedHandSpellActivation({ bridge, info, expectedId: 'M13',
        expectedName: '暗之诱惑', clickReference: selected.clickReference, debugDir });
      save({ stage: 'ACTIVATED', activation });
      console.log('最后尝试诱惑已发动：零输入等待抽2；优先除外零衣，其次兵器；两者都没有才投降，不除外组件。');
    }

    if (['ACTIVATION_STARTED', 'ACTIVATED', 'BANISH_PROMPT_READY'].includes(state.stage)) {
      let outcome;
      save({ stage: 'PROMPT_SCAN_STARTED' });
      try {
        outcome = await selectM13BanishTarget({ bridge, info, library, templates,
          lastResort: true, debugDir,
          onBeforeSubmit: async proof => save({ stage: 'BANISH_SUBMIT_STARTED', submitProof: proof }) });
      } catch (error) {
        if (!String(error.message || error).startsWith('M13_BANISH_PROMPT_TIMEOUT:')) throw error;
        // A missing window is not proof of having no DARK. The baseline must
        // contain no DARK, and the settled ordinary duel must prove INFO=0.
        if (state.baseline.cards.some(row => DARK_IDS.has(row.id))) throw error;
        const { waitForSelfPriorityBlue } = require('../../lib/self-priority-gate');
        await waitForSelfPriorityBlue({ bridge, label: 'M13_NO_DARK_FINAL_HAND', timeoutMs: 15000 });
        const { loadInfoDigitTemplates } = require('../../lib/hand-info-overlay');
        const { runFastOwnAutoHold } = require('../../runtime/observer/test-hand-info-live');
        const count = await runFastOwnAutoHold(bridge, { own: 0 }, loadInfoDigitTemplates(ROOT),
          { debugDir: path.join(debugDir, 'empty_hand_info') });
        if (!count.result || count.result.status !== 'OK' || !count.result.own || count.result.own.handCount !== 0) {
          throw new Error('M13_LAST_RESORT_EMPTY_HAND_NOT_PROVEN');
        }
        outcome = { status: 'NO_DARK_ENTIRE_HAND_SENT_TO_GY', info: count.result };
      }
      if (outcome.selected && SAFE_DARK_IDS.has(outcome.selected.id)) {
        save({ stage: 'BANISH_SUBMITTED', banishProof: outcome });
      } else if (['NO_SAFE_DARK_IN_PROMPT', 'NO_DARK_ENTIRE_HAND_SENT_TO_GY'].includes(outcome.status)) {
        save({ stage: 'SURRENDER_READY', failureProof: outcome });
      } else {
        throw new Error('M13_LAST_RESORT_UNEXPECTED_OUTCOME');
      }
    }

    if (['SURRENDER_READY', 'SURRENDER_STARTED'].includes(state.stage)) {
      console.log('诱惑最后尝试没有零衣或兵器：按本次终端确认授权，直接执行成熟投降流程。');
      save({ stage: 'SURRENDER_STARTED' });
      const surrender = await runConfirmedDeadlockSurrender({ bridge, debugDir: path.join(debugDir, 'surrender') });
      if (!surrender || surrender.status !== 'SURRENDER_COMPLETE') throw new Error('M13_LAST_RESORT_SURRENDER_NOT_COMPLETE');
      const result = { status: 'TERMINAL_SURRENDER', surrender, failureProof: state.failureProof, debugDir };
      save({ stage: 'COMPLETE_SURRENDER', result });
      return result;
    }

    if (state.stage !== 'BANISH_SUBMITTED') throw new Error(`M13_LAST_RESORT_INVALID_STAGE:${state.stage}`);
    await sleep(1800);
    if (ownsBridge) { await bridge.stop(); stopped = true; }
    if (typeof options.observe !== 'function') throw new Error('M13_LAST_RESORT_OBSERVER_REQUIRED');
    save({ stage: 'OBSERVER_STARTED' });
    const observed = await options.observe({ baseline: state.baseline, banishProof: state.banishProof, attemptDir: debugDir });
    if (!observed || !['PASS', 'TERMINAL_VICTORY'].includes(observed.status)) {
      throw new Error('M13_LAST_RESORT_OBSERVER_NOT_PASS');
    }
    const result = { ...observed, debugDir };
    save({ stage: observed.status === 'TERMINAL_VICTORY' ? 'COMPLETE_VICTORY'
      : state.banishProof.selected.id === 'M08' ? 'COMPLETE_HAMP' : 'COMPLETE_RAYE', result });
    console.log('最后尝试已除外安全暗属性，正式observer已完成，返回正常决策。');
    return result;
  } finally {
    if (ownsBridge && !stopped) await bridge.stop().catch(() => {});
  }
}

module.exports = { STATE_PATH, loadLastResortAllureState, isLastResortAllurePending,
  recoverLegacyAllurePromptCheckpoint, runM13LastResort };
