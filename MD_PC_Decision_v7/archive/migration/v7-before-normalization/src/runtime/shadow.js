'use strict';
const fs=require('fs'); const cp=require('child_process'); const {ShadowViolationError}=require('../core/errors');
const FS_SYNC=['writeFileSync','appendFileSync','renameSync','unlinkSync','rmSync','rmdirSync','mkdirSync','copyFileSync','truncateSync','chmodSync','chownSync'];
const FS_ASYNC=['writeFile','appendFile','rename','unlink','rm','rmdir','mkdir','copyFile','truncate','chmod','chown'];
const CP=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
async function withStrictReadOnly(fn){const restores=[];const patch=(obj,k,label)=>{if(typeof obj[k]!=='function')return;const old=obj[k];restores.push(()=>{obj[k]=old;});obj[k]=function(){throw new ShadowViolationError('SHADOW_MUTATION_FORBIDDEN',label,{args:[...arguments].map(String)});};};try{for(const k of FS_SYNC)patch(fs,k,'fs.'+k);for(const k of FS_ASYNC)patch(fs.promises,k,'fs.promises.'+k);for(const k of CP)patch(cp,k,'child_process.'+k);return await fn();}finally{for(let i=restores.length-1;i>=0;i--)restores[i]();}}
module.exports={withStrictReadOnly};
