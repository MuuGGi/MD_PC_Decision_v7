'use strict';

const path = require('path');
const {
  ROOT,
  assertSupportedNode,
  ensureDir,
  writeJson,
  timestampId,
  createCheckpointReader,
  activateGameAndGetInfo,
  saveNode,
  checkpoint,
  latestPass,
  sleep
} = require('./bamboo-first-batch-common');

const D5_ROOT = path.join(ROOT, 'debug', 'execution', 'D5_m19_central_equip');
const { MdFastBridge } = require(path.join(ROOT, 'lib', 'win-fast'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
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

const EXCLUDED_LINK_IDS = ['E02'];

async function main() {
  assertSupportedNode();
  const d5 = latestPass(D5_ROOT);
  if (!d5) throw new Error('D7_REQUIRES_RECENT_D5_PASS:请先完成D5中央妖刀装备，并保持同一对局现场。');
  const targetProof = d5.result && d5.result.targetProof;
  const anchor = targetProof && targetProof.clickReference;
  if (!anchor || targetProof.kind !== 'CENTRAL_MAIN') {
    throw new Error('D7_D5_CENTRAL_CARRIER_EVIDENCE_INVALID');
  }

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'D7_central_carrier_link', timestampId());
  ensureDir(attemptDir);
  const rl = createCheckpointReader();
  const bridge = new MdFastBridge();
  let started = false;

  try {
    console.log('\n============================================================');
    console.log('D7 第一批测试：中央普通怪兽作为妖刀carrier → 单素材Link');
    console.log('前置：刚刚D5已经PASS，妖刀仍装备在中央主怪兽区那只怪兽上，且保持同一对局。');
    console.log(`复用D5真实carrier中心=(${Math.round(anchor.x)},${Math.round(anchor.y)})，禁止重新猜怪兽区位置。`);
    console.log('闪刀姬－篝[E02]继续排除，避免回收窗口污染本测试。');
    console.log('============================================================');

    await bridge.start();
    started = true;
    let control = await checkpoint(rl, {
      prompt: '确认仍是D5完成后的现场，按Enter打开额外卡组；R=重拍；Q=退出：',
      bridge, attemptDir, label: '00_before_extra', extra: { d5ResultPath: d5.resultPath, anchor }
    });
    if (control === 'QUIT') return;

    let info = await activateGameAndGetInfo(bridge);
    const openProof = await clickExtraDeckSummonButton({
      bridge, info, debugDir: path.join(attemptDir, '01_open_extra')
    });
    await sleep(500);
    const promptProof = await waitForSummonCandidates({
      bridge, info, debugDir: path.join(attemptDir, '01_open_extra')
    });
    await saveNode(bridge, info, attemptDir, '01_link_candidates_ready', { openProof, promptProof });

    control = await checkpoint(rl, {
      prompt: 'Enter=逐张精确认并选择一个合法Link（自动排除篝）；R=重拍；Q=退出：',
      bridge, attemptDir, label: '01_link_candidates_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const summonChoice = await selectNextLegalLink({
      bridge, info, library, templates,
      carrierId: targetProof.recognized && targetProof.recognized.id || 'CENTRAL_MONSTER',
      promptProof,
      debugDir: path.join(attemptDir, '02_select_link'),
      excludedLinkIds: EXCLUDED_LINK_IDS
    });
    await saveNode(bridge, info, attemptDir, '02_link_target_selected', { summonChoice });

    control = await checkpoint(rl, {
      prompt: 'Enter=只点击底部“特殊召唤/选择”进入素材窗口；R=重拍；Q=退出：',
      bridge, attemptDir, label: '02_link_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const submitProof = await clickBottomSummonSubmit({
      bridge, info, debugDir: path.join(attemptDir, '03_material_prompt')
    });
    await sleep(650);
    const materialReady = await proveCarrierMaterialSelectable({
      bridge, info,
      anchorReference: anchor,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, '03_material_prompt')
    });
    await saveNode(bridge, info, attemptDir, '03_generic_carrier_proven', { submitProof, materialReady });

    control = await checkpoint(rl, {
      prompt: 'Enter=点击D5保存的真实中央carrier；R=重拍；Q=退出：',
      bridge, attemptDir, label: '03_carrier_ready_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const materialProof = await clickCarrierMaterial({
      bridge, info,
      anchorReference: anchor,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, '04_carrier_selected')
    });
    await saveNode(bridge, info, attemptDir, '04_carrier_selected', { materialProof });

    control = await checkpoint(rl, {
      prompt: '蓝色确认出现后按Enter=只点确认并等待Link动画；R=重拍；Q=退出：',
      bridge, attemptDir, label: '04_carrier_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const materialConfirm = await clickMaterialBlueConfirm({
      bridge, info,
      anchorReference: materialProof.clickReference,
      debugDir: path.join(attemptDir, '05_material_confirm')
    });
    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge, info,
      debugDir: path.join(attemptDir, '05_post_link_optional')
    });

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D7_M19_CENTRAL_GENERIC_CARRIER_SINGLE_LINK',
      d5ResultPath: d5.resultPath,
      carrier: targetProof,
      summonChoice,
      submitProof,
      materialProof,
      materialConfirm,
      optionalPool,
      sealed: false
    });

    console.log('\n============================================================');
    console.log('D7候选PASS：中央普通怪兽作为妖刀carrier，已使用保存的真实中心完成单素材Link。');
    console.log(`Link结果: ${summonChoice.selected.name}[${summonChoice.selected.id}]`);
    console.log(`Link后效果池候选数: ${optionalPool.candidateCount}`);
    console.log('当前停在妖刀相关可选效果池；本测试不继续检索。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (started) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD7测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救；把终端输出和D7最新debug节点发回来。');
  process.exitCode = 1;
});
