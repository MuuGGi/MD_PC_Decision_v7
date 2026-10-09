'use strict';

const ADJACENT_CHECKPOINT_ONLY_ARG = '--adjacent-checkpoint-only';
const EXPECTED_ATOMIC_ACTIVATION_ARG = '--expected-atomic-activation=';
const ALLOW_HISTORICAL_BACKTRACK_ARG = '--allow-historical-backtrack';
const ATOMIC_OBSERVER_ENV = 'MD_V5_ATOMIC_OBSERVER';
const EXPECTED_ATOMIC_ACTIVATION_ENV = 'MD_V5_EXPECTED_ATOMIC_ACTIVATION';

function buildIncrementalObserverArgs(scriptPath, options = {}) {
  const args = [scriptPath];
  if (options.adjacentCheckpointOnly === true) {
    args.push(ADJACENT_CHECKPOINT_ONLY_ARG);
  }
  const expected = String(options.expectedAtomicActivationKey || '').trim().toUpperCase();
  if (expected) args.push(`${EXPECTED_ATOMIC_ACTIVATION_ARG}${expected}`);
  return args;
}

function expectedAtomicActivationKey({ argv = [], env = process.env } = {}) {
  const cli = argv.find(arg => String(arg).startsWith(EXPECTED_ATOMIC_ACTIVATION_ARG));
  const raw = cli
    ? String(cli).slice(EXPECTED_ATOMIC_ACTIVATION_ARG.length)
    : String(env && (env[EXPECTED_ATOMIC_ACTIVATION_ENV] || env.MD_V5_SELECTED_CARD_ID) || '');
  const normalized = raw.trim().toUpperCase();
  return /^[ME]\d{2}$/.test(normalized) ? normalized : null;
}

function shouldUseAdjacentCheckpointOnly({
  argv = [],
  observerStateMeta = null,
  env = process.env
} = {}) {
  return argv.includes(ADJACENT_CHECKPOINT_ONLY_ARG) ||
    Boolean(env && env[ATOMIC_OBSERVER_ENV] === '1') ||
    Boolean(observerStateMeta && observerStateMeta.materialAdjacentStep);
}

// Production observation may learn identities from the log/passive alignment,
// but an uncertain draw must never trigger a new-hand selection as a fallback.
function assertNoNewHandClicks(slots) {
  if (slots.length) throw new Error('NEW_HAND_IDENTITY_UNRESOLVED_NO_CLICK:' + slots.join(','));
}

module.exports = {
  assertNoNewHandClicks,
  ADJACENT_CHECKPOINT_ONLY_ARG,
  EXPECTED_ATOMIC_ACTIVATION_ARG,
  ALLOW_HISTORICAL_BACKTRACK_ARG,
  ATOMIC_OBSERVER_ENV,
  EXPECTED_ATOMIC_ACTIVATION_ENV,
  buildIncrementalObserverArgs,
  expectedAtomicActivationKey,
  shouldUseAdjacentCheckpointOnly
};
