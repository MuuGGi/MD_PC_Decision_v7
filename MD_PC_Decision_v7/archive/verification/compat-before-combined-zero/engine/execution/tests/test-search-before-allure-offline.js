'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');
const opening = require('../../material/issues/issue-100-opening-hand.json');
const openingRuntime = require('../../material/issues/issue-100-opening-runtime.json');
const openingLedger = require('../../material/issues/issue-100-opening-ledger.json');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const protectedFiles = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/observer_state.json',
  'material/verified/verified-cards.json', 'debug/settlement-rewards/daily-gems.json'];
const before = new Map(protectedFiles.filter(rel => fs.existsSync(path.join(ROOT, rel)))
  .map(rel => [rel, fs.readFileSync(path.join(ROOT, rel))]));
let currentRuntime = openingRuntime;
let currentLedger = openingLedger;
const totals = Object.fromEntries(library.cards.filter(card => /^M\d+$/.test(card.id))
  .map(card => [card.id, card.count]));

// Run the production collector with a read-only deck snapshot; no live ledger writes.
const engineFile = path.join(ROOT, 'lib/decision-engine.js');
const engineRequire = createRequire(engineFile);
const engineModule = { exports: {} };
const engineContext = vm.createContext({ module: engineModule, exports: engineModule.exports,
  console, require: id => id === './main-deck-ledger' ? {
    getSharedDeckState: () => ({ ledger: currentLedger,
      outsideDeckCounts: currentLedger.outsideDeckCounts,
      deckRemaining: Object.fromEntries(Object.entries(totals)
        .map(([id, total]) => [id, total - Number(currentLedger.outsideDeckCounts[id] || 0)])) })
  } : engineRequire(id) });
vm.runInContext(read('lib/decision-engine.js'), engineContext, { filename: engineFile });
const collectActions = engineModule.exports.collectActions;

// Run the real top-level suggestion, including its strategic usability and deadlock override.
const main = read('runtime/main-v6.js');
const usableStart = main.indexOf('function isStrategicallyUsable(');
const usableEnd = main.indexOf('function defaultDecisionState(', usableStart);
const start = main.indexOf('function buildDecisionSuggestion(');
const end = main.indexOf('function shortExtraForDecision(', start);
assert.ok(usableStart >= 0 && usableEnd > usableStart && start >= 0 && end > start);
const STRATEGIC_SPELL_IDS = new Set(library.cards.filter(card => /^M\d+$/.test(card.id) &&
  Number(card.id.slice(1)) >= 9).map(card => card.id));
const context = vm.createContext({ ROOT, path, STRATEGIC_SPELL_IDS,
  loadDecisionState: () => currentRuntime, knownNonRayeMonsterPresent: () => false,
  buildLastResortAllureAction, require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return { collectActions };
    if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock };
    throw new Error('Unexpected suggestion dependency: ' + id);
  } });
vm.runInContext(main.slice(usableStart, usableEnd) + main.slice(start, end), context);
const actual = context.buildDecisionSuggestion(opening);
assert.deepStrictEqual(opening.cards.map(card => card.id), ['M01', 'M10', 'M10', 'M13', 'M22']);
assert.strictEqual(actual.selected.id, 'M10');
assert.strictEqual(actual.selected.slot, 2);
assert.strictEqual(actual.selected.details.searchTarget.id, 'M10');
assert.strictEqual(actual.strategicDeadlock.terminal, false);
assert.strictEqual(actual.strategicDeadlock.reason, 'FIXED_RESOURCE_ACTION_PENDING');
assert.strictEqual(actual.result.actions.some(action => action.details.allureLastResort), false);

function decide(ids, runtime = {}) {
  currentRuntime = { graveSpellCount: 0, normalSummonUsed: false, usedCounts: {}, ...runtime };
  const cards = ids.map((id, index) => ({ id, index: index + 1, usable: true,
    name: library.cards.find(card => card.id === id).name }));
  const outsideDeckCounts = { ...currentRuntime.usedCounts };
  for (const id of ids) outsideDeckCounts[id] = Number(outsideDeckCounts[id] || 0) + 1;
  for (const [id, count] of Object.entries(outsideDeckCounts)) assert.ok(count <= totals[id], id);
  currentLedger = { outsideDeckCounts };
  return context.buildDecisionSuggestion({ cards, handCount: cards.length });
}

// Complete both available searches, then offer the gamble only when targets are exhausted.
const second = decide(['M01', 'M10', 'M13', 'M22', 'M10'], { usedCounts: { M10: 1 }, graveSpellCount: 1 });
assert.strictEqual(second.selected.id, 'M10');
assert.strictEqual(second.selected.details.searchTarget.id, 'M07');
const complete = decide(['M01', 'M13', 'M22', 'M10', 'M07'], { usedCounts: { M10: 2 }, graveSpellCount: 2 });
assert.strictEqual(complete.selected.id, 'M13');
assert.strictEqual(complete.selected.details.allureLastResort, true);
assert.strictEqual(complete.result.actions.some(action => action.id === 'M10'), false);

// A no-bonus Engage search is completed even without any paired draw spell.
assert.strictEqual(decide(['M01', 'M13', 'M17']).selected.id, 'M17');
// Raye-backed Allure is normal draw2; HAMP-only Allure preserves Trade-In cost.
for (const runtime of [{}, { usedCounts: { M12: 3 } }]) {
  for (const dark of ['M06', 'M08']) {
    const result = decide([dark, 'M13', 'M16', 'M11'], runtime);
    assert.strictEqual(result.selected.id, dark === 'M06' ? 'M13' : 'M16');
    const allure = result.result.actions.find(action => action.id === 'M13');
    assert.strictEqual(allure.tier, dark === 'M06' ? 3 : 99);
    assert.strictEqual(allure.details.banishTarget.id, dark);
    if (dark === 'M08') assert.ok(result.result.actions.filter(action => !['M13', 'M11'].includes(action.id)).every(action => action.tier < allure.tier));
    assert.ok(result.result.actions.find(action => action.id === 'M11').tier > allure.tier);
    assert.strictEqual(decide([dark, 'M13', 'M11'], runtime).selected.id, 'M13');
    assert.strictEqual(decide(['M11', dark, 'M13'], runtime).selected.id, 'M13');
    const thirdSpell = decide(['M11', dark, 'M13', 'M17'], { ...runtime, graveSpellCount: 2 });
    assert.strictEqual(thirdSpell.result.actions.find(action => action.id === 'M11').tier, 100);
    assert.ok(thirdSpell.result.actions.find(action => action.id === 'M13').tier < 100);
    assert.strictEqual(decide([dark, 'M13'], runtime).selected.id, 'M13');
  }
}
assert.strictEqual(decide(['M06', 'M13', 'M14'], { bambooSwordEquipped: true }).result.actions.find(a => a.id === 'M13').tier, 3);
assert.strictEqual(decide(['M08', 'M13', 'M12']).selected.id, 'M12');
assert.strictEqual(decide(['M01', 'M13'], { chickenGameDrawPending: true }).selected.specialAction, 'M21_FIELD_DRAW');

// ISSUE-115: real revision13 after the last-equip guard closes Y1.
// Safe Allure now precedes restart Mallets too; restart protection remains
// available after current legal gains/filter draws have been exhausted.
const issue114Hand = require('../../material/issues/issue-114-hand.json');
const issue114Runtime = require('../../material/issues/issue-114-decision.json');
currentRuntime = { ...issue114Runtime, v5Branch: { ...issue114Runtime.v5Branch,
  active: false, currentState: 'EQUIPPED_YOTO_NO_SEARCH_TARGET' } };
currentLedger = require('../../material/issues/issue-114-ledger.json');
const issue115 = context.buildDecisionSuggestion(issue114Hand);
assert.strictEqual(issue114Hand.revision, 13);
assert.deepStrictEqual(issue114Hand.cards.map(card => card.id), ['EXODIA_UNKNOWN', 'M06', 'M06', 'M08', 'M11', 'M13']);
assert.strictEqual(issue115.selected.id, 'M13');
assert.strictEqual(issue115.selected.slot, 6);
assert.strictEqual(issue115.selected.details.banishTarget.id, 'M06');
assert.strictEqual(issue115.result.actions.find(action => action.id === 'M11').details.malletDeferredForSafeAllure, true);
assert.strictEqual(issue115.strategicDeadlock.terminal, false);
for (const ids of [['M06', 'M11', 'M10', 'M07', 'M13'],
  ['M13', 'M07', 'M10', 'M11', 'M06']]) {
  const restart = decide(ids, { usedCounts: { M10: 2 } });
  assert.strictEqual(restart.selected.id, 'M13', 'safe filter first even with an exact stranded Toon combination');
  const deferred = restart.result.actions.find(a => a.id === 'M11');
  assert.strictEqual(deferred.details.mallet.toonTableRestartReady, true);
  assert.strictEqual(deferred.tier, 100);
  assert.strictEqual(decide(ids.filter(id => id !== 'M13'), { usedCounts: { M10: 2 } }).selected.id, 'M11');
  const noCombination = decide(ids.filter(id => id !== 'M10'), { usedCounts: { M10: 2 } });
  assert.strictEqual(noCombination.selected.id, 'M13', 'remove Table: no special Mallet promotion');
}
const bambooRestart = decide(['M06', 'M11', 'M14', 'M19', 'M20', 'M13'], {
  usedCounts: { M19: 1 }, v5Branch: { active: false, carrierId: 'E04' } });
assert.strictEqual(bambooRestart.selected.id, 'M19', 'actual equip+Golden is draw2, not a stranded restart; P3 slot order');
assert.ok(bambooRestart.result.actions.some(a => a.id === 'M13'), 'safe Allure remains in the gain pool');
assert.strictEqual(bambooRestart.result.actions.find(a => a.id === 'M11').details.mallet.bambooRestartReady, true);
assert.strictEqual(bambooRestart.result.actions.find(a => a.id === 'M11').tier, 100);
assert.strictEqual(decide(['M06', 'M11', 'M14', 'M19', 'M20'], {
  usedCounts: { M19: 1 }, v5Branch: { active: false, carrierId: 'E04' } }).selected.id, 'M19',
  'without Allure, equip and draw Golden before washing the ready resources');
const noCarrier = decide(['M06', 'M11', 'M14', 'M19', 'M20', 'M13'], { usedCounts: { M19: 1 } });
assert.strictEqual(noCarrier.selected.id, 'M13', 'remove carrier: no Bamboo Mallet promotion');
const exhaustedEngageTargets = { usedCounts: { M06: 1, M08: 2, M22: 1 } };
const engageRestart = decide(['M06', 'M11', 'M17', 'M13'], exhaustedEngageTargets);
assert.strictEqual(engageRestart.selected.id, 'M13', 'safe filter precedes target-return restart');
assert.strictEqual(engageRestart.result.actions.find(a => a.id === 'M11').details.mallet.engageRestartReady, true);
assert.strictEqual(engageRestart.result.actions.find(a => a.id === 'M11').tier, 100);
assert.strictEqual(decide(['M06', 'M11', 'M17'], exhaustedEngageTargets).selected.id, 'M11');
assert.strictEqual(decide(['M06', 'M11', 'M13'], exhaustedEngageTargets).selected.id, 'M13',
  'remove Engage: no special Mallet promotion');
assert.strictEqual(decide(['M01', 'M11', 'M13']).selected.id, 'M11', 'no safe DARK: Mallet precedes the risky gamble');
const shortDeck = { outsideDeckCounts: { ...totals, M06: totals.M06 - 1 } };
currentLedger = shortDeck;
currentRuntime = { graveSpellCount: 7, usedCounts: {} };
const shortHand = { cards: ['M06', 'M11', 'M13'].map((id, i) => ({ id, index: i + 1, usable: true })) };
assert.strictEqual(context.buildDecisionSuggestion(shortHand).result.actions.some(action => action.id === 'M13'), false,
  'a safe DARK does not legalize draw2 from a one-card Deck');

// A stale terminal forecast cannot override any remaining modeled action in the gamble builder.
const hand = [{ id: 'M01' }, { id: 'M13', index: 2 }];
const exhaustedProof = { terminal: true, type: 'DEADLOCK' };
for (const id of ['M10', 'M17', 'M22', 'M19', 'M20', 'M09', 'M11', 'M16']) {
  assert.strictEqual(buildLastResortAllureAction(hand, {
    deck: { deckRemaining: { M06: 2, M01: 20 } }, actions: [{ id }]
  }, exhaustedProof), null, id + ' must precede Allure');
}
const noRaye = decide(['M01', 'M13'], { usedCounts: { M06: 2, M08: 2 } });
assert.strictEqual(noRaye.selected, null);
assert.strictEqual(noRaye.strategicDeadlock.terminal, true);
for (const [rel, bytes] of before) assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), 'state changed: ' + rel);
console.log('SEARCH_BEFORE_ALLURE_OFFLINE_PASS; actualOpening=M10/slot2/targetM10; safeAllure=BEFORE_MALLET; gamble=LAST; gameInputs=0; stateWrites=0');
