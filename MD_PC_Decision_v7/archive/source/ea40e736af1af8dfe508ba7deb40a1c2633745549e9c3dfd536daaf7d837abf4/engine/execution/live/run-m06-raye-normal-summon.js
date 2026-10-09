'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm06-raye'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const {
  captureNeutralNormalSummonFrame,
  clickSelectedMonsterNormalSummon
} = require(path.join(ROOT, 'execution', 'core', 'hand-normal-summon'));
const { markExecutionPass } = require(path.join(ROOT, 'execution', 'core', 'verified-status'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const COMPOSITE_RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

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
  if (out.status !== 0) throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
}

function verifyNormalSummon(beforeCount, attemptDir) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const composite = readJson(COMPOSITE_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const rayeBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (rayeBlocks.length !== 1) {
    throw new Error(`EXEC_M06_LOG_OPERATION_INVALID:${rayeBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`EXEC_M06_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }
  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`EXEC_M06_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = Number(incremental.inference && incremental.inference.addedCount || 0);
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];
  if (!consumed || consumed.id !== card.id) {
    throw new Error(`EXEC_M06_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 0 || inserted.length !== 0) {
    throw new Error(`EXEC_M06_HAND_GAIN_UNEXPECTED:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount - 1) {
    throw new Error(`EXEC_M06_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount - 1}`);
  }

  const materialEvent = (composite.events || []).find(event =>
    event && event.kind === 'MATERIAL_SOURCE' && event.mode === 'RAYE_NORMAL_SUMMON'
  );
  if (!materialEvent) throw new Error('EXEC_M06_COMPOSITE_RAYE_NORMAL_SUMMON_MISSING');

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));
  copyIfExists(COMPOSITE_RESULT_PATH, path.join(attemptDir, 'composite_route_result.json'));

  return {
    logOperation: rayeBlocks[0],
    materialEvent,
    consumed,
    beforeCount,
    afterCount,
    finalHand: incremental.after.cards || []
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'M06_raye_normal_summon', timestampId());
  ensureDir(attemptDir);
  const bridge = new MdFastBridge();
  let baseline;
  let neutralFrame;
  let selected;
  let summonProof;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, 'observer_baseline')
    });

    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    if (!baseline.cards.some(item => item && item.id === card.id)) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }

    neutralFrame = await captureNeutralNormalSummonFrame({
      bridge,
      info,
      debugDir: path.join(attemptDir, 'normal_summon_button')
    });

    console.log('\n============================================================');
    console.log(`准备自动操作：通常召唤 ${card.name}[${card.id}]`);
    console.log('只完成通常召唤；不会发动零衣效果、装备卡或进行Link。');
    console.log('手牌目标和召唤按钮都必须由当前真实画面证明。');
    console.log('============================================================');

    selected = await selectObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline,
      expectedId: card.id,
      debugDir: path.join(attemptDir, 'hand_target')
    });
    console.log(
      `召唤前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS ` +
      `@手牌${selected.slot}${selected.duplicateCount > 1 ? `（同名${selected.duplicateCount}张，取最左）` : ''}`
    );

    summonProof = await clickSelectedMonsterNormalSummon({
      bridge,
      info,
      expectedId: card.id,
      expectedName: card.name,
      clickReference: selected.clickReference,
      neutralFrame,
      debugDir: path.join(attemptDir, 'normal_summon_button')
    });

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      target: { id: card.id, name: card.name, slot: selected.slot },
      handCount: baseline.handCount,
      positioning: selected.positioning,
      selected: selected.selected,
      summonProof
    });

    console.log('已点击真实“召唤”按钮；现在动画阶段零输入。');
    await sleep(card.settleAfterSummonMs);
  } finally {
    await bridge.stop().catch(() => {});
  }

  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
  const verified = verifyNormalSummon(baseline.handCount, attemptDir);
  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    baselineHandCount: baseline.handCount,
    baselineHand: baseline.cards,
    selected,
    summonProof,
    observerVerification: verified
  });

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m06-raye-normal-summon.cmd',
    evidenceDir: attemptDir,
    scope: '1~12张手牌；复用observer TITLE_COMPONENTS/DENSE真实位置；真实蓝色召唤按钮组件点击；动画零输入；正式observer验证M06离手、手牌N->N-1及RAYE_NORMAL_SUMMON素材事件'
  });

  console.log('\n============================================================');
  console.log(`M06通常召唤执行测试 PASS: ${card.name}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log('复合路线确认: MATERIAL_SOURCE:RAYE_NORMAL_SUMMON');
  console.log('未发动零衣效果，未继续Link。');
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM06通常召唤测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前界面；保留现场并发送终端输出与最新debug目录。');
  process.exitCode = 1;
});
