'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { markExecutionPass } = require(path.join(ROOT, 'execution', 'core', 'verified-status'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const OUTCOME_RESULT_PATH = path.join(ROOT, 'debug', 'duel-outcome-live', 'latest_result.json');

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

const { outcomeMtimeMs, readFreshVictoryOutcome } = require('./observer-completion');

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

function verifyOneForOneDraw(card, beforeCount, attemptDir) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const targetBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (targetBlocks.length !== 1) {
    throw new Error(`EXEC_${card.id}_LOG_OPERATION_INVALID:${targetBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(`EXEC_${card.id}_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`);
  }
  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`EXEC_${card.id}_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  const addedCount = incremental.inference && incremental.inference.addedCount;
  const afterCount = incremental.after && incremental.after.handCount;
  const inserted = incremental.insertedCards || [];

  if (!consumed || consumed.id !== card.id) {
    throw new Error(`EXEC_${card.id}_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  if (addedCount !== 1 || inserted.length !== 1) {
    throw new Error(`EXEC_${card.id}_DRAW_INVALID:added=${addedCount};inserted=${inserted.length}`);
  }
  if (afterCount !== beforeCount) {
    throw new Error(`EXEC_${card.id}_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount}`);
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));

  return {
    logOperation: targetBlocks[0],
    consumed,
    inserted: inserted[0],
    beforeCount,
    afterCount,
    finalHand: incremental.after.cards || []
  };
}

async function runSimpleDrawSpellTest(options) {
  const {
    card,
    debugName,
    testEntry,
    passScope
  } = options || {};
  if (!card || !card.id || !card.name) throw new Error('EXEC_SIMPLE_DRAW_CARD_REQUIRED');

  assertSupportedNode();

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    debugName || `${card.id}_${card.name}`,
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;

    // Same baseline path as the already live-PASS M09 test.  Do not create
    // another hand scanner here: 1~7 uses observer TITLE_COMPONENTS, 8~12 DENSE.
    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, 'observer_baseline')
    });

    if (Number.isInteger(card.minHandCountBeforeActivation) &&
        baseline.handCount < card.minHandCountBeforeActivation) {
      throw new Error(
        `EXEC_${card.id}_HAND_COUNT_BELOW_ACTIVATION_MIN:` +
        `${baseline.handCount}<${card.minHandCountBeforeActivation}`
      );
    }

    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const targetCount = baseline.cards.filter(item => item && item.id === card.id).length;
    if (!targetCount) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }

    console.log('\n============================================================');
    console.log(`准备自动操作：${card.name}[${card.id}]`);
    console.log('完全沿用已实战PASS的暴发户执行骨架：observer基线 -> observer真实定位 -> 发动 -> 纯等待 -> observer验收。');
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

    const terminalWatchExpected = process.env.MD_V5_EXODIA_VICTORY_RISK === '1';
    if (terminalWatchExpected) {
      console.log(
        `已点击“发动”：${card.name}[${card.id}]；` +
        '本动作存在艾克佐迪亚终局，立即转入被动终局轮询，不等待固定动画时长。'
      );
      await sleep(250);
    } else {
      console.log(`已点击“发动”：${card.name}[${card.id}]；现在纯等待抽1结算。`);
      await sleep(card.settleAfterActivationMs || 2600);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  // Exactly like the working M09 harness: official observer owns all log and
  // hand-delta truth after the physical activation.
  const outcomeBeforeMtimeMs = outcomeMtimeMs();
  const observerStartedAt = Date.now();
  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  // During a victory animation the INFO overlay is unavailable, so an Exodia
  // terminal must never fall through into ordinary hand-count/log validation.
  // A fresh strict terminal result is itself the final proof of this action.
  const terminalOutcome = readFreshVictoryOutcome(outcomeBeforeMtimeMs, observerStartedAt);
  if (terminalOutcome) {
    copyIfExists(OUTCOME_RESULT_PATH, path.join(attemptDir, 'duel_outcome_result.json'));
    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_TERMINAL_VICTORY',
      completedAt: new Date().toISOString(),
      target: { id: card.id, name: card.name },
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      selected,
      actionProof,
      terminalOutcome
    });

    markExecutionPass({
      id: card.id,
      name: card.name,
      testEntry,
      evidenceDir: attemptDir,
      scope: '发动后由成熟终局检测确认艾克佐迪亚胜利；终局期间禁止INFO手牌数与普通右栏验收'
    });

    console.log('\n============================================================');
    console.log(`${card.id}执行终局 PASS: ${card.name}`);
    console.log('严格胜利证据已成熟；跳过INFO手牌数、普通右栏和抽1增量验收。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
    return { baseline, selected, actionProof, terminalOutcome, attemptDir };
  }

  const verified = verifyOneForOneDraw(card, baseline.handCount, attemptDir);
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
    testEntry,
    evidenceDir: attemptDir,
    scope: passScope || 'observer基线+真实定位；发动后抽1；正式observer验证消耗1张、新增1张、最终手牌数不变'
  });

  console.log('\n============================================================');
  console.log(`${card.id}执行测试 PASS: ${card.name}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`实际抽到: ${verified.inserted.card.name}[${verified.inserted.card.id}] @手牌${verified.inserted.slot}`);
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');

  return { baseline, selected, actionProof, verified, attemptDir };
}

module.exports = {
  runSimpleDrawSpellTest,
  verifyOneForOneDraw,
  readFreshVictoryOutcome
};
