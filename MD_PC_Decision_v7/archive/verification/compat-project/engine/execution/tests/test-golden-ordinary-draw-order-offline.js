'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { planEquippedBambooContinuation: plan } = require('../../lib/yoto-search-value');
const { planGoldenBambooSetup } = require('../../lib/golden-bamboo-setup-policy');
const { planKagariSwordPreparation } = require('../../lib/kagari-sword-plan');
const root = path.resolve(__dirname, '../..'), library = require('../../card-library.json');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id].name, usable: true }));
let remaining = { M19: 1, M20: 1, M14: 2, M01: 1, M06: 1, M08: 1, M10: 1, M07: 1 };
const engineFile = path.join(root, 'lib/decision-engine.js'), native = createRequire(engineFile);
const ctx = vm.createContext({ module: { exports: {} }, console, require: id => id === './main-deck-ledger'
  ? { getSharedDeckState: () => ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) } : native(id) });
vm.runInContext(fs.readFileSync(engineFile, 'utf8'), ctx);
const collect = ctx.module.exports.collectActions;
let cases = 0;
for (const carrierId of ['E02', 'E04', 'E10', 'TOKEN_SKY_STRIKER', 'M06']) {
  for (const fieldId of ['M19', 'M20']) for (const spare of [[], ['M19'], ['M20']]) {
    for (const goldenCount of [1, 2]) {
      const runtime = { bambooSwordEquipped: true, equippedBambooId: fieldId, rayeNormalSummoned: carrierId === 'M06',
        v5Branch: { carrierId }, equipSentToGraveCount: 0 };
      const result = plan(remaining, cards([...spare, ...Array(goldenCount).fill('M14')]), { runtime, byId });
      assert.strictEqual(result.goldenDrawReady, true);
      const fixed = fieldId === 'M19' && carrierId !== 'E10';
      assert.strictEqual(result.shouldContinue, fixed, `${carrierId}/${fieldId}/${spare}/${goldenCount}`);
      assert.strictEqual(result.fixedContinuationReady, fixed);
      assert.strictEqual(result.goldenDrawPreferred, !fixed);
      if (goldenCount === 2) assert.strictEqual(plan(remaining, cards([...spare, 'M14']), { runtime, byId }).shouldContinue, fixed);
      const after = plan(remaining, cards(spare), { runtime, byId });
      assert.strictEqual(after.shouldContinue, fieldId === 'M19' && carrierId !== 'E10');
      // Previous departures do not magically make the absolute last equip expendable.
      assert.strictEqual(plan({ M14: 2 }, [], { runtime: { ...runtime, equipSentToGraveCount: 2 }, byId }).shouldContinue, false);
      cases++;
    }
  }
}
for (const node of ['IDLE', 'KAGARI_RECOVERY_DONE', 'YOTO_SEARCH_DONE', 'E10_EFFECT_RESOLVED', 'RAYE_NORMAL_SUMMONED']) {
  const state = { bambooSwordEquipped: false, rayeNormalSummoned: node === 'RAYE_NORMAL_SUMMONED',
    usedCounts: { M19: 1, M17: 0 }, effectUsage: { KAGARI_RECOVERY: 1, M19_SEARCH: 1 },
    graveSpellCount: 0, v5Branch: { active: node === 'RAYE_NORMAL_SUMMONED', currentState: node,
      carrierId: node === 'RAYE_NORMAL_SUMMONED' ? 'M06' : 'E04' } };
  const hand = cards(['M11', 'M19', 'M14', 'M20']);
  assert.strictEqual(planGoldenBambooSetup(hand, state, { deckRemaining: remaining }).sword.id, 'M19');
  const result = collect(hand, library, state);
  assert.strictEqual(result.selected.id,
    ['IDLE', 'YOTO_SEARCH_DONE', 'E10_EFFECT_RESOLVED'].includes(node) ? 'M20' : 'M19');
  assert.strictEqual(result.selected.tier, -1, 'fixed search/replacement precedes ordinary draw-2');
  assert.strictEqual(collect(cards(['M19', 'M14', 'M10']), library, state).selected.id, 'M10', 'Toon remains absolute first even on Raye');
  const fixedDeck = remaining;
  remaining = { ...remaining, M20: 0 };
  const ordinary = collect(cards(['M11', 'M19', 'M14']), library, state);
  assert.strictEqual(ordinary.selected.id, 'M19');
  assert.strictEqual(ordinary.selected.tier, 3, 'Deck-only spare does not turn ordinary draw into a closed fixed chain');
  assert.strictEqual(ordinary.actions.find(a => a.id === 'M11').tier, 100);
  assert.strictEqual(collect(cards(['M19', 'M14', 'M15']), library, state).selected.id, 'M15', 'ordinary draw-1 still wins');
  assert.strictEqual(collect(cards(['M19', 'M14', 'M10']), library, state).selected.id, 'M10', 'fixed Toon still wins');
  remaining = fixedDeck;
  cases++;
}
const raye = { bambooSwordEquipped: true, equippedBambooId: 'M19', rayeNormalSummoned: true, v5Branch: { carrierId: 'M06' } };
assert.strictEqual(plan({ M14: 1 }, cards(['M14', 'M20']), { runtime: raye, byId }).goldenDrawReady, false, 'cannot draw 2 from one card');
assert.strictEqual(plan({ M14: 1 }, cards(['M20']), { runtime: raye, byId }).shouldContinue, true, 'not permanently locked after draws');
assert.strictEqual(plan({ M14: 1, M19: 1 }, cards(['M14']), { runtime: raye, byId,
  deck: { deckRemaining: { M14: 1, M19: 1 }, unknownExodiaOutsideCount: 1 } }).goldenDrawReady, false, 'use corrected Deck capacity');
const beforeKagari = { bambooSwordEquipped: false, usedCounts: { M17: 1 }, effectUsage: {}, v5Branch: { carrierId: 'E04' } };
assert.strictEqual(planKagariSwordPreparation(cards(['M19', 'M20', 'M14']), beforeKagari,
  { deckRemaining: remaining, byId }, 'E04').plannedSwordId, 'M19', 'fixed combined Kagari/Yoto chain before ordinary draw-2');
assert.strictEqual(planKagariSwordPreparation(cards(['M19', 'M20']), beforeKagari,
  { deckRemaining: remaining, byId }, 'E04').plannedSwordId, 'M19', 'resume combined departure after draw');
console.log(`GOLDEN_ORDINARY_DRAW_ORDER_OFFLINE_PASS; cases=${cases}; fixed-chain > ordinary draw2 > speculative departure; all carriers/equips/spares; replan; last equip preserved; no GUI/capture/state writes`);
