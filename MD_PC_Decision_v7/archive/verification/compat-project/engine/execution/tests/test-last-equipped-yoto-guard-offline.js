'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const policy = require('../../lib/yoto-search-value');
const { evaluateProductiveYotoSearch, shouldEvaluateEquippedYotoContinuation } = policy;

const lastEquipOnly = evaluateProductiveYotoSearch(
  { M14: 2, M19: 0, M20: 0 },
  [
    { id: 'M01' },
    { id: 'M04' },
    { id: 'M05' },
    { id: 'M11' },
    { id: 'M12' },
    { id: 'M12' }
  ],
  { deferredGoldenHasOutlet: true }
);
assert.strictEqual(lastEquipOnly.productiveCount, 0,
  'Mallet/Trade-In cannot replace an exhausted Bamboo equip resource');
assert.strictEqual(lastEquipOnly.equipResources.replacementCountAfterLink, 0);
assert.strictEqual(evaluateProductiveYotoSearch({ M14: 2, M19: 0, M20: 0 }, [{ id: 'M14' }],
  { runtime: { bambooSwordEquipped: true }, deferredGoldenHasOutlet: true }).productiveCount, 0,
  'Golden itself and the sole field equip are not replacement equips');
assert.strictEqual(lastEquipOnly.immediatelyUsableGolden, 0);
assert.strictEqual(lastEquipOnly.deferredGolden, 2);
assert.strictEqual(
  shouldEvaluateEquippedYotoContinuation('M19_EQUIPPED', false),
  true,
  'T20-3 returning to M19_EQUIPPED must run the last-equip value guard'
);

const liveIssue073State = evaluateProductiveYotoSearch(
  { M14: 3, M19: 0, M20: 0 },
  [
    { id: 'M06' },
    { id: 'M09' },
    { id: 'M13' },
    { id: 'M21' },
    { id: 'M21' }
  ],
  { deferredGoldenHasOutlet: true }
);
assert.strictEqual(liveIssue073State.productiveCount, 0,
  'draw resources cannot waive the last-equip guard; ISSUE-114 supersedes the old ISSUE-097 expectation');
assert.deepStrictEqual(liveIssue073State.handEquipIds, []);

const strandedGolden = evaluateProductiveYotoSearch(
  { M14: 2, M19: 0, M20: 0 },
  [{ id: 'M01' }, { id: 'M02' }, { id: 'M04' }, { id: 'M06' }, { id: 'M06' }, { id: 'M17' }]
);
assert.strictEqual(strandedGolden.productiveCount, 0,
  'unusable Golden alone must not send the last equipped Yoto away');
assert.strictEqual(strandedGolden.searchableGolden, 2);
assert.strictEqual(strandedGolden.deferredGolden, 2);

const spareEquipInHand = evaluateProductiveYotoSearch(
  { M14: 2, M19: 0, M20: 0 },
  [{ id: 'M19' }]
);
assert.strictEqual(spareEquipInHand.productiveCount, 2);
assert.strictEqual(evaluateProductiveYotoSearch({ M14: 2, M19: 0, M20: 0 }, [{ id: 'M20' }]).productiveCount, 2);
assert.strictEqual(evaluateProductiveYotoSearch({ M14: 2, M19: 1, M20: 0 }, [],
  { deferredGoldenHasOutlet: true }).productiveCount, 2, 'ISSUE-122: stock absent Golden for the remaining Deck equip');
assert.strictEqual(evaluateProductiveYotoSearch({ M14: 2, M19: 1, M20: 0 }, []).productiveCount, 2,
  'deferred value does not require claiming a guaranteed draw outlet');
assert.strictEqual(evaluateProductiveYotoSearch({ M14: 2, M19: 1, M20: 0 }, [{ id: 'M14' }]).productiveCount, 0,
  'held Golden still preserves its only currently equipped carrier');

const trueSwordSearchable = evaluateProductiveYotoSearch(
  { M14: 2, M19: 0, M20: 1 },
  []
);
assert.strictEqual(trueSwordSearchable.productiveCount, 1,
  'searchable True keeps immediate-route priority instead of claiming the new deferred route');
assert.strictEqual(
  shouldEvaluateEquippedYotoContinuation('M19_EQUIPPED', true),
  true,
  'Golden in hand does not bypass current equipment route evaluation'
);

assert.strictEqual(evaluateProductiveYotoSearch({ M14: 0, M19: 1, M20: 0 }).productiveCount, 0,
  'Yoto cannot search another Yoto');

// Production normalization, main-loop lock arbitration and atomic dispatch.
// All saves and executors are isolated in memory; no bridge or duel file IO.
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const hand = { revision: 12, handCount: 6,
  cards: ['M03', 'M20', 'M08', 'M08', 'M11', 'M17'].map((id, i) => ({ id, index: i + 1 })) };
const currentRuntime = { graveSpellCount: 7, bambooSwordEquipped: true, rayeNormalSummoned: false,
  usedCounts: { M10: 3, M18: 1, M21: 1, M22: 1, M17: 1, M20: 1 }, effectUsage: { M19_SEARCH: 0 },
  v5Branch: { active: false, currentState: 'EQUIPPED_YOTO_NO_SEARCH_TARGET', carrierId: 'E02',
    source: 'FORMAL_V5_AFTER_GOLDEN_NO_PRODUCTIVE_BAMBOO_TARGET' } };
const source = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production boundaries: ${start}`);
  return source.slice(from, to);
}
const production = between('function branchCarrierId(', 'function hornetTrueYotoWindPlan(') +
  between('function isHornetTokenSwordRoute(', 'function commitSwordEquipped(') +
  between('function commitAfterYotoResolution(', 'function normalizeCards(') +
  between('async function executeFieldTransition(', 'async function executeAtomicResponseInterval(');
function harness({ runtime = currentRuntime, remaining = { M14: 3, M19: 1, M20: 0 },
  unknown = false, actions = [{ id: 'M11' }] } = {}) {
  let saved = structuredClone(runtime);
  const calls = [];
  const context = vm.createContext({ ROOT, path, ...policy, console: { log() {} },
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    hornetTrueYotoWindPlan: () => null,
    knownNonRayeMonsterPresent: () => false,
    executeSelected: async ({ slot }) => { calls.push(`EQUIP_SLOT_${slot}`); return { executed: true, state: hand }; },
    runRayeEffectToE10OptionalAtomic: async options => {
      assert.strictEqual(options.equippedYoto, true);
      calls.push('R1D'); options.onE10Selected();
    },
    require: id => {
      if (id.endsWith('recognizer')) return { loadLibrary: () => library };
      if (id.endsWith('decision-engine')) return {
        buildDeckState: () => {
          if (unknown) throw new Error('NO_SHARED_LEDGER');
          return { deckRemaining: remaining, byId: Object.fromEntries(library.cards.map(card => [card.id, card])) };
        },
        collectActions: () => ({ actions })
      };
      if (id.endsWith('main-deck-ledger')) throw new Error('NORMALIZATION_MUST_NOT_RECOMMIT_DECK_EXITS');
      throw new Error(`unexpected dependency: ${id}`);
    },
    runEquippedYotoLinkToOptionalAtomic: async options => {
      assert.strictEqual(options.materialCarrierId, 'E02');
      calls.push('Y1'); options.onOptionalPoolProven({ targetLinkId: 'E04' });
      return { targetLinkId: 'E04' };
    },
    runYotoOptionalToBambooPromptAtomic: async () => { calls.push('Y2'); },
    runBambooPromptToResolvedAtomic: async ({ expectedGain }) => {
      assert.strictEqual(expectedGain, 1); calls.push('Y3');
      return { state: { ...hand, revision: 13, handCount: 7,
        cards: [...hand.cards, { id: 'M14', index: 7 }] } };
    }
  });
  vm.runInContext(production, context);
  return { context, calls, get saved() { return saved; } };
}
async function main() {
  // Replay ISSUE-114's exact saved hand/ledger/decision. Both equips in the
  // GY plus the sole field equip are NOT available after sacrificing it.
  const liveHand = require('../../material/issues/issue-114-hand.json');
  const liveRuntime = require('../../material/issues/issue-114-decision.json');
  const liveLedger = require('../../material/issues/issue-114-ledger.json');
  const liveRemaining = Object.fromEntries(library.cards.map(card =>
    [card.id, Math.max(0, Number(card.count) - Number(liveLedger.outsideDeckCounts[card.id] || 0))]));
  const snapshot = JSON.stringify({ liveHand, liveRuntime, liveLedger });
  const replay = harness({ runtime: liveRuntime, remaining: liveRemaining, actions: [{ id: 'M11' }, { id: 'M13' }] });
  replay.context.normalizeEquippedYotoGoldenDrawPriority(liveHand);
  assert.strictEqual(replay.saved.v5Branch.currentState, 'EQUIPPED_YOTO_NO_SEARCH_TARGET');
  assert.strictEqual(replay.saved.v5Branch.active, false);
  const resources = replay.saved.bambooEquipResources;
  assert.strictEqual(resources.deckCount, 0);
  assert.strictEqual(resources.handCount, 0);
  assert.strictEqual(resources.fieldCount, 1);
  assert.strictEqual(resources.outsideHandFieldCount, 2);
  assert.strictEqual(resources.replacementCountAfterLink, 0);
  assert.strictEqual(replay.saved.graveSpellCount, liveRuntime.graveSpellCount);
  assert.strictEqual(replay.saved.bambooSwordEquipped, true);
  assert.deepStrictEqual(replay.calls, []);
  // Direct dispatch of a stale M19_EQUIPPED branch must also refuse, before
  // either the Link executor or Raye's equipped-Yoto special route is called.
  for (const carrierId of ['E04', 'M06']) {
    const stale = harness({ runtime: { ...liveRuntime, v5Branch: { ...liveRuntime.v5Branch, carrierId } },
      remaining: liveRemaining, actions: [{ id: 'M11' }, { id: 'M13' }] });
    const result = await stale.context.executeFieldTransition({ state: liveHand });
    assert.strictEqual(result.executed, true, 'policy-only state transition is progress, without Link input');
    assert.strictEqual(result.savedObservationOnly, true);
    assert.strictEqual(stale.saved.v5Branch.active, false);
    assert.strictEqual(stale.saved.bambooSwordEquipped, true);
    assert.deepStrictEqual(stale.calls, []);
  }
  assert.strictEqual(JSON.stringify({ liveHand, liveRuntime, liveLedger }), snapshot, 'saved fixtures untouched');
  const phantomEquip = harness({ runtime: { ...liveRuntime, bambooSwordEquipped: false },
    remaining: { M14: 2, M19: 1, M20: 0 } });
  assert.strictEqual((await phantomEquip.context.executeFieldTransition({ state: liveHand })).executed, false);
  assert.deepStrictEqual(phantomEquip.calls, [], 'no field-equip proof means no equipped-Yoto dispatch');
  const heldGolden = harness({ runtime: liveRuntime, remaining: { M14: 2, M19: 1, M20: 0 }, actions: [] });
  assert.strictEqual((await heldGolden.context.executeFieldTransition({ state: { cards: [{ id: 'M14' }] } })).savedObservationOnly, true);
  assert.deepStrictEqual(heldGolden.calls, []);

  const h = harness(), beforeHand = JSON.stringify(hand);
  const rayeRuntime = { ...currentRuntime, equippedBambooId: 'M19', rayeNormalSummoned: true,
    v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'M06' } };
  const raye = harness({ runtime: rayeRuntime, remaining: { M14: 1, M19: 0, M20: 0 } });
  const noSpare = { cards: [{ id: 'M11' }] };
  raye.context.normalizeEquippedYotoGoldenDrawPriority(noSpare);
  assert.strictEqual(raye.saved.v5Branch.active, false);
  await raye.context.executeFieldTransition({ state: noSpare });
  assert.deepStrictEqual(raye.calls, [], 'Raye may not send the absolute last equip even without held Golden');
  const withSpare = { cards: [{ id: 'M11' }, { id: 'M19' }] };
  raye.context.normalizeEquippedYotoGoldenDrawPriority(withSpare);
  assert.strictEqual(raye.saved.v5Branch.active, true);
  assert.strictEqual(raye.saved.bambooContinuationPlan.routeKind, 'RAYE_DIRECT_DUAL');
  await raye.context.executeFieldTransition({ state: withSpare });
  assert.deepStrictEqual(raye.calls, ['R1D']);
  assert.strictEqual(raye.saved.v5Branch.currentState, 'DUAL_OPTIONAL_PENDING');
  assert.strictEqual(raye.saved.v5Branch.summonMode, 'RAYE_DIRECT');
  const beforeRaye = harness({ runtime: { ...rayeRuntime, bambooSwordEquipped: false, equippedBambooId: null,
    v5Branch: { currentState: 'RAYE_NORMAL_SUMMONED', carrierId: 'M06', rayeOnlyMonster: true } },
    remaining: { M14: 1, M19: 0, M20: 0 } });
  await beforeRaye.context.executeFieldTransition({ state: { cards: [{ id: 'M19' }] } });
  assert.deepStrictEqual(beforeRaye.calls, ['EQUIP_SLOT_1'], 'f cannot bypass the equip-before-Raye preparation');
  const e10 = harness({ runtime: { ...currentRuntime, equippedBambooId: 'M19',
    v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E10', summonMode: 'RAYE_DIRECT' } } });
  assert.strictEqual((await e10.context.executeFieldTransition({ state: hand })).savedObservationOnly, true);
  assert.deepStrictEqual(e10.calls, [], 'E10 must never reach the Link executor');
  // ISSUE-120: actual draw put True Sword in hand; cached pre-draw resources
  // must not override the current hand/ledger. The held True closes a fixed
  // chain, which the user's latest clarification ranks above ordinary draw2.
  const issue120Hand = require('../../material/issues/issue-120-hand.json');
  const issue120Runtime = require('../../material/issues/issue-120-decision.json');
  const issue120Ledger = require('../../material/issues/issue-120-ledger.json');
  const issue120Remaining = Object.fromEntries(library.cards.map(card =>
    [card.id, Math.max(0, Number(card.count) - Number(issue120Ledger.outsideDeckCounts[card.id] || 0))]));
  const issue120 = harness({ runtime: issue120Runtime, remaining: issue120Remaining });
  const immutable = JSON.stringify({ issue120Hand, issue120Runtime, issue120Ledger });
  issue120.context.normalizeEquippedYotoGoldenDrawPriority(issue120Hand);
  assert.strictEqual(issue120.saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.strictEqual(issue120.saved.bambooContinuationPlan.searchId, 'M14');
  assert.strictEqual(issue120.saved.bambooContinuationPlan.replacementSource, 'HAND');
  assert.strictEqual(issue120.saved.bambooContinuationPlan.goldenDrawReady, true);
  assert.strictEqual(issue120.saved.bambooEquipResources.byId.M20.deck, 0);
  assert.strictEqual(issue120.saved.bambooEquipResources.byId.M20.hand, 1);
  assert.strictEqual(issue120.saved.bambooContinuationPlan.projectedEquipSentToGraveCount, 2);
  assert.deepStrictEqual(issue120.calls, []);
  // Pre-input dispatch must honor the same fixed-chain layer, not add a
  // blanket Golden lock different from the actual recommender.
  await issue120.context.executeFieldTransition({ state: issue120Hand });
  assert.deepStrictEqual(issue120.calls, ['Y1'], 'fixed target with held replacement wins over ordinary Golden');
  assert.strictEqual(JSON.stringify({ issue120Hand, issue120Runtime, issue120Ledger }), immutable);
  // The first equip with both other equips still in Deck uses the other
  // complete route, searching True before the True -> Deck Yoto conversion.
  const fromDeck = harness({ runtime: { ...currentRuntime, equippedBambooId: 'M19',
    v5Branch: { ...currentRuntime.v5Branch, active: true, currentState: 'M19_EQUIPPED', goldenDrawSetup: true } },
    remaining: { M14: 1, M19: 1, M20: 1 } });
  const onlyGolden = { cards: [{ id: 'M14' }] };
  fromDeck.context.normalizeEquippedYotoGoldenDrawPriority(onlyGolden);
  assert.strictEqual(fromDeck.saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.strictEqual(fromDeck.saved.bambooContinuationPlan.searchId, 'M20');
  assert.strictEqual(fromDeck.saved.bambooContinuationPlan.replacementSource, 'YOTO_SEARCH');
  assert.strictEqual(fromDeck.saved.bambooContinuationPlan.projectedEquipSentToGraveCount, 2);
  await fromDeck.context.executeFieldTransition({ state: onlyGolden });
  assert.deepStrictEqual(fromDeck.calls, ['Y1']);
  h.context.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(h.saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.strictEqual(h.saved.v5Branch.active, true);
  assert.strictEqual(h.saved.v5Branch.carrierId, 'E02');
  assert.strictEqual(h.context.isTransactionPendingNode(), true,
    'the formal loop must select the field lock before Engage or Mallet');
  assert.ok(h.context.currentFieldActionLabel().startsWith('Y1：'));
  assert.deepStrictEqual(h.calls, [], 'reopening sends no game input');
  assert.strictEqual(h.saved.graveSpellCount, 7);
  assert.strictEqual(h.saved.effectUsage.M19_SEARCH, 0);
  assert.strictEqual(h.saved.usedCounts.M20, 1);
  assert.strictEqual(JSON.stringify(hand), beforeHand);
  const normalizedOnce = JSON.stringify(h.saved);
  h.context.normalizeEquippedYotoGoldenDrawPriority(hand);
  assert.strictEqual(JSON.stringify(h.saved), normalizedOnce, 'normalization is idempotent');

  const actualDeadHand = { revision: 2, handCount: 6,
    cards: ['M01', 'M02', 'M04', 'M06', 'M06', 'M17'].map((id, i) => ({ id, index: i + 1 })) };
  const actualDeadRuntime = { ...currentRuntime, graveSpellCount: 24, bambooSwordEquipped: true,
    normalSummonUsed: false, usedCounts: { ...currentRuntime.usedCounts, M17: 2, M19: 1 },
    v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E04',
      source: 'FORMAL_V5_AFTER_GOLDEN_DRAWS_Y1_AVAILABLE' } };
  const stranded = harness({ runtime: actualDeadRuntime,
    remaining: { M14: 2, M19: 0, M20: 0 }, actions: [] });
  stranded.context.normalizeEquippedYotoGoldenDrawPriority(actualDeadHand);
  assert.strictEqual(stranded.saved.v5Branch.currentState, 'EQUIPPED_YOTO_NO_SEARCH_TARGET');
  assert.strictEqual(stranded.saved.v5Branch.active, false);
  assert.strictEqual(stranded.saved.bambooSwordEquipped, true,
    'closing the false continuation does not claim the equipped field card moved');
  assert.deepStrictEqual(stranded.calls, [], 'current deadlock repair sends no game input');

  const options = { state: hand };
  await h.context.executeFieldTransition(options);
  assert.deepStrictEqual(h.calls, ['Y1'], 'one explicit dispatch executes one node, without M20/T20 replay');
  assert.strictEqual(h.saved.v5Branch.currentState, 'YOTO_LINK_RESOLVED');
  assert.strictEqual(h.saved.bambooSwordEquipped, false, 'proved Link already removed the field equip before Y2/Y3');
  assert.strictEqual(h.saved.equippedBambooId, null);
  assert.strictEqual(h.saved.effectUsage.M19_SEARCH, 0);
  await h.context.executeFieldTransition(options);
  assert.deepStrictEqual(h.calls, ['Y1', 'Y2']);
  assert.strictEqual(h.saved.v5Branch.currentState, 'YOTO_SEARCH_PROMPT');
  const result = await h.context.executeFieldTransition(options);
  assert.deepStrictEqual(h.calls, ['Y1', 'Y2', 'Y3']);
  assert.strictEqual(result.state.cards.at(-1).id, 'M14');
  assert.strictEqual(result.state.handCount, 7);
  assert.strictEqual(h.saved.v5Branch.currentState, 'YOTO_SEARCH_DONE');
  assert.strictEqual(h.saved.bambooSwordEquipped, false, 'search is not proof of a new equip');
  assert.strictEqual(h.saved.graveSpellCount, 8);
  assert.strictEqual(h.saved.effectUsage.M19_SEARCH, 1);
  h.context.normalizeEquippedYotoGoldenDrawPriority(result.state);
  assert.strictEqual(h.context.isTransactionPendingNode(), false, 'completed Y1 is not reopened');
  for (const node of ['M19_EQUIPPED', 'GOLDEN_BAMBOO_DRAW_READY']) {
    const fresh = harness({ runtime: { ...currentRuntime, v5Branch: { active: true,
      currentState: node, carrierId: 'E02', source: 'FORMAL_V5_T20_3_REPEATABLE_M19' } } });
    fresh.context.normalizeEquippedYotoGoldenDrawPriority(hand);
    assert.strictEqual(fresh.saved.v5Branch.currentState, 'M19_EQUIPPED');
    assert.strictEqual(fresh.context.isTransactionPendingNode(), true);
    assert.deepStrictEqual(fresh.calls, []);
  }
  for (const setup of [ { remaining: { M14: 0, M19: 1, M20: 0 } }, { unknown: true } ]) {
    const closed = harness(setup);
    closed.context.normalizeEquippedYotoGoldenDrawPriority(hand);
    assert.strictEqual(closed.saved.v5Branch.currentState, 'EQUIPPED_YOTO_NO_SEARCH_TARGET');
  }
  for (const override of [ { bambooSwordEquipped: false },
    { v5Branch: { ...currentRuntime.v5Branch, carrierId: null } },
    { v5Branch: { ...currentRuntime.v5Branch, source: 'UNPROVEN' } },
    { v5Branch: { ...currentRuntime.v5Branch, goldenDrawEquipId: 'M20' } } ]) {
    const guarded = harness({ runtime: { ...currentRuntime, ...override } });
    guarded.context.normalizeEquippedYotoGoldenDrawPriority(hand);
    assert.strictEqual(guarded.saved.v5Branch.currentState, 'EQUIPPED_YOTO_NO_SEARCH_TARGET');
    assert.deepStrictEqual(guarded.calls, []);
  }
  const ready = harness({ runtime: { ...currentRuntime, v5Branch: { active: true,
    currentState: 'M19_EQUIPPED', carrierId: 'E02', source: 'FORMAL_V5_T20_3_REPEATABLE_M19' } } });
  ready.context.normalizeEquippedYotoGoldenDrawPriority({ cards: [{ id: 'M14' }] });
  assert.strictEqual(ready.saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  assert.strictEqual(ready.saved.v5Branch.active, false, 'Golden in hand preserves its equipped carrier');
  const illegal = harness();
  illegal.context.normalizeEquippedYotoGoldenDrawPriority(hand);
  illegal.context.runEquippedYotoLinkToOptionalAtomic = async () => { throw new Error('NO_LEGAL_LINK'); };
  await assert.rejects(illegal.context.executeFieldTransition(options), /NO_LEGAL_LINK/);
  assert.strictEqual(illegal.saved.v5Branch.currentState, 'M19_EQUIPPED');
  assert.deepStrictEqual(illegal.calls, [], 'failed Y1 never falls through to Y2/Y3');
  console.log('LAST_EQUIPPED_YOTO_GUARD_OFFLINE_PASS; ISSUE-114 deck0/hand0/field1/GY-other2 blocks stale Y1/Raye inputs; valid stock keeps Y1/Y2/Y3');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
