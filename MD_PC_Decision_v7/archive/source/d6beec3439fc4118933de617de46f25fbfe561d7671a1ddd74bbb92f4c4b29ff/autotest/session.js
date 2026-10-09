'use strict';
const { classifyFailure } = require('./policy');
// Pure lifecycle: adapters own guarded UI. An error archive must complete
// BEFORE error surrender; human-stop signals override even passive recovery.
async function playOne(store, adapters, resumedGame = null) {
  const game = resumedGame || store.begin();
  let result = null;
  try {
    if (!resumedGame) {
    await adapters.start(game);
    game.duelStarted = true; store.save();
    await adapters.waitMain1(game);
    }
    result = await adapters.play(game);
  } catch (error) {
    game.error = String(error.stack || error); store.save();
    await adapters.archive(game, 'before-recovery', error);
    if (classifyFailure(error, adapters.stopped()) === 'STOP_TEST') {
      store.finish(game, 'INTERRUPTED', { testInterrupted: true }); return { stop: true, game };
    }
    // Recheck after archiving: physical interference during IO must not cause
    // a queued surrender or a subsequent new game.
    if (adapters.stopped()) { store.finish(game, 'INTERRUPTED'); return { stop: true, game }; }
    try {
      result = await adapters.observeEnd(game);
      if (!result) {
        if (game.duelStarted !== true) throw new Error('AUTOTEST_ERROR_CLEANUP_DUEL_NOT_STARTED');
        // No reactivation, no card retries, no guessed outcome. The adapter
        // proves duel controls, confirmation and defeat; finishBoard then
        // proves Starter before the caller may start the next game.
        if (adapters.stopped()) throw new Error('AUTOTEST_STOP:USER_STOP');
        game.errorRecoveryRequested = true; store.save();
        result = await adapters.surrender(game);
        if (!result || result.proven !== true || !['WIN', 'LOSS', 'SURRENDER'].includes(result.outcome)) {
          throw new Error('AUTOTEST_ERROR_SURRENDER_NOT_PROVEN');
        }
        if (result.outcome === 'SURRENDER') {
          game.errorSurrender = true;
          game.surrenderReason = 'EXECUTION_OR_RECOGNITION_ERROR';
        }
        store.save();
      }
    } catch (cleanupError) {
      game.recoveryError = String(cleanupError.stack || cleanupError); store.save();
      await adapters.archive(game, 'recovery-stopped', cleanupError);
      const interrupted = classifyFailure(cleanupError, adapters.stopped()) === 'STOP_TEST';
      store.finish(game, interrupted ? 'INTERRUPTED' : 'UNRESOLVED', { testStoppedForError: !interrupted });
      return { stop: true, game };
    }
  }
  if (adapters.stopped()) {
    await adapters.archive(game, 'interrupted');
    store.finish(game, 'INTERRUPTED'); return { stop: true, game };
  }
  if (!result || !['WIN', 'LOSS', 'SURRENDER'].includes(result.outcome) || result.proven !== true) {
    throw new Error('AUTOTEST_END_NOT_PROVEN');
  }
  // Preserve a proven outcome even if reward/return navigation fails later.
  store.finish(game, result.outcome, { resultProof: result.proof, gems: result.gems ?? null });
  try {
    const reward = await adapters.finishBoard(game, result);
    store.finish(game, result.outcome, { gems: reward.gems ?? null, returnedToStarter: true,
      ...(reward.rewardStatus ? { rewardStatus: reward.rewardStatus, rewardEvidencePath: reward.rewardEvidencePath } : {}) });
    await adapters.archive(game, 'completed');
  } catch (error) {
    game.finishError = String(error.stack || error); store.save();
    await adapters.archive(game, 'finish-stopped', error);
    return { stop: true, game };
  }
  return { stop: false, game };
}
module.exports = { playOne };
