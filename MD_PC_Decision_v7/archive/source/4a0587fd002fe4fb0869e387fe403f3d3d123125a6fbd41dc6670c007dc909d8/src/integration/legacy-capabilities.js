'use strict';
// Pure boundary: translate existing proven ledger/field facts, never write or rescan.
const { goldenDrawFacts } = require('../core/capability');
function goldenFromLegacy(cards, deck, runtime = {}, equipmentId = null) {
  const values = Object.entries(deck && deck.deckRemaining || {}).filter(([id]) => /^M\d+$/.test(id));
  const valid = values.length > 0 && values.every(([, n]) => Number.isInteger(n) && n >= 0);
  const unknownComponents = deck && deck.unknownExodiaOutsideCount || 0;
  const remaining = valid && Number.isInteger(unknownComponents) && unknownComponents >= 0
    ? values.reduce((n, [, count]) => n + count, 0) - unknownComponents : null;
  const equipment = equipmentId || runtime.bambooSwordEquipped === true;
  return goldenDrawFacts({ copies: Array.isArray(cards) ? cards.filter(c => c && c.id === 'M14').length : null,
    remaining, equipment: { status: equipment ? 'PROVEN' : runtime.bambooSwordEquipped === false ? 'ABSENT' : 'UNKNOWN',
      evidence: equipmentId || runtime.equippedBambooId || 'LEGACY_VERIFIED_EQUIP_STATE' } });
}
module.exports = { goldenFromLegacy };
