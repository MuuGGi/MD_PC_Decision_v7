'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..'), RUN = path.resolve(ROOT, '../runs/2026-10-05T02-11-41-105Z');
const library = require('../../card-library.json'), byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
let remaining;
function collector(file) {
  const native = createRequire(file), ctx = vm.createContext({ console, module: { exports: {} },
    require: id => id === './main-deck-ledger' ? { getSharedDeckState: () =>
      ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) } : native(id) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx); return ctx.module.exports.collectActions;
}
const current = collector(path.join(ROOT, 'lib/decision-engine.js'));
const previous = collector(path.join(RUN, 'engine-source/lib/decision-engine.js'));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id]?.name || id, usable: true }));
function prepare(hand, state, overrides = {}) {
  const counts = hand.reduce((out, c) => (out[c.id] = (out[c.id] || 0) + 1, out), {});
  remaining = Object.fromEntries(library.cards.map(c => [c.id,
    Math.max(0, c.count - (counts[c.id] || 0) - (state.usedCounts?.[c.id] || 0))]));
  Object.assign(remaining, overrides);
}
function result(ids, state, overrides = {}) {
  const hand = cards(ids); prepare(hand, state, overrides); return current(hand, library, state);
}
const games = JSON.parse(fs.readFileSync(path.join(RUN, 'summary.json'))).games;
assert.deepStrictEqual(games.map(g => g.outcome), ['SURRENDER', 'WIN', 'SURRENDER', 'WIN', 'WIN']);
// Actual post-dual gain hands are embedded in the NEXT Engage's incremental
// receipt. Read those before snapshots, not invented ideal hands or new PNGs.
for (const n of [4, 5]) {
  const dir = path.join(RUN, `game-${String(n).padStart(5, '0')}/runtime-debug/execution/M17_engage_bonus_draw`);
  const prefix = n === 4 ? '2026-10-05T02-30' : '2026-10-05T02-37';
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.startsWith(prefix)), 'hand_incremental_result.json')));
  const hand = receipt.before.cards.map((c, i) => ({ ...c, index: i + 1, usable: true }));
  const state = { graveSpellCount: n === 4 ? 5 : 3, bambooSwordEquipped: false,
    usedCounts: { M10: n === 4 ? 3 : 0, M22: 1, M19: 1 },
    effectUsage: { KAGARI_RECOVERY: 1, M19_SEARCH: 1 },
    v5Branch: { active: false, currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02', trueBambooGainBeforeEquip: true } };
  prepare(hand, state, { M19: 1, M20: 0 });
  assert.strictEqual(previous(hand, library, state).selected.id, 'M17', `reproduce G${n} stale bonus priority`);
  const fixed = current(hand, library, state);
  assert.strictEqual(fixed.selected.id, 'M20');
  assert.strictEqual(fixed.selected.details.phase, 'POST_KAGARI_RECOVERY_TRUE_FIRST');
  assert.ok(!fixed.trueBambooGainPolicy, 'completed Kagari route cannot keep leasing gain priority');
}
function malletBefore(n) {
  const dir = path.join(RUN, `game-${String(n).padStart(5, '0')}/runtime-debug/execution/M11_mallet_keep_weapon`);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'result.json')));
  const hand = [...receipt.selectionProof.rows.map(r => r.card), ...receipt.selectionProof.protectedRemaining];
  const usedSlots = new Set(hand.map(c => c.originalSlot));
  const activatedSlot = Array.from({ length: receipt.beforeHandCount }, (_, i) => i + 1).find(i => !usedSlots.has(i));
  hand.push({ id: 'M11', originalSlot: activatedSlot });
  return hand.sort((a, b) => a.originalSlot - b.originalSlot)
    .map((c, i) => ({ ...c, index: i + 1, usable: true }));
}
const g5 = malletBefore(5);
assert.deepStrictEqual(g5.map(c => c.id), ['M06', 'M07', 'M08', 'M10', 'M11', 'M14']);
const g5state = { graveSpellCount: 10, bambooSwordEquipped: true, equippedBambooId: 'M19',
  usedCounts: { M10: 2, M22: 1, M19: 1, M20: 1, M17: 2, M15: 2, M12: 1, M13: 1, M08: 1 },
  effectUsage: { KAGARI_RECOVERY: 1, M19_SEARCH: 1 },
  v5Branch: { active: false, currentState: 'GOLDEN_BAMBOO_DRAW_READY', carrierId: 'E02' } };
prepare(g5, g5state);
assert.strictEqual(previous(g5, library, g5state).selected.id, 'M11', 'reproduce actual G5 usable Golden shuffled away');
assert.strictEqual(current(g5, library, g5state).selected.id, 'M14', 'draw2 first, then recompute current hand before shuffle');
assert.strictEqual(result(g5.filter(c => c.id !== 'M14').map(c => c.id), g5state).selected.id, 'M11',
  'after gains exhausted, restore protected Toon restart');
const g2 = malletBefore(2), g2state = { ...g5state, graveSpellCount: 16,
  usedCounts: { M10: 3, M22: 1, M06: 1, M13: 1, M20: 1, M19: 1, M14: 2, M17: 2 },
  v5Branch: { active: false, currentState: 'GOLDEN_BAMBOO_DRAW_READY', carrierId: 'E04' } };
prepare(g2, g2state, { M06: 0, M08: 0, M22: 0 });
assert.strictEqual(previous(g2, library, g2state).selected.id, 'M11');
assert.strictEqual(current(g2, library, g2state).selected.id, 'M15', 'actual G2: legal filter before target-return restart');
const base = { graveSpellCount: 3, bambooSwordEquipped: false, usedCounts: { M10: 2 },
  v5Branch: { currentState: 'IDLE', carrierId: 'E03' } };
const heldTargets = ['M11', 'M10', 'M07', 'M06', 'M08', 'M17'];
for (const ids of [heldTargets, heldTargets.slice().reverse()]) {
  const decision = result(ids, base, { M10: 0, M07: 0, M06: 1, M08: 1 });
  assert.strictEqual(decision.selected.id, 'M17', 'holding Raye/HAMP never suppresses available bonus gain');
  assert.strictEqual(decision.actions.find(a => a.id === 'M11').tier, 100);
}
assert.strictEqual(result(heldTargets, { ...base, engageBlockedByMainMonster: true }, { M10: 0, M07: 0 }).selected.id, 'M11');
assert.strictEqual(result(['M11', 'M10', 'M07', 'M14'], base, { M10: 0, M07: 0 }).selected.id, 'M11',
  'no equipped sword: do not invent Golden draw2');
const bridge = result(['M11', 'M17', 'M08'], { graveSpellCount: 2 });
assert.strictEqual(bridge.selected.id, 'M11', 'no other draw: Mallet supplies third spell for bonus, keep mature bridge');
assert.ok(bridge.selected.details.mallet.keepIds.includes('M17'));
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
for (const n of [1, 3]) {
  const gameDir = path.join(RUN, `game-${String(n).padStart(5, '0')}`);
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'completed/decision-state.json')));
  const hand = JSON.parse(fs.readFileSync(path.join(gameDir, 'runtime-debug/hand-change-live/session_state.json'))).cards;
  const ledger = JSON.parse(fs.readFileSync(path.join(gameDir, 'runtime-debug/main-deck-ledger/state.json')));
  remaining = Object.fromEntries(library.cards.map(c => [c.id,
    Math.max(0, c.count - (ledger.outsideDeckCounts[c.id] || 0))]));
  const decision = current(hand.map(c => ({ ...c, usable: true })), library, state);
  assert.strictEqual(decision.selected, null, `G${n} terminal/before-last-Allure has no ordinary gain`);
  assert.strictEqual(analyzeReachableResourceDeadlock({ cards: hand, runtime: state, decisionResult: decision }).terminal, true);
}
assert.strictEqual(games[2].resultProof.failureProof.status, 'NO_SAFE_DARK_IN_PROMPT');
assert.deepStrictEqual(games[2].resultProof.failureProof.seen.map(c => c.card.id).sort(), ['M01', 'M04']);
console.log('PASS test-oct05-gain-before-shuffle-offline; actual G4/G5 recovered True; G5 Golden/G2 filter before M11; holdings/order/illegal gates; gameInputs=0/stateWrites=0');
