'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '../..');
const { chooseEngageTarget } = require('../../lib/engage-policy');
const { planKagariSwordPreparation } = require('../../lib/kagari-sword-plan');
const { describeDoubleLinkSwordReadiness } = require('../../lib/double-link-policy');
const { describeRayeCloseout } = require('../../lib/raye-closeout-policy');
const { proveKnownMultiGainBlocks } = require('../../lib/known-multi-gain-proof');
const { adjustedMainDeckRemainingCount } = require('../../lib/exodia-policy');
const { commitRecognizedInsertions, buildPositionOnlyScenarios } = require('../../lib/incremental-hand-locator');
const { atomicContinuationDecision } = require('../../lib/atomic-response-continuation-policy');
const library = require('../../card-library.json');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: byId[id]?.name || id, usable: true }));
const occupied = { v5Branch: { carrierId: 'E02', active: false, currentState: 'KAGARI_RECOVERY_DONE' } };
const d = (handCounts = {}, deckRemaining = {}) => ({ byId, handCounts,
  deckRemaining: { M06: 2, M08: 2, M22: 1, ...deckRemaining } });
// Interrupted 23:03 run: after Kagari, Trade without a level-8 cost must
// fetch HAMP, not another entry monster. Empty-field Hornet remains a combo.
assert.strictEqual(chooseEngageTarget(d({ M12: 1 }), occupied).id, 'M08');
assert.strictEqual(chooseEngageTarget(d({ M12: 1 }), {}).id, 'M08',
  'Oct07: no held sword; current Trade-In fee shortage remains the purpose');
assert.strictEqual(chooseEngageTarget(d({ M12: 1, M08: 1 }), occupied).id, 'M06');
assert.strictEqual(chooseEngageTarget(d({ M12: 2, M08: 1 }), occupied).id, 'M08');
assert.strictEqual(chooseEngageTarget(d({ M12: 1, M07: 1 }, { M10: 1 }), occupied).id, 'M08');
assert.strictEqual(chooseEngageTarget(d({ M12: 1, M07: 1 }), occupied).id, 'M06');
assert.strictEqual(chooseEngageTarget(d({ M12: 1 }, { M08: 0 }), occupied).id, 'M06');
for (const held of [{}, { M13: 1 }, { M06: 1 }]) {
  assert.strictEqual(chooseEngageTarget(d(held), occupied).id, held.M06 ? 'M08' : 'M06');
  assert.strictEqual(chooseEngageTarget(d(held), { ...occupied, normalSummonUsed: true }).id, held.M13 ? 'M06' : 'M08',
    'Oct07: spent normal summon does not erase hand Allure fee demand');
  assert.strictEqual(chooseEngageTarget(d(held), { ...occupied, rayeNormalSummoned: true }).id, held.M13 ? 'M06' : 'M08',
    'field Raye cannot be banished from hand for Allure');
}

const before = { usedCounts: { M17: 1 }, effectUsage: {}, graveSpellCount: 3,
  v5Branch: { active: true, currentState: 'HORNET_TOKEN_READY', carrierId: 'TOKEN_SKY_STRIKER' } };
const bambooDeck = { byId, deckRemaining: { M19: 0, M20: 1, M14: 3, M09: 5 } };
const preparation = planKagariSwordPreparation(cards(['M01', 'M12', 'M19', 'M19']), before,
  bambooDeck, 'TOKEN_SKY_STRIKER');
assert.strictEqual(preparation.plannedSwordCount, 2);
assert.deepStrictEqual(preparation.bambooSearchIds, ['M20', 'M14']);
assert.strictEqual(planKagariSwordPreparation(cards(['M19', 'M19']), before,
  { ...bambooDeck, deckRemaining: { M14: 3 } }, 'TOKEN_SKY_STRIKER').m19EffectCount, undefined,
  'no searchable replacement: do not invent triple final True');

const after = { ...occupied, equipSentToGraveCount: 1, effectUsage: { M19_SEARCH: 1 },
  usedCounts: { M17: 1 }, graveSpellCount: 3 };
const future = { byId, deckRemaining: { M14: 2, M20: 0, M19: 0, M06: 1, M08: 1, M17: 1, M09: 5 } };
assert.strictEqual(describeDoubleLinkSwordReadiness(cards(['M06', 'M19', 'M20']), after, future).ready, false,
  'held Yoto+True can still yield Golden, even after an earlier sword departure');
assert.strictEqual(describeDoubleLinkSwordReadiness(cards(['M06', 'M19']), after, future).ready, true,
  'last held Yoto has no deterministic/deferred replacement; historical receipt is not the decision itself');
assert.strictEqual(describeDoubleLinkSwordReadiness(cards(['M06']), { ...after, equipSentToGraveCount: 0,
  effectUsage: {} }, future).ready, true, 'no current sword work, no arbitrary historical prerequisite');

const main = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
let held = { cards: cards(['M06', 'M11']), handCount: 2 };
let runtime = structuredClone(after), selected = { id: 'M11', name: '万宝槌', slot: 2, tier: 99 };
const result = () => ({ selected, actions: selected ? [selected] : [], holds: [], deck: future,
  engageTargets: [{ id: 'M06', remaining: 1 }, { id: 'M08', remaining: 1 }] });
const ctx = vm.createContext({ ROOT: root, path, console: { log() {} }, adjustedMainDeckRemainingCount,
  loadDecisionState: () => runtime, isStrategicallyUsable: () => true,
  knownNonRayeMonsterPresent: () => true, buildLastResortAllureAction: () => null,
  require: name => name.endsWith('recognizer') ? { loadLibrary: () => library } :
    name.endsWith('decision-engine') ? { collectActions: result } :
    { analyzeReachableResourceDeadlock: () => ({ terminal: false,
      rayeCloseout: describeRayeCloseout(held.cards, runtime, result()) }) } });
vm.runInContext(main.slice(main.indexOf('function buildDecisionSuggestion('),
  main.indexOf('function shortExtraForDecision(')), ctx);
for (const tier of [3, 95, 99, 100]) {
  selected = { id: 'M11', slot: 2, tier };
  assert.strictEqual(ctx.buildDecisionSuggestion(held).selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
}
for (const tier of [-5, 0, 1, 1.5, 2]) {
  selected = { id: 'M17', slot: 2, tier };
  assert.strictEqual(ctx.buildDecisionSuggestion(held).selected.id, 'M17', 'fixed/immediate priorities preserved');
}
selected = { id: 'M11', slot: 2, tier: 99 };
held = { cards: cards(['M06', 'M19', 'M20', 'M11']), handCount: 4 };
assert.strictEqual(ctx.buildDecisionSuggestion(held).selected.id, 'M11', 'productive held swords block premature Zero');

const gains = [{ id: 'M17', activationKey: 'E02', fromDeck: false },
  { id: 'M20', activationKey: 'M19', fromDeck: true }, { id: 'M14', activationKey: 'M19', fromDeck: true }];
const blocks = [{ activationKey: 'M19', details: [] }, { activationKey: 'M19', details: [] },
  { activationKey: 'E02', details: gains.map((g, i) => ({ role: 'HAND_GAIN_CANDIDATE', side: 'SELF',
    card: { id: g.id }, box: { y: 10 + i * 30 } })) }];
assert.strictEqual(proveKnownMultiGainBlocks(blocks, gains).pass, true);
const reordered = structuredClone(blocks); reordered[2].details.push(reordered[2].details.shift());
assert.strictEqual(proveKnownMultiGainBlocks(reordered, gains).pass, true, 'normalizer array order does not change physical y order');
for (const mutate of [b => b.pop(), b => { b[0].activationKey = 'M20'; },
  b => { b[2].details[1].card.id = 'M14'; }, b => { b[2].details[2].side = 'OPPONENT'; },
  b => { b[2].details.push(structuredClone(b[2].details[1])); }, b => { b[2].details[1].box.y = 0; }]) {
  const bad = structuredClone(blocks); mutate(bad);
  assert.strictEqual(proveKnownMultiGainBlocks(bad, gains).pass, false);
}
assert.strictEqual(proveKnownMultiGainBlocks(blocks, [{ ...gains[0], fromDeck: true }, ...gains.slice(1)]).pass, false);
const inserted = commitRecognizedInsertions(cards(['M01', 'M12']), cards(['M17', 'M20', 'M14']), library);
assert.strictEqual(inserted.length, 5);
assert.deepStrictEqual(inserted.map(c => c.id), ['M01', 'M12', 'M14', 'M17', 'M20']);
assert.strictEqual(buildPositionOnlyScenarios(cards(['M12']), 4).length, 0, 'ordinary unknown gain still capped at two');
for (const edge of [['DUAL_M19_CL1_SELECTED','TRIPLE_M19_CL2_SELECTED'],
  ['TRIPLE_M19_CL2_SELECTED','DUAL_E10_TARGET_PROMPT'], ['DUAL_M19_BAMBOO_PROMPT','TRIPLE_SECOND_BAMBOO_PROMPT']]) {
  assert.strictEqual(atomicContinuationDecision(...edge).autoContinue, true);
}
console.log('TWO_SWORDS_AND_ENGAGE_PAIRS_OFFLINE_PASS; interrupted hand rules; trade deficit/Toon reserve; one Raye/used summon; current sword reachability; productive double Zero/fixed priority; strict 3 gains/insertion; inputs=0');
