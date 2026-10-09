'use strict';

function normalizeRecognized(result) {
  const judged = result && result.judged;
  const best = judged && judged.best;
  return {
    accepted: Boolean(judged && judged.accepted && best),
    id: best ? best.id : 'UNKNOWN',
    name: best ? best.name : 'UNKNOWN',
    mad: best && best.mad != null ? best.mad : null,
    margin: judged && judged.margin != null ? judged.margin : null
  };
}

module.exports = {
  normalizeRecognized
};
