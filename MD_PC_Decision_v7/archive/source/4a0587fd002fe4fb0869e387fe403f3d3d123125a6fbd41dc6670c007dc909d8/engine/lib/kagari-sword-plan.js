'use strict';
const { planEquippedBambooContinuation } = require('./yoto-search-value');

// This does not choose a new Link route. It only combines a sword departure
// with an already planned Kagari, using the same last-equip policy as Y1.
function planKagariSwordPreparation(cards, runtime, deck, materialId) {
  if (!['TOKEN_SKY_STRIKER', 'E03', 'E04', 'E05'].includes(materialId) ||
      runtime.bambooSwordEquipped === true ||
      Number(runtime.usedCounts?.M17 || 0) <= 0 ||
      Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) > 0 || !deck?.deckRemaining) return null;
  // Both departures have a deterministic replacement, not a forecast draw:
  // Yoto CL1 + Yoto CL2 + Kagari CL3 -> Engage, True, Golden.
  if (cards.length <= 11 && cards.filter(c => c.id === 'M19').length >= 2 &&
      Number(deck.deckRemaining.M20 || 0) >= 1 && Number(deck.deckRemaining.M14 || 0) >= 1) {
    const held = cards.slice();
    for (let n = 0; n < 2; n++) held.splice(held.findIndex(c => c.id === 'M19'), 1);
    const continuation = planEquippedBambooContinuation(deck.deckRemaining, held, {
      byId: deck.byId, deck,
      runtime: { ...runtime, bambooSwordEquipped: true, equippedBambooId: 'M19',
        equippedBambooCounts: { M19: 2 }, v5Branch: { carrierId: materialId,
          kagariSwordLink: true, m19EffectCount: 2 } }
    });
    if (continuation.shouldLink) return {
      plannedSwordId: 'M19', plannedSwordCount: 2, m19EffectCount: 2,
      bambooSearchIds: ['M20', 'M14'], kagariSwordLink: true, targetLinkId: 'E02',
      materialCarrierId: materialId,
      requiredCarrierKind: materialId === 'TOKEN_SKY_STRIKER' ? 'CENTRAL_MAIN' : 'EXTRA_LINK', continuation
    };
  }
  // True + held Yoto: convert True first, then the SAME equipped-node fork can
  // add the held Yoto before departure. No separate dual-sword route required.
  const order = cards.some(c => c.id === 'M20') && cards.some(c => c.id === 'M19')
    ? ['M20', 'M19'] : ['M19', 'M20'];
  for (const swordId of order) {
    const index = cards.findIndex(c => c.id === swordId);
    if (index < 0 || (swordId === 'M20' && Number(deck.deckRemaining.M19 || 0) <= 0)) continue;
    const remaining = { ...deck.deckRemaining };
    if (swordId === 'M20') remaining.M19--;
    const held = cards.filter((_, i) => i !== index);
    const continuation = planEquippedBambooContinuation(remaining, held, {
      byId: deck.byId,
      deck: { ...deck, deckRemaining: remaining },
      runtime: { ...runtime, bambooSwordEquipped: true, equippedBambooId: 'M19', equippedBambooCounts: { M19: 1 },
        v5Branch: { carrierId: materialId } }
    });
    if (!continuation.shouldLink) continue;
    return { plannedSwordId: swordId, kagariSwordLink: true, targetLinkId: 'E02',
      materialCarrierId: materialId,
      requiredCarrierKind: materialId === 'TOKEN_SKY_STRIKER' ? 'CENTRAL_MAIN' : 'EXTRA_LINK',
      continuation };
  }
  return null;
}

module.exports = { planKagariSwordPreparation };
