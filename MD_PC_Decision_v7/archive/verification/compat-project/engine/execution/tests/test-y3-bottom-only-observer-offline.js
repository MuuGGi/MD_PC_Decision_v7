'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  ADJACENT_CHECKPOINT_ONLY_ARG,
  EXPECTED_ATOMIC_ACTIVATION_ARG,
  ALLOW_HISTORICAL_BACKTRACK_ARG,
  ATOMIC_OBSERVER_ENV,
  EXPECTED_ATOMIC_ACTIVATION_ENV,
  buildIncrementalObserverArgs,
  expectedAtomicActivationKey,
  shouldUseAdjacentCheckpointOnly
} = require('../../lib/incremental-observer-policy');

const scriptPath = path.join('runtime', 'observer', 'run-live-incremental.js');
assert.deepStrictEqual(buildIncrementalObserverArgs(scriptPath), [scriptPath]);
assert.deepStrictEqual(
  buildIncrementalObserverArgs(scriptPath, { adjacentCheckpointOnly: true }),
  [scriptPath, ADJACENT_CHECKPOINT_ONLY_ARG]
);
assert.deepStrictEqual(
  buildIncrementalObserverArgs(scriptPath, {
    adjacentCheckpointOnly: true,
    expectedAtomicActivationKey: 'm13'
  }),
  [scriptPath, ADJACENT_CHECKPOINT_ONLY_ARG, `${EXPECTED_ATOMIC_ACTIVATION_ARG}M13`]
);
assert.strictEqual(
  expectedAtomicActivationKey({ argv: [`${EXPECTED_ATOMIC_ACTIVATION_ARG}m13`], env: {} }),
  'M13'
);
assert.strictEqual(
  expectedAtomicActivationKey({ env: { [EXPECTED_ATOMIC_ACTIVATION_ENV]: 'M21' } }),
  'M21'
);
assert.strictEqual(
  expectedAtomicActivationKey({ env: { MD_V5_SELECTED_CARD_ID: 'M17' } }),
  'M17'
);
assert.strictEqual(expectedAtomicActivationKey({ env: { MD_V5_SELECTED_CARD_ID: 'bad' } }), null);
assert.strictEqual(ALLOW_HISTORICAL_BACKTRACK_ARG, '--allow-historical-backtrack');

const duelLogSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'runtime', 'observer', 'test-duel-log-live.js'),
  'utf8'
);
assert.match(
  duelLogSource,
  /CLI_ALLOW_HISTORICAL_BACKTRACK/,
  'historical scrolling must be an explicit diagnostic opt-in'
);
assert.doesNotMatch(
  duelLogSource,
  /const ALLOW_BACKTRACK = options\.allowBacktrack !== false/,
  'the old globally scrolling default must never return'
);

const incrementalSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'runtime', 'observer', 'run-live-incremental.js'),
  'utf8'
);
assert.match(incrementalSource, /allowBacktrack: allowHistoricalBacktrack/);
assert.doesNotMatch(incrementalSource, /allowBacktrack: !adjacentCheckpointOnly/);
assert.strictEqual(shouldUseAdjacentCheckpointOnly(), false);
assert.strictEqual(
  shouldUseAdjacentCheckpointOnly({ argv: [ADJACENT_CHECKPOINT_ONLY_ARG] }),
  true,
  'an atomic caller must be able to forbid historical backtracking explicitly'
);
assert.strictEqual(
  shouldUseAdjacentCheckpointOnly({ env: { [ATOMIC_OBSERVER_ENV]: '1' } }),
  true,
  'production executors must propagate their atomic boundary to nested observers'
);
assert.strictEqual(
  shouldUseAdjacentCheckpointOnly({ observerStateMeta: { materialAdjacentStep: { step: 2 } } }),
  true,
  'the mature material-adjacent checkpoint policy must remain supported'
);

const executorSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'core', 'atomic-route-executor.js'),
  'utf8'
);
assert.match(
  executorSource,
  /adjacentCheckpointOnly: options\.adjacentCheckpointOnly !== false/,
  'every shared atomic-route runObserver call must default to bottom-only validation'
);
assert.match(
  executorSource,
  /MD_V5_EXPECTED_ATOMIC_ACTIVATION: expectedAtomicActivationKey/,
  'shared atomic observers must propagate their trusted current activation boundary'
);
const y3Start = executorSource.indexOf('async function runBambooPromptToResolvedAtomic');
const y3End = executorSource.indexOf('async function recoverClosedBambooPromptAtomic', y3Start);
const y3Source = executorSource.slice(y3Start, y3End);
assert.ok(y3Start >= 0 && y3End > y3Start);
assert.match(
  y3Source,
  /runObserver\(\{[\s\S]*adjacentCheckpointOnly: true,[\s\S]*expectedAtomicActivationKey: 'M19'[\s\S]*\}\)/,
  'Y3 single-gain validation must explicitly stay at its M19 bottom boundary'
);
assert.match(
  y3Source,
  /expectedGain > 1[\s\S]*verifyKnownMultiGainAtomic\(/,
  'dual E10 + M19 resolution must use the targeted no-click multi-gain verifier'
);
assert.doesNotMatch(
  y3Source,
  /rebuildCurrentHandBaselineAtomic/,
  'normal Y3/D4 completion must never fall back to clicking and rescanning the full hand'
);
assert.match(
  y3Source,
  /activationKey: secondGainActivationKey[\s\S]*activationKey: 'M19'/,
  'dual final proof must bind each known gain to its own atomic activation'
);
assert.match(y3Source, /secondGainActivationKey = 'E10'/, 'legacy dual keeps E10 as its default');

const multiGainStart = executorSource.indexOf('async function verifyKnownMultiGainAtomic');
const multiGainEnd = executorSource.indexOf('async function resumeKagariRecoveryCurrentPrompt', multiGainStart);
const multiGainSource = executorSource.slice(multiGainStart, multiGainEnd);
assert.ok(multiGainStart >= 0 && multiGainEnd > multiGainStart);
assert.match(multiGainSource, /readOwnHandCount/);
assert.match(multiGainSource, /allowBacktrack: false/);
assert.match(multiGainSource, /physicalClicksIssued: 0/);
assert.match(multiGainSource, /commitKnownAtomicHandGains/);
assert.doesNotMatch(
  multiGainSource,
  /recognizeCurrentCard|selectObservedHandCard/,
  'targeted multi-gain proof must not inspect cards by clicking the hand'
);

const mainSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'runtime', 'main-v6.js'),
  'utf8'
);
const atomicEnvironmentAssignments = mainSource.match(/MD_V5_ATOMIC_OBSERVER:\s*'1'/g) || [];
assert.ok(
  atomicEnvironmentAssignments.length >= 2,
  'normal production executors and the pending M21 continuation must both propagate atomic observer mode'
);
assert.match(
  mainSource,
  /MD_V5_EXPECTED_ATOMIC_ACTIVATION:\s*'M21'/,
  'the pending M21 field-effect continuation must declare its own current activation'
);

function collectJsFiles(dirPath) {
  const out = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const executionRoot = path.resolve(__dirname, '..', '..', 'execution');
const executionSources = collectJsFiles(executionRoot)
  .filter(file => !file.includes(`${path.sep}tests${path.sep}`))
  .map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));

for (const { file, source } of executionSources) {
  if (!source.includes('run-live-incremental.js')) continue;
  const isSharedAtomicWrapper = file.endsWith(path.join('core', 'atomic-route-executor.js'));
  const isManualCompositeDiagnostic = file.endsWith(path.join('live', 'run-composite-route-observer.js'));
  assert.ok(
    source.includes(ADJACENT_CHECKPOINT_ONLY_ARG) ||
      isSharedAtomicWrapper ||
      isManualCompositeDiagnostic,
    `unclassified incremental observer boundary: ${file}`
  );
  if (isManualCompositeDiagnostic) {
    assert.match(source, /ISSUE-076 audit exception/);
  }
}

for (const { file, source } of executionSources) {
  const directCalls = (source.match(/await runDuelLogLive\s*\(/g) || []).length;
  if (!directCalls) continue;
  const bottomOnlyDeclarations = (source.match(/allowBacktrack:\s*false/g) || []).length;
  assert.ok(
    bottomOnlyDeclarations >= directCalls,
    `direct atomic duel-log call still allows historical backtracking: ${file}; ` +
      `calls=${directCalls}; bottomOnly=${bottomOnlyDeclarations}`
  );
}

// ISSUE-107: direct stage readers must declare the current submitted card,
// just like the shared atomic observer. Explicit baseline creation is separate.
for (const { file, source } of executionSources) {
  const directCalls = source.match(/await runDuelLogLive\(\{[\s\S]*?\n\s*\}\);/g) || [];
  for (const call of directCalls) {
    assert.ok(call.includes('rebaselineCurrentBottom: true') ||
      /expectedAtomicActivationKey:\s*(?!['"]{2})\S+/.test(call),
      'direct stage observer omitted its current activation: ' + file);
  }
}
// Exercise default legacy E10, explicit Kagari, and ordinary single Y3 using
// the production function; no bridge, disk writes or native inputs.
(async () => {
  let gains = null, singleOptions = null;
  const before = { handCount: 0, cards: [] };
  const after = { handCount: 2, cards: [{ id: 'M17' }, { id: 'M14' }] };
  const ctx = vm.createContext({ ROOT: 'MEMORY', ROUTE_ROOT: 'MEMORY', path,
    console: { log() {} }, ensureDir() {}, timestampId: () => 'OFFLINE',
    loadLibrary: () => ({}), loadTemplates: async () => [], sleep: async () => {},
    startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    selectBambooSearchTarget: async () => ({ selected: { id: 'M14' } }),
    verifyKnownMultiGainAtomic: async opts => { gains = opts.gains; return after; },
    runObserver: opts => { singleOptions = opts; return { handCount: 1, cards: [{ id: 'M14' }] }; },
    countId: (s, id) => s.cards.filter(card => card.id === id).length
  });
  vm.runInContext(y3Source, ctx);
  await ctx.runBambooPromptToResolvedAtomic({ state: before, expectedGain: 2, zeroTargetId: 'M17', zeroTargetSource: 'DECK' });
  assert.deepStrictEqual(Array.from(gains, g => g.activationKey), ['E10', 'M19']);
  assert.strictEqual(gains[0].fromDeck, true);
  await ctx.runBambooPromptToResolvedAtomic({ state: before, expectedGain: 2, secondGainActivationKey: 'E02',
    zeroTargetId: 'M17', zeroTargetSource: 'GRAVE' });
  assert.deepStrictEqual(Array.from(gains, g => g.activationKey), ['E02', 'M19']);
  assert.strictEqual(gains[0].fromDeck, false);
  await ctx.runBambooPromptToResolvedAtomic({ state: before });
  assert.strictEqual(singleOptions.expectedAtomicActivationKey, 'M19');
  assert.strictEqual(singleOptions.adjacentCheckpointOnly, true);
  console.log('Y3_BOTTOM_ONLY_OBSERVER_OFFLINE_PASS; legacy E10/new E02/single M19 production dispatch; nativeInputs=0');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
