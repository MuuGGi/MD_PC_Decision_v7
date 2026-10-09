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
const entityId = id => /^(?:M0[678]|E\d+|TOKEN_SKY_STRIKER)$/.test(String(id || ''));
const entityZone = id => /^E\d+$/.test(String(id || '')) ? 'EXTRA_LINK'
  : entityId(id) ? 'CENTRAL_MAIN' : null;
// An equip target's UI role is not its identity. Preserve a known same-zone
// entity only with this transaction's stable target-selection evidence.
function resolveEquipmentCarrier(runtime = {}, target = {}, expectedId = null) {
  const branch = runtime.v5Branch || {};
  const previous = branch.carrierId || branch.carrierCardId || null;
  const recognized = target.recognized?.accepted === true && entityId(target.recognized.id)
    ? target.recognized.id : null;
  const kind = target.kind || null;
  const stable = target.selectableProof?.stableFrames >= 2 && target.selectableProof?.lastYellow > 0;
  let id = recognized, source = 'CURRENT_TARGET_IDENTITY';
  const priorZone = branch.carrierEvidence?.proven === true && branch.carrierEvidence.cardId === previous
    ? branch.carrierEvidence.kind : entityZone(previous);
  const sameZone = [...new Set([
    entityId(previous) && priorZone === kind ? previous : null,
    runtime.rayeNormalSummoned === true && kind === 'CENTRAL_MAIN' ? 'M06' : null
  ].filter(Boolean))];
  if (!id && stable && sameZone.length === 1) {
    id = sameZone[0]; source = 'SAME_ENTITY_EQUIP_ZONE_CONTINUITY';
  }
  if (expectedId && (!entityId(expectedId) || id !== expectedId))
    throw new NotReadyError('EQUIP_CARRIER_BINDING_NOT_PROVEN');
  return { carrierId: id || null, carrierEvidence: {
    cardId: id || null, kind, proven: Boolean(recognized || stable),
    source: id ? source : 'TARGET_ZONE_ONLY_IDENTITY_UNKNOWN'
  } };
}
// Positive Main-zone facts veto no-Main-monster abilities. Absence of these
// facts is NOT a full-field/PvP observation or proof of every empty zone.
function mainMonsterConstraint(runtime = {}) {
  const branch = runtime.v5Branch || {}, id = branch.carrierId || branch.carrierCardId || null;
  const evidence = branch.carrierEvidence;
  const boundMain = evidence?.proven === true && evidence.kind === 'CENTRAL_MAIN' && evidence.cardId === id;
  const present = runtime.rayeNormalSummoned === true || runtime.engageBlockedByMainMonster === true ||
    branch.postE10HornetBambooDraw2 === true || boundMain || id === 'CENTRAL_MONSTER' ||
    id === 'TOKEN_SKY_STRIKER' || /^M\d+$/.test(String(id || ''));
  return { blocked: present, status: present ? 'PROVEN_MAIN_OCCUPIED' : 'NO_POSITIVE_MAIN_OCCUPANCY',
    carrierId: id, rayePresent: runtime.rayeNormalSummoned === true };
}
module.exports = { completeEffectPhase, applyGraveSpellMovement, resolveEquipmentCarrier, mainMonsterConstraint };
