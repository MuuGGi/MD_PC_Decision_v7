'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const evidence = require('../../material/issues/issue-106-mallet-before.json');
const library = require('../../card-library.json');
const { createSimpleDrawAutoController, classifySimpleDrawContinuation } = require('../../lib/simple-draw-continuation-policy');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');
const { buildMalletKeepPolicy, hasAvailableResourceBeforeMallet } = require('../../lib/mallet-policy');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const protectedFiles = ['decision-state.json', 'debug/hand-change-live/session_state.json', 'debug/main-deck-ledger/state.json',
  'debug/duel-log-live/latest_result.json', 'debug/duel-log-live/observer_state.json',
  'debug/hand-change-live/latest_incremental_result.json', 'material/verified/verified-cards.json', 'debug/settlement-rewards/daily-gems.json'];
const protectedBytes = new Map(protectedFiles.filter(rel => fs.existsSync(path.join(ROOT,rel))).map(rel => [rel, fs.readFileSync(path.join(ROOT, rel))]));
const engineFile = path.join(ROOT, 'lib/decision-engine.js'), engineRequire = createRequire(engineFile);
const totals = Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, c.count]));
const actualRemaining = Object.fromEntries(Object.entries(totals).map(([id, total]) =>
  [id, total - Number(evidence.ledger.outsideDeckCounts[id] || 0)]));
let remaining = actualRemaining;
function engine(source) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: evidence.ledger }) }
    : engineRequire(id) });
  return module.exports;
}
const production = engine(read('lib/decision-engine.js'));
assert.deepStrictEqual(evidence.hand.cards.map(c => c.id), ['M08', 'M11', 'M14', 'M15', 'M17']);
assert.strictEqual(evidence.decision.graveSpellCount, 2);
const old = engine(read('material/issues/issue-106-decision-engine-before.js.txt'));
const usableCurrent = evidence.hand.cards.map(c => ({ ...c, usable: true }));
assert.strictEqual(old.collectActions(usableCurrent, library, evidence.decision).selected.id, 'M11', 'reproduce original promotion');
const current = production.collectActions(usableCurrent, library, evidence.decision);
assert.strictEqual(current.selected.id, 'M15');
assert.strictEqual(current.selected.slot, 4);
assert.strictEqual(current.actions.find(a => a.id === 'M11').tier, 100);
assert.strictEqual(current.actions.find(a => a.id === 'M11').details.malletDeferredForOtherResources, true);
function cards(ids) {
  return ids.map((id, i) => ({ id, index: i + 1, usable: true,
    name: library.cards.find(c => c.id === id)?.name || id }));
}
function collect(ids, fields = {}, deckOverrides = {}) {
  const runtime = { ...evidence.decision, ...fields };
  const hand = cards(ids), counts = {};
  hand.forEach(c => { counts[c.id] = Number(counts[c.id] || 0) + 1; });
  remaining = Object.fromEntries(Object.entries(totals).map(([id, total]) =>
    [id, Math.max(0, total - Number(counts[id] || 0) - Number(runtime.usedCounts?.[id] || 0))]));
  Object.assign(remaining, deckOverrides);
  return production.collectActions(hand, library, runtime);
}
for (const id of ['M09', 'M12', 'M15', 'M16', 'M18', 'M21']) {
  for (const branch of [{}, { v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02' } }]) {
    for (const ids of [['M08', 'M11', 'M14', id, 'M17'], ['M08', id, 'M14', 'M11', 'M17']]) {
      const actual = collect(ids, branch);
      assert.strictEqual(actual.selected.id, id, `ordinary ${id} beats Mallet irrespective of order/branch`);
      assert.strictEqual(actual.actions.find(a => a.id === 'M11').tier, 100);
      assert.ok(!actual.v5KagariMalletThirdSpellPolicy?.applied);
    }
  }
}
const equipped = collect(['M08', 'M11', 'M14', 'M17'], { bambooSwordEquipped: true });
assert.strictEqual(equipped.selected.id, 'M14');
for (const runtime of [{}, { v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02' } }]) {
  const onlyEngage = collect(['M08', 'M11', 'M14', 'M17'], runtime);
  assert.strictEqual(onlyEngage.selected.id, 'M11', 'no usable Golden and no ordinary resources: keep the original bridge');
  assert.ok(onlyEngage.selected.details.mallet.keepIds.includes('M17'));
}
const allureLast = collect(['M08', 'M11', 'M13', 'M17']);
assert.strictEqual(allureLast.selected.id, 'M17', 'another legal action disables only the Mallet promotion; normal priorities apply');
assert.strictEqual(allureLast.actions.find(a => a.id === 'M11').tier, 100);
assert.ok(allureLast.actions.find(a => a.id === 'M13').tier < 100, 'safe Allure precedes protective Mallet');
assert.strictEqual(hasAvailableResourceBeforeMallet([{ id: 'M21', graveGain: 0 }], { graveSpellCount: 2 }), true);
assert.strictEqual(hasAvailableResourceBeforeMallet([{ id: 'M17' }], { graveSpellCount: 2 }), false);
assert.strictEqual(hasAvailableResourceBeforeMallet([{ id: 'M17' }], { graveSpellCount: 3 }), true);
assert.strictEqual(hasAvailableResourceBeforeMallet([], { chickenGameDrawPending: true }), true);
const blockedDraw = collect(['M08', 'M11', 'M14', 'M12', 'M17'], {}, { ...Object.fromEntries(Object.keys(totals).map(id => [id, 0])), M06: 1 });
assert.strictEqual(blockedDraw.selected.id, 'M11', 'illegal draw2 does not count as another available action');
const strandedToonIds = ['M03', 'M11', 'M10', 'M07', 'M15', 'M12'];
const strandedToon = collect(strandedToonIds, { graveSpellCount: 1, usedCounts: { M10: 2 } }, { M10: 0, M07: 0 });
assert.strictEqual(strandedToon.selected.id, 'M15', 'new gain-first rule defers stranded Toon restart until legal draws finish');
const protectedDragon = collect(strandedToonIds.filter(id => id !== 'M15'), { graveSpellCount: 1, usedCounts: { M10: 2 } }, { M10: 0, M07: 0 });
assert.strictEqual(protectedDragon.selected.id, 'M11', 'existing protected Toon cost exception remains once ordinary resources are exhausted');
const noEngageTargets = collect(['M08', 'M11', 'M14', 'M15', 'M17'], {}, { M06: 0, M08: 0, M22: 0 });
assert.strictEqual(noEngageTargets.selected.id, 'M15', 'draw first even when Mallet will later restore exhausted Engage targets');
assert.ok(noEngageTargets.actions.find(a => a.id === 'M11').details.mallet.keepIds.includes('M17'));
remaining = actualRemaining;
let runtime = evidence.decision;
const main = read('runtime/main-v6.js');
function extract(from, to) {
  const a = main.indexOf(from), b = main.indexOf(to, a); assert.ok(a >= 0 && b > a); return main.slice(a, b);
}
const context = vm.createContext({ ROOT, path, process: { env: {} }, console: { log() {}, error() {} },
  STRATEGIC_SPELL_IDS: new Set(library.cards.filter(c => /^M\d+$/.test(c.id) && Number(c.id.slice(1)) >= 9).map(c => c.id)),
  loadDecisionState: () => runtime, knownNonRayeMonsterPresent: () => false, buildLastResortAllureAction,
  require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return production;
    if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock };
    throw new Error('Unexpected dependency:' + id);
  } });
vm.runInContext(extract('function isStrategicallyUsable(', 'function defaultDecisionState(') +
  extract('function buildDecisionSuggestion(', 'function shortExtraForDecision(') +
  extract('function parseCommand(', 'function printHelp('), context);
const formal = context.buildDecisionSuggestion(evidence.hand);
assert.strictEqual(formal.selected.id, 'M15'); assert.strictEqual(formal.selected.slot, 4);
assert.strictEqual(classifySimpleDrawContinuation(evidence.hand, formal).automatic, true);
const pendingRuntime = { ...evidence.decision, chickenGameDrawPending: true,
  v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02' } };
runtime = pendingRuntime;
const pendingHand = { handCount: 4, revision: 2, cards: cards(['M08', 'M11', 'M14', 'M17']) };
assert.strictEqual(context.buildDecisionSuggestion(pendingHand).selected.specialAction, 'M21_FIELD_DRAW');
runtime = { ...evidence.decision, graveSpellCount: 3, usedCounts: { M15: 2, M09: 1 } };
const afterDraw = { handCount: 5, revision: 3, cards: cards(['M01', 'M08', 'M11', 'M14', 'M17']) };
const next = context.buildDecisionSuggestion(afterDraw);
assert.strictEqual(next.selected.id, 'M17', 'after the remaining Void, grave3 Engage becomes available');
assert.strictEqual(classifySimpleDrawContinuation(afterDraw, next).automatic, false);
const keep = buildMalletKeepPolicy(current.deck, usableCurrent, evidence.decision);
assert.ok(keep.keepIds.includes('M17'), 'priority fix does not remove mature M11 protection if explicitly chosen');
(async () => {
  let questions = 0;
  const rl = { question: async () => { questions++; return ''; } };
  const auto = createSimpleDrawAutoController();
  const answer = await context.readDecisionCommand(evidence.hand, formal, rl, auto);
  assert.strictEqual(answer.automatic, true); assert.strictEqual(answer.command.slot, 4); assert.strictEqual(questions, 0);
  const review = await context.readDecisionCommand(afterDraw, next, rl, auto);
  assert.strictEqual(review.automatic, false); assert.strictEqual(questions, 1);
  for (const [rel, bytes] of protectedBytes) assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  console.log('MALLET_OTHER_RESOURCES_FIRST_OFFLINE_PASS; actual old=M11/new=M15slot4 automatic question0; next grave3=M17 Enter; only-Engage bridge kept; Chicken graveGain0/pending kept; base+Kagari gated; restart after gains/protected cost kept; stateWrites0/gameInputs0');
})().catch(error => { console.error(error); process.exitCode = 1; });
