'use strict';

const assert = require('assert');
const library = require('../../card-library.json');
const { collectActions } = require('./test-decision-fixture-harness-offline');

const liveOpening = [
  { index: 1, id: 'M02', name: '被封印的左足', usable: null },
  { index: 2, id: 'M15', name: '无之炼狱', usable: true },
  { index: 3, id: 'M19', name: '妖刀竹光', usable: true },
  { index: 4, id: 'M21', name: '试胆竞速', usable: true },
  { index: 5, id: 'M22', name: '闪刀机－大黄蜂无人机', usable: true }
];

const freshRuntime = {
  graveSpellCount: 0,
  bambooSwordEquipped: false,
  usedCounts: {},
  v5Branch: { active: false, currentState: 'IDLE' }
};

const fixedSearchFirst = collectActions(liveOpening, library, freshRuntime);
assert.strictEqual(fixedSearchFirst.selected.id, 'M22');
assert.strictEqual(fixedSearchFirst.selected.tier, -2);
assert.strictEqual(
  fixedSearchFirst.selected.details.phase,
  'START_HORNET_YOTO_FIXED_SEARCH'
);
assert.strictEqual(fixedSearchFirst.selected.details.bambooFollowUp, true);
assert.strictEqual(
  fixedSearchFirst.actions.find(action => action.id === 'M15').tier,
  2,
  'ordinary draw-1 remains legal but must follow the deterministic search'
);

const noTrueSwordTarget = collectActions(
  liveOpening,
  library,
  { ...freshRuntime, usedCounts: { M20: 1 } }
);
assert.strictEqual(noTrueSwordTarget.selected.id, 'M15');
assert.strictEqual(
  noTrueSwordTarget.actions.some(action => action.id === 'M22'),
  false,
  'Hornet must not be promoted when Yoto has no known True-Bamboo search target'
);

console.log('HORNET_YOTO_SEARCH_BEFORE_DRAW_OFFLINE_PASS');
