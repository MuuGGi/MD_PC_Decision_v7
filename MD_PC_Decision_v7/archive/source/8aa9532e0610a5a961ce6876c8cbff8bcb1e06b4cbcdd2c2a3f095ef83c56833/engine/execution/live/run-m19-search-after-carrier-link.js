'use strict';

const fs = require('fs');
const path = require('path');
const {readJsonIfExistsSafe: readJsonIfExists, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const D2_SCRIPT = path.join(ROOT, 'execution', 'tests', 'run-m19-equip-link-carrier.js');
const D2_ROOT = path.join(ROOT, 'debug', 'execution', 'D2_m19_carrier_link');
const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const { MdFastBridge, captureReferenceRoi } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const {
  waitOptionalPool,
  selectM19FromOptionalPool,
  waitForBambooPromptAfterM19,
  selectBambooSearchTarget
} = require(path.join(ROOT, 'execution', 'core', 'm19-search-execution'));

const resumeOptional = process.argv.slice(2).includes('--resume-optional');

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

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}


function latestD2Pass() {
  if (!fs.existsSync(D2_ROOT)) return null;
  return fs.readdirSync(D2_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(D2_ROOT, entry.name);
      const resultPath = path.join(dir, 'result.json');
      const result = readJsonIfExists(resultPath);
      if (!result || result.status !== 'PASS_CANDIDATE') return null;
      return { dir, resultPath, result, mtimeMs: fs.statSync(resultPath).mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function runD2() {
  console.log('\n============================================================');
  console.log('D3前半段直接复用已经PASS的D1+D2。');
  console.log('D2完成并停在“请选择要发动的任意效果”窗口后，D3继续处理妖刀检索。');
  console.log('============================================================\n');
  const out = spawnSync(process.execPath, [D2_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`D3_D2_PREREQUISITE_FAILED:exit=${out.status || 1}`);
}

async function activateGameAndGetInfo(bridge) {
  const activation = await activateAndVerifyMasterDuel(bridge);
  return activation.info;
}

async function saveNode(bridge, info, attemptDir, label, extra = null) {
  const dir = path.join(attemptDir, 'nodes');
  ensureDir(dir);
  const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
  saveRgbaPng(image, path.join(dir, `${label}.png`));
  writeJson(path.join(dir, `${label}.json`), {
    capturedAt: new Date().toISOString(),
    label,
    extra
  });
  console.log(`节点已保存: ${label}`);
}

async function checkpoint(rl, { prompt, bridge, infoGetter, attemptDir, label, extra = null }) {
  let retry = 0;
  while (true) {
    const answer = (await rl.question(prompt)).trim().toUpperCase();
    if (answer === 'Q') return 'QUIT';
    if (answer === 'R') {
      retry++;
      const info = await infoGetter();
      await saveNode(bridge, info, attemptDir, `${label}_R${retry}`, extra);
      console.log('R只重拍当前节点，不向游戏输入。');
      continue;
    }
    if (!answer) return 'ENTER';
    console.log('只接受 Enter / R / Q。');
  }
}

function flattenLogBlocks(log) {
  const lists = [
    log && log.newOperationBlocks,
    log && log.extendedOperationBlocks,
    log && log.operationBlocks,
    log && log.newActivationBlocks,
    log && log.activationBlocks
  ];
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const block of list) {
      const fp = `${block && block.activationKey || ''}|${block && block.signature || ''}|${block && block.index || ''}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(block);
    }
  }
  return out;
}

function cardCountInState(state, cardId) {
  const cards = state && (state.cards || state.hand || state.handCards || state.orderedCards);
  if (!Array.isArray(cards)) return null;
  return cards.filter(item => {
    const card = item && item.card ? item.card : item;
    return card && card.id === cardId;
  }).length;
}

function verifyFinalObserver(selected) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') {
    throw new Error(`D3_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  }

  const beforeCount = incremental.before && incremental.before.handCount;
  const afterCount = incremental.after && incremental.after.handCount;
  if (!Number.isInteger(beforeCount) || !Number.isInteger(afterCount) || afterCount !== beforeCount + 1) {
    throw new Error(`D3_HAND_DELTA_INVALID:${beforeCount}->${afterCount};expected=+1`);
  }

  const inserted = Array.isArray(incremental.insertedCards) ? incremental.insertedCards : [];
  const insertedIds = inserted.map(item => item && item.card && item.card.id).filter(Boolean);
  const exactInserted = insertedIds.includes(selected.id);
  const beforeCopies = cardCountInState(incremental.before, selected.id);
  const afterCopies = cardCountInState(incremental.after, selected.id);
  const countProof = Number.isInteger(beforeCopies) && Number.isInteger(afterCopies) && afterCopies === beforeCopies + 1;
  if (!exactInserted && !countProof) {
    throw new Error(
      `D3_SEARCH_RESULT_NOT_RECONCILED:selected=${selected.id};` +
      `inserted=${insertedIds.join('>') || 'NONE'};copies=${beforeCopies}->${afterCopies}`
    );
  }

  const blocks = flattenLogBlocks(log);
  const m19Blocks = blocks.filter(block => block && block.activationKey === 'M19');
  if (!m19Blocks.length) {
    throw new Error('D3_M19_LOG_BLOCK_NOT_FOUND');
  }

  return {
    beforeCount,
    afterCount,
    insertedIds,
    selected,
    rightLogM19Blocks: m19Blocks.length,
    evidence: exactInserted ? 'INCREMENTAL_INSERTED_CARD' : 'HAND_COPY_COUNT_DELTA'
  };
}

function runFinalObserver() {
  const out = spawnSync(process.execPath, [
    path.join(ROOT, 'runtime/observer/run-live-incremental.js'),
    '--adjacent-checkpoint-only'
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`D3_FINAL_OBSERVER_FAILED:exit=${out.status || 1}`);
}

async function main() {
  assertSupportedNode();
  if (!fs.existsSync(D2_SCRIPT)) {
    throw new Error('D3_REQUIRES_D2_PATCH:缺少 execution/live/run-m19-equip-link-carrier.js');
  }

  if (!resumeOptional) runD2();
  const d2 = latestD2Pass();
  if (!d2) {
    throw new Error(resumeOptional ? 'D3_RESUME_REQUIRES_RECENT_D2_PASS_RESULT' : 'D3_D2_PASS_RESULT_NOT_FOUND');
  }

  const attemptDir = path.join(ROOT, 'debug', 'execution', 'D3_m19_search', timestampId());
  ensureDir(attemptDir);
  const rl = readline.createInterface({ input, output });
  const bridge = new MdFastBridge();
  let started = false;

  try {
    console.log('\n============================================================');
    console.log(`D3 刀支线操作层测试：${resumeOptional ? '从当前D2可选效果池恢复' : 'D2完成'} → 妖刀竹光墓地检索`);
    console.log('流程：识别妖刀效果 → 选择 → 若有其他效果则取消 → 进入竹光检索 → 优先真刀竹光 → 选择 → observer验收手牌+1。');
    console.log('本轮仍不写 verified-cards.json。');
    console.log('交互键：Enter=进入下一自动节点；R=只重拍；Q=原地退出。');
    console.log('============================================================');

    await bridge.start();
    started = true;
    let info = await activateGameAndGetInfo(bridge);
    const optionalPool = await waitOptionalPool({
      bridge,
      info,
      debugDir: path.join(attemptDir, '00_optional_pool')
    });
    await saveNode(bridge, info, attemptDir, '00_d2_optional_pool_ready', { d2Result: d2.resultPath, optionalPool });
    console.log(`D3节点0 PASS：Link后可选效果池存在；candidates=${optionalPool.candidateCount}。`);

    let control = await checkpoint(rl, {
      prompt: 'Enter=逐张精确认可选效果并选择妖刀竹光；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '00_optional_pool_hold',
      extra: { optionalPool }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const m19Selection = await selectM19FromOptionalPool({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '01_select_m19_effect')
    });
    const bambooWindow = await waitForBambooPromptAfterM19({
      bridge,
      info,
      originalCandidateCount: m19Selection.pool.candidateCount,
      debugDir: path.join(attemptDir, '02_wait_bamboo_prompt')
    });
    await saveNode(bridge, info, attemptDir, '02_bamboo_target_prompt_ready', {
      m19Selection,
      bambooWindow
    });
    console.log('\nD3节点1 PASS：妖刀竹光墓地效果已选择，当前已进入竹光检索对象窗口。');

    control = await checkpoint(rl, {
      prompt: 'Enter=识别全部竹光候选并优先选择真刀竹光；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '02_bamboo_prompt_hold',
      extra: { bambooWindow }
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const targetSelection = await selectBambooSearchTarget({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '03_select_bamboo')
    });
    await saveNode(bridge, info, attemptDir, '03_bamboo_selected_and_submitted', { targetSelection });
    console.log(`\nD3节点2 PASS：已提交妖刀检索目标 ${targetSelection.selected.name}[${targetSelection.selected.id}]。`);

    control = await checkpoint(rl, {
      prompt: '等检索动画/入手完全结束并回到稳定场面后按Enter=最终observer；R=重拍；Q=退出：',
      bridge,
      infoGetter: () => activateGameAndGetInfo(bridge),
      attemptDir,
      label: '03_wait_final_settle',
      extra: { targetSelection }
    });
    if (control === 'QUIT') return;

    if (started) {
      await bridge.stop().catch(() => {});
      started = false;
    }
    runFinalObserver();
    const verified = verifyFinalObserver(targetSelection.selected);

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D3_M19_CARRIER_LINK_THEN_SEARCH',
      resumeOptional,
      d2ResultPath: d2.resultPath,
      m19Selection,
      bambooWindow,
      targetSelection,
      verified,
      sealed: false
    });

    console.log('\n============================================================');
    console.log('D3候选PASS：妖刀竹光已因carrier Link送墓并完成墓地检索。');
    console.log(`检索结果: ${targetSelection.selected.name}[${targetSelection.selected.id}]`);
    console.log(`手牌数: ${verified.beforeCount} -> ${verified.afterCount}`);
    console.log(`右栏妖刀块: ${verified.rightLogM19Blocks}`);
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (started) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD3 妖刀检索测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前窗口；把终端输出和debug/execution/D3_m19_search最新节点发回来。');
  process.exitCode = 1;
});
