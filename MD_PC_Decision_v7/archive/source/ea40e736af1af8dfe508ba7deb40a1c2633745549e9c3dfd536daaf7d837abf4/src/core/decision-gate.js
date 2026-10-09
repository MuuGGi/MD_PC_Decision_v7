'use strict';
const { ready, unknown } = require('./capability');
const { known } = require('./snapshot');
function canStartNewDecision(snapshot, commitCoordinator, activeTransaction, options = {}) {
  if (!snapshot) return unknown('SNAPSHOT_MISSING');
  for (const name of options.requiredSources || ['hand', 'runtime', 'ledger', 'library'])
    if (!known(snapshot[name])) return unknown('REQUIRED_SOURCE_UNKNOWN', { source: name });
  if (!Array.isArray(snapshot.consistency) || snapshot.consistency.length) return unknown('SNAPSHOT_INCONSISTENT', { issues: snapshot.consistency });
  try { if (commitCoordinator && commitCoordinator.hasIncomplete()) return unknown('STATE_COMMIT_INCOMPLETE'); }
  catch (error) { return unknown('STATE_COMMIT_JOURNAL_UNREADABLE', { code: error.code }); }
  if (activeTransaction && activeTransaction.status !== 'COMMITTED') return unknown('TRANSACTION_RECOVERY_REQUIRED', { transactionId: activeTransaction.id });
  return ready('NEW_DECISION_BASELINE_SAFE', { snapshotKey: snapshot.snapshotKey });
}
module.exports = { canStartNewDecision };
