'use strict';
const path=require('path'); const {audit}=require('./audit'); const {withStrictReadOnly}=require('./shadow');
async function main(){const args=process.argv.slice(2);const root=path.resolve(args.find(a=>!a.startsWith('--'))||process.cwd());if(args.includes('--shadow')){console.log(JSON.stringify(await withStrictReadOnly(async()=>audit(root)),null,2));return;}if(args.includes('--audit')){console.log(JSON.stringify(audit(root),null,2));return;}console.log('MD_PC_Decision_v7: live control is intentionally disabled until V6 ownership entries are VERIFIED. Use --audit, --shadow, or verify-v7.cmd.');}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={main};
