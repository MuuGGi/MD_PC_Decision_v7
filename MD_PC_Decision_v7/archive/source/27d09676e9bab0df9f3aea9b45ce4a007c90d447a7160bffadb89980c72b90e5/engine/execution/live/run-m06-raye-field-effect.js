'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '..', '..');
const { MdFastBridge, captureReferenceRoi, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');
const { FULL, selectFieldRaye, clickRayeEffect, identifyCurrent } = require('../core/m06-field-effect');
const { waitForSummonCandidates, selectNextLegalLink } = require('../core/link-carrier-summon');
const { clickRayeSummonSubmit } = require('../core/m06-field-effect');
const { probeOptionalEffectPrompt } = require('../core/optional-effect-prompt-observer');

function terminalFocus(mode, original) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'execution', 'core', 'm06-terminal-focus.ps1'), '-Mode', mode];
  if (original) args.push('-WindowHandle', original.handle, '-ExpectedProcessId', String(original.processId));
  const out = spawnSync('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (out.error || out.status !== 0) throw new Error(`M06_TERMINAL_FOCUS_FAILED:${out.error || out.stderr}`);
  return JSON.parse(out.stdout.trim());
}

function isForegroundGuard(error) {
  return String(error && error.message || '').startsWith('Foreground window is not Master Duel. Current title:');
}

async function withForegroundRetry(action, refocus) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      // md-server rejects this exact error BEFORE executing the command.
      // Timeouts, identity failures and unknown click errors are never retried.
      if (!isForegroundGuard(error) || attempt >= 2) throw error;
      console.log('前台检查未通过，自动切回游戏后重试未执行的操作。');
      await refocus();
    }
  }
}

function requireEntryState() {
  const file = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');
  if (!fs.existsSync(file)) throw new Error('M06_ENTRY_MISSING:先完成零衣通常召唤测试');
  const summary = JSON.parse(fs.readFileSync(file, 'utf8')).summary;
  if (!summary || summary.phase !== 'MATERIAL_READY' || summary.equip !== 'NONE' ||
      !(summary.materialSources || []).includes('RAYE_NORMAL_SUMMON')) {
    throw new Error('M06_ENTRY_NOT_READY:需要刚通招成功、未装刀、未离场的零衣');
  }
  return summary;
}

async function main() {
  if (process.versions.node !== '20.11.1') throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
  const entry = requireEntryState();
  let resumed = null;
  let resumeSubmit = null;
  if (process.argv.includes('--resume-effect') && process.argv.includes('--resume-submit')) throw new Error('M06_RESUME_FLAGS_CONFLICT');
  if (process.argv.includes('--resume-submit')) {
    const base = path.join(ROOT, 'debug', 'execution', 'M06_raye_field_effect');
    const names = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    if (!names.length) throw new Error('M06_RESUME_NO_ATTEMPT');
    const previous = JSON.parse(fs.readFileSync(path.join(base, names[0], 'result.json'), 'utf8'));
    const node = (previous.stages || []).find(s => s.name === '03_e10_selected');
    if (!node || !node.proof || !node.proof.selected || node.proof.selected.id !== 'E10' ||
        (previous.stages || []).some(s => s.name === 'summon_submitted') ||
        !['STOPPED_ON_ERROR', 'STOPPED_BY_USER'].includes(previous.status)) throw new Error('M06_RESUME_SUBMIT_NOT_ALLOWED');
    resumeSubmit = { node, source: path.join(base, names[0]) };
  }
  if (process.argv.includes('--resume-effect')) {
    const base = path.join(ROOT, 'debug', 'execution', 'M06_raye_field_effect');
    const names = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    if (!names.length) throw new Error('M06_RESUME_NO_ATTEMPT');
    const previousDir = path.join(base, names[0]);
    const previous = JSON.parse(fs.readFileSync(path.join(previousDir, 'result.json'), 'utf8'));
    const node = (previous.stages || []).find(s => s.name === '01_raye_selected');
    if (!node || (previous.stages || []).some(s => s.name === 'effect_clicked') ||
        !['STOPPED_ON_ERROR', 'STOPPED_BY_USER'].includes(previous.status)) {
      throw new Error('M06_RESUME_NOT_AT_SELECTED_RAYE:只允许恢复最近一次尚未发动的已选零衣');
    }
    resumed = { ...node.proof, neutral: PNG.sync.read(fs.readFileSync(path.join(previousDir, 'before_select_full.png'))), source: previousDir };
  }
  const terminal = terminalFocus('Capture');
  const dir = path.join(ROOT, 'debug', 'execution', 'M06_raye_field_effect', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const state = { status: 'IN_PROGRESS', entry, target: 'E10', stages: [], observerCommitted: false };
  const persist = () => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(state, null, 2), 'utf8');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const bridge = new MdFastBridge();
  let info;
  let shot = 0;
  async function focus() {
    for (let attempt = 0; ; attempt++) {
      try {
        const activation = await activateAndVerifyMasterDuel(bridge);
        await sleep(300);
        const check = await bridge.info();
        await sleep(200);
        const stable = await bridge.info();
        if (JSON.stringify(check.client) !== JSON.stringify(stable.client) ||
            JSON.stringify(activation.info.client) !== JSON.stringify(stable.client)) throw new Error('M06_GAME_CLIENT_MOVED');
        info = stable;
        return;
      } catch (error) {
        if (!isForegroundGuard(error) || attempt >= 2) throw error;
        console.log('游戏前台尚未稳定，重新激活，不点击卡牌。');
        await sleep(250);
      }
    }
  }
  async function snapshot(label) {
    const image = await captureReferenceRoi(bridge, info, FULL);
    saveRgbaPng(image, path.join(dir, `${String(++shot).padStart(2, '0')}_${label}.png`));
  }
  async function checkpoint(text) {
    console.log(`\n${text}`);
    while (true) {
      const answer = (await rl.question('Enter=自动切回游戏并执行下一步；R=自动切回重拍；Q=退出：')).trim().toUpperCase();
      if (answer === 'Q') { state.status = 'STOPPED_BY_USER'; return false; }
      if (answer !== '' && answer !== 'R') continue;
      await focus();
      if (answer === 'R') { await snapshot('recapture'); terminalFocus('Restore', terminal); console.log('已重拍并返回终端。'); continue; }
      return true;
    }
  }
  async function completed(name, proof) {
    state.stages.push({ name, completedAt: new Date().toISOString(), proof });
    persist();
    await snapshot(name);
    terminalFocus('Restore', terminal);
    console.log(`节点完成：${name}。已返回终端，按Enter继续。`);
  }
  try {
    await bridge.start();
    persist();
    console.log('零衣场上效果分步自动测试：不装刀；固定测试目标零梦[E10]。');
    console.log('所有游戏操作和截图由脚本完成。后续效果窗口出现后保留现场，不运行会复位窗口的observer。');
    console.log(`素材目录：${dir}`);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const options = () => ({ bridge, info, library, templates, debugDir: dir });
    if (resumeSubmit) {
      state.stages.push({ ...resumeSubmit.node, resumedFrom: resumeSubmit.source });
      persist();
      console.log('恢复已选零梦：跳过发动和选卡，只验证并提交当前选择按钮。');
    } else {
    let selected;
    if (resumed) {
      selected = resumed;
      saveRgbaPng(selected.neutral, path.join(dir, 'before_select_full.png'));
      state.stages.push({ name: '01_raye_selected', proof: { anchor: selected.anchor, identity: selected.identity }, resumedFrom: resumed.source });
      persist();
      console.log('恢复已选中的零衣：跳过点卡，当前卡名仍会重新识别，只处理发动按钮。');
    } else {
      if (!await checkpoint('1/4 识别并点击场上零衣，确认卡名。')) return;
      selected = await selectFieldRaye(options());
      await completed('01_raye_selected', { anchor: selected.anchor, identity: selected.identity });
    }

    if (!await checkpoint('2/4 自动点击零衣发动效果，纯等待额外候选窗口。')) return;
    const activation = await clickRayeEffect({ ...options(), ...selected });
    state.stages.push({ name: 'effect_clicked', proof: activation });
    persist();
    await sleep(1000);
    const prompt = await waitForSummonCandidates(options());
    await completed('02_extra_candidates', { activation, prompt });

    if (!await checkpoint('3/4 复用真实候选卡框，逐张识别并选中零梦。')) return;
    // Recapture current physical layout after foreground switching.
    const currentPrompt = await waitForSummonCandidates(options());
    const choice = await selectNextLegalLink({
      ...options(), carrierId: 'M06', promptProof: { ...currentPrompt, points: currentPrompt.points.slice().sort((a, b) => b.x - a.x) },
      excludedLinkIds: ['E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09']
    });
    if (!choice.selected || choice.selected.id !== 'E10') throw new Error('M06_E10_NOT_SELECTED');
    await completed('03_e10_selected', choice);
    }

    if (!await checkpoint('4/4 自动提交零梦，等待召唤；检测后续效果窗口并停止。')) return;
    await withForegroundRetry(() => identifyCurrent(options(), 'E10'), focus);
    await sleep(600);
    const submit = await withForegroundRetry(() => clickRayeSummonSubmit(options()), focus);
    state.stages.push({ name: 'summon_submitted', proof: submit });
    persist();
    await sleep(1800);
    let last = null;
    let stable = 0;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const probe = await probeOptionalEffectPrompt({ bridge, info, debugDir: dir, suffix: `post_${attempt}` });
      stable = probe.visible && last && last.visible && probe.candidateCount === last.candidateCount ? stable + 1 : (probe.visible ? 1 : 0);
      last = probe;
      if (stable >= 2) break;
      await sleep(250);
    }
    if (!last || !last.visible || stable < 2) throw new Error('M06_POST_SUMMON_PROMPT_NOT_PROVEN:已保存现场，不猜位置/表示形式按钮');
    await completed('04_post_summon_prompt', last);
    state.status = 'REACHED_OPTIONAL_PROMPT_PENDING_OBSERVER';
    console.log('已到达后续效果窗口，保持窗口不动。本段操作素材已保存；正式日志验收和后续效果处理尚未完成，不登记整条路线PASS。');
  } catch (error) {
    state.status = 'STOPPED_ON_ERROR';
    state.error = String(error.stack || error);
    // Reuse current focus. Never reset, ESC, or retry an already submitted action.
    if (info) await snapshot('STOPPED').catch(() => {});
    throw error;
  } finally {
    persist();
    rl.close();
    await bridge.stop().catch(() => {});
    try { terminalFocus('Restore', terminal); } catch (error) { console.error(error.message); }
    console.log(`测试记录：${dir}`);
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { requireEntryState, isForegroundGuard, withForegroundRetry };
