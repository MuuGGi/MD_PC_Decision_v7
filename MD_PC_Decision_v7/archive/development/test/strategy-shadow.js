'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const ROOT = path.resolve(__dirname, '../../..'), ENGINE = path.join(ROOT, 'engine');
const library = require('../../../engine/card-library.json');
const ledger = { version: 2, mode: 'OUTSIDE_DECK_COUNT', lastHandRevision: 0, unknownExodiaOutsideCount: 0,
  outsideDeckCounts: Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, 0])) };
Object.assign(ledger.outsideDeckCounts, { M14: 1, M11: 1, M19: 1 });
const cards = [{ id: 'M14', index: 1, name: '金黄色的竹光', usable: true }, { id: 'M11', index: 2, name: '万宝槌', usable: true }];
const runtime = { graveSpellCount: 3, usedCounts: {}, bambooSwordEquipped: true, normalSummonUsed: false,
  equippedBambooCounts: { M19: 1 }, equippedBambooId: 'M19', v5Branch: { carrierId: 'E02', currentState: 'GOLDEN_BAMBOO_DRAW_READY' } };
const clone = value => JSON.parse(JSON.stringify(value));
function load(file, source, overrides = {}) {
  const module = { exports: {} }, native = createRequire(file);
  vm.runInNewContext(source, { module, __dirname: path.dirname(file), console,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : native(id) }, { filename: file });
  return module.exports;
}
async function run() {
  await withStrictReadOnly(async () => {
    const queries = load(path.join(ENGINE, 'lib/main-deck-ledger.js'), fs.readFileSync(path.join(ENGINE, 'lib/main-deck-ledger.js'), 'utf8'), {
      fs: { existsSync: () => true, readFileSync: () => JSON.stringify(ledger) },
      './runtime-files': { readJsonIfExistsSafe: file => file.includes('main-deck-ledger') ? clone(ledger) : clone(runtime),
        writeJsonAtomic: () => { throw new Error('STRATEGY_QUERY_WROTE_BUSINESS_STATE'); } }
    });
    const queriesBefore = JSON.stringify(ledger), decisionBefore = JSON.stringify(runtime);
    assert.equal(queries.getReadOnlySharedDeckState(library, cards, runtime).deckRemaining.M14, 2);
    const migrated = load(path.join(ENGINE, 'lib/decision-engine.js'), fs.readFileSync(path.join(ENGINE, 'lib/decision-engine.js'), 'utf8'), { './main-deck-ledger': queries });
    const oldRoot = require('../import-manifest.json').sourceRoot;
    // Frozen V6 source must resolve ITS frozen dependencies, not demand that
    // removed V6 policy files remain in the current V7 runtime package.
    const oldFile = path.join(oldRoot, 'lib/decision-engine.js');
    const original = load(oldFile, fs.readFileSync(oldFile, 'utf8'), { './main-deck-ledger': queries });
    const normalize = result => ({ selected: result.selected && { id: result.selected.id, slot: result.selected.slot, tier: result.selected.tier },
      actions: result.actions.map(a => ({ id: a.id, slot: a.slot, tier: a.tier })) });
    const old = normalize(original.collectActions(clone(cards), library, clone(runtime)));
    const result = migrated.collectActions(clone(cards), library, clone(runtime));
    // Explicit approved difference: the V6 hand-only collector ignored the
    // current fixed departure. The A/B tree must offer it, not imitate V6.
    assert.equal(old.selected.id, 'M14');
    assert.equal(result.selected.details.fieldIntent, 'EQUIPPED_BAMBOO_DEPARTURE');
    assert.equal(result.selected.tier, 0.5);
    assert.equal(result.selected.details.bambooSearchTargetId, 'M20');
    // Preserve the invariant where departure is actually unavailable: E10 is
    // not a Link material. Both versions must cash Golden before Mallet.
    const kept = { ...clone(runtime), v5Branch: { ...runtime.v5Branch, carrierId: 'E10' } };
    const oldKept = normalize(original.collectActions(clone(cards), library, kept));
    const currentKept = normalize(migrated.collectActions(clone(cards), library, kept));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(currentKept)), JSON.parse(JSON.stringify(oldKept)));
    assert.equal(currentKept.selected.id, 'M14');
    assert.equal(JSON.stringify(ledger), queriesBefore); assert.equal(JSON.stringify(runtime), decisionBefore);
  });
  console.log('V7_STRICT_STRATEGY_SHADOW_PASS; approved fixed-departure difference explicit; last carrier Golden before Mallet unchanged; actual final evaluator covered by unified-strategy; inputs=0/writes=0');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
