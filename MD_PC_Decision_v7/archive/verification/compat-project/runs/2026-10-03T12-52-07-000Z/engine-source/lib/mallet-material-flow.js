'use strict';

const RESOLUTION_RAW_TYPES = new Set([
  'HAND_GAIN',
  'RETURN_TO_HAND',
  'DRAW',
  'RETURN_TO_DECK',
  'MOVE_TO_DECK',
  'SHUFFLE_INTO_DECK'
]);

function validateMalletActivationStage(log) {
  const newBlocks = log && Array.isArray(log.newOperationBlocks)
    ? log.newOperationBlocks
    : [];
  const malletBlocks = newBlocks.filter((block) => block && block.activationKey === 'M11');
  if (malletBlocks.length !== 1) {
    throw new Error(`MALLET_ACTIVATION_OPERATION_INVALID:${malletBlocks.length}/1`);
  }

  const operation = malletBlocks[0];
  const resolutionRows = (operation.details || []).filter((detail) => {
    if (!detail) return false;
    if (detail.role === 'HAND_GAIN_CANDIDATE') return true;
    return RESOLUTION_RAW_TYPES.has(detail.rawType);
  });
  if (resolutionRows.length !== 0) {
    throw new Error(
      `MALLET_ACTIVATION_CAPTURE_TOO_LATE:${resolutionRows.map((row) => row.rawType).join(',')}`
    );
  }

  return {
    status: 'PASS',
    operation,
    newOperationCount: newBlocks.length
  };
}

function validateMalletFullRescan(beforeCount, handResult) {
  if (!Number.isInteger(beforeCount) || beforeCount < 1) {
    throw new Error(`MALLET_BEFORE_COUNT_INVALID:${beforeCount}`);
  }
  if (!handResult || handResult.status !== 'PASS') {
    throw new Error(`MALLET_FULL_RESCAN_NOT_PASS:${handResult && handResult.status || 'UNKNOWN'}`);
  }
  const afterCount = handResult.handCount;
  const cards = Array.isArray(handResult.cards) ? handResult.cards : [];
  if (!Number.isInteger(afterCount) || afterCount < 0) {
    throw new Error(`MALLET_AFTER_COUNT_INVALID:${afterCount}`);
  }
  const expectedAfter = beforeCount - 1;
  if (afterCount !== expectedAfter) {
    throw new Error(`MALLET_HAND_DELTA_INVALID:${beforeCount}->${afterCount}; expected=${expectedAfter}`);
  }
  if (cards.length !== afterCount) {
    throw new Error(`MALLET_FULL_RESCAN_CARD_COUNT_INVALID:${cards.length}/${afterCount}`);
  }
  const rejected = cards.filter((item) => !item || item.accepted === false || !item.id);
  if (rejected.length !== 0) {
    throw new Error(`MALLET_FULL_RESCAN_UNRECOGNIZED:${rejected.length}`);
  }

  return {
    status: 'PASS',
    beforeCount,
    afterCount,
    delta: afterCount - beforeCount,
    cardIds: cards.map((item) => item.id)
  };
}

module.exports = {
  validateMalletActivationStage,
  validateMalletFullRescan
};
