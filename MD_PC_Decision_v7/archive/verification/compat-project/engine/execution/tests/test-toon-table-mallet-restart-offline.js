'use strict';

const assert = require('assert');
const {
  buildMalletKeepPolicy,
  malletPriorityForPolicy,
  shouldPreferKagariMalletThirdSpell,
  shouldPreferKagariRecoveredBonusEngage,
  spellCardIsUsable
} = require('../../lib/decision-engine');

assert.strictEqual(
  spellCardIsUsable({ id: 'M11', rightLogCertain: true }),
  true,
  'a no-click exact M11 gain must remain eligible for its mature re-proving executor'
);
assert.strictEqual(
  spellCardIsUsable({ id: 'M19', rightLogCertain: true }),
  false,
  'the right-log exception must remain narrow and must not enable arbitrary Spells'
);

const cards = [
  { id: 'M03', name: 'M03', index: 1 },
  { id: 'M05', name: 'M05', index: 2 },
  { id: 'M06', name: 'M06', index: 3 },
  { id: 'M06', name: 'M06', index: 4 },
  { id: 'M07', name: 'M07', index: 5 },
  { id: 'M10', name: 'M10', index: 6 },
  { id: 'M11', name: 'M11', index: 7 },
  { id: 'M12', name: 'M12', index: 8 }
];

const deck = {
  handCounts: { M03: 1, M05: 1, M06: 2, M07: 1, M10: 1, M11: 1, M12: 1 },
  deckRemaining: { M01: 1, M02: 1, M04: 1, M07: 0, M10: 0 },
  byId: {
    M03: { name: '被封印的右腕' },
    M05: { name: '被封印的艾克佐迪亚' },
    M06: { name: '闪刀姬－零衣' },
    M07: { name: '青眼卡通龙' },
    M10: { name: '卡通目录' },
    M11: { name: '万宝槌' },
    M12: { name: '抵价交易' }
  }
};

const policy = buildMalletKeepPolicy(deck, cards);
assert.strictEqual(policy.toonTableRestartReady, true);
assert.deepStrictEqual(policy.keepIds, ['M10']);
assert.strictEqual(policy.returnableIds.includes('M07'), true);
assert.strictEqual(policy.returnableIds.includes('M10'), false);
assert.strictEqual(policy.returnableIds.includes('M03'), true);
assert.strictEqual(policy.returnableIds.includes('M05'), true);
assert.deepStrictEqual(
  malletPriorityForPolicy(policy),
  { tier: 1, tierLabel: 'P1 万宝槌重启卡通目录' }
);

const noDragon = buildMalletKeepPolicy(
  {
    ...deck,
    handCounts: { ...deck.handCounts, M07: 0 },
    deckRemaining: { ...deck.deckRemaining, M07: 1 }
  },
  cards.filter(card => card.id !== 'M07')
);
assert.strictEqual(noDragon.toonTableRestartReady, false);
assert.deepStrictEqual(
  malletPriorityForPolicy(noDragon),
  { tier: 100, tierLabel: 'P100 万宝槌最后手段' }
);

const bambooCards = [
  { id: 'M03', name: '被封印的右腕', index: 1 },
  { id: 'M11', name: '万宝槌', index: 2 },
  { id: 'M14', name: '金黄色的竹光', index: 3 },
  { id: 'M19', name: '妖刀竹光', index: 4 },
  { id: 'M20', name: '真刀竹光', index: 5 }
];
const bambooDeck = {
  handCounts: { M03: 1, M11: 1, M14: 1, M19: 1, M20: 1 },
  deckRemaining: { M03: 0, M14: 2, M19: 0, M20: 0 },
  byId: {
    M03: { name: '被封印的右腕' },
    M11: { name: '万宝槌' },
    M14: { name: '金黄色的竹光' },
    M19: { name: '妖刀竹光' },
    M20: { name: '真刀竹光' }
  }
};
const bambooPolicy = buildMalletKeepPolicy(bambooDeck, bambooCards, {
  bambooSwordEquipped: false,
  v5Branch: { currentState: 'YOTO_SEARCH_DONE', carrierId: 'E04' }
});
assert.strictEqual(bambooPolicy.bambooRestartReady, true);
assert.strictEqual(bambooPolicy.fixedSearchRestartReady, true);
assert.deepStrictEqual(bambooPolicy.keepIds, ['M20', 'M14']);
assert.strictEqual(bambooPolicy.returnableIds.includes('M19'), true);
assert.strictEqual(bambooPolicy.returnableIds.includes('M20'), false);
assert.strictEqual(bambooPolicy.returnableIds.includes('M14'), false);
assert.strictEqual(bambooPolicy.returnableIds.includes('M03'), true);
assert.deepStrictEqual(
  malletPriorityForPolicy(bambooPolicy),
  { tier: 1, tierLabel: 'P1 万宝槌重启真刀固定贴妖刀' }
);

const engageThirdSpellCards = [
  { id: 'M11', name: '万宝槌', index: 1, usable: true },
  { id: 'M14', name: '金黄色的竹光', index: 2, usable: false },
  { id: 'M14', name: '金黄色的竹光', index: 3, usable: false },
  { id: 'M17', name: '闪刀起动－交闪', index: 4, usable: null },
  { id: 'M20', name: '真刀竹光', index: 5, usable: false }
];
const engageThirdSpellDeck = {
  handCounts: { M11: 1, M14: 2, M17: 1, M20: 1 },
  deckRemaining: { M06: 2, M08: 2, M19: 2, M22: 0 },
  byId: {
    M11: { name: '万宝槌' },
    M14: { name: '金黄色的竹光' },
    M17: { name: '闪刀起动－交闪' },
    M20: { name: '真刀竹光' }
  }
};
const engageThirdSpellPolicy = buildMalletKeepPolicy(
  engageThirdSpellDeck,
  engageThirdSpellCards,
  { graveSpellCount: 2, v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02' } }
);
assert.strictEqual(engageThirdSpellPolicy.engageThirdSpellSetupReady, true);
assert.strictEqual(engageThirdSpellPolicy.protectEngageForThirdSpell, true);
assert.deepStrictEqual(engageThirdSpellPolicy.keepIds, ['M17']);
assert.deepStrictEqual(engageThirdSpellPolicy.returnableIds, ['M14', 'M14', 'M20']);
assert.deepStrictEqual(
  malletPriorityForPolicy(engageThirdSpellPolicy),
  { tier: 0.5, tierLabel: 'P0.5 万宝槌补足交闪第3张魔法' }
);

const onlyMalletAndEngage = buildMalletKeepPolicy(
  {
    handCounts: { M11: 1, M17: 1 },
    deckRemaining: { M06: 2, M08: 2, M22: 0 },
    byId: { M11: { name: '万宝槌' }, M17: { name: '闪刀起动－交闪' } }
  },
  [
    { id: 'M11', name: '万宝槌', index: 1 },
    { id: 'M17', name: '闪刀起动－交闪', index: 2 }
  ],
  { graveSpellCount: 2 }
);
assert.strictEqual(onlyMalletAndEngage.engageMustReturnToMallet, true);
assert.deepStrictEqual(onlyMalletAndEngage.keepIds, []);
assert.deepStrictEqual(onlyMalletAndEngage.returnableIds, ['M17']);
assert.strictEqual(
  shouldPreferKagariMalletThirdSpell({
    branchState: 'KAGARI_RECOVERY_DONE',
    malletPolicy: engageThirdSpellPolicy,
    toonTableAlreadyWins: false,
    ordinaryThirdSpellBuilder: false
  }),
  true,
  'Kagari recovery may use Mallet when no deterministic Bamboo continuation is ready'
);
assert.strictEqual(
  shouldPreferKagariMalletThirdSpell({
    branchState: 'KAGARI_RECOVERY_DONE',
    malletPolicy: engageThirdSpellPolicy,
    toonTableAlreadyWins: false,
    ordinaryThirdSpellBuilder: true
  }),
  false,
  'a real ordinary Spell that supplies the third grave count should stay ahead of Mallet'
);
assert.strictEqual(
  shouldPreferKagariRecoveredBonusEngage({
    branchState: 'KAGARI_RECOVERY_DONE',
    graveSpellCount: 3,
    recoveredEngage: { id: 'M17' },
    engageTarget: { id: 'M08' },
    toonTableAlreadyWins: false
  }),
  true,
  'the recovered three-Spell Engage payoff stays available without a deterministic Bamboo continuation'
);
assert.strictEqual(
  shouldPreferKagariRecoveredBonusEngage({
    branchState: 'KAGARI_RECOVERY_DONE',
    graveSpellCount: 2,
    recoveredEngage: { id: 'M17' },
    engageTarget: { id: 'M08' },
    toonTableAlreadyWins: false
  }),
  false
);


// ISSUE-096: run the real exported collector, with a fully isolated ledger.
// The previous helper-only tests hid the outer override of a valid M20 route.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const engineFile = path.join(root, 'lib/decision-engine.js');
const actualRequire = createRequire(engineFile);
let isolatedRemaining;
const engineContext = vm.createContext({ module: { exports: {} }, console,
  require: id => id === './main-deck-ledger' ? { getSharedDeckState: () => ({
    deckRemaining: isolatedRemaining, outsideDeckCounts: {}, ledger: {} }) } : actualRequire(id) });
vm.runInContext(fs.readFileSync(engineFile, 'utf8'), engineContext);
const collector = engineContext.module.exports.collectActions;
const currentIds = ['M03', 'M07', 'M08', 'M08', 'M11', 'M17', 'M20'];
const outside = { M03: 1, M07: 1, M08: 2, M10: 3, M11: 1, M17: 2,
  M18: 1, M20: 1, M21: 1, M22: 1 };
const currentRuntime = { graveSpellCount: 6, bambooSwordEquipped: false,
  normalSummonUsed: false, chickenGameDrawPending: false,
  usedCounts: { M10: 3, M18: 1, M21: 1, M22: 1, M17: 1 },
  effectUsage: { M19_SEARCH: 0 },
  v5Branch: { active: false, currentState: 'KAGARI_RECOVERY_DONE', carrierId: null } };
function makeCards(ids) { return ids.map((id, i) => ({ id, index: i + 1, usable: true,
  rightLogCertain: true, name: library.cards.find(card => card.id === id).name })); }
function decide(ids = currentIds, deckOverrides = {}, runtimeOverrides = {}) {
  isolatedRemaining = Object.fromEntries(library.cards.filter(card => /^M\d+$/.test(card.id))
    .map(card => [card.id, Math.max(0, card.count - (outside[card.id] || 0))]));
  Object.assign(isolatedRemaining, deckOverrides);
  return collector(makeCards(ids), library, { ...currentRuntime, ...runtimeOverrides });
}
const current = decide();
assert.strictEqual(current.selected.id, 'M20');
assert.strictEqual(current.selected.slot, 7);
assert.strictEqual(current.selected.details.phase, 'POST_KAGARI_RECOVERY_TRUE_FIRST');
assert.strictEqual(Boolean(current.v5KagariRecoveredBonusEngagePolicy), false);
assert.ok(!current.selected.reason.includes('万宝槌补第3'));
assert.strictEqual(decide([...currentIds, 'M09']).selected.id, 'M20');
assert.strictEqual(decide(currentIds, {}, { graveSpellCount: 2 }).selected.id, 'M20',
  'deterministic Bamboo also precedes a speculative Mallet third-spell bridge');
assert.strictEqual(decide(currentIds, { M19: 0 }).selected.id, 'M17');
assert.strictEqual(decide(currentIds.filter(id => id !== 'M20')).selected.id, 'M17');
assert.strictEqual(decide(currentIds.filter(id => id !== 'M20'), {}, { graveSpellCount: 2 }).selected.id, 'M11');
assert.strictEqual(decide([...currentIds, 'M10'], { M10: 1, M07: 1 },
  { usedCounts: { ...currentRuntime.usedCounts, M10: 1 } }).selected.id, 'M10', 'Toon P0 remains first');
assert.strictEqual(decide(currentIds.map(id => id === 'M20' ? 'M19' : id), { M19: 0, M20: 1 }).selected.id, 'M19',
  'hand Yoto searches True even with no other Yoto left in Deck');
assert.strictEqual(shouldPreferKagariRecoveredBonusEngage({ branchState: 'KAGARI_RECOVERY_DONE',
  graveSpellCount: 6, recoveredEngage: { id: 'M17' }, engageTarget: { id: 'M06' },
  toonTableAlreadyWins: false, atomicBambooAlreadyWins: true }), false);
assert.strictEqual(shouldPreferKagariMalletThirdSpell({ branchState: 'KAGARI_RECOVERY_DONE',
  malletPolicy: engageThirdSpellPolicy, toonTableAlreadyWins: false,
  ordinaryThirdSpellBuilder: false, atomicBambooAlreadyWins: true }), false);

// Actual formal suggestion must preserve the collector winner through the
// strategic-usability and deadlock layers; no game bridge or disk writes.
decide();
const mainSource = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
const start = mainSource.indexOf('function buildDecisionSuggestion(');
const end = mainSource.indexOf('function shortExtraForDecision(', start);
assert.ok(start >= 0 && end > start);
const suggestion = vm.createContext({ ROOT: root, path,
  loadDecisionState: () => currentRuntime, isStrategicallyUsable: () => true,
  buildLastResortAllureAction: require('../../lib/allure-policy').buildLastResortAllureAction,
  knownNonRayeMonsterPresent: () => false, require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return { collectActions: collector };
    if (id.endsWith('deadlock-detector')) return require('../../lib/deadlock-detector');
    throw new Error('unexpected formal dependency: ' + id);
  } });
vm.runInContext(mainSource.slice(start, end), suggestion);
const formal = suggestion.buildDecisionSuggestion({ handCount: 7, cards: makeCards(currentIds) });
assert.strictEqual(formal.selected.id, 'M20');
assert.strictEqual(formal.selected.slot, 7);
assert.strictEqual(formal.strategicDeadlock.terminal, false);
console.log('POST_KAGARI_FIXED_BAMBOO_PRIORITY_PASS; current=M20/slot7; fixed=BEFORE_ENGAGE_AND_MALLET; Toon=FIRST');

console.log('TOON_TABLE_MALLET_RESTART_OFFLINE_PASS');
