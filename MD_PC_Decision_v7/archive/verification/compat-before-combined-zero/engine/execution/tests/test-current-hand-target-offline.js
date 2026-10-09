'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const {createRequire}=require('module'),{PNG}=require('pngjs');
const ROOT=path.resolve(__dirname,'../..'),RUN=path.resolve(ROOT,'../runs/2026-10-03T12-52-07-000Z');
const hs=require('../../lib/hand-state'),config=require('../../live-config'),library=require('../../card-library.json');
const {absoluteComponentEstimate}=require('../../lib/live-hand-geometry');
function segment(file,start,end){const source=fs.readFileSync(file,'utf8'),a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a);return source.slice(a,b);}
const fixtures=[
  {game:1,rev:6,ids:['EXODIA_UNKNOWN','M06','M12','M14','M20'],centers:[407,555,691,828,979]},
  {game:2,rev:10,ids:['EXODIA_UNKNOWN','EXODIA_UNKNOWN','M07','M14','M14'],centers:[407,555,691,828,979]},
  {game:3,rev:13,ids:['M10','M12','M12','M16'],centers:[482,622,753,912]},
  {game:5,rev:1,ids:['M08','M10','M10','M16','M19','M21'],centers:[346,484,616,753,887,1048]}
];
async function test(){
  let checked=0;
  const observer=vm.createContext({getHandLayout:hs.getHandLayout,absoluteComponentEstimate,resolveExposedFanSlots:hs.resolveExposedFanSlots});
  vm.runInContext(segment(path.join(ROOT,'runtime/observer/observe-hand-change-incremental-live.js'),
    'function resolveSlotForPhysicalClick(','async function neutralResetForHandGeometry('),observer);
  for(const f of fixtures){
    const image=PNG.sync.read(fs.readFileSync(path.join(RUN,`game-${String(f.game).padStart(5,'0')}/before-recovery/debug/hand-change-live/revision_${f.rev}/passive_hand.png`)));
    let frame=image, clicks=[],wrong=false, queries=0;
    const cards=f.ids.map((id,i)=>({id,name:id,index:i+1})),baseline={handCount:cards.length,cards};
    const bridge={info:async()=>({}),key:async()=>{},click:async(x,y)=>clicks.push({x,y})};
    function recognize(){queries++;const point=clicks.at(-1),x=point.x-config.handFan.detectRoi.x,y=point.y-config.handFan.detectRoi.y;
      const slot=f.centers.findIndex(cx=>Math.abs(cx-x)<=4);
      assert.ok(slot>=0,'selection must land on the labelled real card');
      assert.ok(y>=30&&y<=110,'click must remain inside the labelled visible card header band');
      return {accepted:true,id:wrong?'WRONG_CARD':f.ids[slot],name:f.ids[slot]};}
    const preloadFile=path.join(ROOT,'execution/core/executor-preload.js'),native=createRequire(preloadFile);
    const low=vm.createContext({ROOT,path,console:{log(){}},normalizeRecognized:x=>x,sameRuntimeCardIdentity:(id,row)=>id===row.id,
      require:id=>{const normalized=id.replace(/\\/g,'/');
        if(normalized.endsWith('lib/win-fast'))return {sleep:async()=>{},mapReferencePoint:(_,p)=>p,captureReferenceRoi:async()=>frame};
        if(normalized.endsWith('observer/scan-state'))return {saveRgbaPng(){},recognizeCurrentCard:async()=>recognize()};
        return native(id);}});
    vm.runInContext(segment(preloadFile,'async function selectExactLowHandOrdinal(','function installExactSlotSelection('),low);
    const atomicFile=path.join(ROOT,'execution/core/atomic-route-executor.js');
    const atomic=vm.createContext({ROOT,path,config,console:{log(){}},require:createRequire(atomicFile),getHandLayout:hs.getHandLayout,
      detectHandCountFromImage:hs.detectHandCountFromImage,resolveExposedFanSlots:hs.resolveExposedFanSlots,
      mapReferencePoint:(_,p)=>p,sleep:async()=>{},captureReferenceRoi:async()=>frame,
      normalizeRecognized:x=>x,recognizeCurrentCard:async()=>recognize()});
    vm.runInContext(segment(atomicFile,'async function selectCurrentObservedHandCard(','function runObserver('),atomic);
    const options={bridge,info:{},library,templates:[],baseline};
    const clickable=hs.detectHandCountFromImage(image,cards.length,{purpose:'CLICK_TARGET'});
    for(let slot=1;slot<=cards.length;slot++){
      assert.strictEqual(observer.resolveSlotForPhysicalClick(cards.length,slot,clickable).measuredTitle2D,true);
      assert.throws(()=>observer.resolveSlotForPhysicalClick(cards.length,slot,hs.detectHandCountFromImage(image,cards.length)),/2D_UNPROVEN/);
    }
    for(let i=0;i<cards.length;i++){
      clicks=[];const selected=await low.selectExactLowHandOrdinal(options,i+1,cards[i].id,cards);
      assert.strictEqual(selected.selected.id,cards[i].id);assert.strictEqual(clicks.length,2);checked++;
      if(cards.findIndex(c=>c.id===cards[i].id)===i){
        clicks=[];const equipped=await atomic.selectCurrentObservedHandCard({...options,expectedId:cards[i].id});
        assert.strictEqual(equipped.selected.id,cards[i].id);assert.strictEqual(clicks.length,2);checked++;
      }
    }
    wrong=true;clicks=[];
    await assert.rejects(low.selectExactLowHandOrdinal(options,1,cards[0].id,cards),/HAND_SELECTION_MISMATCH/);
    assert.strictEqual(clicks.length,2);
    clicks=[];await assert.rejects(atomic.selectCurrentObservedHandCard({...options,expectedId:cards[0].id}),/HAND_SELECTION_MISMATCH/);
    assert.strictEqual(clicks.length,2);
    const priorQueries=queries;
    frame={width:image.width,height:image.height,data:Buffer.alloc(image.data.length)};
    await assert.rejects(low.selectExactLowHandOrdinal(options,1,cards[0].id,cards),/NOT_MEASURED|UNMEASURED|UNAVAILABLE/);
    await assert.rejects(atomic.selectCurrentObservedHandCard({...options,expectedId:cards[0].id}),/NOT_MEASURED/);
    assert.strictEqual(queries,priorQueries,'unproven geometry must never select a card');
  }
  console.log(`CURRENT_HAND_TARGET_OFFLINE_PASS; ${checked} actual production selections on 4 passive failure frames; grey/white/occluded rims; wrong identity stops; blank frame no target click; nativeInputs=0`);
}
if(require.main===module)test().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={test};
