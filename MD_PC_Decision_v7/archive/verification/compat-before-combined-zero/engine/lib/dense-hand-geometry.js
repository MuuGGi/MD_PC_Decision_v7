'use strict';
const { measureTitlePatch } = require('./hand-state');

// These are the mature dragged-window calibration limits, not click guesses.
// Every clicked point and the boundary anchor still needs a real 2D patch.
const X_MIN = 640, X_MAX = 1460;
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
}
function resolveDenseMeasuredWindow(geometry, strategy, relative, image, roi, recoverEdge = false) {
  let components = (geometry.components || []).filter(c => c.centerX >= X_MIN && c.centerX <= X_MAX)
    .map(c => ({ ...c })).sort((a, b) => a.centerX - b.centerX);
  const spacing = median(components.slice(1).map((c, i) => c.centerX - components[i].centerX));
  const measured = new Map();
  function measure(component, selectedEndpoint = false) {
    if (measured.has(component.centerX)) return measured.get(component.centerX);
    const width = Number(component.width) || Math.round(spacing - 10);
    const local = { ...component, width,
      x: Number.isFinite(component.x) ? component.x - roi.x : component.centerX - roi.x - width / 2,
      centerX: component.centerX - roi.x };
    let patch = measureTitlePatch(image, local, false), offset = 0;
    // A selected endpoint has a "Set" button over its title. Search only
    // inside that already bounded endpoint, retaining colour coherence and
    // requiring its real card rim. Ordinary targets keep the original patch.
    if (!patch && selectedEndpoint) {
      for (const dx of [0, 12, 24, -12, -24]) {
        if (component.centerX + dx < X_MIN || component.centerX + dx > X_MAX) continue;
        patch = measureTitlePatch(image, { ...local, x: local.x + dx, centerX: local.centerX + dx }, true,
          { sampleHalfWidth: 16, minHalfWidth: 16 });
        if (patch) { offset = dx; break; }
      }
    }
    const result = patch ? { ...component, centerX: component.centerX + offset, width, centerY: patch.centerY + roi.y,
      title2D: true, titleSlope: patch.titleSlope, titleScore: patch.titleScore,
      inferred: false } : null;
    measured.set(component.centerX, result);
    if (result) measured.set(result.centerX, result);
    return result;
  }
  // Only the exceptional wide-frame path can recover ONE missing endpoint.
  // Its proposed point must actually contain the title; inference alone is
  // never returned as a clickable card, and two missing endpoints stay closed.
  if (recoverEdge && components.length >= 4 && spacing >= 100 && spacing <= 175) {
    const edge = strategy === 'right' ? components.at(-1) : components[0];
    const missing = strategy === 'right' ? edge.centerX < 1360 : strategy === 'left' && edge.centerX > 740;
    if (missing) {
      const x = Math.round(edge.centerX + (strategy === 'right' ? spacing : -spacing));
      if (x >= X_MIN && x <= X_MAX && (strategy === 'right' ? x >= 1360 : x <= 740)) {
        const candidate = measure({ centerX: x, width: Math.round(spacing - 10) }, true);
        if (candidate) components.push(candidate);
        components.sort((a, b) => a.centerX - b.centerX);
      }
    }
  }
  const safe = strategy === 'right' ? components.slice(-5) : strategy === 'left' ? components.slice(0, 5) : (() => {
    let best = components.slice(0, 5), score = Infinity;
    for (let i = 0; i <= components.length - 5; i++) {
      const group = components.slice(i, i + 5), distance = Math.abs((group[0].centerX + group.at(-1).centerX) / 2 - 1024);
      if (distance < score) { best = group; score = distance; }
    }
    return best;
  })();
  if (safe.length !== 5 || !Number.isInteger(relative) || relative < 0 || relative >= 5) return null;
  if (safe.slice(1).some((c, i) => c.centerX - safe[i].centerX < 90 || c.centerX - safe[i].centerX > 185)) return null;
  const edge = strategy === 'right' ? safe.at(-1) : safe[0];
  if ((strategy === 'right' && edge.centerX < 1360) || (strategy === 'left' && edge.centerX > 740)) return null;
  const anchor = measure(edge), target = measure(safe[relative]);
  if (!anchor || !target) return null;
  safe[strategy === 'right' ? 4 : 0] = anchor; safe[relative] = target;
  return { components: safe, target, strategy, endpoint: anchor.centerX,
    source: recoverEdge ? 'DENSE_MEASURED_WIDE_RECOVERY' : 'DENSE_MEASURED_FAST_TARGET' };
}
module.exports = { resolveDenseMeasuredWindow };
