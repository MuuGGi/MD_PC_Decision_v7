'use strict';

const { buildToonTableSearchPriority } = require('../../lib/toon-table-policy');

module.exports = {
  id: 'M10',
  name: '卡通目录',
  settleAfterSearchMs: 1600,
  searchPriority: buildToonTableSearchPriority()
};
