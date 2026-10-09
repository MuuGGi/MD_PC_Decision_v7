'use strict';
const fs=require('fs'); const {OwnershipError}=require('./errors');
function loadOwnership(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function findEntry(manifest,capability){return(manifest.entries||[]).find(e=>e.capability===capability)||null;}
function assertProductionReady(entry){if(!entry)throw new OwnershipError('OWNERSHIP_ENTRY_MISSING');if(entry.status!=='VERIFIED')throw new OwnershipError('OWNERSHIP_NOT_VERIFIED',undefined,{capability:entry.capability,status:entry.status});for(const k of ['irreversibleInput','verification','recovery'])if(!entry[k])throw new OwnershipError('OWNERSHIP_FIELD_MISSING',undefined,{capability:entry.capability,field:k});if(!Array.isArray(entry.stateWrites))throw new OwnershipError('OWNERSHIP_STATE_WRITES_MISSING');if(!['LEGACY','V7'].includes(entry.owner))throw new OwnershipError('OWNERSHIP_OWNER_INVALID',undefined,{owner:entry.owner});return true;}
module.exports={loadOwnership,findEntry,assertProductionReady};
