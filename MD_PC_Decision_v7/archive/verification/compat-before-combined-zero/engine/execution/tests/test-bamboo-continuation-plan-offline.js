'use strict';

const assert = require('assert');
const { planEquippedBambooContinuation: plan } = require('../../lib/yoto-search-value');
const byId = { M19: { count: 2 }, M20: { count: 1 } };
const cards = ids => ids.map(id => ({ id }));
const runtime = { bambooSwordEquipped: true, equippedBambooId: 'M19',
  v5Branch: { carrierId: 'E02' },
  // Deliberately wrong cache: the planner must always read the current counts.
  bambooEquipResources: { deckCount: 99, handCount: 99 } };

const first = plan({ M19: 1, M20: 1, M14: 2 }, cards(['M14']), { runtime, byId });
assert.strictEqual(first.goldenDrawReady, true);
assert.strictEqual(first.shouldContinue, true, 'fixed True search/conversion precedes ordinary draw-2');
assert.strictEqual(first.fixedContinuationReady, true);
assert.strictEqual(first.goldenDrawPreferred, false);
assert.deepStrictEqual(plan({ M19: 1, M20: 1, M14: 2 }, [], { runtime, byId }).steps,
  ['LINK_SEND_M19', 'SEARCH_M20', 'EQUIP_M20', 'SEND_M20_EQUIP_DECK_M19']);
const drawn = plan({ M19: 1, M20: 0, M14: 1 }, cards(['M20', 'M14']), { runtime, byId });
assert.strictEqual(drawn.shouldContinue, true, 'held replacement closes a fixed Golden search chain');
assert.deepStrictEqual(plan({ M19: 1, M20: 0, M14: 1 }, cards(['M20']), { runtime, byId }).steps,
  ['LINK_SEND_M19', 'SEARCH_M14', 'EQUIP_M20', 'SEND_M20_EQUIP_DECK_M19']);
assert.strictEqual(drawn.replacementSource, 'HAND');

// All legal distributions of the other two equips. Keep exact M19/M20
// resource types; absent Golden also permits stocking it for a remaining
// Deck equip, without pretending that equip is immediately accessible.
let cases = 0;
for (const spareYoto of ['DECK', 'HAND', 'OTHER']) {
  for (const trueSword of ['DECK', 'HAND', 'OTHER']) {
    for (const goldenDeck of [0, 1, 2, 3]) for (const goldenHand of [0, 1, 2]) {
      const deck = { M19: +(spareYoto === 'DECK'), M20: +(trueSword === 'DECK'), M14: goldenDeck };
      const hand = cards([...(spareYoto === 'HAND' ? ['M19'] : []),
        ...(trueSword === 'HAND' ? ['M20'] : []), ...Array(goldenHand).fill('M14')]);
      const input = JSON.stringify({ deck, hand, runtime });
      const result = plan(deck, hand, { runtime, byId });
      const expected = (trueSword === 'DECK' || goldenDeck > 0) &&
        (trueSword !== 'OTHER' || spareYoto === 'HAND' || (spareYoto === 'DECK' && goldenHand === 0));
      assert.strictEqual(result.shouldLink, expected, `${spareYoto}/${trueSword}/${goldenDeck}/${goldenHand}`);
      assert.strictEqual(JSON.stringify({ deck, hand, runtime }), input, 'pure planner never writes state');
      for (const row of Object.values(result.equipResources.byId)) {
        assert.strictEqual(row.deck + row.hand + row.field + row.outsideHandField, row.total);
      }
      if (expected) {
        // Execute the returned deterministic plan in a local count model.
        const regions = structuredClone(result.equipResources.byId);
        regions.M19.field--; regions.M19.outsideHandField++;
        if (result.deferredGoldenSearch) {
          assert.strictEqual(result.routeKind, 'YOTO_LINK_DEFERRED_GOLDEN');
          assert.strictEqual(result.canReplaceEquipDeterministically, false);
          assert.strictEqual(result.replacementId, null);
          assert.strictEqual(result.replacementSource, null);
          assert.strictEqual(result.projectedFieldEquipId, null);
          assert.strictEqual(regions.M19.field + regions.M20.field, 0);
          assert.strictEqual(regions.M19.deck, 1, 'waiting does not consume the Deck equip');
          assert.deepStrictEqual(result.steps, ['LINK_SEND_M19', 'SEARCH_M14', 'WAIT_FOR_DECK_EQUIP']);
          cases++;
          continue;
        }
        if (result.searchId === 'M20') { regions.M20.deck--; regions.M20.hand++; }
        regions[result.replacementId].hand--; regions[result.replacementId].field++;
        if (result.convertsTrue) {
          regions.M20.field--; regions.M20.outsideHandField++;
          regions.M19.deck--; regions.M19.field++;
        }
        assert.strictEqual(regions.M19.field + regions.M20.field, 1);
        assert.strictEqual(regions[result.projectedFieldEquipId].field, 1);
        for (const row of Object.values(regions)) {
          for (const key of ['deck', 'hand', 'field', 'outsideHandField']) assert.ok(row[key] >= 0);
          assert.strictEqual(row.deck + row.hand + row.field + row.outsideHandField, row.total);
        }
        if (result.convertsTrue) {
          assert.strictEqual(regions.M19.outsideHandField + regions.M20.outsideHandField, 2);
          const final = plan({ M19: regions.M19.deck, M20: regions.M20.deck, M14: goldenDeck },
            cards([...Array(regions.M19.hand).fill('M19'), ...Array(regions.M20.hand).fill('M20'), 'M14']),
            { runtime, byId });
          assert.strictEqual(final.shouldLink, false, 'after two equips go to grave the last equip stays');
        }
      }
      cases++;
    }
  }
}
for (const blockedRuntime of [ { ...runtime, bambooSwordEquipped: false },
  { ...runtime, equippedBambooId: 'M20' }, { ...runtime, v5Branch: {} },
  { ...runtime, v5Branch: { carrierId: 'UNKNOWN' } },
  { ...runtime, v5Branch: { carrierId: 'E10', summonMode: 'RAYE_DIRECT' } } ]) {
  assert.strictEqual(plan({ M19: 1, M20: 1, M14: 2 }, [], { runtime: blockedRuntime, byId }).shouldLink, false);
}
assert.strictEqual(plan({ M19: 1, M20: 0, M14: 2 }, cards(['M11', 'M12', 'M14']),
  { runtime, byId, deferredGoldenHasOutlet: true }).shouldLink, false);
const rayeRuntime = { bambooSwordEquipped: false, rayeNormalSummoned: true,
  v5Branch: { currentState: 'RAYE_NORMAL_SUMMONED', carrierId: 'M06', rayeOnlyMonster: true } };
assert.strictEqual(plan({ M14: 1 }, cards(['M19']), { runtime: rayeRuntime, byId }).prepareEquipId, 'M19');
assert.strictEqual(plan({ M19: 1, M14: 1 }, cards(['M20']), { runtime: rayeRuntime, byId }).prepareEquipId, 'M20');
assert.strictEqual(plan({ M19: 0, M14: 1 }, cards(['M20']), { runtime: rayeRuntime, byId }).prepareEquipId, null,
  'True without a Deck Yoto cannot fabricate a Yoto trigger');
const lastRaye = plan({ M19: 0, M20: 0, M14: 1 }, [],
  { runtime: { ...rayeRuntime, bambooSwordEquipped: true, equippedBambooId: 'M19' }, byId });
assert.strictEqual(lastRaye.shouldContinue, false, 'last equip also stays for future Golden on Raye');
const direct = plan({ M19: 0, M20: 0, M14: 1 }, cards(['M19']),
  { runtime: { ...rayeRuntime, bambooSwordEquipped: true, equippedBambooId: 'M19' }, byId });
assert.strictEqual(direct.shouldLink, false);
assert.strictEqual(direct.shouldContinue, true, 'Raye own effect prepares dual triggers, not a spare-equip Link loop');
assert.strictEqual(direct.routeKind, 'RAYE_DIRECT_DUAL');
console.log(`BAMBOO_CONTINUATION_PLAN_OFFLINE_PASS; ${cases} distributions; immediate/deferred routes; no fictional replacement; terminal last equip; zero state writes`);
