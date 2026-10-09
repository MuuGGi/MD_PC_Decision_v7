'use strict';

const fs = require('fs');
const path = require('path');
const { sameRuntimeCardMultiset } = require('../../lib/exodia-policy');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm14-golden-bamboo-sword'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { markExecutionPass } = require(path.join(ROOT, 'execution', 'core', 'verified-status'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');

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

function cardIdFromDetail(detail) {
  return detail && detail.card && detail.card.id || null;
}

function cardIdFromInserted(item) {
  return item && item.card && item.card.id || null;
}

function verifyGoldenBambooDraw(beforeCount, attemptDir) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const targetBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (targetBlocks.length !== 1) {
    throw new Error(`EXEC_M14_LOG_OPERATION_INVALID:${targetBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`EXEC_M14_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }

  const gains = (targetBlocks[0].details || []).filter(detail =>
    detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  );
  if (gains.length !== 2) {
    throw new Error(`EXEC_M14_LOG_DRAW_COUNT_INVALID:${gains.length}/2`);
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`EXEC_M14_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`EXEC_M14_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 2 || inserted.length !== 2) {
    throw new Error(`EXEC_M14_DRAW_INVALID:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount + 1) {
    throw new Error(`EXEC_M14_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount + 1}`);
  }

  // 右栏两张 HAND_GAIN 与最终手牌新增两张必须是同一个多重集合。
  // 顺序允许不同，因为扇形插入顺序和右栏显示顺序不保证一致。
  const logIds = gains.map(cardIdFromDetail).filter(Boolean).sort();
  const insertedIds = inserted.map(cardIdFromInserted).filter(Boolean).sort();
  if (logIds.length !== 2 || insertedIds.length !== 2 || !sameRuntimeCardMultiset(logIds, insertedIds)) {
    throw new Error(`EXEC_M14_DRAW_ID_MISMATCH:log=${logIds.join(',')};hand=${insertedIds.join(',')}`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    logOperation: targetBlocks[0],
    consumed,
    gains,
    inserted,
    beforeCount,
    afterCount,
    finalHand: incremental.after.cards || []
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'M14_golden_bamboo_sword', timestampId());
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

    if (baseline.handCount > card.maxHandCountBeforeActivation) {
      throw new Error(
        `EXEC_M14_HAND_COUNT_TOO_HIGH_FOR_VERIFIED_POST_SCAN:` +
        `${baseline.handCount}>${card.maxHandCountBeforeActivation};` +
        `M14结算后会到${baseline.handCount + 1}张，超出现有1~12张封板范围`
      );
    }

    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const targetCount = baseline.cards.filter(item => item && item.id === card.id).length;
    if (!targetCount) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }

    console.log('\n============================================================');
    console.log(`准备自动操作：${card.name}[${card.id}]（抽2）`);
    console.log('普通发动完全复用现有封板执行：observer基线 -> TITLE_COMPONENTS/DENSE真实位置 -> 发动。');
    console.log('本牌没有后续选择窗口；发动后纯等待3200ms，不按键、不点鼠标、不读INFO、不滚动。');
    console.log('如果场上没有合法的“竹光”装备魔法，“发动”按钮不会通过，程序会安全停止。');
    console.log('最终正式observer必须验证：M14离手1张 + 抽2张 + 手牌净变化+1。');
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

    console.log(`已点击“发动”：${card.name}[${card.id}]；现在纯等待抽2结算。`);
    await sleep(card.settleAfterActivationMs);
  } finally {
    await bridge.stop().catch(() => {});
  }

  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  const verified = verifyGoldenBambooDraw(baseline.handCount, attemptDir);
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
    testEntry: 'execution\\live\\run-m14-golden-bamboo-sword.cmd',
    evidenceDir: attemptDir,
    scope: '1~11张发动前手牌；复用封板observer TITLE_COMPONENTS/DENSE真实定位；M14发动后纯等待抽2；正式observer验证M14离手1张、两张HAND_GAIN与两张新增手牌一致、最终手牌净+1'
  });

  console.log('\n============================================================');
  console.log(`M14执行测试 PASS: ${card.name}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(
    `实际抽到: ${verified.inserted.map(item => {
      const c = item && item.card ? item.card : {};
      const slot = item && (item.actualSlot || item.slot || item.index);
      return `${c.name}[${c.id}]${slot ? ` @手牌${slot}` : ''}`;
    }).join(' / ')}`
  );
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM14执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
