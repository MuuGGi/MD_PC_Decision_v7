'use strict';

const fs = require('fs');
const path = require('path');
const { countRuntimeCardIds, changeRuntimeCardCount, canonicalRuntimeCardId } = require('../../lib/exodia-policy');
const {readJson, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm10-toon-table'));
const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
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
const { selectM10SearchTarget } = require(path.join(
  ROOT,
  'execution',
  'core',
  'm10-toon-table-search'
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

function countIds(cards) {
  return countRuntimeCardIds(cards);
}

function addCount(map, id, delta) {
  changeRuntimeCardCount(map, id, delta);
}

function detailCardId(detail) {
  return canonicalRuntimeCardId(detail && detail.card);
}

function verifyFinalMultiset({ baseline, searchedId, finalCards }) {
  const expected = countIds(baseline.cards);
  addCount(expected, card.id, -1);
  addCount(expected, searchedId, 1);

  const actual = countIds(finalCards);
  const all = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [];
  for (const id of all) {
    const e = expected.get(id) || 0;
    const a = actual.get(id) || 0;
    if (e !== a) mismatches.push(`${id}:${e}->${a}`);
  }
  if (mismatches.length) {
    throw new Error(`M10_FINAL_HAND_MULTISET_INVALID:${mismatches.join(',')}`);
  }
}

function verifyM10ObserverResult({ baseline, searchProof, attemptDir }) {
  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const targetBlocks = newBlocks.filter(block => block && block.activationKey === card.id);

  if (targetBlocks.length !== 1) {
    throw new Error(`M10_LOG_OPERATION_INVALID:${targetBlocks.length}/1`);
  }
  if (newBlocks.length !== 1) {
    throw new Error(
      `M10_UNEXPECTED_EXTRA_OPERATIONS:${newBlocks.map(block => block.activationKey).join('>')}`
    );
  }

  const gains = (targetBlocks[0].details || []).filter(detail =>
    detail &&
    detail.side === 'SELF' &&
    detail.role === 'HAND_GAIN_CANDIDATE'
  );
  if (gains.length !== 1) {
    throw new Error(`M10_RIGHT_LOG_GAIN_COUNT_INVALID:${gains.length}/1`);
  }

  const searchedId = searchProof && searchProof.selected && searchProof.selected.id;
  const loggedId = detailCardId(gains[0]);
  if (!searchedId || loggedId !== searchedId) {
    throw new Error(
      `M10_RIGHT_LOG_GAIN_INVALID:selected=${searchedId || 'NONE'};logged=${loggedId || 'NONE'}`
    );
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M10_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const after = incremental.after || {};
  if (after.handCount !== baseline.handCount) {
    throw new Error(
      `M10_HAND_COUNT_INVALID:${baseline.handCount}->${after.handCount};expected=${baseline.handCount}`
    );
  }

  const consumed = incremental.inference && incremental.inference.consumed;
  if (!consumed || consumed.id !== card.id) {
    throw new Error(`M10_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }

  verifyFinalMultiset({
    baseline,
    searchedId,
    finalCards: after.cards || []
  });

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_result.json'));
  copyIfExists(
    INCREMENTAL_RESULT_PATH,
    path.join(attemptDir, 'hand_incremental_result.json')
  );

  return {
    beforeCount: baseline.handCount,
    afterCount: after.handCount,
    gained: {
      id: loggedId,
      name: gains[0].card && gains[0].card.name || loggedId
    },
    insertedCards: incremental.insertedCards || [],
    finalHand: after.cards || [],
    operation: targetBlocks[0]
  };
}

async function main() {
  assertSupportedNode();

  const attemptDir = path.join(
    ROOT,
    'debug',
    'execution',
    'M10_toon_table',
    timestampId()
  );
  ensureDir(attemptDir);

  const bridge = new MdFastBridge();
  let baseline;
  let selected;
  let actionProof;
  let searchProof;

  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, 'observer_baseline')
    });

    const matches = (baseline.cards || []).filter(item => item && item.id === card.id);
    if (!matches.length) {
      throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${card.name}[${card.id}]`);
    }
    const first = matches[0];
    const slot = Number(first.index) || baseline.cards.indexOf(first) + 1;

    console.log('\n卡通目录本轮计划：');
    console.log(`  发动: 卡通目录[M10] @手牌${slot}`);
    console.log('  检索优先级: 卡通目录[M10] > 青眼卡通龙[M07]');
    console.log('  检索窗口遍历: 从左向右；看到青眼先记后备，仍继续确认是否存在卡通目录。');

    console.log('\n============================================================');
    console.log('准备自动操作：卡通目录[M10]');
    console.log('普通发动完全复用已封板M09/M15：observer基线 -> observer真实位置 -> 发动。');
    console.log('特殊部分直接移植旧M10实战PASS检索窗口：M10优先，无M10才M07。');
    console.log('候选选中并精确认后，统一多等600ms再点击“选择/确认”。');
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

    console.log('已点击“发动”：卡通目录[M10]；零输入等待专用检索窗口出现。');

    searchProof = await selectM10SearchTarget({
      bridge,
      info,
      library,
      templates,
      priority: card.searchPriority,
      debugDir: attemptDir
    });

    console.log(
      `卡通目录检索确认完成: ${searchProof.selected.name}[${searchProof.selected.id}]；` +
      `纯等待${card.settleAfterSearchMs}ms让检索动画稳定。`
    );
    await sleep(card.settleAfterSearchMs);

    writeJson(path.join(attemptDir, 'execution_click.json'), {
      capturedAt: new Date().toISOString(),
      baselineHandCount: baseline.handCount,
      baselineHand: baseline.cards,
      selected,
      actionProof,
      searchProof
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);

  const verified = verifyM10ObserverResult({
    baseline,
    searchProof,
    attemptDir
  });

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: card.id, name: card.name },
    baselineHandCount: baseline.handCount,
    baselineHand: baseline.cards,
    selected,
    actionProof,
    searchProof,
    observerVerification: verified
  });

  markExecutionPass({
    id: card.id,
    name: card.name,
    testEntry: 'execution\\live\\run-m10-toon-table.cmd',
    evidenceDir: attemptDir,
    scope:
      '1~12手牌；普通发动复用已封板M09/M15真实定位；卡通目录专用检索窗口左->右逐候选精确认；' +
      '检索优先M10>M07；候选确认后延迟600ms再提交；正式observer验证M10离手+检索1且手牌数不变'
  });

  console.log('\n============================================================');
  console.log('M10执行测试 PASS: 卡通目录');
  console.log(`实际检索: ${verified.gained.name}[${verified.gained.id}]`);
  console.log(`选择依据: ${searchProof.selectionReason}`);
  console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
  console.log(`测试记录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM10执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
