'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const {
  EXODIA_COMPONENT_IDS,
  isExodiaComponentId,
  buildExodiaComponentSet
} = require('../../lib/exodia-policy');

const {
  TRADE_IN_COST_IDS,
  isTradeInCostId
} = require('../../lib/trade-in-policy');

const {
  buildMalletKeepPolicy,
  malletPriorityForPolicy
} = require('../../lib/mallet-policy');

const {
  PRODUCTION_ENTRYPOINTS
} = require('../production-entrypoints');

const {
  isLegalBambooSearchTarget,
  bambooSearchTargetIds
} = require('../../lib/bamboo-search-policy');

assert.deepStrictEqual(EXODIA_COMPONENT_IDS, ['M01','M02','M03','M04','M05']);
assert.strictEqual(isExodiaComponentId('M03'), true);
assert.strictEqual(isExodiaComponentId('M06'), false);
assert.strictEqual(buildExodiaComponentSet().size, 5);

assert.deepStrictEqual(TRADE_IN_COST_IDS, ['M07','M08']);
assert.strictEqual(isTradeInCostId('M07'), true);
assert.strictEqual(isTradeInCostId('M08'), true);
assert.strictEqual(isTradeInCostId('M06'), false);

assert.deepStrictEqual(bambooSearchTargetIds(), ['M20','M14']);
assert.strictEqual(isLegalBambooSearchTarget('M20'), true);
assert.strictEqual(isLegalBambooSearchTarget('M14'), true);
assert.strictEqual(isLegalBambooSearchTarget('M19'), false);

for (const [key, rel] of Object.entries(PRODUCTION_ENTRYPOINTS)) {
  assert.ok(rel && typeof rel === 'string', `entry ${key} missing`);
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `entry ${key} path missing: ${rel}`);
}

const deck = {
  handCounts: { M10: 1, M07: 1, M11: 1 },
  deckRemaining: {
    M01: 0, M02: 0, M03: 0, M04: 0, M05: 0,
    M06: 0, M07: 0, M08: 0, M09: 0, M10: 0, M11: 0,
    M12: 0, M13: 0, M14: 0, M15: 0, M16: 0, M17: 0,
    M18: 0, M19: 0, M20: 0, M21: 0, M22: 0
  },
  byId: {
    M10: { name: '卡通目录' },
    M07: { name: '青眼卡通龙' },
    M11: { name: '万宝槌' }
  }
};
const cards = [
  { id: 'M10' },
  { id: 'M07' },
  { id: 'M11' }
];

const mallet = buildMalletKeepPolicy(deck, cards);
assert.strictEqual(mallet.toonTableRestartReady, true);
assert.deepStrictEqual(mallet.keepIds, ['M10']);
assert.strictEqual(malletPriorityForPolicy(mallet).tier, 1);

console.log('STAGE15_BATCH_OFFLINE PASS');
