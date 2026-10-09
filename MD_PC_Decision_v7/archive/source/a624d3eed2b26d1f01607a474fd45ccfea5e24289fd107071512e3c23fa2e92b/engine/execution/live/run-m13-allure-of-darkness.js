'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { findAllureBanishCandidate } = require(path.join(ROOT, 'lib', 'allure-policy'));
const card = require(path.join(ROOT, 'execution', 'cards', 'm13-allure-of-darkness'));
const {
  MdFastBridge,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
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
const { selectM13BanishTarget } = require(path.join(
  ROOT,
  'execution',
  'core',
  'm13-banish-selection'
));
const { markExecutionPass } = require(path.join(
  ROOT,
  'execution',
  'core',
  'verified-status'
));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);
const DUEL_OUTCOME_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'duel-outcome-live',
  'latest_result.json'
);
const PREPARED_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'scan-state-live',
  'prepared',
  'result.json'
);
const RESUME_BANISH_PROMPT = process.argv.includes('--resume-banish-prompt');

function assertSupportedNode() {
  const major = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(
      `NODE_VERSION_TOO_OLD:${process.versions.node || 'UNKNOWN'};需要 Node >= 20。`
    );
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
  if (out.status !== 0) {
    throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
  }
}


function choosePlan(baseline) {
  const allureMatches = (baseline.cards || []).filter(item => item && item.id === card.id);
  if (!allureMatches.length) {
    throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
  }

  if (baseline.handCount < card.minHandCountBeforeActivation) {
    throw new Error(
      `M13_HAND_COUNT_BELOW_ACTIVATION_MIN:` +
      `${baseline.handCount}<${card.minHandCountBeforeActivation}`
    );
  }

  // Preserve the existing decision rule: M13 is not auto-activated merely
  // because Master Duel shows an activation button.  We require a safe DARK
  // target already known before activation: M06 first, M08 only as fallback.
  const safe = findAllureBanishCandidate(baseline.cards || []);
  if (!safe) {
    throw new Error(
      'M13_ACTIVATION_FORBIDDEN_NO_SAFE_DARK:' +
      '发动前手牌没有闪刀姬－零衣[M06]或闪术兵器－H.A.M.P.[M08]。'
    );
  }

  const allure = allureMatches[0];
  return {
    allure: {
      id: card.id,
      name: card.name,
      slot: Number(allure.index) || baseline.cards.indexOf(allure) + 1,
      duplicateCount: allureMatches.length
    },
    safeBeforeActivation: safe,
    priority: card.safeBanishPriority
  };
}

function outcomeMtime() {
  try {
    return fs.existsSync(DUEL_OUTCOME_RESULT_PATH)
      ? Number(fs.statSync(DUEL_OUTCOME_RESULT_PATH).mtimeMs || 0)
      : 0;
  } catch (_) {
    return 0;
  }
}

function readFreshStrictVictory(previousMtime) {
  try {
    if (!fs.existsSync(DUEL_OUTCOME_RESULT_PATH)) return null;
    const currentMtime = Number(fs.statSync(DUEL_OUTCOME_RESULT_PATH).mtimeMs || 0);
    if (!(currentMtime > Number(previousMtime || 0))) return null;
    const outcome = readJson(DUEL_OUTCOME_RESULT_PATH);
    if (
      outcome &&
      outcome.terminal === true &&
      outcome.type === 'VICTORY' &&
      outcome.strictEvidence &&
      outcome.strictEvidence.matched === true
    ) {
      return outcome;
    }
  } catch (_) {}
  return null;
}

function verifyM13ObserverResult({ baseline, banishProof, attemptDir }) {
  const { verifyM13Observation } = require('../../lib/m13-observer-verification');
  const verified = verifyM13Observation({ baseline, banishProof,
    log: readJson(LOG_RESULT_PATH), incremental: readJson(INCREMENTAL_RESULT_PATH) });
  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(INCREMENTAL_RESULT_PATH, path.join(attemptDir, 'hand_incremental_result.json'));
  return verified;
}

function verifySavedM13ObserverResult(checkpoint) {
  const { verifySavedM13Observation } = require('../../lib/m13-observer-verification');
  return verifySavedM13Observation({ checkpoint,
    log: readJson(LOG_RESULT_PATH), incremental: readJson(INCREMENTAL_RESULT_PATH),
    hand: readJson(path.join(ROOT, 'debug/hand-change-live/session_state.json')),
    ledger: readJson(path.join(ROOT, 'debug/main-deck-ledger/state.json')) });
}

async function main() {
  assertSupportedNode();

  if (process.argv.includes('--last-resort-raye')) {
    const { runM13LastResort } = require('../core/m13-last-resort');
    const result = await runM13LastResort({ resume: process.argv.includes('--resume-last-resort'),
      verifySavedObservation: verifySavedM13ObserverResult,
      observe: async verification => {
        const outcomeBeforeObserver = outcomeMtime();
        runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
        const terminalOutcome = readFreshStrictVictory(outcomeBeforeObserver);
        if (terminalOutcome) return { status: 'TERMINAL_VICTORY', terminalOutcome };
        return { status: 'PASS', observerVerification: verifyM13ObserverResult(verification) };
      } });
    console.log(`M13最后尝试完成：${result.status}；记录=${result.debugDir}`);
    return;
  }

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    RESUME_BANISH_PROMPT
      ? 'M13_allure_of_darkness_resume_banish'
      : 'M13_allure_of_darkness',
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let plan;
  let selected;
  let actionProof;
  let banishProof;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;

    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    if (RESUME_BANISH_PROMPT) {
      if (!fs.existsSync(PREPARED_RESULT_PATH)) {
        throw new Error('M13_RESUME_BASELINE_MISSING');
      }
      baseline = readJson(PREPARED_RESULT_PATH);
      if (!baseline || baseline.status !== 'PASS' ||
          !Number.isInteger(baseline.handCount) ||
          !Array.isArray(baseline.cards) ||
          baseline.cards.length !== baseline.handCount) {
        throw new Error('M13_RESUME_BASELINE_INVALID');
      }
      plan = choosePlan(baseline);

      console.log('\n============================================================');
      console.log('M13恢复模式：当前已经停在暗之诱惑除外窗口。');
      console.log('不重新读INFO、不重新扫描普通手牌、不重新发动暗之诱惑；只续除外目标选择。');
      console.log('============================================================');
    } else {
      // Same sealed baseline used by M09/M15.  No M13-specific hand scanner.
      baseline = await establishCurrentObserverBaseline({
        bridge,
        info,
        outputDir: path.join(attemptDir, 'observer_baseline')
      });

      plan = choosePlan(baseline);
      console.log('\n暗之诱惑本轮计划：');
      console.log(`  发动: 暗之诱惑[M13] @手牌${plan.allure.slot}`);
      console.log('  除外优先级: 闪刀姬－零衣[M06] > 闪术兵器－H.A.M.P.[M08]');
      console.log(
        `  发动前安全目标: ${plan.safeBeforeActivation.name}[${plan.safeBeforeActivation.id}] ` +
        `@原手牌${plan.safeBeforeActivation.originalSlot}`
      );

      console.log('\n============================================================');
      console.log('准备自动操作：暗之诱惑[M13]');
      console.log('普通部分沿用已封板M09/M15：observer基线 -> observer真实定位 -> 发动。');
      console.log('特殊部分只处理暗之诱惑专用除外窗口：逐候选精确认 -> M06优先/M08后备 -> 选择/确认。');
      console.log('抽2和最终结算动画期间不按i、不拖手牌、不点其他区域。');
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

      console.log('已点击“发动”：暗之诱惑[M13]；现在零输入等待抽2并出现除外窗口。');
    }

    // waitForBanishPrompt only captures; it sends no input while draw animation
    // is running.  Once the dedicated prompt is proven stable, candidate scans
    // begin.
    banishProof = await selectM13BanishTarget({
      bridge,
      info,
      library,
      templates,
      priority: card.safeBanishPriority,
      plannedBeforeActivation: plan.safeBeforeActivation,
      debugDir: attemptDir
    });

    console.log(
      `暗之诱惑除外确认完成: ${banishProof.selected.name}[${banishProof.selected.id}]；` +
      `纯等待${card.settleAfterBanishMs}ms让最终动画稳定。`
    );
    await sleep(card.settleAfterBanishMs);

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      resumeBanishPrompt: RESUME_BANISH_PROMPT,
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      plan,
      selected,
      actionProof,
      banishProof
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  // Final truth remains the frozen production observer. Unlike ordinary draw
  // cards, M13 finishes its mandatory banish before Master Duel exposes the
  // Exodia terminal screen.  A fresh strict terminal result ends this duel;
  // ordinary right-log/hand multiset verification must not run afterward.
  const outcomeBeforeObserver = outcomeMtime();
  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  const terminalVictory = readFreshStrictVictory(outcomeBeforeObserver);
  if (terminalVictory) {
    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'TERMINAL_VICTORY',
      completedAt: new Date().toISOString(),
      target: { id: card.id, name: card.name },
      plan,
      selected,
      actionProof,
      banishProof,
      terminalOutcome: terminalVictory
    });
    console.log('\n============================================================');
    console.log('M13终局 PASS: 暗之诱惑已完成抽2与强制除外；严格确认艾克佐迪亚胜利。');
    console.log('终局后不再读取右栏、不再验收普通手牌增量、不再发送任何输入。');
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
    return;
  }

  const verified = verifyM13ObserverResult({ baseline, banishProof, attemptDir });

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    plan,
    selected,
    actionProof,
    banishProof,
    observerVerification: verified
  });

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m13-allure-of-darkness.cmd',
    evidenceDir: attemptDir,
    scope:
      '1~12张手牌；普通发动复用已封板M09/M15 observer真实定位；' +
      '暗之诱惑专用除外窗口逐候选精确认；M06优先、M08后备；' +
      '正式observer验证抽2+除外1+M13离手且最终手牌数不变'
  });

  console.log('\n============================================================');
  console.log('M13执行测试 PASS: 暗之诱惑');
  console.log(`实际除外: ${verified.banished.name}[${verified.banished.id}]`);
  console.log(
    `右栏抽到: ${verified.drawn.map(item => `${item.name}[${item.id}]`).join(' / ')}`
  );
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM13执行测试停止: ${error && error.stack ? error.stack : error}`);
  console.error(
    '如果已经停在暗之诱惑除外窗口，请保持当前画面；程序不会把失败状态自动标记为PASS。'
  );
  process.exitCode = 1;
});
