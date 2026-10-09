'use strict';
const {known}=require('./snapshot');
const STATUS=Object.freeze({READY:'READY',BLOCKED:'BLOCKED',UNKNOWN:'UNKNOWN'});
const ready=(reason,evidence={})=>({status:STATUS.READY,reason,evidence});
const blocked=(reason,evidence={})=>({status:STATUS.BLOCKED,reason,evidence});
const unknown=(reason,evidence={})=>({status:STATUS.UNKNOWN,reason,evidence});
function countHand(s,id){return known(s.hand)?(s.hand.data.cards||[]).filter(c=>c&&String(c.id)===id).length:null;}
function totalCount(s,id){if(!known(s.library))return null;const r=(s.library.data.cards||[]).find(c=>c&&String(c.id)===id);const n=Number(r&&(r.count??r.copies));return Number.isFinite(n)?n:null;}
function outsideCount(s,id){if(!known(s.ledger))return null;const raw=s.ledger.data&&s.ledger.data.outsideDeckCounts&&s.ledger.data.outsideDeckCounts[id];if(raw==null)return 0;const n=Number(raw);return Number.isFinite(n)?n:null;}
function deckRemaining(s,id){const t=totalCount(s,id),o=outsideCount(s,id);return t==null||o==null?null:Math.max(0,t-o);}
function deckTotalRemaining(s){if(!known(s.library)||!known(s.ledger))return null;let total=0;for(const row of s.library.data.cards||[]){const id=String(row&&row.id||'');if(!/^M\d+$/.test(id))continue;const n=deckRemaining(s,id);if(n==null)return null;total+=n;}return total;}
function aligned(s){if(!known(s.hand)||!known(s.ledger))return false;const h=Number(s.hand.data.revision),l=Number(s.ledger.data.lastHandRevision);return Number.isFinite(h)&&Number.isFinite(l)&&h===l;}
function goldenDraw2(s,facts={}){
  for(const k of ['hand','ledger','library'])if(!known(s[k]))return unknown('SOURCE_UNKNOWN',{source:k,reason:s[k]&&s[k].reason});
  if(!aligned(s))return unknown('HAND_LEDGER_VERSION_MISMATCH',{handRevision:s.hand.data.revision,ledgerRevision:s.ledger.data.lastHandRevision});
  if(facts.pendingCommit===true)return unknown('STATE_COMMIT_INCOMPLETE');
  if(!facts.bambooEquip||facts.bambooEquip.status!=='PROVEN')return facts.bambooEquip&&facts.bambooEquip.status==='ABSENT'?blocked('BAMBOO_EQUIP_PROVEN_ABSENT'):unknown('BAMBOO_EQUIP_NOT_CURRENTLY_PROVEN');
  const copies=countHand(s,'M14'); if(copies<1)return blocked('GOLDEN_BAMBOO_NOT_IN_CURRENT_HAND');
  const remaining=deckTotalRemaining(s); if(remaining==null)return unknown('DECK_REMAINING_UNKNOWN'); if(remaining<2)return blocked('MAIN_DECK_FEWER_THAN_TWO',{remaining});
  if(facts.uiRole&&facts.uiRole.status==='UNKNOWN')return unknown('CURRENT_UI_ROLE_UNKNOWN');
  return ready('GOLDEN_DRAW2_PROVEN',{copies,remaining,equipEvidence:facts.bambooEquip.evidence||null});
}
function authorizeIrreversible(r){return Boolean(r&&r.status===STATUS.READY);}
function provesDeadlock(r){return Boolean(r&&r.status===STATUS.BLOCKED);}
module.exports={STATUS,ready,blocked,unknown,countHand,deckRemaining,deckTotalRemaining,aligned,goldenDraw2,authorizeIrreversible,provesDeadlock};
