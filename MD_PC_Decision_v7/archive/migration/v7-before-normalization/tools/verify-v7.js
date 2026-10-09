'use strict';
const fs=require('fs'); const path=require('path'); const cp=require('child_process');
const root=path.resolve(__dirname,'..'); const expected='v20.11.1'; const allow=process.argv.includes('--allow-host-version');
if(process.version!==expected&&!allow){console.error(`NODE_RUNTIME_FAIL expected=${expected} actual=${process.version}`);process.exit(2);}console.log(`NODE_RUNTIME ${process.version===expected?'PASS':'HOST_ONLY'} expected=${expected} actual=${process.version}`);
const files=[];(function walk(d){for(const n of fs.readdirSync(d)){const p=path.join(d,n),s=fs.statSync(p);if(s.isDirectory())walk(p);else if(p.endsWith('.js'))files.push(p);}})(root);
for(const f of files){const r=cp.spawnSync(process.execPath,['--check',f],{encoding:'utf8'});if(r.status!==0){console.error(r.stderr||r.stdout);process.exit(r.status||1);}}console.log(`JS_SYNTAX PASS (${files.length} files)`);
const t=cp.spawnSync(process.execPath,[path.join(root,'test','run.js')],{stdio:'inherit'});if(t.status!==0)process.exit(t.status||1);console.log('V7_OFFLINE_VERIFY PASS');
