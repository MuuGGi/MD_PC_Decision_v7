'use strict';

const TOKEN_ID = 'TOKEN_SKY_STRIKER';

function checkpointGainKeys(checkpoint) {
  const output = [];
  const seen = new Set();
  for (const item of checkpoint && checkpoint.evidenceCards || []) {
    if (!item || item.kind !== 'HAND_GAIN' || !item.cardKey) continue;
    const key = String(item.cardKey);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}

function cardId(detail) {
  return String(detail && detail.card && (detail.card.id || detail.card.name) || '');
}

function hasDetail(block, rawType, expectedCardId) {
  return (block && block.details || []).some(detail =>
    detail && detail.rawType === rawType && cardId(detail) === expectedCardId
  );
}

function visibleEvidenceCounts(block) {
  const counts = new Map();
  for (const detail of block && block.details || []) {
    const key = cardId(detail);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function checkpointEvidenceCounts(checkpoint) {
  const counts = new Map();
  for (const item of checkpoint && checkpoint.evidenceCards || []) {
    if (!item || !item.cardKey) continue;
    const key = String(item.cardKey);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function containsCheckpointEvidence(block, checkpoint) {
  const required = checkpointEvidenceCounts(checkpoint);
  if (!required.size) return false;
  const visible = visibleEvidenceCounts(block);
  for (const [key, count] of required.entries()) {
    if ((visible.get(key) || 0) < count) return false;
  }
  return true;
}


function checkpointHasEvidenceCard(checkpoint, expectedCardId) {
  return (checkpoint && checkpoint.evidenceCards || []).some(item =>
    item && String(item.cardKey || '') === expectedCardId
  );
}

function hornetLinkTarget(block) {
  if (!block || block.activationKey !== 'M22') return null;
  for (const target of ['E02', 'E10']) {
    if (hasDetail(block, 'LINK_SUMMON', target)) return target;
  }
  return null;
}

function findHornetLinkContinuationAtTop(blocks, checkpoint) {
  if (!Array.isArray(blocks) || !blocks.length || !checkpoint) return null;
  if (checkpoint.activationKey !== 'M22') return null;
  if (!checkpointHasEvidenceCard(checkpoint, TOKEN_ID)) return null;

  const first = blocks[0];
  if (!first || first.activationKey !== 'M22') return null;

  const linkTarget = hornetLinkTarget(first);
  if (!linkTarget) return null;

  const tokenStillVisible = hasDetail(first, 'SPECIAL_SUMMON', TOKEN_ID);
  return {
    index: 0,
    cardKey: 'M22',
    linkTarget,
    tokenStillVisible,
    matchType: tokenStillVisible
      ? 'HORNET_SAVED_TOKEN_TO_VISIBLE_LINK_EXTENSION'
      : 'HORNET_SAVED_TOKEN_TO_LINK_CONTINUATION_TOKEN_CLIPPED'
  };
}

function hornetLinkTransition(block, checkpoint) {
  if (!block || !checkpoint || checkpoint.activationKey !== 'M22' || block.activationKey !== 'M22') return null;
  if (!containsCheckpointEvidence(block, checkpoint)) return null;
  if (!hasDetail(block, 'SPECIAL_SUMMON', TOKEN_ID) || !hasDetail(block, 'LINK_SUMMON', 'E02')) return null;
  const savedSignature = String(checkpoint.signature || '');
  // If E02 was already part of the saved checkpoint, this is not a new Link node.
  if (savedSignature.includes('E02')) return null;
  return {
    type: 'HORNET_TOKEN_LINK_KAGARI',
    activationKey: 'M22',
    name: '大黄蜂衍生物 → Link 闪刀姬－篝',
    handDelta: 0,
    from: TOKEN_ID,
    to: 'E02',
    evidence: ['SPECIAL_SUMMON:TOKEN_SKY_STRIKER', 'LINK_SUMMON:E02']
  };
}

function findVisibleCheckpointExtensionAtTop(blocks, checkpoint) {
  if (!Array.isArray(blocks) || !blocks.length || !checkpoint) return null;
  const first = blocks[0];
  if (!first || first.activationKey !== checkpoint.activationKey) return null;
  const transition = hornetLinkTransition(first, checkpoint);
  if (!transition) return null;
  return {
    index: 0,
    cardKey: first.activationKey,
    matchType: 'CHECKPOINT_BLOCK_EXTENDED_AT_TOP',
    transition
  };
}


function visibleEvidenceIsCheckpointSubset(block, checkpoint) {
  const visible = visibleEvidenceCounts(block);
  if (!visible.size) return false;
  const saved = checkpointEvidenceCounts(checkpoint);
  if (!saved.size) return false;
  for (const [key, count] of visible.entries()) {
    if ((saved.get(key) || 0) < count) return false;
  }
  return true;
}

function findForwardCheckpointGainHandoff(blocks, checkpoint) {
  if (!Array.isArray(blocks) || !blocks.length || !checkpoint) return null;
  const gainKeys = checkpointGainKeys(checkpoint);
  if (!gainKeys.length) return null;

  // Only the first visible activation may be used as the forward bridge. If a
  // matching card appears later in the viewport, accepting it could hide an
  // unobserved gap before that activation.
  const first = blocks[0];
  const cardKey = first && String(first.activationKey || '');
  if (!cardKey || !gainKeys.includes(cardKey)) return null;

  // Never use the forward hand-gain shortcut when the first visible
  // activation has the same key as the saved checkpoint itself. This is the
  // repeated-search-spell ambiguity (for example M10 -> gain M10 -> activate
  // M10 again): the visible M10 may simply BE the saved checkpoint whose
  // predecessor has scrolled out. Treating it as a fresh activation can turn
  // one real new action (M12) into two apparent new hand operations
  // (M10 + M12). In this same-key case we deliberately fall back to the
  // checkpoint/backtracking path, which can recover the saved predecessor and
  // prove which occurrence is old.
  if (cardKey === String(checkpoint.activationKey || '')) return null;

  const relationship = first.relationship && first.relationship.type;
  const relationshipLooksLikeFollowUp = relationship === 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD' ||
    relationship === 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD' ||
    relationship === 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING';

  // M22 is a special but very strong handoff: if the previous checkpoint just
  // put M22 into hand and the first visible block now shows M22 producing its
  // token, this is necessarily the freshly gained Hornet being activated. The
  // relationship annotator can label the *extended* M22 block as a field
  // follow-up after the token is later used for a Link Summon, so do not let
  // that annotation force a pointless historical scroll.
  const freshHornetActivation = cardKey === 'M22' && hasDetail(first, 'SPECIAL_SUMMON', TOKEN_ID);
  if (relationshipLooksLikeFollowUp && !freshHornetActivation) return null;

  return {
    index: 0,
    cardKey,
    gainKeys,
    matchType: freshHornetActivation
      ? 'FIRST_VISIBLE_HORNET_WAS_CHECKPOINT_HAND_GAIN'
      : 'FIRST_VISIBLE_ACTIVATION_WAS_CHECKPOINT_HAND_GAIN'
  };
}

module.exports = {
  TOKEN_ID,
  checkpointGainKeys,
  containsCheckpointEvidence,
  findHornetLinkContinuationAtTop,
  hornetLinkTransition,
  findVisibleCheckpointExtensionAtTop,
  findForwardCheckpointGainHandoff
};
