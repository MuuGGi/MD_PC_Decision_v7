'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..'), run = path.resolve(root, '../runs/2026-10-06T12-59-37-858Z');
const library = require('../../card-library.json'), policy = require('../../lib/yoto-search-value');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id]?.name || id, usable: true }));
const end = path.join(run, 'game-00001/completed'), read = rel => JSON.parse(fs.readFileSync(path.join(end, rel)));
const hand = read('debug/hand-change-live/session_state.json'), runtime = read('decision-state.json');
const ledger = read('debug/main-deck-ledger/state.json');
const immutable = JSON.stringify({ hand, runtime, ledger });
let remaining = Object.fromEntries(library.cards.map(c => [c.id, Math.max(0, c.count - Number(ledger.outsideDeckCounts[c.id] || 0))]));
function moduleAt(file) {
  const native = createRequire(path.join(root, 'lib/decision-engine.js'));
  const ctx = vm.createContext({ module: { exports: {} }, console, require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ deckRemaining: remaining, outsideDeckCounts: {},
      unknownExodiaOutsideCount: ledger.unknownExodiaOutsideCount, ledger: {} }) } : native(id) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx); return ctx.module.exports;
}
const decision = moduleAt(path.join(root, 'lib/decision-engine.js'));
assert.strictEqual(moduleAt(path.join(run, 'engine-source/lib/decision-engine.js')).collectActions(hand.cards, library, runtime).selected, null);
const result = decision.collectActions(hand.cards, library, runtime);
assert.strictEqual(result.selected.id, 'M20'); assert.strictEqual(result.selected.slot, 5);
assert.strictEqual(result.selected.details.phase, 'CURRENT_RESOURCE_TRUE_EQUIP');
assert.strictEqual(analyzeReachableResourceDeadlock({ cards: hand.cards, runtime, decisionResult: result }).terminal, false);
let cases = 0;
for (const node of ['IDLE', 'BRANCH_COMPLETE', 'E10_EFFECT_RESOLVED', 'KAGARI_RECOVERY_DONE', 'YOTO_SEARCH_DONE']) {
  for (const carrierId of ['E02', 'E04', 'E10', 'TOKEN_SKY_STRIKER']) {
    const state = { ...runtime, v5Branch: { active: false, currentState: node, carrierId } };
    const selected = decision.collectActions(cards(['M20', 'M15']), library, state).selected;
    assert.strictEqual(selected.id, 'M20', `${node}/${carrierId}: current resources, not acquisition label`);
    assert.strictEqual(decision.collectActions(cards(['M20', 'M10']), library, state).selected.id, 'M10');
    cases++;
  }
}
for (const patch of [{ bambooSwordEquipped: true }, { v5Branch: {} },
  { v5Branch: { carrierId: 'UNKNOWN' } },
  { v5Branch: { carrierId: 'E10', active: true, currentState: 'SOME_TRANSACTION' } },
  { v5Branch: { carrierId: 'E10', active: false, currentState: 'DUAL_E10_TARGET_PROMPT' } }]) {
  assert.strictEqual(policy.planTrueBambooConversionSetup(cards(['M20']), { ...runtime, ...patch }, { deckRemaining: remaining }), null);
}
assert.strictEqual(policy.planTrueBambooConversionSetup(cards(['M20']), runtime, { deckRemaining: { M19: 0 } }), null);
assert.strictEqual(policy.planTrueBambooConversionSetup(cards(['M20']), runtime,
  { deckRemaining: { M19: 1 }, unknownExodiaOutsideCount: 1 }), null);
assert.strictEqual(policy.planTrueBambooConversionSetup(cards(['M20']), { ...runtime, rayeNormalSummoned: false,
  v5Branch: { carrierId: 'M06' } }, { deckRemaining: remaining }), null);
assert.ok(policy.planTrueBambooConversionSetup(cards(['M20']), { ...runtime, rayeNormalSummoned: true,
  v5Branch: { carrierId: 'M06', currentState: 'RAYE_NORMAL_SUMMONED', active: true } }, { deckRemaining: remaining }));

async function testDispatch() {
  let saved = structuredClone(runtime), equipCalls = 0;
  const main = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
  const section = (a, b) => main.slice(main.indexOf(a), main.indexOf(b, main.indexOf(a)));
  const ctx = vm.createContext({ ROOT: root, path, console: { log() {} },
    ...require('../../lib/true-bamboo-gain-policy'), ...require('../../lib/golden-bamboo-setup-policy'),
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    cardAtUserSlot: (s, n) => s.cards[n - 1],
    incrementUsedCount: (s, id) => { s.usedCounts[id] = Number(s.usedCounts[id] || 0) + 1; },
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library } : decision,
    equipSwordFromHand: async ({ state, cardId }) => {
      equipCalls++; assert.strictEqual(cardId, 'M20');
      return { state: { ...state, cards: state.cards.filter(c => c.id !== cardId) }, carrier: { id: 'E10' } };
    } });
  vm.runInContext(section('function commitSwordEquipped(', 'function commitRayeNormalSummonAtomic(') +
    section('async function executeSelected(', 'function parseCommand('), ctx);
  assert.strictEqual((await ctx.executeSelected({ state: hand, slot: result.selected.slot })).executed, true);
  assert.strictEqual(equipCalls, 1); assert.strictEqual(saved.v5Branch.currentState, 'M20_EQUIPPED');
  assert.strictEqual(saved.v5Branch.carrierId, 'E10');
  assert.strictEqual(JSON.stringify({ hand, runtime, ledger }), immutable);
  console.log(`CURRENT_TRUE_CONVERSION_ENTRY_OFFLINE_PASS; actual G1 old-null/new-True + actual equip commit; ${cases} node/carrier variants; pending/unknown/Deck/field/Toon guards; GUI/live-state writes=0`);
}
testDispatch().catch(error => { console.error(error); process.exitCode = 1; });
