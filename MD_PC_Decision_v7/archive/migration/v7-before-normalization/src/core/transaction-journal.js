'use strict';
const path=require('path'); const fs=require('fs'); const {ensureDir,readJsonFact,atomicWriteJson}=require('./json-store');
function journalDir(root){return path.join(root,'debug','v7','transactions');}
function activePath(root,id){return path.join(journalDir(root),'active',id+'.json');}
function archivePath(root,id){return path.join(journalDir(root),'archive',id+'.json');}
function createJournal(root){return{
  load(id){const f=readJsonFact(activePath(root,id));return f.status==='KNOWN'?f.data:null;},
  save(tx){atomicWriteJson(activePath(root,tx.id),tx);return tx;},
  archive(tx){const src=activePath(root,tx.id),dst=archivePath(root,tx.id);ensureDir(path.dirname(dst));atomicWriteJson(dst,tx);try{fs.rmSync(src,{force:true});}catch(_){}},
  nextSequence(duelId){const dir=path.join(journalDir(root),'archive');ensureDir(dir);let max=0;for(const f of fs.readdirSync(dir)){if(!f.startsWith(duelId+'-T'))continue;const m=f.match(/-T(\d+)/);if(m)max=Math.max(max,Number(m[1]));}const ad=path.join(journalDir(root),'active');ensureDir(ad);for(const f of fs.readdirSync(ad)){if(!f.startsWith(duelId+'-T'))continue;const m=f.match(/-T(\d+)/);if(m)max=Math.max(max,Number(m[1]));}return max+1;},
  findActiveByInstanceKey(instanceKey){const dir=path.join(journalDir(root),'active');ensureDir(dir);for(const f of fs.readdirSync(dir)){const fact=readJsonFact(path.join(dir,f));if(fact.status==='KNOWN'&&fact.data.instanceKey===instanceKey)return fact.data;}return null;}
};}
module.exports={createJournal};
