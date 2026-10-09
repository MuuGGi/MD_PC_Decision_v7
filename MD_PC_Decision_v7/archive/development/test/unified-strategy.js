'use strict';
const assert = require('assert');
const library = require('../../../engine/card-library.json');
const mature = require('../../../engine/runtime/mature-driver');
const { createDecisionContext } = require('../../../src/strategy/decision-context');
const { evaluateDecision } = require('../../../src/strategy/decision');
const { arbitrateCandidates } = require('../../../src/strategy/action-order');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const { hashValue, clone } = require('../../../src/core/json-store');
const { withDecisionLedgerSnapshot } = require('../../../engine/lib/main-deck-ledger');
const { chooseBambooSearchTarget } = require('../../../engine/lib/bamboo-search-policy');
const { chooseBambooLinkTarget } = require('../../../engine/lib/yoto-search-value');
const { describeCombinedYotoZero, chooseEquippedRayeLink } = require('../../../engine/lib/double-link-policy');
const options = { isStrategicallyUsable: mature.isStrategicallyUsable,
  hasNonRayeMonster: () => false, isTransactionPending: mature.isTransactionPendingNode,
  isFieldPlanning: mature.isFieldPlanningNode };
let count = 0;
function fixture(ids, changes = {}, exits = {}) {
  const hand = { revision: 0, handCount: ids.length, cards: ids.map((id, n) =>
    ({ id, name: library.cards.find(c => c.id === id).name, index: n + 1, usable: true })) };
  const runtime = { graveSpellCount: 0, normalSummonUsed: false, rayeNormalSummoned: false,
    bambooSwordEquipped: false, equipSentToGraveCount: 0, usedCounts: {}, effectUsage: {},
    v5Branch: { currentState: 'IDLE', active: false }, ...clone(changes) };
  const held = {}; ids.forEach(id => { held[id] = (held[id] || 0) + 1; });
  const ledger = { version: 2, mode: 'OUTSIDE_DECK_COUNT', lastHandRevision: 0,
    unknownExodiaOutsideCount: 0, outsideDeckCounts: Object.fromEntries(library.cards
      .filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, exits[c.id] ?? Math.min(c.count,
        (held[c.id] || 0) + (runtime.equippedBambooCounts?.[c.id] || 0) + (runtime.usedCounts[c.id] || 0))])) };
  const fact = data => ({ status: 'KNOWN', data, hash: hashValue(data) });
  const snapshot = { snapshotKey: hashValue({ hand, runtime, ledger }), consistency: [],
    hand: fact(hand), runtime: fact(runtime), ledger: fact(ledger), library: fact(library),
    session: fact({ duelId: 'OFFLINE', startProven: true }), log: { status: 'UNKNOWN' },
    observerState: { status: 'UNKNOWN' } };
  return { hand, runtime, ledger, snapshot };
}
function decide(ids, changes, exits) {
  const f = fixture(ids, changes, exits), before = JSON.stringify(f);
  const context = createDecisionContext(f.snapshot, f.hand);
  const decision = evaluateDecision(context, options);
  assert.equal(JSON.stringify(f), before, 'strategy must not mutate its authorities');
  assert.strictEqual(decision.selected, decision.result.selected);
  assert.equal(context.zones.banished.status, 'UNKNOWN');
  assert.equal(context.zones.grave.status, 'PARTIAL');
  return decision;
}
const field = (sent = false) => ({ graveSpellCount: 3, usedCounts: { M17: 1 },
  effectUsage: { KAGARI_RECOVERY: 1, ...(sent ? { M19_SEARCH: 1 } : {}) },
  equipSentToGraveCount: sent ? 1 : 0,
  v5Branch: { currentState: 'KAGARI_RECOVERY_DONE', carrierId: 'E02', active: false } });
async function run() {
  const check = (name, fn) => { fn(); count++; console.log('V7_UNIFIED_STRATEGY PASS ' + name); };
  await withStrictReadOnly(async () => {
    check('example opener searches Hornet for actual held sword', () => {
      const d = decide(['M01', 'M02', 'M20', 'M17', 'M14']);
      assert.equal(d.selected.id, 'M17'); assert.equal(d.selected.details.searchTarget.id, 'M22');
    });
    check('empty field without sword still searches Hornet; Raye is not auto-summoned', () => {
      assert.equal(decide(['M01', 'M02', 'M17', 'M13', 'M08']).selected.details.searchTarget.id, 'M22');
      assert.notEqual(decide(['M01', 'M02', 'M03', 'M11', 'M06']).selected?.id, 'M06');
    });
    check('Allure with safe Raye fee outranks uncompleted sword stage double Link', () => {
      const d = decide(['M01', 'M02', 'M06', 'M08', 'M13', 'M16'], field());
      assert.equal(d.selected.id, 'M13'); assert.equal(d.selected.details.banishTarget.id, 'M06');
      assert(!d.result.actions.some(a => a.id === 'M06' && a.tier < 3));
    });
    check('confirmed departed sword raises double Link without consuming reserved input', () => {
      const d = decide(['M01', 'M02', 'M06', 'M08', 'M13', 'M16'], field(true));
      assert.equal(d.selected.id, 'M06'); assert.equal(d.selected.tier, 2.5);
      assert.equal(d.selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
    });
    check('no sword is deferral, not a false deadlock when proven Raye recovery remains', () => {
      const d = decide(['M01', 'M02', 'M03', 'M04', 'M06'], { graveSpellCount: 3 });
      assert.equal(d.selected.id, 'M06'); assert.equal(d.selected.tier, 101);
      assert.equal(d.selected.details.swordEntryDeferred, true);
      assert.equal(d.strategicDeadlock.terminal, false);
    });
    check('Allure Raye need outranks generic already-summoned HAMP preference', () => {
      for (const normalSummonUsed of [false, true]) {
        const d = decide(['M01', 'M02', 'M17', 'M13', 'M08'], { normalSummonUsed,
          v5Branch: { currentState: 'IDLE', active: false, carrierId: 'E02' } });
        assert.equal(d.selected.id, 'M17'); assert.equal(d.selected.details.searchTarget.id, 'M06');
      }
    });
    check('safe existing Raye does not demand another Raye', () => {
      const d = decide(['M01', 'M02', 'M17', 'M13', 'M06'], { graveSpellCount: 3,
        v5Branch: { currentState: 'IDLE', active: false, carrierId: 'E02' } });
      assert.equal(d.selected.details.searchTarget.id, 'M08');
    });
    check('real Trade-In cost deficit targets HAMP before general Raye', () => {
      const occupied = { graveSpellCount: 3, v5Branch: { active: false, currentState: 'IDLE', carrierId: 'E02' } };
      assert.equal(decide(['M01', 'M02', 'M17', 'M12', 'M13'], occupied).selected.details.searchTarget.id, 'M08');
      assert.equal(decide(['M17', 'M12', 'M12', 'M08', 'M13'], occupied).selected.details.searchTarget.id, 'M08');
    });
    check('completed token offers conversion before destroying ready equipment draw', () => {
      const d = decide(['M01', 'M02', 'M20', 'M14'], { graveSpellCount: 2,
        usedCounts: { M17: 1, M22: 1 }, v5Branch: {
          active: true, currentState: 'HORNET_TOKEN_READY', carrierId: 'TOKEN_SKY_STRIKER' } });
      assert.equal(d.selected.id, 'M20');
      assert.notEqual(d.selected.details.fieldIntent, 'TOKEN_LINK_KAGARI');
    });
    check('completed True equip returns a current conversion candidate, not pending UI', () => {
      const runtime = { bambooSwordEquipped: true, equippedBambooId: 'M20',
        equippedBambooCounts: { M20: 1 }, v5Branch: {
          active: true, currentState: 'M20_EQUIPPED', carrierId: 'TOKEN_SKY_STRIKER' } };
      const d = decide(['M01', 'M02', 'M14'], runtime);
      assert.equal(d.selected.details.fieldIntent, 'TRUE_EQUIP_CONVERSION');
      assert.equal(mature.isTransactionPendingNode('M20_EQUIPPED'), false);
    });
    check('example converted Yoto draws held Golden before speculative last sword departure', () => {
      const d = decide(['M01', 'M02', 'M14'], { graveSpellCount: 3, equipSentToGraveCount: 1,
        usedCounts: { M17: 1, M22: 1, M20: 1 }, bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'TOKEN_SKY_STRIKER' } });
      assert.equal(d.selected.id, 'M14');
    });
    check('after Golden resolves current Yoto and known GY Engage offer combined Fire gain', () => {
      const d = decide(['M01', 'M02', 'M03', 'M04'], { graveSpellCount: 4, equipSentToGraveCount: 1,
        usedCounts: { M17: 1, M22: 1, M20: 1, M14: 1 }, bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'TOKEN_SKY_STRIKER' } });
      assert.equal(d.selected.details.fieldIntent, 'EQUIPPED_BAMBOO_DEPARTURE');
      assert.equal(d.selected.details.targetLinkId, 'E02');
    });
    check('two Yoto plans distinguish real field receipt from remaining hand fee', () => {
      const d = decide(['M01', 'M02', 'M19'], { graveSpellCount: 3, usedCounts: { M17: 1, M22: 1 },
        bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'TOKEN_SKY_STRIKER',
          materialCarrierId: 'TOKEN_SKY_STRIKER', kagariSwordLink: true, m19EffectCount: 2 } });
      assert.equal(d.selected.details.currentYotoCount, 1); assert.equal(d.selected.details.m19EffectCount, 2);
      assert.equal(d.decisionTrace.candidates[0].costs.M19, 1);
    });
    check('Golden consumes current last equip yield before speculative departure or Mallet', () => {
      const d = decide(['M01', 'M02', 'M14', 'M11'], { bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: false, currentState: 'GOLDEN_BAMBOO_DRAW_READY', carrierId: 'E10' } }, { M19: 2 });
      assert.equal(d.selected.id, 'M14');
    });
    check('Toon fixed search outranks current equipped conversion', () => {
      const d = decide(['M01', 'M02', 'M10', 'M14'], { bambooSwordEquipped: true,
        equippedBambooId: 'M20', equippedBambooCounts: { M20: 1 },
        v5Branch: { active: true, currentState: 'M20_EQUIPPED', carrierId: 'E02' } });
      assert.equal(d.selected.id, 'M10');
    });
    check('already field two materials require current receipts and do not charge hand Raye', () => {
      const runtime = { ...field(true), normalSummonUsed: true, rayeNormalSummoned: true,
        v5Branch: { active: true, currentState: 'RAYE_SECOND_MATERIAL_READY', carrierId: 'E02' } };
      const d = decide(['M01', 'M02', 'M13', 'M08'], runtime);
      assert.equal(d.selected.details.fieldIntent, 'COMMITTED_TWO_MATERIAL_GAIN');
      assert.equal(d.decisionTrace.candidates[0].costs.M06, undefined);
      assert.notEqual(decide(['M01', 'M02', 'M13', 'M08'], { ...runtime, rayeNormalSummoned: false })
        .selected?.details.fieldIntent, 'COMMITTED_TWO_MATERIAL_GAIN');
    });
    check('ordinary selection is invariant under hand order aside from exact slots', () => {
      for (const ids of [['M06', 'M13', 'M08', 'M01'], ['M01', 'M08', 'M13', 'M06']]) {
        const d = decide(ids, field());
        assert.equal(d.selected.id, 'M13'); assert.equal(ids[d.selected.slot - 1], 'M13');
      }
    });
    check('missing fee is rejected, never repaired by selecting another fee', () => {
      const d = arbitrateCandidates([{ id: 'M13', slot: 1, tier: 3,
        details: { banishTarget: { id: 'M06' } } }], {}, { M13: 1 });
      assert.equal(d.selected, null); assert.equal(d.rejected[0].reason, 'CURRENT_HAND_COST_UNAVAILABLE');
    });
    check('pending UI prevents new strategy regardless of held draws', () => {
      const f = fixture(['M13', 'M06'], { v5Branch: { active: true, currentState: 'DUAL_OPTIONAL_PENDING' } });
      assert.throws(() => evaluateDecision(createDecisionContext(f.snapshot, f.hand), options), /UNFINISHED_TRANSACTION/);
    });
    check('revision mismatch and inconsistent/unknown authority do not publish decision', () => {
      const f = fixture(['M13', 'M06']);
      assert.throws(() => createDecisionContext(f.snapshot, { ...f.hand, revision: 1 }), /HAND_NOT_SNAPSHOT/);
      assert.throws(() => createDecisionContext({ ...f.snapshot, consistency: [{}] }, f.hand), /INCONSISTENT/);
      assert.throws(() => createDecisionContext({ ...f.snapshot, ledger: { status: 'UNKNOWN' } }, f.hand), /SOURCE_UNKNOWN/);
    });
    // Oct 8 rule plus Oct 9 A/B refactor: these exercise the actual final
    // evaluator. Offline only; no GUI/game/bridge actions are started.
    check('after sword departure and Fire recovery, search Raye before equipping final sword', () => {
      const runtime = { ...field(true), usedCounts: { M19: 1 },
        v5Branch: { active: false, carrierId: 'E02', currentState: 'KAGARI_RECOVERY_DONE' } };
      const d = decide(['M20', 'M17', 'M13', 'M14', 'M18'], runtime);
      assert.equal(d.selected.id, 'M17'); assert.equal(d.selected.details.searchTarget.id, 'M06');
      assert.equal(d.result.equipmentOpportunity.deferEquipment, true);
      assert(!d.result.actions.some(a => ['M19', 'M20'].includes(a.id)));
    });
    check('new joint departure combines productive Yoto; nonproductive final True still keeps bare Zero', () => {
      // Explicit Oct 9 rule change: a searching Yoto can combine with Zero;
      // this is not a lowered threshold or a special completed-node override.
      const combined = decide(['M06', 'M19', 'M13', 'M14'], field(true));
      assert.equal(combined.selected.id, 'M19');
      assert.equal(combined.selected.details.jointGain.savedExtraDeckSummons, 1);
      const d = decide(['M06', 'M20', 'M13', 'M14'], field(true));
      assert.equal(d.selected.id, 'M06'); assert.equal(d.selected.tier, 2.5);
      assert.equal(d.selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
      assert(!d.result.actions.some(a => ['M19', 'M20'].includes(a.id)));
    });
    check('after Raye summon, current two materials still outrank equip and Allure', () => {
      const d = decide(['M20', 'M13', 'M08', 'M14'], { ...field(true),
        normalSummonUsed: true, rayeNormalSummoned: true,
        v5Branch: { active: true, currentState: 'RAYE_SECOND_MATERIAL_READY', carrierId: 'E02' } });
      assert.equal(d.selected.details.fieldIntent, 'COMMITTED_TWO_MATERIAL_GAIN');
      assert(!d.result.actions.some(a => ['M19', 'M20'].includes(a.id)));
    });
    check('joint departure publishes equip, summon and dual Link from fresh snapshots', () => {
      const base = field();
      const equip = decide(['M06', 'M19', 'M13', 'M14'], base);
      assert.equal(equip.selected.id, 'M19');
      assert.equal(equip.selected.details.equipIntent.carrierId, 'E02');
      assert.equal(equip.selected.details.jointGain.extraDeckSummons, 1);
      assert.equal(equip.selected.details.jointGain.alternativeExtraDeckSummons, 2);
      assert.deepStrictEqual(equip.decisionTrace.candidates[0].costs, { M19: 1 });
      const equipped = { ...base, bambooSwordEquipped: true, equippedBambooId: 'M19',
        equippedBambooCounts: { M19: 1 }, v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } };
      const summon = decide(['M06', 'M13', 'M14'], equipped);
      assert.equal(summon.selected.id, 'M06');
      assert.equal(summon.selected.details.preserveEquippedYoto, true);
      assert.deepStrictEqual(summon.decisionTrace.candidates[0].costs, { M06: 1 });
      const before = JSON.stringify(equipped);
      const after = mature.deriveRayeNormalSummonState(equipped, { doubleLinkRecovery: true,
        preserveEquippedYoto: true, carrierId: 'E02', e10EngageSource: 'GRAVE' });
      assert.equal(JSON.stringify(equipped), before);
      assert.equal(after.v5Branch.currentState, 'M19_EQUIPPED');
      assert.deepStrictEqual(after.equippedBambooCounts, { M19: 1 });
      assert.equal(after.equipSentToGraveCount, 0, 'summoning Raye does not fabricate departure');
      const link = decide(['M13', 'M14'], after);
      assert.equal(link.selected.details.fieldIntent, 'EQUIPPED_BAMBOO_DEPARTURE');
      assert.equal(link.selected.details.targetLinkId, 'E10');
      assert.equal(link.selected.details.doubleWithRaye, true);
      assert.equal(link.selected.details.m19EffectCount, 1);
      assert.deepStrictEqual(link.decisionTrace.candidates[0].costs, {});
      const choice = chooseEquippedRayeLink(['M13', 'M14'].map(id => ({ id })), link.runtime,
        link.result.deck, link.runtime.bambooContinuationPlan);
      assert.equal(choice.answer, '2', 'executor and final strategy share the same readiness');
    });
    check('True is converted before offering the normal-summon part of joint departure', () => {
      const base = field();
      assert.equal(decide(['M06', 'M20', 'M13'], base).selected.id, 'M20');
      const trueField = { ...base, bambooSwordEquipped: true, equippedBambooId: 'M20',
        equippedBambooCounts: { M20: 1 }, usedCounts: { M20: 1, M17: 1 },
        v5Branch: { active: true, currentState: 'M20_EQUIPPED', carrierId: 'E02' } };
      assert.equal(decide(['M06', 'M13'], trueField).selected.details.fieldIntent, 'TRUE_EQUIP_CONVERSION');
      const yotoField = { ...trueField, graveSpellCount: 4, equipSentToGraveCount: 1,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } };
      assert.equal(decide(['M06', 'M13'], yotoField, { M19: 1 }).selected.id, 'M06');
    });
    check('one extra summon never discards an additional unused Fire gain', () => {
      const d = decide(['M06', 'M19', 'M14'], { ...field(), effectUsage: {},
        v5Branch: { active: false, currentState: 'IDLE', carrierId: 'E04' } });
      assert.equal(d.selected.details.fieldIntent, 'KAGARI_SWORD_PREPARATION');
      assert.equal(d.decisionTrace.branchDecision.combinedZeroOpportunity.reason, 'PRESERVE_ADDITIONAL_UNUSED_FIRE_GAIN');
    });
    check('no searching target preserves the absolute last equip and cashes Golden', () => {
      const d = decide(['M06', 'M14'], { ...field(), bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } }, { M19: 2, M20: 1 });
      assert.equal(d.selected.id, 'M14');
      assert(!d.result.actions.some(a => a.details?.doubleWithRaye));
    });
    check('joint gain does not invent a missing normal-summon fee or reuse a spent summon', () => {
      for (const f of [fixture(['M19', 'M14'], field()),
        fixture(['M06', 'M19', 'M14'], { ...field(), normalSummonUsed: true })]) {
        const d = evaluateDecision(createDecisionContext(f.snapshot, f.hand), options);
        assert.notEqual(d.decisionTrace.branchDecision.fork, 'COMBINED_YOTO_ZERO_GAIN');
      }
    });
    check('no Deck search targets or Engage source prevents a combined gain claim', () => {
      for (const exits of [{ M06: 2, M08: 2, M22: 1 }, { M17: 3 }]) {
        const d = decide(['M06', 'M19', 'M14'], { ...field(), usedCounts: {} }, exits);
        assert.notEqual(d.decisionTrace.branchDecision.fork, 'COMBINED_YOTO_ZERO_GAIN');
      }
    });
    check('used or non-material Zero and two-Main-zone placement are not guessed capabilities', () => {
      for (const change of [{ effectUsage: { KAGARI_RECOVERY: 1, E10_SUMMON: 1 } },
        { v5Branch: { active: false, currentState: 'IDLE', carrierId: 'E10' } },
        { v5Branch: { active: false, currentState: 'HORNET_TOKEN_READY', carrierId: 'TOKEN_SKY_STRIKER' } }]) {
        const d = decide(['M06', 'M19', 'M14'], { ...field(), ...change });
        assert.notEqual(d.decisionTrace.branchDecision.fork, 'COMBINED_YOTO_ZERO_GAIN');
      }
    });
    check('two equipped Yotos cannot be mislabeled as a two-effect Zero pool', () => {
      const d = decide(['M06', 'M14'], { ...field(), bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 2 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } }, { M19: 2 });
      assert.equal(d.decisionTrace.branchDecision.combinedZeroOpportunity.reason, 'MULTI_YOTO_ZERO_POOL_NOT_SUPPORTED');
    });
    check('combined gain queries are pure and reject unknown Deck evidence', () => {
      const d = decide(['M06', 'M19', 'M14'], field());
      const before = JSON.stringify(d.result.deck);
      const unknown = { ...d.result.deck, deckRemaining: { ...d.result.deck.deckRemaining, M17: undefined } };
      assert.equal(describeCombinedYotoZero([{ id: 'M06' }, { id: 'M19' }], d.runtime, unknown).reason, 'RESOURCE_EVIDENCE_UNKNOWN');
      assert.equal(JSON.stringify(d.result.deck), before);
    });
    check('combined source and capacity use actual remaining cards, not a hoped-for draw', () => {
      const d = decide(['M06', 'M19', 'M14'], field());
      const thin = { ...d.result.deck, deckRemaining: Object.fromEntries(
        Object.keys(d.result.deck.deckRemaining).map(id => [id, ['M20', 'M17', 'M08'].includes(id) ? 1 : 0])) };
      const runtime = { ...field(), usedCounts: {}, bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: false, currentState: 'M19_EQUIPPED', carrierId: 'E02' } };
      assert.equal(describeCombinedYotoZero([{ id: 'M06' }], runtime, thin).reason, 'INSUFFICIENT_DECK_FOR_COMBINED_GAIN');
      assert.equal(describeCombinedYotoZero([{ id: 'M06' }, { id: 'M19' }],
        { ...field(), graveSpellCount: 0 }, d.result.deck).reason, 'GRAVE_SOURCE_EVIDENCE_INCONSISTENT');
    });
    check('equip-to-normal publication is re-proved; an intervening effect does not silently re-route', () => {
      const f = fixture(['M06', 'M14'], { ...field(), bambooSwordEquipped: true,
        equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } });
      const d = evaluateDecision(createDecisionContext(f.snapshot, f.hand), options);
      withDecisionLedgerSnapshot(f.ledger, () => {
        mature.assertPublishedBranchAction(f.hand, f.runtime, d);
        assert.throws(() => mature.assertPublishedBranchAction(f.hand,
          { ...f.runtime, effectUsage: { E10_SUMMON: 1 } }, d), /RESOURCES_CHANGED/);
      });
    });
    check('second-material receipt cannot erase equipment, fake a carrier or fabricate sword departure', () => {
      const base = { ...field(), bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 } };
      assert.throws(() => mature.deriveRayeNormalSummonState(base,
        { doubleLinkRecovery: true, preserveEquippedYoto: true, carrierId: 'E04' }), /RECEIPT_INVALID/);
      assert.throws(() => mature.deriveRayeNormalSummonState({ ...base, equippedBambooCounts: { M19: 2 } },
        { doubleLinkRecovery: true, preserveEquippedYoto: true, carrierId: 'E02' }), /RECEIPT_INVALID/);
      const { atomicContinuationDecision } = require('../../../engine/lib/atomic-response-continuation-policy');
      assert.equal(atomicContinuationDecision('M19_EQUIPPED', 'DUAL_OPTIONAL_PENDING').autoContinue, true);
    });
    check('equipment deferral does not steal urgent Trade-In partner target', () => {
      const d = decide(['M20', 'M17', 'M12', 'M13', 'M14'], { ...field(true), usedCounts: { M19: 1 } });
      assert.equal(d.selected.id, 'M17'); assert.equal(d.selected.details.searchTarget.id, 'M08');
    });
    check('used Zero, spent summon or missing gain restores ordinary equipment choices', () => {
      for (const change of [{ effectUsage: { KAGARI_RECOVERY: 1, M19_SEARCH: 1, E10_SUMMON: 1 } },
        { normalSummonUsed: true }, { graveSpellCount: 0 }]) {
        const d = decide(['M06', 'M20', 'M13', 'M14'], { ...field(true), ...change });
        assert(d.result.actions.some(a => a.id === 'M20'));
        assert.notEqual(d.result.equipmentOpportunity?.deferEquipment, true);
      }
      const d = decide(['M20', 'M14'], { ...field(true),
        effectUsage: { KAGARI_RECOVERY: 1, M19_SEARCH: 1, E10_SUMMON: 1 },
        v5Branch: { active: false, currentState: 'E10_EFFECT_RESOLVED', carrierId: 'E10' } });
      assert.equal(d.selected.id, 'M20', 'final equip resumes on the proven Zero carrier');
    });
    check('actual interrupted opener chooses Hornet despite Trade-In and absent knife', () => {
      const d = decide(['M12', 'M14', 'M16', 'M17'], { graveSpellCount: 7,
        usedCounts: { M10: 3, M12: 1, M07: 1, M15: 2, M11: 1 } });
      assert.equal(d.selected.id, 'M17'); assert.equal(d.selected.details.searchTarget.id, 'M22');
      assert.equal(d.decisionTrace.branchDecision.fork, 'CARRIER_ENTRY');
    });
    check('same resources do not acquire priority from completed-node spelling', () => {
      const selections = ['KAGARI_RECOVERY_DONE', 'YOTO_SEARCH_DONE', 'IDLE', 'BRANCH_COMPLETE'].map(currentState => {
        const d = decide(['M20', 'M14', 'M13', 'M08'], { ...field(),
          v5Branch: { active: false, carrierId: 'E02', currentState } });
        return [d.selected.id, d.selected.tier, d.selected.details.phase];
      });
      selections.forEach(selection => assert.deepStrictEqual(selection, selections[0]));
    });
    check('bare Fire and equipment preparation are distinct published current actions', () => {
      const runtime = { graveSpellCount: 3, usedCounts: { M17: 1, M22: 1 },
        v5Branch: { active: false, currentState: 'HORNET_TOKEN_READY', carrierId: 'TOKEN_SKY_STRIKER' } };
      const bare = decide(['M01', 'M02'], runtime);
      assert.equal(bare.selected.details.fieldIntent, 'BARE_KAGARI_LINK');
      const prepared = decide(['M19', 'M19'], runtime);
      assert.equal(prepared.selected.details.fieldIntent, 'KAGARI_SWORD_PREPARATION');
      assert.equal(prepared.selected.details.kagariPreparation.m19EffectCount, 2);
    });
    check('True plus Yoto cannot invent another Deck True after conversion', () => {
      const runtime = { graveSpellCount: 3, usedCounts: { M17: 1, M22: 1 },
        v5Branch: { active: false, currentState: 'HORNET_TOKEN_READY', carrierId: 'TOKEN_SKY_STRIKER' } };
      const d = decide(['M20', 'M19'], runtime);
      assert.equal(d.selected.details.kagariPreparation.plannedSwordId, 'M20');
      const converted = decide(['M19'], { ...runtime, usedCounts: { ...runtime.usedCounts, M20: 1 },
        bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { ...runtime.v5Branch, currentState: 'M19_EQUIPPED' } });
      assert.equal(converted.selected.details.m19EffectCount, 1);
      assert.equal(converted.selected.details.additionalHandCosts.M19, undefined);
      assert.equal(converted.selected.details.bambooSearchTargetId, 'M14');
    });
    check('last field equip is not sacrificed for a Golden with no replacement', () => {
      const d = decide(['M14', 'M11'], { bambooSwordEquipped: true, equippedBambooId: 'M19',
        equippedBambooCounts: { M19: 1 }, v5Branch: { active: false, currentState: 'M19_EQUIPPED', carrierId: 'E02' } },
      { M19: 2, M20: 1 });
      assert.equal(d.selected.id, 'M14');
      assert(!d.result.actions.some(a => a.details?.fieldIntent === 'EQUIPPED_BAMBOO_DEPARTURE'));
    });
    check('search objective stocks equip first, or Golden when a real hand equip exists', () => {
      const deckRemaining = { M20: 1, M14: 2 };
      assert.equal(chooseBambooSearchTarget({ deckRemaining, handCards: [] }).id, 'M20');
      assert.equal(chooseBambooSearchTarget({ deckRemaining, handCards: [{ id: 'M19' }] }).id, 'M14');
      assert.equal(chooseBambooSearchTarget({ deckRemaining, handCards: [{ id: 'M20' }, { id: 'M14' }] }).id, 'M14');
      assert.equal(chooseBambooSearchTarget({ deckRemaining: {}, handCards: [] }).id, null);
    });
    check('Link target does not depend on candidate window traversal order', () => {
      for (const legal of [['E05', 'E03', 'E04'], ['E04', 'E05', 'E03']])
        assert.equal(chooseBambooLinkTarget(legal, { carrierId: 'E02' }), 'E03');
      assert.equal(chooseBambooLinkTarget(['E02', 'E03'], { carrierId: 'E04', recoveryReady: true }), 'E02');
      assert.equal(chooseBambooLinkTarget(['E06'], {}), null, 'unsupported capability is explicit');
    });
    check('executor validates the published equip and rejects changed intent without input', () => {
      const f = fixture(['M20', 'M14'], field());
      const d = evaluateDecision(createDecisionContext(f.snapshot, f.hand), options);
      withDecisionLedgerSnapshot(f.ledger, () => {
        mature.assertPublishedBranchAction(f.hand, f.runtime, d);
        const changed = clone(d); changed.selected.details.equipIntent.carrierId = 'E05';
        assert.throws(() => mature.assertPublishedBranchAction(f.hand, f.runtime, changed), /RESOURCES_CHANGED/);
        assert.throws(() => mature.assertPublishedBranchAction(f.hand, f.runtime, null), /INTENT_REQUIRED/);
      });
    });
    check('no legacy negative route priority or duplicate hand action enters final pool', () => {
      const d = decide(['M20', 'M17', 'M14', 'M13', 'M08'], field(true));
      assert(d.result.actions.every(a => a.tier >= 0));
      const keys = d.result.actions.filter(a => a.slot).map(a => `${a.id}:${a.slot}`);
      assert.equal(new Set(keys).size, keys.length);
    });
    // Actual mature hand-dispatch body, with native action replaced by a stub.
    // Verify the published preserve-equipment contract reaches the reducer;
    // a changed source must be rejected BEFORE the normal-summon adapter.
    const fs = require('fs'), path = require('path'), vm = require('vm');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../engine/runtime/mature-driver.js'), 'utf8');
    const start = source.indexOf("  if (card.id === 'M06') {\n    const currentSuggestion = decision || buildDecisionSuggestion(state);");
    const end = source.indexOf("  if (card.id === 'M21') {", start);
    assert(start > 0 && end > start);
    const block = source.slice(start, end);
    const f = fixture(['M06', 'M14'], { ...field(), bambooSwordEquipped: true,
      equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
      v5Branch: { active: true, currentState: 'M19_EQUIPPED', carrierId: 'E02' } });
    const d = evaluateDecision(createDecisionContext(f.snapshot, f.hand), options);
    let normalCalls = 0, committed;
    const dispatch = runtime => {
      let pending;
      withDecisionLedgerSnapshot(f.ledger, () => { pending = vm.runInNewContext(
      '(async function(){' + block + '})()', { card: { id: 'M06' }, state: f.hand,
        decision: d, slot: d.selected.slot, runtimeBeforeSelection: runtime,
        path, ROOT: 'INERT', console: { log() {} },
        assertPublishedBranchAction: mature.assertPublishedBranchAction,
        normalSummonRaye: async () => { normalCalls++; return { ...f.hand, cards: f.hand.cards.slice(1), handCount: 1 }; },
        commitRayeNormalSummonAtomic: options => { committed = mature.deriveRayeNormalSummonState(runtime, options); }
      }); });
      return pending;
    };
    await dispatch(f.runtime);
    assert.equal(normalCalls, 1); assert.equal(committed.v5Branch.currentState, 'M19_EQUIPPED');
    assert.deepStrictEqual(committed.equippedBambooCounts, { M19: 1 });
    normalCalls = 0;
    await assert.rejects(dispatch({ ...f.runtime, effectUsage: { E10_SUMMON: 1 } }), /RESOURCES_CHANGED/);
    assert.equal(normalCalls, 0);
    count++; console.log('V7_UNIFIED_STRATEGY PASS actual normal dispatcher preserves joint receipt and rejects stale intent before input');
  });
  console.log('V7_UNIFIED_STRATEGY_PASS; cases=' + count + '; real final evaluator; inputs=0/businessWrites=0');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run, fixture, decide };
