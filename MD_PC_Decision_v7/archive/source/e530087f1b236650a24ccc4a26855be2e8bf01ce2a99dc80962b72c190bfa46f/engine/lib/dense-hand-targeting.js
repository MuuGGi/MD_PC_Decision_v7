'use strict';

function denseWindowsForCount(handCount) {
  if (!Number.isInteger(handCount) || handCount < 8 || handCount > 12) {
    throw new Error(`DENSE_TARGET_COUNT_UNSUPPORTED:${handCount}`);
  }
  const windows = [
    { id: 'LEFT_EDGE', position: 'RIGHT_EDGE', startSlot: 1, endSlot: 5, strategy: 'left', order: 0 }
  ];
  if (handCount >= 11) {
    windows.push({ id: 'MIDDLE', position: 'MIDDLE_FROM_RIGHT', startSlot: 4, endSlot: 8, strategy: 'center', order: 1 });
  }
  windows.push({
    id: 'RIGHT_EDGE',
    position: 'LEFT_EDGE',
    startSlot: handCount - 4,
    endSlot: handCount,
    strategy: 'right',
    order: 2
  });
  return windows;
}

function covers(window, slot) {
  return slot >= window.startSlot && slot <= window.endSlot;
}

function subsets(rows) {
  const out = [];
  const total = 1 << rows.length;
  for (let mask = 1; mask < total; mask++) {
    const subset = [];
    for (let i = 0; i < rows.length; i++) {
      if (mask & (1 << i)) subset.push(rows[i]);
    }
    out.push(subset);
  }
  return out;
}

function assignmentDistance(window, slot) {
  const centre = (window.startSlot + window.endSlot) / 2;
  return Math.abs(slot - centre);
}

function planDenseTargetWindows(handCount, targetSlots) {
  const slots = [...new Set((targetSlots || []).map(Number))].sort((a, b) => a - b);
  if (slots.some(slot => !Number.isInteger(slot) || slot < 1 || slot > handCount)) {
    throw new Error(`DENSE_TARGET_SLOT_INVALID:${slots.join(',')}/${handCount}`);
  }
  if (!slots.length) return { handCount, targetSlots: [], windows: [] };

  const windows = denseWindowsForCount(handCount);
  const candidates = subsets(windows)
    .filter(group => slots.every(slot => group.some(window => covers(window, slot))))
    .map(group => {
      const assignments = new Map(group.map(window => [window.id, []]));
      let distance = 0;
      for (const slot of slots) {
        const choices = group.filter(window => covers(window, slot)).sort((a, b) => {
          return assignmentDistance(a, slot) - assignmentDistance(b, slot) || a.order - b.order;
        });
        const chosen = choices[0];
        assignments.get(chosen.id).push(slot);
        distance += assignmentDistance(chosen, slot);
      }
      const used = group.filter(window => assignments.get(window.id).length > 0);
      const score = used.length * 100 + distance + used.reduce((sum, window) => sum + window.order * 0.01, 0);
      return { used, assignments, score };
    })
    .sort((a, b) => a.score - b.score);

  if (!candidates.length) {
    throw new Error(`DENSE_TARGET_PLAN_UNCOVERED:${handCount}:${slots.join(',')}`);
  }
  const best = candidates[0];
  return {
    handCount,
    targetSlots: slots,
    windows: best.used
      .sort((a, b) => a.order - b.order)
      .map(window => ({
        ...window,
        slots: assignmentsFor(best.assignments, window.id)
      }))
  };
}

function assignmentsFor(assignments, id) {
  return (assignments.get(id) || []).slice().sort((a, b) => a - b);
}

module.exports = {
  denseWindowsForCount,
  planDenseTargetWindows
};
