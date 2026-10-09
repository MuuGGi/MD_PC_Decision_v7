'use strict';

function cardKey(detail) {
  const card = detail && detail.card;
  return String(card && (card.id || card.name) || '');
}

function detailToken(detail) {
  const key = cardKey(detail);
  if (!key) return '';
  return `${String(detail && (detail.rawType || detail.type || detail.role) || 'UNKNOWN')}:${key}`;
}

function tokensFromSignature(signature) {
  const text = String(signature || '');
  const bar = text.indexOf('|');
  if (bar < 0) return [];
  const rest = text.slice(bar + 1);
  if (!rest) return [];
  return rest.split(',').map(item => item.trim()).filter(Boolean);
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens || []) {
    if (!token) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function multisetContains(haystackTokens, needleTokens) {
  const haystack = tokenCounts(haystackTokens);
  const needle = tokenCounts(needleTokens);
  for (const [token, count] of needle.entries()) {
    if ((haystack.get(token) || 0) < count) return false;
  }
  return true;
}

function compactBlock(block) {
  if (!block) return null;
  const activationKey = String(block.activationKey || '');
  if (!activationKey) return null;
  const detailTokens = (block.details || []).map(detailToken).filter(Boolean);
  return {
    activationKey,
    signature: String(block.signature || ''),
    detailTokens
  };
}

function compactTailBlocks(blocks, maxBlocks = 6) {
  const compact = (blocks || []).map(compactBlock).filter(Boolean);
  return compact.slice(Math.max(0, compact.length - maxBlocks));
}

function savedTokens(saved) {
  if (Array.isArray(saved && saved.detailTokens)) return saved.detailTokens.filter(Boolean);
  return tokensFromSignature(saved && saved.signature);
}

function currentTokens(current) {
  if (Array.isArray(current && current.details)) {
    return current.details.map(detailToken).filter(Boolean);
  }
  if (Array.isArray(current && current.detailTokens)) return current.detailTokens.filter(Boolean);
  return tokensFromSignature(current && current.signature);
}

function compareSavedBlockToCurrent(saved, current) {
  if (!saved || !current) return { matched: false, reason: 'MISSING_BLOCK' };
  if (String(saved.activationKey || '') !== String(current.activationKey || '')) {
    return { matched: false, reason: 'ACTIVATION_KEY_MISMATCH' };
  }

  const savedSignature = String(saved.signature || '');
  const currentSignature = String(current.signature || '');
  if (savedSignature && currentSignature && savedSignature === currentSignature) {
    return { matched: true, kind: 'EXACT_SIGNATURE' };
  }

  const before = savedTokens(saved);
  const now = currentTokens(current);
  if (!before.length && !now.length) {
    return { matched: true, kind: 'HEADER_ONLY_EXACT' };
  }

  // A history block is allowed to grow after its checkpoint was saved. This is
  // common in Master Duel: M22 -> TOKEN is saved in one observer step and the
  // same visual M22 block later acquires LINK_SUMMON:E02. Treat the saved block
  // as a prefix/evidence subset, never require byte-for-byte signature equality.
  if (before.length && multisetContains(now, before)) {
    const strictExtension = now.length > before.length || currentSignature !== savedSignature;
    return {
      matched: true,
      kind: strictExtension ? 'MONOTONIC_DETAIL_EXTENSION' : 'SAVED_EVIDENCE_SUBSET',
      strictExtension
    };
  }

  return {
    matched: false,
    reason: before.length ? 'SAVED_DETAIL_EVIDENCE_NOT_PRESENT' : 'SIGNATURE_MISMATCH'
  };
}

function savedFingerprint(block) {
  const key = String(block && block.activationKey || '');
  const signature = String(block && block.signature || '');
  const tokens = savedTokens(block).join(',');
  return `${key}|${signature || tokens}`;
}

function findCrossRunTailContinuity(previousTail, currentBlocks) {
  const previous = Array.isArray(previousTail) ? previousTail.filter(Boolean) : [];
  const current = Array.isArray(currentBlocks) ? currentBlocks.filter(Boolean) : [];
  if (!previous.length) return { matched: false, reason: 'NO_SAVED_TAIL' };
  if (!current.length) return { matched: false, reason: 'NO_CURRENT_BLOCKS' };

  const limit = Math.min(previous.length, current.length);
  for (let length = limit; length >= 1; length--) {
    const previousStart = previous.length - length;
    const comparisons = [];
    let ok = true;
    let usedClippedFinalDetailFallback = false;

    for (let offset = 0; offset < length; offset++) {
      const saved = previous[previousStart + offset];
      const visible = current[offset];
      let comparison = compareSavedBlockToCurrent(saved, visible);

      if (!comparison.matched) {
        // Master Duel can compact the DETAIL rows of the previous endpoint
        // when a new operation (notably M21 / Chicken Game placement) is
        // appended below it.  In that shape the previous activation header and
        // its predecessor are still visible, but some/all saved result rows are
        // clipped.  Scrolling UP can never recover rows that were clipped BELOW
        // the header, so the old strict matcher wastes eight backtrack passes
        // and eventually throws.
        //
        // Accept this only for the FINAL block of an overlap, only when:
        //   1) at least one earlier overlap block already matched,
        //   2) there is a genuinely newer block after the overlap,
        //   3) activation identity is unchanged, and
        //   4) every detail that remains visible is a subset of the saved
        //      details (no contradictory new detail).
        // A fully matched UNIQUE earlier block is required below before this
        // fallback is allowed to authorize continuity.
        const isFinalOverlapBlock = offset === length - 1;
        const hasEarlierMatchedBlock = offset > 0 && comparisons.every(item => item.matched);
        const hasForwardNewBlock = current.length > length;
        const sameActivation = String(saved && saved.activationKey || '') ===
          String(visible && visible.activationKey || '');
        const beforeTokens = savedTokens(saved);
        const nowTokens = currentTokens(visible);
        const looksLikeClippedSavedDetails = beforeTokens.length > 0 &&
          nowTokens.length < beforeTokens.length &&
          multisetContains(beforeTokens, nowTokens);

        if (isFinalOverlapBlock && hasEarlierMatchedBlock && hasForwardNewBlock &&
            sameActivation && looksLikeClippedSavedDetails) {
          comparison = {
            matched: true,
            kind: 'CLIPPED_FINAL_DETAIL_WITH_PREDECESSOR',
            clippedFinalDetailFallback: true
          };
          usedClippedFinalDetailFallback = true;
        } else {
          ok = false;
          comparisons.push(comparison);
          break;
        }
      }

      comparisons.push(comparison);
    }
    if (!ok) continue;

    // Repeated identical spell activations are the dangerous case for a
    // cross-run suffix/prefix overlap. Require either a unique saved anchor in
    // the overlap or a strict in-place extension (which itself proves identity).
    // For the clipped-final-detail fallback, the unique anchor MUST come from
    // one of the earlier blocks that matched normally; the clipped endpoint
    // itself is not allowed to prove its own identity.
    const hasStrictExtension = comparisons.some(item => item.strictExtension);
    let hasUniqueSavedAnchor = false;
    for (let offset = 0; offset < length; offset++) {
      if (comparisons[offset] && comparisons[offset].clippedFinalDetailFallback) continue;
      const candidate = previous[previousStart + offset];
      const fp = savedFingerprint(candidate);
      const occurrences = previous.filter(item => savedFingerprint(item) === fp).length;
      if (occurrences === 1) {
        hasUniqueSavedAnchor = true;
        break;
      }
    }
    if (usedClippedFinalDetailFallback && !hasUniqueSavedAnchor) {
      continue;
    }
    if (!hasUniqueSavedAnchor && !hasStrictExtension) {
      continue;
    }

    return {
      matched: true,
      previousStart,
      overlapLength: length,
      newBlockStart: length,
      matchedKeys: current.slice(0, length).map(block => String(block.activationKey || '')),
      matchKinds: comparisons.map(item => item.kind),
      hasStrictExtension,
      hasUniqueSavedAnchor,
      usedClippedFinalDetailFallback
    };
  }

  return { matched: false, reason: 'NO_SAFE_SUFFIX_PREFIX_OVERLAP' };
}

module.exports = {
  compactBlock,
  compactTailBlocks,
  compareSavedBlockToCurrent,
  findCrossRunTailContinuity
};
