'use strict';
const { adjustedMainDeckRemainingCount } = require('./exodia-policy');
const { describeE10EngageSources } = require('./e10-engage-source-policy');
const { describeDoubleLinkSwordReadiness } = require('./double-link-policy');

// Shared by the recommender and the deadlock proof. Never forecast a direct
// Raye -> Zero while another carrier remains, or spend the last field equip.
function describeRayeCloseout(cards, runtime = {}, result = {}) {
  const branch = runtime.v5Branch || {};
  const carrier = String(branch.carrierId || branch.carrierCardId || '');
  const raye = (cards || []).find(c => c && c.id === 'M06');
  const alreadySummoned = runtime.rayeNormalSummoned === true && carrier === 'M06';
  const unavailable = reason => ({ ready: false, reason });
  if ((!raye || runtime.normalSummonUsed === true) && !alreadySummoned) return unavailable('NO_UNUSED_RAYE_ENTRY');
  if (branch.active === true && !alreadySummoned) return unavailable('ATOMIC_FIELD_TRANSACTION_PENDING');
  if (Number(runtime.effectUsage?.E10_SUMMON || 0) > 0 || carrier === 'E10') return unavailable('ZERO_ALREADY_USED');
  if (runtime.bambooSwordEquipped === true) return unavailable('FIELD_EQUIP_PRESERVED');
  const targets = result.engageTargets || [];
  const remaining = adjustedMainDeckRemainingCount(result.deck);
  const sourcePolicy = describeE10EngageSources(result.deck || {}, cards, runtime);
  const source = sourcePolicy.preferredSource;
  if (source === 'NONE') return unavailable('NO_REACHABLE_ENGAGE');
  const bonusDraw = Number(runtime.graveSpellCount || 0) >= 3 && targets.length > 0 &&
    remaining >= (source === 'DECK' ? 3 : 2);
  if (!carrier || carrier === 'M06') {
    return { ready: true, mode: 'DIRECT', source, sourcePolicy, bonusDraw, carrierId: carrier, raye };
  }
  if (!/^E(?:0[2-9])$/.test(carrier) ||
      !['KAGARI_RECOVERY_DONE', 'YOTO_SEARCH_DONE'].includes(String(branch.currentState || '')) || !bonusDraw) {
    return unavailable('NO_PROVEN_DOUBLE_LINK_CLOSEOUT');
  }
  const sword = describeDoubleLinkSwordReadiness(cards, runtime, result.deck || {});
  if (!sword.ready) return unavailable(sword.reason);
  return { ready: true, mode: 'DOUBLE_LINK', source, sourcePolicy, sword, bonusDraw, carrierId: carrier, raye };
}
module.exports = { describeRayeCloseout };
