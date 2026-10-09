'use strict';
const path=require('path'); const {readJsonFact,hashValue}=require('./json-store');
function known(f){return Boolean(f&&f.status==='KNOWN');}
function read(root,rel,opts){return readJsonFact(path.join(root,rel),opts);}
function loadSnapshot(root,options={}){
  const common=options.maxAgeMs?{maxAgeMs:options.maxAgeMs}:{};
  const s={root,capturedAt:new Date().toISOString(),
    hand:read(root,'debug/hand-change-live/session_state.json',common),
    runtime:read(root,'decision-state.json',common),
    ledger:read(root,'debug/main-deck-ledger/state.json',common),
    log:read(root,'debug/duel-log-live/latest_result.json',common),
    observerState:read(root,'debug/duel-log-live/observer_state.json',common),
    library:read(root,'card-library.json',{}),
    victory:read(root,'debug/duel-settlement/latest_result.json',common)};
  s.consistency=[];
  if(known(s.hand)&&known(s.ledger)){const h=Number(s.hand.data.revision),l=Number(s.ledger.data.lastHandRevision);if(Number.isFinite(h)&&Number.isFinite(l)&&h!==l)s.consistency.push({code:'HAND_LEDGER_REVISION_MISMATCH',handRevision:h,ledgerRevision:l});}
  s.snapshotKey=hashValue(Object.fromEntries(['hand','runtime','ledger','log','observerState','library','victory'].map(k=>[k,known(s[k])?s[k].hash:'UNKNOWN:'+s[k].reason])));
  return s;
}
function deriveDuelIdentity(s){
  if(known(s.ledger)){const d=s.ledger.data||{};if(d.openingBaselineCapturedAt)return{status:'KNOWN',source:'LEDGER_OPENING_BASELINE',value:'DUEL-'+hashValue({at:d.openingBaselineCapturedAt,openingHand:d.openingHand||null}).slice(0,24)};}
  if(known(s.hand)&&Number(s.hand.data&&s.hand.data.revision)===0&&s.hand.data.capturedAt)return{status:'KNOWN',source:'HAND_REVISION_ZERO',value:'DUEL-'+hashValue({at:s.hand.data.capturedAt,cards:(s.hand.data.cards||[]).map(c=>c&&c.id)}).slice(0,24)};
  return{status:'UNKNOWN',reason:'NO_STABLE_DUEL_BASELINE'};
}
function buildActionBaseline(s,extra={}){
  return{snapshotKey:s.snapshotKey,hand:known(s.hand)?{revision:s.hand.data.revision,cards:(s.hand.data.cards||[]).map(c=>c&&c.id)}:{unknown:true},
    observer:known(s.observerState)?{checkpoint:s.observerState.data.checkpoint||null,tailBlocks:s.observerState.data.tailBlocks||null}:{unknown:true},
    log:known(s.log)?{continuity:s.log.data.continuity||null,anchor:s.log.data.matchedContinuityAnchor||null}:{unknown:true},
    runtime:known(s.runtime)?{fieldSpell:s.runtime.data.fieldSpell||null,normalSummonUsed:s.runtime.data.normalSummonUsed===true,bambooSwordEquipped:s.runtime.data.bambooSwordEquipped===true,usedCounts:s.runtime.data.usedCounts||{}}:{unknown:true},extra};
}
module.exports={known,loadSnapshot,deriveDuelIdentity,buildActionBaseline};
