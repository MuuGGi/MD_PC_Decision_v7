'use strict';

const COSTS = {
  M07: { id: 'M07', name: '青眼卡通龙' },
  M08: { id: 'M08', name: '闪术兵器－H.A.M.P.' }
};

const TRADE_IN_COST_IDS = Object.freeze(['M07', 'M08']);

function isTradeInCostId(id) {
  return TRADE_IN_COST_IDS.includes(String(id || ''));
}

function buildTradeInCostPolicy({ handCounts = {}, usedCounts = {} } = {}) {
  const toonTablesInGrave = Number(usedCounts && usedCounts.M10 || 0);
  const protectToonDragon = toonTablesInGrave < 3;
  const priority = (protectToonDragon ? ['M08', 'M07'] : ['M07', 'M08'])
    .map(id => ({ ...COSTS[id] }));

  let plannedCost = null;
  for (const candidate of priority) {
    if (Number(handCounts && handCounts[candidate.id] || 0) <= 0) continue;
    plannedCost = {
      ...candidate,
      // Preserve the existing decision-layer metadata exactly.  Before all
      // three Toon Tables are in the GY, whichever legal cost is actually
      // available is the current first usable choice.  Afterwards Toon Dragon
      // is preference 1 and H.A.M.P. is the fallback preference 2.
      preference: protectToonDragon
        ? 1
        : (candidate.id === 'M07' ? 1 : 2)
    };
    break;
  }

  return {
    toonTablesInGrave,
    protectToonDragon,
    priority,
    plannedCost,
    toonDragonStillProtected: Boolean(
      plannedCost && plannedCost.id === 'M07' && protectToonDragon
    )
  };
}

module.exports = {
  COSTS,
  TRADE_IN_COST_IDS,
  isTradeInCostId,
  buildTradeInCostPolicy
};
