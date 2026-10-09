'use strict';
const fs=require('fs'); const path=require('path'); const {paths}=require('./v6-layout');
function grep(text,re){return(text.match(re)||[]).length;}
function inspectFile(file){if(!fs.existsSync(file))return{exists:false,path:file};const t=fs.readFileSync(file,'utf8');return{exists:true,path:file,lines:t.split(/\r?\n/).length,signals:{writeJsonAtomic:grep(t,/writeJsonAtomic\s*\(/g),writeFileSync:grep(t,/writeFileSync\s*\(/g),spawnSync:grep(t,/spawnSync\s*\(/g),bridgeClick:grep(t,/bridge\.click\s*\(/g),ledgerCommit:grep(t,/commitKnown|persistLedger|applyLogOnlyToMainDeckLedger/g)}};}
function audit(root){const p=paths(root);return{main:inspectFile(p.main),atomic:inspectFile(p.atomic),composite:inspectFile(p.composite),ledger:inspectFile(p.ledger)};}
module.exports={audit};
