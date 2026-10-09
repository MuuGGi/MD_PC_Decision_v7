'use strict';

// One ordering contract for hand, setup and field candidates. Providers describe
// actions/conditions; they must not publish or overwrite the final selection.
function rankCandidates(actions = [], runtime = {}) {
  const rows = actions.filter(Boolean);
  const chickenAvailable = rows.some(a => a.id === 'M21' && a.tier === 2);
  return rows.slice().sort((a, b) => {
    const forced = action => action.details?.v5TestMode ? 0 : 1;
    if (forced(a) !== forced(b)) return forced(a) - forced(b);
    const toon = action => action.id === 'M10' ? 0 : 1;
    if (toon(a) !== toon(b)) return toon(a) - toon(b);
    const at = Number.isFinite(a.tier) ? a.tier : Infinity;
    const bt = Number.isFinite(b.tier) ? b.tier : Infinity;
    if (at !== bt) return at - bt;
    if (at === 2 && chickenAvailable) {
      const burial = action => action.id === 'M18' ? 1 : 0;
      if (burial(a) !== burial(b)) return burial(a) - burial(b);
    }
    const ag = Number(a.graveGain || 0), bg = Number(b.graveGain || 0);
    if (at === 2 && runtime.graveSpellCount < 3 && ag !== bg) return bg - ag;
    return Number(a.slot || 0) - Number(b.slot || 0);
  });
}

// Provisional provider query only, never a committed decision or state write.
function leadingCandidate(result) {
  return rankCandidates(result?.actions || [], result?.state || {})[0] || null;
}

function describeCosts(action) {
  const counts = {};
  if (action.slot && action.id) counts[action.id] = 1;
  const partner = action.details?.discardTarget || action.details?.banishTarget;
  if (partner?.id) counts[partner.id] = (counts[partner.id] || 0) + 1;
  for (const [id, count] of Object.entries(action.details?.additionalHandCosts || {}))
    counts[id] = (counts[id] || 0) + count;
  return counts;
}

function arbitrateCandidates(actions, runtime, handCounts = null) {
  const rejected = [], accepted = [];
  for (const action of actions || []) {
    const costs = describeCosts(action);
    if (!Number.isFinite(action.tier)) {
      rejected.push({ id: action.id, reason: 'PRIORITY_UNDEFINED' }); continue;
    }
    if (handCounts && Object.entries(costs).some(([id, count]) => (handCounts[id] || 0) < count)) {
      rejected.push({ id: action.id, reason: 'CURRENT_HAND_COST_UNAVAILABLE', costs }); continue;
    }
    accepted.push(action);
  }
  const ranked = rankCandidates(accepted, runtime);
  return { actions: ranked, selected: ranked[0] || null, rejected,
    trace: ranked.map(a => ({ id: a.id, slot: a.slot || null, tier: a.tier,
      phase: a.details?.phase || null, specialAction: a.specialAction || null,
      fieldIntent: a.details?.fieldIntent || null, swordStage: a.details?.swordStage || null,
      currentYotoCount: a.details?.currentYotoCount ?? null,
      plannedYotoCount: a.details?.m19EffectCount ?? null,
      costs: describeCosts(a), reason: a.reason })) };
}

module.exports = { rankCandidates, leadingCandidate, describeCosts, arbitrateCandidates };
