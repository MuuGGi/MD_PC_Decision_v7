'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const valuePolicy = require('../../lib/yoto-search-value');
const gainPolicy = require('../../lib/true-bamboo-gain-policy');

// Execute the actual decision module with an in-memory shared ledger. Neither
// the current duel nor the disk ledger may influence this regression.
const decisionFile = path.join(ROOT, 'lib/decision-engine.js');
const realRequire = createRequire(decisionFile);
let deckRemaining;
const decisionContext = vm.createContext({
  module: { exports: {} }, console,
  require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ deckRemaining, outsideDeckCounts: {}, ledger: {} }) }
    : realRequire(id)
});
vm.runInContext(fs.readFileSync(decisionFile, 'utf8'), decisionContext);
const { collectActions } = decisionContext.module.exports;
const runtime = {
  graveSpellCount: 2, bambooSwordEquipped: false,
  // This regression exercises continued Bamboo searches AFTER Kagari's
  // recovery opportunity is spent. The unspent gain route has separate tests.
  effectUsage: { M19_SEARCH: 1, KAGARI_RECOVERY: 1 },
  usedCounts: { M19: 1, M22: 1 },
  v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E04' }
};
function cards(ids) {
  return ids.map((id, i) => ({ id, index: i + 1, usable: true,
    name: library.cards.find(card => card.id === id).name }));
}
function decide(ids, deckOverrides = {}, stateOverrides = {}) {
  deckRemaining = Object.fromEntries(library.cards.filter(card => /^M\d+$/.test(card.id))
    .map(card => [card.id, Math.max(0, card.count - ids.filter(id => id === card.id).length)]));
  Object.assign(deckRemaining, { M19: 0, M20: 0, M22: 0 }, deckOverrides);
  return collectActions(cards(ids), library, { ...runtime, ...stateOverrides });
}
const phase = 'POST_YOTO_SEARCH_HAND_YOTO_REPEAT_SEARCH';
const currentIds = ['M01', 'M12', 'M17', 'M19', 'M20'];
const live = decide(currentIds);
assert.strictEqual(live.selected.id, 'M19');
assert.strictEqual(live.selected.slot, 4);
assert.strictEqual(live.selected.details.phase, phase);
assert.strictEqual(live.deck.deckRemaining.M19, 0);
assert.strictEqual(live.deck.deckRemaining.M20, 0);
assert.strictEqual(live.deck.deckRemaining.M14, 3);

// Fixed search before random draw and no-bonus Engage, but Toon stays P0.
assert.strictEqual(decide([...currentIds, 'M15']).selected.details.phase, phase);
assert.strictEqual(decide([...currentIds, 'M14']).selected.details.phase, phase,
  'held Golden does not outrank the proven fixed search+held replacement chain');
assert.strictEqual(decide([...currentIds, 'M14']).selected.tier, -1);
assert.strictEqual(decide([...currentIds, 'M10']).selected.id, 'M10');
// Consume the selected Yoto before checking replacement equipment. With no
// spare in hand/Deck, do not create a repeat-Link route for unusable Golden.
const deferred = decide(currentIds.filter(id => id !== 'M20'));
assert.notStrictEqual(deferred.selected.details.phase, phase);
assert.strictEqual(deferred.deck.bambooEquipResources.deckCount, 0);
assert.strictEqual(deferred.deck.bambooEquipResources.handCount, 1, 'this is the copy the proposed equip would consume');
const futureEquipInDeck = decide(currentIds.filter(id => id !== 'M20'), { M19: 1 });
assert.strictEqual(futureEquipInDeck.selected.details.phase, phase, 'ISSUE-122: stock absent Golden for the other Deck Yoto');
assert.match(futureEquipInDeck.selected.reason, /延后检索金竹光/);
assert.notStrictEqual(decide([...currentIds.filter(id => id !== 'M20'), 'M14'], { M19: 1 }).selected.details.phase,
  phase, 'held Golden with no immediate replacement must not enter the deferred branch');
assert.strictEqual(decide(['M19', 'M19']).selected.details.phase, phase);
assert.notStrictEqual(decide(currentIds, { M14: 0, M20: 0 }).selected.details.phase, phase);
assert.notStrictEqual(decide(currentIds, {}, {
  v5Branch: { ...runtime.v5Branch, carrierId: null }
}).selected.details.phase, phase);
assert.notStrictEqual(decide(currentIds, {}, { bambooSwordEquipped: true }).selected.details.phase, phase);
assert.strictEqual(decide(currentIds, { M19: 1 }).selected.details.phase, 'POST_YOTO_SEARCH_TRUE_EQUIP');
assert.strictEqual(decide(['M19'], { M20: 1 }).selected.details.phase, phase);
const rayeState = { rayeNormalSummoned: true,
  v5Branch: { currentState: 'RAYE_NORMAL_SUMMONED', carrierId: 'M06', rayeOnlyMonster: true } };
assert.strictEqual(decide(['M19', 'M11', 'M15'], {}, rayeState).selected.details.phase,
  'RAYE_YOTO_BEFORE_DIRECT_E10_DUAL_SEARCH', 'equip before Raye effect even without held Golden/spare True');
assert.strictEqual(decide(['M20', 'M11'], { M19: 1 }, rayeState).selected.details.phase,
  'RAYE_LAST_CARRIER_TRUE_BEFORE_EFFECT');

// After the second search, True Bamboo alone is a real draw-2 setup. Keep the
// ordinary draw-1 ordering and the established Yoto-in-hand draw-ready route.
const goldenIds = ['M01', 'M12', 'M17', 'M20', 'M14'];
const golden = decide(goldenIds);
assert.strictEqual(golden.selected.id, 'M20');
assert.strictEqual(golden.selected.tier, 3);
assert.strictEqual(golden.selected.details.enablesGoldenDraw2, true);
assert.strictEqual(golden.selected.details.phase, 'POST_YOTO_SEARCH_EQUIP_TRUE_FOR_GOLDEN_DRAW2');
assert.strictEqual(decide([...goldenIds, 'M15']).selected.id, 'M15');
assert.strictEqual(decide(['M11', 'M19', 'M14']).selected.details.enablesGoldenDraw2, true);
assert.strictEqual(decide(['M11', 'M19', 'M14', 'M15']).selected.id, 'M15');
assert.strictEqual(decide(goldenIds, { M19: 1 }).selected.details.phase, 'POST_YOTO_SEARCH_TRUE_EQUIP');

const runtimeSource = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
function productionBetween(start, end) {
  const from = runtimeSource.indexOf(start);
  const to = runtimeSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `runtime boundaries: ${start}`);
  return runtimeSource.slice(from, to);
}
const production = productionBetween('function commitSwordEquipped(', 'function commitRayeNormalSummonAtomic(') +
  productionBetween('function branchCarrierId(', 'function setAtomicBranch(') +
  productionBetween('function buildEquippedBambooContinuationPlan(', 'const TRANSACTION_PENDING_NODES') +
  productionBetween('async function executeSelected(', 'function parseCommand(');
function runtimeHarness(yotoInDeck = 0) {
  let saved = structuredClone(runtime);
  let equipInputs = 0;
  const context = vm.createContext({
    ROOT, path, console: { log() {} },
    ...valuePolicy,
    ...gainPolicy,
    ...require('../../lib/golden-bamboo-setup-policy'),
    loadDecisionState: () => saved,
    saveDecisionState: state => { saved = state; },
    incrementUsedCount: (state, id) => { state.usedCounts[id] = Number(state.usedCounts[id] || 0) + 1; },
    cardAtUserSlot: (state, slot) => state.cards[slot - 1],
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library }
      : { buildDeckState: () => ({ deckRemaining: { M19: yotoInDeck, M20: 0, M14: 2 } }),
        collectActions: () => ({ actions: [] }) },
    equipSwordFromHand: async ({ state, cardId }) => {
      equipInputs++;
      const next = state.cards.slice();
      next.splice(next.findIndex(card => card.id === cardId), 1);
      return { state: { cards: next }, carrier: { id: 'E04' } };
    }
  });
  vm.runInContext(production, context);
  return { context, get saved() { return saved; }, get equipInputs() { return equipInputs; } };
}
async function main() {
  const trueWithoutTarget = runtimeHarness();
  await trueWithoutTarget.context.executeSelected({ state: { cards: cards(['M20']) }, slot: 1 });
  assert.strictEqual(trueWithoutTarget.saved.v5Branch.active, false,
    'no Deck Yoto means no T20 even when Golden is not held');
  assert.strictEqual(trueWithoutTarget.saved.equippedBambooId, 'M20');
  const trueDraw = runtimeHarness();
  await trueDraw.context.executeSelected({ state: { cards: cards(goldenIds) }, slot: 4 });
  assert.strictEqual(trueDraw.equipInputs, 1);
  assert.strictEqual(trueDraw.saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  assert.strictEqual(trueDraw.saved.v5Branch.active, false);
  assert.strictEqual(trueDraw.saved.v5Branch.goldenDrawEquipId, 'M20');
  trueDraw.context.normalizeEquippedYotoGoldenDrawPriority({ cards: cards(['M20', 'M11']) });
  assert.strictEqual(trueDraw.saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY',
    'after drawing the last Golden, a True equip must not reopen Y1');

  const trueConvert = runtimeHarness(1);
  await trueConvert.context.executeSelected({ state: { cards: cards(goldenIds) }, slot: 4 });
  assert.strictEqual(trueConvert.saved.v5Branch.currentState, 'M20_EQUIPPED');
  assert.strictEqual(trueConvert.saved.v5Branch.active, true);

  const repeat = runtimeHarness();
  await repeat.context.executeSelected({ state: { cards: cards(currentIds) }, slot: 4 });
  assert.strictEqual(repeat.saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.strictEqual(repeat.saved.effectUsage.M19_SEARCH, 1);
  repeat.context.normalizeEquippedYotoGoldenDrawPriority({ cards: cards(['M20']) });
  assert.strictEqual(repeat.saved.v5Branch.currentState, 'M19_EQUIPPED');

  const yotoDraw = runtimeHarness();
  await yotoDraw.context.executeSelected({ state: { cards: cards(['M19', 'M14']) }, slot: 1 });
  yotoDraw.context.normalizeEquippedYotoGoldenDrawPriority({ cards: cards(['M14']) });
  assert.strictEqual(yotoDraw.saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  console.log('YOTO_REPEAT_SEARCH_OFFLINE_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
