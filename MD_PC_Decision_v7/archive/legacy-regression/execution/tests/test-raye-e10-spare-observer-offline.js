'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const Module = require('module');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const evidence = require('../../material/issues/issue-103-e10-before.json');
const library = require('../../card-library.json');
const scenePath = path.join(ROOT, 'material/issues/issue-103-e10-resolved-scene.png');
const scene = PNG.sync.read(fs.readFileSync(scenePath));
const { selectSingleHandOperation, inferIncrementalSlots } = require('../../lib/incremental-hand-locator');
const { prepareSavedE10Resolution } = require('../../lib/e10-saved-resolution-recovery');
const { completeE10ResolutionDecision, verifyE10IncrementalResolution } = require('../../lib/e10-resolution-policy');
const clone = value => JSON.parse(JSON.stringify(value));
const plan = prepareSavedE10Resolution({ evidence, scene, scenePath, library });
const context = { runtime: evidence.decision, expectedAtomicActivationKey: 'E10' };
assert.strictEqual(selectSingleHandOperation(evidence.hand.cards, evidence.log.newOperationBlocks).reason,
  'MULTIPLE_HAND_OPERATIONS_REQUIRE_SEQUENTIAL_RECONCILIATION', 'reproduce the original spare-Raye failure');
const normalized = selectSingleHandOperation(evidence.hand.cards, evidence.log.newOperationBlocks, context);
assert.strictEqual(normalized.operation.activationKey, 'E10');
assert.strictEqual(normalized.reason, null);
assert.strictEqual(plan.proof.exactFanConfirmed, true);
assert.deepStrictEqual(plan.incremental.after.cards.map(card => card.id), ['M02', 'M06', 'M12', 'M14', 'M17']);
assert.strictEqual(plan.incremental.after.revision, 10);
assert.deepStrictEqual(plan.incremental.inference.predictedSlots, [5]);
assert.strictEqual(plan.incremental.inference.consumed, null);
assert.strictEqual(plan.incremental.finalClicks[0].physicalClicksIssued, 0);
for (const change of [
  c => { c.expectedAtomicActivationKey = 'M06'; },
  c => { c.runtime.v5Branch.currentState = 'RAYE_NORMAL_SUMMONED'; },
  c => { c.runtime.v5Branch.carrierId = 'M06'; },
  c => { c.runtime.v5Branch.summonMode = 'LINK'; }
]) {
  const bad = clone(context); change(bad);
  assert.ok(selectSingleHandOperation(evidence.hand.cards, evidence.log.newOperationBlocks, bad).reason);
}
for (const change of [
  blocks => { blocks[1].relationship.parentActivationKey = 'M22'; },
  blocks => { blocks.reverse(); },
  blocks => { blocks[0].details[0].card.id = 'M09'; },
  blocks => { blocks.push({ activationKey: 'M12', details: [] }); }
]) {
  const blocks = clone(evidence.log.newOperationBlocks); change(blocks);
  assert.ok(selectSingleHandOperation(evidence.hand.cards, blocks, context).reason);
}
const summon = selectSingleHandOperation(evidence.hand.cards, [{ activationKey: 'M06', details: [] }], context);
assert.strictEqual(inferIncrementalSlots(evidence.hand.cards, summon.operation, 3, library).consumed.id, 'M06');
const noSpare = evidence.hand.cards.filter(card => card.id !== 'M06');
assert.strictEqual(selectSingleHandOperation(noSpare, evidence.log.newOperationBlocks).operation.activationKey, 'E10');

const ledgerPath = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const handPath = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const resultPath = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
const files = new Map([[ledgerPath, clone(evidence.ledger)], [handPath, clone(evidence.hand)],
  [path.join(ROOT, 'card-library.json'), library], [path.join(ROOT, 'decision-state.json'), evidence.decision]]);
const runtimeFiles = { readJsonIfExistsSafe: file => files.get(file) || null,
  writeJsonAtomic: (file, value) => files.set(file, clone(value)),
  restoreBuffer: (file, value) => value == null ? files.delete(file) : files.set(file, JSON.parse(value)) };
function load(rel, overrides) {
  const file = path.join(ROOT, rel), mod = { exports: {} }, requireReal = Module.createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { __dirname: path.dirname(file), module: mod, exports: mod.exports,
    Buffer, process, console: { log() {} }, require: name => Object.hasOwn(overrides, name) ? overrides[name] : requireReal(name) });
  return mod.exports;
}
const ledgerModule = load('lib/main-deck-ledger.js', { './runtime-files': runtimeFiles });
const transaction = load('lib/incremental-observer-transaction.js', { './runtime-files': runtimeFiles,
  './main-deck-ledger': ledgerModule, fs: { existsSync: file => files.has(file),
    readFileSync: file => Buffer.from(JSON.stringify(files.get(file))) } });
transaction.commitIncrementalObserverResult({ incrementalResult: plan.incremental, log: evidence.log,
  statePath: handPath, resultPath });
const ledger = files.get(ledgerPath);
assert.strictEqual(ledger.outsideDeckCounts.M06, 2, 'spare Raye is neither redrawn nor consumed');
assert.strictEqual(ledger.outsideDeckCounts.M17, 1);
assert.strictEqual(ledger.lastHandRevision, 10);
const verification = { baseline: evidence.hand, targetId: 'M17', targetSource: 'DECK',
  log: evidence.log, incremental: plan.incremental, hand: plan.incremental.after, ledger };
assert.strictEqual(verifyE10IncrementalResolution(verification).savedObservationOnly, true);
const completed = completeE10ResolutionDecision(evidence.decision, { zeroTargetId: 'M17', zeroTargetSource: 'DECK', handRevision: 10 });
assert.strictEqual(completed.v5Branch.carrierId, 'E10');
assert.strictEqual(completed.v5Branch.active, false);
assert.strictEqual(completed.v5Branch.currentState, 'E10_EFFECT_RESOLVED');
assert.strictEqual(completed.rayeNormalSummoned, false);
assert.deepStrictEqual(completed.usedCounts, evidence.decision.usedCounts);
assert.strictEqual(completed.graveSpellCount, 7);
assert.deepStrictEqual(completeE10ResolutionDecision(completed, { zeroTargetId: 'M17', zeroTargetSource: 'DECK', handRevision: 10 }), completed);
const runtimeSource = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
assert.ok(runtimeSource.includes("setAtomicBranch('KAGARI_RECOVERY_DONE', { active: false, carrierId: 'E02' })"),
  'Kagari recovery releases its prompt lock while preserving the occupied Extra Monster Zone');

// Execute the real decision collector and the real M17 GUI search-priority
// adapter against the completed R3 state, without touching runtime files.
const engine = load('lib/decision-engine.js', { './main-deck-ledger': { getSharedDeckState: () => ({ ledger,
  deckRemaining: Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c =>
    [c.id, c.count - (ledger.outsideDeckCounts[c.id] || 0)])) }) } });
const decision = engine.collectActions(plan.incremental.after.cards.map(card => ({ ...card, usable: true })), library, completed);
assert.strictEqual(decision.selected.id, 'M17');
assert.strictEqual(decision.selected.details.searchTarget.id, 'M08');
assert.ok(!decision.actions.some(action => action.id === 'M22'));
const searchFile = path.join(ROOT, 'execution/core/m17-engage-search.js');
const searchSource = fs.readFileSync(searchFile, 'utf8');
const priorityCode = searchSource.slice(searchSource.indexOf('function buildSearchPriority('), searchSource.indexOf('async function ', searchSource.indexOf('function buildSearchPriority(')));
const searchContext = { ROOT, path, LEGAL: new Map([['M06', 'Raye'], ['M08', 'HAMP'], ['M22', 'Hornet']]),
  fs: { existsSync: () => true, readFileSync: file => JSON.stringify(file.endsWith('decision-state.json') ? completed : library) },
  buildDeckState: engine.buildDeckState, buildEngageTargetPriority: require('../../lib/engage-policy').buildEngageTargetPriority };
vm.runInNewContext(priorityCode, searchContext);
assert.strictEqual(searchContext.buildSearchPriority(plan.incremental.after).targets[0].id, 'M08');

async function main() {
  const source = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
  const coreCode = source.slice(source.indexOf('async function runE10TargetToResolvedAtomic('), source.indexOf('module.exports = {', source.indexOf('async function runE10TargetToResolvedAtomic(')));
  let runtime = clone(evidence.decision), fail = true, targetCalls = 0, observerCalls = 0;
  const target = { selected: { recognized: { accepted: true, id: 'M17', name: '交闪' } }, selectedSource: 'DECK' };
  const ctx = { ROOT, path, ROUTE_ROOT: 'unused', DECISION_STATE_PATH: 'decision', console: { log() {} },
    timestampId: () => 'offline', ensureDir() {}, loadLibrary: () => library, loadTemplates: async () => [],
    startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    readJsonIfExists: () => runtime, writeJsonAtomic: (_, value) => { runtime = value; }, writeJson() {},
    selectPreferredSkyStrikerTarget: async () => { targetCalls++; return target; }, currentE10EngageSourcePolicy: () => ({}),
    sleep: async () => {}, countId: (state, id) => state.cards.filter(card => card.id === id).length,
    runObserver: options => { observerCalls++; assert.strictEqual(options.expectedAtomicActivationKey, 'E10');
      assert.strictEqual(options.e10TargetSource, 'DECK'); if (fail) throw new Error('INJECTED_OBSERVER_FAILURE'); return plan.incremental.after; },
    require: Module.createRequire(path.join(ROOT, 'execution/core/atomic-route-executor.js')),
    readJson: file => file.endsWith('latest_result.json') ? evidence.log : file.endsWith('latest_incremental_result.json') ? plan.incremental : ledger };
  vm.runInNewContext(coreCode, ctx);
  await assert.rejects(ctx.runE10TargetToResolvedAtomic({ state: evidence.hand }), /INJECTED_OBSERVER_FAILURE/);
  assert.strictEqual(runtime.v5Branch.e10SubmittedResolution.targetId, 'M17');
  fail = false;
  ctx.startBridge = async () => { throw new Error('TARGET_GUI_REPLAY_FORBIDDEN'); };
  ctx.selectPreferredSkyStrikerTarget = async () => { throw new Error('TARGET_RESELECT_FORBIDDEN'); };
  assert.strictEqual((await ctx.runE10TargetToResolvedAtomic({ state: evidence.hand })).state.revision, 10);
  assert.strictEqual(targetCalls, 1);
  assert.strictEqual(observerCalls, 2);
  ctx.runObserver = () => { throw new Error('COMMITTED_OBSERVER_REPLAY_FORBIDDEN'); };
  assert.strictEqual((await ctx.runE10TargetToResolvedAtomic({ state: plan.incremental.after })).savedObservationOnly, true);
  const stale = clone(plan.incremental.after); stale.cards[1].id = 'M09';
  await assert.rejects(ctx.runE10TargetToResolvedAtomic({ state: stale }), /COMMIT_MISMATCH/);
  console.log('RAYE_E10_SPARE_OBSERVER_OFFLINE PASS; actual saved scene=5; spare Raye retained; E10+1 ledger; R3 submit receipt no target replay; collector+actual M17 adapter=HAMP');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
