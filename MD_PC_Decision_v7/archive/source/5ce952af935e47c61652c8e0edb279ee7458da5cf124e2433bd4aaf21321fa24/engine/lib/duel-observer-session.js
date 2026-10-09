'use strict';

const { normalizeExodiaComponentCard } = require('./exodia-policy');

function cleanCard(card) {
  if (!card) return null;
  return normalizeExodiaComponentCard({
    id: card.id || null,
    name: card.name || null,
    index: Number.isInteger(card.index) ? card.index : undefined
  });
}

function cleanCards(cards) {
  return (cards || []).map(cleanCard).filter(Boolean);
}

function summarizeOperation(block) {
  if (!block) return null;
  const activation = block.activation && block.activation.card;
  return {
    activationKey: block.activationKey || activation && activation.id || null,
    name: activation && activation.name || null,
    signature: block.signature || null,
    details: (block.details || []).map(detail => ({
      rawType: detail.rawType || null,
      role: detail.role || null,
      side: detail.side || null,
      card: cleanCard(detail.card)
    }))
  };
}

function summarizeOperations(log) {
  return (log && (log.newOperationBlocks || log.newActivationBlocks) || [])
    .map(summarizeOperation)
    .filter(Boolean);
}

function createInitialSession(scan, metrics = {}) {
  const cards = cleanCards(scan && scan.cards);
  return {
    version: 1,
    status: 'ACTIVE',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step: 0,
    handCount: Number(scan && scan.handCount),
    cards,
    history: [],
    initialRecognitionTimings: cards.map((card, index) => ({
      slot: index + 1,
      id: card.id,
      name: card.name,
      ...(scan.cards[index] && scan.cards[index].timingMs ? scan.cards[index].timingMs : {})
    })),
    initialMetrics: metrics
  };
}


function cleanLogicalNode(node) {
  if (!node) return null;
  return {
    type: node.type || null,
    activationKey: node.activationKey || null,
    name: node.name || null,
    handDelta: Number(node.handDelta || 0),
    from: node.from || null,
    to: node.to || null,
    gainedCard: cleanCard(node.gainedCard),
    evidence: Array.isArray(node.evidence) ? node.evidence.slice() : []
  };
}

function buildObservationStep(session, log, incremental, metrics = {}) {
  const before = incremental && incremental.before || null;
  const after = incremental && incremental.after || before || null;
  const inserted = (incremental && incremental.insertedCards || []).map(item => ({
    slot: item.slot,
    card: cleanCard(item.card)
  }));
  const removed = [];
  const inference = incremental && incremental.inference || {};
  if (inference.consumed) removed.push(cleanCard(inference.consumed));
  for (const item of inference.costConsumed || []) removed.push(cleanCard(item));

  const nextStep = Number(session && session.step || 0) + 1;
  return {
    step: nextStep,
    observedAt: new Date().toISOString(),
    mode: incremental && incremental.mode || 'HAND_INCREMENTAL',
    reason: incremental && incremental.reason || null,
    operations: summarizeOperations(log),
    logicalNodes: (incremental && incremental.logicalNodes || []).map(cleanLogicalNode).filter(Boolean),
    handBefore: before ? {
      handCount: before.handCount,
      cards: cleanCards(before.cards)
    } : null,
    handAfter: after ? {
      handCount: after.handCount,
      cards: cleanCards(after.cards)
    } : null,
    removedCards: removed.filter(Boolean),
    insertedCards: inserted,
    recognitionTimings: incremental && incremental.recognitionTimings || [],
    metrics
  };
}

function applyObservationStep(session, step) {
  const next = {
    ...session,
    updatedAt: new Date().toISOString(),
    step: step.step,
    history: [...(session.history || []), step]
  };
  if (step.handAfter) {
    next.handCount = step.handAfter.handCount;
    next.cards = cleanCards(step.handAfter.cards);
  }
  return next;
}

function flattenStageMetrics(metrics) {
  const rows = [];
  for (const [group, result] of Object.entries(metrics || {})) {
    if (!result) continue;
    if (Number.isFinite(result.totalMs)) {
      rows.push({ group, name: 'TOTAL', ms: Number(result.totalMs) });
    }
    for (const stage of result.stages || []) {
      if (Number.isFinite(stage.ms)) rows.push({ group, name: stage.name, ms: Number(stage.ms) });
    }
  }
  return rows.sort((a, b) => b.ms - a.ms);
}

module.exports = {
  cleanCard,
  cleanCards,
  summarizeOperation,
  summarizeOperations,
  cleanLogicalNode,
  createInitialSession,
  buildObservationStep,
  applyObservationStep,
  flattenStageMetrics
};
