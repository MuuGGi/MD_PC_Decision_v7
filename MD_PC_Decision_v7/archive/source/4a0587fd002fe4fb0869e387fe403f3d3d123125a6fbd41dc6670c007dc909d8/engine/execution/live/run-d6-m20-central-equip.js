'use strict';

const path = require('path');
const {
  ROOT,
  assertSupportedNode,
  ensureDir,
  writeJson,
  readJsonIfExists,
  timestampId,
  createCheckpointReader,
  activateGameAndGetInfo,
  saveNode,
  checkpoint,
  runNodeFromRoot,
  clickRequiredCentralEquipTarget,
  flattenLogBlocks,
  sleep
} = require('./bamboo-first-batch-common');

const CARD = { id: 'M20', name: '真刀竹光' };
const { MdFastBridge } = require(path.join(ROOT, 'lib', 'win-fast'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { clickObservedEquipConfirm } = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const COMPOSITE_RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

function verifyM20FromHand(beforeCount) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  const composite = readJsonIfExists(COMPOSITE_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') throw new Error(`D6_M20_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  if (!composite.summary || composite.summary.equip !== 'M20_FROM_HAND') {
    throw new Error(`D6_M20_COMPOSITE_NOT_CONFIRMED:${composite.summary && composite.summary.equip || 'NONE'}`);
  }
  const afterCount = incremental.after && incremental.after.handCount;
  if (afterCount !== beforeCount - 1) throw new Error(`D6_M20_HAND_COUNT_INVALID:${beforeCount}->${afterCount}`);
  const consumed = incremental.inference && incremental.inference.consumed;
  if (!consumed || consumed.id !== CARD.id) throw new Error(`D6_M20_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  const m20Blocks = flattenLogBlocks(log).filter(block => block && block.activationKey === CARD.id);
  if (!m20Blocks.length) throw new Error('D6_M20_LOG_BLOCK_NOT_FOUND');
  return { beforeCount, afterCount, consumed, m20Blocks: m20Blocks.length, compositeEquip: composite.summary.equip };
}

async function main() {
  assertSupportedNode();
  const attemptDir = path.join(ROOT, 'debug', 'execution', 'D6_m20_central_equip', timestampId());
  ensureDir(attemptDir);
  const rl = createCheckpointReader();
  const bridge = new MdFastBridge();
  let started = false;

  try {
    console.log('\n============================================================');
    console.log('D6 第一批测试：真刀竹光[M20] → 中央主怪兽区装备');
    console.log('测试前场面：手牌有真刀；额外怪兽区不要有Link；中央主怪兽区有可装备怪兽。');
    console.log('本轮只封“真刀中央装备”分支，不继续真刀场上效果/转妖刀。');
    console.log('============================================================');

    await bridge.start();
    started = true;
    let control = await checkpoint(rl, {
      prompt: '准备好后按Enter建立observer基线；R=重拍；Q=退出：',
      bridge, attemptDir, label: '00_before_baseline'
    });
    if (control === 'QUIT') return;

    let info = await activateGameAndGetInfo(bridge);
    const baseline = await establishCurrentObserverBaseline({
      bridge, info,
      outputDir: path.join(attemptDir, '00_observer_baseline')
    });
    const count = (baseline.cards || []).filter(card => card && card.id === CARD.id).length;
    if (!count) throw new Error('D6_M20_NOT_IN_CURRENT_HAND');
    await saveNode(bridge, info, attemptDir, '00_baseline_ready', { handCount: baseline.handCount, m20Count: count });

    control = await checkpoint(rl, {
      prompt: 'Enter=从真实手牌位置发动真刀；R=重拍；Q=退出：',
      bridge, attemptDir, label: '00_baseline_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const selected = await selectObservedHandCard({
      bridge, info, library, templates, baseline,
      expectedId: CARD.id,
      debugDir: path.join(attemptDir, '01_m20_activation')
    });
    const actionProof = await clickSelectedHandSpellActivation({
      bridge, info,
      expectedId: CARD.id,
      expectedName: CARD.name,
      clickReference: selected.clickReference,
      debugDir: path.join(attemptDir, '01_m20_activation')
    });
    await sleep(500);
    await saveNode(bridge, info, attemptDir, '01_after_m20_activation', { selected, actionProof });

    control = await checkpoint(rl, {
      prompt: '确认进入装备对象窗口后按Enter=只允许中央主怪兽区；R=重拍；Q=退出：',
      bridge, attemptDir, label: '01_target_prompt_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const targetProof = await clickRequiredCentralEquipTarget({
      bridge, info, library, templates,
      debugDir: path.join(attemptDir, '02_central_target'),
      label: '真刀'
    });
    await saveNode(bridge, info, attemptDir, '02_central_target_selected', { targetProof });

    control = await checkpoint(rl, {
      prompt: '中央怪兽已选中；蓝色确认出现后按Enter=只点确认；R=重拍；Q=退出：',
      bridge, attemptDir, label: '02_target_selected_hold', extra: { targetProof }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const confirmProof = await clickObservedEquipConfirm({
      bridge, info,
      anchorReference: targetProof.clickReference,
      debugDir: path.join(attemptDir, '03_equip_confirm'),
      label: 'd6_m20_central_confirm'
    });
    await sleep(900);
    await saveNode(bridge, info, attemptDir, '03_after_equip_confirm', { targetProof, confirmProof });

    control = await checkpoint(rl, {
      prompt: '真刀装备稳定后按Enter=observer最终验收；R=重拍；Q=退出：',
      bridge, attemptDir, label: '03_settled_hold'
    });
    if (control === 'QUIT') return;

    await bridge.stop();
    started = false;
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const verified = verifyM20FromHand(baseline.handCount);
    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D6_M20_EQUIP_CENTRAL_MAIN',
      baselineHandCount: baseline.handCount,
      targetProof,
      confirmProof,
      observerVerification: verified,
      sealed: false
    });

    console.log('\n============================================================');
    console.log('D6候选PASS：真刀竹光中央主怪兽区装备分支通过。');
    console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
    console.log('本轮不继续真刀→妖刀；原D4完整路线保持不动。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (started) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD6测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前窗口；把终端输出和D6最新debug节点发回来。');
  process.exitCode = 1;
});
