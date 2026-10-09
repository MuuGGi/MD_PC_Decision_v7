'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const D1_SCRIPT = path.join(ROOT, 'execution', 'tests', 'run-m19-equip-existing-link.js');
const D1_ROOT = path.join(ROOT, 'debug', 'execution', 'D1_m19_equip_existing_link');
const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { captureObservedOwnLink } = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));
const {
  clickExtraDeckSummonButton,
  waitForSummonCandidates,
  selectNextLegalLink,
  clickBottomSummonSubmit,
  proveCarrierMaterialSelectable,
  clickCarrierMaterial,
  clickMaterialBlueConfirm,
  waitForPostLinkOptionalPool
} = require(path.join(ROOT, 'execution', 'core', 'link-carrier-summon'));


const resumeEquipped = process.argv.slice(2).includes('--resume-equipped');

function assertSupportedNode() {
  const actual = String(process.versions.node || '');
  if (actual !== '20.11.1') {
    throw new Error(`NODE_VERSION_MISMATCH:${actual || 'UNKNOWN'};本测试固定要求 Node v20.11.1。`);
  }
  console.log('Node运行时: v20.11.1 PASS');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function latestD1Pass() {
  if (!fs.existsSync(D1_ROOT)) return null;
  const rows = fs.readdirSync(D1_ROOT, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => {
      const dir = path.join(D1_ROOT, x.name);
      const resultPath = path.join(dir, 'result.json');
      if (!fs.existsSync(resultPath)) return null;
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const stat = fs.statSync(resultPath);
        return { dir, resultPath, result, mtimeMs: stat.mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .filter(x => x.result && x.result.status === 'PASS_CANDIDATE')
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows[0] || null;
}

async function activateGameAndGetInfo(bridge) {
  const activation = await activateAndVerifyMasterDuel(bridge);
  return activation.info;
}

async function saveNode(bridge, info, attemptDir, label, extra = null) {
  const dir = path.join(attemptDir, 'nodes');
  ensureDir(dir);
  const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
  saveRgbaPng(image, path.join(dir, `${label}.png`));
  writeJson(path.join(dir, `${label}.json`), {
    capturedAt: new Date().toISOString(),
    label,
    extra
  });
  console.log(`节点已保存: ${label}`);
}

async function checkpoint(rl, { prompt, bridge, infoGetter, attemptDir, label, extra = null }) {
  let retry = 0;
  while (true) {
    const answer = (await rl.question(prompt)).trim().toUpperCase();
    if (answer === 'Q') return 'QUIT';
    if (answer === 'R') {
      retry++;
      const info = await infoGetter();
      await saveNode(bridge, info, attemptDir, `${label}_R${retry}`, extra);
      console.log('R只重拍当前节点，不向游戏输入。');
      continue;
    }
    if (!answer) return 'ENTER';
    console.log('只接受 Enter / R / Q。');
  }
}

function runD1() {
  console.log('\n============================================================');
  console.log('D2前半段直接复用已经PASS的D1：妖刀装备当前已有Link。');
  console.log('D1完成后，本测试继续进入carrier Link；不会重新写D1逻辑。');
  console.log('============================================================\n');
  const out = spawnSync(process.execPath, [D1_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`D2_D1_PREREQUISITE_FAILED:exit=${out.status || 1}`);
}

async function main() {
  assertSupportedNode();
  if (!fs.existsSync(D1_SCRIPT)) {
    throw new Error('D2_REQUIRES_D1_PATCH:缺少 execution/live/run-m19-equip-existing-link.js');
  }

  if (resumeEquipped) {
    console.log('\n============================================================');
    console.log('D2局内恢复：当前已经完成D1，妖刀已装备在已有Link怪兽上。');
    console.log('不会重新扫描/点击手牌妖刀，也不会重新发动妖刀。');
    console.log('直接复用最近一次D1 PASS记录，并先重新确认当前carrier真实卡框。');
    console.log('============================================================\n');
  } else {
    runD1();
  }
  const d1 = latestD1Pass();
  if (!d1) {
    throw new Error(resumeEquipped ? 'D2_RESUME_REQUIRES_RECENT_D1_PASS_RESULT' : 'D2_D1_PASS_RESULT_NOT_FOUND');
  }

  const targetProof = d1.result.targetProof || {};
  const carrier = targetProof.recognized || {};
  const anchor = targetProof.clickReference || (d1.result.baselineLink && d1.result.baselineLink.referenceCenter);
  if (!carrier.id || !/^E(?:0[2-9]|10)$/.test(String(carrier.id)) || !anchor) {
    throw new Error(`D2_D1_CARRIER_EVIDENCE_INVALID:${carrier.id || 'NONE'}`);
  }

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'D2_m19_carrier_link', timestampId());
  ensureDir(attemptDir);
  const rl = readline.createInterface({ input, output });
  const bridge = new MdFastBridge();
  let started = false;

  try {
    console.log('\n============================================================');
    console.log(`D2 刀支线操作层测试：${resumeEquipped ? '从已装备现场恢复' : 'D1装备成功'} → 当前carrier继续Link`);
    console.log(`D1 carrier: ${carrier.name}[${carrier.id}]；实测中心=(${Math.round(anchor.x)},${Math.round(anchor.y)})`);
    console.log('本轮新增能力：打开额外卡组 → 选择当前合法单素材Link → 把实际carrier作为素材 → 蓝色确认。');
    console.log('Link完成后停在可选效果池，不处理妖刀检索；那是D3。');
    console.log('交互键：Enter=进入下一自动节点；R=只重拍；Q=原地退出。');
    console.log('============================================================');

    await bridge.start();
    started = true;
    let info = await activateGameAndGetInfo(bridge);

    const currentCarrier = await captureObservedOwnLink({
      bridge,
      info,
      anchorReference: anchor,
      debugDir: path.join(attemptDir, '00_carrier_recheck'),
      label: 'carrier_after_d1'
    });
    if (!currentCarrier.visible || !currentCarrier.referenceCenter) {
      throw new Error('D2_CARRIER_NOT_VISIBLE_AFTER_D1');
    }
    const carrierAnchor = currentCarrier.referenceCenter;
    await saveNode(bridge, info, attemptDir, '00_after_d1_carrier_ready', {
      d1Result: d1.resultPath,
      carrier,
      carrierAnchor
    });

    let control = await checkpoint(rl, {
      prompt: 'D2节点0已就绪。Enter=打开额外卡组并点击真实“特殊召唤”按钮；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '00_carrier_ready',
      extra: { carrier, carrierAnchor }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const openProof = await clickExtraDeckSummonButton({
      bridge,
      info,
      debugDir: path.join(attemptDir, '01_open_extra')
    });
    await sleep(500);
    const promptProof = await waitForSummonCandidates({
      bridge,
      info,
      debugDir: path.join(attemptDir, '01_open_extra')
    });
    await saveNode(bridge, info, attemptDir, '01_link_candidates_ready', { openProof, promptProof });
    console.log('\nD2节点1 PASS：额外卡组Link候选窗口已打开，尚未选择Link结果。');

    control = await checkpoint(rl, {
      prompt: '确认候选窗口正常后按Enter=逐张精确认并选择一个合法单素材Link；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '01_link_candidates_hold',
      extra: { carrier, promptProof }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const summonChoice = await selectNextLegalLink({
      bridge,
      info,
      library,
      templates,
      carrierId: carrier.id,
      promptProof,
      debugDir: path.join(attemptDir, '02_select_link')
    });
    await saveNode(bridge, info, attemptDir, '02_link_target_selected', { summonChoice });
    console.log('\nD2节点2 PASS：Link结果已选中并精确认，尚未提交。');

    control = await checkpoint(rl, {
      prompt: 'Enter=只点击底部“特殊召唤/选择”并进入素材选择；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '02_link_target_selected_hold',
      extra: { summonChoice }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const submitProof = await clickBottomSummonSubmit({
      bridge,
      info,
      debugDir: path.join(attemptDir, '03_enter_material_prompt')
    });
    await sleep(650);
    const materialReady = await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: carrierAnchor,
      debugDir: path.join(attemptDir, '03_enter_material_prompt')
    });
    await saveNode(bridge, info, attemptDir, '03_material_prompt_ready', { submitProof, materialReady });
    console.log('\nD2节点3 PASS：已进入Link素材选择，当前实际carrier仍被证明为可选素材。');

    control = await checkpoint(rl, {
      prompt: 'Enter=点击当前实际carrier作为Link素材；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '03_material_prompt_hold',
      extra: { carrier, materialReady }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const materialProof = await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: carrierAnchor,
      debugDir: path.join(attemptDir, '04_carrier_selected')
    });
    await saveNode(bridge, info, attemptDir, '04_carrier_material_selected', { materialProof });
    console.log('\nD2节点4 PASS：carrier已选中；下一节点只点蓝色确认，不重新点击carrier。');

    control = await checkpoint(rl, {
      prompt: '蓝色确认出现后按Enter=点击确认并零输入等待Link动画；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '04_carrier_selected_hold',
      extra: { materialProof }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const materialConfirm = await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: materialProof.clickReference,
      debugDir: path.join(attemptDir, '05_material_confirm')
    });
    console.log('Link素材确认已点击；现在动画阶段零输入等待1700ms。');
    await sleep(1700);

    const optionalPool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(attemptDir, '05_post_link_optional')
    });
    // The optional-effect modal is itself the stable post-Link boundary for D2.
    // Do not require the field Link frame here: the modal overlays/dims the field and
    // can make the normal blue-frame detector fail even though the Link summon is done.
    // Keep a passive frame probe only as diagnostic evidence; never fail D2 on it.
    const newLink = await captureObservedOwnLink({
      bridge,
      info,
      debugDir: path.join(attemptDir, '05_post_link_optional'),
      label: 'post_link_new_monster_diagnostic'
    });
    await saveNode(bridge, info, attemptDir, '05_post_link_optional_pool', {
      summonChoice,
      materialProof,
      materialConfirm,
      optionalPool,
      newLink,
      postLinkFrameRequired: false,
      postLinkBoundary: 'OPTIONAL_EFFECT_POOL'
    });

    console.log(
      `D2 Link后场面框诊断: ${newLink.visible ? 'PASS' : '被可选效果窗口遮挡/压暗，不作为失败条件'}; ` +
      'D2以可选效果池出现作为Link完成边界。'
    );

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D2_M19_EQUIP_THEN_CARRIER_LINK',
      resumeEquipped,
      d1ResultPath: d1.resultPath,
      carrier,
      carrierAnchor,
      summonChoice,
      submitProof,
      materialProof,
      materialConfirm,
      optionalPool,
      postLinkFrame: newLink,
      sealed: false,
      note: 'Stops at post-Link optional-effect pool. M19 search is intentionally untouched for D3.'
    });

    console.log('\n============================================================');
    console.log('D2候选PASS：妖刀装备后的实际carrier已被自动作为素材完成Link。');
    console.log(`carrier: ${carrier.name}[${carrier.id}]`);
    console.log(`Link结果: ${summonChoice.selected.name}[${summonChoice.selected.id}]`);
    console.log(`Link后效果池候选数: ${optionalPool.candidateCount}`);
    console.log('当前停在可选效果池，不要处理妖刀；下一步D3从这里开始做妖刀检索。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (started) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD2 carrier Link测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前窗口；把终端输出和debug/execution/D2_m19_carrier_link最新节点发回来。');
  process.exitCode = 1;
});
