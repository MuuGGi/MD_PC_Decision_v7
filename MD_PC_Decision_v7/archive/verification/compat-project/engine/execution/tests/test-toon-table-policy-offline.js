'use strict';

const assert = require('assert');
const {
  buildToonTableSearchPriority,
  chooseToonTableTarget
} = require('../../lib/toon-table-policy');
const decision = require('../../lib/decision-engine');
const card = require('../cards/m10-toon-table');

assert.deepStrictEqual(
  buildToonTableSearchPriority().map(x => x.id),
  ['M10', 'M07']
);
assert.deepStrictEqual(
  card.searchPriority.map(x => x.id),
  ['M10', 'M07']
);

assert.strictEqual(
  chooseToonTableTarget({ M10: 2, M07: 1 }).id,
  'M10'
);
assert.strictEqual(
  chooseToonTableTarget({ M10: 0, M07: 1 }).id,
  'M07'
);
assert.strictEqual(
  chooseToonTableTarget({ M10: 0, M07: 0 }),
  null
);

const mkDeck = remaining => ({
  deckRemaining: { M10: 0, M07: 0, ...remaining },
  byId: {
    M10: { id: 'M10', name: '卡通目录', count: 3 },
    M07: { id: 'M07', name: '青眼卡通龙', count: 1 }
  }
});

assert.strictEqual(decision.toonTableTarget(mkDeck({ M10: 1, M07: 1 })).id, 'M10');
assert.strictEqual(decision.toonTableTarget(mkDeck({ M10: 0, M07: 1 })).id, 'M07');
assert.strictEqual(decision.toonTableTarget(mkDeck({ M10: 0, M07: 0 })), null);

console.log('TOON_TABLE_POLICY_OFFLINE PASS');
