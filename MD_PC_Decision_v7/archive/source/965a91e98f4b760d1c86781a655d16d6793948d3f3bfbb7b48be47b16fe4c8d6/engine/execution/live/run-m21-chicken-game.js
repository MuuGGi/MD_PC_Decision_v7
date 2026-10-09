'use strict';

const fs = require('fs');
const { loadPendingM21Transaction, beginM21Transaction, saveM21Stage,
  commitM21Placement, completeM21Transaction, LOG_STATE_PATH } = require('../../lib/m21-field-transaction');
const path = require('path');
const {readJson, writeJsonAtomic, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm21-chicken-game'));
const { MdFastBridge } = require(path.join(ROOT, 'lib', 'win-fast'));
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
const {
  LOG_RESULT_PATH,
  waitForFieldPlacementLog,
  commitKnownM21Consumption,
  clickFieldCardAndVerify,
  clickFieldEffectButton,
  confirmDefaultDrawOne,
  validateFinalDraw
} = require(path.join(
  ROOT,
  'execution',
  'core',
  'm21-chicken-game-route'
));
const { markExecutionPass } = require(path.join(
  ROOT,
  'execution',
  'core',
  'verified-status'
));

const HAND_STATE_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'session_state.json'
);
const ROUTE_DIR = path.join(
  ROOT,
  'debug',
  'execution',
  'M21_chicken_game'
);

const argv = process.argv.slice(2);
const V5_FIELD_ONLY = argv.includes('--v5-field-only');
const V5_DRAW_ONLY = argv.includes('--v5-draw-only');
const RESUME_STAGE = argv.includes('--resume-m21-stage');
if (V5_FIELD_ONLY && V5_DRAW_ONLY) {
  throw new Error('M21_V5_MODE_CONFLICT:field-only+draw-only');
}

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

function validateSessionState(state, label) {
  const count = Number(state && state.handCount);
  const cards = Array.isArray(state && state.cards) ? state.cards : [];
  if (!Number.isInteger(count) || cards.length !== count) {
    throw new Error(`${label}_HAND_STATE_INVALID:${count}/${cards.length}`);
  }
  return state;
}

async function runDrawOnly(attemptDir, pending = null) {
  if (!pending) pending = beginM21Transaction({ before: readJson(HAND_STATE_PATH),
    decisionBefore: readJson(path.join(ROOT, 'decision-state.json')), attemptDir, drawOnly: true });
  const beforeDraw = validateSessionState(pending.beforeDraw, 'M21_DRAW_ONLY');
  const stageAtEntry = pending.stage;
  const committed = readJson(HAND_STATE_PATH);
  const alreadyObserved = stageAtEntry === 'OBSERVER_STARTED' &&
    committed.revision === beforeDraw.revision + 1 && committed.handCount === beforeDraw.handCount + 1 &&
    committed.cards?.length === committed.handCount;
  if (!alreadyObserved && JSON.stringify(committed) !== JSON.stringify(beforeDraw)) {
    throw new Error('M21_DRAW_BASELINE_CHANGED');
  }
  const bridge = new MdFastBridge();
  let fieldCardProof;
  let fieldEffectProof;
  let drawConfirmProof;

  if (!['DRAW_CONFIRM_STARTED', 'OBSERVER_STARTED'].includes(stageAtEntry)) {
  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    console.log('\n============================================================');
    console.log('M21延后抽1续跑：试胆竞速已经在场，本次绝不重新发动手牌M21。');
    console.log('只执行：确认场上M21 -> 发动效果 -> 默认抽1 -> OK -> observer。');
    console.log(`续跑前内部手牌=${beforeDraw.handCount}张。`);
    console.log('============================================================');

    if (stageAtEntry === 'PLACEMENT_COMMITTED') {
    fieldCardProof = await clickFieldCardAndVerify({
      bridge,
      info,
      library,
      templates,
      card,
      debugDir: path.join(attemptDir, '03_field_effect')
    });

    fieldEffectProof = await clickFieldEffectButton({
      bridge,
      info,
      card,
      debugDir: path.join(attemptDir, '03_field_effect'),
      beforeSubmit: () => { pending = saveM21Stage(pending, 'FIELD_EFFECT_STARTED'); }
    });
    }

    console.log('场上“发动效果”已点击：现在只截图等待抽1选项窗口，不发送其他输入。');

    drawConfirmProof = await confirmDefaultDrawOne({
      bridge,
      info,
      card,
      debugDir: path.join(attemptDir, '04_draw_option'),
      beforeSubmit: () => { pending = saveM21Stage(pending, 'DRAW_CONFIRM_STARTED'); }
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  }
  const outcomePath = path.join(ROOT, 'debug/duel-outcome-live/latest_result.json');
  const outcomeBefore = fs.existsSync(outcomePath) ? fs.statSync(outcomePath).mtimeMs : 0;
  pending = saveM21Stage(pending, 'OBSERVER_STARTED');
  if (!alreadyObserved) runNodeFromRoot('runtime/observer/run-live-incremental.js',
    ['--adjacent-checkpoint-only', '--expected-atomic-activation=M21']);

  if (fs.existsSync(outcomePath) && fs.statSync(outcomePath).mtimeMs > outcomeBefore) {
    const outcome = readJson(outcomePath);
    if (outcome.terminal === true && outcome.type === 'VICTORY' && outcome.strictEvidence?.matched === true) {
      completeM21Transaction(pending);
      writeJson(path.join(attemptDir, 'result.json'), { status: 'TERMINAL_VICTORY', outcome });
      return;
    }
  }

  // validateFinalDraw 的历史口径是：中间手牌=baseline-1，抽后=baseline。
  // draw-only 入口的 beforeDraw 就是那个“中间手牌”，因此传 before+1 即可复用同一封板验收。
  const verified = validateFinalDraw({
    baselineHandCount: beforeDraw.handCount + 1,
    card
  });
  if (alreadyObserved && JSON.stringify(committed.cards.map(c => c.id)) !==
      JSON.stringify(verified.finalHand.map(c => c.id))) throw new Error('M21_COMMITTED_DRAW_HAND_MISMATCH');

  copyIfExists(
    LOG_RESULT_PATH,
    path.join(attemptDir, '05_final_duel_log.json')
  );
  copyIfExists(
    path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json'),
    path.join(attemptDir, '05_final_hand_incremental.json')
  );

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS_DRAW_ONLY',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    beforeDrawHandCount: beforeDraw.handCount,
    fieldCardProof,
    fieldEffectProof,
    drawConfirmProof,
    observerVerification: verified
  });

  console.log('\n============================================================');
  completeM21Transaction(pending);
  console.log('M21延后抽1 PASS: 试胆竞速');
  console.log(`抽到: ${verified.drawn.name}[${verified.drawn.id}]`);
  console.log(`手牌: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

async function runFromHand(attemptDir) {
  const bridge = new MdFastBridge();
  let baseline;
  let fieldPlacement;
  let actionProof;
  let pending;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;

    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, '00_baseline')
    });

    const candidates = (baseline.cards || []).filter(item => item && item.id === card.id);
    if (!candidates.length) {
      throw new Error(`M21_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }

    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    console.log('\n============================================================');
    console.log('准备自动操作：试胆竞速[M21]');
    console.log('阶段1普通发动完全复用封板执行：observer基线 -> observer真实位置 -> 发动。');
    console.log('发动后只读右栏确认落场，不读INFO、不点击手牌；随后明确提交M21离手 -1。');
    console.log(
      V5_FIELD_ONLY
        ? 'V5本轮只做阶段1：新场地落场后立即停住，把场上抽1留给顶层决策；不会点场上M21。'
        : '阶段2沿用旧M21现场PASS：固定场地区M21 -> 发动效果 -> 默认抽1 -> OK -> observer。'
    );
    console.log('所有“点卡 -> 下一按钮/OK”都增加600ms间隔；动画阶段只等待。');
    console.log('============================================================');

    const selected = await selectObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline,
      expectedId: card.id,
      debugDir: path.join(attemptDir, '01_hand_activation')
    });

    console.log(
      `发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS @手牌${selected.slot}`
    );

    pending = beginM21Transaction({ before: readJson(HAND_STATE_PATH),
      decisionBefore: readJson(path.join(ROOT, 'decision-state.json')), selectedSlot: selected.slot,
      attemptDir, fieldOnly: V5_FIELD_ONLY });
    actionProof = await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: card.id,
      expectedName: card.name,
      clickReference: selected.clickReference,
      debugDir: path.join(attemptDir, '01_hand_activation')
    });

    console.log('已点击“发动”：试胆竞速[M21]；现在纯等待落场动画并只重读右栏。');

    fieldPlacement = await waitForFieldPlacementLog({
      bridge,
      info,
      card
    });

    copyIfExists(
      LOG_RESULT_PATH,
      path.join(attemptDir, '02_field_placement_duel_log.json')
    );

    pending = commitM21Placement(pending, fieldPlacement.log, fieldPlacement.block);
    const afterFieldState = pending.beforeDraw;

    console.log('\n============================================================');
    console.log('M21阶段1 PASS: 试胆竞速已从手牌发动并留在场地区。');
    console.log(`我方手牌内部提交: ${baseline.handCount} -> ${afterFieldState.handCount}`);
    console.log(
      V5_FIELD_ONLY
        ? '本轮按V5固定检索优先规则停在这里：场上抽1保持未使用。'
        : '现在同一命令继续场上抽1效果。'
    );
    console.log('============================================================');

    if (V5_FIELD_ONLY) {
      writeJson(path.join(attemptDir, 'result.json'), {
        status: 'PASS_FIELD_ONLY_DRAW_PENDING',
        completedAt: new Date().toISOString(),
        target: { id: card.id, name: card.name },
        baselineHandCount: baseline.handCount,
        fieldHandCount: afterFieldState.handCount,
        actionProof,
        fieldPlacement: {
          attempts: fieldPlacement.attempts,
          blockCount: fieldPlacement.blockCount,
          operation: fieldPlacement.block
        },
        drawPending: true
      });
      completeM21Transaction(pending, { fieldOnly: true });
      console.log('M21阶段1-only PASS：没有点击场上M21，没有发动抽1。');
      return;
    }

  } finally {
    await bridge.stop().catch(() => {});
  }
  await runDrawOnly(attemptDir, pending);
  markExecutionPass({ id: card.id, name: card.name,
    testEntry: 'execution\\live\\run-m21-chicken-game.cmd', evidenceDir: attemptDir,
    scope: '成熟落场/场上抽1；分阶段保存；共享增量提交手牌与账本；无新手牌点击' });
}

async function resumeM21Stage(pending) {
  if (pending.stage === 'HAND_ACTIVATION_STARTED') {
    // The original hand click is never replayed, even if the crash occurred
    // before the submit receipt. Only a fresh M21 placement log may advance.
    if (pending.observerBefore) writeJsonAtomic(LOG_STATE_PATH, pending.observerBefore);
    const bridge = new MdFastBridge();
    await bridge.start();
    try {
      const activation = await activateAndVerifyMasterDuel(bridge);
      const placement = await waitForFieldPlacementLog({ bridge, info: activation.info, card });
      pending = commitM21Placement(pending, placement.log, placement.block);
    } finally { await bridge.stop().catch(() => {}); }
  }
  if (pending.fieldOnly && pending.stage === 'PLACEMENT_COMMITTED') {
    completeM21Transaction(pending, { fieldOnly: true });
    return;
  }
  return runDrawOnly(pending.attemptDir, pending);
}

async function main() {
  assertSupportedNode();
  const pending = loadPendingM21Transaction();
  if (RESUME_STAGE) {
    if (!pending) throw new Error('M21_RESUME_WITHOUT_PENDING_STAGE');
    await resumeM21Stage(pending);
    return;
  }
  if (pending) throw new Error('M21_PENDING_TRANSACTION_NO_REACTIVATION');
  const attemptDir = path.join(ROUTE_DIR, timestampId());
  ensureDir(attemptDir);

  if (V5_DRAW_ONLY) {
    await runDrawOnly(attemptDir);
    return;
  }
  await runFromHand(attemptDir);
}

main().catch(error => {
  console.error(`\nM21执行测试停止: ${error && error.stack ? error.stack : error}`);
  console.error(
    V5_DRAW_ONLY
      ? '延后抽1续跑失败：不会重新点场上M21，不会自动改做其他手牌；保持现场。'
      : V5_FIELD_ONLY
        ? 'M21阶段1-only失败：不会继续场上抽1；保持现场。'
        : '已保存M21阶段；正式主循环只恢复后续，禁止重放手牌发动或完整重扫。'
  );
  process.exitCode = 1;
});
