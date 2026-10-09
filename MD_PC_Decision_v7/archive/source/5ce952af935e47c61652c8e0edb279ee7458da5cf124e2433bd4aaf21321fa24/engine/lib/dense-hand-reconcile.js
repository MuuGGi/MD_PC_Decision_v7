'use strict';

function cleanCard(card, index = null) {
  return {
    ...(card || {}),
    ...(index == null ? {} : { index }),
    id: card && card.id ? String(card.id) : 'UNKNOWN',
    name: card && card.name ? String(card.name) : 'UNKNOWN'
  };
}

function ids(cards) {
  return (cards || []).map(card => String(card && card.id || 'UNKNOWN'));
}

function enumerateEmbeddings(remainingCards, scannedCards, limit = 256) {
  const remaining = ids(remainingCards);
  const scanned = ids(scannedCards);
  const out = [];

  function walk(oldIndex, scanStart, chosen) {
    if (out.length >= limit) return;
    if (oldIndex >= remaining.length) {
      out.push(chosen.slice());
      return;
    }
    const target = remaining[oldIndex];
    const oldLeft = remaining.length - oldIndex - 1;
    for (let scanIndex = scanStart; scanIndex < scanned.length; scanIndex++) {
      if (scanned[scanIndex] !== target) continue;
      if ((scanned.length - scanIndex - 1) < oldLeft) break;
      chosen.push(scanIndex);
      walk(oldIndex + 1, scanIndex + 1, chosen);
      chosen.pop();
      if (out.length >= limit) return;
    }
  }

  walk(0, 0, []);
  return out;
}

function deriveInsertion(scannedCards, embedding) {
  const oldPositions = new Set(embedding || []);
  const insertedCards = [];
  for (let index = 0; index < (scannedCards || []).length; index++) {
    if (oldPositions.has(index)) continue;
    insertedCards.push({
      slot: index + 1,
      card: cleanCard(scannedCards[index], index + 1)
    });
  }
  return insertedCards;
}

function reconcileDenseFullScan(remainingCards, scannedCards, addedCount) {
  const remaining = (remainingCards || []).map((card, index) => cleanCard(card, Number(card && card.index || index + 1)));
  const scanned = (scannedCards || []).map((card, index) => cleanCard(card, index + 1));
  if (!Number.isInteger(addedCount) || addedCount < 0 || addedCount > 2) {
    return { success: false, reason: `DENSE_INVALID_ADDED_COUNT:${addedCount}` };
  }
  if (scanned.length !== remaining.length + addedCount) {
    return {
      success: false,
      reason: `DENSE_COUNT_MISMATCH:${remaining.length}+${addedCount}!=${scanned.length}`
    };
  }
  if (scanned.some(card => !card.id || card.id === 'UNKNOWN')) {
    return { success: false, reason: 'DENSE_SCAN_CONTAINS_UNKNOWN_CARD' };
  }

  const embeddings = enumerateEmbeddings(remaining, scanned);
  if (!embeddings.length) {
    return {
      success: false,
      reason: `DENSE_OLD_HAND_NOT_SUBSEQUENCE:${ids(remaining).join('>')}=>${ids(scanned).join('>')}`
    };
  }

  const variants = embeddings.map(embedding => {
    const insertedCards = deriveInsertion(scanned, embedding);
    return {
      embedding,
      insertedCards,
      identitySignature: insertedCards.map(item => item.card.id).join('>'),
      slotSignature: insertedCards.map(item => `${item.slot}:${item.card.id}`).join('|')
    };
  });
  const identitySignatures = new Set(variants.map(row => row.identitySignature));
  if (identitySignatures.size !== 1) {
    return {
      success: false,
      reason: `DENSE_INSERTION_IDENTITY_AMBIGUOUS:${[...identitySignatures].join(' / ')}`,
      embeddings: embeddings.length
    };
  }

  const chosen = variants[0];
  if (chosen.insertedCards.length !== addedCount) {
    return {
      success: false,
      reason: `DENSE_INSERTED_COUNT_MISMATCH:${chosen.insertedCards.length}/${addedCount}`
    };
  }

  const slotSignatures = new Set(variants.map(row => row.slotSignature));
  return {
    success: true,
    reason: null,
    cards: scanned,
    insertedCards: chosen.insertedCards,
    predictedSlots: chosen.insertedCards.map(item => item.slot),
    embeddings: embeddings.length,
    placementAmbiguous: slotSignatures.size > 1,
    identityAmbiguous: false,
    confidence: slotSignatures.size > 1 ? 'IDENTITY_EXACT_SLOT_EQUIVALENT' : 'EXACT_SUBSEQUENCE'
  };
}

module.exports = {
  enumerateEmbeddings,
  reconcileDenseFullScan
};
