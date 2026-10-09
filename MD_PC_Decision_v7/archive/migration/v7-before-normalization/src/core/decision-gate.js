'use strict';
const {ready,unknown}=require('./capability');
function canStartNewDecision(snapshot,commitCoordinator,activeTransaction){
  if(snapshot&&Array.isArray(snapshot.consistency)&&snapshot.consistency.length)return unknown('SNAPSHOT_INCONSISTENT',{issues:snapshot.consistency});
  if(commitCoordinator&&commitCoordinator.hasIncomplete())return unknown('STATE_COMMIT_INCOMPLETE');
  if(activeTransaction&&activeTransaction.status!=='COMMITTED')return unknown('TRANSACTION_RECOVERY_REQUIRED',{transactionId:activeTransaction.id,currentStep:activeTransaction.currentStep});
  return ready('NEW_DECISION_BASELINE_SAFE',{snapshotKey:snapshot&&snapshot.snapshotKey||null});
}
module.exports={canStartNewDecision};
