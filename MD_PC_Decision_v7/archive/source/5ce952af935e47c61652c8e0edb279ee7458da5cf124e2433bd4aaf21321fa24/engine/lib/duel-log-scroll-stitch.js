'use strict';

function blockKey(block) {
  return String(block && block.activationKey || '');
}

function detailKey(detail) {
  const card = detail && detail.card || {};
  return [
    detail && (detail.rawType || detail.type || ''),
    detail && detail.role || '',
    detail && detail.side || '',
    card.id || card.name || ''
  ].join('|');
}

function mergeBlock(older, newer) {
  const details = [];
  const seen = new Set();
  for (const detail of [...(older && older.details || []), ...(newer && newer.details || [])]) {
    const key = detailKey(detail);
    if (seen.has(key)) continue;
    seen.add(key);
    details.push(detail);
  }
  return {
    ...older,
    ...newer,
    activation: newer && newer.activation || older && older.activation,
    details,
    // Preserve the older signature when possible: it is the representation
    // most likely saved as the previous observer checkpoint.
    signature: older && older.signature || newer && newer.signature
  };
}

function overlapLength(olderBlocks, newerBlocks) {
  const limit = Math.min(olderBlocks.length, newerBlocks.length);
  for (let length = limit; length >= 1; length--) {
    let matches = true;
    for (let offset = 0; offset < length; offset++) {
      if (blockKey(olderBlocks[olderBlocks.length - length + offset]) !==
          blockKey(newerBlocks[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function findViewportOverlap(olderBlocks, newerBlocks, maxEdgeNoise = 2) {
  const strictLength = overlapLength(olderBlocks, newerBlocks);
  if (strictLength) {
    return {
      olderStart: olderBlocks.length - strictLength,
      newerStart: 0,
      length: strictLength,
      mode: 'STRICT_SUFFIX_PREFIX'
    };
  }

  // A blue heading cut by the top/bottom edge can disappear in one viewport
  // or be classified as a different partial block. Find the longest common
  // contiguous run while allowing only a small number of edge blocks to be
  // discarded. Interior gaps remain forbidden.
  let best = null;
  for (let olderStart = 0; olderStart < olderBlocks.length; olderStart++) {
    for (let newerStart = 0; newerStart < newerBlocks.length; newerStart++) {
      let length = 0;
      while (olderStart + length < olderBlocks.length &&
             newerStart + length < newerBlocks.length &&
             blockKey(olderBlocks[olderStart + length]) === blockKey(newerBlocks[newerStart + length])) {
        length++;
      }
      if (!length) continue;
      if (length === 1) {
        const key = blockKey(olderBlocks[olderStart]);
        const olderOccurrences = olderBlocks.filter(block => blockKey(block) === key).length;
        const newerOccurrences = newerBlocks.filter(block => blockKey(block) === key).length;
        if (olderOccurrences !== 1 || newerOccurrences !== 1) continue;
      }
      const discardedOlderTail = olderBlocks.length - (olderStart + length);
      const discardedNewerHead = newerStart;
      if (discardedOlderTail > maxEdgeNoise || discardedNewerHead > maxEdgeNoise) continue;
      const score = length * 100 - discardedOlderTail * 10 - discardedNewerHead;
      if (!best || score > best.score) {
        best = {
          olderStart,
          newerStart,
          length,
          discardedOlderTail,
          discardedNewerHead,
          mode: 'EDGE_TOLERANT_CONTIGUOUS',
          score
        };
      }
    }
  }
  return best;
}

function stitchChronologicalViewports(viewportBlockLists) {
  const lists = (viewportBlockLists || []).filter(Array.isArray);
  if (!lists.length) return { success: true, blocks: [], overlaps: [] };
  let combined = lists[0].slice();
  const overlaps = [];
  for (let index = 1; index < lists.length; index++) {
    const next = lists[index];
    if (!next.length) continue;
    if (!combined.length) {
      combined = next.slice();
      continue;
    }
    const match = findViewportOverlap(combined, next);
    if (!match) {
      return {
        success: false,
        reason: `VIEWPORT_OPERATION_OVERLAP_MISSING:${index - 1}->${index}`,
        blocks: combined,
        overlaps
      };
    }
    // Drop only the explicitly tolerated edge fragments. The common run and
    // all fully visible history on either side remain chronological.
    combined = combined.slice(0, match.olderStart + match.length);
    for (let offset = 0; offset < match.length; offset++) {
      combined[match.olderStart + offset] = mergeBlock(
        combined[match.olderStart + offset],
        next[match.newerStart + offset]
      );
    }
    combined.push(...next.slice(match.newerStart + match.length));
    overlaps.push({
      from: index - 1,
      to: index,
      operationCount: match.length,
      mode: match.mode,
      discardedOlderTail: match.discardedOlderTail || 0,
      discardedNewerHead: match.discardedNewerHead || 0
    });
  }
  return { success: true, blocks: combined, overlaps };
}

function mergeOrphanDetails(viewportOrphanLists) {
  const output = [];
  const seen = new Set();
  for (const detail of (viewportOrphanLists || []).flat()) {
    const key = detailKey(detail);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(detail);
  }
  return output;
}

module.exports = {
  blockKey,
  mergeBlock,
  overlapLength,
  findViewportOverlap,
  stitchChronologicalViewports,
  mergeOrphanDetails
};
