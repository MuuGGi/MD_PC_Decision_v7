'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { recognizeCurrentCard, saveRgbaPng } = require('../../runtime/observer/scan-state');
const { withForegroundRetry } = require('./run-m06-raye-field-effect');
const { establishCurrentObserverBaseline } = require('../core/observer-current-baseline');
const { selectObservedHandCard } = require('../core/hand-target');
const { captureNeutralNormalSummonFrame } = require('../core/hand-normal-summon');
const { clickSelectedHandSpellActivation } = require('../core/hand-spell-activation');
const { clickObservedEquipConfirm } = require('../core/field-link-target');
const { CENTRAL_MAIN, clickPreferredEquipCarrier } = require('../core/preferred-equip-carrier');
const { locateFieldM20, clickFieldM20Effect, waitForM19DeckPrompt, selectM19FromDeckPrompt } = require('../core/m20-true-bamboo-conversion');
const { FULL, detectRayeSubmit } = require('../core/m06-field-effect');
const { clickExtraDeckSummonButton, waitForSummonCandidates, selectNextLegalLink, clickBottomSummonSubmit, proveCarrierMaterialSelectable, clickCarrierMaterial, clickMaterialBlueConfirm } = require('../core/link-carrier-summon');
const { selectM19FromOptionalPool } = require('../core/m19-search-execution');
const { OPTIONAL_EFFECT_PROMPT, probeOptionalEffectPrompt } = require('../core/optional-effect-prompt-observer');
const { probeSkyStrikerSearchTargetPrompt } = require('../core/sky-striker-search-target-prompt-observer');
const { BAMBOO_TARGET_PROMPT, probeBambooSearchTargetPrompt } = require('../core/bamboo-search-target-prompt-observer');
const { detectCandidateCenters } = require('../core/prompt-candidate-centers');
const { initialState, summarizeCompositeRouteState } = require('../../lib/composite-route-observer');
const PATHS = {
  hand: path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json'),
  log: path.join(ROOT, 'debug/duel-log-live/latest_result.json'),
  composite: path.join(ROOT, 'debug/composite-route-live/latest_result.json'),
  compositeState: path.join(ROOT, 'debug/composite-route-live/session_state.json'),
  decision: path.join(ROOT, 'decision-state.json')
};
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function write(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
function terminal(mode, original) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'execution/core/m06-terminal-focus.ps1'), '-Mode', mode];
  if (original) args.push('-WindowHandle', original.handle, '-ExpectedProcessId', String(original.processId));
  const out = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (out.error || out.status !== 0) throw new Error(`TERMINAL_FOCUS_FAILED:${out.error || out.stderr}`);
  return JSON.parse(out.stdout.trim());
}
const { brightBambooEvidence } = require('./run-raye-yoto-double-effect');
function verifyConversion(r, count) {
  if(r.hand.status!=='PASS'||r.hand.after?.handCount!==count||
     (r.hand.insertedCards||[]).length||r.composite.summary?.equip!=='M20_FIELD_TO_M19'||
     !(r.log.newOperationBlocks||[]).some(b=>b.activationKey==='M20')) {
    throw new Error('TRUE_TO_YOTO_NOT_VERIFIED');
  }
  return {handCount:count,equip:r.composite.summary.equip};
}
function verifyFinal(hand,log,summary,before,bamboo) {
  const blocks=log.newOperationBlocks||[];
  const details=blocks.flatMap(b=>b.details||[]);
  const own=d=>!d.side||d.side==='SELF';
  const gains=(hand.insertedCards||[]).map(x=>x.card&&x.card.id);
  if(hand.status!=='PASS'||hand.before?.handCount!==before||hand.after?.handCount!==before+1||
     gains.length!==1||gains[0]!==bamboo||
     !details.some(d=>own(d)&&d.rawType==='LINK_SUMMON'&&d.card?.id==='E04')||
     !details.some(d=>own(d)&&d.role==='REMOVAL_RESULT'&&d.card?.id==='E02')||
     !details.some(d=>own(d)&&d.rawType==='DESTROY'&&d.card?.id==='M19')||
     !blocks.some(b=>b.activationKey==='M19'&&(b.details||[]).some(d=>own(d)&&d.role==='HAND_GAIN_CANDIDATE'&&d.card?.id===bamboo))||
     summary.exit!=='SINGLE_LINK'||summary.equip!=='M20_FIELD_TO_M19') {
    throw new Error('TRUE_BAMBOO_FINAL_NOT_VERIFIED:需火刀离场、风刀Link登场、妖刀破坏及实际检索入手');
  }
  return {before,after:hand.after.handCount,bamboo,result:'E04'};
}
async function main() {
  if(process.versions.node!=='20.11.1')throw new Error('NODE_VERSION_MISMATCH');
  const autoRun=true;
  const optimized=autoRun && !process.argv.includes('--no-optimize');
  const fullDebug=process.argv.includes('--full-debug');
  const runStarted=process.hrtime.bigint();
  const elapsed=start=>Number(process.hrtime.bigint()-start)/1e6;
  const base=path.join(ROOT,'debug/execution/Hornet_kagari_true_bamboo_wind');
  let state={next:0,status:'IN_PROGRESS',data:{},completed:[]};
  const resumeTrue=process.argv.includes('--resume-true');
  const resumeYotoSelected=process.argv.includes('--resume-yoto-selected');
  if(resumeTrue && resumeYotoSelected)throw new Error('RESUME_FLAGS_CONFLICT');
  if(process.argv.some(a=>a.startsWith('--resume')&&!['--resume-true','--resume-yoto-selected'].includes(a)))throw new Error('UNSUPPORTED_RESUME');
  if(resumeTrue) {
    const dirs=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort().reverse();
    if(!dirs.length)throw new Error('NO_RESUME_RECORD');
    state=read(path.join(base,dirs[0],'result.json'));
    if(state.status!=='ERROR'||state.next!==7||!(state.completed||[]).some(c=>c.step===6)||
       !/^Error: DENSE_OBSERVED_WITNESS_CARD_MISMATCH:RIGHT_EDGE:ordinal=4;expected=M20;actual=.*\[M19\]/.test(state.error||''))throw new Error('RESUME_TRUE_REQUIRES_PRE_ACTIVATION_MISMATCH');
    const saved=read(path.join(base,dirs[0],'07','hand.json'));
    const current=read(path.join(ROOT,'debug/hand-change-live/session_state.json'));
    if(saved.after.handCount!==current.handCount||saved.after.cards.map(c=>c.id).join('|')!==current.cards.map(c=>c.id).join('|'))throw new Error('RESUME_HAND_STATE_CHANGED');
  }
  if(resumeYotoSelected) {
    const dirs=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort().reverse();
    if(!dirs.length)throw new Error('NO_RESUME_RECORD');
    state=read(path.join(base,dirs[0],'result.json'));
    if(state.status!=='ERROR'||state.next!==10||!(state.completed||[]).some(c=>c.step===9)||
       !/D4_M19_(NOT_FOUND_IN_DECK_PROMPT|SELECTED_IDENTITY_NOT_CONFIRMED)/.test(state.error||''))throw new Error('RESUME_YOTO_REQUIRES_DECK_SELECTION_FAILURE');
  }
  const dir = path.join(base, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  state.status = 'IN_PROGRESS';
  const persist = () => write(path.join(dir, 'result.json'), state);
  const origin = terminal('Capture');
  const rl = null;
  const library = loadLibrary(ROOT), templates = await loadTemplates(ROOT, library);
  let bridge = null, info = null, stepDir = dir;
  async function close() { const b = bridge; bridge = null; if (b) await b.stop(); }
  async function focus() {
    // Reuse activation only when the bridge proves exactly the same window
    // report. Any report change takes the original complete verification path.
    if (optimized && bridge && info) {
      let current;
      try { current = await bridge.info(); }
      catch (error) {
        if (!/Foreground window is not Master Duel/.test(String(error.message))) throw error;
      }
      if (current && JSON.stringify(current) === JSON.stringify(info)) return;
    }
    if (!bridge) { bridge = new MdFastBridge(); await bridge.start(); }
    await withForegroundRetry(async () => {
      info = (await activateAndVerifyMasterDuel(bridge)).info;
      await sleep(300);
      const current = await bridge.info();
      if (JSON.stringify(info.client) !== JSON.stringify(current.client)) throw new Error('DOUBLE_EFFECT_WINDOW_MOVED');
      info = current;
    }, async () => { await bridge.activateMasterDuel(); await sleep(300); });
  }
  const opts = () => ({ bridge, info, library, templates, debugDir: stepDir });
  async function shot(label) { return saveRgbaPng(await captureReferenceRoi(bridge, info, FULL), path.join(stepDir, label + '.png')); }
  async function identify(expected) {
    const raw = await withForegroundRetry(() => recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 }), focus);
    const j = raw && raw.judged;
    if (!j || !j.accepted || !j.best || (expected && j.best.id !== expected)) throw new Error(`DOUBLE_EFFECT_CARD_NOT_PROVEN:${expected || 'ANY'}/${j && j.best && j.best.id}`);
    return j.best;
  }
  async function click(point) {
    await withForegroundRetry(async () => { const p = mapReferencePoint(info, point); await bridge.click(p.x, p.y); }, focus);
    await sleep(300);
  }
  async function submit(x, label) {
    const roi = { x, y: 1050, width: 310, height: 90 };
    let previous = null;
    for (let i = 0; i < 8; i++) {
      const im = await captureReferenceRoi(bridge, info, roi);
      saveRgbaPng(im, path.join(stepDir, `${label}_${i}.png`));
      const p = detectRayeSubmit(im);
      if (p.visible && previous && previous.visible && Math.hypot(p.centerX-previous.centerX,p.centerY-previous.centerY)<5) {
        const point = { x: x + p.centerX, y: 1050 + p.centerY };
        await click(point); return point;
      }
      previous = p; await sleep(180);
    }
    throw new Error(`${label}_BUTTON_NOT_PROVEN:已选卡不重复点击`);
  }
  async function observe() {
    await close();
    const started = Date.now();
    const out = spawnSync(process.execPath, [
      path.join(ROOT, 'runtime/observer/run-live-incremental.js'),
      '--adjacent-checkpoint-only'
    ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (out.error || out.status !== 0) throw new Error(`DOUBLE_EFFECT_OBSERVER_FAILED:${out.error || out.status}`);
    for (const key of ['hand', 'log', 'composite']) {
      if (fs.statSync(PATHS[key]).mtimeMs < started-1000) throw new Error(`STALE_OBSERVER:${key}`);
      fs.copyFileSync(PATHS[key], path.join(stepDir, key + '.json'));
    }
    const result = { hand: read(PATHS.hand), log: read(PATHS.log), composite: read(PATHS.composite) };
    await focus();
    return result;
  }
  async function waitPool(count) {
    let last = null, stable = 0;
    for (let i=0;i<20;i++) {
      const p = await probeOptionalEffectPrompt({ bridge, info, debugDir: stepDir, suffix: String(i) });
      stable = p.visible && p.candidateCount === count ? stable+1 : 0;
      last = p;
      if (stable>=2) return p;
      await sleep(220);
    }
    throw new Error(`OPTIONAL_EXPECT_${count}:actual=${last && last.candidateCount}`);
  }
  async function probeRouteBamboo() {
    const probe=await probeBambooSearchTargetPrompt({bridge,info,debugDir:stepDir});
    if(probe.visible)return probe;
    const candidates=await captureReferenceRoi(bridge,info,BAMBOO_TARGET_PROMPT.candidateRoi);
    const footer=await captureReferenceRoi(bridge,info,{x:695,y:1030,width:650,height:20});
    const result=brightBambooEvidence(probe,candidates,footer);
    write(path.join(stepDir,'route_bamboo_probe.json'),result);
    return result;
  }
  async function selectRouteBamboo() {
    const prompt=await waitTarget('M19_SEARCH');
    let fallback=null;
    for(const point of prompt.candidateCenters.slice().sort((a,b)=>b.x-a.x)) {
      await click(point);const card=await identify();
      console.log(`妖刀检索候选：${card.name}[${card.id}]`);
      if(!['M14','M20'].includes(card.id))throw new Error('ROUTE_BAMBOO_UNEXPECTED_CARD:保留现场');
      if(card.id==='M20') {
        await sleep(600);await submit(870,'bamboo_confirm');return {selected:card,point};
      }
      fallback={point,card};await click(point);
    }
    if(!fallback)throw new Error('ROUTE_BAMBOO_TARGET_MISSING');
    await click(fallback.point);const card=await identify('M14');
    await sleep(600);await submit(870,'bamboo_confirm');return {selected:card,point:fallback.point};
  }
  async function waitTarget(kind) {
    const probe = kind === 'M19_SEARCH' ? probeRouteBamboo : probeSkyStrikerSearchTargetPrompt;
    let previous = null;
    for (let i=0;i<16;i++) {
      const p = await probe({ bridge, info, debugDir: stepDir, suffix: String(i) });
      if (p.visible && previous && previous.visible && p.candidateCenters.length===previous.candidateCenters.length &&
          p.candidateCenters.every((point,i)=>Math.hypot(point.x-previous.candidateCenters[i].x,point.y-previous.candidateCenters[i].y)<=5)) return p;
      previous = p; await sleep(220);
    }
    throw new Error(`TARGET_PROMPT_NOT_STABLE:${kind}`);
  }
  async function currentHandTarget(id) {
    let current=read(path.join(ROOT,'debug/hand-change-live/session_state.json'));
    let baseline={...current,status:'PASS'};
    const target=current.cards.find(c=>c.id===id);
    if(!target)throw new Error('TARGET_NOT_IN_OBSERVED_HAND:'+id);
    // The common target entry must obtain current evidence. Never attach an
    // opening-hand ordinal to a card in a later observer state.
    const neutralFrame=await captureNeutralNormalSummonFrame(opts());
    return {baseline,neutralFrame,selected:await selectObservedHandCard({...opts(),baseline,expectedId:id})};
  }
  function checkConsumed(r,id,before) {
    if(r.hand.status!=='PASS'||r.hand.after.handCount!==before-1||
       !r.hand.inference.consumed||r.hand.inference.consumed.id!==id||(r.hand.insertedCards||[]).length)throw new Error('CONSUMPTION_NOT_VERIFIED:'+id);
  }
  async function chooseLink(id) {
    const p=await waitForSummonCandidates(opts());
    const choice=await selectNextLegalLink({...opts(),carrierId:'ROUTE_MATERIALS',
      promptProof:{...p,points:p.points.slice().sort((a,b)=>b.x-a.x)},
      excludedLinkIds:['E02','E03','E04','E05','E06','E07','E08','E09','E10'].filter(x=>x!==id)});
    if(choice.selected.id!==id)throw new Error('LINK_CHOICE_MISMATCH');
    return choice;
  }
  async function chooseSingleOptional(id) {
    await waitPool(1);
    const image=await captureReferenceRoi(bridge,info,OPTIONAL_EFFECT_PROMPT.candidateRoi);
    const points=detectCandidateCenters(image,OPTIONAL_EFFECT_PROMPT.candidateRoi,OPTIONAL_EFFECT_PROMPT.candidateY,{mode:'components'});
    if(points.length!==1)throw new Error('OPTIONAL_NOT_SINGLE');
    await click(points[0]);const card=await identify(id);await sleep(600);
    return {card,point:points[0]};
  }
  const steps=[
    ['新局观察，发动大黄蜂并验收衍生物',async()=>{
      const baseline=await establishCurrentObserverBaseline({...opts(),outputDir:stepDir});
      if(!['M22','M20'].every(id=>baseline.cards.some(c=>c.id===id)))throw new Error('NEED_HORNET_TRUE_BAMBOO');
      for(const key of ['composite','compositeState','decision'])if(fs.existsSync(PATHS[key]))fs.copyFileSync(PATHS[key],path.join(stepDir,'previous_'+key+'.json'));
      const empty=initialState();write(PATHS.compositeState,empty);write(PATHS.composite,{state:empty,summary:summarizeCompositeRouteState(empty)});
      const reset=spawnSync(process.execPath,[path.join(ROOT,'tools/reset-duel-state.js')],{cwd:ROOT,stdio:'inherit',windowsHide:true});
      if(reset.error||reset.status!==0)throw new Error('RESET_FAILED');
      state.data.fullBaseline=baseline;state.data.initialCount=baseline.handCount;
      const target=await currentHandTarget('M22');
      await sleep(600);await clickSelectedHandSpellActivation({...opts(),expectedId:'M22',expectedName:'闪刀机－大黄蜂无人机',clickReference:target.selected.clickReference});
      await sleep(1600);const r=await observe();checkConsumed(r,'M22',baseline.handCount);
      const token=(r.log.newOperationBlocks||[]).flatMap(b=>b.details||[]).find(d=>d.rawType==='SPECIAL_SUMMON'&&d.card&&(/衍生物/.test(d.card.name)||d.card.id==='TOKEN_SKY_STRIKER'));
      if(!token)throw new Error('TOKEN_SUMMON_NOT_VERIFIED');return {token};
    }],
    ['打开额外卡组，等待真实候选窗口',async()=>{
      await captureNeutralNormalSummonFrame(opts());
      await clickExtraDeckSummonButton(opts());return await waitForSummonCandidates(opts());
    }],
    ['选择火刀并提交，进入单素材窗口',async()=>{
      const p=await chooseLink('E02');await clickBottomSummonSubmit(opts());await sleep(650);return p;
    }],
    ['选择衍生物作为素材',async()=>{
      // The library has no hand/detail template for the Token. Its identity
      // comes from the preceding verified M22 special-summon log; the actual
      // material window must prove the sole central carrier selectable.
      const target=await clickPreferredEquipCarrier({...opts(),label:'单素材衍生物', knownCentralToken:true});
      if(target.kind!=='CENTRAL_MAIN'||target.recognized.accepted)throw new Error('EXPECTED_TOKEN_MATERIAL:新局中央只应有已验收衍生物');
      state.data.tokenAnchor=target.clickReference;return target;
    }],
    ['确认单素材Link，等待火刀效果窗口',async()=>{
      await clickMaterialBlueConfirm({...opts(),anchorReference:state.data.tokenAnchor});await sleep(1700);return await waitPool(1);
    }],
    ['选择火刀效果并发动',async()=>{
      const p=await chooseSingleOptional('E02');await submit(1022,'kagari_effect');await sleep(700);return p;
    }],
    ['火刀回收：交闪优先，否则大黄蜂',async()=>{
      const p=await waitTarget('MONSTER_OPTIONAL');let chosen=null,fallback=null;
      for(const point of p.candidateCenters.slice().sort((a,b)=>b.x-a.x)) {
        await click(point);const card=await identify();
        if(card.id==='M17'){chosen=card;break;}
        if(card.id==='M22')fallback={point,card};
        await click(point);
      }
      if(!chosen&&fallback){await click(fallback.point);chosen=await identify('M22');}
      if(!chosen)throw new Error('RECOVERY_TARGET_NOT_FOUND');
      await sleep(600);await submit(870,'kagari_recovery');await sleep(1600);
      const r=await observe();
      if(r.hand.status!=='PASS'||r.hand.after.handCount!==state.data.initialCount||
         r.hand.before.handCount!==state.data.initialCount-1||
         (r.hand.insertedCards||[]).length!==1||r.hand.insertedCards[0].card.id!==chosen.id||
         !(r.log.newOperationBlocks||[]).some(b=>b.activationKey==='E02'&&(b.details||[]).some(d=>d.card?.id===chosen.id&&['RETURN_TO_HAND','HAND_GAIN'].includes(d.rawType))))throw new Error('KAGARI_RECOVERY_NOT_VERIFIED');
      state.data.recovery=chosen.id;return {recovered:chosen};
    }],
    ['从真实手牌发动真刀',async()=>{
      const target=await currentHandTarget('M20');state.data.beforeEquip=target.baseline.handCount;
      await sleep(600);return await clickSelectedHandSpellActivation({...opts(),expectedId:'M20',expectedName:'真刀竹光',clickReference:target.selected.clickReference});
    }],
    ['真刀选择火刀并装备，正式观察',async()=>{
      const p=await clickPreferredEquipCarrier({...opts(),label:'真刀装备火刀'});
      if(!p.recognized.accepted||p.recognized.id!=='E02')throw new Error('EQUIP_TARGET_NOT_KAGARI');
      state.data.kagariAnchor=p.clickReference;
      await clickObservedEquipConfirm({...opts(),anchorReference:p.clickReference});await sleep(1400);
      const r=await observe();checkConsumed(r,'M20',state.data.beforeEquip);
      if(r.composite.summary.equip!=='M20_FROM_HAND')throw new Error('TRUE_EQUIP_NOT_VERIFIED');
      state.data.beforeFinal=r.hand.after.handCount;return r.composite.summary;
    }],
    ['识别场上真刀，发动效果',async()=>{
      const p=await locateFieldM20(opts());
      const effect=await clickFieldM20Effect({...opts(),fieldReference:p.reference});
      await sleep(1200);return effect;
    }],
    ['从牌组选择妖刀并提交',async()=>{
      const promptProof=await waitForM19DeckPrompt(opts());
      const p=await selectM19FromDeckPrompt({...opts(),promptProof,alreadySelected:resumeYotoSelected});
      await sleep(900);return p;
    }],
    ['妖刀装备火刀，正式观察真刀转换',async()=>{
      const p=await clickPreferredEquipCarrier({...opts(),label:'真刀效果装备妖刀'});
      if(!p.recognized.accepted||p.recognized.id!=='E02')throw new Error('CONVERSION_TARGET_NOT_KAGARI');
      state.data.kagariAnchor=p.clickReference;
      await clickObservedEquipConfirm({...opts(),anchorReference:p.clickReference});await sleep(1800);
      const r=await observe();return verifyConversion(r,state.data.beforeFinal);
    }],
    ['打开额外卡组，选择风刀并提交',async()=>{
      await captureNeutralNormalSummonFrame(opts());await clickExtraDeckSummonButton(opts());
      const p=await chooseLink('E04');await clickBottomSummonSubmit(opts());await sleep(700);return p;
    }],
    ['选择火刀作为单素材，确认卡名',async()=>{
      const p=await clickCarrierMaterial({...opts(),anchorReference:state.data.kagariAnchor,carrierMode:'GENERIC'});
      await identify('E02');await sleep(600);return p;
    }],
    ['确认素材，等待妖刀效果池',async()=>{
      await clickMaterialBlueConfirm({...opts(),anchorReference:state.data.kagariAnchor});
      await sleep(1800);return await waitPool(1);
    }],
    ['发动妖刀检索效果',async()=>await selectM19FromOptionalPool(opts())],
    ['妖刀检索竹光，真刀优先',async()=>{
      const p=await selectRouteBamboo();state.data.bamboo=p.selected.id;await sleep(1600);return p;
    }],
    ['正式observer验收风刀登场、妖刀离场和竹光入手',async()=>{
      const optional=await probeOptionalEffectPrompt({bridge,info,debugDir:stepDir});
      const bamboo=await probeRouteBamboo();
      if(optional.visible||bamboo.visible)throw new Error('DIALOG_STILL_OPEN');
      const r=await observe();return verifyFinal(r.hand,r.log,r.composite.summary,state.data.beforeFinal,state.data.bamboo);
    }]

  ];
  try {
    persist();
    console.log('大黄蜂→火刀回收（交闪优先）→真刀装备→真刀带出妖刀→Link风刀→妖刀检索。新局：主要阶段1、空怪兽区、手牌大黄蜂和真刀。');
    if(resumeTrue)console.log('从第8步恢复：火刀已回收交闪；重新采集当前手牌并选真刀，不重放回收。');
    state.executionMode=autoRun?'AUTO':'STEP';state.timings=[];
    if(autoRun)console.log('全自动整合测试：中途无需按键；逐步确认当前目标；异常立即停止。');
    persist();
    console.log(`测试记录：${dir}`);
    while(state.next<steps.length) {
      const [name,action]=steps[state.next];
      stepDir=path.join(dir,String(state.next+1).padStart(2,'0'));fs.mkdirSync(stepDir,{recursive:true});
      console.log(`\n${state.next+1}/${steps.length} ${name}`);
      const answer=autoRun?'':(await rl.question('Enter=自动执行；R=自动重拍；Q=暂停：')).trim().toUpperCase();
      if(answer==='Q'){state.status='PAUSED';return;}
      if(!['','R'].includes(answer))continue;
      const stepStarted=process.hrtime.bigint();
      await focus();
      if(answer==='R'){await shot('recapture_'+Date.now());terminal('Restore',origin);continue;}
      state.activeStep=name;persist();
      if(!optimized||fullDebug)await shot('before');
      const actionStarted=process.hrtime.bigint();
      const proof=await action();
      const actionMs=elapsed(actionStarted);
      state.completed.push({step:state.next,name,proof,at:new Date().toISOString()});state.next++;state.activeStep=null;persist();
      await shot('after');if(!autoRun)terminal('Restore',origin);
      const timing={step:state.next,name,actionMs,totalMs:elapsed(stepStarted)};
      state.timings.push(timing);persist();
      console.log(`节点完成：${name}；动作=${(actionMs/1000).toFixed(2)}秒；本步总计=${(timing.totalMs/1000).toFixed(2)}秒`);
    }
    state.status='PASS_LIVE';persist();
    console.log(`PASS：火刀回收、真刀转换、Link风刀及妖刀检索验收通过；手牌${state.data.beforeFinal}→${state.data.beforeFinal+1}。`);
  } catch(error) {
    state.status='ERROR';state.error=String(error.stack||error);
    if(bridge&&info)await shot('STOPPED').catch(()=>{});
    throw error;
  } finally {
    state.runElapsedMs=elapsed(runStarted);
    console.log(`本次运行耗时（截至收尾前）：${(state.runElapsedMs/1000).toFixed(2)}秒`);
    persist();if(rl)rl.close();await close().catch(()=>{});
    try{terminal('Restore',origin);}catch(e){console.error(e.message);}
    console.log(`测试记录：${dir}`);
  }
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={verifyFinal,verifyConversion};
