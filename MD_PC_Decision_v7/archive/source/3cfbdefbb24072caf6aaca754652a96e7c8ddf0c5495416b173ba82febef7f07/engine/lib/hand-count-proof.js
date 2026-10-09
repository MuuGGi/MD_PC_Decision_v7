'use strict';

function isValidExpectedCandidate(candidate) {
  return Boolean(candidate && candidate.valid);
}

function buildOperationFanProof({ beforeCount, operationExpectedCount, passiveDetected, latestBlock }) {
  const passiveEstimate = passiveDetected && passiveDetected.componentEstimate || null;
  const expectedFanCandidate = Number.isInteger(operationExpectedCount)
    ? (passiveDetected && passiveDetected.candidates || []).find(candidate => candidate.count === operationExpectedCount)
    : null;
  const details = latestBlock && latestBlock.details || [];
  const selfGains = details.filter(detail =>
    detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  ).length;
  const exactFanConfirmed = Boolean(
    Number.isInteger(operationExpectedCount) &&
    isValidExpectedCandidate(expectedFanCandidate) &&
    passiveEstimate && passiveEstimate.count === operationExpectedCount
  );
  const removalOnlyConfirmed = Boolean(
    exactFanConfirmed &&
    Number.isInteger(beforeCount) &&
    operationExpectedCount === beforeCount - 1 &&
    selfGains === 0
  );
  return {
    exactFanConfirmed,
    removalOnlyConfirmed,
    passiveEstimate,
    expectedFanCandidate,
    selfGains
  };
}

function canFallbackFromInfoTimeout(error, proof) {
  const code = String(error && (error.code || error.message) || '');
  return code.includes('INFO_AUTO_HOLD_MAX_TIMEOUT') && Boolean(proof && proof.exactFanConfirmed);
}

module.exports = {
  buildOperationFanProof,
  canFallbackFromInfoTimeout
};
