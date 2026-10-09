'use strict';
const path = require('path');
const { loadSnapshot, known } = require('../core/snapshot');
const { canStartNewDecision } = require('../core/decision-gate');
const { withStrictReadOnly } = require('./shadow');
const { hashValue } = require('../core/json-store');
async function strategyShadow(root) {
  const ownEngine = path.resolve(__dirname, '../../engine');
  if (path.resolve(root) !== ownEngine) throw new Error('V7_STRATEGY_SHADOW_ONLY_MIGRATED_PURE_DRIVER');
  return withStrictReadOnly(async () => {
    const before = loadSnapshot(root), gate = canStartNewDecision(before, null, null);
    if (gate.status !== 'READY') return { mode: 'STRICT_READ_ONLY_STRATEGY', status: 'UNKNOWN', reason: gate.reason, inputCount: 0, businessWrites: 0 };
    const mature = require('../../engine/runtime/mature-driver');
    const suggestion = mature.buildDecisionSuggestion(before.hand.data);
    const after = loadSnapshot(root);
    if (before.snapshotKey !== after.snapshotKey) throw new Error('V7_SHADOW_BUSINESS_STATE_CHANGED');
    return { mode: 'STRICT_READ_ONLY_STRATEGY', status: 'PROVEN_READ_ONLY', snapshotKey: before.snapshotKey,
      selected: suggestion.selected, strategicDeadlock: suggestion.strategicDeadlock,
      decisionHash: hashValue({ selected: suggestion.selected, deadlock: suggestion.strategicDeadlock }),
      inputCount: 0, businessWrites: 0 };
  });
}
module.exports = { strategyShadow };
