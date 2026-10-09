'use strict';
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');
const { planEquippedBambooContinuation, provenUnequippedBambooCarrier } = require('./yoto-search-value');

// Reachability depends on CURRENT resources, not which recovery/search named
// the last completed node. This plan never forecasts a new monster or a draw.
function planGoldenBambooSetup(cards = [], runtime = {}, deck = {}) {
  const branch = runtime.v5Branch || {};
  const node = String(branch.currentState || '');
  const carrierId = provenUnequippedBambooCarrier(runtime);
  if (!carrierId || adjustedMainDeckRemainingCount(deck) < 2 ||
      !cards.some(card => card?.id === 'M14')) return null;
  const sword = cards.find(card => card?.id === 'M19') || cards.find(card => card?.id === 'M20');
  if (!sword) return null;
  const afterEquip = cards.filter(card => card !== sword);
  const continuation = planEquippedBambooContinuation(deck.deckRemaining, afterEquip, {
    deck, byId: deck.byId,
    runtime: { ...runtime, bambooSwordEquipped: true, equippedBambooId: sword.id }
  });
  return { sword, carrierId, branchState: node, enablesGoldenDraw2: true,
    fixedContinuationReady: continuation.fixedContinuationReady,
    convertsTrue: sword.id === 'M20' && Number(deck.deckRemaining?.M19 || 0) > 0,
    phase: sword.id === 'M19' ? 'EQUIP_YOTO_FOR_GOLDEN_DRAW2' : 'EQUIP_TRUE_FOR_GOLDEN_DRAW2' };
}
module.exports = { planGoldenBambooSetup };
