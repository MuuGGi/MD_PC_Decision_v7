'use strict';

const fs = require('fs');
const path = require('path');
const {readJsonIfExistsSafe: readJsonIfExists, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const M20 = { id: 'M20', name: '真刀竹光' };
const D4_EXCLUDED_LINK_IDS = ['E02']; // 闪刀姬－篝会引入额外回收效果，D4隔离路线禁止选择。
const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { clickObservedEquipConfirm } = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));
const { clickPreferredEquipCarrier } = require(path.join(ROOT, 'execution', 'core', 'preferred-equip-carrier'));
const {
  locateFieldM20,
  clickFieldM20Effect,
  waitForM19DeckPrompt,
  selectM19FromDeckPrompt
} = require(path.join(ROOT, 'execution', 'core', 'm20-true-bamboo-conversion'));
const {
  clickExtraDeckSummonButton,
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
const COMPOSITE_RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

function assertSupportedNode() {
  const actual = String(process.versions.node || '');
  if (actual !== '20.11.1') {
    throw new Error(`NODE_VERSION_MISMATCH:${actual || 'UNKNOWN'};本测试固定要求 Node v20.11.1。`);
  }
  console.log('Node运行时: v20.11.1 PASS');
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function timestampId() { return new Date().toISOString().replace(/[:.]/g, '-'); }
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

function verifyM20FromHand(beforeCount) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  const composite = readJsonIfExists(COMPOSITE_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') throw new Error(`D4_M20_EQUIP_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  if (!composite.summary || composite.summary.equip !== 'M20_FROM_HAND') {
    throw new Error(`D4_M20_EQUIP_COMPOSITE_NOT_CONFIRMED:${composite.summary && composite.summary.equip || 'NONE'}`);
  }
  const afterCount = incremental.after && incremental.after.handCount;
  if (afterCount !== beforeCount - 1) {
    throw new Error(`D4_M20_EQUIP_HAND_COUNT_INVALID:${beforeCount}->${afterCount};expected=${beforeCount - 1}`);
  }
  const consumed = incremental.inference && incremental.inference.consumed;
  if (!consumed || consumed.id !== 'M20') {
    throw new Error(`D4_M20_EQUIP_CONSUMED_INVALID:${consumed && consumed.id || 'NONE'}`);
  }
  const m20Blocks = flattenLogBlocks(log).filter(block => block && block.activationKey === 'M20');
  if (!m20Blocks.length) throw new Error('D4_M20_EQUIP_LOG_BLOCK_NOT_FOUND');
  return { beforeCount, afterCount, consumed, m20Blocks: m20Blocks.length };
}

function verifyM20FieldToM19(expectedHandCount) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  const composite = readJsonIfExists(COMPOSITE_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') throw new Error(`D4_M20_FIELD_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  if (!composite.summary || composite.summary.equip !== 'M20_FIELD_TO_M19') {
    throw new Error(`D4_M20_FIELD_TO_M19_NOT_CONFIRMED:${composite.summary && composite.summary.equip || 'NONE'}`);
  }
  const afterCount = incremental.after && incremental.after.handCount;
  if (Number.isInteger(afterCount) && afterCount !== expectedHandCount) {
    throw new Error(`D4_M20_FIELD_HAND_COUNT_CHANGED:${expectedHandCount}->${afterCount}`);
  }
  const m20Blocks = flattenLogBlocks(log).filter(block => block && block.activationKey === 'M20');
  if (!m20Blocks.length) throw new Error('D4_M20_FIELD_EFFECT_LOG_BLOCK_NOT_FOUND');
  return { handCount: Number.isInteger(afterCount) ? afterCount : expectedHandCount, m20Blocks: m20Blocks.length };
}

function cardCountInState(state, cardId) {
  const cards = state && (state.cards || state.hand || state.handCards || state.orderedCards);
  if (!Array.isArray(cards)) return null;
  return cards.filter(item => {
    const card = item && item.card ? item.card : item;
    return card && card.id === cardId;
  }).length;
}

function verifyFinalSearch(selected) {
  const log = readJsonIfExists(LOG_RESULT_PATH) || {};
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  if (incremental.status !== 'PASS') throw new Error(`D4_FINAL_INCREMENTAL_NOT_PASS:${incremental.status || 'NONE'}`);
  const beforeCount = incremental.before && incremental.before.handCount;
  const afterCount = incremental.after && incremental.after.handCount;
  if (!Number.isInteger(beforeCount) || !Number.isInteger(afterCount) || afterCount !== beforeCount + 1) {
    throw new Error(`D4_FINAL_HAND_DELTA_INVALID:${beforeCount}->${afterCount};expected=+1`);
  }
  const inserted = Array.isArray(incremental.insertedCards) ? incremental.insertedCards : [];
  const insertedIds = inserted.map(x => x && x.card && x.card.id).filter(Boolean);
  const beforeCopies = cardCountInState(incremental.before, selected.id);
  const afterCopies = cardCountInState(incremental.after, selected.id);
  if (!insertedIds.includes(selected.id) && !(Number.isInteger(beforeCopies) && Number.isInteger(afterCopies) && afterCopies === beforeCopies + 1)) {
    throw new Error(`D4_FINAL_SEARCH_CARD_NOT_RECONCILED:${selected.id};inserted=${insertedIds.join('>') || 'NONE'}`);
  }
  const m19Blocks = flattenLogBlocks(log).filter(block => block && block.activationKey === 'M19');
  if (!m19Blocks.length) throw new Error('D4_FINAL_M19_LOG_BLOCK_NOT_FOUND');
  return { beforeCount, afterCount, insertedIds, m19Blocks: m19Blocks.length };
}


function findLatestD4AttemptDir() {
  const root = path.join(ROOT, 'debug', 'execution', 'D4_m20_true_bamboo_route');
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const name of names) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'nodes', '02_m20_target_selected.json'))) return dir;
  }
  return null;
}

function loadFieldEffectResumeState(attemptDir) {
  const targetNode = readJsonIfExists(path.join(attemptDir, 'nodes', '02_m20_target_selected.json')) || {};
  const m20Target = targetNode.extra && targetNode.extra.m20Target;
  if (!m20Target || !m20Target.clickReference) {
    throw new Error('D4_RESUME_FIELD_EFFECT_TARGET_EVIDENCE_MISSING');
  }
  const incremental = readJsonIfExists(INCREMENTAL_RESULT_PATH) || {};
  const afterCount = incremental.after && incremental.after.handCount;
  if (!Number.isInteger(afterCount)) {
    throw new Error('D4_RESUME_FIELD_EFFECT_HAND_COUNT_MISSING');
  }
  const m20EquipVerified = verifyM20FromHand(afterCount + 1);
  return {
    m20Target,
    m20EquipVerified,
    baseline: { handCount: m20EquipVerified.beforeCount }
  };
}

async function main() {
  assertSupportedNode();
  const resumeFieldEffect = process.argv.slice(2).includes('--resume-field-effect');
  let attemptDir = resumeFieldEffect
    ? findLatestD4AttemptDir()
    : path.join(ROOT, 'debug', 'execution', 'D4_m20_true_bamboo_route', timestampId());
  if (!attemptDir) throw new Error('D4_RESUME_FIELD_EFFECT_NO_PREVIOUS_ATTEMPT');
  ensureDir(attemptDir);
  const rl = readline.createInterface({ input, output });
  let bridge = new MdFastBridge();
  let bridgeStarted = false;
  let baseline = null;
  let library = null;
  let templates = null;
  let m20Target = null;
  let m20EquipVerified = null;
  let info = null;
  let control = null;

  try {
    console.log('\n============================================================');
    console.log('D4 刀支线操作层测试：真刀竹光 → 转妖刀 → carrier Link → 妖刀检索');
    console.log('测试前场面：正常场面；手牌有真刀竹光[M20]；场上有可装备且可用于后续Link的怪兽。');
    console.log('装备对象统一规则：额外怪兽区Link优先；若没有，再检查中央主怪兽区；不固定具体卡名。');
    console.log('前半段测试M20→M19；后半段直接复用已经PASS的D2/D3核心。');
    console.log('交互键：Enter=下一自动节点；R=只重拍；Q=原地退出。');
    console.log('Node固定 v20.11.1。');
    console.log('============================================================');

    await bridge.start();
    bridgeStarted = true;

    if (!resumeFieldEffect) {
      control = await checkpoint(rl, {
      prompt: '准备好后按Enter建立当前observer基线；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '00_before_baseline'
    });
    if (control === 'QUIT') return;

      info = await activateGameAndGetInfo(bridge);
      baseline = await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(attemptDir, '00_observer_baseline')
    });
    const m20Count = (baseline.cards || []).filter(card => card && card.id === 'M20').length;
    if (!m20Count) throw new Error('D4_M20_NOT_IN_CURRENT_HAND:真刀竹光[M20]');
    console.log(
      `D4节点0 PASS：手牌=${baseline.handCount}；真刀=${m20Count}张。` +
      '装备对象不在基线阶段写死，等真实装备选择窗口出现后按“额外Link→中央主怪兽区”现场决定。'
    );

    control = await checkpoint(rl, {
      prompt: 'Enter=从真实手牌位置发动真刀竹光；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '00_baseline_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
      library = loadLibrary(ROOT);
      templates = await loadTemplates(ROOT, library);
    const selectedM20 = await selectObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline,
      expectedId: 'M20',
      debugDir: path.join(attemptDir, '01_m20_activation')
    });
    console.log(`发动前卡名确认: ${selectedM20.selected.name}[${selectedM20.selected.id}] PASS @手牌${selectedM20.slot}`);
    const m20Activation = await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: 'M20',
      expectedName: M20.name,
      clickReference: selectedM20.clickReference,
      debugDir: path.join(attemptDir, '01_m20_activation')
    });
    await sleep(500);
    await saveNode(bridge, info, attemptDir, '01_after_m20_activation_500ms', { selectedM20, m20Activation });
    console.log('D4节点1 PASS：真刀已发动，尚未点击装备对象。');

    control = await checkpoint(rl, {
      prompt: '进入装备对象选择后按Enter=按“额外Link优先，否则中央主怪兽区”选择；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '01_m20_target_prompt_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
      m20Target = await clickPreferredEquipCarrier({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '02_m20_equip_target'),
      afterIdentityMs: 600,
      label: '真刀'
    });
    console.log(
      `真刀装备对象选择 PASS: ${m20Target.zoneName}; ` +
      `carrier=(${Math.round(m20Target.clickReference.x)},${Math.round(m20Target.clickReference.y)})`
    );
    await saveNode(bridge, info, attemptDir, '02_m20_target_selected', { m20Target });

    control = await checkpoint(rl, {
      prompt: '蓝色确认出现后按Enter=只点确认；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '02_m20_target_selected_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const m20Confirm = await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: m20Target.clickReference,
      debugDir: path.join(attemptDir, '03_m20_equip_confirm'),
      label: 'm20_equip_confirm'
    });
    console.log('真刀装备确认已点击；动画阶段零输入等待900ms。');
    await sleep(900);
    await saveNode(bridge, info, attemptDir, '03_after_m20_equip_confirm', { m20Confirm });

    control = await checkpoint(rl, {
      prompt: '真刀装备完成并回到稳定场面后按Enter=observer验收第一阶段；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '03_m20_equip_settled'
    });
    if (control === 'QUIT') return;

    await bridge.stop();
    bridgeStarted = false;
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
      m20EquipVerified = verifyM20FromHand(baseline.handCount);
    console.log(`M20阶段1 observer PASS: 真刀竹光已装备；手牌 ${m20EquipVerified.beforeCount}->${m20EquipVerified.afterCount}`);

      // runtime/observer/run-live-incremental.js owns its own bridge. A stopped MdFastBridge instance is single-use,
      // so always create a fresh object before continuing the next execution stage.
      bridge = new MdFastBridge();
      await bridge.start();
      bridgeStarted = true;
      info = await activateGameAndGetInfo(bridge);
    } else {
      const resumed = loadFieldEffectResumeState(attemptDir);
      baseline = resumed.baseline;
      m20Target = resumed.m20Target;
      m20EquipVerified = resumed.m20EquipVerified;
      library = loadLibrary(ROOT);
      templates = await loadTemplates(ROOT, library);
      info = await activateGameAndGetInfo(bridge);
      console.log('\n============================================================');
      console.log('D4局内恢复：真刀手牌装备阶段已经 PASS，当前从“场上真刀发动效果”继续。');
      console.log('不会重新点击手牌真刀，也不会重新选择第一阶段装备对象。');
      console.log(`沿用第一阶段 carrier=${m20Target.zoneName || 'UNKNOWN'} @(${Math.round(m20Target.clickReference.x)},${Math.round(m20Target.clickReference.y)})；手牌=${m20EquipVerified.afterCount}。`);
      console.log('============================================================');
    }

    console.log('\n============================================================');
    console.log('真刀竹光阶段2：场上真刀 → 发动效果 → 选择妖刀 → 选择 → 再按“额外Link→中央主怪兽区”选装备对象 → 蓝色确认 → observer。');
    console.log('============================================================');
    const fieldM20 = await locateFieldM20({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '04_locate_field_m20')
    });
    await saveNode(bridge, info, attemptDir, '04_field_m20_proven', { fieldM20 });

    control = await checkpoint(rl, {
      prompt: 'Enter=点击真刀场上“发动效果”；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '04_field_m20_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const fieldEffect = await clickFieldM20Effect({
      bridge,
      info,
      fieldReference: fieldM20.reference,
      debugDir: path.join(attemptDir, '05_m20_field_effect')
    });
    console.log('已点击真刀竹光“发动效果”：纯等待1200ms进入妖刀牌组选卡窗口。');
    await sleep(1200);
    const m19DeckPrompt = await waitForM19DeckPrompt({
      bridge,
      info,
      debugDir: path.join(attemptDir, '06_m19_deck_prompt')
    });
    await saveNode(bridge, info, attemptDir, '06_m19_deck_prompt_ready', { fieldEffect, m19DeckPrompt });
    console.log('D4节点2 PASS：真刀场上效果已发动，妖刀牌组选卡窗口已出现。');

    control = await checkpoint(rl, {
      prompt: 'Enter=精确认妖刀竹光并点击底部“选择”；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '06_m19_deck_prompt_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const m19DeckSelection = await selectM19FromDeckPrompt({
      bridge,
      info,
      library,
      templates,
      promptProof: m19DeckPrompt,
      debugDir: path.join(attemptDir, '07_select_m19_from_deck')
    });
    console.log('妖刀已从牌组选择并提交；纯等待900ms进入装备对象阶段。');
    await sleep(900);
    await saveNode(bridge, info, attemptDir, '07_m19_from_deck_submitted', { m19DeckSelection });

    control = await checkpoint(rl, {
      prompt: '进入妖刀装备对象阶段后按Enter=再次按“额外Link优先，否则中央主怪兽区”选择；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '07_m19_equip_target_prompt_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const m19Target = await clickPreferredEquipCarrier({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '08_m19_equip_target'),
      afterIdentityMs: 600,
      label: '妖刀'
    });
    const m19Confirm = await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: m19Target.clickReference,
      debugDir: path.join(attemptDir, '08_m19_equip_confirm'),
      label: 'm19_after_m20_confirm'
    });
    console.log('妖刀装备确认已点击；动画阶段零输入等待1800ms。');
    await sleep(1800);
    await saveNode(bridge, info, attemptDir, '08_m20_to_m19_equip_done', { m19Target, m19Confirm });

    control = await checkpoint(rl, {
      prompt: '真刀→妖刀转换稳定后按Enter=observer验收转换；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '08_m20_to_m19_settled'
    });
    if (control === 'QUIT') return;

    await bridge.stop();
    bridgeStarted = false;
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const conversionVerified = verifyM20FieldToM19(m20EquipVerified.afterCount);
    console.log(`M20→M19 observer PASS: 真刀送墓并把妖刀装备到场；手牌保持=${conversionVerified.handCount}`);

    // Reuse the already live-PASSed D2 core directly from the current carrier.
    bridge = new MdFastBridge();
    await bridge.start();
    bridgeStarted = true;
    info = await activateGameAndGetInfo(bridge);
    const carrierReference = m19Target.clickReference;
    const carrierMode = m19Target.kind === 'EXTRA_LINK' ? 'LINK' : 'GENERIC';
    await saveNode(bridge, info, attemptDir, '09_carrier_before_link', {
      carrierReference,
      carrierMode,
      carrierZone: m19Target.zoneName,
      carrierIdentity: m19Target.recognized
    });
    console.log(
      `\nD4前半段 PASS。当前妖刀carrier=${m19Target.zoneName} ` +
      `@(${Math.round(carrierReference.x)},${Math.round(carrierReference.y)})；下面复用D2核心完成Link。`
    );
    console.log('D4 Link策略：闪刀姬－篝[E02]固定排除；若已经用过则不会出现在候选中，若仍可召唤也会主动跳过，避免混入篝回收效果。');

    control = await checkpoint(rl, {
      prompt: 'Enter=开始carrier Link；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '09_carrier_link_ready'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const extraButton = await clickExtraDeckSummonButton({ bridge, info, debugDir: path.join(attemptDir, '10_extra_deck') });
    const summonPrompt = await waitForSummonCandidates({ bridge, info, debugDir: path.join(attemptDir, '10_link_candidates') });
    const nextLink = await selectNextLegalLink({
      bridge,
      info,
      library,
      templates,
      carrierId: m19Target.recognized.id,
      promptProof: summonPrompt,
      debugDir: path.join(attemptDir, '11_select_link'),
      excludedLinkIds: D4_EXCLUDED_LINK_IDS
    });
    await clickBottomSummonSubmit({ bridge, info, debugDir: path.join(attemptDir, '11_link_submit') });
    await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: carrierReference,
      carrierMode,
      debugDir: path.join(attemptDir, '12_carrier_material')
    });
    await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: carrierReference,
      carrierMode,
      debugDir: path.join(attemptDir, '12_carrier_material')
    });
    await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: carrierReference,
      debugDir: path.join(attemptDir, '13_material_confirm')
    });
    console.log('Link素材确认已点击；动画阶段零输入等待1700ms。');
    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(attemptDir, '14_post_link_optional')
    });
    await saveNode(bridge, info, attemptDir, '14_post_link_optional_pool', { extraButton, nextLink, optionalPool });
    console.log(`D2复用段 PASS：Link结果=${nextLink.selected.name}[${nextLink.selected.id}]；效果池=${optionalPool.candidateCount}。`);

    control = await checkpoint(rl, {
      prompt: 'Enter=继续复用D3核心处理妖刀检索；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '14_optional_pool_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const m19Optional = await selectM19FromOptionalPool({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '15_select_m19_optional')
    });
    const bambooWindow = await waitForBambooPromptAfterM19({
      bridge,
      info,
      originalCandidateCount: m19Optional.pool.candidateCount,
      debugDir: path.join(attemptDir, '16_wait_bamboo_prompt')
    });
    await saveNode(bridge, info, attemptDir, '16_bamboo_search_prompt', { m19Optional, bambooWindow });

    control = await checkpoint(rl, {
      prompt: 'Enter=选择竹光检索目标并提交；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '16_bamboo_search_hold'
    });
    if (control === 'QUIT') return;

    info = await activateGameAndGetInfo(bridge);
    const bambooSelection = await selectBambooSearchTarget({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(attemptDir, '17_select_bamboo')
    });
    await saveNode(bridge, info, attemptDir, '17_bamboo_submitted', { bambooSelection });

    control = await checkpoint(rl, {
      prompt: '检索入手并回到稳定场面后按Enter=最终observer；R=重拍；Q=退出：',
      bridge,
      attemptDir,
      label: '17_final_settle'
    });
    if (control === 'QUIT') return;

    await bridge.stop();
    bridgeStarted = false;
    runNodeFromRoot('runtime/observer/run-live-incremental.js', ['--adjacent-checkpoint-only']);
    const finalVerified = verifyFinalSearch(bambooSelection.selected);

    writeJson(path.join(attemptDir, 'result.json'), {
      status: 'PASS_CANDIDATE',
      completedAt: new Date().toISOString(),
      route: 'D4_M20_TO_M19_REUSE_D2_D3',
      baselineHandCount: baseline.handCount,
      m20EquipVerified,
      fieldM20,
      conversionVerified,
      carrier: { zoneName: m19Target.zoneName, kind: m19Target.kind, reference: m19Target.clickReference, recognized: m19Target.recognized },
      linkResult: nextLink.selected,
      bambooSelection,
      finalVerified,
      sealed: false
    });

    console.log('\n============================================================');
    console.log('D4候选PASS：真刀竹光路线完整跑通。');
    console.log('真刀手牌发动 → 优先额外Link/否则中央主怪兽区装备 → 转妖刀 → carrier Link → 妖刀检索 PASS');
    console.log(`Link结果: ${nextLink.selected.name}[${nextLink.selected.id}]`);
    console.log(`妖刀检索结果: ${bambooSelection.selected.name}[${bambooSelection.selected.id}]`);
    console.log(`最终检索手牌变化: ${finalVerified.beforeCount} -> ${finalVerified.afterCount}`);
    console.log(`测试记录: ${attemptDir}`);
    console.log('============================================================');
  } finally {
    if (bridgeStarted) await bridge.stop().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`\nD4 真刀竹光路线测试停止: ${error && error.stack ? error.stack : error}`);
  console.error('不要手动补救当前窗口；把终端输出和debug/execution/D4_m20_true_bamboo_route最新节点发回来。');
  process.exitCode = 1;
});
