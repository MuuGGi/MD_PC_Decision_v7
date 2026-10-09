'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {PNG}=require('pngjs');
const {observerReplay}=require('./test-observer-replay-harness-offline');
const ROOT=path.resolve(__dirname,'../..'), AUTO=path.resolve(ROOT,'..');
const RUN=path.join(AUTO,'runs/2026-10-03T12-52-07-000Z');
const hs=require('../../lib/hand-state');
const legacy=require(path.join(AUTO,'runs/2026-10-03T11-15-45-311Z/engine-source/lib/hand-state'));
const broken=require(path.join(RUN,'engine-source/lib/hand-state'));
const cases=[
  {game:1,rev:6,count:5,gains:['M06'],hand:['EXODIA_UNKNOWN','M06','M12','M14','M20'],oldCount:4},
  {game:2,rev:10,count:5,gains:['M14'],hand:['EXODIA_UNKNOWN','EXODIA_UNKNOWN','M07','M14','M14'],oldCount:2},
  {game:3,rev:13,count:4,gains:['M10','M12'],hand:['M10','M12','M12','M16'],oldCount:3},
  {game:5,rev:1,count:6,gains:['M10'],hand:['M08','M10','M10','M16','M19','M21'],oldCount:5}
];
const bytes=[];
for(const rel of ['../statistics.json','decision-state.json','debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json']){
  const file=path.join(ROOT,rel);if(fs.existsSync(file))bytes.push([file,fs.readFileSync(file)]);
}
function fixture(c, extra={}){
  const archive=path.join(RUN,`game-${String(c.game).padStart(5,'0')}/before-recovery`);
  const passivePath=path.join(archive,`debug/hand-change-live/revision_${c.rev}/passive_hand.png`);
  return {archive,passivePath,handCount:c.count,...extra};
}
function unchanged(h){
  for(const [file,before]of h.before){const now=h.files.get(path.resolve(file));
    assert.ok(before ? before.equals(now) : now==null,'failed transaction changed '+file);}
}
async function test(){
  for(const c of cases){
    const f=fixture(c),image=PNG.sync.read(fs.readFileSync(f.passivePath));
    assert.strictEqual(broken.estimateHandCountByTitleComponents(image).count,c.oldCount);
    assert.strictEqual(legacy.estimateHandCountByTitleComponents(image).count,c.count);
    assert.strictEqual(hs.estimateHandCountByTitleComponents(image).count,c.count);
    const archived=observerReplay({...f,sourceRoot:path.join(RUN,'engine-source')});
    await assert.rejects(archived.run(),/PASSIVE_CURRENT_HAND_COMPONENTS_UNAVAILABLE/);
    unchanged(archived);
    const current=observerReplay(f);await current.run();
    const result=current.json(current.resultPath),before=current.json(current.ledgerPath);
    const originalLedger=JSON.parse(current.before.find(([file])=>file===current.ledgerPath)[1]);
    assert.strictEqual(result.status,'PASS');
    assert.strictEqual(result.after.handCount,c.count);
    assert.deepStrictEqual(Array.from(result.after.cards,x=>x.id),c.hand);
    assert.deepStrictEqual(Array.from(result.insertedCards,x=>x.card.id),c.gains);
    assert.ok(result.finalClicks.every(x=>Number(x.physicalClicksIssued||0)===0));
    assert.strictEqual(before.lastHandRevision,result.after.revision);
    const gainCounts={};for(const id of c.gains)gainCounts[id]=(gainCounts[id]||0)+1;
    for(const [id,count]of Object.entries(gainCounts))assert.strictEqual(
      before.outsideDeckCounts[id],Number(originalLedger.outsideDeckCounts[id]||0)+count,
      'each logged Deck gain must leave the Deck exactly once: '+id);
    current.transaction().commitIncrementalObserverResult({incrementalResult:result,log:current.log(),
      statePath:current.handPath,resultPath:current.resultPath});
    assert.deepStrictEqual(current.json(current.ledgerPath).outsideDeckCounts,before.outsideDeckCounts,'same result must not count deck exits twice');
    const wrongInfo=observerReplay(fixture(c,{handCount:c.count+1}));
    await assert.rejects(wrongInfo.run(),/INFO_HAND_COUNT_OPERATION_MISMATCH|HAND_COUNT|CURRENT_HAND|UNRESOLVED/);
    unchanged(wrongInfo);
    const blank={width:image.width,height:image.height,data:Buffer.alloc(image.data.length)};
    const missingGeometry=observerReplay(fixture(c,{detector:{...hs,detectHandCountFromImage:()=>hs.detectHandCountFromImage(blank,c.count)}}));
    await assert.rejects(missingGeometry.run(),/PASSIVE_CURRENT_HAND_COMPONENTS_UNAVAILABLE/);unchanged(missingGeometry);
    const writeFailure=observerReplay(fixture(c,{failWrite:path.join('hand-change-live','.session_state.json.')}));
    await assert.rejects(writeFailure.run(),/SIMULATED_OBSERVER_WRITE_FAILURE/);unchanged(writeFailure);
    assert.ok(writeFailure.writes.some(p=>p.includes('main-deck-ledger')),'rollback test must get past the real ledger write');
    const unknown=observerReplay(fixture(c,{mutateLog:log=>{
      const gain=log.newOperationBlocks.flatMap(b=>b.details||[]).find(d=>d.rawType==='HAND_GAIN'&&d.side==='SELF');
      gain.card={id:'UNKNOWN',name:'UNKNOWN'};gain.top3=[{id:'M09'},{id:'M16'}];
    }}));
    await assert.rejects(unknown.run(),/UNRESOLVED|ALIGNMENT|LOCATION|PREDICTED|IDENTITY/);unchanged(unknown);
    const stopped=observerReplay(fixture(c,{bridgeError:'AUTOTEST_STOP:MOUSE_INTERFERENCE'}));
    await assert.rejects(stopped.run(),/MOUSE_INTERFERENCE/);unchanged(stopped);
  }
  for(const[file,before]of bytes)assert.ok(before.equals(fs.readFileSync(file)),'disk state changed '+file);
  console.log('PASSIVE_HAND_ACCEPTANCE_OFFLINE_PASS; 4 real failures reproduced by archived full observer; fixed full observer+ledger commit; INFO mismatch/blank/write rollback/human stop; deduplicated gains; nativeInputs=0; diskWrites=0');
}
if(require.main===module)test().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={test};
