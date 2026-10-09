'use strict';
const path=require('path'); const {audit}=require('./audit'); const {withStrictReadOnly}=require('./shadow');
async function main(){
  const args=process.argv.slice(2);
  const root=path.resolve(args.find(a=>!a.startsWith('--'))||path.join(__dirname,'../../engine'));
  if(args.includes('--shadow')){console.log(JSON.stringify(await withStrictReadOnly(async()=>audit(root)),null,2));return;}
  if(args.includes('--strategy-shadow')){console.log(JSON.stringify(await require('./strategy-shadow').strategyShadow(root),null,2));return;}
  if(args.includes('--audit')){console.log(JSON.stringify(audit(root),null,2));return;}
  console.log('V7 live entry: run-v7-autotest.cmd --max-games=5. --audit/--shadow are read-only; --strategy-shadow uses migrated pure strategy.');
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={main};
