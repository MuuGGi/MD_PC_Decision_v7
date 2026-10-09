'use strict';

const assert = require('assert');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { isHornetBambooFollowUpPhase } = require('../../lib/decision-engine');

function cards(ids) {
  return ids.map((id, index) => ({ id, name: id, index: index + 1, usable: true }));
}

function deckRemaining(overrides = {}) {
  const deck = {};
  for (let i = 1; i <= 22; i++) deck[`M${String(i).padStart(2, '0')}`] = 0;
  return Object.assign(deck, overrides);
}

function analyze(hand, runtime, deck, actions = [], engageTargets = []) {
  return analyzeReachableResourceDeadlock({
    cards: cards(hand),
    runtime: Object.assign({
      graveSpellCount: 9,
      fieldSpell: 'M21',
      chickenGameDrawUsed: true,
      normalSummonUsed: false,
      usedCounts: { M17: 3, M22: 1 },
      v5Branch: { active: false, currentState: 'E10_EFFECT_RESOLVED' }
    }, runtime || {}),
    decisionResult: {
      deck: { deckRemaining: deckRemaining(deck) },
      actions,
      holds: [],
      engageTargets
    }
  });
}

// Reported class: legal Raye/Link setup and dead search cards remain, but the
// only Deck card is not a draw enabler and every fixed search target is gone.
const exhausted = analyze(
  ['M06', 'M06', 'M07', 'M08', 'M10', 'M14', 'M14'],
  null,
  { M05: 1 },
  []
);
assert.strictEqual(exhausted.terminal, true);
assert.strictEqual(exhausted.reason, 'NO_REACHABLE_DRAW_OR_PRODUCTIVE_FIXED_RESOURCE_ROUTE');

// A real draw-1 remains an escape.
const directDraw = analyze(
  ['M06', 'M15'],
  null,
  { M05: 1 },
  [{ id: 'M15', details: {} }]
);
assert.strictEqual(directDraw.terminal, false);
assert.strictEqual(directDraw.reason, 'DIRECT_RANDOM_RESOURCE_ACTION_EXISTS');

// A fixed Toon chain is productive when it deterministically reaches the
// missing Trade-In cost and leaves two cards to draw.
const toonUnlock = analyze(
  ['M10', 'M12'],
  null,
  { M10: 1, M07: 1, M01: 1, M02: 1 },
  [{ id: 'M10', details: { searchTarget: { id: 'M10' } } }]
);
assert.strictEqual(toonUnlock.terminal, false);
assert.strictEqual(toonUnlock.reason, 'TOON_CHAIN_UNLOCKS_TRADE_IN');

// ISSUE-100: finish the legal Toon chain even without an immediate paired draw.
const futileToon = analyze(
  ['M06', 'M10', 'M14'],
  null,
  { M10: 1, M07: 1, M05: 1 },
  [{ id: 'M10', details: { searchTarget: { id: 'M10' } } }]
);
assert.strictEqual(futileToon.terminal, false);
assert.strictEqual(futileToon.reason, 'FIXED_RESOURCE_ACTION_PENDING');
assert.strictEqual(futileToon.action, 'M10');

// Raye/E10 recovery is not productive when Engage has no Deck target.
const emptyEngageRecovery = analyze(
  ['M06', 'M14'],
  null,
  { M05: 1 },
  []
);
assert.strictEqual(emptyEngageRecovery.terminal, true);

// The same recovery remains a valid escape when a real Engage target exists.
const liveEngageRecovery = analyze(
  ['M06', 'M14'],
  null,
  { M08: 1, M05: 1 },
  [],
  [{ id: 'M08', remaining: 1 }]
);
assert.strictEqual(liveEngageRecovery.terminal, false);
assert.strictEqual(liveEngageRecovery.reason, 'SKY_RECOVERY_UNLOCKS_ENGAGE_BONUS_DRAW');

// Reported 2026-09-22 live hand: the first Engage has no immediate bonus draw,
// but it deterministically searches Hornet.  Hornet -> Kagari recovers Engage,
// and the known Yoto -> True -> Deck Yoto -> Golden line puts enough spells in
// the GY for Golden draw2 followed by the recovered Engage search + draw1.
const engageHornetBambooBridge = analyze(
  ['M05', 'M14', 'M17', 'M17', 'M19'],
  {
    graveSpellCount: 1,
    fieldSpell: 'M21',
    chickenGameDrawUsed: true,
    usedCounts: { M15: 1, M21: 1 },
    v5Branch: { active: false, currentState: 'IDLE' }
  },
  { M01: 23, M06: 2, M08: 2, M17: 1, M19: 1, M20: 1, M22: 1 },
  [{ id: 'M17', details: { searchableTargets: [{ id: 'M22' }] } }],
  [{ id: 'M22', remaining: 1 }, { id: 'M08', remaining: 2 }, { id: 'M06', remaining: 2 }]
);
assert.strictEqual(engageHornetBambooBridge.terminal, false);
assert.strictEqual(
  engageHornetBambooBridge.reason,
  'ENGAGE_HORNET_KAGARI_BAMBOO_UNLOCKS_GOLDEN_AND_BONUS_DRAW'
);

// After the first Engage has searched Hornet, the route changes stage but is
// still productive.  The Hornet action must carry the Bamboo follow-up proof
// through the strategic deadlock gate before H1 makes Kagari.
assert.strictEqual(
  isHornetBambooFollowUpPhase('START_HORNET_YOTO_FIXED_RESOURCE'),
  true
);
const postEngageHornetBridge = analyze(
  ['M05', 'M14', 'M17', 'M19', 'M22'],
  {
    graveSpellCount: 2,
    fieldSpell: 'M21',
    chickenGameDrawUsed: true,
    usedCounts: { M15: 1, M17: 1, M21: 1 },
    v5Branch: { active: false, currentState: 'IDLE' }
  },
  { M01: 23, M06: 2, M08: 2, M17: 1, M19: 1, M20: 1, M22: 0 },
  [{
    id: 'M22',
    details: {
      bambooFollowUp: isHornetBambooFollowUpPhase('START_HORNET_YOTO_FIXED_RESOURCE'),
      phase: 'START_HORNET_YOTO_FIXED_RESOURCE'
    }
  }]
);
assert.strictEqual(postEngageHornetBridge.terminal, false);
assert.strictEqual(postEngageHornetBridge.reason, 'MODELED_BAMBOO_FIXED_ROUTE_REACHABLE');

// The Bamboo draw bridge is broken, but the legal Engage search still comes first.
const brokenEngageHornetBambooBridge = analyze(
  ['M05', 'M14', 'M17', 'M17', 'M19'],
  {
    graveSpellCount: 1,
    fieldSpell: 'M21',
    chickenGameDrawUsed: true,
    usedCounts: { M15: 1, M21: 1 },
    v5Branch: { active: false, currentState: 'IDLE' }
  },
  { M01: 24, M06: 2, M08: 2, M17: 1, M19: 0, M20: 1, M22: 1 },
  [{ id: 'M17', details: { searchableTargets: [{ id: 'M22' }] } }],
  [{ id: 'M22', remaining: 1 }, { id: 'M08', remaining: 2 }, { id: 'M06', remaining: 2 }]
);
assert.strictEqual(brokenEngageHornetBambooBridge.terminal, false);
assert.strictEqual(brokenEngageHornetBambooBridge.reason, 'FIXED_RESOURCE_ACTION_PENDING');

console.log('STRATEGIC_DEADLOCK_OFFLINE_PASS');
