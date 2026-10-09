'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..'), run = path.resolve(root, '../runs/2026-10-06T10-59-05-485Z');
const library = require('../../card-library.json'), gain = require('../../lib/true-bamboo-gain-policy');
const bamboo = require('../../lib/yoto-search-value'), setup = require('../../lib/golden-bamboo-setup-policy');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const final = path.join(run, 'game-00003/completed');
const read = rel => JSON.parse(fs.readFileSync(path.join(final, rel)));
const hand = read('debug/hand-change-live/session_state.json'), runtime = read('decision-state.json');
const ledger = read('debug/main-deck-ledger/state.json');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id]?.name || id, usable: true }));
const remaining = Object.fromEntries(library.cards.map(c => [c.id, Math.max(0, c.count - Number(ledger.outsideDeckCounts[c.id] || 0))]));
const immutable = JSON.stringify({ hand, runtime, ledger });
const deck = { deckRemaining: remaining, byId, unknownExodiaOutsideCount: ledger.unknownExodiaOutsideCount };
function loadCollector(file) {
  const native = createRequire(path.join(root, 'lib/decision-engine.js'));
  const ctx = vm.createContext({ module: { exports: {} }, console, require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ ...deck, outsideDeckCounts: {}, ledger: {} }) } : native(id) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx); return ctx.module.exports;
}
const decision = loadCollector(path.join(root, 'lib/decision-engine.js'));
const old = loadCollector(path.join(run, 'engine-source/lib/decision-engine.js'));
const actual = cards(hand.cards.map(c => c.id));
assert.strictEqual(old.collectActions(actual, library, runtime).selected, null, 'actual G3 coarse unused-Kagari deferral reproduced');
assert.strictEqual(gain.planTrueBambooGain(actual, runtime, deck), null, 'no held/GY Engage means no immediate gain');
const fixed = decision.collectActions(actual, library, runtime);
assert.strictEqual(fixed.selected.id, 'M20');
assert.strictEqual(fixed.selected.details.phase, 'POST_YOTO_SEARCH_TRUE_EQUIP');
assert.strictEqual(analyzeReachableResourceDeadlock({ cards: actual, runtime, decisionResult: fixed }).terminal, false);

// Cross-carrier shared decision/executor prerequisites. A future recovery
// label, a dead Engage, or an insufficient Deck cannot hold True indefinitely.
for (const carrierId of ['E03', 'E04', 'E05']) {
  const state = { ...runtime, v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId } };
  for (const ids of [['M20'], ['M20', 'M14'], ['M20', 'M21']]) {
    assert.strictEqual(gain.planTrueBambooGain(cards(ids), state, deck), null);
    assert.strictEqual(decision.collectActions(cards(ids), library, state).selected.id, 'M20');
  }
  const held = gain.planTrueBambooGain(cards(['M20', 'M17']), state, deck);
  assert.strictEqual(held.stage, 'ENGAGE_BEFORE_TRUE'); assert.strictEqual(held.immediateGain, true);
  const recoverable = { ...state, usedCounts: { ...state.usedCounts, M17: 1 } };
  assert.strictEqual(gain.planTrueBambooGain(cards(['M20']), recoverable, deck).stage, 'KAGARI_LINK_BEFORE_TRUE');
  for (const deckRemaining of [{ M19: 1 }, { M06: 1 }]) {
    assert.strictEqual(gain.planTrueBambooGain(cards(['M20', 'M17']), recoverable, { ...deck, deckRemaining }), null);
  }
}

// G5 remains an explicitly permitted deferred search when Golden is absent;
// it must yield to an actually held Golden unless a fixed replacement exists.
const equipped = { bambooSwordEquipped: true, equippedBambooId: 'M19', v5Branch: { carrierId: 'E04' } };
const residual = { M19: 1, M20: 0, M14: 3, M17: 1, M06: 1 };
assert.strictEqual(bamboo.planEquippedBambooContinuation(residual, [], { runtime: equipped, byId }).deferredGoldenSearch, true);
for (const n of [1, 2, 3]) {
  const result = bamboo.planEquippedBambooContinuation(residual, cards(Array(n).fill('M14')), { runtime: equipped, byId });
  assert.strictEqual(result.shouldContinue, false); assert.strictEqual(result.goldenDrawPreferred, true);
  const directed = bamboo.planEquippedBambooContinuation(residual, cards(['M20', ...Array(n).fill('M14')]), { runtime: equipped, byId });
  assert.strictEqual(directed.shouldContinue, true); assert.strictEqual(directed.fixedContinuationReady, true);
}

async function verifyActualDispatch() {
  let saved = structuredClone(runtime), equips = 0;
  const main = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
  const section = (a, b) => main.slice(main.indexOf(a), main.indexOf(b, main.indexOf(a)));
  const ctx = vm.createContext({ ROOT: root, path, console: { log() {} }, ...gain, ...setup,
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    cardAtUserSlot: (state, slot) => state.cards[slot - 1],
    incrementUsedCount: (state, id) => { state.usedCounts[id] = Number(state.usedCounts[id] || 0) + 1; },
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library }
      : id.endsWith('decision-engine') ? decision : (() => { throw new Error(`unexpected require ${id}`); })(),
    equipSwordFromHand: async ({ state, cardId }) => {
      equips++; assert.strictEqual(cardId, 'M20');
      return { state: { ...state, cards: state.cards.filter(c => c.id !== cardId) }, carrier: { id: 'E04' } };
    } });
  vm.runInContext(section('function commitSwordEquipped(', 'function commitRayeNormalSummonAtomic(') +
    section('async function executeSelected(', 'function parseCommand('), ctx);
  const result = await ctx.executeSelected({ state: { ...hand, cards: actual }, slot: fixed.selected.slot });
  assert.strictEqual(result.executed, true); assert.strictEqual(equips, 1);
  assert.strictEqual(saved.v5Branch.currentState, 'M20_EQUIPPED');
  assert.strictEqual(JSON.stringify({ hand, runtime, ledger }), immutable, 'actual archived hand/state/ledger untouched');
  console.log('IMMEDIATE_KAGARI_AND_FIXED_GOLDEN_ORDER_OFFLINE_PASS; actual G3 old-null/new-True + production equip commit; immediate gain gate across carriers; fixed-chain > draw2 > speculative departure; original G5 deferred route kept; GUI/capture/live-state writes=0');
}
verifyActualDispatch().catch(error => { console.error(error); process.exitCode = 1; });
