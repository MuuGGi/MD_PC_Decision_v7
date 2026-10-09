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
const protectedPaths = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json'];
const originals = protectedPaths.filter(rel => fs.existsSync(path.join(ROOT, rel)))
  .map(rel => [rel, fs.readFileSync(path.join(ROOT, rel))]);
const fixtureHand = require('../../material/issues/issue-122-hand.json');
const fixtureRuntime = require('../../material/issues/issue-122-decision.json');
const fixtureLedger = require('../../material/issues/issue-122-ledger.json');
const immutable = JSON.stringify({ fixtureHand, fixtureRuntime, fixtureLedger });
const byId = Object.fromEntries(library.cards.map(card => [card.id, card]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, usable: true,
  name: byId[id] ? byId[id].name : id }));
let remaining = Object.fromEntries(library.cards.map(card =>
  [card.id, Math.max(0, card.count - (fixtureLedger.outsideDeckCounts[card.id] || 0))]));
const engineFile = path.join(ROOT, 'lib/decision-engine.js');
const nativeRequire = createRequire(engineFile);
const engine = vm.createContext({ module: { exports: {} }, console,
  require: id => id === './main-deck-ledger' ? { getSharedDeckState: () =>
    ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) } : nativeRequire(id) });
vm.runInContext(fs.readFileSync(engineFile, 'utf8'), engine);
const decision = engine.module.exports;
let saved = structuredClone(fixtureRuntime);
let hand = { ...structuredClone(fixtureHand), cards: cards(fixtureHand.cards.map(card => card.id)) };
const inputs = [], messages = [];
const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
function between(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return main.slice(a, b);
}
const ctx = vm.createContext({ ROOT, path, ...policy, ...gainPolicy,
  ...require('../../lib/golden-bamboo-setup-policy'),
  console: { log: value => messages.push(String(value)) },
  loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
  hornetTrueYotoWindPlan: () => null,
  cardAtUserSlot: (state, slot) => state.cards[slot - 1],
  incrementUsedCount: (runtime, id) => { runtime.usedCounts[id] = Number(runtime.usedCounts[id] || 0) + 1; },
  require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return decision;
    throw new Error(`unexpected dependency: ${id}`);
  },
  runEquippedYotoLinkToOptionalAtomic: async options => {
    assert.strictEqual(options.materialCarrierId, 'E02');
    inputs.push('Y1'); options.onOptionalPoolProven({ targetLinkId: 'E04' });
    return { targetLinkId: 'E04' };
  },
  runYotoOptionalToBambooPromptAtomic: async () => { inputs.push('Y2'); },
  runBambooPromptToResolvedAtomic: async ({ state, expectedGain }) => {
    assert.strictEqual(expectedGain, 1); assert.strictEqual(remaining.M14, 1);
    inputs.push('Y3'); remaining.M14--;
    return { state: { ...state, revision: state.revision + 1, handCount: state.handCount + 1,
      cards: cards([...state.cards.map(card => card.id), 'M14']) } };
  },
  equipSwordFromHand: async ({ state, cardId }) => {
    assert.strictEqual(cardId, 'M19'); inputs.push('EQUIP_DRAWN_M19');
    const ids = state.cards.map(card => card.id); ids.splice(ids.indexOf(cardId), 1);
    return { state: { ...state, handCount: ids.length, cards: cards(ids) }, carrier: { id: 'E04' } };
  }
});
vm.runInContext(between('function branchCarrierId(', 'function hornetTrueYotoWindPlan(') +
  between('function isHornetTokenSwordRoute(', 'function commitRayeNormalSummonAtomic(') +
  between('function commitAfterYotoResolution(', 'function normalizeCards(') +
  between('async function executeFieldTransition(', 'async function executeAtomicResponseInterval(') +
  between('async function executeSelected(', 'function parseCommand('), ctx);

async function run() {
  assert.strictEqual(hand.revision, 25);
  assert.strictEqual(fixtureLedger.lastHandRevision, 25);
  assert.strictEqual(hand.handCount, 7);
  assert.deepStrictEqual([remaining.M19, remaining.M20, remaining.M14], [1, 0, 1]);
  // Actual current saved closed branch is reopened by the normal main-loop
  // normalization, not by manually editing the live duel's JSON/checkpoints.
  ctx.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.strictEqual(saved.v5Branch.active, true);
  assert.strictEqual(ctx.isTransactionPendingNode(), true);
  assert.strictEqual(saved.bambooContinuationPlan.routeKind, 'YOTO_LINK_DEFERRED_GOLDEN');
  assert.strictEqual(saved.bambooContinuationPlan.canReplaceEquipDeterministically, false);
  assert.strictEqual(saved.bambooContinuationPlan.projectedFieldEquipId, null);
  assert.match(messages.join('\n'), /先检索金竹光，等待牌组剩余装备上手/);
  for (const [key, value] of Object.entries(fixtureRuntime)) {
    if (['v5Branch', 'bambooEquipResources', 'bambooContinuationPlan'].includes(key)) continue;
    assert.strictEqual(JSON.stringify(saved[key]), JSON.stringify(value), `committed ${key} retained`);
  }
  assert.strictEqual(JSON.stringify(hand.cards.map(card => card.id)), JSON.stringify(fixtureHand.cards.map(card => card.id)));
  assert.deepStrictEqual(inputs, [], 'hot reload sends no game input');
  const normalized = JSON.stringify(saved);
  ctx.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(JSON.stringify(saved), normalized, 'reload is idempotent');
  // Pending modal checkpoints are never rewritten into the new Y1 route.
  const ready = structuredClone(saved);
  for (const node of ['YOTO_LINK_RESOLVED', 'YOTO_SEARCH_PROMPT', 'M19_EQUIP_TARGET_PENDING']) {
    saved = { ...structuredClone(fixtureRuntime), v5Branch: { ...fixtureRuntime.v5Branch, currentState: node } };
    const pending = JSON.stringify(saved);
    ctx.normalizeEquippedYotoGoldenDrawPriority(hand);
    assert.strictEqual(JSON.stringify(saved), pending);
  }
  saved = ready;
  for (const node of ['YOTO_LINK_RESOLVED', 'YOTO_SEARCH_PROMPT', 'YOTO_SEARCH_DONE']) {
    hand = (await ctx.executeFieldTransition({ state: hand })).state;
    assert.strictEqual(saved.v5Branch.currentState, node);
  }
  assert.deepStrictEqual(inputs, ['Y1', 'Y2', 'Y3'], 'no draw/equip guessed or chained into the search');
  assert.strictEqual(saved.bambooSwordEquipped, false);
  assert.strictEqual(saved.equippedBambooId, null);
  assert.strictEqual(remaining.M19, 1, 'remaining equip is still physically in Deck');
  assert.strictEqual(saved.graveSpellCount, fixtureRuntime.graveSpellCount + 1);
  assert.strictEqual(saved.effectUsage.M19_SEARCH, fixtureRuntime.effectUsage.M19_SEARCH + 1);
  ctx.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(ctx.isTransactionPendingNode(), false, 'completed Link is not replayed');
  let choices = decision.collectActions(hand.cards, library, saved);
  assert.ok(!choices.actions.some(action => action.id === 'M14'), 'stocked Golden is unusable without field equip');
  assert.ok(choices.actions.some(action => action.id === 'M17'), 'ordinary fixed search remains available');
  // A later observed draw is modeled separately: only now may equip setup
  // enable Golden. No perpetual wait lock or fabricated Deck exit is stored.
  remaining.M19--;
  hand = { ...hand, cards: cards([...hand.cards.map(card => card.id), 'M19']), handCount: hand.handCount + 1 };
  choices = decision.collectActions(hand.cards, library, saved);
  const setup = choices.actions.find(action => action.id === 'M19');
  assert.ok(setup);
  assert.strictEqual(setup.details.enablesGoldenDraw2, true);
  hand = (await ctx.executeSelected({ state: hand, slot: setup.slot })).state;
  ctx.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  assert.strictEqual(saved.v5Branch.active, false, 'last equip is kept, not linked again');
  assert.strictEqual(saved.equippedBambooId, 'M19');
  choices = decision.collectActions(hand.cards, library, saved);
  assert.ok(choices.actions.some(action => action.id === 'M14'));
  assert.ok(choices.actions.findIndex(action => action.id === 'M17') <
    choices.actions.findIndex(action => action.id === 'M14'), 'fixed Engage still precedes Golden draw');
  assert.strictEqual(JSON.stringify({ fixtureHand, fixtureRuntime, fixtureLedger }), immutable);
  for (const [rel, content] of originals) assert.ok(content.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  console.log('DEFERRED_GOLDEN_CURRENT_RESUME_OFFLINE_PASS; actual rev25 in-duel reopen; Y1/Y2/Y3 only; wait no fake equip; later equip/Engage priority; live stateWrites0/gameInputs0');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
