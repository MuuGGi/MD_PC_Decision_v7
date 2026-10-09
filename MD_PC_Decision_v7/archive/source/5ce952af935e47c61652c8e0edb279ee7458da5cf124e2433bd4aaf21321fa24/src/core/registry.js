'use strict';
const {ContractError}=require('./errors'); const {assertProductionReady}=require('./ownership');
class ProductionRegistry{constructor(manifest){this.manifest=manifest;this.map=new Map();}register(key,handler){if(typeof handler!=='function')throw new ContractError('REGISTRY_HANDLER_REQUIRED');const entry=(this.manifest.entries||[]).find(e=>e.capability===key);assertProductionReady(entry);if(this.map.has(key))throw new ContractError('REGISTRY_DUPLICATE',undefined,{key});this.map.set(key,{handler,entry});}async dispatch(key,context,payload){const row=this.map.get(key);if(!row)throw new ContractError('REGISTRY_CAPABILITY_UNBOUND',undefined,{key});return row.handler(context,payload,row.entry);}list(){return[...this.map.keys()];}}
class AuditRegistry{constructor(manifest){this.manifest=manifest;}list(){return(this.manifest.entries||[]).map(e=>({capability:e.capability,status:e.status,owner:e.owner,path:e.path}));}}
module.exports={ProductionRegistry,AuditRegistry};
