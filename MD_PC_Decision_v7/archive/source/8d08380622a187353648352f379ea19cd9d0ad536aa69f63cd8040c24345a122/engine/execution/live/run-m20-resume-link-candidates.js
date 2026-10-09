'use strict';

const fs = require('fs');
const path = require('path');
const {readJsonIfExistsSafe: readJsonIfExists, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const { isLegalBambooSearchTarget } = require(path.join(ROOT, 'lib', 'bamboo-search-policy'));
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const D4_EXCLUDED_LINK_IDS = ['E02']; // D4隔离路线禁止篝，避免额外回收效果混入。
const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { saveRgbaPng, recognizeCurrentCard } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { isKnownLinkMonsterId } = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));
const {
  waitForSummonCandidates,
  selectNextLegalLink,
  clickBottomSummonSubmit,
  proveCarrierMaterialSelectable,
  clickCarrierMaterial,
  clickMaterialBlueConfirm,
  waitForPostLinkOptionalPool
} = require(path.join(ROOT, 'execution', 'core', 'link-carrier-summon'));
const {
  selectM19FromOptionalPool,
  waitForBambooPromptAfterM19,
  selectBambooSearchTarget
} = require(path.join(ROOT, 'execution', 'core', 'm19-search-execution'));

const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const INCREMENTAL_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');

function assertSupportedNode() {
  const actual = String(process.versions.node || '');
  if (actual !== '20.11.1') {
    throw new Error(`NODE_VERSION_MISMATCH:${actual || 'UNKNOWN'};本测试固定要求 Node v20.11.1。`);
  }
  console.log('Node运行时: v20.11.1 PASS');
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function runNodeFromRoot(script, args = []) {
  console.log(`\n===== ${script}${args.length ? ` ${args.join(' ')}` : ''} =====`);
  const out = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
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
  writeJson(path.join(dir, `${label}.json`), { capturedAt: new Date().toISOString(), label, extra });
  console.log(`节点已保存: ${label}`);
}

async function checkpoint(rl, { prompt, bridge, attemptDir, label, extra = null }) {
  let retry = 0;
  while (true) {
    const answer = (await rl.question(prompt)).trim().toUpperCase();
    if (answer === 'Q') return 'QUIT';
    if (answer === 'R') {
      retry++;
      const info = await activateGameAndGetInfo(bridge);
      await saveNode(bridge, info, attemptDir, `${label}_R${retry}`, extra);
      console.log('R只重拍当前节点，不向游戏发送其它输入。');
      continue;
    }
    if (!answer) return 'ENTER';
    console.log('只接受 Enter / R / Q。');
  }
}

function findLatestD4LinkAttemptDir() {
  const root = path.join(ROOT, 'debug', 'execution', 'D4_m20_true_bamboo_route');
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const name of names) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'nodes', '09_carrier_before_link.json'))) return dir;
  }
  return null;
}

function loadCarrierState(attemptDir) {
  const node = readJsonIfExists(path.join(attemptDir, 'nodes', '09_carrier_before_link.json')) || {};
  const extra = node.extra || {};
  if (!extra.carrierReference || !Number.isFinite(extra.carrierReference.x) || !Number.isFinite(extra.carrierReference.y)) {
    throw new Error('D4_RESUME_LINK_CARRIER_REFERENCE_MISSING');
  }
  return {
    carrierReference: extra.carrierReference,
    carrierMode: extra.carrierMode || 'LINK',
    carrierZone: extra.carrierZone || 'UNKNOWN',
    carrierIdentity: extra.carrierIdentity || { id: null, name: 'UNKNOWN' }
  };
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

function inferM19SearchGainFromLog() {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const candidates = [];
  for (const block of flattenLogBlocks(log)) {
    if (!block || block.activationKey !== 'M19') continue;
    for (const detail of block.details || []) {
      const card = detail && detail.card;
      if (!card || !isLegalBambooSearchTarget(card.id)) continue;
      if (detail.rawType === 'HAND_GAIN' || detail.role === 'HAND_GAIN_CANDIDATE') {
        candidates.push({ id: card.id, name: card.name || (card.id === 'M20' ? '真刀竹光' : '金黄色的竹光') });
      }
    }
  }
  return candidates[candidates.length - 1] || null;
}

function verifyFinalSearch(selected) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') {
    throw new Error(`D4_RESUME_FINAL_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  }
  const beforeCount = incremental.before && incremental.before.handCount;
  const afterCount = incremental.after && incremental.after.handCount;
  if (!Number.isInteger(beforeCount) || !Number.isInteger(afterCount) || afterCount !== beforeCount + 1) {
    throw new Error(`D4_RESUME_FINAL_HAND_DELTA_INVALID:${beforeCount}->${afterCount};expected=+1`);
  }
  const inserted = Array.isArray(incremental.insertedCards) ? incremental.insertedCards : [];
  const insertedIds = inserted.map(x => x && x.card && x.card.id).filter(Boolean);
  const beforeCopies = cardCountInState(incremental.before, selected.id);
  const afterCopies = cardCountInState(incremental.after, selected.id);
  if (!insertedIds.includes(selected.id) && !(Number.isInteger(beforeCopies) && Number.isInteger(afterCopies) && afterCopies === beforeCopies + 1)) {
    throw new Error(`D4_RESUME_FINAL_SEARCH_CARD_NOT_RECONCILED:${selected.id};inserted=${insertedIds.join('>') || 'NONE'}`);
  }
  const m19Blocks = flattenLogBlocks(log).filter(block => block && block.activationKey === 'M19');
  if (!m19Blocks.length) throw new Error('D4_RESUME_FINAL_M19_LOG_BLOCK_NOT_FOUND');
  return { beforeCount, afterCount, insertedIds, m19Blocks: m19Blocks.length };
}

async function main() {
  assertSupportedNode();
  const args = process.argv.slice(2);
  const resumeSelected = args.includes('--selected');
  const resumeAfterBambooGain = args.includes('--after-bamboo-gain');
  const attemptDir = findLatestD4LinkAttemptDir();
  if (!attemptDir) throw new Error('D4_RESUME_LINK_NO_PREVIOUS_ATTEMPT');
  const carrier = loadCarrierState(attemptDir);

  // Recovery for the exact live state where the Bamboo Sword has already
  // entered the hand but the runner stopped before its final observer.
  // This branch sends no card/button input; it only runs the mature observer
  // and derives the actual M19 HAND_GAIN from the right log.
  if (resumeAfterBambooGain) {
    console.log('\n============================================================');
    console.log('D4局内恢复：妖刀检索已经实际入手，当前只做最终observer验收。');
    console.log('不会重新点击竹光候选，不会点击“选择”，不会重新Link。');
    console.log('============================================================');
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const selected = inferM19SearchGainFromLog();
    if (!selected) throw new Error('D4_RESUME_AFTER_GAIN_M19_HAND_GAIN_NOT_FOUND');
    const finalVerified = verifyFinalSearch(selected);
    writeJson(path.join(attemptDir, 'resume_after_bamboo_gain_result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      carrier,
      bambooSelection: { selected, source: 'RIGHT_LOG_ACTUAL_HAND_GAIN' },
      finalVerified
    });
    console.log('\n============================================================');
    console.log('D4候选PASS：当前已完成的妖刀检索已由最终observer正式验收。');
    console.log(`妖刀检索: ${selected.name}[${selected.id}]`);
    console.log(`手牌数: ${finalVerified.beforeCount} -> ${finalVerified.afterCount}`);
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
    return;
  }

  const rl = readline.createInterface({ input, output });
  const bridge = new MdFastBridge();
  let bridgeStarted = false;

  try {
    await bridge.start();
    bridgeStarted = true;
    let info = await activateGameAndGetInfo(bridge);
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);

    console.log('\n============================================================');
    console.log(resumeSelected
      ? 'D4局内恢复：当前 Link 候选已经被点击并处于选中状态。'
      : 'D4局内恢复：当前已经停在额外卡组 Link 候选窗口。');
    console.log('不会重新发动真刀、不会重新选妖刀、不会重新打开额外卡组。');
    console.log(resumeSelected
      ? '本模式只精确认当前已选中的 Link 卡名，然后只点击底部“选择”；绝不重新点击候选卡。'
      : '本版先从当前窗口重新测量真实 Link 卡框中心，再点击候选；不再强制 y=925。');
    console.log('D4 Link策略：闪刀姬－篝[E02]固定排除；已用过则不会出现，未用过但出现在候选中也会跳过。');
    console.log(
      `当前妖刀carrier=${carrier.carrierZone} ` +
      `@(${Math.round(carrier.carrierReference.x)},${Math.round(carrier.carrierReference.y)}); ` +
      `identity=${carrier.carrierIdentity.name || 'UNKNOWN'}[${carrier.carrierIdentity.id || 'UNKNOWN'}]`
    );
    console.log('============================================================');

    let control;
    let nextLink;
    let summonPrompt = null;
    if (resumeSelected) {
      await saveNode(bridge, info, attemptDir, '10_link_candidate_already_selected', { carrier });
      control = await checkpoint(rl, {
        prompt: '当前候选已经选中。Enter=只精确认当前Link并点击底部“选择”；R=重拍；Q=退出：',
        bridge,
        attemptDir,
        label: '10_link_candidate_selected_hold'
      });
      if (control === 'QUIT') return;

      info = await activateGameAndGetInfo(bridge);
      const raw = await recognizeCurrentCard(
        bridge,
        info,
        library,
        templates,
        { stableAcceptedSamples: 2 }
      );
      const selected = normalizeRecognized(raw);
      if (!selected.accepted || !isKnownLinkMonsterId(selected.id)) {
        throw new Error(`D4_SELECTED_LINK_NOT_PROVEN:${selected.name}[${selected.id}]`);
      }
      if (D4_EXCLUDED_LINK_IDS.includes(selected.id)) {
        throw new Error(`D4_SELECTED_LINK_EXCLUDED_BY_ROUTE:${selected.name}[${selected.id}];D4禁止篝，避免混入额外回收效果。`);
      }
      await sleep(600);
      nextLink = {
        selected,
        selectedPoint: null,
        selectedIndex: null,
        seen: [{ index: null, point: null, recognized: selected }],
        preferred: [],
        source: 'ALREADY_SELECTED_NO_RECLICK'
      };
      writeJson(path.join(attemptDir, '11_select_link_resume', 'selected_link_candidate.json'), nextLink);
      console.log(
        `当前已选Link精确认: ${selected.name}[${selected.id}] PASS；` +
        '不重新点击候选，只提交底部“选择”。'
      );
    } else {
      summonPrompt = await waitForSummonCandidates({
        bridge,
        info,
        debugDir: path.join(attemptDir, '10_link_candidates_resume')
      });
      await saveNode(bridge, info, attemptDir, '10_link_candidates_resume_ready', { summonPrompt, carrier });

      control = await checkpoint(rl, {
        prompt: '当前Link候选窗口确认无误后按Enter=按真实蓝色卡框中心选择；R=重拍；Q=退出：',
        bridge,
        attemptDir,
        label: '10_link_candidates_resume_hold'
      });
      if (control === 'QUIT') return;

      info = await activateGameAndGetInfo(bridge);
      nextLink = await selectNextLegalLink({
        bridge,
        info,
        library,
        templates,
        carrierId: carrier.carrierIdentity.id,
        promptProof: summonPrompt,
        debugDir: path.join(attemptDir, '11_select_link_resume'),
        excludedLinkIds: D4_EXCLUDED_LINK_IDS
      });
    }
    await clickBottomSummonSubmit({
      bridge,
      info,
      debugDir: path.join(attemptDir, '11_link_submit_resume')
    });
    await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: carrier.carrierReference,
      carrierMode: carrier.carrierMode,
      debugDir: path.join(attemptDir, '12_carrier_material_resume')
    });
    await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: carrier.carrierReference,
      carrierMode: carrier.carrierMode,
      debugDir: path.join(attemptDir, '12_carrier_material_resume')
    });
    await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: carrier.carrierReference,
      debugDir: path.join(attemptDir, '13_material_confirm_resume')
    });
    console.log('Link素材确认已点击；动画阶段零输入等待1700ms。');
    await sleep(1700);

    const optionalPool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(attemptDir, '14_post_link_optional_resume')
    });
    await saveNode(bridge, info, attemptDir, '14_post_link_optional_pool_resume', { nextLink, optionalPool });
    console.log(`D4 Link段 PASS：Link结果=${nextLink.selected.name}[${nextLink.selected.id}]；效果池=${optionalPool.candidateCount}。`);

    control = await checkpoint(rl, {
      prompt: 'Enter=继续妖刀检索；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '14_optional_pool_resume_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const m19Optional = await selectM19FromOptionalPool({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '15_select_m19_optional_resume')
    });
    const bambooWindow = await waitForBambooPromptAfterM19({
      bridge,
      info,
      originalCandidateCount: m19Optional.pool.candidateCount,
      debugDir: path.join(attemptDir, '16_wait_bamboo_prompt_resume')
    });
    await saveNode(bridge, info, attemptDir, '16_bamboo_search_prompt_resume', { m19Optional, bambooWindow });

    control = await checkpoint(rl, {
      prompt: 'Enter=选择竹光检索目标并提交；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '16_bamboo_search_resume_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const bambooSelection = await selectBambooSearchTarget({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '17_select_bamboo_resume')
    });
    await saveNode(bridge, info, attemptDir, '17_bamboo_submitted_resume', { bambooSelection });

    control = await checkpoint(rl, {
      prompt: '检索入手并回到稳定场面后按Enter=最终observer；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '17_final_resume_settle'
    });
    if (control === 'QUIT') return;

    await bridge.stop();
    bridgeStarted = false;
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const finalVerified = verifyFinalSearch(bambooSelection.selected);

    writeJson(path.join(attemptDir, 'resume_link_candidates_result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      carrier,
      summonPrompt,
      nextLink,
      optionalPool,
      bambooSelection,
      finalVerified
    });

    console.log('\n============================================================');
    console.log('D4候选PASS：从当前单张Link候选窗口恢复后，carrier Link + 妖刀检索完整完成。');
    console.log(`Link结果: ${nextLink.selected.name}[${nextLink.selected.id}]`);
    console.log(`妖刀检索: ${bambooSelection.selected.name}[${bambooSelection.selected.id}]`);
    console.log(`手牌数: ${finalVerified.beforeCount} -> ${finalVerified.afterCount}`);
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    rl.close();
    if (bridgeStarted) {
      try { await bridge.stop(); } catch (_) {}
    }
  }
}

main().catch(error => {
  console.error(`\nD4 Link候选恢复测试停止: ${error.stack || error.message}`);
  console.error('不要手动补救当前窗口；把终端输出和最新D4节点发回来。');
  process.exitCode = 1;
});
