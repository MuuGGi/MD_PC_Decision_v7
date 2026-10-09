'use strict';
const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
function ensureDir(dir){fs.mkdirSync(dir,{recursive:true});}
function stableStringify(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(stableStringify).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableStringify(v[k])).join(',')+'}';}
function hashValue(v){return crypto.createHash('sha256').update(stableStringify(v)).digest('hex');}
function readJsonStrict(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function readJsonFact(file,options={}){try{const st=fs.statSync(file);const data=readJsonStrict(file);const ageMs=Date.now()-st.mtimeMs;if(Number.isFinite(options.maxAgeMs)&&ageMs>options.maxAgeMs)return{status:'UNKNOWN',reason:'STALE',path:file,mtimeMs:st.mtimeMs,ageMs,data:null};return{status:'KNOWN',path:file,mtimeMs:st.mtimeMs,size:st.size,data,hash:hashValue(data)};}catch(e){return{status:'UNKNOWN',reason:e&&e.code==='ENOENT'?'MISSING':'READ_OR_PARSE_FAILED',path:file,error:String(e&&e.message||e),data:null};}}
function atomicWriteJson(file,value){ensureDir(path.dirname(file));const tmp=file+'.tmp.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n','utf8');fs.renameSync(tmp,file);}
function clone(v){return v==null?v:JSON.parse(JSON.stringify(v));}
module.exports={ensureDir,stableStringify,hashValue,readJsonStrict,readJsonFact,atomicWriteJson,clone};
