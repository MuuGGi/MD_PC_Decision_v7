'use strict';
const { NotReadyError } = require('./errors');
// Ending an interaction/chain changes its lock, not the existence of its carrier.
// A null projection means unspecified; field removal/replacement needs evidence.
function completeEffectPhase(previous = {}, next = {}, fieldChange = null) {
  const current = previous.carrierId || previous.carrierCardId || null;
  if (!current) throw new NotReadyError('FIELD_CARRIER_CONTINUITY_UNKNOWN');
  const proposed = next.carrierId || current;
  if (fieldChange) {
    if (fieldChange.proven !== true || fieldChange.affectedController !== 'SELF' ||
        !['SELF', 'OPPONENT', 'UNKNOWN'].includes(fieldChange.actor) || fieldChange.fromCardId !== current ||
        !['DEPARTED', 'REPLACED'].includes(fieldChange.kind)) throw new NotReadyError('FIELD_CHANGE_NOT_PROVEN');
    if (fieldChange.kind === 'REPLACED' && (!fieldChange.toCardId || fieldChange.toCardId !== proposed))
      throw new NotReadyError('FIELD_REPLACEMENT_NOT_PROVEN');
    return { ...next, carrierId: fieldChange.kind === 'DEPARTED' ? null : fieldChange.toCardId };
  }
  if (proposed !== current) throw new NotReadyError('FIELD_REPLACEMENT_REQUIRES_EVIDENCE');
  return { ...next, carrierId: current };
}
function applyGraveSpellMovement(beforeCount, { enteredSpellCount, recoveredCardIds = [], isSpell }) {
  if (!Number.isInteger(beforeCount) || beforeCount < 0 || !Number.isInteger(enteredSpellCount) || enteredSpellCount < 0 || typeof isSpell !== 'function')
    throw new NotReadyError('GRAVE_SPELL_MOVEMENT_UNKNOWN');
  let recoveredSpells = 0;
  for (const id of recoveredCardIds) {
    const spell = isSpell(id);
    if (typeof spell !== 'boolean') throw new NotReadyError('RECOVERED_CARD_TYPE_UNKNOWN');
    if (spell) recoveredSpells++;
  }
  const after = beforeCount + enteredSpellCount - recoveredSpells;
  if (after < 0) throw new NotReadyError('GRAVE_SPELL_MOVEMENT_INCONSISTENT');
  return after;
}
module.exports = { completeEffectPhase, applyGraveSpellMovement };
