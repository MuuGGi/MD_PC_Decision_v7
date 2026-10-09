'use strict';

const assert = require('assert');
const { buildTradeInCostPolicy } = require('../../lib/trade-in-policy');

function ids(policy) {
  return policy.priority.map(item => item.id);
}

{
  const policy = buildTradeInCostPolicy({
    handCounts: { M07: 1, M08: 1 },
    usedCounts: { M10: 2 }
  });
  assert.deepStrictEqual(ids(policy), ['M08', 'M07']);
  assert.strictEqual(policy.plannedCost.id, 'M08');
  assert.strictEqual(policy.plannedCost.preference, 1);
  assert.strictEqual(policy.protectToonDragon, true);
  assert.strictEqual(policy.toonDragonStillProtected, false);
}

{
  const policy = buildTradeInCostPolicy({
    handCounts: { M07: 1 },
    usedCounts: { M10: 2 }
  });
  assert.deepStrictEqual(ids(policy), ['M08', 'M07']);
  assert.strictEqual(policy.plannedCost.id, 'M07');
  assert.strictEqual(policy.plannedCost.preference, 1);
  assert.strictEqual(policy.toonDragonStillProtected, true);
}

{
  const policy = buildTradeInCostPolicy({
    handCounts: { M07: 1, M08: 1 },
    usedCounts: { M10: 3 }
  });
  assert.deepStrictEqual(ids(policy), ['M07', 'M08']);
  assert.strictEqual(policy.plannedCost.id, 'M07');
  assert.strictEqual(policy.plannedCost.preference, 1);
  assert.strictEqual(policy.protectToonDragon, false);
}

{
  const policy = buildTradeInCostPolicy({
    handCounts: { M08: 1 },
    usedCounts: { M10: 3 }
  });
  assert.strictEqual(policy.plannedCost.id, 'M08');
  assert.strictEqual(policy.plannedCost.preference, 2);
}

{
  const policy = buildTradeInCostPolicy({
    handCounts: {},
    usedCounts: { M10: 1 }
  });
  assert.strictEqual(policy.plannedCost, null);
}

console.log('TRADE_IN_COST_POLICY_OFFLINE PASS');
