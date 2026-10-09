'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm22-hornet-drones'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { markExecutionPass } = require(path.join(ROOT, 'execution', 'core', 'verified-status'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const TOKEN_IDS = new Set(['TOKEN_SKY_STRIKER', '闪刀姬衍生物']);

function assertSupportedNode() {
  const major = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`NODE_VERSION_TOO_OLD:${process.versions.node || 'UNKNOWN'};需要 Node >= 20。`);
  }
  console.log(`Node运行时: v${process.versions.node} PASS`);
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

function detailCardKey(detail) {
  return String(detail && detail.card && (detail.card.id || detail.card.name) || '');
}

function verifyHornetActivation(beforeCount, attemptDir) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const hornetBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (hornetBlocks.length !== 1) {
    throw new Error(`EXEC_M22_LOG_OPERATION_INVALID:${hornetBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`EXEC_M22_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }

  const hornetBlock = hornetBlocks[0];
  const tokenDetail = (hornetBlock.details || []).find(detail =>
    detail && detail.rawType === 'SPECIAL_SUMMON' && TOKEN_IDS.has(detailCardKey(detail))
  );
  if (!tokenDetail) {
    throw new Error('EXEC_M22_TOKEN_SPECIAL_SUMMON_EVIDENCE_MISSING');
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`EXEC_M22_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`EXEC_M22_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 0 || inserted.length !== 0) {
    throw new Error(`EXEC_M22_HAND_GAIN_UNEXPECTED:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount - 1) {
    throw new Error(`EXEC_M22_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount - 1}`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    logOperation: hornetBlock,
    consumed,
    token: {
      id: detailCardKey(tokenDetail),
      name: tokenDetail.card && tokenDetail.card.name || '闪刀姬衍生物'
    },
    beforeCount,
    afterCount,
    finalHand: incremental.after.cards || []
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'M22_hornet_drones', timestampId());
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;

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
    const targetCount = baseline.cards.filter(item => item && item.id === card.id).length;
    if (!targetCount) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }

    console.log('\n============================================================');
    console.log(`准备自动操作：${card.name}[${card.id}]`);
    console.log('路线：observer真实基线 -> 复用真实手牌位置 -> 精确认大黄蜂 -> 发动。');
    console.log('发动后不做任何后续操作；动画阶段零输入，最后只交给正式observer验收。');
    console.log('============================================================');

    selected = await selectObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline,
      expectedId: card.id,
      debugDir: attemptDir
    });
    console.log(
      `发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS ` +
      `@手牌${selected.slot}${selected.duplicateCount > 1 ? `（同名${selected.duplicateCount}张，取最左）` : ''}`
    );

    actionProof = await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: card.id,
      expectedName: card.name,
      clickReference: selected.clickReference,
      debugDir: attemptDir
    });

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      target: { id: card.id, name: card.name, slot: selected.slot },
      handCount: baseline.handCount,
      positioning: selected.positioning,
      selected: selected.selected,
      actionProof
    });

    console.log(`已点击“发动”：${card.name}[${card.id}]；后续零输入，等待衍生物特殊召唤完成。`);
    await sleep(card.settleAfterActivationMs);
  } finally {
    await bridge.stop().catch(() => {});
  }

  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  const verified = verifyHornetActivation(baseline.handCount, attemptDir);
  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    baselineHandCount: baseline.handCount,
    baselineHand: baseline.cards,
    selected,
    actionProof,
    observerVerification: verified
  });

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m22-hornet-drones.cmd',
    evidenceDir: attemptDir,
    scope: '1~12张手牌；复用封板observer TITLE_COMPONENTS/DENSE真实定位；大黄蜂只直接发动，发动后零输入；正式observer验证M22离手1张、SPECIAL_SUMMON闪刀姬衍生物、无新增手牌、最终手牌N->N-1'
  });

  console.log('\n============================================================');
  console.log(`M22执行测试 PASS: ${card.name}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`右栏确认: ${card.name} -> 特殊召唤 ${verified.token.name}[${verified.token.id}]`);
  console.log('发动后未执行任何选择、确认、Link或其他额外输入。');
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM22执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
