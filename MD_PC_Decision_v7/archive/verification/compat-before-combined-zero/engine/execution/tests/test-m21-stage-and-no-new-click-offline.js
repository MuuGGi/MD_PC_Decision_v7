'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(ROOT,rel),'utf8');
const quiet = { log() {}, error() {} };
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = require('../../material/issues/issue-107-hand-before.json');
const decision = require('../../material/issues/issue-107-decision-before.json');
const weakLog = require('../../material/issues/issue-107-m09-log.json');
const library = require('../../card-library.json');
const policy = require('../../lib/incremental-observer-policy');
const { mainDeckCandidates, inferPersistentExodiaAtSlot } = require('../../lib/incremental-hand-locator');
const exodiaPolicy = require('../../lib/exodia-policy');
const files = ['decision-state.json','debug/hand-change-live/session_state.json',
 'debug/main-deck-ledger/state.json','debug/duel-log-live/latest_result.json',
 'debug/duel-log-live/observer_state.json','debug/hand-change-live/latest_incremental_result.json',
 'debug/execution/M21_chicken_game/pending_field_activation.json','material/verified/verified-cards.json'];
const bytes = new Map(files.filter(p=>fs.existsSync(path.join(ROOT,p))).map(p=>[p,fs.readFileSync(path.join(ROOT,p))]));
function load(rel, mocks = {}) {
 const filename = path.join(ROOT,rel), module = { exports:{} }, nativeRequire = createRequire(filename);
 const context = vm.createContext({ module, exports:module.exports, __filename:filename,
   __dirname:path.dirname(filename), process, Buffer, console:quiet,
   require: id => Object.hasOwn(mocks,id) ? mocks[id] : nativeRequire(id) });
 vm.runInContext(read(rel),context,{filename});
 return module.exports;
}
function segment(source,start,end) {
 const a=source.indexOf(start),b=source.indexOf(end,a);
 assert.ok(a>=0 && b>a,start);return source.slice(a,b);
}

(async () => {
 // The real weak thumbnail was a wrong head with Chicken Game as Top2.
 // Exact limb identity is intentionally irrelevant: retain one sealed-component
 // class token and continue with no card click.
 const weak = weakLog.newOperationBlocks[0].details[0];
 assert.deepStrictEqual(mainDeckCandidates(weak).map(c=>c.id),['M05','M21','M04']);
 const observer = read('runtime/observer/observe-hand-change-incremental-live.js');
 const insertionCode = segment(observer,'    const clickStageStarted =','    timer.stages.push({');
 let clicks=0;
 const insertionContext = vm.createContext({ process, Map, console:quiet,
   assertNoNewHandClicks:policy.assertNoNewHandClicks,
   inference:{ addedCount:1,predictedSlots:[1],remaining:fixture.cards.slice(1),
   candidateRows:[mainDeckCandidates(weak)],certainNewCardsBySlot:[{slot:1,card:null}] },
   PERSISTENT_EXODIA_IDS:new Set(['M01','M02','M03','M04','M05']), library, templates:[],
   EXODIA_UNKNOWN_ID:exodiaPolicy.EXODIA_UNKNOWN_ID,
   normalizeExodiaComponentCard:exodiaPolicy.normalizeExodiaComponentCard,
   inferPersistentExodiaAtSlot, strongCertainInsertion:()=>null,
   info:{}, observedHandCount:6,
   bridge:{info:async()=>({}),click:async()=>{clicks++;},key:async()=>{}},
   validateClient(){},mapReferencePoint:(_info,p)=>p,sleep:async()=>{},
   locateSlotWithoutHandClick:async()=>({x:662,titleY:1011,source:'TITLE_COMPONENTS'}),
   recognizeCurrentCard:async()=>({judged:{accepted:true,best:{id:'M03',name:'被封印的右腕'}}}),
   config:{mouseSettleMs:0,handFan:{slotResetSettleMs:0}} });
 await vm.runInContext('(async()=>{'+insertionCode+'})()',insertionContext);
 assert.strictEqual(clicks,0);
 assert.throws(()=>policy.assertNoNewHandClicks([2,9]),/NO_CLICK:2,9/);
 const dense = segment(observer,'const clickSlots = denseInference.predictedSlots','if (clickSlots.length)');
 assert.ok(dense.includes('assertNoNewHandClicks(clickSlots)'),'dense path also stops before targeted scan');

 // Bounded passive rereads restore the ORIGINAL checkpoint for every attempt.
 const shared = read('runtime/observer/run-live-incremental.js');
 const retry = segment(shared,'      for (let attempt = 1; ; attempt++) {','      if (!fs.existsSync(incrementalResultPath))');
 let attempts=0,rereads=0,restores=0;
 const retryContext={runIncrementalHandChange:async()=>{if(++attempts<3)policy.assertNoNewHandClicks([1]);},
   bridge:{},verbose:false,prefetchedFastOwnInfo:null,console:quiet,
   restoreBuffer:p=>{if(p==='original')restores++;},observerStatePath:'original',observerStateBefore:'bytes',
   compositeRouteStatePath:'composite-state',compositeRouteStateBefore:'state-bytes',
   compositeRouteResultPath:'composite-result',compositeRouteResultBefore:'result-bytes',
   sleep:async()=>{},observeCurrentLog:async()=>{rereads++;}};
 await vm.runInNewContext('(async()=>{'+retry+'})()',retryContext);
 assert.deepStrictEqual([attempts,rereads,restores],[3,2,2]);
 attempts=rereads=restores=0;
 retryContext.runIncrementalHandChange=async()=>{attempts++;policy.assertNoNewHandClicks([1]);};
 await assert.rejects(vm.runInNewContext('(async()=>{'+retry+'})()',retryContext),/NO_CLICK/);
 assert.deepStrictEqual([attempts,rereads,restores],[3,2,2]);

 // The actual stored frame reads the correct arm and an undrawn M21 placement.
 const { readPng }=require('../../lib/png-utils');
 const { loadLibrary,loadTemplates }=require('../../lib/recognizer');
 const { loadDuelLogLabelTemplates }=require('../../lib/duel-log-label-reader');
 const { loadFieldRowTemplates }=require('../../lib/duel-log-field-rows');
 const { recognizeDuelLogScreenshot }=require('../../runtime/observer/test-duel-log-live');
 const { buildActivationBlocks,annotateBlockRelationships,reconcileExpectedAtomicBottom }=require('../../lib/duel-log-state');
 const loaded=await loadTemplates(ROOT,loadLibrary(ROOT));
 const screenshot=await readPng(path.join(ROOT,'material/issues/issue-107-m21-placement.png'));
 const recognized=recognizeDuelLogScreenshot(screenshot,{cardTemplates:loaded.map(t=>({...t.card,image:t.image})),
   labelTemplates:await loadDuelLogLabelTemplates(ROOT),fieldRowTemplates:await loadFieldRowTemplates(ROOT)}, {skipMain1Search:true});
 const blocks=annotateBlockRelationships(buildActivationBlocks(recognized.events).blocks);
 const arm=blocks.find(b=>b.activationKey==='M09').details.find(d=>d.role==='HAND_GAIN_CANDIDATE');
 assert.deepStrictEqual(mainDeckCandidates(arm).map(c=>c.id),['M03']);
 const explicit=reconcileExpectedAtomicBottom({checkpoint:{activationKey:'M09'}},blocks,'M21');
 const placementLog={newOperationBlocks:explicit.newBlocks};
 const route= require('../../execution/core/m21-chicken-game-route');
 const placement=route.validateFieldPlacementLog(placementLog,{id:'M21'});
 assert.strictEqual(placement.block.activationKey,'M21');
 assert.throws(()=>route.validateFieldPlacementLog({newOperationBlocks:[blocks[0]]},{id:'M21'}),/PLACEMENT_LOG_MISSING/);
 const calls=[];
 const mockedRoute=load('execution/core/m21-chicken-game-route.js',{
   '../../lib/runtime-files':{readJson:()=>placementLog},
   [path.join(ROOT,'lib','win-fast')]:{sleep:async()=>{}},
   [path.join(ROOT,'runtime','observer','test-duel-log-live')]:{runDuelLogLive:async options=>calls.push(options)} });
 await mockedRoute.waitForFieldPlacementLog({bridge:{},info:{},card:{id:'M21',fieldPlacementLogAttempts:1,fieldPlacementInitialWaitMs:0}});
 assert.strictEqual(calls[0].expectedAtomicActivationKey,'M21');
 assert.strictEqual(calls[0].allowBacktrack,false);assert.strictEqual(calls[0].performanceFast,true);
 // Two copies: consume the selected second copy, preserving the first slot.
 const duplicateHand={revision:10,handCount:3,cards:[{id:'M21',index:1},{id:'M03',index:2},{id:'M21',index:3}]};
 const consumed=route.commitKnownM21Consumption(duplicateHand,placement.block,{id:'M21'},3);
 assert.deepStrictEqual(consumed.cards.map(c=>c.id),['M21','M03']);
 assert.strictEqual(consumed.lastIncremental.consumed.index,3);

 // Exercise real transaction writes in memory, including rollback and repeat
 // commits. No test reads/writes the current live state as a test fixture.
 const disk=new Map();const file=p=>path.join(ROOT,p);
 const jget=p=>JSON.parse(disk.get(p).toString());const jput=(p,v)=>disk.set(p,Buffer.from(JSON.stringify(v)));
 const init=()=>{disk.clear();jput(file(files[0]),decision);jput(file(files[1]),fixture);
   jput(file(files[2]),{lastHandRevision:5,outsideDeckCounts:{M21:1}});};init();
 let failLedger=false;
 const tx=load('lib/m21-field-transaction.js',{
  fs:{existsSync:p=>disk.has(p),readFileSync:p=>disk.get(p)},
  './runtime-files':{readJson:jget,readJsonIfExistsSafe:p=>disk.has(p)?jget(p):null,writeJsonAtomic:jput,
    restoreBuffer:(p,b)=>b==null?disk.delete(p):disk.set(p,b)},
  './incremental-observer-transaction':{commitIncrementalObserverResult:({incrementalResult:r,statePath,resultPath})=>{
    const ledger=jget(file(files[2]));ledger.lastHandRevision=r.after.revision;jput(file(files[2]),ledger);
    if(failLedger)throw new Error('INJECT_LEDGER_FAILURE');jput(statePath,r.after);jput(resultPath,r);}},
  '../execution/core/m21-chicken-game-route':route });
 let pending=tx.beginM21Transaction({before:clone(fixture),decisionBefore:clone(decision),selectedSlot:6,attemptDir:'test',fieldOnly:true});
 assert.throws(()=>tx.beginM21Transaction({before:fixture}),/NO_REACTIVATION/);
 const beforeMemory=new Map([...disk].map(([p,b])=>[p,Buffer.from(b)]));failLedger=true;
 assert.throws(()=>tx.commitM21Placement(pending,placementLog,placement.block),/INJECT_LEDGER_FAILURE/);
 assert.deepStrictEqual([...disk].sort(),[...beforeMemory].sort());failLedger=false;
 pending=tx.commitM21Placement(pending,placementLog,placement.block);
 assert.strictEqual(jget(file(files[1])).revision,6);assert.strictEqual(jget(file(files[2])).lastHandRevision,6);
 assert.strictEqual(jget(file(files[0])).usedCounts.M21,1);assert.strictEqual(jget(file(files[0])).graveSpellCount,11);
 pending=tx.commitM21Placement(pending,placementLog,placement.block);
 assert.strictEqual(jget(file(files[0])).usedCounts.M21,1);
 tx.completeM21Transaction(pending,{fieldOnly:true});assert.strictEqual(tx.loadPendingM21Transaction(),null);
 assert.strictEqual(jget(file(files[0])).chickenGameDrawPending,true);
 const replacing=clone(decision);replacing.fieldSpell='M21';
 assert.strictEqual(tx.accountM21Placement(replacing,{decisionBefore:clone(replacing),id:'replacement'}).graveSpellCount,12);

 // Run the actual executor functions with input-counting mature atom mocks.
 // Each interruption resumes only the saved next step; no hand replay exists.
 let state,events=[],saved;
 const live=read('execution/live/run-m21-chicken-game.js').split('main().catch(error => {')[0];
 const nativeRequire=createRequire(path.join(ROOT,'execution/live/run-m21-chicken-game.js'));
 const beforeDraw=route.commitKnownM21Consumption(fixture,placement.block,{id:'M21'},6);
 const liveContext=vm.createContext({__dirname:path.join(ROOT,'execution/live'),process,console:quiet,
  require:id=>{
   if(id==='../../lib/m21-field-transaction')return {loadPendingM21Transaction:()=>saved,
     saveM21Stage:(p,stage)=>saved={...p,stage},completeM21Transaction:p=>{saved={...p,stage:'COMPLETE'};events.push('complete');},
     beginM21Transaction:()=>{throw new Error('UNEXPECTED_NEW_ACTIVATION');}};
   if(id==='../../lib/runtime-files')return {readJson:()=>state,writeEvidenceJson(){},writeJsonAtomic(){}};
   if(id==='child_process')return {spawnSync:(_exe,args)=>{events.push('observer');assert.ok(args.includes('--expected-atomic-activation=M21'));return {status:0};}};
   if(id===path.join(ROOT,'lib','win-fast'))return {MdFastBridge:class {async start(){events.push('bridge');}async stop(){} }};
   if(id===path.join(ROOT,'lib','md-foreground'))return {activateAndVerifyMasterDuel:async()=>({info:{}})};
   if(id===path.join(ROOT,'lib','recognizer'))return {loadLibrary:()=>library,loadTemplates:async()=>[]};
   if(id===path.join(ROOT,'execution','core','m21-chicken-game-route'))return {
     clickFieldCardAndVerify:async()=>{events.push('field-card');},
     clickFieldEffectButton:async o=>{o.beforeSubmit();events.push('effect');},
     confirmDefaultDrawOne:async o=>{o.beforeSubmit();events.push('confirm');},
     validateFinalDraw:()=>({drawn:{id:'M09'},beforeCount:5,afterCount:6,finalHand:state.cards}),LOG_RESULT_PATH:'none'};
   if(id==='fs')return {existsSync:()=>false,mkdirSync(){}};
   return nativeRequire(id);
  }});
 vm.runInContext(live,liveContext);
 for(const [stage,expected] of [
   ['PLACEMENT_COMMITTED',['bridge','field-card','effect','confirm','observer','complete']],
   ['FIELD_EFFECT_STARTED',['bridge','confirm','observer','complete']],
   ['DRAW_CONFIRM_STARTED',['observer','complete']],['OBSERVER_STARTED',['observer','complete']]]) {
   state=clone(beforeDraw);events=[];saved={stage,beforeDraw:state};
   liveContext.pendingInput=saved;
   await vm.runInContext("runDrawOnly('test',pendingInput)",liveContext);
   assert.deepStrictEqual(events,expected,stage);
 }
 state={...clone(beforeDraw),revision:7,handCount:6,cards:[...clone(beforeDraw.cards),{id:'M09',index:6}]};events=[];saved={stage:'OBSERVER_STARTED',beforeDraw};liveContext.pendingInput=saved;
 await vm.runInContext("runDrawOnly('test',pendingInput)",liveContext);
 assert.deepStrictEqual(events,['complete'],'already committed draw is validated without observer/input replay');

 // Current repaired fixture really selects the field draw and skips Enter.
 const after=require('../../material/issues/issue-107-current-after.json');
 assert.deepStrictEqual(after.hand.cards.map(c=>c.id),['M03','M08','M12','M12','M14']);
 const { classifySimpleDrawContinuation }=require('../../lib/simple-draw-continuation-policy');
 const main=read('runtime/main-v6.js');
 const fixtureRemaining=Object.fromEntries(library.cards
  .filter(card=>/^M\d+$/.test(card.id))
  .map(card=>[card.id,Number(card.count||0)-Number(after.ledger.outsideDeckCounts[card.id]||0)]));
 const isolatedDecisionEngine=load('lib/decision-engine.js',{
  './main-deck-ledger':{getSharedDeckState:()=>({
    ledger:clone(after.ledger),deckRemaining:clone(fixtureRemaining),
    outsideDeckCounts:clone(after.ledger.outsideDeckCounts)})}
 });
 const context=vm.createContext({ROOT,path,console:quiet,loadDecisionState:()=>after.decision,
  knownNonRayeMonsterPresent:()=>false,validateHandState:s=>s,
  STRATEGIC_SPELL_IDS:new Set(library.cards.filter(c=>Number(c.id.slice(1))>=9&&c.id.startsWith('M')).map(c=>c.id)),
  buildLastResortAllureAction:require('../../lib/allure-policy').buildLastResortAllureAction,
  require:id=>{
    if(id.endsWith('recognizer'))return {loadLibrary:()=>library};
    if(id.endsWith('decision-engine'))return isolatedDecisionEngine;
    if(id.endsWith('deadlock-detector'))return require('../../lib/deadlock-detector');
    throw new Error('UNEXPECTED_REQUIRE:'+id);
  }});
 vm.runInContext(segment(main,'function isStrategicallyUsable(','function defaultDecisionState(')+
  segment(main,'function buildDecisionSuggestion(','function shortExtraForDecision('),context);
 const suggestion=context.buildDecisionSuggestion(after.hand);
 assert.strictEqual(suggestion.selected.specialAction,'M21_FIELD_DRAW');
 assert.strictEqual(classifySimpleDrawContinuation(after.hand,suggestion).automatic,true);
 assert.ok(main.indexOf('const m21Recovery = await resumePendingM21AtDecision')<main.indexOf("const suggestion = printDecisionPoint(state, '决策点'"));
 for(const [p,b] of bytes)assert.ok(fs.readFileSync(path.join(ROOT,p)).equals(b),`current state preserved: ${p}`);
 console.log('M21_STAGE_AND_NO_NEW_CLICK_OFFLINE_PASS: actual weak gain/settled frame; no hand clicks; current field draw auto; staged resume/rollback/idempotency');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
