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
const { FULL, detectRayeSubmit } = require('../core/m06-field-effect');
const { withForegroundRetry } = require('./run-m06-raye-field-effect');
const { OPTIONAL_EFFECT_PROMPT, probeOptionalEffectPrompt } = require('../core/optional-effect-prompt-observer');
const { probeSkyStrikerSearchTargetPrompt } = require('../core/sky-striker-search-target-prompt-observer');
const { detectCandidateCenters } = require('../core/prompt-candidate-centers');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function latest(base) {
  const names = fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort().reverse();
  if (!names.length) throw new Error('M06_SEARCH_PREVIOUS_ATTEMPT_MISSING');
  return path.join(base, names[0]);
}
function terminal(mode, original) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'execution/core/m06-terminal-focus.ps1'), '-Mode', mode];
  if (original) args.push('-WindowHandle', original.handle, '-ExpectedProcessId', String(original.processId));
  const out = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (out.error || out.status !== 0) throw new Error(`TERMINAL_FOCUS_FAILED:${out.error || out.stderr}`);
  return JSON.parse(out.stdout.trim());
}
function validateObserverResult(hand, composite, before, target, log) {
  const rows = hand && hand.insertedCards || [];
  const summary = composite && composite.summary || {};
  const blocks = log && (log.newOperationBlocks || log.newActivationBlocks) || [];
  const e10Gain = blocks.some(b => b.activationKey === 'E10' && (b.details || []).some(d =>
    d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE' && d.card && d.card.id === target));
  if (!hand || hand.status !== 'PASS' || !hand.before || hand.before.handCount !== before ||
      !hand.after || hand.after.handCount !== before + 1 || rows.length !== 1 ||
      !rows[0].card || rows[0].card.id !== target || !e10Gain ||
      summary.exit !== 'RAYE_EFFECT' || !/零梦|E10/.test(String(summary.summon || ''))) {
    throw new Error('M06_ZERO_SEARCH_OBSERVER_NOT_CONFIRMED:需同时确认零衣效果离场、零梦登场及所选卡净增1');
  }
  return { before, after: hand.after.handCount, gained: rows[0].card, exit: summary.exit, summon: summary.summon };
}
async function main() {
  if (process.versions.node !== '20.11.1') throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
  const base = path.join(ROOT, 'debug/execution/M06_zero_search');
  let state;
  if (process.argv.includes('--resume')) {
    state = read(path.join(latest(base), 'result.json'));
    if (state.pendingInput || state.uncommittedSelection || !['STOPPED', 'ERROR'].includes(state.status) || state.phase >= 5) throw new Error('SEARCH_RESUME_NOT_ALLOWED');
  } else {
    const prior = latest(path.join(ROOT, 'debug/execution/M06_raye_field_effect'));
    if (read(path.join(prior, 'result.json')).status !== 'REACHED_OPTIONAL_PROMPT_PENDING_OBSERVER') throw new Error('M06_SEARCH_REQUIRES_POST_SUMMON_PROMPT');
    const hand = read(path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json'));
    if (!hand.after || !Number.isInteger(hand.after.handCount)) throw new Error('M06_SEARCH_HAND_BASELINE_MISSING');
    state = { phase: 0, target: 'M17', beforeCount: hand.after.handCount, source: prior, stages: [] };
  }
  const dir = path.join(base, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const origin = terminal('Capture');
  const bridge = new MdFastBridge();
  let bridgeStopRequested = false;
  let bridgeStopPromise = null;
  function stopBridge() {
    if (!bridgeStopRequested) {
      bridgeStopRequested = true;
      bridgeStopPromise = bridge.stop();
    }
    return bridgeStopPromise;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const persist = () => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(state, null, 2), 'utf8');
  let info, serial = 0;
  state.status = 'IN_PROGRESS';
  async function focus() {
    await withForegroundRetry(async () => {
      info = (await activateAndVerifyMasterDuel(bridge)).info;
      await sleep(300);
      const current = await bridge.info();
      if (JSON.stringify(current.client) !== JSON.stringify(info.client)) throw new Error('SEARCH_CLIENT_MOVED');
      info = current;
    }, async () => { await bridge.activateMasterDuel(); await sleep(300); });
  }
  async function snapshot(label) {
    saveRgbaPng(await captureReferenceRoi(bridge, info, FULL), path.join(dir, `${++serial}_${label}.png`));
  }
  async function pause(message) {
    console.log('\n' + message);
    while (true) {
      const answer = (await rl.question('Enter=自动执行；R=自动重拍；Q=退出：')).trim().toUpperCase();
      if (answer === 'Q') { state.status = 'STOPPED'; return false; }
      if (!['', 'R'].includes(answer)) continue;
      await focus();
      if (answer === 'R') { await snapshot('recapture'); terminal('Restore', origin); continue; }
      return true;
    }
  }
  async function click(point, label) {
    state.pendingInput = label; persist();
    try {
      await withForegroundRetry(async () => {
        const p = mapReferencePoint(info, point);
        await bridge.click(p.x, p.y);
      }, focus);
      state.pendingInput = null;
      if (['select_zero_effect', 'inspect_target'].includes(label)) state.uncommittedSelection = true;
      if (label === 'deselect_non_target') state.uncommittedSelection = false;
      persist();
    } catch (error) { throw error; }
  }
  async function identity() {
    const raw = await withForegroundRetry(() => recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 }), focus);
    const j = raw && raw.judged;
    if (!j || !j.accepted || !j.best) throw new Error('SEARCH_CARD_IDENTITY_UNCONFIRMED');
    return j.best;
  }
  async function finish(phase, name, proof) {
    state.uncommittedSelection = false;
    state.phase = phase; state.stages.push({ name, proof }); persist();
    await snapshot(name); terminal('Restore', origin);
  }
  async function submit(x, label) {
    const roi = { x, y: 1050, width: 310, height: 90 };
    let previous = null;
    for (let i = 0; i < 8; i++) {
      const im = await withForegroundRetry(() => captureReferenceRoi(bridge, info, roi), focus);
      saveRgbaPng(im, path.join(dir, `${label}_${i}.png`));
      const p = detectRayeSubmit(im);
      if (p.visible && previous && previous.visible && Math.hypot(p.centerX-previous.centerX,p.centerY-previous.centerY)<5) {
        const point = { x: x + p.centerX, y: 1050 + p.centerY };
        await click(point, label); return point;
      }
      previous = p; await sleep(180);
    }
    throw new Error(`${label}_BUTTON_NOT_PROVEN:保留选中卡，不重复点卡`);
  }
  let library, templates;
  try {
    await bridge.start(); persist();
    library = loadLibrary(ROOT); templates = await loadTemplates(ROOT, library);
    console.log(`零梦检索自动测试：固定检索交闪。记录：${dir}`);
    if (state.phase === 0) {
      if (!await pause('1/5 点击效果池中的零梦，确认卡名。')) return;
      const pool = await probeOptionalEffectPrompt({ bridge, info, debugDir: dir });
      if (!pool.visible || pool.candidateCount !== 1) throw new Error('SEARCH_EXPECT_SINGLE_ZERO_OPTIONAL');
      const roi = OPTIONAL_EFFECT_PROMPT.candidateRoi;
      const im = await captureReferenceRoi(bridge, info, roi);
      const points = detectCandidateCenters(im, roi, OPTIONAL_EFFECT_PROMPT.candidateY, { mode: 'components' });
      if (points.length !== 1) throw new Error('SEARCH_OPTIONAL_FRAME_NOT_UNIQUE');
      await click(points[0], 'select_zero_effect');
      const card = await identity();
      if (card.id !== 'E10') throw new Error(`SEARCH_EXPECT_E10:${card.id}`);
      await sleep(600);
      await finish(1, 'zero_effect_selected', card);
    }
    if (state.phase === 1) {
      if (!await pause('2/5 点击右侧“选择”，发动零梦检索效果。')) return;
      if ((await identity()).id !== 'E10') throw new Error('SEARCH_SELECTED_ZERO_CHANGED');
      await sleep(600);
      const point = await submit(1022, 'activate_zero_effect');
      // Commit before waiting so a timeout never repeats the effect activation.
      state.phase = 2; persist();
      await sleep(1000);
      await finish(2, 'zero_effect_submitted', point);
    }
    if (state.phase === 2) {
      if (!await pause('3/5 检测检索窗口，按真实卡框从右向左寻找交闪。')) return;
      let prompt = null;
      for (let i = 0; i < 12; i++) {
        prompt = await probeSkyStrikerSearchTargetPrompt({ bridge, info, debugDir: dir, suffix: String(i) });
        if (prompt.visible) break;
        await sleep(250);
      }
      if (!prompt || !prompt.visible) throw new Error('ZERO_SEARCH_TARGET_PROMPT_NOT_VISIBLE');
      let chosen = null;
      for (const point of prompt.candidateCenters.slice().sort((a,b) => b.x-a.x)) {
        await click(point, 'inspect_target'); await sleep(350);
        const card = await identity();
        console.log(`检索候选：${card.name}[${card.id}]`);
        if (card.id === state.target) { chosen = { point, card }; break; }
        await click(point, 'deselect_non_target'); await sleep(200);
      }
      if (!chosen) throw new Error('ZERO_SEARCH_ENGAGE_NOT_FOUND:本测试不擅自改选其他卡');
      await sleep(600); await finish(3, 'engage_selected', chosen);
    }
    if (state.phase === 3) {
      if (!await pause('4/5 点击居中的确认按钮，等待交闪入手。')) return;
      if ((await identity()).id !== state.target) throw new Error('ZERO_SEARCH_SELECTED_TARGET_CHANGED');
      await sleep(600);
      const point = await submit(870, 'submit_search_target');
      state.phase = 4; persist(); await sleep(1800);
      await finish(4, 'search_submitted', point);
    }
    if (state.phase === 4) {
      if (!await pause('5/5 运行正式observer，核对零衣离场、零梦登场和交闪入手。')) return;
      const optional = await probeOptionalEffectPrompt({ bridge, info, debugDir: dir, suffix: 'before_observer' });
      const target = await probeSkyStrikerSearchTargetPrompt({ bridge, info, debugDir: dir, suffix: 'before_observer' });
      if (optional.visible || target.visible) throw new Error('SEARCH_DIALOG_STILL_OPEN:不运行会复位窗口的observer');
      await stopBridge();
      const started = Date.now();
      const out = spawnSync(process.execPath, [
        path.join(ROOT, 'runtime/observer/run-live-incremental.js'),
        '--adjacent-checkpoint-only'
      ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      if (out.error || out.status !== 0) throw new Error(`ZERO_SEARCH_OBSERVER_FAILED:${out.error || out.status}`);
      const paths = ['debug/hand-change-live/latest_incremental_result.json', 'debug/composite-route-live/latest_result.json', 'debug/duel-log-live/latest_result.json'].map(p => path.join(ROOT,p));
      if (paths.some(p => fs.statSync(p).mtimeMs < started - 1000)) throw new Error('ZERO_SEARCH_OBSERVER_RESULT_STALE');
      state.verification = validateObserverResult(read(paths[0]), read(paths[1]), state.beforeCount, state.target, read(paths[2]));
      state.phase = 5; state.status = 'PASS_LIVE'; persist();
      console.log(`PASS：零衣效果→零梦→交闪入手；手牌${state.beforeCount}→${state.beforeCount+1}。`);
    }
  } catch (error) {
    state.status = 'ERROR'; state.error = String(error.stack || error);
    if (info && !bridgeStopRequested) await snapshot('STOPPED').catch(()=>{});
    throw error;
  } finally {
    persist(); rl.close(); await stopBridge().catch(()=>{});
    try { terminal('Restore',origin); } catch(e) { console.error(e.message); }
    console.log(`测试记录：${dir}`);
  }
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode=1; });
module.exports = { validateObserverResult };
