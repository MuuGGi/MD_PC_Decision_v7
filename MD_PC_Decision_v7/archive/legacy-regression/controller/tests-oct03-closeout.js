'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, 'engine');
const RUN = path.join(__dirname, 'runs/2026-10-03T11-15-45-311Z');
const readJson = p => JSON.parse(fs.readFileSync(p));
const copy = v => JSON.parse(JSON.stringify(v));
const snapshot = n => path.join(RUN, `game-${String(n).padStart(5, '0')}/before-recovery`);
const hs = require('./engine/lib/hand-state'), config = require('./engine/live-config');
const { cropImage } = require('./engine/lib/png-utils');
const draw = require('./engine/lib/atomic-draw-resolution');
const library = require('./engine/card-library.json');
const deadlock = require('./engine/lib/deadlock-detector');
const silent = { log() {}, error() {} };
const png = p => PNG.sync.read(fs.readFileSync(p));
function segment(file, start, end) {
  const source = fs.readFileSync(file, 'utf8'), a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
function geometry(image, count) {
  const d = hs.detectHandCountFromImage(image, count, { purpose: 'CLICK_TARGET' });
  const estimate = d.componentEstimate && { ...d.componentEstimate, components: d.componentEstimate.components.map(c => ({
    ...c, centerX: c.centerX + config.handFan.detectRoi.x,
    centerY: c.centerY + config.handFan.detectRoi.y
  })) };
  return hs.resolveExposedFanSlots(hs.getHandLayout(count), estimate);
}

async function test() {
  const protectedFiles = [1, 2, 3, 5].flatMap(n => ['decision-state.json',
    'debug/hand-change-live/session_state.json', 'debug/main-deck-ledger/state.json'].map(rel => path.join(snapshot(n), rel)));
  const before = protectedFiles.map(p => [p, fs.readFileSync(p)]);
  const seven = png(path.join(snapshot(5), 'debug/execution/M09_upstart_goblin/2026-10-03T11-43-22-366Z/v5_current_title_target_01.png'));
  const sevenSlots = geometry(seven, 7);
  assert.strictEqual(sevenSlots.slots.length, 7);
  assert.ok(sevenSlots.slots.every(s => s.measuredTitle2D));
  assert.strictEqual(sevenSlots.slots[0].x, 576);
  assert.ok(sevenSlots.slots[0].titleY >= 1030 && sevenSlots.slots[0].titleY <= 1055);
  for (let n = 1; n <= 6; n++) {
    const two = png(path.join(snapshot(2), `debug/execution/V5_formal_atomic/2026-10-03T11-27-18-131Z_M19_equip/hand_target/v5_link_current_title_0${n}.png`));
    assert.strictEqual(hs.detectHandCountFromImage(two, 2, { purpose: 'CLICK_TARGET' }).componentEstimate.count, 2, 'grass must not become the third click target');
    assert.ok(geometry(two, 2).slots.every(s => s.measuredTitle2D));
  }
  const blank = { width: seven.width, height: seven.height, data: Buffer.alloc(seven.data.length) };
  assert.strictEqual(hs.detectHandCountFromImage(blank, 7).componentEstimate, null);

  // Do not solve the two-card grass false positive by raising a colour
  // threshold that silently drops real glowing/printed historical headers.
  const legacyHs = require(path.join(RUN, 'engine-source/lib/hand-state'));
  let historicalTitles = 0;
  function historical(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (historicalTitles >= 40) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) historical(file);
      else if (entry.name === 'v5_current_title_target_01.png' && fs.existsSync(path.join(dir, 'execution_click.json'))) {
        const meta = readJson(path.join(dir, 'execution_click.json'));
        const count = meta.handCount || meta.baselineHandCount;
        if (!count || count > 7) continue;
        const image = png(file), previous = legacyHs.estimateHandCountByTitleComponents(image);
        const current = hs.estimateHandCountByTitleComponents(image);
        assert.strictEqual(current?.count, previous?.count, 'lost historical title: ' + file);
        const clickable = hs.estimateClickableHandTitles(image, count);
        assert.ok(clickable.components.every(c => c.title2D && Number.isFinite(c.centerY)));
        historicalTitles++;
      }
    }
  }
  historical(path.join(ROOT, 'material/verified/evidence'));
  assert.strictEqual(historicalTitles, 40);

  // Exercise the real low-hand selector with a recording bridge, not only the
  // detector. Wrong Y deliberately produces the historical M13 mismatch.
  const preloadFile = path.join(ROOT, 'execution/core/executor-preload.js');
  const nativePreload = createRequire(preloadFile);
  let clicks = [], selectedIdentity = 'M09';
  const bridge = { info: async () => ({}), key: async () => {}, click: async (x,y) => { clicks.push({x,y}); } };
  const selector = vm.createContext({ ROOT, path, console: silent,
    normalizeRecognized: x => x, sameRuntimeCardIdentity: (id, row) => id === row.id,
    require: id => {
      const normalized=id.replace(/\\/g,'/');
      if (normalized.endsWith('lib/win-fast')) return { sleep: async () => {}, mapReferencePoint: (_, p) => p, captureReferenceRoi: async () => seven };
      if (normalized.endsWith('observer/scan-state')) return { saveRgbaPng() {}, recognizeCurrentCard: async () => {
        const p = clicks.at(-1); return { accepted: true, id: p.y >= 1030 ? selectedIdentity : 'M13', name: selectedIdentity };
      } };
      return nativePreload(id);
    } });
  vm.runInContext(segment(preloadFile, 'async function selectExactLowHandOrdinal(', 'function installExactSlotSelection('), selector);
  const cards = ['M09','M12','M12','M12','M14','M16','M21'].map((id,i) => ({ id,index:i+1 }));
  const options = { bridge, info: {}, library, templates: [], baseline: { handCount: 7, cards } };
  const selected = await selector.selectExactLowHandOrdinal(options, 1, 'M09', cards);
  assert.strictEqual(selected.selected.id, 'M09');
  assert.ok(clicks.at(-1).y >= 1030);
  selectedIdentity = 'M13'; clicks = [];
  await assert.rejects(selector.selectExactLowHandOrdinal(options,1,'M09',cards), /HAND_SELECTION_MISMATCH/);
  assert.strictEqual(clicks.length, 2, 'wrong identity stops; no speculative retry or activation');

  // Also exercise the real Link/equip selector on G2's two-card image.
  const two = png(path.join(snapshot(2), 'debug/execution/V5_formal_atomic/2026-10-03T11-27-18-131Z_M19_equip/hand_target/v5_link_current_title_01.png'));
  const atomicFile = path.join(ROOT, 'execution/core/atomic-route-executor.js');
  const atomic = vm.createContext({ ROOT, path, config, console: silent, require: createRequire(atomicFile),
    getHandLayout: hs.getHandLayout, detectHandCountFromImage: hs.detectHandCountFromImage,
    resolveExposedFanSlots: hs.resolveExposedFanSlots, mapReferencePoint: (_,p)=>p,
    sleep: async()=>{}, captureReferenceRoi: async()=>two, normalizeRecognized:x=>x,
    recognizeCurrentCard: async()=>({accepted:true,id:'M19',name:'妖刀竹光'}) });
  vm.runInContext(segment(atomicFile,'async function selectCurrentObservedHandCard(','function runObserver('),atomic);
  clicks=[];
  const equip = await atomic.selectCurrentObservedHandCard({ bridge, info:{}, library, templates:[],
    expectedId:'M19', baseline:{handCount:2,cards:[{id:'M14',index:1},{id:'M19',index:2}]} });
  assert.strictEqual(equip.selected.id,'M19');
  assert.strictEqual(equip.slot,2); assert.strictEqual(equip.clickReference.x,1094);
  assert.strictEqual(clicks.length,2);

  // Replay the incomplete real M15 log. A subsequent same-transaction gain
  // must mature before hand validation; INFO alone cannot manufacture a gain.
  const partial = readJson(path.join(snapshot(1), 'debug/duel-log-live/latest_result.json'));
  assert.strictEqual(draw.inspectAtomicDrawResolution(partial,'M15').ready,false);
  const complete = copy(partial);
  complete.newOperationBlocks.find(b => b.activationKey === 'M15').details.push({
    rawType: 'HAND_GAIN', side: 'SELF', card: { id: 'M09' }
  });
  let log = partial, clock = 0, refreshes = 0;
  const waited = await draw.waitForAtomicDrawResolution({ activationKey:'M15', readLog:()=>log,
    delay:async ms=>{clock+=ms;}, now:()=>clock, refresh:async()=>{refreshes++;log=complete;} });
  assert.strictEqual(waited.proof.ready,true); assert.strictEqual(refreshes,1);
  clock=0; await assert.rejects(draw.waitForAtomicDrawResolution({ activationKey:'M15',readLog:()=>partial,
    now:()=>clock,delay:async ms=>{clock+=ms;},refresh:async()=>{},timeoutMs:600 }), /RESOLUTION_TIMEOUT/);
  await assert.rejects(draw.waitForAtomicDrawResolution({ activationKey:'M15',readLog:()=>partial,
    delay:async()=>{},refresh:async()=>{throw new Error('AUTOTEST_STOP:MOUSE_INTERFERENCE');} }), /MOUSE_INTERFERENCE/);
  const terminal = await draw.waitForAtomicDrawResolution({ activationKey:'M15',readLog:()=>partial,
    delay:async()=>{},refresh:async()=>({terminal:true,type:'VICTORY'}) });
  assert.strictEqual(terminal.terminal,true);
  const wrongSide = copy(complete); wrongSide.newOperationBlocks.find(b=>b.activationKey==='M15').details[0].side='OPPONENT';
  assert.strictEqual(draw.inspectAtomicDrawResolution(wrongSide,'M15').ready,false);
  const excess = copy(complete); excess.newOperationBlocks.find(b=>b.activationKey==='M15').details.push({rawType:'HAND_GAIN',side:'SELF'});
  assert.throws(()=>draw.inspectAtomicDrawResolution(excess,'M15'),/EXCESS_GAINS/);
  const productionObserver = fs.readFileSync(path.join(ROOT,'runtime/observer/run-live-incremental.js'),'utf8');
  assert.ok(productionObserver.indexOf('await waitForAtomicDrawResolution(') < productionObserver.indexOf('await runIncrementalHandChange('));
  assert.match(productionObserver,/restoreBuffer\(observerStatePath, observerStateBefore\);\s*await observeCurrentLog\(frame\)/);
  const tradeIn = fs.readFileSync(path.join(ROOT,'execution/live/run-m12-trade-in.js'),'utf8');
  assert.ok(tradeIn.indexOf('if (terminalOutcome) {') < tradeIn.indexOf('const verified = verifyM12ObserverResult('));
  assert.match(tradeIn,/readFreshVictoryOutcome\(previousOutcomeMtime, observerStartedAt\)/);
  const victoryFile=path.join(ROOT,'execution/core/observer-completion.js');
  let victory={terminal:true,type:'VICTORY',strictEvidence:{matched:true},checkedAt:new Date(3000).toISOString()};
  const freshGuard=vm.createContext({OUTCOME_PATH:'mock', fs:{readFileSync:()=>JSON.stringify(victory)},
    outcomeMtimeMs:()=>3000});
  vm.runInContext(segment(victoryFile,'function readFreshVictoryOutcome(','// Observer success'),freshGuard);
  assert.ok(freshGuard.readFreshVictoryOutcome(1000,3000));
  assert.strictEqual(freshGuard.readFreshVictoryOutcome(3000,3000),null,'stale outcome mtime');
  assert.strictEqual(freshGuard.readFreshVictoryOutcome(1000,5000),null,'old checkedAt');
  victory.strictEvidence.matched=false;
  assert.strictEqual(freshGuard.readFreshVictoryOutcome(1000,3000),null,'unconfirmed victory');
  victory.strictEvidence.matched=true; victory.type='DEFEAT';
  assert.strictEqual(freshGuard.readFreshVictoryOutcome(1000,3000),null,'defeat is not victory');

  let runtime, remaining;
  const engineFile=path.join(ROOT,'lib/decision-engine.js'), native=createRequire(engineFile);
  const engine=vm.createContext({module:{exports:{}},console:silent,require:id=>id==='./main-deck-ledger'
    ? {getSharedDeckState:()=>({deckRemaining:remaining,outsideDeckCounts:{},ledger:{}})} : native(id)});
  vm.runInContext(fs.readFileSync(engineFile,'utf8'),engine);
  const main=vm.createContext({ROOT,path,console:silent,loadDecisionState:()=>runtime,isStrategicallyUsable:()=>true,
    knownNonRayeMonsterPresent:()=>!!runtime.bambooSwordEquipped || !!runtime.v5Branch?.carrierId,
    buildLastResortAllureAction:()=>null,adjustedMainDeckRemainingCount:require('./engine/lib/exodia-policy').adjustedMainDeckRemainingCount,
    require:id=>id.endsWith('recognizer')?{loadLibrary:()=>library}:id.endsWith('decision-engine')?engine.module.exports:require(id)});
  vm.runInContext(segment(path.join(ROOT,'runtime/main-v6.js'),'function buildDecisionSuggestion(','function shortExtraForDecision('),main);
  function archived(n) {
    runtime=readJson(path.join(snapshot(n),'decision-state.json'));
    const ledger=readJson(path.join(snapshot(n),'debug/main-deck-ledger/state.json'));
    remaining=Object.fromEntries(library.cards.filter(c=>/^M\d+$/.test(c.id)).map(c=>[c.id,c.count-(ledger.outsideDeckCounts[c.id]||0)]));
    return readJson(path.join(snapshot(n),'debug/hand-change-live/session_state.json'));
  }
  const first=archived(1);
  // Restore the immediately preceding decision before One Day drew this Void.
  first.cards=first.cards.map(c=>c.id==='M15'?{...c,id:'M16',name:'暂时休战'}:c);
  remaining.M15++; runtime.usedCounts.M16--; runtime.graveSpellCount--;
  const firstDecision=main.buildDecisionSuggestion(first);
  assert.strictEqual(firstDecision.selected.id,'M13');
  assert.strictEqual(firstDecision.selected.tier,3);
  assert.strictEqual(firstDecision.selected.details.banishTarget.id,'M06');
  const third=archived(3), thirdDecision=main.buildDecisionSuggestion(third);
  assert.strictEqual(thirdDecision.selected,null);
  assert.strictEqual(thirdDecision.strategicDeadlock.terminal,true);
  assert.strictEqual(thirdDecision.strategicDeadlock.rayeCloseout.reason,'FIELD_EQUIP_PRESERVED');
  runtime.bambooSwordEquipped=false; runtime.usedCounts.M17=0; runtime.v5Branch.currentState='YOTO_SEARCH_DONE';
  const legalDeck=main.buildDecisionSuggestion(third);
  assert.strictEqual(legalDeck.selected.details.e10EngageSource,'DECK');
  assert.strictEqual(legalDeck.selected.details.phase,'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
  assert.strictEqual(legalDeck.strategicDeadlock.terminal,false);
  runtime.effectUsage.E10_SUMMON=1;
  assert.strictEqual(main.buildDecisionSuggestion(third).strategicDeadlock.terminal,true);
  for(const [p,bytes] of before) assert.ok(bytes.equals(fs.readFileSync(p)),'archive changed: '+p);
  console.log('OCT03_CLOSEOUT_OFFLINE_PASS; real G2/G5 measured XY; 40 old title images; both production selectors; G1 resolution waits/timeout/human stop; Raye Allure draw2; G3 shared last-equip/Deck-Engage/used-Zero proof; M12 fresh/stale/strict terminal guard; nativeInputs=0');
}
if(require.main===module) test().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={test};
