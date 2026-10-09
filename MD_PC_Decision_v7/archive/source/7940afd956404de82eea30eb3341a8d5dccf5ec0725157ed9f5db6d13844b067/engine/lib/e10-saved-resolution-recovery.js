'use strict';
const { cropImage } = require('./png-utils');
const config = require('../live-config');
const { detectHandCountFromImage } = require('./hand-state');
const { buildOperationFanProof } = require('./hand-count-proof');
const { selectSingleHandOperation, inferIncrementalSlots, commitInsertionsAtSlots } = require('./incremental-hand-locator');
const { checkpointFrom } = require('./duel-log-state');
const { extractCompositeRouteEvents, updateCompositeRouteState, summarizeCompositeRouteState } = require('./composite-route-observer');

function prepareSavedE10Resolution({ evidence, scene, scenePath, library }) {
  const { hand: before, log, decision, ledger } = evidence;
  if (ledger.lastHandRevision !== before.revision || decision.v5Branch?.currentState !== 'E10_TARGET_PROMPT' ||
      decision.v5Branch.carrierId !== 'E10' || decision.v5Branch.summonMode !== 'RAYE_DIRECT') {
    throw new Error('E10_RECOVERY_BASELINE_INVALID');
  }
  const selected = selectSingleHandOperation(before.cards, log.newOperationBlocks, {
    runtime: decision, expectedAtomicActivationKey: 'E10'
  });
  if (selected.reason || selected.operation?.activationKey !== 'E10' ||
      selected.normalization !== 'RAYE_ZERO_DIRECT_RENDERED_SUMMON_ROWS') {
    throw new Error('E10_RECOVERY_OPERATION_UNPROVEN');
  }
  const expectedCount = before.handCount + 1;
  const passive = detectHandCountFromImage(cropImage(scene, config.handFan.detectRoi), expectedCount);
  const proof = buildOperationFanProof({ beforeCount: before.handCount,
    operationExpectedCount: expectedCount, passiveDetected: passive, latestBlock: selected.operation });
  if (!proof.exactFanConfirmed) throw new Error('E10_RECOVERY_SAVED_FAN_COUNT_UNPROVEN');
  const inference = inferIncrementalSlots(before.cards, selected.operation, expectedCount, library);
  if (!inference.success || inference.consumed || (inference.costConsumed || []).length ||
      inference.addedCount !== 1 || inference.certainNewCardsBySlot?.length !== 1 ||
      inference.certainNewCardsBySlot[0].card.id !== 'M17' ||
      Number(ledger.outsideDeckCounts.M17 || 0) !== 0 || Number(decision.usedCounts?.M17 || 0) !== 0) {
    throw new Error('E10_RECOVERY_EXACT_DECK_GAIN_UNPROVEN');
  }
  // All three Engages are proven in Deck, so this exact M17 gain cannot be GY
  // recovery. Retain the observed spare Raye and insert only the proven new card.
  const insertedCards = inference.certainNewCardsBySlot.map(row => ({ slot: row.slot,
    card: { id: row.card.id, name: row.card.name, rightLogCertain: true, candidateIds: [row.card.id] } }));
  const finalClicks = insertedCards.map(row => ({ slot: row.slot, id: row.card.id, name: row.card.name,
    source: 'RIGHT_LOG_EXACT_NO_CLICK', physicalClicksIssued: 0 }));
  const after = { version: 2, capturedAt: log.capturedAt, revision: before.revision + 1,
    handCount: expectedCount, cards: commitInsertionsAtSlots(inference.remaining, insertedCards, expectedCount),
    handImagePath: scenePath, lastOperation: { activationKey: 'E10', signature: selected.operation.signature,
      activationOccurrence: (log.operationBlocks || []).filter(b => b.activationKey === 'E10').length },
    lastIncremental: { consumed: null, costConsumed: [], predictedSlots: inference.predictedSlots,
      recognized: insertedCards.map(row => row.card), finalClicks } };
  const incremental = { status: 'PASS', mode: 'SAVED_R3_FIXED_GAIN_PIXEL_VERIFIED', before, after,
    inference: { activationKey: 'E10', consumed: null, costConsumed: [], addedCount: 1,
      predictedSlots: inference.predictedSlots }, insertedCards, finalClicks,
    savedEvidence: { scenePath, sourceLogCapturedAt: log.capturedAt, exactFanConfirmed: true,
      detectedHandCount: passive.componentEstimate.count, targetSource: 'DECK', normalization: selected.normalization,
      gameInputs: 0, handScans: 0, observerReplays: 0 } };
  const events = extractCompositeRouteEvents(log.newOperationBlocks, { beforeHand: before.cards })
    .map(event => ({ ...event, observationId: log.capturedAt }));
  const updated = updateCompositeRouteState(evidence.compositeState, events, log.capturedAt);
  const compositeResult = { status: 'PASS', mode: 'FLOW_STATE_SAVED_RESOLUTION_VERIFIED',
    appliedEvents: updated.applied, events, state: updated.state,
    summary: summarizeCompositeRouteState(updated.state), sourceLogCapturedAt: log.capturedAt };
  return { incremental, proof, compositeResult,
    logState: { ...evidence.logState, capturedAt: log.capturedAt,
      checkpoint: checkpointFrom(log.operationBlocks || log.newOperationBlocks) },
    zeroTargetId: 'M17', zeroTargetSource: 'DECK' };
}
module.exports = { prepareSavedE10Resolution };
