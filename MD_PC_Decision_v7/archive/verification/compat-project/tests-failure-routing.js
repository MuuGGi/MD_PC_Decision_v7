'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {classifyFailure}=require('./policy'),{playOne}=require('./session');
async function test(){
  const summary=JSON.parse(fs.readFileSync(path.join(__dirname,'runs/2026-10-03T12-52-07-000Z/summary.json')));
  const real=summary.games.find(g=>g.id===5).error;
  assert.strictEqual(classifyFailure(real),'ARCHIVE_AND_SURRENDER');
  const cases=[
    [new Error('PASSIVE_CURRENT_HAND_COMPONENTS_UNAVAILABLE\n    at captureDesktop (D:/desktop/tools.js:1:1)'),'ARCHIVE_AND_SURRENDER'],
    [new Error('M11_RESOLUTION_TAIL_NOT_READY:return=0;drawLabel=1;drawCount=2/3'),'ARCHIVE_AND_SURRENDER'],
    [new Error('HAND_CLICK_TITLE_2D_UNPROVEN:slot=2'),'ARCHIVE_AND_SURRENDER'],
    [new Error('AUTOTEST_ACTION_FAILED:V6执行停止 FAIL-CLOSED'),'ARCHIVE_AND_SURRENDER'],
    [new Error('UNCLASSIFIED_EXECUTOR_ERROR'),'ARCHIVE_AND_SURRENDER'],
    [new Error('CopyFromScreen failed'),'STOP_TEST'],[new Error('desktop unavailable'),'STOP_TEST'],
    [new Error('DESKTOP_ACCESS_DENIED'),'STOP_TEST'],[new Error('MOUSE_INTERFERENCE'),'STOP_TEST'],
    [new Error('FOREGROUND_LOST'),'STOP_TEST'],[new Error('WINDOW_NOT_FOUND'),'STOP_TEST'],
    [new Error('CLIENT_UNSAFE'),'STOP_TEST'],[new Error('AUTOTEST_GUARD_WRITE_FAILED'),'STOP_TEST'],
    [new Error('GUARD_MUTEX_TIMEOUT'),'STOP_TEST'],[new Error('wrapper',{cause:new Error('USER_STOP')}),'STOP_TEST']
  ];
  for(const [error,expected]of cases)assert.strictEqual(classifyFailure(error),expected);
  assert.strictEqual(classifyFailure(real,true),'STOP_TEST');
  for(const [error,expected]of [[real,'ARCHIVE_AND_SURRENDER'],...cases]){
    const calls=[],game={id:1},store={begin:()=>game,save(){},finish:(_,result)=>calls.push(result)};
    const adapters={stopped:()=>false,start:async()=>{},waitMain1:async()=>{},play:async()=>{throw error;},
      archive:async(_,label)=>calls.push('archive:'+label),observeEnd:async()=>null,
      surrender:async()=>{calls.push('surrender');return {outcome:'SURRENDER',proven:true};},finishBoard:async()=>({gems:0})};
    await playOne(store,adapters);
    assert.strictEqual(calls[0],'archive:before-recovery');
    assert.strictEqual(calls.includes('surrender'),expected!=='STOP_TEST','only ordinary errors authorize cleanup');
    assert.ok(calls.includes(expected==='STOP_TEST'?'INTERRUPTED':'SURRENDER'));
    assert.strictEqual(game.errorSurrender===true, expected!=='STOP_TEST');
  }
  const latest=JSON.parse(fs.readFileSync(path.join(__dirname,'runs/2026-10-04T06-13-06-592Z/summary.json')));
  for(const row of latest.games.filter(g=>[1,2,3,5].includes(g.id)))assert.strictEqual(classifyFailure(row.error),'ARCHIVE_AND_SURRENDER');
  const calls=[],game={id:1},store={begin:()=>game,save(){},finish:(_,result)=>calls.push(result)};
  const adapters={stopped:()=>false,start:async()=>{},waitMain1:async()=>{},archive:async()=>{},
    play:async()=>({outcome:'SURRENDER',proven:true}),finishBoard:async()=>({gems:0})};
  assert.strictEqual((await playOne(store,adapters)).stop,false);
  assert.ok(calls.includes('SURRENDER'),'proven strategic surrender remains an ordinary result');
  // Execute the production console hook without loading or running its bridge.
  const vm=require('vm'),source=fs.readFileSync(path.join(__dirname,'auto-hook.js'),'utf8');
  const context=vm.createContext({console:{error(){}},failed:null,process:{env:{}},fs:{},record(){}});
  vm.runInContext(source.slice(source.indexOf('function check()'),source.indexOf("const readline =")),context);
  context.console.error('M11执行测试停止: Error: HAND_CLICK_TITLE_2D_UNPROVEN:slot=2');
  context.console.error('V6执行停止 FAIL-CLOSED');
  assert.throws(()=>context.check(),/HAND_CLICK_TITLE_2D_UNPROVEN:slot=2/,'first executor cause is not overwritten');
  console.log('FAILURE_ROUTING_OFFLINE_PASS; ordinary errors archived then surrender; safety still INTERRUPTED; strategic surrender preserved; first cause retained; nativeInputs=0; diskWrites=0');
}
if(require.main===module)test().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={test};
