'use strict';
const {NotReadyError,ContractError}=require('./errors');
function chooseRole(candidates,policy={}){const rows=(candidates||[]).filter(Boolean).filter(c=>policy.roleTest?policy.roleTest(c):true).map((c,i)=>({...c,_i:i,_score:Number.isFinite(Number(c.score))?Number(c.score):0})).filter(c=>!Number.isFinite(Number(policy.minScore))||c._score>=Number(policy.minScore)).sort((a,b)=>b._score-a._score);if(!rows.length)throw new NotReadyError(policy.notReadyCode||'UI_ROLE_NOT_PROVEN');if(rows.length>1&&rows[0]._score-rows[1]._score<Number(policy.minMargin??0.05))throw new ContractError(policy.ambiguousCode||'UI_ROLE_AMBIGUOUS',undefined,{first:rows[0],second:rows[1]});return rows[0];}
function roleFact(fn){try{return{status:'PROVEN',candidate:fn()};}catch(e){if(e instanceof NotReadyError||e instanceof ContractError)return{status:'UNKNOWN',reason:e.code,details:e.details||{}};throw e;}}
module.exports={chooseRole,roleFact};
