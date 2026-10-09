'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
const atomic = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
const continuation = require('../../lib/atomic-response-continuation-policy');
const { adjustedMainDeckRemainingCount } = require('../../lib/exodia-policy');
const protectedFiles = [
  'decision-state.json',
  'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json',
  'debug/duel-log-live/observer_state.json'
];
const protectedBytes = new Map(protectedFiles.filter(rel => fs.existsSync(path.join(ROOT,rel))).map(rel => [
  rel,
  fs.readFileSync(path.join(ROOT, rel))
]));

function segment(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `segment:${start}`);
  return source.slice(a, b);
}

const hand = {
  revision: 15,
  handCount: 7,
  cards: ['M02', 'M05', 'M06', 'M07', 'M08', 'M08', 'M14'].map((id, i) => ({
    id,
    index: i + 1,
    name: id,
    usable: true
  }))
};
const deckRemaining = { M06: 1, M17: 1, M01: 3, M03: 1 };
const decisionResult = {
  selected: null,
  actions: [],
  engageTargets: [{ id: 'M06', name: '闪刀姬－零衣', remaining: 1 }],
  deck: { deckRemaining }
};
let runtime = {
  graveSpellCount: 10,
  bambooSwordEquipped: false,
  normalSummonUsed: false,
  rayeNormalSummoned: false,
  usedCounts: { M17: 2 },
  v5Branch: {
    active: false,
    currentState: 'KAGARI_RECOVERY_DONE',
    carrierId: 'E02'
  }
};

const context = vm.createContext({
  ROOT,
  path,
  console: { log() {}, error() {} },
  loadDecisionState: () => runtime,
  isStrategicallyUsable: () => true,
  knownNonRayeMonsterPresent: () => true,
  buildLastResortAllureAction: () => null,
  adjustedMainDeckRemainingCount,
  require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => ({ cards: [] }) };
    if (id.endsWith('decision-engine')) return { collectActions: () => structuredClone(decisionResult) };
    if (id.endsWith('deadlock-detector')) return {
      analyzeReachableResourceDeadlock: () => ({ terminal: false, type: 'NONE', reason: 'SKY_RECOVERY_UNLOCKS_ENGAGE_BONUS_DRAW',
        rayeCloseout: require('../../lib/raye-closeout-policy').describeRayeCloseout(hand.cards, runtime, decisionResult) })
    };
    throw new Error(`Unexpected dependency:${id}`);
  }
});
vm.runInContext(
  segment(main, 'function buildDecisionSuggestion(', 'function shortExtraForDecision('),
  context
);

let actual = context.buildDecisionSuggestion(hand);
assert.strictEqual(actual.selected.id, 'M06');
assert.strictEqual(actual.selected.slot, 3);
assert.strictEqual(actual.selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
assert.strictEqual(actual.selected.details.existingCarrierId, 'E02');
assert.strictEqual(actual.selected.details.e10EngageSource, 'DECK', '4 targets in hand+Deck: Deck preferred');

for (const mutate of [
  value => { value.normalSummonUsed = true; },
  value => { value.graveSpellCount = 2; },
  value => { value.bambooSwordEquipped = true; },
  value => { value.v5Branch.active = true; },
  value => { value.v5Branch.carrierId = 'E10'; },
  value => { value.v5Branch.currentState = 'E10_EFFECT_RESOLVED'; value.effectUsage = { E10_SUMMON: 1 }; }
]) {
  const saved = structuredClone(runtime);
  mutate(runtime);
  actual = context.buildDecisionSuggestion(hand);
  assert.strictEqual(actual.selected, null, JSON.stringify(runtime));
  runtime = saved;
}

// Oct07: a completed-node label is not a substitute for the actual carrier,
// usage and resource receipts. Other proven completion labels retain legality.
const completedLabel = structuredClone(runtime);
runtime.v5Branch.currentState = 'ORDINARY_DRAW_RESOLVED';
assert.strictEqual(context.buildDecisionSuggestion(hand).selected.id, 'M06');
runtime = completedLabel;

const commitContext = vm.createContext({
  console: { log() {} },
  runtime: null,
  loadDecisionState: () => commitContext.runtime,
  saveDecisionState: value => { commitContext.runtime = value; return value; },
  incrementUsedCount: (value, id) => {
    value.usedCounts = { ...(value.usedCounts || {}), [id]: Number(value.usedCounts && value.usedCounts[id] || 0) + 1 };
  },
  knownNonRayeMonsterPresent: () => true
});
vm.runInContext(
  segment(main, 'function commitRayeNormalSummonAtomic(', 'function knownNonRayeMonsterPresent('),
  commitContext
);
commitContext.runtime = structuredClone(runtime);
commitContext.commitRayeNormalSummonAtomic({
  doubleLinkRecovery: true,
  carrierId: 'E02',
  e10EngageSource: 'GRAVE'
});
assert.strictEqual(commitContext.runtime.normalSummonUsed, true);
assert.strictEqual(commitContext.runtime.rayeNormalSummoned, true);
assert.strictEqual(commitContext.runtime.v5Branch.active, true);
assert.strictEqual(commitContext.runtime.v5Branch.currentState, 'RAYE_SECOND_MATERIAL_READY');
assert.strictEqual(commitContext.runtime.v5Branch.carrierId, 'E02');
assert.strictEqual(commitContext.runtime.v5Branch.e10EngageSource, 'GRAVE');

commitContext.runtime = structuredClone(runtime);
commitContext.commitRayeNormalSummonAtomic();
assert.strictEqual(commitContext.runtime.v5Branch.active, false,
  'ISSUE-061 direct-Raye guard remains fail-closed with another monster present');
assert.strictEqual(commitContext.runtime.v5Branch.currentState, 'RAYE_NORMAL_SUMMONED_WITH_OTHER_MONSTER');

assert.ok(main.includes("'RAYE_SECOND_MATERIAL_READY'"));
assert.ok(main.includes('doubleWithRaye: true'));
assert.ok(main.includes('equippedYoto: false'));
assert.ok(main.includes("requiredCarrierKind: 'EXTRA_LINK'"));
const poolStatement = atomic.match(/const expectedPoolCount = [^;]+;/)?.[0];
assert.ok(poolStatement);
for (const [doubleWithRaye, equippedYoto, kagariDual, expected] of [
  [true, false, false, 1], [true, true, false, 2],
  [false, true, false, 1], [false, true, true, 2]
]) {
  assert.strictEqual(vm.runInNewContext(`${poolStatement}\nexpectedPoolCount`,
    { doubleWithRaye, equippedYoto, kagariDual, equippedYotoCount: 1 }), expected);
}
assert.ok(atomic.includes("forcedSource === 'GRAVE'"));
assert.strictEqual(
  continuation.atomicContinuationDecision('RAYE_SECOND_MATERIAL_READY', 'E10_OPTIONAL_PENDING').autoContinue,
  true
);

for (const [rel, bytes] of protectedBytes) {
  assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
}

console.log(
  'RAYE_DOUBLE_LINK_ENGAGE_RECOVERY_OFFLINE_PASS; current rev15=M06@3; ' +
  'E02+M06->E10; shared hand+Deck source policy and explicit grave receipt; bonus draw route; ISSUE-061 guard preserved; gameInputs0/stateWrites0'
);
