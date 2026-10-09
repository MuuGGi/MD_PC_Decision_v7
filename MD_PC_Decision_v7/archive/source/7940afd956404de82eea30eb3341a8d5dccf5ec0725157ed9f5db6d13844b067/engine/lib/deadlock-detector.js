'use strict';

const library = require('../card-library.json');
const { describeRayeCloseout } = require('./raye-closeout-policy');
const { planGoldenBambooSetup } = require('./golden-bamboo-setup-policy');
const {
  IDS,
  collectActions
} = require('./decision-engine');
const {
  countExodiaComponents,
  isExodiaComponentId,
  adjustedMainDeckRemainingCount
} = require('./exodia-policy');

const DIRECT_RANDOM_RESOURCE_IDS = new Set([
  IDS.UPSTART,
  IDS.MALLET,
  IDS.TRADE_IN,
  IDS.ALLURE,
  IDS.GOLDEN_BAMBOO,
  IDS.INTO_VOID,
  IDS.ONE_DAY,
  IDS.FOOLISH_GOODS,
  IDS.CHICKEN_GAME
]);

const KNOWN_DETERMINISTIC_ONLY_IDS = new Set([
  IDS.TOON_TABLE,
  IDS.ENGAGE,
  IDS.HORNET,
  IDS.CURSED_BAMBOO,
  IDS.TRUE_BAMBOO
]);

function normalizeCards(cards) {
  return (cards || [])
    .filter(card => card && card.id && card.id !== 'UNKNOWN')
    .map((card, index) => ({
      index: Number.isInteger(card.index) ? card.index : index + 1,
      x: Number(card.x || 0),
      y: Number(card.y || 0),
      id: card.id,
      name: card.name || card.id,
      // Deadlock detection is deliberately optimistic: assume every spell in
      // hand is activatable. If the decision engine still finds no safe route,
      // the "no hand continuation" evidence is strong enough to use.
      usable: true
    }));
}

function stepRemovedCard(step, id) {
  return Boolean((step && step.removedCards || []).some(card => card && card.id === id));
}

function operationHasHandGain(operation) {
  return Boolean((operation && operation.details || []).some(detail =>
    detail && (detail.rawType === 'HAND_GAIN' || detail.role === 'HAND_GAIN_CANDIDATE')
  ));
}

function deriveKnownFieldState(session) {
  let chickenGameOnField = false;
  let chickenGameDrawUsed = false;

  for (const step of session && session.history || []) {
    // A removed M21 means a fresh copy was activated from hand and is now the
    // field spell. Its once-per-turn draw has not been used yet.
    if (stepRemovedCard(step, IDS.CHICKEN_GAME)) {
      chickenGameOnField = true;
      chickenGameDrawUsed = false;
    }

    for (const operation of step.operations || []) {
      if (!operation || operation.activationKey !== IDS.CHICKEN_GAME) continue;
      if (operationHasHandGain(operation) && !stepRemovedCard(step, IDS.CHICKEN_GAME)) {
        chickenGameOnField = true;
        chickenGameDrawUsed = true;
      }
    }
  }

  return {
    chickenGameOnField,
    chickenGameDrawUsed,
    chickenGameEffectAvailable: chickenGameOnField && !chickenGameDrawUsed
  };
}

function optimisticHandDecision(cards) {
  const normalized = normalizeCards(cards);
  // These settings intentionally favor NOT calling deadlock. They assume the
  // best plausible strategic state for cards whose usability depends on state.
  const runtimeState = {
    graveSpellCount: 3,
    fieldSpell: null,
    bambooSwordEquipped: true,
    usedCounts: {}
  };
  return collectActions(normalized, library, runtimeState);
}

function countHandIds(cards) {
  const counts = {};
  for (const card of cards || []) {
    const id = String(card && card.id || '');
    if (!id || id === 'UNKNOWN') continue;
    counts[id] = Number(counts[id] || 0) + 1;
  }
  return counts;
}

function deckCount(deck, id) {
  return Math.max(0, Number(deck && deck.deckRemaining && deck.deckRemaining[id] || 0));
}

function totalDeckCount(deck) {
  return adjustedMainDeckRemainingCount(deck);
}

function activeAtomicBranch(runtime) {
  const branch = runtime && runtime.v5Branch || {};
  const node = String(branch.currentState || '');
  if (branch.active !== true) return null;
  if (!node || ['IDLE', 'BRANCH_COMPLETE', 'YOTO_SEARCH_DONE', 'E10_EFFECT_RESOLVED'].includes(node)) {
    return null;
  }
  return node;
}

function actionActuallyProducesRandomResource(action, runtime) {
  if (!action) return false;
  if (DIRECT_RANDOM_RESOURCE_IDS.has(action.id)) return true;
  if (action.id === IDS.ENGAGE) {
    const targets = action.details && action.details.searchableTargets || [];
    return Number(runtime && runtime.graveSpellCount || 0) >= 3 && targets.length > 0;
  }
  if (action.id === IDS.HORNET) {
    return Boolean(action.details && action.details.postE10BambooDraw2);
  }
  return false;
}

function engageSearchCanUnlockDraw({ targets, handCounts, deck, graveAfterFirstEngage }) {
  const ids = new Set((targets || []).map(target => target && target.id).filter(Boolean));
  const deckAfterSearch = Math.max(0, totalDeckCount(deck) - 1);

  if (ids.has(IDS.HAMP) && Number(handCounts[IDS.TRADE_IN] || 0) > 0 && deckAfterSearch >= 2) {
    return 'ENGAGE_HAMP_UNLOCKS_TRADE_IN';
  }
  if (ids.has(IDS.RAYE) && Number(handCounts[IDS.ALLURE] || 0) > 0 && deckAfterSearch >= 2) {
    return 'ENGAGE_RAYE_UNLOCKS_ALLURE';
  }

  // With two spells already in the GY, the first Engage can take Hornet and
  // become the third spell. Hornet -> Kagari then recovers Engage. This is an
  // escape only if another actual Engage target remains in Deck afterwards.
  if (ids.has(IDS.HORNET) && Number(graveAfterFirstEngage || 0) >= 3) {
    const targetsAfterHornet =
      deckCount(deck, IDS.RAYE) +
      deckCount(deck, IDS.HAMP) +
      Math.max(0, deckCount(deck, IDS.HORNET) - 1);
    if (targetsAfterHornet > 0 && deckAfterSearch >= 1) {
      return 'ENGAGE_HORNET_RECOVERY_UNLOCKS_BONUS_DRAW';
    }
  }
  return null;
}

function bambooRouteCanUnlockDraw({ handCounts, deck, runtime }) {
  if (totalDeckCount(deck) < 2) return null;
  if (Number(handCounts[IDS.GOLDEN_BAMBOO] || 0) <= 0) return null;

  const actualGoldenCards = Object.entries(handCounts).flatMap(([id, n]) => Array.from({ length: n }, () => ({ id })));
  const golden = require('../../src/integration/legacy-capabilities').goldenFromLegacy(actualGoldenCards, deck, runtime);
  if (golden.status === 'READY') {
    return 'EQUIPPED_BAMBOO_UNLOCKS_GOLDEN_DRAW2';
  }
  if (golden.status === 'UNKNOWN' && runtime && runtime.bambooSwordEquipped === true) return 'BAMBOO_FACTS_UNKNOWN_NO_DEADLOCK_PROOF';

  const actualCards = Object.entries(handCounts).flatMap(([id, n]) => Array.from({ length: n }, () => ({ id })));
  if (planGoldenBambooSetup(actualCards, runtime || {}, deck)) return 'EQUIP_HAND_BAMBOO_UNLOCKS_GOLDEN_DRAW2';
  const rayeCanBeSummoned = Number(handCounts[IDS.RAYE] || 0) > 0 && runtime?.normalSummonUsed !== true;
  const carrierId = String(runtime?.v5Branch?.carrierId || '');
  const hasCarrier = rayeCanBeSummoned || runtime?.rayeNormalSummoned === true ||
    /^E\d+$/.test(carrierId) || carrierId === 'TOKEN_SKY_STRIKER';
  // Deck-only equipment is not reachable without an actual search/conversion
  // action. Those actions and pending field transactions are handled separately.
  const hasEquipRoute = Number(handCounts[IDS.CURSED_BAMBOO] || 0) > 0 ||
    Number(handCounts[IDS.TRUE_BAMBOO] || 0) > 0;
  return hasCarrier && hasEquipRoute ? 'RAYE_BAMBOO_ROUTE_UNLOCKS_GOLDEN_DRAW2' : null;
}

/**
 * Conservative strategic deadlock proof for the formal V5 decision point.
 *
 * Known legal fixed searches/recoveries must be completed before declaring a
 * terminal deadlock or offering Allure as the last resort, even when they cannot
 * immediately unlock another draw. All targets come from the shared ledger;
 * a copy already outside Deck cannot be counted again.
 */
function analyzeReachableResourceDeadlock(options) {
  return { ...analyzeReachableResourceDeadlockInternal(options),
    rayeCloseout: describeRayeCloseout(options.cards, options.runtime || {}, options.decisionResult || {}) };
}

function analyzeReachableResourceDeadlockInternal({ cards, runtime, decisionResult }) {
  const rawCards = Array.isArray(cards) ? cards : [];
  if (!rawCards.length || rawCards.some(card => !card || !card.id || card.id === 'UNKNOWN')) {
    return { terminal: false, type: 'NONE', reason: 'UNKNOWN_HAND_NOT_SAFE_TO_FORECAST' };
  }

  const pendingNode = activeAtomicBranch(runtime || {});
  if (pendingNode) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'ATOMIC_FIELD_TRANSACTION_PENDING',
      pendingNode
    };
  }

  const result = decisionResult || {};
  const deck = result.deck;
  if (!deck || !deck.deckRemaining) {
    return { terminal: false, type: 'NONE', reason: 'SHARED_DECK_LEDGER_UNAVAILABLE' };
  }

  const handCounts = countHandIds(rawCards);
  const handIds = rawCards.map(card => card.id);
  const remaining = totalDeckCount(deck);
  const engageTargets = Array.isArray(result.engageTargets) ? result.engageTargets : [];
  const actions = Array.isArray(result.actions) ? result.actions : [];

  if (countExodiaComponents(rawCards) >= 5) {
    return { terminal: false, type: 'NONE', reason: 'EXODIA_COMPLETE_AWAIT_TERMINAL_OUTCOME' };
  }

  if (
    runtime && (
      runtime.chickenGameDrawPending === true ||
      (runtime.fieldSpell === IDS.CHICKEN_GAME && runtime.chickenGameDrawUsed !== true)
    ) && remaining >= 1
  ) {
    return { terminal: false, type: 'NONE', reason: 'FIELD_DRAW_RESOURCE_REACHABLE' };
  }

  const direct = actions.find(action => actionActuallyProducesRandomResource(action, runtime || {}));
  if (direct) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'DIRECT_RANDOM_RESOURCE_ACTION_EXISTS',
      escape: direct.id
    };
  }

  const bambooEscape = bambooRouteCanUnlockDraw({ handCounts, deck, runtime: runtime || {} });
  if (bambooEscape) {
    return { terminal: false, type: 'NONE', reason: bambooEscape };
  }
  if (actions.some(action =>
    action && (
      action.id === IDS.CURSED_BAMBOO ||
      action.id === IDS.TRUE_BAMBOO ||
      (action.id === IDS.HORNET && action.details && action.details.bambooFollowUp)
    )
  )) {
    return { terminal: false, type: 'NONE', reason: 'MODELED_BAMBOO_FIXED_ROUTE_REACHABLE' };
  }


  // Toon Table itself only thins/searches. It is productive here only when its
  // terminal Toon Dragon target can enable a Trade-In that is already in hand.
  const toonSearches = deckCount(deck, IDS.TOON_TABLE) + (deckCount(deck, IDS.TOON_DRAGON) > 0 ? 1 : 0);
  if (
    Number(handCounts[IDS.TOON_TABLE] || 0) > 0 &&
    deckCount(deck, IDS.TOON_DRAGON) > 0 &&
    Number(handCounts[IDS.TRADE_IN] || 0) > 0 &&
    remaining - toonSearches >= 2
  ) {
    return { terminal: false, type: 'NONE', reason: 'TOON_CHAIN_UNLOCKS_TRADE_IN' };
  }

  if (Number(handCounts[IDS.ENGAGE] || 0) > 0 && engageTargets.length > 0) {
    const engageEscape = engageSearchCanUnlockDraw({
      targets: engageTargets,
      handCounts,
      deck,
      graveAfterFirstEngage: Number(runtime && runtime.graveSpellCount || 0) + 1
    });
    if (engageEscape) {
      return { terminal: false, type: 'NONE', reason: engageEscape };
    }
  }

  // Raye -> E10 or Hornet -> Kagari can recover Engage from the GY. Recovery
  // is an escape only when that Engage has a real Deck target and can generate
  // a draw (or unlock a paired draw spell); recovering an unusable Engage is
  // deliberately not counted.
  const rayeCloseout = describeRayeCloseout(rawCards, runtime || {}, result);
  const canEnterRayeZero = rayeCloseout.ready === true;
  const canReachSkyRecovery = canEnterRayeZero ||
    actions.some(action => action && action.id === IDS.HORNET);
  const engageKnownInGrave = Number(runtime && runtime.usedCounts && runtime.usedCounts[IDS.ENGAGE] || 0) > 0;
  // Raye can also access an Engage still in Deck through Zero's summon effect.
  // Keep a real fixed search available even when no bonus draw is possible yet.
  if (canEnterRayeZero && deckCount(deck, IDS.ENGAGE) > 0) {
    return { terminal: false, type: 'NONE', reason: 'SKY_ENTRY_FIXED_ENGAGE_SEARCH_REACHABLE' };
  }
  if (canReachSkyRecovery && engageKnownInGrave && engageTargets.length > 0) {
    if (Number(runtime && runtime.graveSpellCount || 0) >= 3) {
      return { terminal: false, type: 'NONE', reason: 'SKY_RECOVERY_UNLOCKS_ENGAGE_BONUS_DRAW' };
    }
    const recoveredEngageEscape = engageSearchCanUnlockDraw({
      targets: engageTargets,
      handCounts,
      deck,
      graveAfterFirstEngage: Number(runtime && runtime.graveSpellCount || 0) + 1
    });
    if (recoveredEngageEscape) {
      return { terminal: false, type: 'NONE', reason: recoveredEngageEscape };
    }
  }

  // ISSUE-100: a lack of future draw does not cancel a legal search/recovery.
  // These actions have already passed the collector's target and route gates.
  // Preserve the ordinary priority winner until each fixed action is completed.
  const fixedResource = actions.find(action =>
    action && KNOWN_DETERMINISTIC_ONLY_IDS.has(action.id)
  );
  if (fixedResource) {
    return { terminal: false, type: 'NONE', reason: 'FIXED_RESOURCE_ACTION_PENDING',
      action: fixedResource.id };
  }

  // Unknown future action types make the proof unsafe.
  const unmodeledAction = actions.find(action =>
    action &&
    !KNOWN_DETERMINISTIC_ONLY_IDS.has(action.id) &&
    !actionActuallyProducesRandomResource(action, runtime || {})
  );
  if (unmodeledAction) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'UNMODELED_ACTION_NOT_SAFE_TO_FORECAST',
      action: unmodeledAction.id
    };
  }

  return {
    terminal: true,
    type: 'DEADLOCK',
    action: 'STOP',
    reason: 'NO_REACHABLE_DRAW_OR_PRODUCTIVE_FIXED_RESOURCE_ROUTE',
    confidence: 'HIGH',
    rayeCloseout,
    handIds,
    deckRemaining: remaining,
    searchable: {
      engage: {
        M06: deckCount(deck, IDS.RAYE),
        M08: deckCount(deck, IDS.HAMP),
        M22: deckCount(deck, IDS.HORNET)
      },
      toon: {
        M10: deckCount(deck, IDS.TOON_TABLE),
        M07: deckCount(deck, IDS.TOON_DRAGON)
      },
      bamboo: {
        M19: deckCount(deck, IDS.CURSED_BAMBOO),
        M20: deckCount(deck, IDS.TRUE_BAMBOO)
      }
    },
    legalButUnproductive: actions.map(action => action.id)
  };
}

function detectDeadlock(session) {
  const rawCards = session && Array.isArray(session.cards) ? session.cards : [];
  if (!rawCards.length || rawCards.some(card => !card || !card.id || card.id === 'UNKNOWN')) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'EMPTY_OR_UNKNOWN_HAND_NOT_SAFE_TO_CLASSIFY'
    };
  }

  const cards = normalizeCards(rawCards);
  const ids = cards.map(card => card.id);
  const uniqueIds = [...new Set(ids)];

  if (ids.includes(IDS.RAYE)) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'RAYE_IN_HAND',
      handIds: ids
    };
  }

  if (session && session.pendingMallet) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'MALLET_PENDING',
      handIds: ids
    };
  }

  if (session && session.pendingNadir) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'NADIR_PENDING_FULL_RESOLUTION',
      handIds: ids
    };
  }

  const field = deriveKnownFieldState(session || {});
  if (field.chickenGameEffectAvailable) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'KNOWN_FIELD_CONTINUATION_CHICKEN_GAME',
      handIds: ids,
      field
    };
  }

  const decision = optimisticHandDecision(cards);
  if (decision.selected) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'OPTIMISTIC_HAND_ACTION_EXISTS',
      handIds: ids,
      selected: {
        id: decision.selected.id,
        name: decision.selected.name,
        tier: decision.selected.tier
      },
      field
    };
  }

  // The FTK route treats Exodia pieces, Toon Dragon, H.A.M.P. and Bamboo
  // equipment without Raye/another modeled starter as inert hand resources.
  // They are retained in evidence so the terminal decision is auditable.
  const inertOnly = ids.every(id =>
    isExodiaComponentId(id) ||
    id === IDS.TOON_DRAGON ||
    id === IDS.HAMP ||
    id === IDS.CURSED_BAMBOO ||
    id === IDS.TRUE_BAMBOO
  );

  if (!inertOnly) {
    return {
      terminal: false,
      type: 'NONE',
      reason: 'UNMODELED_NO_ACTION_NOT_SAFE_TO_SURRENDER',
      confidence: 'REVIEW',
      handIds: ids,
      uniqueHandIds: uniqueIds,
      field,
      optimisticActionCount: decision.actions.length,
      holds: (decision.holds || []).map(hold => ({
        id: hold.id,
        name: hold.name,
        reason: hold.reason
      }))
    };
  }

  return {
    terminal: true,
    type: 'DEADLOCK',
    action: 'SURRENDER',
    reason: 'NO_SAFE_HAND_ACTION_NO_RAYE_NO_KNOWN_FIELD_CONTINUATION',
    confidence: 'HIGH',
    handIds: ids,
    uniqueHandIds: uniqueIds,
    field,
    optimisticActionCount: decision.actions.length,
    holds: (decision.holds || []).map(hold => ({
      id: hold.id,
      name: hold.name,
      reason: hold.reason
    }))
  };
}

module.exports = {
  deriveKnownFieldState,
  optimisticHandDecision,
  describeRayeCloseout,
  analyzeReachableResourceDeadlock,
  detectDeadlock
};
