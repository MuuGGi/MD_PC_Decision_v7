'use strict';
const fs = require('fs'), path = require('path');
const { captureReferenceRoi } = require('../../lib/win-fast');
const { detectLogScrollbarThumb } = require('../../runtime/observer/test-duel-log-live');
const { beginTransaction, completeTransaction } = require('../../lib/atomic-log-transaction');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const ROOT = path.resolve(__dirname, '../..');

async function beginAtomicLogObservation({ bridge, info, baseline, activationKey }) {
  const file = path.join(ROOT, 'debug/duel-log-live/observer_state.json');
  if (!fs.existsSync(file)) return null;
  const logBefore = readJson(file);
  // An empty Main1 baseline has no repeated old operation to disambiguate.
  // Keep the mature first-operation path; never forbid opening Engage merely
  // because there is no prior activation checkpoint yet.
  if (!logBefore?.checkpoint) return null;
  const hand = readJson(path.join(ROOT, 'debug/hand-change-live/session_state.json'));
  if (baseline?.handCount !== hand.handCount ||
      JSON.stringify((baseline?.cards || []).map(c => c.id)) !== JSON.stringify((hand.cards || []).map(c => c.id))) {
    throw new Error('ATOMIC_LOG_TRANSACTION_EXECUTOR_BASELINE_CHANGED');
  }
  const frame = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
  // The prepared scan adapter need not carry a revision. Fingerprint the
  // persisted observer hand that the next observer will actually validate.
  return beginTransaction({ baseline: hand, logBefore,
    bottomThumb: detectLogScrollbarThumb(frame), activationKey });
}
function completeAtomicLogObservation(draft, options, attemptDir) {
  if (!draft) return [];
  const receipt = completeTransaction(draft, options);
  const file = path.join(attemptDir, 'atomic_log_transaction.json');
  writeJsonAtomic(file, receipt, { trailingNewline: true });
  // Do not depend on the full-duel parent's environment: standalone sealed
  // card test entrypoints must use the exact same receipt protocol.
  return ['--expected-atomic-activation=' + receipt.activationKey, '--atomic-log-transaction=' + file];
}
module.exports = { beginAtomicLogObservation, completeAtomicLogObservation };
