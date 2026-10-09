'use strict';
const { sameRuntimeCardIdentity } = require('./exodia-policy');

function median(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function medianSpacing(centers) {
  const xs = (centers || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < 2) return null;
  return median(xs.slice(1).map((x, i) => x - xs[i]));
}

function geometryDelta(a, b) {
  const aa = (a || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  const bb = (b || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!aa.length || !bb.length) return Infinity;

  // Dense fans can lose an outer title component.  Compare the smaller list
  // against the best contiguous slice of the larger one rather than forcing
  // equal component counts.
  const small = aa.length <= bb.length ? aa : bb;
  const large = aa.length <= bb.length ? bb : aa;
  let best = Infinity;
  for (let start = 0; start <= large.length - small.length; start++) {
    const diffs = small.map((x, i) => Math.abs(x - large[start + i]));
    const score = median(diffs);
    if (Number.isFinite(score) && score < best) best = score;
  }
  return best;
}

function geometryStable(a, b, tolerancePx = 6) {
  return geometryDelta(a, b) <= tolerancePx;
}

function normalizeCards(cards) {
  return (cards || []).map(card => ({
    ...card,
    id: card && card.id ? String(card.id) : 'UNKNOWN',
    name: card && card.name ? String(card.name) : 'UNKNOWN',
    accepted: Boolean(card && card.accepted)
  }));
}

function sameCard(a, b) {
  if (!a || !b || !a.accepted || !b.accepted) return false;
  if (a.id === 'UNKNOWN' || b.id === 'UNKNOWN') return false;
  return sameRuntimeCardIdentity(a, b);
}

function validOverlaps(previousCards, currentCards) {
  const prev = normalizeCards(previousCards);
  const curr = normalizeCards(currentCards);
  const max = Math.min(prev.length, curr.length);
  const out = [];
  for (let k = 1; k <= max; k++) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (!sameCard(prev[prev.length - k + i], curr[i])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(k);
  }
  return out;
}

function chooseOverlap(previousCards, currentCards, options = {}) {
  const overlaps = validOverlaps(previousCards, currentCards);
  if (!overlaps.length) {
    return {
      overlap: 0,
      candidates: [],
      ambiguous: false,
      expectedOverlap: null,
      reason: 'NO_EXACT_CARD_OVERLAP'
    };
  }

  const prevLen = (previousCards || []).length;
  const spacing = Number(options.medianSpacingPx);
  const drag = Math.abs(Number(options.dragDistancePx));
  let expectedOverlap = null;
  if (Number.isFinite(spacing) && spacing >= 55 && Number.isFinite(drag) && drag > 0) {
    const expectedAdvance = Math.max(1, Math.round(drag / spacing));
    expectedOverlap = Math.max(0, prevLen - expectedAdvance);
  }

  let chosen;
  if (expectedOverlap == null) {
    chosen = Math.max(...overlaps);
  } else {
    chosen = overlaps.slice().sort((a, b) => {
      const da = Math.abs(a - expectedOverlap);
      const db = Math.abs(b - expectedOverlap);
      return da - db || b - a;
    })[0];
  }

  return {
    overlap: chosen,
    candidates: overlaps,
    ambiguous: overlaps.length > 1,
    expectedOverlap,
    reason: overlaps.length > 1 ? 'DUPLICATE_CARD_OVERLAP_RESOLVED_BY_GEOMETRY' : 'EXACT_CARD_OVERLAP'
  };
}

function mergeWindows(windows, handCount) {
  const rows = (windows || []).filter(row => Array.isArray(row.cards) && row.cards.length);
  if (!rows.length) {
    return { cards: [], steps: [], complete: false, confidence: 'NONE' };
  }

  let merged = normalizeCards(rows[0].cards);
  const steps = [];
  for (let i = 1; i < rows.length; i++) {
    const prevWindow = normalizeCards(rows[i - 1].cards);
    const current = normalizeCards(rows[i].cards);
    const overlap = chooseOverlap(prevWindow, current, {
      medianSpacingPx: rows[i].medianSpacingPx || rows[i - 1].medianSpacingPx,
      dragDistancePx: rows[i].dragDistancePx
    });
    const append = current.slice(overlap.overlap);
    merged.push(...append);
    steps.push({
      fromWindow: rows[i - 1].index,
      toWindow: rows[i].index,
      ...overlap,
      appended: append.map(card => card.id)
    });
    if (Number.isInteger(handCount) && merged.length >= handCount) {
      merged = merged.slice(0, handCount);
      break;
    }
  }

  const accepted = merged.filter(card => card.accepted && card.id !== 'UNKNOWN').length;
  const complete = Number.isInteger(handCount) && merged.length === handCount && accepted === handCount;
  const hadZeroOverlap = steps.some(step => step.overlap === 0);
  const hadAmbiguous = steps.some(step => step.ambiguous);
  const confidence = complete && !hadZeroOverlap && !hadAmbiguous
    ? 'HIGH'
    : complete && !hadZeroOverlap
      ? 'MEDIUM'
      : complete
        ? 'LOW'
        : 'INCOMPLETE';

  return { cards: merged, steps, complete, confidence };
}


function mergeBoundaryWindows(firstCards, lastCards, handCount) {
  const first = normalizeCards(firstCards);
  const last = normalizeCards(lastCards);
  if (!Number.isInteger(handCount) || handCount <= 0) {
    return { cards: [], complete: false, confidence: 'NONE', overlap: 0, overlapMatches: 0 };
  }
  if (!first.length || !last.length) {
    return { cards: [], complete: false, confidence: 'NONE', overlap: 0, overlapMatches: 0 };
  }

  const overlap = Math.max(0, first.length + last.length - handCount);
  if (overlap > Math.min(first.length, last.length)) {
    return { cards: [], complete: false, confidence: 'NONE', overlap, overlapMatches: 0 };
  }

  let overlapMatches = 0;
  for (let i = 0; i < overlap; i++) {
    if (sameCard(first[first.length - overlap + i], last[i])) overlapMatches++;
  }

  const cards = first.concat(last.slice(overlap)).slice(0, handCount);
  const accepted = cards.filter(card => card.accepted && card.id !== 'UNKNOWN').length;
  const complete = cards.length === handCount && accepted === handCount;
  const overlapConsistent = overlap === 0 || overlapMatches === overlap;
  const confidence = complete && overlapConsistent ? 'HIGH' : complete ? 'LOW' : 'INCOMPLETE';
  return { cards, complete, confidence, overlap, overlapMatches, overlapConsistent };
}


function mergeAnchoredThreeWindows(firstWindow, middleWindow, lastWindow, handCount) {
  const first = normalizeCards(firstWindow && firstWindow.cards);
  const middle = normalizeCards(middleWindow && middleWindow.cards);
  const last = normalizeCards(lastWindow && lastWindow.cards);
  if (!Number.isInteger(handCount) || handCount <= 0 || !first.length || !middle.length || !last.length) {
    return { cards: [], steps: [], complete: false, confidence: 'NONE', candidates: [] };
  }

  const overlaps12 = validOverlaps(first, middle);
  const overlaps23 = validOverlaps(middle, last);
  const spacing = Number(
    middleWindow && middleWindow.medianSpacingPx ||
    firstWindow && firstWindow.medianSpacingPx ||
    lastWindow && lastWindow.medianSpacingPx
  );
  const drag = Math.abs(Number(middleWindow && middleWindow.dragDistancePx));
  let expected12 = null;
  if (Number.isFinite(spacing) && spacing >= 55 && Number.isFinite(drag) && drag > 0) {
    const expectedAdvance = Math.max(1, Math.round(drag / spacing));
    expected12 = Math.max(0, first.length - expectedAdvance);
  }

  const candidates = [];
  for (const overlap12 of overlaps12) {
    for (const overlap23 of overlaps23) {
      const cards = first.concat(middle.slice(overlap12), last.slice(overlap23));
      if (cards.length !== handCount) continue;
      const accepted = cards.filter(card => card.accepted && card.id !== 'UNKNOWN').length;
      if (accepted !== handCount) continue;
      const geometryPenalty = expected12 == null ? 0 : Math.abs(overlap12 - expected12);
      candidates.push({ overlap12, overlap23, cards, geometryPenalty });
    }
  }

  if (!candidates.length) {
    return {
      cards: [],
      steps: [],
      complete: false,
      confidence: 'INCOMPLETE',
      candidates: [],
      overlapCandidates12: overlaps12,
      overlapCandidates23: overlaps23,
      expectedOverlap12: expected12
    };
  }

  candidates.sort((a, b) =>
    a.geometryPenalty - b.geometryPenalty ||
    Math.abs(a.overlap12 - a.overlap23) - Math.abs(b.overlap12 - b.overlap23) ||
    b.overlap12 - a.overlap12
  );
  const chosen = candidates[0];
  const equallyBest = candidates.filter(candidate => candidate.geometryPenalty === chosen.geometryPenalty);
  const confidence = equallyBest.length === 1 ? 'HIGH' : 'MEDIUM';

  return {
    cards: chosen.cards,
    steps: [
      { fromWindow: firstWindow.index, toWindow: middleWindow.index, overlap: chosen.overlap12 },
      { fromWindow: middleWindow.index, toWindow: lastWindow.index, overlap: chosen.overlap23 }
    ],
    complete: true,
    confidence,
    candidates: candidates.map(candidate => ({
      overlap12: candidate.overlap12,
      overlap23: candidate.overlap23,
      geometryPenalty: candidate.geometryPenalty
    })),
    overlapCandidates12: overlaps12,
    overlapCandidates23: overlaps23,
    expectedOverlap12: expected12,
    chosenOverlaps: [chosen.overlap12, chosen.overlap23]
  };
}

function compareSweeps(a, b) {
  const aa = normalizeCards(a && a.cards);
  const bb = normalizeCards(b && b.cards);
  if (!aa.length || aa.length !== bb.length) {
    return { equal: false, samePositions: 0, total: Math.max(aa.length, bb.length), mismatches: [] };
  }
  const mismatches = [];
  let samePositions = 0;
  for (let i = 0; i < aa.length; i++) {
    if (sameCard(aa[i], bb[i])) samePositions++;
    else mismatches.push({ index: i + 1, a: aa[i].id, b: bb[i].id });
  }
  return { equal: mismatches.length === 0, samePositions, total: aa.length, mismatches };
}

module.exports = {
  median,
  medianSpacing,
  geometryDelta,
  geometryStable,
  validOverlaps,
  chooseOverlap,
  mergeWindows,
  mergeBoundaryWindows,
  mergeAnchoredThreeWindows,
  compareSweeps
};
