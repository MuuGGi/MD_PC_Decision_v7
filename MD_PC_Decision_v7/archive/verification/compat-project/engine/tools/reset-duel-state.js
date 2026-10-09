'use strict';

const path = require('path');
const { writeJsonAtomic } = require('../lib/runtime-files');
const { resetCompositeRouteSession } = require('../lib/duel-session-reset');
const ROOT = path.resolve(__dirname, '..');
const state = {
  graveSpellCount: 0,
  fieldSpell: null,
  chickenGameDrawUsed: false,
  bambooSwordEquipped: false,
  usedCounts: {},
  // Effect history is reset for the new duel. M19_SEARCH is telemetry only:
  // each newly equipped M19 sent from field to GY may open a fresh search trigger.
  effectUsage: {
    M19_SEARCH: 0
  },
  effectUsageMeta: {},
  notes: 'New duel state reset; M19 search history cleared without a once-per-turn lock.'
};
writeJsonAtomic(
  path.join(ROOT, 'decision-state.json'),
  state,
  { trailingNewline: true }
);
const compositeReset = resetCompositeRouteSession(ROOT);
console.log(`新开局状态已重置；composite当前局文件已清除=${compositeReset.removed.length}。`);
