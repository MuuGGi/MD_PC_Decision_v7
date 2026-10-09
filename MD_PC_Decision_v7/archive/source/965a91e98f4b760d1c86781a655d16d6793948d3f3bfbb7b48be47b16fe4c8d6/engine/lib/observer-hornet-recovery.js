'use strict';

const TOKEN_IDS = new Set(['TOKEN_SKY_STRIKER', '闪刀姬衍生物']);

function cardKey(card) {
  return String(card && (card.id || card.name) || '');
}

function detailCardKey(detail) {
  return cardKey(detail && detail.card);
}

function hasDetail(block, rawType, acceptedIds) {
  return (block && block.details || []).some(detail =>
    detail && detail.rawType === rawType && acceptedIds.has(detailCardKey(detail))
  );
}

function findHornetTokenBlock(log) {
  const blocks = log && (log.operationBlocks || log.activationBlocks) || [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!block || block.activationKey !== 'M22') continue;
    if (hasDetail(block, 'SPECIAL_SUMMON', TOKEN_IDS)) {
      return { block, index, blocks };
    }
  }
  return null;
}

function findFollowingKagariRecovery(blocks, hornetIndex) {
  for (let index = hornetIndex + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block || block.activationKey !== 'E02') continue;
    const gain = (block.details || []).find(detail =>
      detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
    );
    if (gain) return { block, index, gain };
  }
  return null;
}

function removeOneCard(cards, id) {
  const input = Array.isArray(cards) ? cards : [];
  const index = input.findIndex(card => card && card.id === id);
  if (index < 0) return null;
  const removed = input[index];
  const remaining = input.filter((_, i) => i !== index).map((card, i) => ({
    ...card,
    index: i + 1
  }));
  return { removed, remaining };
}

function buildShortHornetCheckpoint(hornetBlock) {
  const tokenDetail = (hornetBlock.details || []).find(detail =>
    detail && detail.rawType === 'SPECIAL_SUMMON' && TOKEN_IDS.has(detailCardKey(detail))
  );
  if (!tokenDetail) throw new Error('HORNET_TOKEN_EVIDENCE_MISSING');
  const tokenKey = detailCardKey(tokenDetail);
  return {
    activationKey: 'M22',
    signature: `M22|SPECIAL_SUMMON:${tokenKey}`,
    signatureOccurrence: 1,
    activationOccurrence: 1,
    // Intentionally null. In the real previous observer step M22 itself was
    // the endpoint. The older Engage block may already be clipped out of the
    // current bottom viewport, and the concrete TOKEN evidence is enough to
    // identify this saved M22 activation without forcing historical scroll.
    previousActivationKey: null,
    evidenceCards: [{
      kind: 'PROCESSING_CARD',
      cardKey: tokenKey,
      cardName: tokenDetail.card && (tokenDetail.card.name || tokenDetail.card.id) || tokenKey
    }]
  };
}

function buildHornetPreviousAdoption({ session, handState, log, observerState, capturedAt }) {
  if (!session || session.status !== 'ACTIVE') {
    throw new Error('HORNET_ADOPT_ACTIVE_SESSION_REQUIRED');
  }
  if (!handState || !Array.isArray(handState.cards)) {
    throw new Error('HORNET_ADOPT_HAND_STATE_REQUIRED');
  }
  const hornet = findHornetTokenBlock(log);
  if (!hornet) throw new Error('HORNET_ADOPT_M22_TOKEN_BLOCK_NOT_FOUND_IN_LATEST_LOG');
  const kagari = findFollowingKagariRecovery(hornet.blocks, hornet.index);
  if (!kagari) throw new Error('HORNET_ADOPT_FOLLOWING_KAGARI_RECOVERY_NOT_FOUND');

  const sessionRemoval = removeOneCard(session.cards, 'M22');
  const handRemoval = removeOneCard(handState.cards, 'M22');
  if (!sessionRemoval || !handRemoval) {
    throw new Error('HORNET_ADOPT_M22_NOT_PRESENT_IN_STALE_HAND_BASELINE');
  }

  const now = capturedAt || new Date().toISOString();
  const previousStep = Number(session.step || 0) + 1;
  const checkpoint = buildShortHornetCheckpoint(hornet.block);
  const syntheticStep = {
    step: previousStep,
    observedAt: now,
    mode: 'RECOVERED_PREVIOUS_NODE',
    reason: 'ADOPT_ALREADY_COMPLETED_HORNET_ACTIVATION',
    operations: [{
      activationKey: 'M22',
      name: '闪刀机－大黄蜂无人机',
      signature: checkpoint.signature,
      details: [{
        rawType: 'SPECIAL_SUMMON',
        role: 'SUMMON_RESULT',
        side: 'SELF',
        card: { id: checkpoint.evidenceCards[0].cardKey, name: checkpoint.evidenceCards[0].cardName }
      }]
    }],
    logicalNodes: [{
      type: 'HORNET_ACTIVATION_TOKEN',
      activationKey: 'M22',
      name: '闪刀机－大黄蜂无人机发动 → 特殊召唤衍生物',
      handDelta: -1,
      evidence: [`SPECIAL_SUMMON:${checkpoint.evidenceCards[0].cardKey}`]
    }],
    handBefore: {
      handCount: Number(session.handCount),
      cards: session.cards
    },
    handAfter: {
      handCount: sessionRemoval.remaining.length,
      cards: sessionRemoval.remaining
    },
    removedCards: [sessionRemoval.removed],
    insertedCards: [],
    recognitionTimings: [],
    metrics: { recovery: { totalMs: 0, stages: [] } }
  };

  const nextSession = {
    ...session,
    updatedAt: now,
    step: previousStep,
    handCount: sessionRemoval.remaining.length,
    cards: sessionRemoval.remaining,
    history: [...(session.history || []), syntheticStep],
    recoveries: [
      ...(session.recoveries || []),
      {
        recoveredAt: now,
        type: 'ADOPT_ALREADY_COMPLETED_HORNET_ACTIVATION',
        checkpoint
      }
    ]
  };

  const nextHandState = {
    ...handState,
    capturedAt: now,
    revision: Number(handState.revision || 0) + 1,
    handCount: handRemoval.remaining.length,
    cards: handRemoval.remaining,
    lastOperation: {
      activationKey: 'M22',
      signature: checkpoint.signature,
      activationOccurrence: 1
    },
    lastIncremental: {
      consumed: handRemoval.removed,
      costConsumed: [],
      predictedSlots: [],
      recognized: [],
      finalClicks: []
    }
  };

  const nextObserverState = {
    ...(observerState || {}),
    version: 1,
    capturedAt: now,
    checkpoint
  };

  return {
    nextSession,
    nextHandState,
    nextObserverState,
    syntheticStep,
    hornetBlock: hornet.block,
    kagariBlock: kagari.block,
    checkpoint
  };
}

module.exports = {
  buildShortHornetCheckpoint,
  buildHornetPreviousAdoption
};
