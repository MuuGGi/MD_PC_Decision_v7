'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { readPng, cropImage } = require(path.join(ROOT, 'lib', 'png-utils'));
const {
  findFaceUpCardComponents,
  findCardBackComponents,
  componentsOverlap,
  matchLogCard
} = require(path.join(ROOT, 'lib', 'duel-log-reader'));

function luminance(data, index) {
  return (data[index] * 3 + data[index + 1] * 6 + data[index + 2]) / 10;
}

function brightMask(template) {
  const points = [];
  for (let y = 0; y < template.height; y++) {
    for (let x = 0; x < template.width; x++) {
      const index = (y * template.width + x) * 4;
      const value = luminance(template.data, index);
      if (value >= 145) points.push({ x, y, value });
    }
  }
  return points;
}

function maskedMadAt(image, mask, x, y) {
  let sum = 0;
  for (const point of mask) {
    const index = ((y + point.y) * image.width + (x + point.x)) * 4;
    sum += Math.abs(luminance(image.data, index) - point.value);
  }
  return mask.length ? sum / (mask.length * 255) : Infinity;
}

function findTextMatches(panelImage, template, options) {
  const mask = brightMask(template);
  const threshold = Number(options.threshold || 0.095);
  const minX = Math.max(0, Number(options.minX || 0));
  const maxX = Math.min(
    panelImage.width - template.width,
    Number.isFinite(options.maxX) ? Number(options.maxX) : panelImage.width - template.width
  );
  const minY = Math.max(0, Number(options.minY || 0));
  const maxY = Math.min(
    panelImage.height - template.height,
    Number.isFinite(options.maxY) ? Number(options.maxY) : panelImage.height - template.height
  );
  const step = Math.max(1, Number(options.step || 1));
  const candidates = [];
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const mad = maskedMadAt(panelImage, mask, x, y);
      if (mad <= threshold) candidates.push({ x, y, mad });
    }
  }
  const kept = [];
  for (const candidate of candidates.sort((a, b) => a.mad - b.mad)) {
    if (kept.some(item => Math.abs(item.x - candidate.x) <= 14 && Math.abs(item.y - candidate.y) <= 20)) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

function uniqueCardComponents(faceUp, backs) {
  const out = [];
  for (const component of faceUp) {
    out.push({ ...component, visibility: 'FACE_UP' });
  }
  for (const component of backs) {
    if (faceUp.some(other => componentsOverlap(other, component))) continue;
    out.push({ ...component, visibility: 'CARD_BACK' });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

function groupSameRow(components, tolerance = 20) {
  const rows = [];
  for (const component of components) {
    const centerY = component.y + component.height / 2;
    let row = rows.find(item => Math.abs(item.centerY - centerY) <= tolerance);
    if (!row) {
      row = { centerY, cards: [] };
      rows.push(row);
    }
    row.cards.push(component);
    row.centerY = row.cards.reduce((sum, card) => sum + card.y + card.height / 2, 0) / row.cards.length;
  }
  return rows.map(row => ({
    centerY: row.centerY,
    cards: row.cards.sort((a, b) => a.x - b.x)
  })).sort((a, b) => a.centerY - b.centerY);
}

function nearestReturnCard(returnMatch, cardComponents) {
  const targetY = returnMatch.y + 13;
  const candidates = cardComponents.filter(card => {
    const cy = card.y + card.height / 2;
    return card.x < returnMatch.x && Math.abs(cy - targetY) <= 52;
  });
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const ay = Math.abs((a.y + a.height / 2) - targetY);
    const by = Math.abs((b.y + b.height / 2) - targetY);
    return ay - by || b.x - a.x;
  })[0];
}

function cardIdentity(sourceImage, component, cardTemplates) {
  if (!component) return null;
  if (component.visibility === 'CARD_BACK') {
    return { id: 'UNKNOWN', name: '背面牌', visibility: 'CARD_BACK' };
  }
  const match = matchLogCard(sourceImage, component, cardTemplates);
  return {
    id: match.best && match.best.id || 'UNKNOWN',
    name: match.best && match.best.name || 'UNKNOWN',
    mad: match.best && Number.isFinite(match.best.mad) ? match.best.mad : null,
    visibility: 'FACE_UP'
  };
}

async function loadMalletEvidenceTemplates(rootDir) {
  const dir = path.join(rootDir, 'templates', 'ui');
  return {
    returnText: await readPng(path.join(dir, 'duel_log_label_mallet_return.png')),
    drawText: await readPng(path.join(dir, 'duel_log_label_mallet_draw.png'))
  };
}


function estimateRowPitch(cards) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  const centers = cards.map(card => card.x + card.width / 2).sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < centers.length; i++) {
    const diff = centers[i] - centers[i - 1];
    if (diff >= 45 && diff <= 75) diffs.push(diff);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function selectDrawRows(rows, labelAbsY) {
  const below = rows.filter(row => row.centerY >= labelAbsY + 45 && row.centerY <= labelAbsY + 310);
  if (!below.length) return [];
  below.sort((a, b) => a.centerY - b.centerY);

  let startIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < below.length; i++) {
    const distance = Math.abs(below[i].centerY - (labelAbsY + 95));
    if (distance < bestDistance) {
      bestDistance = distance;
      startIndex = i;
    }
  }

  const selected = [below[startIndex]];
  for (let i = startIndex + 1; i < below.length; i++) {
    const prev = selected[selected.length - 1];
    const gap = below[i].centerY - prev.centerY;
    if (gap < 55) continue;
    if (gap > 120) break;
    selected.push(below[i]);
    if (selected.length >= 3) break;
  }
  return selected;
}

function inferMultiRowDrawCount(selectedRows, expectedDrawCount) {
  if (!selectedRows.length) {
    return { resultCount: 0, observedCardCount: 0, rowObservedCounts: [], rowInferredCounts: [], inferredPitch: null, inferredMissingSlots: [] };
  }

  const observedCardCount = selectedRows.reduce((sum, row) => sum + row.cards.length, 0);
  const rowObservedCounts = selectedRows.map(row => row.cards.length);
  const pitches = selectedRows.map(row => estimateRowPitch(row.cards)).filter(Number.isFinite);
  const inferredPitch = pitches.length ? pitches.sort((a, b) => a - b)[Math.floor(pitches.length / 2)] : null;
  const rowInferredCounts = rowObservedCounts.slice();
  const inferredMissingSlots = [];

  // Master Duel's DRAW result list wraps after four cards.  The important
  // evidence here is the wrap itself: once a following row exists, every
  // preceding row must have been full even if one thumbnail component was
  // missed by the generic face-up-card detector.
  for (let i = 0; i < selectedRows.length - 1; i++) {
    if (rowInferredCounts[i] < 4 && rowInferredCounts[i] >= 2) {
      const missing = 4 - rowInferredCounts[i];
      rowInferredCounts[i] = 4;
      inferredMissingSlots.push({ row: i + 1, count: missing, reason: 'NEXT_DRAW_ROW_PROVES_PREVIOUS_ROW_WRAPPED_FULL' });
    }
  }

  // Do not silently force the expected count.  We only infer ONE missing
  // trailing thumbnail when the visible row itself proves a stable ~58 px
  // grid pitch.  This applies both to a single-row <=4 draw and to the final
  // row of wrapped results such as 4+4+3 (12 -> 11 M11 study).
  if (Number.isInteger(expectedDrawCount) && Number.isFinite(inferredPitch) &&
      inferredPitch >= 54 && inferredPitch <= 62) {
    const priorCount = rowInferredCounts.slice(0, -1).reduce((sum, count) => sum + count, 0);
    const lastIndex = rowInferredCounts.length - 1;
    const expectedLast = expectedDrawCount - priorCount;
    if (expectedLast >= 1 && expectedLast <= 4 &&
        rowInferredCounts[lastIndex] >= 2 &&
        rowInferredCounts[lastIndex] < expectedLast &&
        expectedLast - rowInferredCounts[lastIndex] === 1) {
      rowInferredCounts[lastIndex] += 1;
      inferredMissingSlots.push({
        row: lastIndex + 1,
        count: 1,
        reason: 'STABLE_DRAW_GRID_PITCH_SUPPORTS_ONE_TRAILING_SLOT'
      });
    }
  }

  const resultCount = rowInferredCounts.reduce((sum, count) => sum + count, 0);
  return {
    resultCount,
    observedCardCount,
    rowObservedCounts,
    rowInferredCounts,
    inferredPitch,
    inferredMissingSlots
  };
}

function analyzeMalletResolutionEvidence(sourceImage, rightPanel, templates, cardTemplates, options = {}) {
  const panel = cropImage(sourceImage, rightPanel);
  const scopeMinY = Number.isFinite(options.minY) ? Math.max(0, Number(options.minY)) : 0;
  const scopeMaxY = Number.isFinite(options.maxY)
    ? Math.min(panel.height - 1, Number(options.maxY))
    : panel.height - 1;
  const returnMatches = findTextMatches(panel, templates.returnText, {
    minX: 120,
    maxX: 255,
    minY: scopeMinY,
    maxY: scopeMaxY,
    threshold: 0.105,
    step: 1
  });
  const drawMatches = findTextMatches(panel, templates.drawText, {
    minX: 0,
    maxX: 100,
    minY: scopeMinY,
    maxY: scopeMaxY,
    threshold: 0.105,
    step: 1
  });

  const faceUp = findFaceUpCardComponents(sourceImage, rightPanel).map(component => ({
    ...component,
    visibility: 'FACE_UP'
  }));
  const backs = findCardBackComponents(sourceImage, rightPanel).map(component => ({
    ...component,
    visibility: 'CARD_BACK'
  }));
  const cards = uniqueCardComponents(faceUp, backs);

  const returns = returnMatches.map(match => {
    const absoluteMatch = { ...match, x: rightPanel.x + match.x, y: rightPanel.y + match.y };
    const component = nearestReturnCard(absoluteMatch, cards);
    return {
      ...match,
      card: cardIdentity(sourceImage, component, cardTemplates),
      cardBox: component || null
    };
  });

  const expectedDrawCount = Number.isInteger(Number(options.expectedDrawCount))
    ? Number(options.expectedDrawCount)
    : null;

  const draws = drawMatches.map(match => {
    const labelAbsY = rightPanel.y + match.y;
    const candidateCards = cards.filter(card => {
      const topDelta = card.y - labelAbsY;
      return topDelta >= 25 && topDelta <= 330;
    });
    const rows = groupSameRow(candidateCards, 22);
    const selectedRows = selectDrawRows(rows, labelAbsY);
    const grid = inferMultiRowDrawCount(selectedRows, expectedDrawCount);
    const resultCards = [];
    selectedRows.forEach((row, rowIndex) => {
      row.cards.forEach(component => {
        resultCards.push({
          rowIndex: rowIndex + 1,
          box: component,
          card: cardIdentity(sourceImage, component, cardTemplates)
        });
      });
    });
    return {
      ...match,
      observedCardCount: grid.observedCardCount,
      resultCount: grid.resultCount,
      inferredPitch: grid.inferredPitch,
      rowObservedCounts: grid.rowObservedCounts,
      rowInferredCounts: grid.rowInferredCounts,
      inferredMissingSlots: grid.inferredMissingSlots,
      resultRows: selectedRows.map((row, rowIndex) => ({
        rowIndex: rowIndex + 1,
        centerY: row.centerY,
        observedCount: row.cards.length,
        inferredCount: grid.rowInferredCounts[rowIndex] || row.cards.length,
        cards: row.cards
      })),
      resultCards
    };
  });

  const rankedDraws = draws.slice().sort((a, b) => {
    // If the study knows the exact expected draw count (N-1 when all remaining
    // cards are returned), prefer the row whose inferred count matches it.
    if (expectedDrawCount !== null) {
      const aExact = a.resultCount === expectedDrawCount ? 0 : 1;
      const bExact = b.resultCount === expectedDrawCount ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aDelta = Math.abs(a.resultCount - expectedDrawCount);
      const bDelta = Math.abs(b.resultCount - expectedDrawCount);
      if (aDelta !== bDelta) return aDelta - bDelta;
    }
    return b.resultCount - a.resultCount || a.mad - b.mad;
  });

  const primaryDraw = rankedDraws.length ? rankedDraws[0] : null;
  const returnBeforePrimaryDraw = primaryDraw
    ? returns.filter(row => Number.isFinite(row.y) && row.y < primaryDraw.y)
    : [];
  if (primaryDraw) {
    const rowCards = primaryDraw.resultCards || [];
    const bottoms = rowCards.map(item => item.box && (item.box.y + item.box.height)).filter(Number.isFinite);
    const tops = rowCards.map(item => item.box && item.box.y).filter(Number.isFinite);
    const lefts = rowCards.map(item => item.box && item.box.x).filter(Number.isFinite);
    const rights = rowCards.map(item => item.box && (item.box.x + item.box.width)).filter(Number.isFinite);
    primaryDraw.anchor = {
      labelPanelX: primaryDraw.x,
      labelPanelY: primaryDraw.y,
      labelMad: primaryDraw.mad,
      expectedDrawCount,
      observedCardCount: primaryDraw.observedCardCount,
      resultCount: primaryDraw.resultCount,
      rowObservedCounts: primaryDraw.rowObservedCounts || [],
      rowInferredCounts: primaryDraw.rowInferredCounts || [],
      inferredMissingSlots: primaryDraw.inferredMissingSlots || [],
      rowClientTop: tops.length ? Math.min(...tops) : null,
      rowClientBottom: bottoms.length ? Math.max(...bottoms) : null,
      rowClientLeft: lefts.length ? Math.min(...lefts) : null,
      rowClientRight: rights.length ? Math.max(...rights) : null
    };
  }

  return {
    scope: { minY: scopeMinY, maxY: scopeMaxY },
    expectedDrawCount,
    returnLabelCount: returns.length,
    returnRows: returns,
    returnBeforePrimaryDrawCount: returnBeforePrimaryDraw.length,
    returnBeforePrimaryDrawRows: returnBeforePrimaryDraw,
    drawLabelCount: draws.length,
    drawRows: draws,
    primaryDraw,
    drawResultCount: primaryDraw ? primaryDraw.resultCount : 0,
    fingerprint: `M11:R${returns.length}:D${primaryDraw ? primaryDraw.resultCount : 0}:E${expectedDrawCount === null ? 'X' : expectedDrawCount}`
  };
}

module.exports = {
  brightMask,
  maskedMadAt,
  findTextMatches,
  loadMalletEvidenceTemplates,
  analyzeMalletResolutionEvidence,
  inferMultiRowDrawCount
};
