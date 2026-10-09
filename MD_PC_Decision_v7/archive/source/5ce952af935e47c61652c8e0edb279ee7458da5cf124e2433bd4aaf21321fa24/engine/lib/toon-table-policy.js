'use strict';

const SEARCH_PRIORITY = Object.freeze([
  Object.freeze({ id: 'M10', name: '卡通目录' }),
  Object.freeze({ id: 'M07', name: '青眼卡通龙' })
]);

function buildToonTableSearchPriority() {
  return SEARCH_PRIORITY.map(item => ({ ...item }));
}

function chooseToonTableTarget(deckRemaining = {}) {
  if (Number(deckRemaining.M10 || 0) > 0) {
    return {
      id: 'M10',
      name: '卡通目录',
      reason: '牌组仍有卡通目录，继续目录链'
    };
  }

  if (Number(deckRemaining.M07 || 0) > 0) {
    return {
      id: 'M07',
      name: '青眼卡通龙',
      reason: '牌组已无下一张目录，最后检索青眼卡通龙'
    };
  }

  return null;
}

module.exports = {
  buildToonTableSearchPriority,
  chooseToonTableTarget
};
