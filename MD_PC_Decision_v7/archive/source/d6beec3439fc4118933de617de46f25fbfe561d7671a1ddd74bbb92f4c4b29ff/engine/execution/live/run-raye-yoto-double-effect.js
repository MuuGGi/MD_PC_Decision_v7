'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { recognizeCurrentCard, saveRgbaPng } = require('../../runtime/observer/scan-state');
const { withForegroundRetry } = require('./run-m06-raye-field-effect');
const { establishCurrentObserverBaseline } = require('../core/observer-current-baseline');
const { selectObservedHandCard } = require('../core/hand-target');
const { captureNeutralNormalSummonFrame, clickSelectedMonsterNormalSummon } = require('../core/hand-normal-summon');
const { clickSelectedHandSpellActivation } = require('../core/hand-spell-activation');
const { clickObservedEquipConfirm } = require('../core/field-link-target');
const { clickPreferredEquipCarrier } = require('../core/preferred-equip-carrier');
const { FULL, selectFieldRaye, clickRayeEffect, clickRayeSummonSubmit, detectRayeSubmit } = require('../core/m06-field-effect');
const { waitForSummonCandidates, selectNextLegalLink } = require('../core/link-carrier-summon');
const { selectM19FromOptionalPool } = require('../core/m19-search-execution');
const { OPTIONAL_EFFECT_PROMPT, probeOptionalEffectPrompt } = require('../core/optional-effect-prompt-observer');
const { probeSkyStrikerSearchTargetPrompt } = require('../core/sky-striker-search-target-prompt-observer');
const { BAMBOO_TARGET_PROMPT, probeBambooSearchTargetPrompt } = require('../core/bamboo-search-target-prompt-observer');
const { detectCandidateCenters } = require('../core/prompt-candidate-centers');
const { initialState, summarizeCompositeRouteState, recordCompositeKnownEvent,
  selectCompositeOptionalEffect, enterCompositeResolutionSelection, submitCompositeTargetSelection } = require('../../lib/composite-route-observer');
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
function validateFinal(hand, log, composite, count, bamboo) {
  const inserted = hand && hand.insertedCards || [];
  const gains = inserted.map(r => r.card && r.card.id).sort();
  const blocks = log && (log.newOperationBlocks || log.newActivationBlocks) || [];
  const order = blocks.map(b => b.activationKey);
  const ri = order.indexOf('M06'), yi = order.indexOf('M19'), zi = order.indexOf('E10');
  const s = composite && composite.summary || {};
  const links = s.chain && s.chain.links || [];
  const independentGains = blocks.flatMap(b => b.details || []).filter(d => d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE').map(d => d.card && d.card.id);
  if (!hand || hand.status !== 'PASS' || !hand.before || hand.before.handCount !== count ||
      !hand.after || hand.after.handCount !== count + 2 || gains.join('|') !== ['M17', bamboo].sort().join('|') ||
      !(ri >= 0 && yi > ri && zi > yi) || !independentGains.includes('M17') ||
      s.exit !== 'RAYE_EFFECT' || !/零梦|E10/.test(String(s.summon || '')) ||
      !s.chain || s.chain.status !== 'RESOLVED' || links.length !== 2 ||
      links[0].mode !== 'M19_SEARCH' || links[1].mode !== 'MONSTER_OPTIONAL' ||
      links.some(l => l.status !== 'RESOLVED') || !s.turnUsage || !s.turnUsage.m19SearchUsed) {
    throw new Error('DOUBLE_EFFECT_FINAL_NOT_CONFIRMED:需同时满足M06>M19>E10日志、两张实际入手、CL1/CL2结算及妖刀次数');
  }
  return { before: count, after: hand.after.handCount, gained: gains, chain: s.chain, order, turnUsage: s.turnUsage };
}
function equipBaselineFromObserver(hand, current) {
  if (!hand || hand.status !== 'PASS' || !hand.before || !hand.after ||
      !hand.inference || !hand.inference.consumed || hand.inference.consumed.id !== 'M06' ||
      hand.after.handCount !== hand.before.handCount - 1 || (hand.insertedCards || []).length) {
    throw new Error('EQUIP_REQUIRES_VERIFIED_NORMAL_SUMMON');
  }
  const after = hand.after;
  const ids = cards => (cards || []).map(c => c.id).join('|');
  if (!current || current.handCount !== after.handCount || ids(current.cards) !== ids(after.cards)) {
    throw new Error('EQUIP_OBSERVER_STATE_CHANGED');
  }
  const baseline = { ...current, status: 'PASS' };
  if (!baseline.cards.some(c => c.id === 'M19')) throw new Error('EQUIP_YOTO_NOT_IN_OBSERVED_HAND');
  return baseline;
}
// Route-local fallback for bright Bamboo card art. Keep the shared probe intact.
function brightBambooEvidence(probe, candidateImage, footerImage) {
  const points = detectCandidateCenters(candidateImage,BAMBOO_TARGET_PROMPT.candidateRoi,BAMBOO_TARGET_PROMPT.candidateY,{mode:'components'});
  let dark=0;
  for(let i=0;i<footerImage.data.length;i+=4) if(Math.max(footerImage.data[i],footerImage.data[i+1],footerImage.data[i+2])<92)dark++;
  const footerDark=dark/(footerImage.width*footerImage.height);
  const frames=points.length>=1 && points.length<=5 && points.every((p,i)=>
    p.width>=80 && p.width<=145 && p.x-p.width/2>=695 && p.x+p.width/2<=1355 &&
    (!i || p.x-points[i-1].x>=130 && p.x-points[i-1].x<=180));
  return {...probe,visible:probe.headerDark>=BAMBOO_TARGET_PROMPT.minHeaderDark && footerDark>=0.85 && frames,
    candidateCount:points.length,candidateCenters:points.map(p=>({x:p.x,y:p.y})),footerDark,
    detector:'RAYE_YOTO_BRIGHT_BAMBOO_HEADER_FRAMES_FOOTER_V1'};
}
async function main() {
  if (process.versions.node !== '20.11.1') throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
  const autoRun = process.argv.includes('--auto');
  const optimized = autoRun && !process.argv.includes('--no-optimize');
  const fullDebug = process.argv.includes('--full-debug');
  const runStarted = process.hrtime.bigint();
  const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;
  const base = path.join(ROOT, 'debug/execution/Raye_yoto_double_effect');
  let state = { next: 0, status: 'IN_PROGRESS', data: {}, completed: [] };
  const resumeEquip = process.argv.includes('--resume-equip');
  const resumeEquipTarget = process.argv.includes('--resume-equip-target');
  const resumeBamboo=process.argv.includes('--resume-bamboo');
  if (process.argv.includes('--resume') || resumeEquip || resumeEquipTarget || resumeBamboo) {
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    if (!dirs.length) throw new Error('DOUBLE_EFFECT_NO_RESUME');
    state = read(path.join(base, dirs[0], 'result.json'));
    if (resumeBamboo) {
      if(state.status!=='ERROR'||state.next!==8||!(state.completed||[]).some(c=>c.step===7)||
          !/^Error: TARGET_PROMPT_NOT_STABLE:M19_SEARCH(?:\r?\n|$)/.test(state.error||'')) {
        throw new Error('RESUME_BAMBOO_REQUIRES_POST_ENGAGE_WAIT_STOP');
      }
      state.data.engageSubmitted=true;
    } else if (resumeEquipTarget) {
      if (state.status !== 'ERROR' || state.next !== 2 ||
          !(state.completed || []).some(c => c.step === 1) ||
          !/^Error: M06_FIELD_FRAME_NOT_UNIQUE:0\/0(?:\r?\n|$)/.test(state.error || '')) {
        throw new Error('RESUME_EQUIP_TARGET_REQUIRES_PRE_CLICK_FRAME_STOP');
      }
    } else if (resumeEquip) {
      if (state.status !== 'ERROR' || state.next !== 1 ||
          !(state.completed || []).some(c => c.step === 0) ||
          !/DENSE_OBSERVED_WITNESS_DRIFT_TOO_LARGE/.test(state.error || '')) {
        throw new Error('RESUME_EQUIP_REQUIRES_PRE_CLICK_DRIFT_STOP');
      }
      const previousHand = state.data.normalSummonObservation || read(path.join(base, dirs[0], '01', 'hand.json'));
      state.data.normalSummonObservation = previousHand;
      if (JSON.stringify(previousHand.after) !== JSON.stringify(read(PATHS.hand).after)) {
        throw new Error('RESUME_EQUIP_OBSERVER_CHANGED');
      }
    } else if (state.status !== 'PAUSED') throw new Error('DOUBLE_EFFECT_RESUME_REQUIRES_Q_CHECKPOINT:异常现场先发日志，不重放未完成动作');
  }
  const dir = path.join(base, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  state.status = 'IN_PROGRESS';
  const persist = () => write(path.join(dir, 'result.json'), state);
  const origin = terminal('Capture');
  const rl = autoRun ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
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
  function record(event) {
    return recordCompositeKnownEvent({ rootDir: ROOT, event, source: 'AUTOMATIC_RAYE_YOTO_UI_EVIDENCE' });
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
  function poolEvent(proof) { record({ kind: 'OPTIONAL_EFFECT', mode: 'AVAILABLE', candidateCount: proof.candidateCount, detector: proof.detector }); }
  function targetEvent(mode, p) {
    record({ kind: 'EFFECT_TARGET_SELECTION', mode: 'AVAILABLE', effectMode: mode, candidateCount: p.candidateCount,
      allowedTargets: p.allowedTargets, detector: p.detector });
  }
  async function selectOptionalZero() {
    const im = await captureReferenceRoi(bridge, info, OPTIONAL_EFFECT_PROMPT.candidateRoi);
    const points = detectCandidateCenters(im, OPTIONAL_EFFECT_PROMPT.candidateRoi, OPTIONAL_EFFECT_PROMPT.candidateY, { mode: 'components' });
    if (points.length!==1) throw new Error('DOUBLE_EFFECT_REMAINING_POOL_NOT_SINGLE');
    await click(points[0]); const card = await identify('E10'); await sleep(600); return card;
  }
  async function chooseEngage(p) {
    for (const point of p.candidateCenters.slice().sort((a,b)=>b.x-a.x)) {
      await click(point); const card=await identify();
      console.log(`零梦检索候选：${card.name}[${card.id}]`);
      if (card.id==='M17') { await sleep(600); return card; }
      await click(point);
    }
    throw new Error('DOUBLE_EFFECT_ENGAGE_NOT_FOUND');
  }
  const steps = [
    ['新局建立基线，自动通常召唤零衣并验收', async () => {
      const baseline = await establishCurrentObserverBaseline({ ...opts(), outputDir: stepDir });
      if (!['M06','M19'].every(id=>baseline.cards.some(c=>c.id===id))) throw new Error('NEED_RAYE_AND_YOTO_IN_HAND');
      if (baseline.handCount>12) throw new Error('HAND_COUNT_UNSUPPORTED');
      // User explicitly prepared a fresh duel. Archive previous bookkeeping,
      // then start this route with the mature empty composite state.
      for (const key of ['composite','compositeState','decision']) if(fs.existsSync(PATHS[key])) fs.copyFileSync(PATHS[key],path.join(stepDir,'previous_'+key+'.json'));
      const empty=initialState(); write(PATHS.compositeState,empty); write(PATHS.composite,{state:empty,summary:summarizeCompositeRouteState(empty)});
      const reset=spawnSync(process.execPath,[path.join(ROOT,'tools/reset-duel-state.js')],{cwd:ROOT,stdio:'inherit',windowsHide:true});
      if(reset.error||reset.status!==0) throw new Error('NEW_DUEL_RESET_FAILED');
      state.data.initialCount=baseline.handCount;
      const neutralFrame=await captureNeutralNormalSummonFrame(opts());
      const selected=await selectObservedHandCard({...opts(),baseline,expectedId:'M06'});
      await clickSelectedMonsterNormalSummon({...opts(),expectedId:'M06',expectedName:'闪刀姬－零衣',clickReference:selected.clickReference,neutralFrame});
      await sleep(1500);
      const r=await observe();
      if(r.hand.status!=='PASS'||r.hand.after.handCount!==baseline.handCount-1||!r.hand.inference.consumed||r.hand.inference.consumed.id!=='M06'||!(r.composite.summary.materialSources||[]).includes('RAYE_NORMAL_SUMMON'))throw new Error('NORMAL_SUMMON_NOT_VERIFIED');
      state.data.normalSummonObservation = r.hand;
      return {before:baseline.handCount,after:r.hand.after.handCount};
    }],
    ['从当前真实手牌发动妖刀竹光', async () => {
      const hand = read(PATHS.hand);
      const current = read(path.join(ROOT,'debug/hand-change-live/session_state.json'));
      const baseline = equipBaselineFromObserver(hand,current);
      console.log(`复用通招后的observer手牌：${baseline.handCount}张；仅定位并确认妖刀。`);
      state.data.beforeEquip=baseline.handCount;
      // Like normal summon, clear the last inspected/hovered hand card before
      // asking the unchanged mature locator to reuse its recorded window.
      // ESC alone leaves the raised card title outside the DENSE title ROI.
      await captureNeutralNormalSummonFrame(opts());
      const selected=await selectObservedHandCard({...opts(),baseline,expectedId:'M19'});
      await sleep(600);
      const proof=await clickSelectedHandSpellActivation({...opts(),expectedId:'M19',expectedName:'妖刀竹光',clickReference:selected.clickReference});
      await sleep(700); return proof;
    }],
    ['复用成熟装备入口选择零衣并确认卡名', async () => {
      const selected=await clickPreferredEquipCarrier({...opts(),label:'妖刀装备零衣',afterIdentityMs:600});
      if (!selected.recognized || !selected.recognized.accepted || selected.recognized.id !== 'M06') {
        throw new Error('YOTO_EQUIP_TARGET_NOT_RAYE:保留选中现场，不点击确认');
      }
      state.data.carrierAnchor=selected.clickReference;
      return {anchor:selected.clickReference,identity:selected.recognized,source:selected.source};
    }],
    ['点击蓝色装备确认，等待并验收妖刀装备', async () => {
      await identify('M06');
      const proof=await clickObservedEquipConfirm({...opts(),anchorReference:state.data.carrierAnchor});
      await sleep(1400);
      const r=await observe();
      if(r.hand.status!=='PASS'||r.hand.after.handCount!==state.data.beforeEquip-1||!r.hand.inference.consumed||r.hand.inference.consumed.id!=='M19'||r.composite.summary.equip!=='M19_FROM_HAND')throw new Error('YOTO_EQUIP_NOT_VERIFIED');
      state.data.beforeFinal=r.hand.after.handCount;
      return {proof,afterEquip:state.data.beforeFinal};
    }],
    ['选择已装备妖刀的零衣，发动零衣自身效果', async () => {
      const selected=await selectFieldRaye(opts());
      const proof=await clickRayeEffect({...opts(),...selected});
      await sleep(1100);
      // The next automatic step performs the full stable-frame check before clicking.
      const prompt=optimized ? null : await waitForSummonCandidates(opts());
      return {proof,prompt};
    }],
    ['从右向左选择零梦并提交，停在双效果池', async () => {
      const p=await waitForSummonCandidates(opts());
      const selected=await selectNextLegalLink({...opts(),carrierId:'M06',promptProof:{...p,points:p.points.slice().sort((a,b)=>b.x-a.x)},excludedLinkIds:['E02','E03','E04','E05','E06','E07','E08','E09']});
      if(selected.selected.id!=='E10')throw new Error('EXPECTED_ZERO');
      // Mature selection already confirms E10 and waits 600 ms.
      if (!optimized) { await identify('E10');await sleep(600); }
      await clickRayeSummonSubmit(opts());await sleep(1800);
      const pool=await waitPool(2);
      // As in the mature R3B workflow, record executed route facts and the
      // observed prompt now; final acceptance still requires independent log
      // ordering, the real hand gains and the fully resolved chain.
      record({kind:'MATERIAL_EXIT',mode:'RAYE_EFFECT',materialCount:1,inferred:true});
      record({kind:'SUMMON_RESULT',mode:'RAYE_EFFECT',cardId:'E10',cardName:'闪刀姬－零梦',inferred:true});
      poolEvent(pool);return {selected:selected.selected,pool};
    }],
    ['选择妖刀效果作为CL1，保留剩余零梦效果', async () => {
      await waitPool(2);
      const proof=await selectM19FromOptionalPool(opts());
      selectCompositeOptionalEffect({rootDir:ROOT,effectMode:'M19_SEARCH',chainBuild:true,requiresResolutionSelection:true,source:'AUTO_CONFIRMED_M19_CL1'});
      await sleep(600);const pool=await waitPool(1);poolEvent(pool);return {proof,pool};
    }],
    ['选择零梦效果作为CL2，进入零梦检索窗口', async () => {
      await waitPool(1);const card=await selectOptionalZero();
      await submit(1022,'zero_cl2');
      selectCompositeOptionalEffect({rootDir:ROOT,effectMode:'MONSTER_OPTIONAL',chainBuild:true,requiresResolutionSelection:true,source:'AUTO_CONFIRMED_E10_CL2'});
      await sleep(1000);const p=await waitTarget('MONSTER_OPTIONAL');
      enterCompositeResolutionSelection({rootDir:ROOT,effectMode:'MONSTER_OPTIONAL',resolvedBefore:[]});targetEvent('MONSTER_OPTIONAL',p);
      return {card,p};
    }],
    ['零梦先检索交闪并提交，等待妖刀检索窗口', async () => {
      let card=state.data.engageCard || null;
      if(!state.data.engageSubmitted) {
        const p=await waitTarget('MONSTER_OPTIONAL');card=await chooseEngage(p);
        await submit(870,'engage_confirm');
        submitCompositeTargetSelection({rootDir:ROOT,effectMode:'MONSTER_OPTIONAL',cardId:card.id,cardName:card.name,source:'AUTO_E10_TARGET_SUBMIT'});
        state.data.engageSubmitted=true;state.data.engageCard=card;persist();
        await sleep(1200);
      } else console.log('交闪已提交：只检测妖刀检索窗口，不重放交闪操作。');
      const bamboo=await waitTarget('M19_SEARCH');
      enterCompositeResolutionSelection({rootDir:ROOT,effectMode:'M19_SEARCH',resolvedBefore:['MONSTER_OPTIONAL']});targetEvent('M19_SEARCH',bamboo);
      return {card,bamboo};
    }],
    ['妖刀检索竹光并提交：优先真刀，缺少时金黄色竹光', async () => {
      // selectRouteBamboo performs the same full stable-window check itself.
      if (!optimized) await waitTarget('M19_SEARCH');
      const proof=await selectRouteBamboo();
      state.data.bamboo=proof.selected.id;
      submitCompositeTargetSelection({rootDir:ROOT,effectMode:'M19_SEARCH',cardId:proof.selected.id,cardName:proof.selected.name,source:'AUTO_M19_TARGET_SUBMIT'});
      await sleep(1600);return proof;
    }],
    ['正式observer最终验收双效果路线', async () => {
      const optional=await probeOptionalEffectPrompt({bridge,info,debugDir:stepDir});
      const target=await probeRouteBamboo();
      if(optional.visible||target.visible)throw new Error('DIALOG_STILL_OPEN_NO_RESET');
      const r=await observe();
      return validateFinal(r.hand,r.log,r.composite,state.data.beforeFinal,state.data.bamboo);
    }]
  ];
  try {
    persist();
    console.log('零衣→妖刀→零梦双效果测试。新局要求：主要阶段1，手牌有零衣和妖刀，尚未通招；不需要手动点击游戏。');
    if (resumeBamboo) console.log('恢复妖刀检索窗口：交闪已提交，不重复选择。');
    if (resumeEquip) console.log('从第2步恢复：零衣已通招，仅继续发动妖刀。');
    if (resumeEquipTarget) console.log('从第3步恢复：妖刀已发动，仅选择装备对象，不重复发动。');
    if(autoRun)console.log('全自动整合测试：中途无需按键，执行到最终observer验收；异常立即停止并保留现场。');
    state.executionMode=autoRun?'AUTO':'STEP';
    state.optimized=optimized;state.timings=[];
    if(optimized)console.log('提速模式：合并重复确认；保留每步完成截图、核心识别素材和失败现场。');
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
      if(!optimized || fullDebug)await shot('before');
      const actionStarted=process.hrtime.bigint();
      const proof=await action();
      const actionMs=elapsed(actionStarted);
      state.completed.push({step:state.next,name,proof,at:new Date().toISOString()});state.next++;state.activeStep=null;persist();
      await shot('after');if(!autoRun)terminal('Restore',origin);
      const timing={step:state.next,name,actionMs,totalMs:elapsed(stepStarted)};
      state.timings.push(timing);persist();
      console.log(`节点完成：${name}；动作=${(timing.actionMs/1000).toFixed(2)}秒；本步总计=${(timing.totalMs/1000).toFixed(2)}秒`);
    }
    state.status='PASS_LIVE';persist();
    console.log(`PASS：双效果逆序结算，交闪和${state.data.bamboo==='M20'?'真刀竹光':'金黄色的竹光'}入手；手牌${state.data.beforeFinal}→${state.data.beforeFinal+2}。`);
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
module.exports={validateFinal,equipBaselineFromObserver,brightBambooEvidence};
