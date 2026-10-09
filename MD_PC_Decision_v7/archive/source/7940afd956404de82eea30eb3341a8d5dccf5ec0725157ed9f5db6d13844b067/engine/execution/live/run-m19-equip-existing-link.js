'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const CARD = { id: 'M19', name: '妖刀竹光' };
const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { establishCurrentObserverBaseline } = require(path.join(
  ROOT,
  'execution',
  'core',
  'observer-current-baseline'
));
const { selectObservedHandCard } = require(path.join(
  ROOT,
  'execution',
  'core',
  'hand-target'
));
const { clickSelectedHandSpellActivation } = require(path.join(
  ROOT,
  'execution',
  'core',
  'hand-spell-activation'
));
const {
  captureObservedOwnLink,
  clickObservedOwnLinkTarget,
  clickObservedEquipConfirm,
  isKnownLinkMonsterId
} = require(path.join(
  ROOT,
  'execution',
  'core',
  'field-link-target'
));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);
const COMPOSITE_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'composite-route-live',
  'latest_result.json'
);

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

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runNodeFromRoot(script, args = []) {
  console.log(`\n===== ${script} =====`);
  const out = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
  }
}

async function activateGameAndGetInfo(bridge) {
  const activation = await activateAndVerifyMasterDuel(bridge);
  return activation.info;
}

async function savePassiveNodeSnapshot(bridge, info, attemptDir, label, extra = null) {
  const dir = path.join(attemptDir, 'nodes');
  ensureDir(dir);
  const image = await captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: 2048,
    height: 1152
  });
  const imagePath = path.join(dir, `${label}.png`);
  saveRgbaPng(image, imagePath);
  writeJson(path.join(dir, `${label}.json`), {
    capturedAt: new Date().toISOString(),
    label,
    screenshot: imagePath,
    extra
  });
  console.log(`节点已保存: ${label}`);
  return imagePath;
}

async function waitCheckpoint(rl, options) {
  const {
    prompt,
    bridge,
    attemptDir,
    retryPrefix,
    retryExtra = null
  } = options;
  let retryCount = 0;

  while (true) {
    const answer = (await rl.question(prompt)).trim().toUpperCase();
    if (answer === 'Q') return 'QUIT';
    if (answer === 'R') {
      retryCount += 1;
      const info = await activateGameAndGetInfo(bridge);
      await savePassiveNodeSnapshot(
        bridge,
        info,
        attemptDir,
        `${retryPrefix}_R${retryCount}`,
        retryExtra
      );
      console.log('R只重拍并保存当前节点，没有点击游戏。Alt+Tab回终端可继续。');
      continue;
    }
    if (!answer) return 'ENTER';
    console.log('只接受 Enter / R / Q。');
  }
}

function verifyM19Equip(beforeCount) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const composite = fs.existsSync(COMPOSITE_RESULT_PATH)
    ? readJson(COMPOSITE_RESULT_PATH)
    : null;

  const newBlocks = Array.isArray(log.newOperationBlocks) ? log.newOperationBlocks : [];
  const m19Blocks = newBlocks.filter(block => block && block.activationKey === CARD.id);

  if (m19Blocks.length !== 1) {
    throw new Error(`D1_M19_LOG_INVALID:${m19Blocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`D1_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }

  const compositeEquip = composite && composite.summary && composite.summary.equip;
  if (compositeEquip !== 'M19_FROM_HAND') {
    throw new Error(`D1_M19_EQUIP_COMPOSITE_NOT_CONFIRMED:${compositeEquip || 'NONE'}`);
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`D1_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== CARD.id) {
    throw new Error(`D1_M19_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 0 || inserted.length !== 0) {
    throw new Error(`D1_M19_HAND_GAIN_UNEXPECTED:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount - 1) {
    throw new Error(`D1_M19_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount - 1}`);
  }

  return {
    operation: m19Blocks[0],
    compositeEquip,
    consumed,
    beforeCount,
    afterCount,
    finalHand: incremental.after && incremental.after.cards || []
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    'D1_m19_equip_existing_link',
    timestampId()
  );
  ensureDir(attemptDir);

  const rl = readline.createInterface({ input, output });
  const bridge = new MdFastBridge();
  let bridgeStarted = false;
  let baseline = null;
  let linkBaseline = null;
  let selected = null;
  let actionProof = null;
  let targetProof = null;
  let confirmProof = null;

  try {
    console.log('\n============================================================');
    console.log('D1 刀支线操作层测试：妖刀竹光 → 当前已有Link怪兽');
    console.log('测试范围只做到“妖刀自动发动 + 动态选择已有Link装备对象 + 最终observer验收”。');
    console.log('不测试后续Link，不测试妖刀墓地检索。');
    console.log('测试前场面：正常场面；我方已有1只可装备的Link怪兽；手牌有妖刀竹光[M19]。');
    console.log('交互键：Enter=进入下一自动阶段；R=只重拍保存当前节点；Q=原地结束，不再输入游戏。');
    console.log('重要：测试过程中不要手动点牌/按钮；目标选中后由节点2.5专门识别并点击蓝色“确认”。');
    console.log('============================================================');

    await bridge.start();
    bridgeStarted = true;

    let control = await waitCheckpoint(rl, {
      prompt: '准备好后按 Enter 建立observer基线；R只保存当前画面；Q退出：',
      bridge,
      attemptDir,
      retryPrefix: '00_before_baseline'
    });
    if (control === 'QUIT') return;

    let info = await activateGameAndGetInfo(bridge);
    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, '00_observer_baseline')
    });

    const m19Count = (baseline.cards || []).filter(card => card && card.id === CARD.id).length;
    if (!m19Count) {
      throw new Error(`D1_M19_NOT_IN_CURRENT_HAND:${CARD.name}[${CARD.id}]`);
    }

    linkBaseline = await captureObservedOwnLink({
      bridge,
      info,
      debugDir: path.join(attemptDir, '00_link_baseline'),
      label: 'existing_link_baseline'
    });
    if (!linkBaseline.visible || !linkBaseline.referenceCenter) {
      throw new Error('D1_PREEXISTING_LINK_NOT_PROVEN');
    }

    writeJson(path.join(attemptDir, '00_baseline_result.json'), {
      status: 'PASS',
      capturedAt: new Date().toISOString(),
      handCount: baseline.handCount,
      hand: baseline.cards,
      m19Count,
      existingLink: linkBaseline
    });

    console.log('\nD1节点0 PASS：observer基线与已有Link真实卡框都已建立。');
    console.log(`当前手牌=${baseline.handCount}；妖刀=${m19Count}张；Link中心=(${Math.round(linkBaseline.referenceCenter.x)},${Math.round(linkBaseline.referenceCenter.y)})`);
    console.log('Alt+Tab回终端后按Enter，程序才会真正点击妖刀。');

    control = await waitCheckpoint(rl, {
      prompt: 'Enter=自动选择妖刀并点击“发动”；R=重拍节点0；Q=退出：',
      bridge,
      attemptDir,
      retryPrefix: '00_baseline_hold',
      retryExtra: { handCount: baseline.handCount, link: linkBaseline.referenceCenter }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    selected = await selectObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline,
      expectedId: CARD.id,
      debugDir: path.join(attemptDir, '01_m19_activation')
    });

    console.log(
      `发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS ` +
      `@手牌${selected.slot}${selected.duplicateCount > 1 ? `（同名${selected.duplicateCount}张，取最左实际识别位置）` : ''}`
    );

    actionProof = await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: CARD.id,
      expectedName: CARD.name,
      clickReference: selected.clickReference,
      debugDir: path.join(attemptDir, '01_m19_activation')
    });

    console.log('妖刀“发动”已点击。现在零输入；请等游戏真正出现装备对象选择状态。');
    await sleep(500);
    await savePassiveNodeSnapshot(
      bridge,
      info,
      attemptDir,
      '01_after_m19_activation_500ms',
      { selected, actionProof }
    );
    writeJson(path.join(attemptDir, '01_activation_result.json'), {
      status: 'ACTION_CLICKED',
      capturedAt: new Date().toISOString(),
      selected,
      actionProof
    });

    console.log('\nD1节点1已保存：妖刀已发动，但程序尚未点击装备对象。');
    console.log('请看游戏：只有真正停在装备对象选择阶段时才按Enter。');

    control = await waitCheckpoint(rl, {
      prompt: 'Enter=按节点0的真实Link卡框重新定位并点击装备对象；R=只重拍当前选择窗口；Q=保留现场退出：',
      bridge,
      attemptDir,
      retryPrefix: '01_equip_target_prompt_hold',
      retryExtra: { anchor: linkBaseline.referenceCenter }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    targetProof = await clickObservedOwnLinkTarget({
      bridge,
      info,
      library,
      templates,
      anchorReference: linkBaseline.referenceCenter,
      debugDir: path.join(attemptDir, '02_equip_target'),
      afterIdentityMs: 600
    });

    writeJson(path.join(attemptDir, '02_target_result.json'), {
      status: 'TARGET_CLICKED_AND_IDENTITY_PROVEN',
      capturedAt: new Date().toISOString(),
      targetProof
    });
    await savePassiveNodeSnapshot(
      bridge,
      info,
      attemptDir,
      '02_after_link_target_click',
      { targetProof }
    );

    console.log('\nD1节点2 PASS：程序已点击“当前真实Link卡框”，并精确认装备对象卡名。');
    console.log('当前怪兽已经被选中；下一节点只允许识别/点击它上方真实蓝色“确认”，禁止重新点怪兽。');

    control = await waitCheckpoint(rl, {
      prompt: '确认蓝色按钮已出现后按Enter=检测真实确认按钮并点击；R=只重拍节点2；Q=保留现场退出：',
      bridge,
      attemptDir,
      retryPrefix: '02_after_target_hold',
      retryExtra: { target: targetProof.recognized }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    confirmProof = await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: targetProof.clickReference,
      debugDir: path.join(attemptDir, '03_equip_confirm')
    });

    console.log('妖刀装备“确认”已点击。现在动画阶段零输入等待900ms。');
    await sleep(900);
    await savePassiveNodeSnapshot(
      bridge,
      info,
      attemptDir,
      '03_after_equip_confirm_900ms',
      { target: targetProof.recognized, confirmProof }
    );
    writeJson(path.join(attemptDir, '03_confirm_result.json'), {
      status: 'CONFIRM_CLICKED',
      capturedAt: new Date().toISOString(),
      target: targetProof.recognized,
      confirmProof
    });

    console.log('\nD1节点2.5 PASS：真实蓝色确认按钮已识别并点击。');
    control = await waitCheckpoint(rl, {
      prompt: '确认游戏已回到稳定场面后按Enter=运行最终observer；R=只重拍节点2.5；Q=保留现场退出：',
      bridge,
      attemptDir,
      retryPrefix: '03_after_confirm_hold',
      retryExtra: { target: targetProof.recognized, confirmProof }
    });
    if (control === 'QUIT') return;

    await savePassiveNodeSnapshot(
      bridge,
      await activateGameAndGetInfo(bridge),
      attemptDir,
      '04_before_final_observer',
      { target: targetProof.recognized, confirmProof }
    );

    await bridge.stop();
    bridgeStarted = false;

    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const verified = verifyM19Equip(baseline.handCount);

    copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, '05_final_duel_log.json'));
    copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, '05_final_hand_incremental.json'));
    copyIfExists(COMPOSITE_RESULT_PATH, path.join(attemptDir, '05_final_composite_route.json'));

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D1_M19_EQUIP_EXISTING_LINK',
      target: CARD,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      baselineLink: linkBaseline,
      selected,
      actionProof,
      targetProof,
      confirmProof,
      observerVerification: verified,
      sealed: false,
      note: 'Development route only. Does not write execution/verified-cards.json until the full D1 UI path is confirmed live.'
    });

    console.log('\n============================================================');
    console.log('D1候选PASS：妖刀竹光已从真实手牌位置发动，并装备到动态识别的已有Link怪兽。');
    console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
    console.log(`装备对象: ${targetProof.recognized.name}[${targetProof.recognized.id}]`);
    console.log(`装备语义: ${verified.compositeEquip} PASS`);
    console.log('本测试暂不写 verified-cards.json；D1操作链先现场复测确认。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (bridgeStarted) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD1妖刀装备测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('停止后不要乱点当前游戏窗口；把终端输出和本轮debug/execution/D1_m19_equip_existing_link最新节点发回来即可继续接下一步。');
  process.exitCode = 1;
});
