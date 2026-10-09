'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm09-upstart-goblin'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));

const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
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

function verifyObserverResult(beforeCount, attemptDir) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const m09Blocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (m09Blocks.length !== 1) {
    throw new Error(`EXEC_M09_LOG_OPERATION_INVALID:${m09Blocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`EXEC_M09_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }
  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`EXEC_M09_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`EXEC_M09_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 1 || inserted.length !== 1) {
    throw new Error(`EXEC_M09_DRAW_INVALID:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount) {
    throw new Error(`EXEC_M09_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount}`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    logOperation: m09Blocks[0],
    consumed,
    inserted: inserted[0],
    beforeCount,
    afterCount,
    finalHand: incremental.after.cards || []
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'M09_upstart_goblin', timestampId());
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
    console.log('目标定位完全复用 observer：1~7 当前 TITLE_COMPONENTS；8~12 当前 DENSE 窗口。');
    console.log('目标牌只点击1次；发动后纯等待，不追加任何输入。');
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

    console.log(`已点击“发动”：${card.name}[${card.id}]；现在纯等待抽卡结算。`);

    // Animation/resolution: zero input.  No mouse, keyboard, INFO or scroll.
    await sleep(card.settleAfterActivationMs);
  } finally {
    await bridge.stop().catch(() => {});
  }

  // Reuse the frozen production observer as the truth source.  The executor
  // does not implement its own right-log or hand-delta parser.
  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  const verified = verifyObserverResult(baseline.handCount, attemptDir);
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

  console.log('\n============================================================');
  console.log(`M09执行测试 PASS: ${card.name}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`实际抽到: ${verified.inserted.card.name}[${verified.inserted.card.id}] @手牌${verified.inserted.slot}`);
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM09执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
