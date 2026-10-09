'use strict';

const TERMINAL_YIELD = 'DUEL_LOG_STRICT_TERMINAL_YIELD';
function isStrictVictory(outcome) {
  return outcome?.terminal === true && outcome.type === 'VICTORY' &&
    outcome.strictEvidence?.matched === true;
}

// Only the existing strict detector may declare victory. A missing ordinary
// surface or a weak victory candidate suspends observation, never opens/logs/
// scrolls that surface. Polls are passive, bounded, and share the same bridge.
function createTerminalObservationGuard({ detect, capture, delay, now = Date.now,
  timeoutMs = 12000, intervalMs = 250, onSuspend = () => {} }) {
  return async ({ sourceImage, info, stage, panelState }) => {
    let outcome = await detect(sourceImage, info);
    const weak = () => outcome?.safetyStop && outcome.type === 'VICTORY_CANDIDATE_UNCONFIRMED';
    const missingSurface = panelState && !panelState.open;
    if (!outcome?.terminal && (weak() || missingSurface)) {
      onSuspend(stage);
      const started = now();
      while (now() - started < timeoutMs) {
        if (outcome?.safetyStop && !weak()) break;
        await delay(Math.min(intervalMs, timeoutMs - (now() - started)));
        const fresh = await capture();
        outcome = await detect(fresh.image, fresh.info);
        if (outcome?.terminal) break;
      }
      // Never resume from a frame whose ordinary surface was lost. A later
      // ordinary retry requires its own fresh observation and checkpoint.
      if (!outcome?.terminal && !outcome?.safetyStop) {
        throw new Error('DUEL_LOG_ORDINARY_SURFACE_LOST:' + stage);
      }
    }
    if (isStrictVictory(outcome)) {
      const error = new Error(TERMINAL_YIELD);
      error.code = TERMINAL_YIELD;
      error.outcome = outcome;
      throw error;
    }
    if (outcome?.terminal || outcome?.safetyStop) {
      throw new Error('DUEL_LOG_TERMINAL_NOT_STRICT_VICTORY:' + stage);
    }
  };
}
module.exports = { TERMINAL_YIELD, isStrictVictory, createTerminalObservationGuard };
