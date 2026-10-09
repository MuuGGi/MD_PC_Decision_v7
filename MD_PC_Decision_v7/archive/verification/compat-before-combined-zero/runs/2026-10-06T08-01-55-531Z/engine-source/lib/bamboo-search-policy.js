'use strict';

const SEARCH_PRIORITY = Object.freeze([
  Object.freeze({ id: 'M20', name: '真刀竹光' }),
  Object.freeze({ id: 'M14', name: '金黄色的竹光' })
]);

function buildBambooSearchPriority() {
  return SEARCH_PRIORITY.map(item => ({ ...item }));
}

function bambooSearchTargetIds() {
  return SEARCH_PRIORITY.map(item => item.id);
}

function isLegalBambooSearchTarget(id) {
  return SEARCH_PRIORITY.some(item => item.id === String(id || ''));
}

module.exports = {
  buildBambooSearchPriority,
  bambooSearchTargetIds,
  isLegalBambooSearchTarget
};
