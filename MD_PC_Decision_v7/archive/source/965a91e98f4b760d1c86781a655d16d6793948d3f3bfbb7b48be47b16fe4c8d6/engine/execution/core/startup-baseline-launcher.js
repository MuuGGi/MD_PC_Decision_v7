'use strict';
const {spawnSync}=require('child_process');
const readline=require('readline/promises');
async function main() {
  const [script,...args]=process.argv.slice(2);
  if(!script)throw new Error('STARTUP_SCRIPT_REQUIRED');
  const env={...process.env};
  delete env.MD_STARTUP_MALLET;
  if(!args.some(a=>a.startsWith('--resume'))) {
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try {
      let answer;
      do {
        answer=(await rl.question('开局前最后是否用了已结算的万宝槌？[y=是，只记最后抽卡 / n=否，普通基线]：')).trim().toLowerCase();
      } while(!['y','n'].includes(answer));
      env.MD_STARTUP_MALLET=answer==='y'?'1':'0';
    } finally {rl.close();}
  }
  const child=spawnSync(process.execPath,[script,...args],{stdio:'inherit',env,windowsHide:true});
  if(child.error)throw child.error;
  process.exitCode=Number.isInteger(child.status)?child.status:1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
