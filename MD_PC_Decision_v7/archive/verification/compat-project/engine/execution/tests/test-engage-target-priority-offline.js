'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildEngageTargetPriority,
  chooseEngageTarget,
  buildEngageLegalTargets
} = require('../../lib/engage-policy');
const decisionEngine = require('../../lib/decision-engine');
const cardConfig = require('../cards/m17-engage');

assert.deepStrictEqual(
  buildEngageLegalTargets().map(item => item.id),
  ['M06', 'M08', 'M22']
);
assert.deepStrictEqual(
  cardConfig.legalTargets.map(item => item.id),
  ['M06', 'M08', 'M22']
);
assert.strictEqual(
  decisionEngine.buildEngageTargetPriority,
  buildEngageTargetPriority
);
assert.strictEqual(
  decisionEngine.chooseEngageTarget,
  chooseEngageTarget
);

function deck({ hand = {}, remaining = {} } = {}) {
  const names = {
    M06: '闪刀姬－零衣',
    M08: '闪术兵器－H.A.M.P.',
    M22: '闪刀机－大黄蜂无人机'
  };
  return {
    handCounts: hand,
    deckRemaining: { M06: 0, M08: 0, M22: 0, ...remaining },
    byId: Object.fromEntries(
      Object.entries(names).map(([id, name]) => [id, { id, name, count: id === 'M22' ? 1 : 2 }])
    )
  };
}

const currentLive = deck({
  hand: { M06: 1, M13: 1, M17: 1 },
  remaining: { M06: 1, M08: 2, M22: 0 }
});
assert.deepStrictEqual(
  buildEngageTargetPriority(currentLive, { usedCounts: { M22: 1 } }).targets.map(x => x.id),
  ['M08', 'M06']
);
assert.strictEqual(
  chooseEngageTarget(currentLive, { usedCounts: { M22: 1 } }).id,
  'M08'
);

const allureNeedsRaye = deck({
  hand: { M13: 1 },
  remaining: { M06: 1, M08: 2, M22: 0 }
});
assert.strictEqual(chooseEngageTarget(allureNeedsRaye).id, 'M06');

const hornetIsLastReserve = deck({
  hand: { M06: 1, M13: 1 },
  remaining: { M06: 1, M08: 2, M22: 1 }
});
assert.deepStrictEqual(
  buildEngageTargetPriority(hornetIsLastReserve).targets.map(x => x.id),
  ['M08', 'M06', 'M22']
);
assert.strictEqual(chooseEngageTarget(hornetIsLastReserve).id, 'M08',
  'Oct07: empty alone is not a sword carrier demand; existing hand Raye covers Allure');

const hornetLastWhenExtraMonsterExists = {
  v5Branch: { carrierId: 'E10', currentState: 'GOLDEN_BAMBOO_DRAW_READY' }
};
assert.deepStrictEqual(
  buildEngageTargetPriority(hornetIsLastReserve, hornetLastWhenExtraMonsterExists)
    .targets.map(x => x.id),
  ['M08', 'M06', 'M22']
);
assert.strictEqual(
  chooseEngageTarget(hornetIsLastReserve, hornetLastWhenExtraMonsterExists).id,
  'M08'
);

const onlyHornetRemains = deck({
  remaining: { M06: 0, M08: 0, M22: 1 }
});

const alreadyHoldingHamp = deck({ hand: { M08: 1, M17: 1 },
  remaining: { M06: 1, M08: 1, M22: 1 } });
assert.strictEqual(chooseEngageTarget(alreadyHoldingHamp).id, 'M06',
  'Oct07: without sword or cost deficit, search first hand Raye');
assert.strictEqual(chooseEngageTarget(alreadyHoldingHamp, hornetLastWhenExtraMonsterExists).id, 'M06');
const twoTrades = deck({ hand: { M12: 1, M17: 1 },
  remaining: { M06: 2, M08: 2, M22: 1 } });
assert.strictEqual(chooseEngageTarget(twoTrades, { usedCounts: { M12: 2 } }).id, 'M08');
assert.strictEqual(chooseEngageTarget(twoTrades, { ...hornetLastWhenExtraMonsterExists, usedCounts: { M12: 2 } }).id, 'M08');
const actualOpening = deck({ hand: { M07: 1, M08: 1, M13: 1, M17: 1, M19: 1 },
  remaining: { M06: 2, M08: 1, M22: 1 } });
assert.strictEqual(chooseEngageTarget(actualOpening).id, 'M22');
for (const state of [{ v5Branch: { carrierId: 'M06' } }, { rayeNormalSummoned: true },
  { v5Branch: { currentState: 'HORNET_TOKEN_READY' } }, { engageBlockedByMainMonster: true }]) {
  assert.strictEqual(chooseEngageTarget(actualOpening, state).id, 'M06',
    'Oct07: main-zone monster is not empty field; field Raye is not an in-hand Allure fee');
}
assert.strictEqual(chooseEngageTarget(actualOpening, { usedCounts: { M22: 1 } }).id, 'M06');
assert.strictEqual(chooseEngageTarget(twoTrades, { usedCounts: { M12: 1 } }).id, 'M08',
  'Oct07: actual held Trade-In fee deficit, not historical activation threshold');
assert.strictEqual(chooseEngageTarget(deck({ hand: { M08: 1 },
  remaining: { M06: 0, M08: 1, M22: 0 } }), { usedCounts: { M12: 3 } }).id, 'M08',
  'Raye exhausted: retain legal fallback');

// Raye -> E10 leaves Hornet unused in Deck. After the first Engage and Kagari
// recovery, preserve the existing Extra-Deck carrier for the second Engage too.
const secondEngageAfterKagari = deck({ hand: { M17: 1, M12: 1 },
  remaining: { M06: 0, M08: 1, M22: 1 } });
assert.strictEqual(chooseEngageTarget(secondEngageAfterKagari, {
  v5Branch: { active: false, currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02' }
}).id, 'M08');
assert.strictEqual(
  chooseEngageTarget(onlyHornetRemains).id,
  'M22',
  'Hornet remains a legal last-resort Engage target when every other target is gone'
);

assert.strictEqual(
  decisionEngine.hornetBlockedByExtraDeckMonster({
    v5Branch: { carrierId: 'E10', currentState: 'GOLDEN_BAMBOO_DRAW_READY' }
  }),
  true
);
assert.strictEqual(
  decisionEngine.hornetBlockedByExtraDeckMonster({
    v5Branch: { carrierId: 'M06', currentState: 'RAYE_NORMAL_SUMMONED' }
  }),
  false
);

const mainSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'runtime', 'main-v6.js'),
  'utf8'
);
assert.match(
  mainSource,
  /if \(card\.id === 'M22'\)[\s\S]*\/\^E\\d\+\$\/\.test\(extraCarrierId\)[\s\S]*本轮没有发送游戏输入/,
  'manual slot override must not bypass the occupied Extra Monster Zone Hornet guard'
);

console.log('PASS test-engage-target-priority-offline');
