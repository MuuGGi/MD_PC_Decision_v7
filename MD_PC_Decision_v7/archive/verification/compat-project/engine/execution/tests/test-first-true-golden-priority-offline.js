'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const policy = require('../../lib/yoto-search-value');
const gainPolicy = require('../../lib/true-bamboo-gain-policy');
const { atomicContinuationDecision } = require('../../lib/atomic-response-continuation-policy');
const protectedPaths = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json'];
const originals = protectedPaths.filter(rel => fs.existsSync(path.join(ROOT, rel)))
  .map(rel => [rel, fs.readFileSync(path.join(ROOT, rel))]);
const liveHand = require('../../material/issues/issue-121-hand.json');
const liveRuntime = require('../../material/issues/issue-121-decision.json');
const liveLedger = require('../../material/issues/issue-121-ledger.json');
const byId = Object.fromEntries(library.cards.map(card => [card.id, card]));
let remaining = Object.fromEntries(library.cards.map(card =>
  [card.id, Math.max(0, card.count - (liveLedger.outsideDeckCounts[card.id] || 0))]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id] ? byId[id].name : id, usable: true }));
const engineFile = path.join(ROOT, 'lib/decision-engine.js');
const nativeRequire = createRequire(engineFile);
const engine = vm.createContext({ module: { exports: {} }, console,
  require: id => id === './main-deck-ledger' ? { getSharedDeckState: () =>
    ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) } : nativeRequire(id) });
vm.runInContext(fs.readFileSync(engineFile, 'utf8'), engine);
const decision = engine.module.exports;
const decide = (hand, runtime) => decision.collectActions(hand.cards, library, runtime);
const current = { ...liveHand, cards: cards(liveHand.cards.map(card => card.id)) };
assert.strictEqual(decide(current, liveRuntime).selected.id, 'M22', 'no carrier yet: keep Hornet -> Kagari recovery');

// After the fixed Hornet/Kagari route, the recovered Engage is held alongside
// True + two Goldens. Run actual hand selection and all actual T20 commits.
let saved = { ...structuredClone(liveRuntime), usedCounts: { ...liveRuntime.usedCounts, M22: 1, M17: 0 },
  v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02', active: false } };
let hand = { revision: 5, handCount: 5, cards: cards(['EXODIA_UNKNOWN', 'M14', 'M14', 'M20', 'M17']) };
const calls = [];
const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
function between(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return main.slice(a, b);
}
const ctx = vm.createContext({ ROOT, path, ...policy, ...gainPolicy,
  ...require('../../lib/golden-bamboo-setup-policy'), console: { log() {} },
  fs: { existsSync: () => false }, INCREMENTAL_PATH: 'NO_FILE', DECISION_STATE_PATH: 'MEMORY',
  GRAVE_AFTER_RESOLVE: new Set(['M14', 'M17']),
  loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
  writeJsonAtomic: (file, value) => { assert.strictEqual(file, 'MEMORY'); saved = value; },
  cardAtUserSlot: (state, slot) => state.cards[slot - 1],
  hornetTrueYotoWindPlan: () => null,
  require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return decision;
    if (id.endsWith('main-deck-ledger')) return { commitKnownDeckExit: id => {
      assert.strictEqual(id, 'M19'); remaining.M19--; calls.push('DECK_EXIT_M19'); } };
    throw new Error(`unexpected dependency: ${id}`);
  },
  equipSwordFromHand: async ({ state, cardId }) => {
    assert.strictEqual(cardId, 'M20'); calls.push('TRUE_EQUIP');
    const next = state.cards.filter(card => card.id !== 'M20');
    return { state: { ...state, handCount: next.length, cards: cards(next.map(card => card.id)) }, carrier: { id: 'E02' } };
  },
  runM20FieldEffectToDeckPromptAtomic: async () => { calls.push('T20_1'); },
  runM20SelectYotoFromDeckAtomic: async () => { calls.push('T20_2'); },
  runM20EquipSelectedYotoAtomic: async ({ expectedCarrierId }) => {
    assert.strictEqual(expectedCarrierId, 'E02'); calls.push('T20_3'); },
  runEquippedYotoLinkToOptionalAtomic: async () => { throw new Error('UNEXPECTED_LINK'); }
});
vm.runInContext(between('function branchCarrierId(', 'function hornetTrueYotoWindPlan(') +
  between('function isHornetTokenSwordRoute(', 'function commitRayeNormalSummonAtomic(') +
  between('function incrementUsedCount(', 'function m21ReplacementUnlocksEngage(') +
  between('async function executeFieldTransition(', 'async function executeAtomicResponseInterval(') +
  between('async function executeSelected(', 'function parseCommand('), ctx);

async function run() {
  const choice = decide(hand, saved).selected;
  assert.strictEqual(choice.id, 'M20');
  assert.strictEqual(choice.details.phase, 'FIRST_TRUE_GOLDEN_FIXED_EQUIP');
  assert.strictEqual(choice.tier, -1, 'True -> Deck Yoto belongs to fixed resources, not random draw2 setup');
  assert.strictEqual(decide({ ...hand, cards: cards([...hand.cards.map(card => card.id), 'M10']) }, saved).selected.id, 'M10',
    'Toon Table remains first among fixed resources');
  assert.strictEqual(decide(hand, { ...saved, v5Branch: { currentState: 'IDLE', carrierId: 'E03' } }).selected.id, 'M20',
    'first True+Golden is not a Kagari-only patch');
  const plan = (ids, deck, runtime = saved) => policy.planEquippedBambooContinuation(deck, cards(ids), { runtime, byId });
  assert.strictEqual(plan(['M20', 'M14', 'M19'], remaining).firstTrueGoldenSetup, false);
  assert.strictEqual(plan(['M20', 'M14'], { ...remaining, M19: 1 }).firstTrueGoldenSetup, false);
  assert.strictEqual(plan(['M20'], remaining).firstTrueGoldenSetup, false);
  assert.strictEqual(plan(['M20', 'M14'], remaining, { ...saved, usedCounts: { M20: 1 } }).firstTrueGoldenSetup, false);
  assert.strictEqual(plan(['M20', 'M14'], remaining, { ...saved, rayeNormalSummoned: true,
    v5Branch: { currentState: 'RAYE_NORMAL_SUMMONED', carrierId: 'M06' } }).prepareEquipId, 'M20',
    'Raye equip-before-direct-dual route remains separate');
  const equipped = await ctx.executeSelected({ state: hand, slot: choice.slot });
  hand = equipped.state;
  assert.strictEqual(saved.v5Branch.currentState, 'M20_EQUIPPED');
  await ctx.executeFieldTransition({ state: hand });
  await ctx.executeFieldTransition({ state: hand });
  await ctx.executeFieldTransition({ state: hand });
  assert.deepStrictEqual(calls, ['TRUE_EQUIP', 'T20_1', 'T20_2', 'T20_3', 'DECK_EXIT_M19']);
  assert.strictEqual(saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  assert.strictEqual(saved.v5Branch.active, false);
  assert.strictEqual(saved.equippedBambooId, 'M19');
  assert.strictEqual(saved.graveSpellCount, liveRuntime.graveSpellCount + 1);
  assert.strictEqual(remaining.M19, 1);
  assert.strictEqual(atomicContinuationDecision('M19_SELECTED_FROM_DECK', 'GOLDEN_BAMBOO_DRAW_READY').autoContinue, false);
  const afterSetup = decide(hand, saved);
  assert.strictEqual(afterSetup.selected.id, 'M17', 'recovered Engage still precedes Golden after fixed conversion');
  assert.strictEqual(afterSetup.actions.find(row => row.id === 'M14').tier, 3);
  // Fixed-search resolution changes the hand; it does not invent a draw lock.
  hand = { ...hand, cards: cards(['EXODIA_UNKNOWN', 'M14', 'M14', 'M08']), handCount: 4 };
  ctx.updateDecisionStateAfterSuccess({ id: 'M17' }, structuredClone(saved));
  assert.strictEqual(decide(hand, saved).selected.id, 'M14');
  assert.deepStrictEqual(calls, ['TRUE_EQUIP', 'T20_1', 'T20_2', 'T20_3', 'DECK_EXIT_M19'], 'no draw/Link issued by T20');

  // A drawn spare closes the fixed search/replacement chain. The user's
  // fixed-chain layer remains higher than an ordinary Golden draw-2.
  const later = policy.planEquippedBambooContinuation(remaining, cards(['M19', 'M14']), { runtime: saved, byId });
  assert.strictEqual(later.shouldLink, true);
  assert.strictEqual(later.goldenDrawReady, true);
  assert.strictEqual(later.fixedContinuationReady, true);
  assert.strictEqual(policy.planEquippedBambooContinuation(remaining, cards(['M19']),
    { runtime: saved, byId }).shouldLink, true);
  for (const [rel, bytes] of originals) assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  console.log('FIRST_TRUE_GOLDEN_PRIORITY_OFFLINE_PASS; actual rev3 next Hornet; True fixed -> actual T20 -> Engage -> Golden; no macro draw/Link; fixed spare chain before ordinary Golden; stateWrites0/gameInputs0');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
