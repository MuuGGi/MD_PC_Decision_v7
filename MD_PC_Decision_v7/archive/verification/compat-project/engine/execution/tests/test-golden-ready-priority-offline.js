'use strict';

const assert = require('assert');
const library = require('../../card-library.json');
const { collectActions } = require('./test-decision-fixture-harness-offline');

const cards = [
  { index: 1, id: 'M06', name: '闪刀姬－零衣', usable: true },
  { index: 2, id: 'M08', name: '闪术兵器－H.A.M.P.', usable: true },
  { index: 3, id: 'M08', name: '闪术兵器－H.A.M.P.', usable: true },
  { index: 4, id: 'M10', name: '卡通目录', usable: true },
  { index: 5, id: 'M14', name: '金黄色的竹光', usable: true },
  { index: 6, id: 'M16', name: '暂时休战', usable: true },
  { index: 7, id: 'M21', name: '试胆竞速', usable: true }
];

const runtime = {
  graveSpellCount: 9,
  fieldSpell: null,
  chickenGameDrawUsed: false,
  chickenGameDrawPending: false,
  bambooSwordEquipped: true,
  normalSummonUsed: false,
  usedCounts: { M14: 1 },
  v5Branch: {
    active: false,
    currentState: 'GOLDEN_BAMBOO_DRAW_READY',
    carrierId: 'E04'
  }
};

const withToon = collectActions(cards, library, runtime);
assert.strictEqual(withToon.selected.id, 'M10');
assert.strictEqual(withToon.v5GoldenBambooReadyPolicy.forcedGolden, false);

const withoutToon = collectActions(
  cards.filter(card => card.id !== 'M10'),
  library,
  runtime
);
assert.strictEqual(withoutToon.selected.id, 'M21');

const withoutOrdinaryDraw1 = collectActions(
  cards.filter(card => !['M10', 'M21'].includes(card.id)),
  library,
  runtime
);
assert.strictEqual(withoutOrdinaryDraw1.selected.id, 'M14');

const fixedSearchThenEngage = collectActions(
  [
    { index: 1, id: 'M10', name: '卡通目录', usable: true },
    { index: 2, id: 'M17', name: '闪刀起动－交闪', usable: true },
    { index: 3, id: 'M21', name: '试胆竞速', usable: true },
    { index: 4, id: 'M14', name: '金黄色的竹光', usable: true }
  ],
  library,
  runtime
);
assert.deepStrictEqual(
  fixedSearchThenEngage.actions.slice(0, 4).map(action => [action.id, action.tier]),
  [['M10', 0], ['M17', 1], ['M21', 2], ['M14', 3]]
);

console.log('GOLDEN_READY_PRIORITY_OFFLINE_PASS');
