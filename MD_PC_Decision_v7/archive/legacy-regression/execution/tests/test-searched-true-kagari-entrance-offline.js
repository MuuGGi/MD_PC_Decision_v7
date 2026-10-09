'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..'), library = require('../../card-library.json');
const run = path.resolve(ROOT, '../runs/2026-10-04T15-47-29-509Z/game-00001');
const final = JSON.parse(fs.readFileSync(path.join(run, 'completed/decision-state.json')));
const ledger = JSON.parse(fs.readFileSync(path.join(run, 'runtime-debug/main-deck-ledger/state.json')));
const byId = Object.fromEntries(library.cards.map(row => [row.id, row]));
const remaining = Object.fromEntries(library.cards.map(row => [row.id,
  Math.max(0, row.count - (ledger.outsideDeckCounts[row.id] || 0))]));
// Reconstruct the logged point immediately after Yoto searched True, before
// True conversion and Chicken draw. Final runtime/ledger remain read-only.
remaining.M19 = 1; remaining.M08 = 1;
const runtime = { ...final, graveSpellCount: 1, fieldSpell: null,
  chickenGameDrawUsed: false, bambooSwordEquipped: false, equippedBambooId: null,
  bambooContinuationPlan: null, bambooEquipResources: null,
  usedCounts: { M22: 1, M19: 1 }, effectUsage: { M19_SEARCH: 1 },
  v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E04' } };
const engineFile = path.join(ROOT, 'lib/decision-engine.js'), native = createRequire(engineFile);
const ctx = vm.createContext({ module: { exports: {} }, console, require: id =>
  id === './main-deck-ledger' ? { getSharedDeckState: () => ({ deckRemaining: remaining,
    outsideDeckCounts: {}, ledger: {} }) } : native(id) });
vm.runInContext(fs.readFileSync(engineFile, 'utf8'), ctx);
const decide = (ids, state = runtime) => ctx.module.exports.collectActions(ids.map((id, i) =>
  ({ id, index: i + 1, name: byId[id]?.name || id, usable: true })), library, state);
const first = decide(['M07', 'M08', 'M20', 'M21']);
assert.strictEqual(first.selected.id, 'M20', 'no actual Engage/GY recovery: equip True instead of reserving a fictional gain');
assert.strictEqual(first.v5UnequippedKagariEntrance, undefined);
const done = decide(['M07', 'M08', 'M20', 'M21'], { ...runtime,
  effectUsage: { ...runtime.effectUsage, KAGARI_RECOVERY: 1 } });
assert.strictEqual(done.selected.id, 'M20', 'Kagari already used: existing equip continuation');
const golden = decide(['M07', 'M08', 'M20', 'M14']);
assert.strictEqual(golden.selected.id, 'M20', 'constructible Golden draw2 still allowed');
assert.strictEqual(golden.selected.tier, -1, 'True fixed conversion retains its layer when no immediate fire gain exists');
const engage = decide(['M07', 'M08', 'M20', 'M17']);
assert.strictEqual(engage.selected.id, 'M17', 'held Engage precedes premature True equip');
console.log('PASS test-searched-true-kagari-entrance-offline; actual G1 reconstructed; gameInputs=0; stateWrites=0');
