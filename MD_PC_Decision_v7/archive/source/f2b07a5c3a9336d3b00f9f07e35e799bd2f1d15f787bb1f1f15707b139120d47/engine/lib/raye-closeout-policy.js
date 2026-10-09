'use strict';
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');
const { describeE10EngageSources } = require('./e10-engage-source-policy');
const { describeDoubleLinkSwordReadiness } = require('./double-link-policy');
const { mainMonsterConstraint } = require('../../src/core/field-state');

// Shared by the recommender and the deadlock proof. Never forecast a direct
// Raye -> Zero while another carrier remains, or spend the last field equip.
function describeRayeCloseout(cards, runtime = {}, result = {}) {
  const branch = runtime.v5Branch || {};
  const carrier = String(branch.carrierId || branch.carrierCardId || '');
  const raye = (cards || []).find(c => c && c.id === 'M06');
  const secondMaterialReady = runtime.rayeNormalSummoned === true && /^E0[2-9]$/.test(carrier) &&
    branch.currentState === 'RAYE_SECOND_MATERIAL_READY';
  const alreadySummoned = runtime.rayeNormalSummoned === true && (carrier === 'M06' || secondMaterialReady);
  const unavailable = reason => ({ ready: false, reason });
  if ((!raye || runtime.normalSummonUsed === true) && !alreadySummoned) return unavailable('NO_UNUSED_RAYE_ENTRY');
  if (branch.active === true && !alreadySummoned) return unavailable('ATOMIC_FIELD_TRANSACTION_PENDING');
  if (Number(runtime.effectUsage?.E10_SUMMON || 0) > 0 || carrier === 'E10') return unavailable('ZERO_ALREADY_USED');
  if (runtime.bambooSwordEquipped === true) return unavailable('FIELD_EQUIP_PRESERVED');
  const swordStage = describeDoubleLinkSwordReadiness(cards, runtime, result.deck || {});
  const heldSword = (cards || []).some(c => c && ['M19', 'M20'].includes(c.id));
  // Searching Raye is not a summon commitment. Deferring the sword entrance
  // is a strategy preference, not proof that a legal recovery cannot exist.
  const swordEntryDeferred = !alreadySummoned && !heldSword && !swordStage.stageComplete;
  const targets = result.engageTargets || [];
  const remaining = adjustedMainDeckRemainingCount(result.deck);
  const sourcePolicy = describeE10EngageSources(result.deck || {}, cards, runtime);
  const source = sourcePolicy.preferredSource;
  if (source === 'NONE') return unavailable('NO_REACHABLE_ENGAGE');
  const bonusDraw = Number(runtime.graveSpellCount || 0) >= 3 && targets.length > 0 &&
    remaining >= (source === 'DECK' ? 3 : 2);
  if (!carrier || carrier === 'M06') {
    return { ready: true, mode: 'DIRECT', source, sourcePolicy, bonusDraw, carrierId: carrier,
      alreadySummoned, sword: swordStage, swordEntryDeferred, raye };
  }
  // The carrier and resource receipts establish legality; a previous route's
  // completed-node name must not decide whether current resources can be used.
  if (!/^E(?:0[2-9])$/.test(carrier) || !bonusDraw) {
    return unavailable('NO_PROVEN_DOUBLE_LINK_CLOSEOUT');
  }
  const sword = describeDoubleLinkSwordReadiness(cards, runtime, result.deck || {});
  if (!sword.ready) return unavailable(sword.reason);
  return { ready: true, mode: 'DOUBLE_LINK', source, sourcePolicy, sword, bonusDraw,
    carrierId: carrier, alreadySummoned, swordEntryDeferred, raye };
}
// Shared opportunity-cost facts for hand equipment, Engage target purpose and
// the final field candidate pool. This is not a persisted multi-action route:
// each search/summon/link settles before the next snapshot is evaluated.
function describeEquipmentOpportunityCost(cards = [], runtime = {}, deck = {}) {
  const branch = runtime.v5Branch || {}, carrierId = String(branch.carrierId || branch.carrierCardId || '');
  const sword = describeDoubleLinkSwordReadiness(cards, runtime, deck);
  const idle = branch.active !== true && !/PENDING|IN_FLIGHT|PROMPT|SELECTED_FROM_DECK|FIELD_EFFECT_ACTIVATED/.test(branch.currentState || '');
  const heldSwordIds = cards.filter(c => ['M19', 'M20'].includes(c.id)).map(c => c.id);
  const unavailable = reason => ({ deferEquipment: false, reason, sword, carrierId });
  if (!idle || !heldSwordIds.length || runtime.bambooSwordEquipped === true ||
      !sword.stageComplete || !sword.ready || !/^E0[2-9]$/.test(carrierId) ||
      Number(runtime.effectUsage?.KAGARI_RECOVERY || 0) <= 0 ||
      Number(runtime.effectUsage?.E10_SUMMON || 0) > 0) return unavailable('NO_OPEN_UNEQUIPPED_LINK_GAIN_WINDOW');
  const targets = describeE10EngageSources(deck, cards, runtime).searchableTargets;
  const closeout = describeRayeCloseout(cards, runtime, { deck, engageTargets: targets });
  if (closeout.ready && closeout.mode === 'DOUBLE_LINK')
    return { deferEquipment: true, nextResource: 'CURRENT_TWO_MATERIAL_GAIN',
      reason: 'CONFIRMED_LINK_GAIN_BEFORE_FINAL_EQUIP', carrierId, heldSwordIds, sword,
      rayeSearchNeeded: false, closeout };
  if (runtime.normalSummonUsed === true || runtime.rayeNormalSummoned === true ||
      mainMonsterConstraint(runtime).blocked) return unavailable('NO_UNUSED_LEGAL_RAYE_ENTRY');
  const engage = cards.find(c => c.id === 'M17');
  const hasRaye = cards.some(c => c.id === 'M06');
  // Only an actually held activation can open the next deterministic search.
  // Never forecast drawing Raye, returning it with Mallet, or replaying recovery.
  if (!engage || engage.usable === false ||
      (!hasRaye && !(Number(deck.deckRemaining?.M06) > 0))) return unavailable('NO_CURRENT_ENGAGE_RAYE_ACCESS');
  const target = !hasRaye ? targets.find(t => t.id === 'M06')
    : ['M08', 'M06', 'M22'].map(id => targets.find(t => t.id === id)).find(Boolean);
  if (!target) return unavailable('NO_CURRENT_ENGAGE_TARGET');
  const remaining = { ...deck.deckRemaining, [target.id]: Number(deck.deckRemaining[target.id]) - 1 };
  const projectedCards = cards.filter(c => c !== engage).concat({ id: target.id });
  const projectedRuntime = { ...runtime, graveSpellCount: Number(runtime.graveSpellCount || 0) + 1,
    usedCounts: { ...runtime.usedCounts, M17: Number(runtime.usedCounts?.M17 || 0) + 1 } };
  const sources = describeE10EngageSources({ ...deck, deckRemaining: remaining }, projectedCards, projectedRuntime);
  const currentDrawCost = Number(runtime.graveSpellCount || 0) >= 3 ? 2 : 1;
  const futureDrawCost = sources.preferredSource === 'DECK' ? 3 : 2;
  if (projectedRuntime.graveSpellCount < 3 || sources.preferredSource === 'NONE' ||
      sources.searchableComponentRemaining < 1 ||
      adjustedMainDeckRemainingCount(deck) < currentDrawCost + futureDrawCost)
    return unavailable('NO_CURRENT_CAPACITY_FOR_LINK_ENGAGE_GAIN');
  return { deferEquipment: true, nextResource: 'CURRENT_ENGAGE_ACCESS',
    reason: 'ENGAGE_ACCESS_BEFORE_FINAL_EQUIP', carrierId, heldSwordIds, sword,
    rayeSearchNeeded: !hasRaye, searchTargetId: target.id,
    projectedEngageSource: sources.preferredSource,
    // The additional random draw has no invented identity. It can change the
    // next opportunity; actual post-resolution hand/deck must re-prove it.
    recheckAfterResolution: true };
}
module.exports = { describeRayeCloseout, describeEquipmentOpportunityCost };
