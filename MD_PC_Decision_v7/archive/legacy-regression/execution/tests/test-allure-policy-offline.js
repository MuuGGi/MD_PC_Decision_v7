'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildAllureBanishPriority,
  findAllureBanishCandidate,
  describeAllureDecision
} = require('../../lib/allure-policy');
const card = require('../cards/m13-allure-of-darkness');

assert.deepStrictEqual(
  buildAllureBanishPriority().map(x => x.id),
  ['M06', 'M08']
);
assert.deepStrictEqual(
  card.safeBanishPriority.map(x => x.id),
  ['M06', 'M08']
);

let row = describeAllureDecision({ M06: 1, M08: 1 }, { M12: 0 });
assert.strictEqual(row.allowed, true);
assert.strictEqual(row.target.id, 'M06');
assert.strictEqual(row.tier, 3);
assert.strictEqual(row.protectHampForFutureTradeIn, false);

row = describeAllureDecision({ M06: 0, M08: 1 }, { M12: 0 });
assert.strictEqual(row.target.id, 'M08');
assert.strictEqual(row.tier, 99);
assert.strictEqual(row.tradeInUsed, 0);
assert.strictEqual(row.protectHampForFutureTradeIn, true);

row = describeAllureDecision({ M06: 0, M08: 1 }, { M12: 2 });
assert.strictEqual(row.target.id, 'M08');
assert.strictEqual(row.tier, 99);
assert.strictEqual(row.protectHampForFutureTradeIn, true);

row = describeAllureDecision({ M06: 0, M08: 1 }, { M12: 3 });
assert.strictEqual(row.target.id, 'M08');
assert.strictEqual(row.tier, 99);
assert.strictEqual(row.protectHampForFutureTradeIn, false);

row = describeAllureDecision({ M06: 0, M08: 0 }, { M12: 3 });
assert.strictEqual(row.allowed, false);
assert.strictEqual(row.target, null);

const candidate = findAllureBanishCandidate([
  { id: 'M08', index: 1 },
  { id: 'M06', index: 4 },
  { id: 'M08', index: 5 }
]);
assert.strictEqual(candidate.id, 'M06');
assert.strictEqual(candidate.count, 1);
assert.strictEqual(candidate.originalSlot, 4);

const mainSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'runtime', 'main-v6.js'),
  'utf8'
);
assert.match(
  mainSource,
  /id === 'M12' \|\| id === 'M13' \|\| id === 'M14'/,
  'M13 draw 2 must participate in the Exodia victory-risk watcher'
);

const executorSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'live', 'run-m13-allure-of-darkness.js'),
  'utf8'
);
assert.match(executorSource, /readFreshStrictVictory\(outcomeBeforeObserver\)/);
assert.match(executorSource, /status: 'TERMINAL_VICTORY'/);
assert.match(
  executorSource,
  /if \(terminalVictory\)[\s\S]*终局后不再读取右栏[\s\S]*return;/,
  'strict M13 victory must return before ordinary log and hand verification'
);

console.log('ALLURE_POLICY_OFFLINE PASS');
