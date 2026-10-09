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
  clickCentralSelectableMaterial,
  sleep
} = require('./bamboo-first-batch-common');

const { MdFastBridge } = require(path.join(ROOT, 'lib', 'win-fast'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
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

// 只留下零梦[E10]，这样仍复用成熟 selectNextLegalLink 的逐张真实卡框点击/卡名精确认，
// 但测试目标固定为“双素材Link零梦”。
const EXCLUDE_NOT_E10 = ['E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09'];

async function main() {
  assertSupportedNode();
  const attemptDir = path.join(ROOT, 'debug', 'execution', 'D8_double_material_link', timestampId());
  ensureDir(attemptDir);
  const rl = createCheckpointReader();
  const bridge = new MdFastBridge();
  let started = false;

  try {
    console.log('\n============================================================');
    console.log('D8 第一批测试：两只实际怪兽 → 双素材Link零梦[E10]');
    console.log('测试前场面：额外怪兽区已有1只可用Link；中央主怪兽区另有1只可用怪兽。');
    console.log('两只怪兽都必须能作为当前E10召唤素材；本轮不测试第二素材如何生成。');
    console.log('第一素材使用observer测得的真实Link卡框；第二素材必须由素材窗口真实黄色高亮证明。');
    console.log('============================================================');

    await bridge.start();
    started = true;
    let control = await checkpoint(rl, {
      prompt: '场面准备好后按Enter=确认第一只已有Link真实卡框；R=重拍；Q=退出：',
      bridge, attemptDir, label: '00_before_baseline'
    });
    if (control === 'QUIT') return;

    let info = await activateGameAndGetInfo(bridge);
    const firstMaterial = await captureObservedOwnLink({
      bridge, info,
      debugDir: path.join(attemptDir, '00_first_material'),
      label: 'double_link_first_existing_link'
    });
    if (!firstMaterial.visible || !firstMaterial.referenceCenter) {
      throw new Error('D8_FIRST_EXISTING_LINK_NOT_PROVEN');
    }
    const firstAnchor = firstMaterial.referenceCenter;
    await saveNode(bridge, info, attemptDir, '00_first_material_proven', { firstMaterial, firstAnchor });

    control = await checkpoint(rl, {
      prompt: 'Enter=打开额外卡组并进入Link候选窗口；R=重拍；Q=退出：',
      bridge, attemptDir, label: '00_first_material_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const openProof = await clickExtraDeckSummonButton({
      bridge, info,
      debugDir: path.join(attemptDir, '01_open_extra')
    });
    await sleep(500);
    const promptProof = await waitForSummonCandidates({
      bridge, info,
      debugDir: path.join(attemptDir, '01_open_extra')
    });

    control = await checkpoint(rl, {
      prompt: 'Enter=逐张精确认，只有零梦[E10]允许保留选中；R=重拍；Q=退出：',
      bridge, attemptDir, label: '01_candidates_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const summonChoice = await selectNextLegalLink({
      bridge, info, library, templates,
      carrierId: 'DOUBLE_LINK',
      promptProof,
      debugDir: path.join(attemptDir, '02_select_e10'),
      excludedLinkIds: EXCLUDE_NOT_E10
    });
    if (!summonChoice.selected || summonChoice.selected.id !== 'E10') {
      throw new Error(`D8_REQUIRED_E10_NOT_SELECTED:${summonChoice.selected && summonChoice.selected.id || 'NONE'}`);
    }
    await saveNode(bridge, info, attemptDir, '02_e10_selected', { openProof, summonChoice });

    control = await checkpoint(rl, {
      prompt: 'Enter=只点底部“特殊召唤/选择”进入双素材窗口；R=重拍；Q=退出：',
      bridge, attemptDir, label: '02_e10_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const submitProof = await clickBottomSummonSubmit({
      bridge, info,
      debugDir: path.join(attemptDir, '03_material_prompt')
    });
    await sleep(650);
    const firstReady = await proveCarrierMaterialSelectable({
      bridge, info,
      anchorReference: firstAnchor,
      carrierMode: 'LINK',
      debugDir: path.join(attemptDir, '03_material_prompt')
    });
    await saveNode(bridge, info, attemptDir, '03_first_material_ready', { submitProof, firstReady });

    control = await checkpoint(rl, {
      prompt: 'Enter=点击第一只已有Link真实卡框；R=重拍；Q=退出：',
      bridge, attemptDir, label: '03_first_material_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const firstSelected = await clickCarrierMaterial({
      bridge, info,
      anchorReference: firstAnchor,
      carrierMode: 'LINK',
      debugDir: path.join(attemptDir, '04_first_selected')
    });
    await saveNode(bridge, info, attemptDir, '04_first_material_selected', { firstSelected });

    control = await checkpoint(rl, {
      prompt: '确认第一素材已选中后按Enter=检测中央第二素材真实黄色高亮并点击；R=重拍；Q=退出：',
      bridge, attemptDir, label: '04_first_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const secondSelected = await clickCentralSelectableMaterial({
      bridge, info,
      debugDir: path.join(attemptDir, '05_second_central')
    });
    await saveNode(bridge, info, attemptDir, '05_second_material_selected', { firstSelected, secondSelected });

    control = await checkpoint(rl, {
      prompt: '两素材都已选中；蓝色确认出现后按Enter=只点确认；R=重拍；Q=退出：',
      bridge, attemptDir, label: '05_two_materials_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const materialConfirm = await clickMaterialBlueConfirm({
      bridge, info,
      anchorReference: secondSelected.clickReference,
      debugDir: path.join(attemptDir, '06_material_confirm')
    });
    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge, info,
      debugDir: path.join(attemptDir, '06_post_link_optional')
    });

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D8_DOUBLE_MATERIAL_LINK_E10',
      firstMaterial,
      firstSelected,
      secondSelected,
      summonChoice,
      materialConfirm,
      optionalPool,
      sealed: false
    });

    console.log('\n============================================================');
    console.log('D8候选PASS：两只实际素材已自动选择并Link零梦[E10]。');
    console.log(`第一素材真实中心: (${Math.round(firstSelected.clickReference.x)},${Math.round(firstSelected.clickReference.y)})`);
    console.log(`第二素材黄色高亮中心: (${Math.round(secondSelected.clickReference.x)},${Math.round(secondSelected.clickReference.y)})`);
    console.log(`Link结果: ${summonChoice.selected.name}[${summonChoice.selected.id}]`);
    console.log(`Link后效果池候选数: ${optionalPool.candidateCount}`);
    console.log('当前停在零梦自身可选效果窗口；本轮不继续检索。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (started) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD8测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前窗口；把终端输出和D8最新debug节点发回来。');
  process.exitCode = 1;
});
