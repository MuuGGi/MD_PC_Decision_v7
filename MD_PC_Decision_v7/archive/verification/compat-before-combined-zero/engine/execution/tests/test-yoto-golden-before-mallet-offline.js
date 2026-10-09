'use strict';

const assert = require('assert');
const library = require('../../card-library.json');
const { collectActions } = require('./test-decision-fixture-harness-offline');

const baseCards = [
  { index: 1, id: 'M01', name: '被封印的右足', usable: null },
  { index: 2, id: 'M04', name: '被封印的左腕', usable: null },
  { index: 3, id: 'M11', name: '万宝槌', usable: true },
  { index: 4, id: 'M14', name: '金黄色的竹光', usable: false },
  { index: 5, id: 'M15', name: '无之炼狱', usable: true },
  { index: 6, id: 'M19', name: '妖刀竹光', usable: true }
];

const runtime = {
  graveSpellCount: 11,
  bambooSwordEquipped: false,
  usedCounts: { M11: 1, M15: 1, M20: 1 },
  v5Branch: {
    active: false,
    currentState: 'YOTO_SEARCH_DONE',
    carrierId: 'E04'
  }
};

const draw1First = collectActions(baseCards, library, runtime);
assert.strictEqual(draw1First.selected.id, 'M15');
assert.strictEqual(draw1First.actions.find(row => row.id === 'M19').tier, 3);

const setupBeforeMallet = collectActions(
  baseCards.filter(card => card.id !== 'M15'),
  library,
  runtime
);
assert.strictEqual(setupBeforeMallet.selected.id, 'M19');
assert.strictEqual(setupBeforeMallet.selected.details.enablesGoldenDraw2, true);
assert.ok(setupBeforeMallet.actions.findIndex(row => row.id === 'M19') <
  setupBeforeMallet.actions.findIndex(row => row.id === 'M11'));

const bothSwordsGone = collectActions(
  baseCards.filter(card => !['M15', 'M19'].includes(card.id)),
  library,
  runtime
);
assert.strictEqual(bothSwordsGone.selected.id, 'M11');

const noKnownCarrier = collectActions(
  baseCards.filter(card => card.id !== 'M15'),
  library,
  { ...runtime, v5Branch: { ...runtime.v5Branch, carrierId: null } }
);
assert.strictEqual(noKnownCarrier.selected.id, 'M11');

console.log('YOTO_GOLDEN_BEFORE_MALLET_OFFLINE_PASS');
