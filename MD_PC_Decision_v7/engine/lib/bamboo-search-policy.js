'use strict';

const SEARCH_PRIORITY = Object.freeze([
  Object.freeze({ id: 'M20', name: '真刀竹光' }),
  Object.freeze({ id: 'M14', name: '金黄色的竹光' })
]);

function buildBambooSearchPriority() {
  return SEARCH_PRIORITY.map(item => ({ ...item }));
}

function bambooSearchTargetIds() {
  return SEARCH_PRIORITY.map(item => item.id);
}

function isLegalBambooSearchTarget(id) {
  return SEARCH_PRIORITY.some(item => item.id === String(id || ''));
}

// One target fork for every ordinary Yoto resolution. Mandatory triple-chain
// targets remain explicit; do not mistake a random future draw for equipment.
function chooseBambooSearchTarget({ deckRemaining = {}, handCards = [], legalIds = null } = {}) {
  const legal = id => Number(deckRemaining[id] || 0) > 0 && (!legalIds || legalIds.includes(id));
  const heldEquip = handCards.some(c => ['M19', 'M20'].includes(c?.id));
  const heldGolden = handCards.some(c => c?.id === 'M14');
  const heldTrue = handCards.some(c => c?.id === 'M20');
  const order = heldEquip && !heldGolden ? ['M14', 'M20']
    : heldTrue ? ['M14', 'M20'] : ['M20', 'M14'];
  const id = order.find(legal) || null;
  return { id, reason: id === 'M14' && heldEquip ? 'HELD_EQUIP_ENABLES_GOLDEN'
    : id === 'M20' ? 'SEARCH_CONFIRMED_EQUIP_REPLACEMENT' : id ? 'STOCK_LEGAL_GOLDEN' : 'NO_LEGAL_TARGET' };
}

module.exports = {
  buildBambooSearchPriority,
  bambooSearchTargetIds,
  isLegalBambooSearchTarget,
  chooseBambooSearchTarget
};
