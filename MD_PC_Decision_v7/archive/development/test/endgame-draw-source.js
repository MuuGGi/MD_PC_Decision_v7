'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { performance } = require('perf_hooks');
const { arbitrateCandidates } = require('../../../src/strategy/action-order');
const { describeE10EngageSources, selectE10EngageCandidate, bindE10EngageSourcePolicy } = require('../../../engine/lib/e10-engage-source-policy');
const { createDecisionContext } = require('../../../src/strategy/decision-context');
const { evaluateDecision } = require('../../../src/strategy/decision');
const { hashValue, clone } = require('../../../src/core/json-store');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const mature = require('../../../engine/runtime/mature-driver'), library = require('../../../engine/card-library.json');
const options = { isStrategicallyUsable: mature.isStrategicallyUsable, hasNonRayeMonster: () => false,
  isTransactionPending: mature.isTransactionPendingNode, isFieldPlanning: mature.isFieldPlanningNode };
const ROOT = path.resolve(__dirname, '../../..'); let cases = 0;
function check(name, fn) { fn(); cases++; console.log('V7_ENDGAME_SOURCE PASS ' + name); }
function deck(n) { return { deckRemaining: { M01: n }, unknownExodiaOutsideCount: 0 }; }
function action(id, slot, details = {}, tier = id === 'M09' || id === 'M15' ? 2 : 3) {
  return { id, slot, tier, name: id, details };
}
function order(rows, n, counts, runtime = { bambooSwordEquipped: true }) {
  return arbitrateCandidates(rows, runtime, counts, deck(n));
}
function context(ids, runtime, remaining = {}) {
  const hand = { revision: 0, handCount: ids.length, cards: ids.map((id, index) => ({ id, index: index + 1,
    name: library.cards.find(c => c.id === id)?.name || '被封印组件', usable: true })) };
  const counts = {}; ids.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const ledger = { version: 2, mode: 'OUTSIDE_DECK_COUNT', lastHandRevision: 0, unknownExodiaOutsideCount: counts.EXODIA_UNKNOWN || 0,
    outsideDeckCounts: Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, c.count - (remaining[c.id] || 0)])) };
  const fact = data => ({ status: 'KNOWN', data, hash: hashValue(data) });
  const snapshot = { consistency: [], snapshotKey: hashValue({ hand, runtime, ledger }), hand: fact(hand), runtime: fact(runtime),
    ledger: fact(ledger), library: fact(library), session: fact({ duelId: 'OFFLINE', startProven: true }), log: { status: 'UNKNOWN' }, observerState: { status: 'UNKNOWN' } };
  return { snapshot, hand };
}
async function run() {
  await withStrictReadOnly(async () => {
    check('4 cards with 1+2+2 chooses 2, while equal 1+1+2 keeps ordinary order', () => {
      const d = order([action('M09', 1), action('M14', 2), action('M14', 3)], 4, { M09: 1, M14: 2 });
      assert.equal(d.selected.id, 'M14'); assert.equal(d.drawSchedule.maximumGuaranteedDraws, 4);
      assert.equal(d.drawSchedule.firstMoves[0].reachableDraws, 3); assert.equal(d.drawSchedule.canEmptyDeck, true);
      assert.equal(d.selected.details.drawCombination.noFutureDrawIdentities, true);
      assert.match(d.selected.reason, /牌组末段/);
      const free = order([action('M09', 1), action('M09', 2), action('M14', 3)], 4, { M09: 2, M14: 1 });
      assert.equal(free.selected.id, 'M09'); assert.equal(free.drawSchedule.applied, false);
    });
    check('2 remaining protects draw2; 3 or 5 with exact odd coverage allows draw1', () => {
      for (const n of [2, 3, 5]) {
        const d = order([action('M09', 1), action('M14', 2), action('M14', 3)], n, { M09: 1, M14: 2 });
        assert.equal(d.selected.id, n === 2 ? 'M14' : 'M09'); assert.equal(d.drawSchedule.canEmptyDeck, true);
      }
    });
    check('ordinary non-endgame order and original priority numbers are preserved', () => {
      const d = order([action('M09', 1), action('M14', 2)], 20, { M09: 1, M14: 1 });
      assert.equal(d.selected.id, 'M09'); assert.equal(d.drawSchedule.applied, false);
      assert.deepEqual(d.actions.map(x => x.tier), [2, 3]);
    });
    check('two Trade-Ins cannot spend the same HAMP twice', () => {
      const rows = [action('M09', 1), action('M12', 2, { discardTarget: { id: 'M08' } }), action('M12', 3, { discardTarget: { id: 'M08' } })];
      const one = order(rows, 4, { M09: 1, M12: 2, M08: 1 });
      assert.equal(one.drawSchedule.maximumGuaranteedDraws, 3); assert.equal(one.drawSchedule.canEmptyDeck, false);
      const two = order(rows, 4, { M09: 1, M12: 2, M08: 2 });
      assert.equal(two.selected.id, 'M12'); assert.equal(two.drawSchedule.maximumGuaranteedDraws, 4);
    });
    check('Allure and Trade-In share actual cost holdings, never a hoped-for drawn partner', () => {
      const d = order([action('M09', 1), action('M12', 2, { discardTarget: { id: 'M08' } }),
        action('M13', 3, { banishTarget: { id: 'M08' } }, 99)], 4, { M09: 1, M12: 1, M13: 1, M08: 1 });
      assert.equal(d.drawSchedule.maximumGuaranteedDraws, 3); assert.equal(d.drawSchedule.canEmptyDeck, false);
      assert.equal(order([action('M09', 1), action('M13', 2, { allureLastResort: true }, 1000)], 2, { M09: 1, M13: 1 }).selected.id, 'M09');
    });
    check('unproven equipment, missing cost and protected Toon Dragon are not free draw2', () => {
      assert.equal(order([action('M09', 1), action('M14', 2)], 2, { M09: 1, M14: 1 }, {}).selected.id, 'M09');
      const missing = order([action('M09', 1), action('M12', 2, { discardTarget: { id: 'M08' } })], 2, { M09: 1, M12: 1 });
      assert.equal(missing.selected.id, 'M09'); assert.equal(missing.rejected.length, 1);
      assert.equal(order([action('M09', 1), action('M12', 2, { discardTarget: { id: 'M07' }, protectedToonDragonCost: true }, 95)],
        2, { M09: 1, M12: 1, M07: 1 }).selected.id, 'M09');
    });
    check('fixed search, field setup and explicit development intent remain barriers', () => {
      const draws = [action('M09', 1), action('M14', 2), action('M14', 3)];
      for (const fixed of [action('M17', 4, { searchTarget: { id: 'M08' } }, 1), action('M10', 4, {}, 0),
        { id: 'E02', tier: 0.5, specialAction: 'FIELD_RESOURCE_STEP', details: {} }])
        assert.equal(order([...draws, fixed], 4, { M09: 1, M14: 2, M17: 1, M10: 1 }).selected.id, fixed.id);
      const midway = order([...draws, { id: 'E02', tier: 2.5, specialAction: 'FIELD_RESOURCE_STEP', details: {} }],
        4, { M09: 1, M14: 2 });
      assert.equal(midway.selected.id, 'M09');
      assert.equal(order([action('M09', 1, { v5TestMode: 'EXPLICIT' }, -100), ...draws.slice(1)],
        4, { M09: 1, M14: 2 }).selected.id, 'M09');
    });
    check('pending field draw is single-use and hand field replacement invalidates it', () => {
      const fieldDraw = { id: 'M21', tier: 1.5, specialAction: 'M21_FIELD_DRAW', details: { pendingFieldDraw: true } };
      const r = { bambooSwordEquipped: true, chickenGameDrawPending: true };
      const d = order([fieldDraw, action('M14', 1), action('M14', 2)], 4, { M14: 2 }, r);
      assert.equal(d.selected.id, 'M14'); assert.equal(d.drawSchedule.firstMoves[0].reachableDraws, 3);
      const sharedField = order([fieldDraw, action('M21', 1, {}, 2), action('M14', 2)], 4, { M21: 1, M14: 1 }, r);
      assert.equal(sharedField.drawSchedule.firstMoves.find(x => x.id === 'M21' && x.slot === 1).reachableDraws, 3);
      assert.equal(sharedField.drawSchedule.canEmptyDeck, true);
    });
    check('unknown Deck facts do not change ordinary action or declare a deadlock', () => {
      const rows = [action('M09', 1), action('M14', 2)];
      const d = arbitrateCandidates(rows, { bambooSwordEquipped: true }, { M09: 1, M14: 1 }, { deckRemaining: { M01: '2' } });
      assert.equal(d.selected.id, 'M09'); assert.equal(d.drawSchedule.reason, 'DRAW_BASIS_UNKNOWN');
      const before = JSON.stringify(rows); order(rows, 2, { M09: 1, M14: 1 }); assert.equal(JSON.stringify(rows), before);
    });
    check('Into Void hand-count qualification remains true only after actual current costs', () => {
      const d = order([action('M09', 1), action('M15', 2), action('M14', 3)], 4, { M09: 1, M15: 1, M14: 1 });
      assert.equal(d.drawSchedule.canEmptyDeck, true);
      const small = order([action('M15', 1), action('M14', 2)], 3, { M15: 1, M14: 1 });
      assert.equal(small.drawSchedule.firstMoves[0].reachableDraws, -1);
      assert.equal(small.selected.id, 'M14');
      assert.equal(small.drawSchedule.maximumGuaranteedDraws, 3, 'known draw2 raises hand count to three without guessing identities');
    });
    check('fresh decision snapshot reevaluates after draw2 without precommitting the old sequence', () => {
      const thin = { M01: 1, M02: 1, M03: 1, M04: 1 };
      const runtime = { graveSpellCount: 10, normalSummonUsed: true, rayeNormalSummoned: false,
        bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        usedCounts: {}, effectUsage: { E10_SUMMON: 1 }, v5Branch: { currentState: 'GOLDEN_BAMBOO_DRAW_READY', carrierId: 'E10', active: false } };
      const f = context(['M09', 'M14', 'M14'], runtime, thin);
      const d = evaluateDecision(createDecisionContext(f.snapshot, f.hand), options);
      assert.equal(d.selected.id, 'M14'); assert.strictEqual(d.selected, d.result.selected);
      assert.equal(d.decisionTrace.drawSchedule.applied, true);
      const next = context(['M09', 'M14'], runtime, { M01: 1, M02: 1 });
      assert.equal(evaluateDecision(createDecisionContext(next.snapshot, next.hand), options).selected.id, 'M14');
    });
    check('real final Goblin baseline selects Bamboo in the actual final evaluator', () => {
      const evidence = path.join(ROOT, 'archive/autotest/runs/2026-10-09T09-18-47-362Z/game-00003/completed');
      const tx = JSON.parse(fs.readFileSync(path.join(evidence, 'debug/v7/transactions/archive/DUEL-0cc8861d9ec07652f40f2b05-T0030.json')));
      const original = JSON.stringify(tx);
      const runtime = JSON.parse(fs.readFileSync(path.join(evidence, 'decision-state.json')));
      runtime.usedCounts = clone(tx.baseline.runtime.usedCounts); runtime.graveSpellCount--;
      const hand = { revision: tx.baseline.hand.revision, handCount: tx.baseline.hand.cards.length,
        cards: tx.baseline.hand.cards.map((id, n) => ({ id, index: n + 1, name: id, usable: true })) };
      // All components remain protected in hand; the already reviewed journal
      // and post-Goblin count independently prove this baseline has four left.
      const ledger = { version: 2, mode: 'OUTSIDE_DECK_COUNT', lastHandRevision: hand.revision,
        outsideDeckCounts: tx.baseline.ledger.counts, unknownExodiaOutsideCount: 2 };
      const fact = data => ({ status: 'KNOWN', data, hash: hashValue(data) });
      const snapshot = { consistency: [], snapshotKey: 'REAL-T0030', hand: fact(hand), runtime: fact(runtime), ledger: fact(ledger),
        library: fact(library), session: fact({ duelId: tx.duelId, startProven: true }), log: { status: 'UNKNOWN' }, observerState: { status: 'UNKNOWN' } };
      const d = evaluateDecision(createDecisionContext(snapshot, hand), options);
      assert.equal(d.selected.id, 'M14'); assert.equal(d.decisionTrace.drawSchedule.remaining, 4);
      assert.equal(d.decisionTrace.drawSchedule.maximumGuaranteedDraws, 4); assert.equal(JSON.stringify(tx), original);
      assert(!d.result.actions.some(a => a.id === 'M17'), 'held Engage has no remaining legal target');
    });
    check('last Deck target prefers Deck regardless of hand holdings; two targets keep existing source rule', () => {
      const d = { deckRemaining: { M06: 0, M08: 1, M22: 0, M17: 2 }, handCounts: {}, byId: {} };
      for (const cards of [[], [{ id: 'M06' }], [{ id: 'M08' }, { id: 'M06' }]]) {
        const policy = describeE10EngageSources(d, cards, { usedCounts: { M17: 1 } });
        assert.equal(policy.preferredSource, 'DECK'); assert.equal(policy.lastDeckTarget, true);
        assert.equal(policy.deckEngagePreferred, true);
      }
      const two = describeE10EngageSources({ ...d, deckRemaining: { ...d.deckRemaining, M08: 2 } }, [], { usedCounts: { M17: 1 } });
      assert.equal(two.preferredSource, 'GRAVE'); assert.equal(two.lastDeckTarget, false);
      assert.equal(describeE10EngageSources({ ...d, deckRemaining: { ...d.deckRemaining, M08: 2 } }, [{ id: 'M06' }],
        { usedCounts: { M17: 1 } }).preferredSource, 'DECK');
      assert.equal(describeE10EngageSources({ ...d, deckRemaining: { ...d.deckRemaining, M17: 0 } }, [], { usedCounts: { M17: 1 } }).preferredSource, 'GRAVE');
    });
    check('source selector uses real GY-first Deck-second copies and never substitutes a stale source', () => {
      const policy = describeE10EngageSources({ deckRemaining: { M06: 0, M08: 1, M22: 0, M17: 2 } }, [], { usedCounts: { M17: 1 } });
      const candidates = [900, 700, 800].map(x => ({ reference: { x }, recognized: { id: 'M17', accepted: true } }));
      assert.equal(selectE10EngageCandidate(candidates, policy).reference.x, 800);
      assert.equal(bindE10EngageSourcePolicy(policy, 'DECK').preferredSource, 'DECK');
      assert.throws(() => bindE10EngageSourcePolicy(policy, 'GRAVE'), /STALE_LAST_TARGET/);
      assert.throws(() => selectE10EngageCandidate(candidates.slice(1), policy), /COUNT_MISMATCH/);
      assert.throws(() => bindE10EngageSourcePolicy({ ...policy, engageDeckRemaining: 0 }, 'DECK'), /UNAVAILABLE/);
    });
    check('actual target-policy caller cannot restore the old forced-GRAVE route override', () => {
      const text = fs.readFileSync(path.join(ROOT, 'engine/execution/core/atomic-route-executor.js'), 'utf8');
      const start = text.indexOf('function currentE10EngageSourcePolicy(library, state) {');
      const end = text.indexOf('async function completeM20FieldEffectToYotoTarget', start);
      assert(start > 0 && end > start);
      const policy = describeE10EngageSources({ deckRemaining: { M06: 0, M08: 1, M22: 0, M17: 2 } }, [{ id: 'M06' }], { usedCounts: { M17: 1 } });
      const mockRuntime = { v5Branch: { e10EngageSource: 'DECK' } }, module = { exports: {} };
      vm.runInNewContext(text.slice(start, end) + '\nmodule.exports = currentE10EngageSourcePolicy;', {
        module, console: { log() {} }, DECISION_STATE_PATH: 'MEMORY', readJsonIfExists: () => mockRuntime,
        buildE10EngageSourcePolicy: () => policy, require: () => ({ bindE10EngageSourcePolicy }) });
      assert.equal(module.exports({}, {}).preferredSource, 'DECK');
      mockRuntime.v5Branch.e10EngageSource = 'GRAVE'; assert.throws(() => module.exports({}, {}), /STALE_LAST_TARGET/);
    });
    check('exhaustive small independent draw pools agree with a subset-sum oracle', () => {
      for (let ones = 1; ones <= 3; ones++) for (let twos = 1; twos <= 3; twos++) for (let n = 1; n <= ones + 2 * twos; n++) {
        const rows = [...Array.from({ length: ones }, (_, i) => action('M09', i + 1)),
          ...Array.from({ length: twos }, (_, i) => action('M14', ones + i + 1))];
        const max = (a, b, cap) => Math.max(...Array.from({ length: a + 1 }, (_, x) =>
          Array.from({ length: b + 1 }, (_, y) => x + 2 * y)).flat().filter(x => x <= cap));
        const d = order(rows, n, { M09: ones, M14: twos });
        assert.equal(d.drawSchedule.maximumGuaranteedDraws, max(ones, twos, n));
        const firstOne = 1 + max(ones - 1, twos, n - 1);
        assert.equal(d.selected.id, firstOne === max(ones, twos, n) ? 'M09' : 'M14');
      }
    });
    check('bounded 12-card draw analysis remains cheap and never publishes a future sequence', () => {
      const rows = Array.from({ length: 6 }, (_, i) => action('M12', i + 1, { discardTarget: { id: 'M08' } }));
      const at = performance.now(), d = order(rows, 8, { M12: 6, M08: 6 });
      assert(d.drawSchedule.statesVisited <= 10000); assert(performance.now() - at < 500);
      assert.equal(d.selected.id, 'M12');
      assert(!('steps' in d.selected.details));
    });
    check('unproven future hand capability is not mislabeled as an illegal draw2', () => {
      const d = order([action('M09', 1), action('M14', 2)], 2, { M09: 1, M14: 1, EXODIA_UNKNOWN: 10 });
      assert.equal(d.drawSchedule.reason, 'DRAW_FUTURE_HAND_CAPABILITY_UNKNOWN_PRESERVE_NORMAL_ORDER');
      assert.equal(d.drawSchedule.applied, false); assert(d.actions.some(a => a.id === 'M14'));
    });
  });
  console.log('V7_ENDGAME_DRAW_SOURCE_PASS; cases=' + cases + '; actual final evaluator+source caller; inputs=0/businessWrites=0');
}
run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
