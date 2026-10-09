'use strict';
const {ContractError}=require('./errors');
function createChain(chainId){return{chainId,links:[],status:'BUILDING'};}
function addLink(chain,link){if(!chain||!chain.chainId)throw new ContractError('CHAIN_ID_REQUIRED');const index=Number(link&&link.index);if(!Number.isInteger(index)||index<1)throw new ContractError('CHAIN_LINK_INDEX_INVALID');if(chain.links.some(x=>x.index===index))throw new ContractError('CHAIN_LINK_DUPLICATE',undefined,{index});chain.links.push({index,actor:link.actor||'UNKNOWN',actionType:link.actionType||null,eventInstanceKey:link.eventInstanceKey||null,status:'PENDING',result:null});chain.links.sort((a,b)=>a.index-b.index);return chain;}
function resolveLink(chain,index,result){const row=chain.links.find(x=>x.index===Number(index));if(!row)throw new ContractError('CHAIN_LINK_NOT_FOUND',undefined,{index});row.status='RESOLVED';row.result=result||{};if(chain.links.every(x=>x.status==='RESOLVED'))chain.status='RESOLVED';return chain;}
module.exports={createChain,addLink,resolveLink};
