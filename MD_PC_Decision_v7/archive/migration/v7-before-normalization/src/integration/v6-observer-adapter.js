'use strict';
const {readJsonFact}=require('../core/json-store'); const {paths}=require('./v6-layout'); const {adaptV6ObserverResult}=require('../core/observer-contract');
function readContract(root,options={}){const p=paths(root).duelLog;const f=readJsonFact(p);if(f.status!=='KNOWN')return{status:'UNKNOWN',reason:f.reason,path:p};return{status:'KNOWN',path:p,contract:adaptV6ObserverResult(f.data,{duelId:options.duelId||null})};}
module.exports={readContract};
