'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const hand = require('../../material/issues/issue-116-hand.json');
const runtime = require('../../material/issues/issue-116-decision.json');
const ledger = require('../../material/issues/issue-116-ledger.json');
const { buildMalletKeepPolicy } = require('../../lib/mallet-policy');
const { adjustedMainDeckRemainingCount } = require('../../lib/exodia-policy');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const protectedPaths = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/observer_state.json'];
const before = protectedPaths.map(rel => [rel, fs.existsSync(path.join(ROOT, rel))
  ? fs.readFileSync(path.join(ROOT, rel)) : null]);

// Boundary matrix: 0..5 components, Deck 0..6, generic and legacy aliases.
// The exception requires BOTH Deck<=5 AND count>=4; no exact identity gate.
for (let remaining = 0; remaining <= 6; remaining++) {
  for (let count = 0; count <= 5; count++) {
    for (const generic of [true, false]) {
      const components = Array.from({ length: count }, (_, i) => ({
        id: generic ? 'EXODIA_UNKNOWN' : `M0${i + 1}`, persistentExodia: generic
      }));
      const cards = [...components, { id: 'M11' }, { id: 'M16' }];
      const policy = buildMalletKeepPolicy({ deckRemaining: { M16: remaining }, byId: {} }, cards);
      const expected = remaining <= 5 && count >= 4;
      assert.strictEqual(policy.protectExodiaComponents, expected);
      assert.strictEqual(policy.exodiaComponentCount, count);
      assert.strictEqual(policy.returnableCount, 1 + (expected ? 0 : count));
      assert.strictEqual(policy.keepIds.length > 0, expected);
    }
  }
}
const genericFour = Array.from({ length: 4 }, () => ({ id: 'EXODIA_UNKNOWN' }));
const adjusted = buildMalletKeepPolicy({ deckRemaining: { M01: 1, M02: 1, M03: 1, M04: 1, M05: 1, M16: 3 },
  unknownExodiaOutsideCount: 4 }, [...genericFour, { id: 'M11' }, { id: 'M16' }]);
assert.strictEqual(adjusted.deckRemaining, 4, 'subtract aggregate components before evaluating Deck<=5');
assert.strictEqual(adjusted.protectExodiaComponents, true);

// Real production collector, read-only snapshot; no bridge and no live ledger.
const totals = Object.fromEntries(library.cards.filter(card => /^M\d+$/.test(card.id)).map(card => [card.id, card.count]));
const remaining = Object.fromEntries(Object.entries(totals).map(([id, total]) =>
  [id, total - Number(ledger.outsideDeckCounts[id] || 0)]));
const engineFile = path.join(ROOT, 'lib/decision-engine.js');
const nativeEngineRequire = createRequire(engineFile);
const engineModule = { exports: {} };
vm.runInNewContext(read('lib/decision-engine.js'), { module: engineModule, exports: engineModule.exports,
  console, require: id => id === './main-deck-ledger' ? { getSharedDeckState: () => ({
    deckRemaining: remaining, ledger, outsideDeckCounts: ledger.outsideDeckCounts,
    unknownExodiaOutsideCount: ledger.unknownExodiaOutsideCount
  }) } : nativeEngineRequire(id) });
const result = engineModule.exports.collectActions(hand.cards.map(card => ({ ...card, usable: true })), library, runtime);
assert.deepStrictEqual(hand.cards.map(card => card.id),
  ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M06', 'M08', 'M08', 'M11', 'M11', 'M17']);
assert.strictEqual(result.selected.id, 'M11');
assert.strictEqual(result.selected.slot, 6);
const policy = result.selected.details.mallet;
assert.deepStrictEqual(Array.from(policy.keepIds), ['M17']);
assert.strictEqual(policy.protectExodiaComponents, false);
assert.strictEqual(policy.returnableCount, 6, 'both components and the non-activated Mallet are returnable');
assert.strictEqual(policy.returnableIds.filter(id => id === 'EXODIA_UNKNOWN').length, 2);

// Run the mature executor's real pure plan and verify dynamic keep parsing.
function segment(source, from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, from);
  return source.slice(a, b);
}
const executor = read('execution/live/run-m11-mallet-keep-weapon.js');
const context = vm.createContext({ DEFAULT_KEEP_IDS: ['M08'],
  canonicalRuntimeCardId: require('../../lib/exodia-policy').canonicalRuntimeCardId });
vm.runInContext(segment(executor, 'function parseKeepIds(', 'function cardName(') +
  segment(executor, 'function buildRemainingPlan(', 'function countIds('), context);
const keepIds = context.parseKeepIds(['--keep=' + policy.keepIds.join(',')]);
const plan = context.buildRemainingPlan(hand, 6, keepIds);
assert.deepStrictEqual(Array.from(plan.kept, card => card.id), ['M17']);
assert.strictEqual(plan.returned.length, 6);
assert.strictEqual(plan.returned.filter(card => card.id === 'EXODIA_UNKNOWN').length, 2);
assert.strictEqual(plan.returned.filter(card => card.id === 'M11').length, 1);

// Execute the actual M11 reconciliation entirely in memory. Returning generic
// components must decrement aggregate outside count, including redraw overlap.
const ledgerFile = path.join(ROOT, 'lib/main-deck-ledger.js');
const nativeLedgerRequire = createRequire(ledgerFile);
let memoryLedger;
const ledgerModule = { exports: {} };
vm.runInNewContext(read('lib/main-deck-ledger.js'), { module: ledgerModule, exports: ledgerModule.exports,
  __dirname: path.join(ROOT, 'lib'), console: { log() {} }, require: id => id === './runtime-files' ? {
    readJsonIfExistsSafe: file => file.endsWith('card-library.json') ? clone(library)
      : file.endsWith('decision-state.json') ? clone(runtime)
      : file.endsWith('session_state.json') ? clone(hand) : clone(memoryLedger),
    writeJsonAtomic: (file, value) => { memoryLedger = clone(value); }
  } : nativeLedgerRequire(id) });
for (const redrawIds of [
  ['M16', 'M18', 'M12', 'M14', 'M11', 'M06'],
  ['EXODIA_UNKNOWN', 'M16', 'M18', 'M12', 'M14', 'M11'],
  ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M11', 'M06', 'M08', 'M08']
]) {
  memoryLedger = clone(ledger);
  const finalScan = { cards: [{ id: 'M17' }, ...redrawIds.map(id => ({ id }))] };
  const committed = ledgerModule.exports.reconcileMalletFullResync({ baseline: hand, plan, finalScan });
  assert.strictEqual(committed.unknownExodiaOutsideCount, redrawIds.filter(id => id === 'EXODIA_UNKNOWN').length);
  assert.strictEqual(committed.lastMallet.returned.filter(id => id === 'EXODIA_UNKNOWN').length, 2);
  assert.strictEqual(committed.lastMallet.drawn.length, 6);
  assert.strictEqual(committed.lastHandRevision, 0);
  assert.ok(adjustedMainDeckRemainingCount({ deckRemaining: remaining, unknownExodiaOutsideCount: 2 }) >= 0);
}
for (const [rel, bytes] of before) assert.ok(bytes
  ? bytes.equals(fs.readFileSync(path.join(ROOT, rel))) : !fs.existsSync(path.join(ROOT, rel)), rel);
console.log('MALLET_COMPONENT_PROTECTION_OFFLINE_PASS; Deck<=5 AND components>=4; actual keep=M17/return6; generic returns/redraw ledger verified; stateWrites0/gameInputs0');
