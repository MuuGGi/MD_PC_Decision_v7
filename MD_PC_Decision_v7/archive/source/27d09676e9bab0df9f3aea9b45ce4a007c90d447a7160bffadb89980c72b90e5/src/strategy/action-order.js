'use strict';

// Branches describe current gains; they share these bands instead of inventing
// route-specific negative numbers. Toon keeps its existing absolute exception.
const PRIORITY = Object.freeze({ FIXED_RESOURCE: 0.5, ENGAGE: 1, DRAW_ONE: 2,
  ZERO_AFTER_SWORD: 2.5, DRAW_TWO: 3, ZERO_BEFORE_SWORD: 96, RAYE_CLOSEOUT: 101 });

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

// Only guaranteed, CURRENT draw capabilities enter this small endgame search.
// Randomly drawn identities never become fees or additional actions. A fixed
// search/setup/Toon or protected cost is a priority barrier, not a draw macro.
function currentDrawCapability(action, runtime) {
  if (action.details?.v5TestMode || action.details?.protectedToonDragonCost ||
      action.details?.allureLastResort) return null;
  if (action.specialAction === 'M21_FIELD_DRAW') return runtime.chickenGameDrawPending === true
    ? { count: 1, fieldDraw: true } : null;
  if (action.specialAction || !Number.isInteger(Number(action.slot)) || Number(action.slot) <= 0) return null;
  if (['M09', 'M15', 'M16', 'M18', 'M21'].includes(action.id)) return { count: 1 };
  if (action.id === 'M14' && runtime.bambooSwordEquipped === true) return { count: 2 };
  if (action.id === 'M12' && ['M07', 'M08'].includes(action.details?.discardTarget?.id)) return { count: 2 };
  if (action.id === 'M13' && ['M06', 'M08'].includes(action.details?.banishTarget?.id)) return { count: 2 };
  return null;
}

function planCurrentDrawOrder(ranked, runtime, handCounts, deck) {
  const unchanged = reason => ({ actions: ranked, trace: { applied: false, reason } });
  if (!ranked.length || !handCounts || !deck?.deckRemaining) return unchanged('NO_CURRENT_DRAW_BASIS');
  const values = Object.entries(deck.deckRemaining).filter(([id]) => /^M\d+$/.test(id));
  const unresolved = deck.unknownExodiaOutsideCount ?? deck.mainDeckLedger?.unknownExodiaOutsideCount ?? 0;
  if (!values.length || values.some(([, n]) => !Number.isInteger(n) || n < 0) ||
      !Number.isInteger(unresolved) || unresolved < 0 ||
      Object.values(handCounts).some(n => !Number.isInteger(n) || n < 0)) return unchanged('DRAW_BASIS_UNKNOWN');
  const remaining = values.reduce((n, [, count]) => n + count, 0) - unresolved;
  if (remaining <= 0) return unchanged('NO_REMAINING_DECK');
  // Do not move a random draw ahead of an already higher-ranked fixed gain.
  const models = [], keys = new Set();
  for (const action of ranked) {
    const capability = currentDrawCapability(action, runtime);
    if (!capability) break;
    const key = action.specialAction || `${action.id}@${action.slot}`;
    if (keys.has(key)) continue;
    keys.add(key); models.push({ action, ...capability, costs: describeCosts(action) });
  }
  if (models.length < 2) return unchanged('FIXED_GAIN_OR_SINGLE_DRAW_PRESERVED');
  if (models.length > 13) return unchanged('CURRENT_DRAW_POOL_LIMIT');
  const upper = models.reduce((n, m) => n + m.count, 0);
  if (remaining > upper) return unchanged('NOT_IN_CURRENT_DRAW_ENDGAME');
  const countBefore = Object.values(handCounts).reduce((n, count) => n + count, 0);
  const memo = new Map(), budget = 10000;
  let visited = 0;
  function advance(index, mask, left, counts, handCount, pending) {
    const model = models[index], { action, costs, count } = model;
    if ((mask & (1 << index)) || left < count || (model.fieldDraw && !pending) ||
        (action.id === 'M15' && handCount < 3) ||
        Object.entries(costs).some(([id, n]) => (counts[id] || 0) < n)) return null;
    const nextCounts = { ...counts };
    for (const [id, n] of Object.entries(costs)) nextCounts[id] -= n;
    const nextHandCount = handCount + count - Object.values(costs).reduce((n, c) => n + c, 0);
    // A future hand outside the supported observer is UNKNOWN, not an illegal
    // draw2 or proof that draw1 is better. Do not use that gap to rescore.
    if (nextHandCount > 12) throw new Error('DRAW_FUTURE_HAND_CAPABILITY_UNKNOWN');
    return { mask: mask | (1 << index), left: left - count, counts: nextCounts,
      handCount: nextHandCount, pending: action.id === 'M21' ? false : pending };
  }
  function best(mask, left, counts, handCount, pending) {
    if (!left) return 0;
    const key = JSON.stringify([mask, left, counts, handCount, pending]);
    if (memo.has(key)) return memo.get(key);
    if (++visited > budget) throw new Error('DRAW_SEARCH_BUDGET');
    let gain = 0;
    for (let i = 0; i < models.length; i++) {
      const next = advance(i, mask, left, counts, handCount, pending);
      if (next) gain = Math.max(gain, models[i].count + best(next.mask, next.left, next.counts, next.handCount, next.pending));
    }
    memo.set(key, gain); return gain;
  }
  try {
    const coverage = models.map((model, i) => {
      const next = advance(i, 0, remaining, handCounts, countBefore, runtime.chickenGameDrawPending === true);
      return { model, reachable: next ? model.count + best(next.mask, next.left, next.counts, next.handCount, next.pending) : -1 };
    });
    const maximum = Math.max(...coverage.map(row => row.reachable));
    // Stable original order among all equally good first moves. Thus 1+1+2
    // remains free-order, while 1+2+2 at four cards admits only the two draws.
    const optimal = new Set(coverage.filter(row => row.reachable === maximum).map(row => row.model.action));
    const applied = maximum > 0 && !optimal.has(ranked[0]);
    const actions = applied ? [...ranked.filter(a => optimal.has(a)), ...ranked.filter(a => !optimal.has(a))] : ranked;
    return { actions, trace: { applied, reason: applied ? 'PRESERVE_CURRENT_DRAW_COMBINATION' : 'NORMAL_FIRST_MOVE_PRESERVES_COMBINATION',
      remaining, maximumGuaranteedDraws: maximum, canEmptyDeck: maximum === remaining,
      statesVisited: visited, noFutureDrawIdentities: true,
      firstMoves: coverage.map(row => ({ id: row.model.action.id, slot: row.model.action.slot || null,
        drawCount: row.model.count, reachableDraws: row.reachable })) } };
  } catch (error) {
    if (!['DRAW_SEARCH_BUDGET', 'DRAW_FUTURE_HAND_CAPABILITY_UNKNOWN'].includes(error.message)) throw error;
    return unchanged(error.message + '_PRESERVE_NORMAL_ORDER');
  }
}

function arbitrateCandidates(actions, runtime, handCounts = null, deck = null) {
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
  const schedule = planCurrentDrawOrder(rankCandidates(accepted, runtime), runtime, handCounts, deck);
  const ranked = schedule.actions.map((action, index) => schedule.trace.applied && index === 0 ? {
    ...action, reason: `牌组末段剩${schedule.trace.remaining}张，当前真实费用与抽牌组合最多可抽${schedule.trace.maximumGuaranteedDraws}张；` +
      `先发动${action.name || action.id}保留该组合，避免抽1截断后续抽2。本次只执行这一张，结算后重新判断。`,
    details: { ...action.details, drawCombination: schedule.trace }
  } : action);
  return { actions: ranked, selected: ranked[0] || null, rejected, drawSchedule: schedule.trace,
    trace: ranked.map(a => ({ id: a.id, slot: a.slot || null, tier: a.tier,
      phase: a.details?.phase || null, specialAction: a.specialAction || null,
      fieldIntent: a.details?.fieldIntent || null, swordStage: a.details?.swordStage || null,
      currentYotoCount: a.details?.currentYotoCount ?? null,
      plannedYotoCount: a.details?.m19EffectCount ?? null,
      jointGain: a.details?.jointGain || null,
      costs: describeCosts(a), reason: a.reason })) };
}

module.exports = { PRIORITY, rankCandidates, leadingCandidate, describeCosts, arbitrateCandidates, planCurrentDrawOrder };
