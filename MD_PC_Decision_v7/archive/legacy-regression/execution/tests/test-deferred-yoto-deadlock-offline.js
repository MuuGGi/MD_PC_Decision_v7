'use strict';

const assert = require('assert');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { evaluateProductiveYotoSearch } = require('../../lib/yoto-search-value');

function cards(ids) {
  return ids.map((id, index) => ({ id, name: id, index: index + 1, usable: true }));
}

function fullDeckRemaining(overrides = {}) {
  const remaining = {};
  for (let i = 1; i <= 22; i++) remaining[`M${String(i).padStart(2, '0')}`] = 0;
  return Object.assign(remaining, overrides);
}

// ISSUE-109 exact live shape after Golden Bamboo drew M02 + M17:
// the equipped M19 can still search either of two M14 copies, but neither
// searched Golden can be activated because no spare M19/M20 or ordinary hand
// action remains. M17 also has no M06/M08/M22 target left in the Deck.
const hand = cards(['M01', 'M02', 'M04', 'M06', 'M06', 'M17']);
const deckRemaining = fullDeckRemaining({ M03: 1, M05: 1, M13: 1, M14: 2 });

const yotoValue = evaluateProductiveYotoSearch(deckRemaining, hand);
assert.strictEqual(yotoValue.searchableGolden, 2,
  'both Golden copies remain legally searchable');
assert.strictEqual(yotoValue.productiveCount, 0,
  'a legal but unusable Golden search must not count as productive');
assert.strictEqual(yotoValue.deferredGoldenHasOutlet, false);

const runtime = {
  graveSpellCount: 24,
  fieldSpell: 'M21',
  chickenGameDrawUsed: true,
  bambooSwordEquipped: true,
  normalSummonUsed: false,
  rayeNormalSummoned: false,
  usedCounts: { M17: 2, M19: 1 },
  v5Branch: {
    active: false,
    currentState: 'EQUIPPED_YOTO_NO_SEARCH_TARGET',
    carrierId: 'E04',
    source: 'ISSUE_109_DEFERRED_GOLDEN_NO_OUTLET'
  }
};
const decisionResult = {
  deck: { deckRemaining },
  actions: [],
  holds: [],
  engageTargets: []
};

const deadlock = analyzeReachableResourceDeadlock({ cards: hand, runtime, decisionResult });
assert.strictEqual(deadlock.terminal, true);
assert.strictEqual(deadlock.type, 'DEADLOCK');
assert.strictEqual(deadlock.confidence, 'HIGH');
assert.strictEqual(deadlock.reason, 'NO_REACHABLE_DRAW_OR_PRODUCTIVE_FIXED_RESOURCE_ROUTE');
assert.strictEqual(deadlock.deckRemaining, 5);
assert.deepStrictEqual(deadlock.searchable.engage, { M06: 0, M08: 0, M22: 0 });
assert.deepStrictEqual(deadlock.searchable.bamboo, { M19: 0, M20: 0 });

const hiddenByOldLock = analyzeReachableResourceDeadlock({
  cards: hand,
  runtime: {
    ...runtime,
    v5Branch: {
      active: true,
      currentState: 'M19_EQUIPPED',
      carrierId: 'E04',
      source: 'FORMAL_V5_AFTER_GOLDEN_DRAWS_Y1_AVAILABLE'
    }
  },
  decisionResult
});
assert.strictEqual(hiddenByOldLock.terminal, false);
assert.strictEqual(hiddenByOldLock.reason, 'ATOMIC_FIELD_TRANSACTION_PENDING',
  'the stale Y1 lock explains why the old main loop never reached deadlock analysis');

console.log('DEFERRED_YOTO_DEADLOCK_OFFLINE_PASS');
