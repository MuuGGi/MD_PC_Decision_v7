'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, readJsonIfExistsSafe: readJsonIfExists, writeJsonAtomic, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const { buildIncrementalObserverArgs } = require('../../lib/incremental-observer-policy');
const { commitRecognizedInsertions } = require('../../lib/incremental-hand-locator');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const {
  MdFastBridge,
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const {
  yellowUsableStats,
  detectHandCountFromImage,
  getHandLayout,
  resolveExposedFanSlots
} = require(path.join(ROOT, 'lib', 'hand-state'));
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(ROOT, 'execution', 'core', 'prompt-candidate-centers'));
const { waitBeforePromptSubmit } = require(path.join(ROOT, 'execution', 'core', 'prompt-submit-timing'));
const { selectObservedHandCard } = require(path.join(ROOT, 'execution', 'core', 'hand-target'));
const { clickSelectedHandSpellActivation } = require(path.join(ROOT, 'execution', 'core', 'hand-spell-activation'));
const { locateFieldActivateIcon } = require('./hand-action-icon');
const { captureNeutralNormalSummonFrame, buildNormalSummonActionRoi,
  clickSelectedMonsterNormalSummon } = require(path.join(ROOT, 'execution', 'core', 'hand-normal-summon'));
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
  choosePreferredEquipCarrier,
  clickPreferredEquipCarrier
} = require(path.join(ROOT, 'execution', 'core', 'preferred-equip-carrier'));
const {
  clickObservedEquipConfirm
} = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));
const {
  waitOptionalPool,
  selectM19FromOptionalPool,
  waitForBambooPromptAfterM19,
  selectBambooSearchTarget
} = require(path.join(ROOT, 'execution', 'core', 'm19-search-execution'));
const {
  locateFieldM20,
  clickFieldM20Effect,
  waitForM19DeckPrompt,
  selectM19FromDeckPrompt
} = require(path.join(ROOT, 'execution', 'core', 'm20-true-bamboo-conversion'));
const {
  OPTIONAL_EFFECT_PROMPT
} = require(path.join(ROOT, 'execution', 'core', 'optional-effect-prompt-observer'));
const {
  clickRayeSummonSubmit
} = require(path.join(ROOT, 'execution', 'core', 'm06-field-effect'));
const {
  SKY_STRIKER_TARGET_PROMPT,
  probeSkyStrikerSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'sky-striker-search-target-prompt-observer'));
const { buildE10EngageSourcePolicy, selectE10EngageCandidate } = require(path.join(ROOT, 'lib', 'e10-engage-source-policy'));
const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
const {
  commitKnownDeckExit,
  commitKnownAtomicHandGains,
  commitKnownNonDeckHandGain
} = require(path.join(ROOT, 'lib', 'main-deck-ledger'));

const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const INCREMENTAL_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const DUEL_LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const DECISION_STATE_PATH = path.join(ROOT, 'decision-state.json');
const ROUTE_ROOT = path.join(ROOT, 'debug', 'execution', 'V5_hornet_link_current');
const TRUE_ROUTE_STATE_PATH = path.join(ROUTE_ROOT, 'true_route_state.json');
const ALL_LINK_IDS = ['E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10'];
const TOKEN_ANCHOR = { x: 1024, y: 705 };
const RAYE_MAIN_ANCHOR = { x: 1024, y: 705 };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}



function saveTrueRouteStage(stage, extra = {}) {
  writeJsonAtomic(TRUE_ROUTE_STATE_PATH, {
    stage,
    updatedAt: new Date().toISOString(),
    ...extra
  }, { trailingNewline: true });
}

function clearTrueRouteStage() {
  fs.rmSync(TRUE_ROUTE_STATE_PATH, { force: true });
}

function loadTrueRouteStage() {
  return readJsonIfExists(TRUE_ROUTE_STATE_PATH);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function countId(state, id) {
  return (Array.isArray(state && state.cards) ? state.cards : [])
    .filter(card => card && String(card.id || '') === id).length;
}



async function selectCurrentObservedHandCard({
  bridge,
  info,
  library,
  templates,
  baseline,
  expectedId,
  debugDir,
  onBeforeSelect
}) {
  const { resolveMeasuredHandTarget } = require(path.join(ROOT, 'lib', 'live-hand-geometry'));
  const handCount = Number(baseline && baseline.handCount);
  const cards = Array.isArray(baseline && baseline.cards) ? baseline.cards : [];
  const targetIndex = cards.findIndex(card => card && String(card.id || '') === String(expectedId || ''));
  if (targetIndex < 0) {
    throw new Error(`V5_LINK_CURRENT_CARD_NOT_IN_HAND:${expectedId}`);
  }
  const requestedSlot = targetIndex + 1;

  // High-hand old cards can still use the mature DENSE witness path.  If a
  // newly gained card has no historical witness, target only its current slot.
  if (handCount > 7) {
    const selectedCard = cards[targetIndex];
    if (selectedCard && selectedCard.denseWitness) {
      return selectObservedHandCard({
        bridge,
        info,
        library,
        templates,
        baseline,
        expectedId,
        debugDir,
        onBeforeSelect
      });
    }

    const { recognizeDenseTargetSlots } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
    const targeted = await recognizeDenseTargetSlots({
      bridge,
      info,
      library,
      templates,
      handCount,
      targetSlots: [requestedSlot],
      outputDir: path.join(debugDir, 'v5_current_dense_target'),
      stepPx: 420,
      keepFinalSelection: true,
      onBeforeSelect
    });
    const row = targeted && targeted.recognized && targeted.recognized[0];
    if (!targeted || targeted.success !== true || !targeted.selectionKept || !row ||
        !row.card || String(row.card.id || '') !== String(expectedId)) {
      throw new Error(
        `V5_LINK_DENSE_CURRENT_SLOT_NOT_PROVEN:slot=${requestedSlot};expected=${expectedId};` +
        `actual=${row && row.card ? `${row.card.name}[${row.card.id}]` : 'NONE'}`
      );
    }
    console.log(
      `V5 Link当前高手牌确认: 手牌${requestedSlot} ${row.card.name}[${row.card.id}] ` +
      `(${row.window}); 不依赖旧DENSE witness。`
    );
    return {
      slot: requestedSlot,
      selected: row.recognition,
      clickReference: row.clickReference,
      positioning: {
        mode: 'V5_LINK_CURRENT_DENSE_SLOT',
        window: row.window,
        currentCenter: row.clickReference
      }
    };
  }

  const detectRoi = config.handFan.detectRoi;
  const layout = getHandLayout(handCount);
  if (!layout || layout.status !== 'OK' || !Array.isArray(layout.slots) || layout.slots.length !== handCount) {
    throw new Error(`V5_LINK_CURRENT_TITLE_LAYOUT_INVALID:${handCount}`);
  }

  const safeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
  const safe = mapReferencePoint(info, safeRef);
  const maxAttempts = Math.max(2, Number(config.handFan.slotResetMaxAttempts || 3));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await bridge.click(safe.x, safe.y);
    await sleep(Math.max(80, Number(config.handFan.slotResetClickSettleMs || 80)));
    await bridge.key('ESC').catch(() => {});
    await sleep(Math.max(100, Number(config.handFan.slotResetSettleMs || 120)) * attempt);

    const image = await captureReferenceRoi(bridge, info, detectRoi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(
        image,
        path.join(debugDir, `v5_link_current_title_${String(attempt).padStart(2, '0')}.png`)
      );
    }

    const geometry = resolveMeasuredHandTarget(image, handCount, requestedSlot, {
      baselineCards: cards, detector: { detectHandCountFromImage, getHandLayout, resolveExposedFanSlots }
    });
    const target = geometry.target;
    const targetX = Number(target && target.x);
    const targetY = Number(target && target.titleY);
    last = geometry;
    if (!geometry.clickable) {
      continue;
    }

    const fresh = await bridge.info();
    const physical = mapReferencePoint(fresh, { x: targetX, y: targetY });
    if (onBeforeSelect) {
      await onBeforeSelect({ bridge, info: fresh, slot: requestedSlot,
        clickReference: { x: targetX, y: targetY } });
    }
    await bridge.click(physical.x, physical.y);
    await sleep(config.toonChain.selectSettleMs || 260);

    const raw = await recognizeCurrentCard(
      bridge,
      fresh,
      library,
      templates,
      { stableAcceptedSamples: 2 }
    );
    const selected = normalizeRecognized(raw);
    if (debugDir && raw && raw.query) saveRgbaPng(raw.query, path.join(debugDir, 'selected_card_query.png'));
    if (!selected.accepted || String(selected.id || '') !== String(expectedId)) {
      await bridge.key('ESC').catch(() => {});
      throw new Error(
        `V5_LINK_HAND_SELECTION_MISMATCH:slot=${requestedSlot};expected=${expectedId};` +
        `actual=${selected.name}[${selected.id}]`
      );
    }

    console.log(
      `V5 Link当前槽位确认: 手牌${requestedSlot} ${selected.name}[${selected.id}] ` +
      `@(${Math.round(targetX)},${Math.round(targetY)}); ` +
      '使用当前真实TITLE组件，不再要求历史x/y。'
    );

    return {
      slot: requestedSlot,
      selected,
      clickReference: { x: targetX, y: targetY },
      positioning: {
        mode: 'V5_LINK_CURRENT_MEASURED_TITLE_COMPONENT',
        source: geometry.source,
        centers: last.resolvedCenters,
        currentCenter: { x: targetX, y: targetY }
      }
    };
  }

  throw new Error(
    `V5_LINK_CURRENT_TITLE_TARGET_NOT_MEASURED:slot=${requestedSlot};expected=${expectedId};` +
    `source=${last && last.source};titleCount=${last && last.titleCount};` +
    `measured=${last && last.measuredCenters ? last.measuredCenters.map(Math.round).join(',') : ''};` +
    `resolved=${last && last.resolvedCenters ? last.resolvedCenters.join(',') : ''}`
  );
}

function runObserver(options = {}) {
  const e10TargetSource = String(options.e10TargetSource || '').toUpperCase();
  const expectedAtomicActivationKey = String(
    options.expectedAtomicActivationKey || process.env.MD_V5_SELECTED_CARD_ID || ''
  ).trim().toUpperCase();
  // Every caller in this shared executor is the final verifier of a bounded
  // physical atom. Historical reconstruction belongs to the general duel
  // observer, never to an already-completed atomic transaction.
  const atomicObserverOptions = {
    ...options,
    adjacentCheckpointOnly: options.adjacentCheckpointOnly !== false
  };
  const observerArgs = buildIncrementalObserverArgs(
    path.join(ROOT, 'runtime/observer/run-live-incremental.js'),
    atomicObserverOptions
  );
  const out = spawnSync(process.execPath, observerArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ...(expectedAtomicActivationKey
        ? { MD_V5_EXPECTED_ATOMIC_ACTIVATION: expectedAtomicActivationKey }
        : {}),
      ...(e10TargetSource ? { V5_E10_TARGET_SOURCE: e10TargetSource } : {})
    }
  });
  if (out.error) throw out.error;
  if (out.status !== 0) {
    const error = new Error(`V5_ATOMIC_OBSERVER_FAILED:activation=${expectedAtomicActivationKey || 'UNKNOWN'};exit=${out.status == null ? 'UNKNOWN' : out.status}`);
    error.code = 'V5_ATOMIC_OBSERVER_FAILED';
    error.activationKey = expectedAtomicActivationKey || null;
    const stopPath = process.env.MD_AUTOTEST_STOP;
    if (stopPath && fs.existsSync(stopPath)) {
      const cause = new Error(`AUTOTEST_STOP:${fs.readFileSync(stopPath, 'utf8')}`);
      const guardPath = process.env.MD_AUTOTEST_GUARD;
      if (guardPath) cause.guardFailure = readJsonIfExists(guardPath + '.failure.json');
      error.cause = cause;
    }
    throw error;
  }
  return readJson(HAND_STATE_PATH);
}


function collectM20FieldConversionEvidence(log) {
  const matches = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (String(node.activationKey || '') === 'M20') {
      const details = Array.isArray(node.details) ? node.details : [];
      const paidTrueSword = details.some(detail =>
        detail && detail.card && String(detail.card.id || '') === 'M20' &&
        String(detail.rawType || detail.type || '') === 'COST_TO_GRAVEYARD'
      );
      const equippedYoto = details.some(detail =>
        detail && detail.card && String(detail.card.id || '') === 'M19' &&
        String(detail.rawType || detail.type || '') === 'MOVE_TO_FIELD'
      );
      matches.push({ block: node, paidTrueSword, equippedYoto });
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(log);
  return {
    matches,
    complete: matches.find(row => row.paidTrueSword && row.equippedYoto) || null,
    sawM20Gy: matches.some(row => row.paidTrueSword),
    sawM19Field: matches.some(row => row.equippedYoto)
  };
}

async function runM20FieldConversionLogCheck({ attempts = 4 } = {}) {
  let lastEvidence = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const out = spawnSync(
      process.execPath,
      [path.join(ROOT, 'runtime/observer/test-duel-log-live.js'), '--defer-bottom-to-hand-click'],
      { cwd: ROOT, stdio: 'inherit', windowsHide: true }
    );
    if (out.error) throw out.error;
    if (out.status !== 0) {
      throw new Error(`V5_M20_FIELD_LOG_CHECK_FAILED:exit=${out.status == null ? 'UNKNOWN' : out.status}`);
    }

    const log = readJson(DUEL_LOG_RESULT_PATH);
    const evidence = collectM20FieldConversionEvidence(log);
    lastEvidence = evidence;
    if (evidence.complete) {
      console.log(
        '真刀转妖刀右栏确认 PASS：M20送墓 + M19从牌组装备；' +
        '此节点手牌数量不变，不再读取INFO、不再重扫手牌。'
      );
      return { log, effect: evidence.complete.block, attempt };
    }

    console.log(
      `真刀转妖刀右栏证据尚未完整: attempt=${attempt}/${attempts}; ` +
      `M20_GY=${evidence.sawM20Gy ? 1 : 0}; M19_FIELD=${evidence.sawM19Field ? 1 : 0}。` +
      (attempt < attempts ? ' 保持零输入等待后继续读右栏，不提前停止。' : '')
    );
    if (attempt < attempts) await sleep(850);
  }

  throw new Error(
    `V5_M20_FIELD_EFFECT_EVIDENCE_MISSING_AFTER_RETRY:` +
    `M20_GY=${lastEvidence && lastEvidence.sawM20Gy ? 1 : 0};` +
    `M19_FIELD=${lastEvidence && lastEvidence.sawM19Field ? 1 : 0}`
  );
}

async function startBridge() {
  const bridge = new MdFastBridge();
  await bridge.start();
  const activation = await activateAndVerifyMasterDuel(bridge);
  return { bridge, info: activation.info };
}

async function selectSpecificLink({ bridge, info, library, templates, promptProof, targetId, carrierId, debugDir }) {
  const excluded = ALL_LINK_IDS.filter(id => id !== targetId);
  const result = await selectNextLegalLink({
    bridge,
    info,
    library,
    templates,
    carrierId: carrierId || 'UNKNOWN',
    promptProof,
    debugDir,
    excludedLinkIds: excluded
  });
  if (!result.selected || result.selected.id !== targetId) {
    throw new Error(`V5_LINK_TARGET_MISMATCH:${result.selected && result.selected.id || 'NONE'};expected=${targetId}`);
  }
  return result;
}

function chooseYellowComponent(stats, roi, expected, options = {}) {
  const expectedLocal = { x: expected.x - roi.x, y: expected.y - roi.y };
  return (stats.components || [])
    .filter(c =>
      c.estimatedPixels >= (options.minPixels || 80) &&
      c.width >= (options.minWidth || 12) &&
      c.height >= (options.minHeight || 8) && c.width <= 180 && c.height <= 50
    )
    .map(c => ({ ...c, drift: Math.hypot(c.centerX - expectedLocal.x, c.centerY - expectedLocal.y) }))
    .filter(c => c.drift <= (options.maxDrift || 40))
    .sort((a, b) => a.drift - b.drift || b.estimatedPixels - a.estimatedPixels)[0] || null;
}

async function clickYellowButton({ bridge, info, roi, expected, debugPath, label, timeoutMs = 4000 }) {
  const started = Date.now();
  let lastYellow = 0;
  let lastChosen = null;
  while (Date.now() - started < timeoutMs) {
    const image = await captureReferenceRoi(bridge, info, roi);
    if (debugPath) {
      ensureDir(path.dirname(debugPath));
      saveRgbaPng(image, debugPath);
    }
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    lastChosen = chooseYellowComponent(stats, roi, expected);
    if (lastChosen) {
      const reference = { x: roi.x + lastChosen.centerX, y: roi.y + lastChosen.centerY };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(`${label}: PASS; yellow=${lastYellow}; reference=(${Math.round(reference.x)},${Math.round(reference.y)})`);
      return { reference, yellowPixels: lastYellow };
    }
    await sleep(120);
  }
  throw new Error(`${label}_NOT_PROVEN:yellow=${lastYellow};component=${lastChosen ? 1 : 0}`);
}

async function capturePromptPoints({ bridge, info, roi, candidateY, debugPath }) {
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugPath) {
    ensureDir(path.dirname(debugPath));
    saveRgbaPng(image, debugPath);
  }
  let points = [];
  try {
    points = detectCandidateCenters(image, roi, candidateY, { mode: 'components' }) || [];
  } catch (_) {
    points = [];
  }
  return points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
}

async function recognizeSelectedAt({ bridge, info, library, templates, reference, label }) {
  const physical = mapReferencePoint(info, reference);
  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 260);
  const raw = await recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 });
  const recognized = normalizeRecognized(raw);
  console.log(`${label}: ${recognized.name}[${recognized.id}] ${recognized.accepted ? 'PASS' : 'UNKNOWN'}`);
  return recognized;
}

async function selectExactPromptCard({
  bridge,
  info,
  library,
  templates,
  roi,
  candidateY,
  targetId,
  label,
  debugDir,
  candidatePoints = null,
  allowMiss = false
}) {
  // Reuse the passive probe's already-proven physical centers when available.
  // A second component detection after a card becomes highlighted can collapse
  // a multi-card strip into one component; that was the cause of the live stop.
  const points = Array.isArray(candidatePoints) && candidatePoints.length
    ? candidatePoints
        .map(p => ({ x: Number(p.x), y: Number(p.y) }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x)
    : await capturePromptPoints({
        bridge,
        info,
        roi,
        candidateY,
        debugPath: debugDir && path.join(debugDir, `${targetId}_candidate_strip.png`)
      });

  // Extra Deck order is stable for this deck: E10 is normally reached faster
  // from the right, while E02/Kagari (the fire Link) keeps its proven left-to-
  // right traversal.  Only traversal order changes; click/settle timing stays.
  if (targetId === 'E10') points.sort((a, b) => b.x - a.x);

  if (!points.length) throw new Error(`${label}_NO_REAL_CANDIDATE_FRAMES`);
  console.log(`${label}固定候选中心: ${points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')}`);

  const seen=[];
  for (let i=0;i<points.length;i++) {
    const reference={x:points[i].x,y:points[i].y};
    const physical=mapReferencePoint(info,reference);
    await bridge.click(physical.x,physical.y);
    await sleep(Math.max(600,Number(config.mouseSettleMs||260)));

    let raw=await recognizeCurrentCard(bridge,info,library,templates,{stableAcceptedSamples:3});
    let recognized=normalizeRecognized(raw);
    if (!recognized.accepted || recognized.id==='UNKNOWN') {
      await sleep(450);
      raw=await recognizeCurrentCard(bridge,info,library,templates,{stableAcceptedSamples:3});
      recognized=normalizeRecognized(raw);
    }

    console.log(`${label}候选${i+1}: ${recognized.name}[${recognized.id}] ${recognized.accepted?'PASS':'UNKNOWN'}`);
    seen.push({reference,recognized});
    if (recognized.accepted && recognized.id===targetId) {
      console.log(`${label}目标命中: ${recognized.name}[${recognized.id}]；保持选中，不再点击候选。`);
      await waitBeforePromptSubmit(label);
      return {reference,recognized,seen};
    }

    // Do not click the same card again to "deselect" it. Clicking the next
    // physical card naturally changes the selection and keeps geometry stable.
    console.log(`  ${label}候选${i+1}不是目标；直接检查下一真实候选。`);
  }
  if (allowMiss) {
    return {
      miss: true,
      targetId,
      points,
      seen,
      lastReference: seen.length ? seen[seen.length - 1].reference : null
    };
  }
  throw new Error(`${label}_TARGET_NOT_FOUND:${targetId};seen=${seen.map(x=>`${x.recognized.name}[${x.recognized.id}]`).join('>')||'NONE'}`);
}

async function selectOptionalEffectById({ bridge, info, library, templates, targetId, debugDir, onSubmitted = null, expectedPoolCount = null }) {
  const pool = await waitOptionalPool({ bridge, info, debugDir, timeoutMs: 9000 });
  if (expectedPoolCount !== null && Number(pool.candidateCount) !== expectedPoolCount) {
    throw new Error('OPTIONAL_EFFECT_POOL_COUNT_CHANGED:zero_input=1');
  }
  const selected = await selectExactPromptCard({
    bridge,
    info,
    library,
    templates,
    roi: OPTIONAL_EFFECT_PROMPT.candidateRoi,
    candidateY: OPTIONAL_EFFECT_PROMPT.candidateY,
    targetId,
    label: '可选效果',
    debugDir
  });
  const expected = config.extraDeck && config.extraDeck.summonDialog && config.extraDeck.summonDialog.confirmPoint || { x: 1178, y: 1088 };
  await clickYellowButton({
    bridge,
    info,
    roi: { x: 1030, y: 1025, width: 340, height: 120 },
    expected,
    debugPath: debugDir && path.join(debugDir, 'optional_select_latest.png'),
    label: `${selected.recognized.name}效果“选择”按钮`
  });
  if (typeof onSubmitted === 'function') onSubmitted({ selected, pool });
  const priority = await waitForSelfPriorityBlue({
    bridge,
    info,
    label: `AFTER_${targetId}_OPTIONAL_EFFECT_ACTIVATION_RESPONSE_BOUNDARY`,
    timeoutMs: 30000
  });
  return { pool, selected, responseBoundaryPriority: priority };
}

async function waitSkyTargetPrompt({ bridge, info, debugDir, timeoutMs = 9000 }) {
  const started = Date.now();
  let attempt = 0;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    last = await probeSkyStrikerSearchTargetPrompt({
      bridge,
      info,
      debugDir,
      suffix: `v5_kagari_${String(attempt).padStart(2, '0')}`
    });
    if (last.visible) return last;
    await sleep(150);
  }
  throw new Error(`V5_KAGARI_RECOVERY_PROMPT_TIMEOUT:candidates=${last && last.candidateCount || 0}`);
}

async function confirmGenericSearch({ bridge, info, debugDir, label }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.roi || !cfg.point) throw new Error('V5_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  const started = Date.now();
  let lastYellow = 0;
  while (Date.now() - started < 4000) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'search_confirm_latest.png'));
    }
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    const enoughTotal = lastYellow >= (cfg.minYellowPixels || 600);
    const enoughComponent = stats.buttonComponent &&
      stats.buttonComponent.estimatedPixels >= ((cfg.minButtonPixels || cfg.minYellowPixels || 600) * 0.4);
    if (enoughTotal || enoughComponent) {
      const physical = mapReferencePoint(info, cfg.point);
      await bridge.click(physical.x, physical.y);
      console.log(`${label}: 已点击底部“选择/确认”；yellowPixels=${lastYellow}`);
      return { yellowPixels: lastYellow, point: cfg.point };
    }
    await sleep(120);
  }
  throw new Error(`${label}_CONFIRM_NOT_PROVEN:yellow=${lastYellow};候选已选中，只重试按钮。`);
}

async function selectSkyStrikerRecoveryTarget({
  bridge,
  info,
  library,
  templates,
  targetId,
  debugDir,
  label = '闪刀回收'
}) {
  // IMPORTANT: do not trust the coarse prompt component count here.
  // A highlighted Sky Striker Spell can visually merge the whole row into one
  // component.  The formal V5 atomic path therefore measures the actual green
  // Spell-card frames from current pixels and then recognizes each real frame.
  const prompt = await waitSkyTargetPrompt({ bridge, info, debugDir });
  console.log(`${label}窗口 PASS: coarseCandidates=${prompt.candidateCount}`);

  const points = await waitForStableSkyTargetPoints({
    bridge,
    info,
    debugDir,
    label: `${label}真实候选`
  });
  if (!points.length) throw new Error(`${label}_NO_REAL_CANDIDATE_FRAMES`);

  console.log(
    `${label}真实候选中心: ` +
    points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')
  );

  const seen = [];
  for (let i = 0; i < points.length; i++) {
    const reference = { x: points[i].x, y: points[i].y };
    const recognized = await recognizeSelectedAt({
      bridge,
      info,
      library,
      templates,
      reference,
      label: `${label}候选${i + 1}`
    });
    seen.push({ reference, recognized });

    if (recognized.accepted && recognized.id === targetId) {
      console.log(`${label}目标命中: ${recognized.name}[${recognized.id}]；保持选中，不再扫描。`);
      await waitBeforePromptSubmit(`${label}目标`);
      await confirmGenericSearch({ bridge, info, debugDir, label: `${label}目标` });
      return { prompt, selected: { reference, recognized }, seen, physicalPoints: points };
    }

    // Do not click the same card again to deselect it. Selecting the next real
    // physical card naturally replaces the current highlight without changing
    // prompt geometry.
    console.log(`  ${label}候选${i + 1}不是目标；直接检查下一真实候选。`);
  }

  throw new Error(
    `${label}_TARGET_NOT_FOUND:${targetId};seen=` +
    `${seen.map(x => `${x.recognized.name}[${x.recognized.id}]`).join('>') || 'NONE'}`
  );
}

async function selectKagariRecoveryTarget(options) {
  return selectSkyStrikerRecoveryTarget({ ...options, label: '篝回收' });
}

function verifyHandGain(before, after, id, label) {
  if (!after || !Number.isInteger(after.handCount)) throw new Error(`${label}_AFTER_HAND_INVALID`);
  if (after.handCount !== before.handCount + 1) {
    throw new Error(`${label}_HAND_DELTA_INVALID:${before.handCount}->${after.handCount};expected=+1`);
  }
  const beforeCopies = countId(before, id);
  const afterCopies = countId(after, id);
  if (afterCopies !== beforeCopies + 1) {
    throw new Error(`${label}_CARD_GAIN_INVALID:${id};${beforeCopies}->${afterCopies}`);
  }
}

async function verifyKnownSingleGainAtomic({
  state,
  gainId,
  label,
  settleMs = 900,
  activationKey = 'E02'
}) {
  const { readOwnHandCount } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
  const { loadInfoDigitTemplates } = require(path.join(ROOT, 'lib', 'hand-info-overlay'));
  const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));
  const library = loadLibrary(ROOT);
  const gainMeta = (library.cards || []).find(card => card && card.id === gainId);
  if (!gainMeta) throw new Error(`${label}_GAIN_META_NOT_FOUND:${gainId}`);

  console.log(
    `${label}: 已知只新增${gainMeta.name}[${gainId}]；纯等待${settleMs}ms后` +
    '只被动读取底部右栏与我方手牌数，禁止点击手牌。'
  );
  await sleep(settleMs);

  const provisionalCards = commitRecognizedInsertions(state.cards || [], [{
    id: gainMeta.id,
    name: gainMeta.name,
    accepted: true,
    __knownGain: true
  }], library);
  const provisional = {
    ...state,
    handCount: state.handCount + 1,
    cards: provisionalCards
  };

  const attemptDir = path.join(ROUTE_ROOT, timestampId(), 'known_single_gain_atomic');
  ensureDir(attemptDir);
  const { bridge, info } = await startBridge();
  try {
    const digitTemplates = loadInfoDigitTemplates(ROOT);
    const actualCount = await readOwnHandCount(
      bridge,
      digitTemplates,
      path.join(attemptDir, 'hand_count'),
      provisional.handCount
    );
    if (actualCount !== provisional.handCount) {
      throw new Error(`${label}_HAND_COUNT_INVALID:${state.handCount}->${actualCount};expected=+1`);
    }
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      rebaselineCurrentBottom: true,
      allowBacktrack: false,
      expectedAtomicActivationKey: activationKey,
      initialInfo: info,
      verbose: false
    });

    const log = readJson(DUEL_LOG_RESULT_PATH);
    const blocks = Array.isArray(log && log.operationBlocks) ? log.operationBlocks : [];
    const matching = blocks.filter(block => {
      if (!block || String(block.activationKey || '') !== String(activationKey)) return false;
      return (Array.isArray(block.details) ? block.details : []).some(detail =>
        detail && detail.card && detail.card.id === gainId &&
        String(detail.role || detail.rawType || '').includes('HAND_GAIN')
      );
    });
    if (matching.length !== 1) {
      throw new Error(
        `${label}_RIGHT_LOG_GAIN_NOT_UNIQUE:${activationKey}->${gainId};matches=${matching.length}`
      );
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const gainSlot = provisionalCards.findIndex(card => card.__knownGain === true) + 1;
  if (gainSlot <= 0) throw new Error(`${label}_PROVISIONAL_GAIN_SLOT_NOT_FOUND:${gainId}`);
  const cards = provisionalCards.map(card => {
    const copy = card.index === gainSlot
      ? {
        ...card,
        accepted: true,
        source: 'RIGHT_LOG_EXACT_NO_CLICK',
        physicalClicksIssued: 0
      }
      : { ...card };
    delete copy.__knownGain;
    return copy;
  });
  const next = {
    ...state,
    version: Math.max(2, Number(state.version || 1)),
    capturedAt: new Date().toISOString(),
    revision: Number(state.revision || 0) + 1,
    handCount: provisional.handCount,
    cards,
    lastIncremental: {
      consumed: null,
      costConsumed: [],
      predictedSlots: [gainSlot],
      recognized: [cards[gainSlot - 1]],
      finalClicks: [],
      mode: 'KNOWN_SINGLE_GAIN_RIGHT_LOG_AND_COUNT_NO_CLICK'
    }
  };
  writeJsonAtomic(HAND_STATE_PATH, next, { trailingNewline: true });
  try {
    commitKnownNonDeckHandGain({
      beforeState: state,
      afterState: next,
      gainId,
      evidenceKey: `KAGARI_KNOWN_SINGLE_GAIN:${gainId}:${state.revision}->${next.revision}`
    });
  } catch (error) {
    // Keep the two persistent revisions aligned if the ledger refuses the
    // targeted proof.  The physical H3 action is still never replayed; its
    // dedicated recovery node can re-prove the already-resolved hand gain.
    writeJsonAtomic(HAND_STATE_PATH, state, { trailingNewline: true });
    throw error;
  }
  console.log(
    `${label} PASS: 手牌${state.handCount}->${next.handCount}; ` +
    `右栏唯一确认${gainMeta.name}[${gainId}]回手，未点击、未扫描其它手牌。`
  );
  return next;
}

async function verifyKnownMultiGainAtomic({
  state,
  gains,
  label,
  settleMs = 300
}) {
  const { readOwnHandCount } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
  const { loadInfoDigitTemplates } = require(path.join(ROOT, 'lib', 'hand-info-overlay'));
  const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));
  const library = loadLibrary(ROOT);
  const rows = (Array.isArray(gains) ? gains : []).map((gain, index) => {
    const id = String(gain && gain.id || '');
    const activationKey = String(gain && gain.activationKey || '');
    const meta = (library.cards || []).find(card => card && card.id === id);
    if (!meta || !activationKey) {
      throw new Error(`${label}_GAIN_INPUT_INVALID:${index}:${id}:${activationKey || 'NO_ACTIVATION'}`);
    }
    return { ...gain, id, activationKey, meta, token: `known_gain_${index}` };
  });
  if (rows.length < 2) throw new Error(`${label}_MULTI_GAIN_COUNT_INVALID:${rows.length}`);

  console.log(
    `${label}: 已知连续新增${rows.map(row => `${row.meta.name}[${row.id}]`).join('、')}；` +
    `纯等待${settleMs}ms后只被动读取底部右栏与我方手牌数，禁止点击手牌。`
  );
  await sleep(settleMs);

  const provisionalCards = commitRecognizedInsertions(state.cards || [], rows.map(row => ({
      id: row.meta.id,
      name: row.meta.name,
      accepted: true,
      __knownGainToken: row.token
  })), library);
  const provisional = {
    ...state,
    handCount: state.handCount + rows.length,
    cards: provisionalCards
  };

  const attemptDir = path.join(ROUTE_ROOT, timestampId(), 'known_multi_gain_atomic');
  ensureDir(attemptDir);
  const { bridge, info } = await startBridge();
  try {
    const digitTemplates = loadInfoDigitTemplates(ROOT);
    const actualCount = await readOwnHandCount(
      bridge,
      digitTemplates,
      path.join(attemptDir, 'hand_count'),
      provisional.handCount
    );
    if (actualCount !== provisional.handCount) {
      throw new Error(
        `${label}_HAND_COUNT_INVALID:${state.handCount}->${actualCount};expected=+${rows.length}`
      );
    }
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      rebaselineCurrentBottom: true,
      allowBacktrack: false,
      expectedAtomicActivationKey: '',
      initialInfo: info,
      verbose: false
    });

    const log = readJson(DUEL_LOG_RESULT_PATH);
    const blocks = Array.isArray(log && log.operationBlocks) ? log.operationBlocks : [];
    const { proveKnownMultiGainBlocks } = require(path.join(ROOT, 'lib', 'known-multi-gain-proof'));
    const gainProof = proveKnownMultiGainBlocks(blocks, rows);
    if (!gainProof.pass && rows.some(row => row.activationKey === 'E02')) {
      throw new Error(`${label}_RIGHT_LOG_GAIN_NOT_UNIQUE:KAGARI_DUAL_PROOF_REJECTED`);
    }
    if (!gainProof.pass) for (const row of rows) {
      const matching = blocks.filter(block => {
        if (!block || String(block.activationKey || '') !== row.activationKey) return false;
        return (Array.isArray(block.details) ? block.details : []).some(detail =>
          detail && detail.card && detail.card.id === row.id &&
          String(detail.role || detail.rawType || '').includes('HAND_GAIN')
        );
      });
      if (matching.length !== 1) {
        throw new Error(
          `${label}_RIGHT_LOG_GAIN_NOT_UNIQUE:${row.activationKey}->${row.id};matches=${matching.length}`
        );
      }
    }
    console.log(`${label}: 获卡归属验收 ${gainProof.mode || 'REJECTED'}`);
  } finally {
    await bridge.stop().catch(() => {});
  }

  const recognized = [];
  const cards = provisionalCards.map(card => {
    const row = rows.find(candidate => candidate.token === card.__knownGainToken);
    const copy = row
      ? { ...card, accepted: true, source: 'RIGHT_LOG_EXACT_NO_CLICK', physicalClicksIssued: 0 }
      : { ...card };
    delete copy.__knownGainToken;
    if (row) recognized.push(copy);
    return copy;
  });
  const gainSlots = recognized.map(card => card.index);
  if (recognized.length !== rows.length) {
    throw new Error(`${label}_PROVISIONAL_GAIN_SLOTS_INVALID:${recognized.length}/${rows.length}`);
  }
  const next = {
    ...state,
    version: Math.max(2, Number(state.version || 1)),
    capturedAt: new Date().toISOString(),
    revision: Number(state.revision || 0) + 1,
    handCount: provisional.handCount,
    cards,
    lastIncremental: {
      consumed: null,
      costConsumed: [],
      predictedSlots: gainSlots,
      recognized,
      finalClicks: [],
      mode: 'KNOWN_MULTI_GAIN_RIGHT_LOG_AND_COUNT_NO_CLICK'
    }
  };
  writeJsonAtomic(HAND_STATE_PATH, next, { trailingNewline: true });
  try {
    commitKnownAtomicHandGains({
      beforeState: state,
      afterState: next,
      gains: rows.map(row => ({
        id: row.id,
        activationKey: row.activationKey,
        fromDeck: row.fromDeck === true,
        reason: row.reason
      })),
      evidenceKey: `KNOWN_MULTI_GAIN:${rows.map(row => `${row.activationKey}->${row.id}`).join('+')}:` +
        `${state.revision}->${next.revision}`
    });
  } catch (error) {
    writeJsonAtomic(HAND_STATE_PATH, state, { trailingNewline: true });
    throw error;
  }
  writeJsonAtomic(INCREMENTAL_PATH, {
    status: 'PASS',
    mode: 'KNOWN_MULTI_GAIN_RIGHT_LOG_AND_COUNT_NO_CLICK',
    before: state,
    after: next,
    insertedCards: recognized.map(card => ({ slot: card.index, card })),
    finalClicks: [],
    physicalClicksIssued: 0
  }, { trailingNewline: true });
  console.log(
    `${label} PASS: 手牌${state.handCount}->${next.handCount}; ` +
    `右栏逐项确认${rows.map(row => `${row.activationKey}->${row.id}`).join('、')}，未点击、未扫描其它手牌。`
  );
  return next;
}


async function resumeKagariRecoveryCurrentPrompt({ state, recoverId = 'M17' }) {
  const attemptDir=path.join(ROUTE_ROOT,timestampId(),'01b_resume_kagari_recovery');
  ensureDir(attemptDir);
  const library=loadLibrary(ROOT);
  const templates=await loadTemplates(ROOT,library);
  const { observeAdjacentLogAndHandEventually } = require(path.join(
    ROOT,
    'execution',
    'core',
    'branch-adjacent-observer'
  ));
  const {bridge,info}=await startBridge();
  let observerError = null;
  try {
    console.log('\n============================================================');
    console.log('V6现场续跑：当前应保持在“篝回收对象”窗口。');
    console.log('不会重做大黄蜂、不会重新Link篝、不会重新发动篝效果。');
    console.log('只处理当前窗口：找到交闪[M17] -> 选择 -> 提交。');
    console.log('============================================================');
    await selectKagariRecoveryTarget({
      bridge,info,library,templates,targetId:recoverId,
      debugDir:path.join(attemptDir,'kagari_recovery_resume')
    });
    try {
      const observed = await observeAdjacentLogAndHandEventually({
        bridge,
        label: 'HORNET_H3_KAGARI_RECOVERY_DONE',
        expectedActivationKey: 'E02',
        expectedMode: 'new-or-extended',
        requiredDetails: [{ cardId: recoverId, roleIncludes: 'HAND_GAIN' }],
        settleBeforeFirstMs: 900,
        retryWaitMs: 650,
        maxAttempts: 4
      });
      const after = observed.handState;
      verifyHandGain(state,after,recoverId,'V5_KAGARI_RECOVERY_RESUME');
      console.log(
        `篝回收原子 observer PASS: ${recoverId}; 手牌 ${state.handCount}->${after.handCount}; ` +
        `bottom-only; backtrack=${observed.proof.backtrackCount || 0}`
      );
      return {state:after,recoverId,attemptDir,proof:observed.proof};
    } catch (error) {
      // The target and bottom confirm have already been irreversibly submitted.
      // Never replay H3 merely because the strict adjacent right-log checkpoint
      // rolled back. Close this bridge first, then prove only the single known
      // gain from current log + INFO; never rebuild or click the whole hand.
      observerError = error;
      console.log(
        `H3提交后相邻右栏验收失败：${error && error.message || error}; ` +
        '禁止重点回收窗口，改为只确认唯一新增的交闪。'
      );
    }
  } finally {
    await bridge.stop().catch(()=>{});
  }

  if (observerError) {
    const after = await verifyKnownSingleGainAtomic({
      state,
      gainId: recoverId,
      label: 'H3提交后的单张确定回收验收',
      settleMs: 300
    });
    verifyHandGain(state, after, recoverId, 'V5_KAGARI_RECOVERY_TARGETED');
    console.log(
      `篝回收原子 TARGETED PASS: ${recoverId}; 手牌 ${state.handCount}->${after.handCount}; ` +
      '未重放回收点击，未扫描其它手牌。'
    );
    return {
      state: after,
      recoverId,
      attemptDir,
      proof: { mode: 'KNOWN_SINGLE_GAIN_AFTER_SUBMITTED_H3', observerError: observerError.message }
    };
  }

  throw new Error('V5_KAGARI_RECOVERY_UNREACHABLE');
}

async function recoverResolvedKagariAtomic({ state, recoverId = 'M17' }) {
  console.log('\n============================================================');
  console.log('V5恢复节点 H3R：篝回收窗口已经提交/消失，只验收交闪确实回手。');
  console.log('本节点不会点击篝、候选牌、确认按钮或任何保存坐标。');
  console.log('============================================================');
  const after = await verifyKnownSingleGainAtomic({
    state,
    gainId: recoverId,
    label: 'H3R已提交篝回收的单张验收',
    settleMs: 1500
  });
  verifyHandGain(state, after, recoverId, 'V5_KAGARI_RECOVERY_CLOSED_PROMPT');
  console.log(
    `H3R PASS: ${recoverId}; 手牌 ${state.handCount}->${after.handCount}; ` +
    '未重放任何回收点击。'
  );
  return {
    state: after,
    recoverId,
    proof: { mode: 'CLOSED_KAGARI_PROMPT_KNOWN_SINGLE_GAIN' }
  };
}

async function resumeSwordEquipTargetAtomic({
  state,
  cardId = 'M19',
  expectedCarrierId = 'E02',
  requiredCarrierKind = 'EXTRA_LINK'
}) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'resume_sword_equip_target');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  let target = null;
  try {
    console.log('\n============================================================');
    console.log(`V5恢复节点 EQ-R：${cardId}已经发动，只处理当前装备对象窗口。`);
    console.log('不会重新点击手牌、不会重新发动装备魔法。');
    console.log('============================================================');
    target = await clickPreferredEquipCarrier({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(routeDir, 'equip_target'),
      requiredKind: requiredCarrierKind,
      afterIdentityMs: 1000,
      label: `${cardId}恢复装备`
    });
    if (
      expectedCarrierId && target.recognized && target.recognized.accepted &&
      String(target.recognized.id || '') !== String(expectedCarrierId)
    ) {
      throw new Error(
        `V5_RESUME_EQUIP_CARRIER_MISMATCH:${target.recognized.id};expected=${expectedCarrierId}`
      );
    }
    await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: target.clickReference,
      debugDir: path.join(routeDir, 'equip_confirm'),
      label: `${cardId}_resume_equip_confirm`
    });
    await sleep(1200);
  } finally {
    await bridge.stop().catch(() => {});
  }
  const after = runObserver({ expectedAtomicActivationKey: cardId });
  if (after.handCount !== state.handCount - 1 || countId(after, cardId) !== countId(state, cardId) - 1) {
    throw new Error(`V5_RESUME_${cardId}_EQUIP_HAND_DELTA_INVALID:${state.handCount}->${after.handCount}`);
  }
  console.log(`EQ-R PASS: ${cardId}装备完成；手牌 ${state.handCount}->${after.handCount}。`);
  return { state: after, carrier: target, routeDir };
}

async function dismissSelectedHandActionMenuAtomic() {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_dismiss_selected_hand_action_menu');
  ensureDir(routeDir);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6恢复原子 HM-R：只把误点手牌后打开的操作菜单复位到中立画面。');
    console.log('复用成熟手牌定位前复位：安全区点击 -> ESC -> 稳定截图；不发动卡、不执行Link。');
    console.log('============================================================');
    const image = await captureNeutralNormalSummonFrame({
      bridge,
      info,
      debugDir: path.join(routeDir, 'neutral')
    });
    if (!image || image.width !== 2048 || image.height !== 1152) {
      throw new Error('V5_HAND_MENU_DISMISS_NEUTRAL_FRAME_INVALID');
    }
    console.log('HM-R PASS：手牌操作菜单已按成熟中立复位序列关闭；本节点没有发动卡或执行Link。');
    return { routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}


async function runHornetTokenToKagariLinkAtomic({ state, onOptionalPoolProven = null }) {
  const attemptDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_hornet_token_to_kagari');
  ensureDir(attemptDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 H1：大黄蜂衍生物 -> Link闪刀姬－篝。');
    console.log('本节点只做到篝Link成功并出现可选效果池；不会发动篝效果，不会进入回收窗口。');
    console.log('============================================================');

    await clickExtraDeckSummonButton({ bridge, info, debugDir: path.join(attemptDir, 'extra') });
    const prompt = await waitForSummonCandidates({ bridge, info, debugDir: path.join(attemptDir, 'link_candidates') });
    await selectSpecificLink({
      bridge,
      info,
      library,
      templates,
      promptProof: prompt,
      targetId: 'E02',
      carrierId: 'TOKEN_SKY_STRIKER',
      debugDir: path.join(attemptDir, 'select_kagari')
    });
    await clickBottomSummonSubmit({ bridge, info, debugDir: path.join(attemptDir, 'link_submit') });
    await sleep(550);
    await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, 'token_material')
    });
    await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, 'token_material')
    });
    await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      debugDir: path.join(attemptDir, 'token_confirm')
    });
    await sleep(900);
    const pool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(attemptDir, 'post_link')
    });
    if (Number(pool && pool.candidateCount || 0) !== 1) {
      throw new Error(`V5_H1_KAGARI_OPTIONAL_POOL_NOT_SINGLE:${pool && pool.candidateCount || 0}`);
    }

    // Same commit proof as the unequipped Kagari/Yoto entrances: exact E02
    // selection + submitted material + current single optional-effect pool.
    // H1 changes no hand card. An auxiliary old M22 log representation cannot
    // veto a completed Link or leave TOKEN_READY saved for blind replay.
    const proof = { ...buildUnequippedKagariGainProof('E02', pool), materialCarrierId: 'TOKEN_SKY_STRIKER',
      phase: 'LINK_RESOLVED_EFFECT_NOT_ACTIVATED' };
    if (typeof onOptionalPoolProven === 'function') await onOptionalPoolProven({ targetLinkId: 'E02', pool, proof, attemptDir });
    console.log('H1 PASS: 篝身份、素材提交与当前单效果池已确认；不要求旧黄蜂日志必须报为新增/扩展块。');
    return { state, pool, proof, attemptDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runKagariEffectToRecoveryPromptAtomic({ state }) {
  const attemptDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_kagari_effect_to_prompt');
  ensureDir(attemptDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 H2：只发动闪刀姬－篝效果，停在回收对象窗口。');
    console.log('不会选择回收目标，不会点击当前候选卡。');
    console.log('============================================================');

    await selectOptionalEffectById({
      bridge,
      info,
      library,
      templates,
      targetId: 'E02',
      debugDir: path.join(attemptDir, 'kagari_effect')
    });
    const prompt = await waitSkyTargetPrompt({
      bridge,
      info,
      debugDir: path.join(attemptDir, 'kagari_recovery_prompt')
    });
    const points = await waitForStableSkyTargetPoints({
      bridge,
      info,
      debugDir: path.join(attemptDir, 'kagari_recovery_prompt'),
      label: '篝回收真实候选'
    });
    console.log(
      `H2 PASS: 篝回收窗口已稳定; coarse=${prompt.candidateCount}; ` +
      `physical=${points.length}; 未选择任何回收目标。`
    );
    return { state, prompt, points, attemptDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runKagariRecoveryCurrentPromptAtomic({ state, recoverId = 'M17' }) {
  console.log('\n============================================================');
  console.log('V6原子节点 H3：当前篝回收对象窗口 -> 精确认目标 -> 回收完成。');
  console.log('不会重做大黄蜂、不会重做Link、不会重新发动篝。');
  console.log('============================================================');
  return resumeKagariRecoveryCurrentPrompt({ state, recoverId });
}

async function runTokenToKagariRecover({ state, recoverId = 'M17' }) {
  const attemptDir = path.join(ROUTE_ROOT, timestampId(), '01_token_to_kagari_recover');
  ensureDir(attemptDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6确定性节点：大黄蜂衍生物 -> 单素材Link闪刀姬－篝 -> 篝回收交闪。');
    console.log('全部复用成熟真实候选/素材/确认检测；任何节点证据不足立即停止。');
    console.log('============================================================');

    await clickExtraDeckSummonButton({ bridge, info, debugDir: path.join(attemptDir, 'extra') });
    const prompt = await waitForSummonCandidates({ bridge, info, debugDir: path.join(attemptDir, 'link_candidates') });
    await selectSpecificLink({
      bridge,
      info,
      library,
      templates,
      promptProof: prompt,
      targetId: 'E02',
      carrierId: 'TOKEN_SKY_STRIKER',
      debugDir: path.join(attemptDir, 'select_kagari')
    });
    await clickBottomSummonSubmit({ bridge, info, debugDir: path.join(attemptDir, 'link_submit') });
    await sleep(550);
    await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, 'token_material')
    });
    await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      carrierMode: 'GENERIC',
      debugDir: path.join(attemptDir, 'token_material')
    });
    await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: TOKEN_ANCHOR,
      debugDir: path.join(attemptDir, 'token_confirm')
    });
    await sleep(1700);
    await waitForPostLinkOptionalPool({ bridge, info, debugDir: path.join(attemptDir, 'post_link') });
    await selectOptionalEffectById({
      bridge,
      info,
      library,
      templates,
      targetId: 'E02',
      debugDir: path.join(attemptDir, 'kagari_effect')
    });
    await sleep(500);
    await selectKagariRecoveryTarget({
      bridge,
      info,
      library,
      templates,
      targetId: recoverId,
      debugDir: path.join(attemptDir, 'kagari_recovery')
    });
    await sleep(1600);
  } finally {
    await bridge.stop().catch(() => {});
  }

  const after = runObserver({ expectedAtomicActivationKey: 'E02' });
  verifyHandGain(state, after, recoverId, 'V5_KAGARI_RECOVERY');
  console.log(`篝回收 observer PASS: ${recoverId}; 手牌 ${state.handCount}->${after.handCount}`);
  return { state: after, recoverId, attemptDir };
}

async function equipSwordFromHand({ state, cardId, cardName, debugDir, requiredCarrierKind = null, expectedCarrierId = null }) {
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  let targetProof = null;
  try {
    const selected = await selectCurrentObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline: state,
      expectedId: cardId,
      debugDir: path.join(debugDir, 'hand_target')
    });
    console.log(`发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS @手牌${selected.slot}`);
    await clickSelectedHandSpellActivation({
      bridge,
      info,
      expectedId: cardId,
      expectedName: cardName,
      clickReference: selected.clickReference,
      debugDir: path.join(debugDir, 'activation')
    });
    // The activation click only opens the equip-target transaction.  Do not
    // inspect or click the existing Link frame while that prompt is animating.
    await sleep(900);
    targetProof = await clickPreferredEquipCarrier({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(debugDir, 'equip_target'),
      requiredKind: requiredCarrierKind,
      afterIdentityMs: 1000,
      label: cardName
    });
    if (expectedCarrierId && (targetProof?.recognized?.accepted !== true || targetProof.recognized.id !== expectedCarrierId)) {
      throw new Error(`KAGARI_SWORD_EQUIP_CARRIER_NOT_PROVEN:${expectedCarrierId}`);
    }
    await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: targetProof.clickReference,
      debugDir: path.join(debugDir, 'equip_confirm'),
      label: `${cardId}_equip_confirm`
    });
    await sleep(1200);
  } finally {
    await bridge.stop().catch(() => {});
  }
  const after = runObserver({ expectedAtomicActivationKey: cardId });
  if (after.handCount !== state.handCount - 1 || countId(after, cardId) !== countId(state, cardId) - 1) {
    throw new Error(`V5_${cardId}_EQUIP_HAND_DELTA_INVALID:${state.handCount}->${after.handCount}`);
  }
  return { state: after, carrier: targetProof, debugDir };
}

async function clickRayeNormalSummonButton({ bridge, info, selectedReference, neutralActionFrame, debugDir }) {
  return clickSelectedMonsterNormalSummon({ bridge, info, expectedId: 'M06',
    expectedName: '闪刀姬－零衣', clickReference: selectedReference, neutralActionFrame, debugDir });
}


async function locateFieldRaye({ bridge, info, library, templates, debugDir }) {
  const reference = { ...RAYE_MAIN_ANCHOR };
  const physical = mapReferencePoint(info, reference);
  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 260);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const recognized = normalizeRecognized(raw);
  if (!recognized.accepted || recognized.id !== 'M06') {
    throw new Error(
      `V5_RAYE_FIELD_NOT_PROVEN:${recognized.name}[${recognized.id}];` +
      `probe=(${reference.x},${reference.y})`
    );
  }

  console.log(
    `场上零衣精确认: ${recognized.name}[${recognized.id}]; ` +
    `实际探测中心≈(${reference.x},${reference.y})`
  );
  if (debugDir) {
    writeJson(path.join(debugDir, 'field_raye.json'), {
      status: 'PASS',
      reference,
      recognized
    });
  }
  return { reference, recognized };
}


async function clickFieldRayeEffect({ bridge, info, fieldReference, debugDir }) {
  // Keep the existing whole action-wheel ROI and two-frame stability budget.
  // The confirmed field card determines the expected local point; permission
  // to click requires the actual Activate glyph, not a yellow/green ring.
  const effectRoi = {
    x: Math.max(0, Math.round(fieldReference.x - 190)),
    y: Math.max(0, Math.round(fieldReference.y - 265)),
    width: 380,
    height: 220
  };
  const expected = { x: fieldReference.x, y: fieldReference.y - 142 };
  const started = Date.now();
  let previous = null;
  let lastYellow = 0;
  let lastCandidates = [];
  let stableFrames = 0;
  let lastDetector = 'NONE';

  while (Date.now() - started < 5000) {
    const image = await captureReferenceRoi(bridge, info, effectRoi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'raye_effect_button_latest.png'));
    }
    const stats = yellowUsableStats(image);
    lastYellow = Number(stats && stats.estimatedYellowPixels || 0);
    const glyphProof = locateFieldActivateIcon(image, stats, effectRoi, expected);
    const chosenLocal = glyphProof.chosen;
    lastDetector = chosenLocal ? glyphProof.detector : 'NONE';
    const chosen = chosenLocal ? {
      component: chosenLocal,
      refX: effectRoi.x + Number(chosenLocal.centerX || 0),
      refY: effectRoi.y + Number(chosenLocal.centerY || 0)
    } : null;
    lastCandidates = chosen ? [chosen] : [];
    if (chosen) {
      if (previous && Math.hypot(chosen.refX - previous.refX, chosen.refY - previous.refY) <= 8) {
        stableFrames += 1;
      } else {
        stableFrames = 1;
      }
      previous = chosen;
      if (stableFrames >= 2) {
        const reference = { x: chosen.refX, y: chosen.refY };
        const horizontalDrift = Math.abs(reference.x - fieldReference.x);
        if (horizontalDrift > 35 || reference.y >= fieldReference.y - 60) {
          throw new Error(
            `RAYE_EFFECT_BUTTON_NOT_DIRECTLY_ABOVE:` +
            `card=(${fieldReference.x},${fieldReference.y});` +
            `button=(${Math.round(reference.x)},${Math.round(reference.y)});dx=${Math.round(horizontalDrift)}`
          );
        }
        const physical = mapReferencePoint(info, reference);
        await bridge.click(physical.x, physical.y);
        console.log(
          `零衣发动按钮确认: (${Math.round(reference.x)},${Math.round(reference.y)}); ` +
          `detector=${lastDetector}; stable=${stableFrames}; yellow=${lastYellow}`
        );
        return {
          clickReference: reference,
          reference,
          yellowPixels: lastYellow,
          component: chosen.component,
          stableFrames,
          detector: lastDetector
        };
      }
    } else {
      previous = null;
      stableFrames = 0;
    }
    await sleep(120);
  }

  throw new Error(
    'RAYE_EFFECT_BUTTON_NOT_PROVEN_FULL_WHEEL:' +
    'yellow=' + lastYellow + ';candidates=' + lastCandidates.length + ';detector=' + lastDetector
  );
}

async function submitRayeExtraSelection({ bridge, info, debugDir }) {
  // Reuse the mature M06 centered Select-label detector. Its ROI is fully
  // inside the 2048x1152 client and it requires the same label in two stable
  // frames, so an already-selected E10 is never clicked a second time.
  return clickRayeSummonSubmit({ bridge, info, debugDir });
}


function v5TargetTextureScore(image, centerX) {
  if (!image || !image.data || !image.width || !image.height) return 0;
  const half = 48;
  const left = Math.max(0, Math.round(centerX - half));
  const right = Math.min(image.width - 2, Math.round(centerX + half));
  let sum = 0;
  let samples = 0;
  for (let y = 15; y < Math.min(image.height - 2, 190); y += 2) {
    for (let x = left; x <= right; x += 2) {
      const a = (y * image.width + x) * 4;
      const b = a + 4;
      sum += Math.abs(image.data[a] - image.data[b]);
      sum += Math.abs(image.data[a + 1] - image.data[b + 1]);
      sum += Math.abs(image.data[a + 2] - image.data[b + 2]);
      samples++;
    }
  }
  return samples ? sum / samples : 0;
}

function v5RefineTargetCenter(image, seedLocalX, radius = 24) {
  let best = null;
  const left = Math.max(52, Math.round(seedLocalX - radius));
  const right = Math.min(image.width - 52, Math.round(seedLocalX + radius));
  for (let x = left; x <= right; x += 2) {
    const score = v5TargetTextureScore(image, x);
    if (!best || score > best.score) best = { x, score };
  }
  return best;
}

function v5DetectGreenSpellFrames(image, referenceRoi, candidateY) {
  if (!image || !image.data || !image.width || !image.height) return [];
  const scores = [];
  const top = 12;
  const bottom = Math.min(image.height - 5, 188);
  for (let x = 0; x < image.width; x++) {
    let green = 0;
    for (let y = top; y < bottom; y++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (g >= 55 && g * 100 >= r * 108 && g * 100 >= b * 85) green++;
    }
    scores.push(green);
  }
  const active = [];
  for (let x = 0; x < scores.length; x++) if (scores[x] >= 24) active.push(x);
  if (!active.length) return [];
  const groups = [];
  let start = active[0];
  let prev = active[0];
  for (let i = 1; i < active.length; i++) {
    const x = active[i];
    if (x - prev > 6) {
      groups.push({ start, end: prev });
      start = x;
    }
    prev = x;
  }
  groups.push({ start, end: prev });
  const out = [];
  for (const group of groups) {
    const width = group.end - group.start + 1;
    const center = (group.start + group.end) / 2;
    if (width < 72 || width > 145 || center < 70 || center > image.width - 70) continue;
    const refined = v5RefineTargetCenter(image, center, 24) || { x: center, score: v5TargetTextureScore(image, center) };
    out.push({
      x: referenceRoi.x + Math.round(refined.x),
      y: candidateY,
      detector: 'E10_TARGET_GREEN_SPELL_FRAME_V3',
      textureScore: refined.score
    });
  }
  return out.sort((a, b) => a.x - b.x).slice(0, 5);
}

function v5PhysicalTargetSignature(points) {
  return (points || []).map(point => Math.round(Number(point.x) / 8) * 8).join('|');
}

async function waitForStableSkyTargetPoints({ bridge, info, debugDir, timeoutMs = 7000, label = '零梦实际候选' }) {
  const roi = SKY_STRIKER_TARGET_PROMPT.candidateRoi;
  const started = Date.now();
  let lastSignature = '';
  let stable = 0;
  let stableAt = 0;
  let last = [];
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    const image = await captureReferenceRoi(bridge, info, roi);
    if (debugDir) saveRgbaPng(image, path.join(debugDir, `zero_target_physical_${String(attempt).padStart(2, '0')}.png`));
    let points = v5DetectGreenSpellFrames(image, roi, SKY_STRIKER_TARGET_PROMPT.candidateY);
    if (!points.length) {
      try {
        points = (detectCandidateCenters(image, roi, SKY_STRIKER_TARGET_PROMPT.candidateY, { mode: 'components' }) || [])
          .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number(p.width || 0) >= 58 && Number(p.width || 0) <= 175)
          .map(p => ({ ...p, detector: 'COMPONENT_FALLBACK' }));
      } catch (_) { points = []; }
    }
    last = points;
    const signature = v5PhysicalTargetSignature(points);
    console.log(`${label}稳定等待: attempt=${attempt}; count=${points.length}; ` +
      `${points.map(p => `(${Math.round(p.x)},${Math.round(p.y)};${p.detector})`).join(', ') || 'NONE'}`);
    if (signature && points.length >= 1 && points.length <= 5) {
      if (signature === lastSignature) stable++;
      else { lastSignature = signature; stable = 1; stableAt = Date.now(); }
      const greenOnly = points.every(p => p.detector === 'E10_TARGET_GREEN_SPELL_FRAME_V3');
      const needSamples = greenOnly ? 3 : 4;
      const needMs = greenOnly ? 350 : 700;
      if (stable >= needSamples && Date.now() - stableAt >= needMs) {
        console.log(`${label}卡框: PASS_STABLE; count=${points.length}; source=${greenOnly ? 'GREEN_SPELL_FRAMES' : 'FALLBACK'}; ` +
          `centers=[${points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')}]`);
        return points;
      }
    } else {
      lastSignature = '';
      stable = 0;
      stableAt = 0;
    }
    await sleep(150);
  }
  throw new Error(`V5_ZERO_TARGET_PHYSICAL_FRAMES_TIMEOUT:lastCount=${last.length}`);
}

async function selectPreferredSkyStrikerTarget({
  bridge,
  info,
  library,
  templates,
  debugDir,
  preferredIds = ['M17', 'M22'],
  engageSourcePolicy = null
}) {
  const prompt = await waitSkyTargetPrompt({ bridge, info, debugDir });
  console.log(`零梦检索/回收窗口 PASS: candidates=${prompt.candidateCount}`);

  const points = await waitForStableSkyTargetPoints({ bridge, info, debugDir });
  if (!points.length) throw new Error('V5_ZERO_TARGET_NO_REAL_CANDIDATE_FRAMES');

  const rank = new Map(preferredIds.map((id, index) => [id, index]));
  const seen = [];
  let fallback = null;
  const deferEngageChoice = preferredIds[0] === 'M17' && engageSourcePolicy &&
    ['GRAVE', 'DECK'].includes(engageSourcePolicy.preferredSource);

  for (let i = 0; i < points.length; i++) {
    const reference = { x: points[i].x, y: points[i].y };
    const recognized = await recognizeSelectedAt({
      bridge, info, library, templates, reference,
      label: `零梦检索候选${i + 1}`
    });
    const r = recognized.accepted && rank.has(recognized.id) ? rank.get(recognized.id) : null;
    seen.push({ reference, recognized, rank: r });

    if (r === 0 && !deferEngageChoice) {
      console.log(`零梦优先命中: ${recognized.name}[${recognized.id}]；保持选中。`);
      await waitBeforePromptSubmit('零梦检索目标');
      await confirmGenericSearch({ bridge, info, debugDir, label: '零梦检索目标' });
      return {
        prompt,
        selected: { reference, recognized },
        seen,
        priorityRank: 1,
        selectedSource: recognized.id === 'M17' && engageSourcePolicy &&
          engageSourcePolicy.preferredSource === 'DECK' ? 'DECK' : null,
        engageSourcePolicy
      };
    }

    if (r != null && (!fallback || r < fallback.rank)) fallback = { reference, recognized, rank: r };

    console.log(`  零梦候选${i + 1}不是最终优先目标：不再同点反点，直接检查下一真实候选。`);
  }

  if (deferEngageChoice) {
    fallback = selectE10EngageCandidate(seen, engageSourcePolicy);
  }

  if (!fallback) {
    throw new Error(
      `V5_ZERO_NO_SUPPORTED_TARGET:` +
      `${seen.map(x => `${x.recognized.name}[${x.recognized.id}]`).join('|') || 'NONE'}`
    );
  }

  const lastSeen = seen[seen.length - 1];
  const alreadySelected = Boolean(
    lastSeen &&
    Math.hypot(
      Number(lastSeen.reference.x) - Number(fallback.reference.x),
      Number(lastSeen.reference.y) - Number(fallback.reference.y)
    ) <= 3
  );
  if (!alreadySelected) {
    const physical = mapReferencePoint(info, fallback.reference);
    await bridge.click(physical.x, physical.y);
    await sleep(config.mouseSettleMs || 260);
  }
  const raw = await recognizeCurrentCard(bridge, info, library, templates, { stableAcceptedSamples: 2 });
  const recognized = normalizeRecognized(raw);
  if (!recognized.accepted || recognized.id !== fallback.recognized.id) {
    throw new Error(
      `V5_ZERO_FALLBACK_RESELECT_MISMATCH:${recognized.name}[${recognized.id}];` +
      `expected=${fallback.recognized.id}`
    );
  }

  console.log(
    fallback.selectedSource === 'GRAVE'
      ? `零梦按数量策略选择墓地${recognized.name}[${recognized.id}]。`
      : `零梦回到已确认的${recognized.name}[${recognized.id}]。`
  );
  await waitBeforePromptSubmit('零梦检索目标');
  await confirmGenericSearch({ bridge, info, debugDir, label: '零梦检索目标' });
  return {
    prompt,
    selected: { reference: fallback.reference, recognized },
    seen,
    priorityRank: fallback.rank + 1,
    selectedSource: fallback.selectedSource || null,
    engageSourcePolicy
  };
}

function currentE10EngageSourcePolicy(library, state) {
  const runtimeState = readJsonIfExists(DECISION_STATE_PATH) || {};
  let policy = buildE10EngageSourcePolicy({ library, handState: state, runtimeState });
  const forcedSource = String(runtimeState.v5Branch && runtimeState.v5Branch.e10EngageSource || '')
    .toUpperCase();
  if (forcedSource === 'GRAVE' && Number(policy.engageInGrave || 0) > 0) {
    policy = {
      ...policy,
      preferredSource: 'GRAVE',
      reason:
        '当前Raye双素材路线已证明墓地有交闪，且回收后可检索并追加抽1；' +
        '本原子固定选择墓地交闪，不改成牌组同名交闪。'
    };
  }
  console.log(`零梦交闪来源策略: ${policy.preferredSource}; ${policy.reason}`);
  return policy;
}


async function completeM20FieldEffectToYotoTarget({
  bridge,
  info,
  library,
  templates,
  routeDir,
  expectedCarrierId = null,
  label = '真刀转妖刀'
}) {
  // Verified mature order:
  // field M20 effect -> choose M19 from Deck -> bottom Select ->
  // choose the monster for M19 -> blue Confirm -> pure wait.
  await sleep(1050);
  const prompt = await waitForM19DeckPrompt({
    bridge,
    info,
    debugDir: path.join(routeDir, 'm19_deck_prompt')
  });
  await selectM19FromDeckPrompt({
    bridge,
    info,
    library,
    templates,
    promptProof: prompt,
    debugDir: path.join(routeDir, 'm19_from_deck')
  });
  console.log('妖刀竹光[M19]已经从牌组选择并提交；现在才进入“选择一个怪兽用妖刀竹光装备”。');

  await sleep(900);
  const target = await clickPreferredEquipCarrier({
    bridge,
    info,
    library,
    templates,
    debugDir: path.join(routeDir, 'm19_equip_target'),
    afterIdentityMs: 1000,
    label: `${label}装备对象`
  });

  if (
    expectedCarrierId &&
    target && target.recognized && target.recognized.accepted &&
    String(target.recognized.id || '') !== String(expectedCarrierId)
  ) {
    throw new Error(
      `V5_M20_TO_M19_TARGET_MISMATCH:` +
      `${target.recognized.name}[${target.recognized.id}];expected=${expectedCarrierId}`
    );
  }

  await clickObservedEquipConfirm({
    bridge,
    info,
    anchorReference: target.clickReference,
    debugDir: path.join(routeDir, 'm19_equip_confirm'),
    label: 'M19_from_M20_equip_confirm'
  });
  console.log('妖刀装备对象蓝色确认已提交；纯等待真刀送墓/妖刀装备动画。');
  await sleep(1900);
  return target;
}

async function resumeM20YotoEquipTargetCurrentPrompt({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), '02b_resume_m20_yoto_target');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6现场续跑：当前必须停在“选择一个怪兽用妖刀竹光装备”窗口。');
    console.log('不会重新发动真刀、不会重新选择妖刀、不会点击手牌。');
    console.log('只执行：选择当前真实装备对象 -> 蓝色确认 -> 右栏验收 -> 继续carrier Link/妖刀检索。');
    console.log('============================================================');

    const target = await clickPreferredEquipCarrier({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(routeDir, 'm19_equip_target_resume'),
      afterIdentityMs: 1000,
      label: '妖刀竹光'
    });
    await clickObservedEquipConfirm({
      bridge,
      info,
      anchorReference: target.clickReference,
      debugDir: path.join(routeDir, 'm19_equip_confirm_resume'),
      label: 'M19_resume_equip_confirm'
    });
    await sleep(1900);
  } finally {
    await bridge.stop().catch(() => {});
  }

  await runM20FieldConversionLogCheck({ attempts: 4 });
  saveTrueRouteStage('M20_CONVERTED_TO_M19', {
    routeDir,
    handCount: state.handCount
  });
  return runTruePostConversionContinuation({ state, routeDir });
}

async function prepareTrueToYotoOnFieldRaye({ state, routeDir }) {
  const equipped = await equipSwordFromHand({
    state,
    cardId: 'M20',
    cardName: '真刀竹光',
    debugDir: path.join(routeDir, 'equip_true_to_raye')
  });

  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    const fieldM20 = await locateFieldM20({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'field_true')
    });
    await clickFieldM20Effect({
      bridge, info,
      fieldReference: fieldM20.reference,
      debugDir: path.join(routeDir, 'true_effect')
    });

    await completeM20FieldEffectToYotoTarget({
      bridge,
      info,
      library,
      templates,
      routeDir,
      expectedCarrierId: 'M06',
      label: '真刀贴妖刀到零衣'
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  await runM20FieldConversionLogCheck({ attempts: 4 });
  return equipped.state;
}

async function runRayeZeroDirect({ state, swordMode = 'AUTO', alreadyEquippedYoto = false }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), '03_raye_zero_direct');
  ensureDir(routeDir);

  let working = state;
  let equippedYoto = Boolean(alreadyEquippedYoto);
  let actualSwordMode = alreadyEquippedYoto ? 'M19_EQUIPPED' : 'NONE';
  const hasM19 = countId(working, 'M19') > 0;
  const hasM20 = countId(working, 'M20') > 0;

  if (!alreadyEquippedYoto && (swordMode === 'M19' || swordMode === 'AUTO') && hasM19) {
    console.log('\n零梦收尾：先把手牌妖刀竹光装备给场上零衣，再发动零衣自身效果。');
    const equipped = await equipSwordFromHand({
      state: working,
      cardId: 'M19',
      cardName: '妖刀竹光',
      debugDir: path.join(routeDir, 'equip_yoto_to_raye')
    });
    working = equipped.state;
    equippedYoto = true;
    actualSwordMode = 'M19';
  } else if (!alreadyEquippedYoto && (swordMode === 'M20' || swordMode === 'AUTO') && hasM20) {
    console.log('\n零梦收尾：先真刀装备零衣，再用真刀效果把妖刀贴到零衣。');
    working = await prepareTrueToYotoOnFieldRaye({ state: working, routeDir });
    equippedYoto = true;
    actualSwordMode = 'M20_TO_M19';
  }

  const beforeResolution = working;
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  let zeroTarget = null;
  let bambooSelection = null;

  try {
    console.log('\n============================================================');
    console.log(
      equippedYoto
        ? 'V6零衣路线3：零衣已带妖刀 -> 零衣自身效果 -> 直接特殊召唤零梦[E10] -> 妖刀CL1/零梦CL2。'
        : 'V6零衣路线3：不Link；零衣自身效果 -> 直接特殊召唤零梦[E10] -> 零梦效果。'
    );
    console.log('这是零衣自身效果直出零梦，不是双素材Link。');
    console.log('============================================================');

    const raye = await locateFieldRaye({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'field_raye')
    });
    await clickFieldRayeEffect({
      bridge, info,
      fieldReference: raye.reference,
      debugDir: path.join(routeDir, 'raye_effect')
    });

    await sleep(650);
    const prompt = await waitForSummonCandidates({
      bridge, info,
      debugDir: path.join(routeDir, 'zero_candidates')
    });
    await selectSpecificLink({
      bridge, info, library, templates,
      promptProof: prompt,
      targetId: 'E10',
      carrierId: 'M06',
      debugDir: path.join(routeDir, 'select_zero')
    });
    await submitRayeExtraSelection({
      bridge, info,
      debugDir: path.join(routeDir, 'zero_submit')
    });
    console.log('零衣额外选择已提交：零梦[E10]；未重复点击零梦。');

    await sleep(1700);

    if (equippedYoto) {
      const optionalPool = await waitForPostLinkOptionalPool({
        bridge, info,
        debugDir: path.join(routeDir, 'double_optional_pool')
      });
      if (Number(optionalPool.candidateCount || 0) < 2) {
        throw new Error(`V5_RAYE_YOTO_ZERO_EXPECTED_DOUBLE_OPTIONAL_POOL:${optionalPool.candidateCount || 0}`);
      }

      const m19Optional = await selectM19FromOptionalPool({
        bridge, info, library, templates,
        debugDir: path.join(routeDir, 'm19_cl1')
      });
      console.log('妖刀竹光[M19]已作为CL1发动；保留零梦效果作为CL2。');

      await sleep(450);
      await selectOptionalEffectById({
        bridge, info, library, templates,
        targetId: 'E10',
        debugDir: path.join(routeDir, 'zero_cl2')
      });
      console.log('零梦[E10]已作为CL2发动；按逆序先结算零梦。');

      await sleep(450);
      zeroTarget = await selectPreferredSkyStrikerTarget({
        bridge, info, library, templates,
        debugDir: path.join(routeDir, 'zero_target')
      });
      await sleep(900);

      await waitForBambooPromptAfterM19({
        bridge, info,
        originalCandidateCount: m19Optional.pool && m19Optional.pool.candidateCount || optionalPool.candidateCount,
        debugDir: path.join(routeDir, 'wait_bamboo'),
        skipRemainingOptionalCancel: true
      });
      bambooSelection = await selectBambooSearchTarget({
        bridge, info, library, templates,
        debugDir: path.join(routeDir, 'bamboo_search')
      });
      await sleep(1500);
    } else {
      await selectOptionalEffectById({
        bridge, info, library, templates,
        targetId: 'E10',
        debugDir: path.join(routeDir, 'zero_only_effect')
      });
      await sleep(450);
      zeroTarget = await selectPreferredSkyStrikerTarget({
        bridge, info, library, templates,
        debugDir: path.join(routeDir, 'zero_target')
      });
      await sleep(1500);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const finalState = runObserver({
    expectedAtomicActivationKey: equippedYoto ? 'M19' : 'E10'
  });
  const expectedGain = equippedYoto ? 2 : 1;
  if (finalState.handCount !== beforeResolution.handCount + expectedGain) {
    throw new Error(
      `V5_RAYE_ZERO_FINAL_HAND_DELTA_INVALID:${beforeResolution.handCount}->${finalState.handCount};expected=+${expectedGain}`
    );
  }

  const zeroGainId = zeroTarget && zeroTarget.selected && zeroTarget.selected.recognized && zeroTarget.selected.recognized.id || null;
  const bambooGainId = bambooSelection && bambooSelection.selected && bambooSelection.selected.id || null;

  if (zeroGainId && countId(finalState, zeroGainId) < countId(beforeResolution, zeroGainId) + 1) {
    throw new Error(`V5_RAYE_ZERO_TARGET_GAIN_NOT_CONFIRMED:${zeroGainId}`);
  }
  if (bambooGainId && countId(finalState, bambooGainId) < countId(beforeResolution, bambooGainId) + 1) {
    throw new Error(`V5_RAYE_ZERO_BAMBOO_GAIN_NOT_CONFIRMED:${bambooGainId}`);
  }

  console.log(
    `零衣->零梦 observer PASS: 手牌 ${beforeResolution.handCount}->${finalState.handCount}; ` +
    `零梦取得=${zeroGainId || 'UNKNOWN'}` +
    (equippedYoto ? `; 妖刀检索=${bambooGainId || 'UNKNOWN'}` : '')
  );

  return {
    state: finalState,
    route: equippedYoto ? 'RAYE_EFFECT_DIRECT_E10_WITH_YOTO' : 'RAYE_EFFECT_DIRECT_E10',
    swordMode: actualSwordMode,
    equippedYoto,
    zeroTargetId: zeroGainId,
    bambooGainId,
    routeDir
  };
}

async function normalSummonRaye({ state, debugDir }) {
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    let neutralActionFrame = null;
    const selected = await selectCurrentObservedHandCard({
      bridge,
      info,
      library,
      templates,
      baseline: state,
      expectedId: 'M06',
      debugDir: path.join(debugDir, 'raye_hand_target'),
      onBeforeSelect: async ({ bridge: targetBridge, info: targetInfo, clickReference }) => {
        // Capture only the action area at the existing neutral/reset boundary.
        // No second reset, full-client capture, or whole-hand identity scan.
        const roi = buildNormalSummonActionRoi(clickReference,
          { horizontalPadding: 230, topOffset: 270, bottomOffset: 50 });
        neutralActionFrame = { roi, image: await captureReferenceRoi(targetBridge, targetInfo, roi),
          clickReference, info: targetInfo };
      }
    });
    await clickRayeNormalSummonButton({
      bridge,
      info: neutralActionFrame ? neutralActionFrame.info : info,
      selectedReference: selected.clickReference,
      neutralActionFrame,
      debugDir: path.join(debugDir, 'raye_normal_summon')
    });
    await sleep(1700);
  } finally {
    await bridge.stop().catch(() => {});
  }
  const after = runObserver({ expectedAtomicActivationKey: 'M06' });
  if (after.handCount !== state.handCount - 1 || countId(after, 'M06') !== countId(state, 'M06') - 1) {
    throw new Error(`V5_RAYE_NORMAL_SUMMON_HAND_DELTA_INVALID:${state.handCount}->${after.handCount}`);
  }
  return after;
}

async function linkCarrierAndResolveYoto({
  carrier = null,
  targetLinkId,
  secondMaterial = null,
  debugDir,
  zeroRecoverId = null,
  dynamicCarrier = true
}) {
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  let bambooSelection = null;
  try {
    const extra = await clickExtraDeckSummonButton({ bridge, info, debugDir: path.join(debugDir, 'extra') });
    const prompt = await waitForSummonCandidates({ bridge, info, debugDir: path.join(debugDir, 'link_candidates') });
    const link = await selectSpecificLink({
      bridge,
      info,
      library,
      templates,
      promptProof: prompt,
      targetId: targetLinkId,
      carrierId: carrier && carrier.recognized && carrier.recognized.id || 'E02',
      debugDir: path.join(debugDir, 'select_link')
    });
    await clickBottomSummonSubmit({ bridge, info, debugDir: path.join(debugDir, 'link_submit') });

    let activeCarrier = carrier;
    if (dynamicCarrier) {
      // Re-locate the ACTUAL selectable carrier only after the game has entered
      // the Link-material window. This is the mature rule: do not carry a stale
      // pre-conversion x/y forward through M20 -> M19 animations.
      activeCarrier = await choosePreferredEquipCarrier({
        bridge,
        info,
        debugDir: path.join(debugDir, 'mat1_dynamic_carrier')
      });
      console.log(
        `Link素材动态重定位: ${activeCarrier.zoneName}; ` +
        `reference=(${Math.round(activeCarrier.reference.x)},${Math.round(activeCarrier.reference.y)}); ` +
        `source=${activeCarrier.source}`
      );
    }

    const carrierMode =
      activeCarrier && activeCarrier.kind === 'EXTRA_LINK' ? 'LINK' : 'GENERIC';
    const carrierRef =
      activeCarrier && (activeCarrier.clickReference || activeCarrier.reference);
    if (!carrierRef) throw new Error('V5_YOTO_CARRIER_REFERENCE_MISSING');

    await proveCarrierMaterialSelectable({
      bridge,
      info,
      anchorReference: carrierRef,
      carrierMode,
      debugDir: path.join(debugDir, 'mat1')
    });
    await clickCarrierMaterial({
      bridge,
      info,
      anchorReference: carrierRef,
      carrierMode,
      debugDir: path.join(debugDir, 'mat1')
    });
    await clickMaterialBlueConfirm({
      bridge,
      info,
      anchorReference: carrierRef,
      debugDir: path.join(debugDir, 'mat1_confirm')
    });

    if (secondMaterial) {
      await sleep(550);
      await proveCarrierMaterialSelectable({
        bridge,
        info,
        anchorReference: secondMaterial.reference,
        carrierMode: secondMaterial.mode || 'GENERIC',
        debugDir: path.join(debugDir, 'mat2')
      });
      await clickCarrierMaterial({
        bridge,
        info,
        anchorReference: secondMaterial.reference,
        carrierMode: secondMaterial.mode || 'GENERIC',
        debugDir: path.join(debugDir, 'mat2')
      });
      await clickMaterialBlueConfirm({
        bridge,
        info,
        anchorReference: secondMaterial.reference,
        debugDir: path.join(debugDir, 'mat2_confirm')
      });
    }

    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(debugDir, 'post_link')
    });

    // Already verified R8 chain order:
    //   M19 = CL1
    //   E10 = CL2
    //   resolve E10 first (recover Engage), then resolve M19 Bamboo search.
    const m19Optional = await selectM19FromOptionalPool({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(debugDir, 'm19_optional')
    });

    let zeroOptional = null;
    let zeroRecovery = null;
    const isDoubleZero = targetLinkId === 'E10';

    if (isDoubleZero) {
      if (Number(optionalPool.candidateCount || 0) < 2) {
        throw new Error(
          `V5_ZERO_ROUTE_EXPECTED_DOUBLE_OPTIONAL_POOL:${optionalPool.candidateCount || 0}`
        );
      }

      await sleep(500);
      zeroOptional = await selectOptionalEffectById({
        bridge,
        info,
        library,
        templates,
        targetId: 'E10',
        debugDir: path.join(debugDir, 'zero_optional')
      });
      console.log('零梦[E10]已作为CL2发动；先处理零梦回收，再进入妖刀CL1检索。');

      await sleep(450);
      zeroRecovery = await selectPreferredSkyStrikerTarget({
        bridge,
        info,
        library,
        templates,
        debugDir: path.join(debugDir, 'zero_recovery'),
        preferredIds: zeroRecoverId ? [zeroRecoverId, 'M17', 'M22'] : ['M17', 'M22']
      });
      console.log(
        `零梦实际回收/检索已提交: ${zeroRecovery.selected.recognized.name}` +
        `[${zeroRecovery.selected.recognized.id}]；纯等待CL2结算后进入妖刀检索。`
      );
      await sleep(900);
    }

    await waitForBambooPromptAfterM19({
      bridge,
      info,
      originalCandidateCount: m19Optional.pool.candidateCount || optionalPool.candidateCount,
      debugDir: path.join(debugDir, 'wait_bamboo'),
      skipRemainingOptionalCancel: isDoubleZero
    });
    bambooSelection = await selectBambooSearchTarget({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(debugDir, 'bamboo_search')
    });
    await sleep(1500);
    return {
      extra,
      link,
      optionalPool,
      m19Optional,
      zeroOptional,
      zeroRecovery,
      bambooSelection
    };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runYotoContinuation({ state, doubleWithRaye = false }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), doubleWithRaye ? '02_yoto_double_zero' : '02_yoto_single_wind');
  ensureDir(routeDir);
  const equipped = await equipSwordFromHand({ state, cardId: 'M19', cardName: '妖刀竹光', debugDir: path.join(routeDir, 'equip_yoto') });
  let afterSetup = equipped.state;
  let secondMaterial = null;
  if (doubleWithRaye) {
    afterSetup = await normalSummonRaye({ state: afterSetup, debugDir: path.join(routeDir, 'raye') });
    secondMaterial = { reference: RAYE_MAIN_ANCHOR, mode: 'GENERIC', id: 'M06' };
  }
  const resolution = await linkCarrierAndResolveYoto({
    carrier: equipped.carrier,
    targetLinkId: doubleWithRaye ? 'E10' : 'E04',
    secondMaterial,
    zeroRecoverId: doubleWithRaye ? 'M17' : null,
    dynamicCarrier: true,
    debugDir: path.join(routeDir, 'link_and_search')
  });
  const finalState = runObserver({ expectedAtomicActivationKey: 'M19' });
  const expectedGain = doubleWithRaye ? 2 : 1;
  if (finalState.handCount !== afterSetup.handCount + expectedGain) {
    throw new Error(
      `V5_YOTO_FINAL_HAND_DELTA_INVALID:${afterSetup.handCount}->${finalState.handCount};` +
      `expected=+${expectedGain}`
    );
  }

  if (doubleWithRaye) {
    const beforeEngage = countId(afterSetup, 'M17');
    const afterEngage = countId(finalState, 'M17');
    if (afterEngage !== beforeEngage + 1) {
      throw new Error(`V5_ZERO_ENGAGE_RECOVERY_INVALID:M17:${beforeEngage}->${afterEngage}`);
    }
  }

  return {
    state: finalState,
    route: doubleWithRaye ? 'YOTO_RAYE_DOUBLE_ZERO' : 'YOTO_SINGLE_WIND',
    zeroRecovered:
      doubleWithRaye && resolution.zeroRecovery
        ? resolution.zeroRecovery.selected.recognized
        : null,
    bambooSearched: resolution.bambooSelection.selected,
    accounting: {
      usedAdd: doubleWithRaye ? ['M19', 'M06'] : ['M19'],
      usedRemove: doubleWithRaye ? ['M17'] : [],
      // Double-zero: M19 enters GY (+1), E10 returns Engage from GY (-1).
      graveSpellDelta: doubleWithRaye ? 0 : 1,
      bambooSwordEquipped: false,
      m19SearchUsed: true
    },
    routeDir
  };
}


async function convertEquippedTrueToYoto({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_true_to_yoto');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    const fieldM20 = await locateFieldM20({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'field_true')
    });
    await clickFieldM20Effect({
      bridge, info,
      fieldReference: fieldM20.reference,
      debugDir: path.join(routeDir, 'true_effect')
    });
    await completeM20FieldEffectToYotoTarget({
      bridge,
      info,
      library,
      templates,
      routeDir,
      expectedCarrierId: null,
      label: '真刀转妖刀'
    });
  } finally {
    await bridge.stop().catch(() => {});
  }
  await runM20FieldConversionLogCheck({ attempts: 4 });
  saveTrueRouteStage('M20_CONVERTED_TO_M19', { routeDir, handCount: state.handCount });
  return { state, route: 'M20_EQUIPPED_TO_M19_EQUIPPED', routeDir };
}

async function runEquippedYotoContinuation({ state, doubleWithRaye = false }) {
  const routeDir = path.join(
    ROUTE_ROOT,
    timestampId(),
    doubleWithRaye ? 'atomic_equipped_yoto_double_zero' : 'atomic_equipped_yoto_single_wind'
  );
  ensureDir(routeDir);
  const secondMaterial = doubleWithRaye
    ? { reference: RAYE_MAIN_ANCHOR, mode: 'GENERIC', id: 'M06' }
    : null;
  const resolution = await linkCarrierAndResolveYoto({
    carrier: null,
    targetLinkId: doubleWithRaye ? 'E10' : 'E04',
    secondMaterial,
    zeroRecoverId: null,
    dynamicCarrier: true,
    debugDir: path.join(routeDir, 'link_and_search')
  });
  const finalState = runObserver({ expectedAtomicActivationKey: 'M19' });
  const expectedGain = doubleWithRaye ? 2 : 1;
  if (finalState.handCount !== state.handCount + expectedGain) {
    throw new Error(
      `V5_EQUIPPED_YOTO_FINAL_HAND_DELTA_INVALID:${state.handCount}->${finalState.handCount};expected=+${expectedGain}`
    );
  }
  return {
    state: finalState,
    route: doubleWithRaye ? 'EQUIPPED_YOTO_RAYE_DOUBLE_ZERO' : 'EQUIPPED_YOTO_SINGLE_WIND',
    zeroRecovered: resolution.zeroRecovery ? resolution.zeroRecovery.selected.recognized : null,
    bambooSearched: resolution.bambooSelection.selected,
    accounting: {
      usedAdd: doubleWithRaye ? ['M06'] : [],
      usedRemove: doubleWithRaye && resolution.zeroRecovery ? [resolution.zeroRecovery.selected.recognized.id] : [],
      graveSpellDelta: doubleWithRaye ? 0 : 1,
      bambooSwordEquipped: false,
      m19SearchUsed: true
    },
    routeDir
  };
}

async function runTruePostConversionContinuation({ state, routeDir = null }) {
  const activeRouteDir =
    routeDir || path.join(ROUTE_ROOT, timestampId(), '02_true_post_conversion_single_wind');
  ensureDir(activeRouteDir);

  console.log(
    '\nV6真刀续接：M20->M19转换已经完成；' +
    '从当前场上实际妖刀carrier开始，不再要求M20仍在手牌。'
  );

  const resolution = await linkCarrierAndResolveYoto({
    carrier: null,
    targetLinkId: 'E04',
    secondMaterial: null,
    dynamicCarrier: true,
    debugDir: path.join(activeRouteDir, 'link_and_search')
  });

  const finalState = runObserver({ expectedAtomicActivationKey: 'M19' });
  if (finalState.handCount !== state.handCount + 1) {
    throw new Error(
      `V5_TRUE_POST_CONVERSION_FINAL_HAND_DELTA_INVALID:` +
      `${state.handCount}->${finalState.handCount};expected=+1`
    );
  }

  clearTrueRouteStage();

  return {
    state: finalState,
    route: 'TRUE_POST_CONVERSION_TO_YOTO_SINGLE_WIND',
    bambooSearched: resolution.bambooSelection.selected,
    accounting: {
      usedAdd: ['M20', 'M19'],
      graveSpellDelta: 2,
      bambooSwordEquipped: false,
      m19SearchUsed: true
    },
    routeDir: activeRouteDir
  };
}

async function runTrueContinuation({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), '02_true_to_yoto_single_wind');
  ensureDir(routeDir);
  saveTrueRouteStage('BEFORE_M20_EQUIP', {
    routeDir,
    handCount: state.handCount
  });

  const equipped = await equipSwordFromHand({
    state,
    cardId: 'M20',
    cardName: '真刀竹光',
    debugDir: path.join(routeDir, 'equip_true')
  });
  saveTrueRouteStage('M20_EQUIPPED', {
    routeDir,
    handCount: equipped.state.handCount
  });

  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    const fieldM20 = await locateFieldM20({
      bridge,
      info,
      library,
      templates,
      debugDir: path.join(routeDir, 'field_true')
    });
    await clickFieldM20Effect({
      bridge,
      info,
      fieldReference: fieldM20.reference,
      debugDir: path.join(routeDir, 'true_effect')
    });

    await completeM20FieldEffectToYotoTarget({
      bridge,
      info,
      library,
      templates,
      routeDir,
      expectedCarrierId: null,
      label: '真刀转妖刀'
    });
  } finally {
    await bridge.stop().catch(() => {});
  }

  // IMPORTANT: do NOT call the full incremental hand observer here.
  // M20 field effect is hand-neutral. The mature D4 route only checks the
  // right log for M20->GY + M19->FIELD, then immediately continues.
  await runM20FieldConversionLogCheck({ attempts: 4 });
  saveTrueRouteStage('M20_CONVERTED_TO_M19', {
    routeDir,
    handCount: equipped.state.handCount
  });

  return runTruePostConversionContinuation({
    state: equipped.state,
    routeDir
  });
}


// ============================================================================
// Formal V5 atomic field transitions
// One exported function below performs exactly ONE semantic transition:
// action -> immediate result proof -> return.  No function calls the next
// transition.  runtime/main-v6.js owns all scheduling through persisted v5Branch state.
// ============================================================================

async function runM20FieldEffectToDeckPromptAtomic({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_m20_effect_to_deck_prompt');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 T20-1：场上真刀竹光 -> 发动效果 -> 停在妖刀牌组选卡窗口。');
    console.log('本节点不选择妖刀、不选择装备对象。');
    console.log('============================================================');
    const fieldM20 = await locateFieldM20({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'field_true')
    });
    await clickFieldM20Effect({
      bridge, info,
      fieldReference: fieldM20.reference,
      debugDir: path.join(routeDir, 'true_effect')
    });
    const prompt = await waitForM19DeckPrompt({
      bridge, info,
      debugDir: path.join(routeDir, 'm19_deck_prompt')
    });
    console.log(`T20-1 PASS: 妖刀牌组选卡窗口已出现；candidates=${prompt.candidateCount || 'UNKNOWN'}。`);
    return { state, prompt, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runM20SelectYotoFromDeckAtomic({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_m20_select_yoto_from_deck');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 T20-2：当前妖刀牌组选卡窗口 -> 只选择妖刀竹光。');
    console.log('选择提交后立即返回；本节点不点击场上装备对象。');
    console.log('============================================================');
    const prompt = await waitForM19DeckPrompt({
      bridge, info,
      debugDir: path.join(routeDir, 'm19_deck_prompt')
    });
    const selected = await selectM19FromDeckPrompt({
      bridge, info, library, templates,
      promptProof: prompt,
      debugDir: path.join(routeDir, 'm19_from_deck')
    });
    await sleep(900);
    console.log('T20-2 PASS: 妖刀竹光[M19]已从牌组选择并提交；下一节点才处理装备对象。');
    return { state, prompt, selected, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runM20EquipSelectedYotoAtomic({
  state,
  expectedCarrierId = null,
  requiredCarrierKind = null
}) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_m20_equip_selected_yoto');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  let target = null;
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 T20-3：当前妖刀装备对象窗口 -> 选择真实carrier -> 蓝色确认。');
    console.log('本节点只闭环 M20送墓 + M19装备；不会继续Link。');
    console.log('============================================================');
    target = await clickPreferredEquipCarrier({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'm19_equip_target'),
      requiredKind: requiredCarrierKind,
      afterIdentityMs: 1000,
      label: '真刀转妖刀装备对象'
    });
    if (
      expectedCarrierId && target && target.recognized && target.recognized.accepted &&
      String(target.recognized.id || '') !== String(expectedCarrierId)
    ) {
      throw new Error(`V5_M20_ATOMIC_CARRIER_MISMATCH:${target.recognized.id};expected=${expectedCarrierId}`);
    }
    await clickObservedEquipConfirm({
      bridge, info,
      anchorReference: target.clickReference,
      debugDir: path.join(routeDir, 'm19_equip_confirm'),
      label: 'M19_from_M20_atomic_equip_confirm'
    });
    await sleep(1900);
  } finally {
    await bridge.stop().catch(() => {});
  }
  const proof = await runM20FieldConversionLogCheck({ attempts: 4 });
  console.log('T20-3 PASS: 右栏确认 M20送墓 + M19从牌组装备；手牌保持不变。');
  return { state, target, proof, routeDir };
}

async function runEquippedYotoLinkToOptionalAtomic({
  state,
  doubleWithRaye = false,
  equippedYoto = true,
  singleTargetLinkId = null,
  requiredCarrierKind = null,
  materialCarrierId = 'E02',
  equippedKagari = false,
  equippedYotoCount = 1,
  onOptionalPoolProven = null
}) {
  const requestedLinkId = doubleWithRaye ? 'E10' : String(singleTargetLinkId || '');
  const unequippedKagariGain = !doubleWithRaye && equippedYoto === false && requestedLinkId === 'E02' &&
    requiredCarrierKind === 'EXTRA_LINK' && ['E03', 'E04', 'E05'].includes(materialCarrierId);
  const kagariDual = equippedKagari === true && !doubleWithRaye && equippedYoto === true && requestedLinkId === 'E02' &&
    ((requiredCarrierKind === 'EXTRA_LINK' && ['E03', 'E04', 'E05'].includes(materialCarrierId)) ||
     (requiredCarrierKind === 'CENTRAL_MAIN' && materialCarrierId === 'TOKEN_SKY_STRIKER'));
  if (equippedKagari && !kagariDual) throw new Error('KAGARI_YOTO_DUAL_PREREQUISITE_INVALID:zero_input=1');
  if (![1, 2].includes(equippedYotoCount) || (equippedYotoCount === 2 && !kagariDual)) {
    throw new Error('MULTI_YOTO_LINK_UNSUPPORTED:zero_input=1');
  }
  if (!doubleWithRaye && requestedLinkId && !['E03', 'E04', 'E05'].includes(requestedLinkId) && !unequippedKagariGain && !kagariDual) {
    throw new Error(`V5_YOTO_SINGLE_LINK_TARGET_UNSUPPORTED:${requestedLinkId}`);
  }
  const routeDir = path.join(
    ROUTE_ROOT,
    timestampId(),
    `atomic_yoto_link_${(requestedLinkId || 'any_non_kagari').toLowerCase()}_to_optional`
  );
  ensureDir(routeDir);
  const expectedPoolCount = kagariDual ? equippedYotoCount + 1 : (doubleWithRaye && equippedYoto) ? 2 : 1;
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { observeAdjacentLogEventually } = require(path.join(ROOT, 'execution', 'core', 'branch-adjacent-observer'));
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log(
      doubleWithRaye
        ? equippedYoto
          ? 'V6原子节点 Y1D：妖刀carrier + 场上零衣 -> 双素材Link零梦 -> 停在双效果池。'
          : 'V6原子节点 R7-1：已有Link + 场上零衣 -> 双素材Link零梦 -> 停在零梦单效果池。'
        : kagariDual ? 'V6原子KD：带妖刀素材 -> Link篝 -> 停在妖刀/篝双效果池。'
        : unequippedKagariGain
          ? 'V6原子节点 G1：未装刀的非火刀 -> Link篝 -> 停在篝单效果池。'
          : 'V6原子节点 Y1：妖刀carrier -> 任意合法非火刀单素材Link -> 停在妖刀单效果池。'
    );
    console.log('本节点不发动任何可选效果。');
    console.log('============================================================');

    await clickExtraDeckSummonButton({ bridge, info, debugDir: path.join(routeDir, 'extra') });
    const prompt = await waitForSummonCandidates({ bridge, info, debugDir: path.join(routeDir, 'link_candidates') });
    const summonChoice = requestedLinkId
      ? await selectSpecificLink({
          bridge, info, library, templates,
          promptProof: prompt,
          targetId: requestedLinkId,
          carrierId: materialCarrierId,
          debugDir: path.join(routeDir, 'select_link')
        })
      : await selectNextLegalLink({
          bridge, info, library, templates,
          carrierId: materialCarrierId,
          promptProof: prompt,
          debugDir: path.join(routeDir, 'select_link'),
          excludedLinkIds: ALL_LINK_IDS.filter(id => !['E03', 'E04', 'E05'].includes(id))
        });
    const targetLinkId = String(summonChoice && summonChoice.selected && summonChoice.selected.id || '');
    const legalResultIds = doubleWithRaye ? ['E10'] : unequippedKagariGain || kagariDual ? ['E02'] : ['E03', 'E04', 'E05'];
    if (!legalResultIds.includes(targetLinkId)) {
      throw new Error(`V5_YOTO_LINK_ACTUAL_TARGET_INVALID:${targetLinkId || 'NONE'}`);
    }
    await clickBottomSummonSubmit({ bridge, info, debugDir: path.join(routeDir, 'link_submit') });

    await sleep(550);
    const activeCarrier = await choosePreferredEquipCarrier({
      bridge, info,
      debugDir: path.join(routeDir, 'mat1_dynamic_carrier'),
      requiredKind: requiredCarrierKind
    });
    const carrierMode = activeCarrier.kind === 'EXTRA_LINK' ? 'LINK' : 'GENERIC';
    const carrierRef = activeCarrier.reference;
    await proveCarrierMaterialSelectable({
      bridge, info,
      anchorReference: carrierRef,
      carrierMode,
      debugDir: path.join(routeDir, 'mat1')
    });
    await clickCarrierMaterial({
      bridge, info,
      anchorReference: carrierRef,
      carrierMode,
      debugDir: path.join(routeDir, 'mat1')
    });
    await clickMaterialBlueConfirm({
      bridge, info,
      anchorReference: carrierRef,
      debugDir: path.join(routeDir, 'mat1_confirm')
    });

    if (doubleWithRaye) {
      await sleep(550);
      await proveCarrierMaterialSelectable({
        bridge, info,
        anchorReference: RAYE_MAIN_ANCHOR,
        carrierMode: 'GENERIC',
        debugDir: path.join(routeDir, 'mat2_raye')
      });
      await clickCarrierMaterial({
        bridge, info,
        anchorReference: RAYE_MAIN_ANCHOR,
        carrierMode: 'GENERIC',
        debugDir: path.join(routeDir, 'mat2_raye')
      });
      await clickMaterialBlueConfirm({
        bridge, info,
        anchorReference: RAYE_MAIN_ANCHOR,
        debugDir: path.join(routeDir, 'mat2_confirm')
      });
    }

    await sleep(1000);
    const pool = await waitForPostLinkOptionalPool({
      bridge, info,
      debugDir: path.join(routeDir, 'post_link')
    });
    if (Number(pool && pool.candidateCount || 0) !== expectedPoolCount) {
      throw new Error(
        `V5_YOTO_ATOMIC_OPTIONAL_POOL_INVALID:${pool && pool.candidateCount || 0};expected=${expectedPoolCount}`
      );
    }

    if (unequippedKagariGain) buildUnequippedKagariGainProof(targetLinkId, pool);
    if (kagariDual) buildKagariYotoDualLinkProof(targetLinkId, pool, equippedYotoCount);

    // Link submission and material selection are irreversible.  Once the live
    // optional pool proves that resolution completed, persist a recovery-safe
    // checkpoint before the stricter right-log continuity check.  Otherwise a
    // log-only failure leaves M19_EQUIPPED saved and a retry replays the Link.
    if (typeof onOptionalPoolProven === 'function') {
      await onOptionalPoolProven({
        targetLinkId,
        expectedPoolCount,
        pool,
        routeDir
      });
    }

    // ISSUE-089: use the same LIVE_PASS resolution evidence as Y1R. The
    // selected non-fire Link was identified before submission, all material
    // confirms completed, and the live single optional pool proves resolution.
    // An auxiliary log check must not reject this completed physical atom.
    if (!doubleWithRaye) {
      const proof = kagariDual ? buildKagariYotoDualLinkProof(targetLinkId, pool, equippedYotoCount) : unequippedKagariGain
        ? buildUnequippedKagariGainProof(targetLinkId, pool)
        : buildYotoSingleLinkResolutionProof(targetLinkId, pool);
      console.log(`Y1 PASS: ${targetLinkId} Link与当前单效果池已确认；不重复验收旧右栏checkpoint。`);
      return { state, pool, proof, targetLinkId, routeDir };
    }

    const observed = await observeAdjacentLogEventually({
      bridge,
      label: doubleWithRaye ? 'YOTO_DOUBLE_E10_LINK_RESOLVED' : `YOTO_SINGLE_${targetLinkId}_LINK_RESOLVED`,
      expectedActivationKey: targetLinkId,
      expectedMode: 'new-or-extended',
      requiredDetails: [{ cardId: targetLinkId, roleIncludes: 'LINK_SUMMON' }],
      allowMergedDetailBlock: true,
      maxAttempts: 4,
      settleBeforeFirstMs: 250,
      retryWaitMs: 300
    });
    console.log(
      `Y1${doubleWithRaye ? 'D' : ''} PASS: ${targetLinkId} Link已确认；` +
      `optional=${expectedPoolCount}; backtrack=${observed.proof.upwardBacktrackSteps}`
    );
    return { state, pool, proof: observed.proof, targetLinkId, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

function buildKagariYotoDualLinkProof(targetLinkId, pool, equippedYotoCount = 1) {
  if (![1, 2].includes(equippedYotoCount) || targetLinkId !== 'E02' ||
      pool?.visible !== true || Number(pool.candidateCount) !== equippedYotoCount + 1) {
    throw new Error('KAGARI_YOTO_DUAL_LINK_NOT_PROVEN');
  }
  return { pass: true, expectedLinkId: 'E02', candidateCount: equippedYotoCount + 1,
    mode: equippedYotoCount === 2 ? 'LIVE_KAGARI_TWO_YOTO_TRIPLE_POOL' : 'LIVE_KAGARI_YOTO_DUAL_POOL' };
}

function buildUnequippedKagariGainProof(targetLinkId, pool) {
  if (targetLinkId !== 'E02' || !pool || pool.visible !== true || Number(pool.candidateCount) !== 1) {
    throw new Error('TRUE_BAMBOO_KAGARI_LINK_POOL_NOT_PROVEN');
  }
  return { mode: 'SELECTED_KAGARI_PLUS_CURRENT_SINGLE_OPTIONAL_POOL', expectedLinkId: 'E02', candidateCount: 1 };
}

function buildYotoSingleLinkResolutionProof(targetLinkId, pool) {
  const id = String(targetLinkId || '');
  if (!['E03', 'E04', 'E05'].includes(id)) {
    throw new Error(`V5_YOTO_SINGLE_LINK_RESOLUTION_ID_INVALID:${id || 'NONE'}`);
  }
  if (!pool || pool.visible !== true || Number(pool.candidateCount) !== 1) {
    throw new Error('V5_YOTO_SINGLE_LINK_RESOLUTION_POOL_NOT_PROVEN');
  }
  return {
    mode: 'SAVED_SELECTED_LINK_PLUS_CURRENT_YOTO_OPTIONAL_POOL',
    expectedLinkId: id,
    candidateCount: 1
  };
}

function semanticDetailRoles(detail) {
  return [detail && detail.rawType, detail && detail.type, detail && detail.role]
    .map(value => String(value || '').toUpperCase())
    .filter(Boolean);
}

function inferUniqueLinkSummonIdFromObservedBlock(observed, expectedLinkId = null) {
  const details = Array.isArray(observed && observed.rawBlock && observed.rawBlock.details)
    ? observed.rawBlock.details
    : [];
  const ids = [...new Set(details
    .filter(detail => semanticDetailRoles(detail).some(role => role.includes('LINK_SUMMON')))
    .map(detail => String(detail && detail.card && detail.card.id || ''))
    .filter(Boolean))];
  if (ids.length !== 1) {
    throw new Error(`V5_Y1R_LINK_RESULT_NOT_UNIQUE:${ids.join(',') || 'NONE'}`);
  }
  const actualLinkId = ids[0];
  if (expectedLinkId && actualLinkId !== String(expectedLinkId)) {
    throw new Error(`V5_Y1R_LINK_RESULT_MISMATCH:${actualLinkId};expected=${expectedLinkId}`);
  }
  return actualLinkId;
}

async function recoverYotoLinkResolvedOptionalAtomic({ state, expectedLinkId = null }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'recover_yoto_link_resolved_optional');
  ensureDir(routeDir);
  const { bridge, info } = await startBridge();
  const { observeAdjacentLogEventually } = require(path.join(ROOT, 'execution', 'core', 'branch-adjacent-observer'));
  try {
    console.log('\n============================================================');
    console.log(
      `V6恢复原子 Y1R：Link 已完成；只被动证明当前妖刀单效果池与右栏实际Link结果` +
      `${expectedLinkId ? `（保存目标=${expectedLinkId}）` : ''}。`
    );
    console.log('不会再次打开额外卡组、不会选择Link怪兽、不会点击当前可选效果。');
    console.log('============================================================');
    const pool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(routeDir, 'current_optional_pool')
    });
    if (Number(pool && pool.candidateCount || 0) !== 1) {
      throw new Error(`V5_Y1R_OPTIONAL_POOL_INVALID:${pool && pool.candidateCount || 0};expected=1`);
    }
    const savedLinkId = String(expectedLinkId || '');
    if (['E03', 'E04', 'E05'].includes(savedLinkId)) {
      const proof = buildYotoSingleLinkResolutionProof(savedLinkId, pool);
      console.log(
        `Y1R PASS：当前妖刀单效果池仍在，且不可逆提交前已保存实际Link ${savedLinkId}；` +
        '无需重复依赖右栏连续性，保持窗口不点击。'
      );
      return {
        state,
        pool,
        proof,
        targetLinkId: savedLinkId,
        routeDir
      };
    }
    const observed = await observeAdjacentLogEventually({
      bridge,
      label: 'YOTO_SINGLE_LINK_RESOLVED_RECOVERY',
      expectedActivationKey: expectedLinkId || '',
      expectedMode: 'new-or-extended',
      requiredDetails: [{ roleIncludes: 'LINK_SUMMON' }],
      allowMergedDetailBlock: true,
      maxAttempts: 2,
      settleBeforeFirstMs: 0,
      retryWaitMs: 300
    });
    const actualLinkId = inferUniqueLinkSummonIdFromObservedBlock(observed, expectedLinkId);
    console.log(`Y1R PASS：当前单效果池与实际Link ${actualLinkId} 均已证明；保持窗口不点击。`);
    return { state, pool, proof: observed.proof, targetLinkId: actualLinkId, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runYotoOptionalToBambooPromptAtomic({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_yoto_optional_to_bamboo_prompt');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 Y2：当前妖刀可选效果 -> 发动妖刀 -> 停在竹光检索窗口。');
    console.log('本节点不选择任何竹光。');
    console.log('============================================================');
    const m19Optional = await selectM19FromOptionalPool({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'm19_optional')
    });
    const prompt = await waitForBambooPromptAfterM19({
      bridge, info,
      originalCandidateCount: m19Optional.pool && m19Optional.pool.candidateCount || 1,
      debugDir: path.join(routeDir, 'wait_bamboo')
    });
    console.log('Y2 PASS: 妖刀效果已发动，竹光检索窗口已经稳定出现；未选择目标。');
    return { state, prompt, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function rebuildCurrentHandBaselineAtomic(label) {
  const { establishCurrentObserverBaseline } = require(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
  const { bridge, info } = await startBridge();
  try {
    console.log(`${label}: 多效果在同一事务内连续改变手牌；最终窗口关闭后执行一次完整当前手牌重建。`);
    return await establishCurrentObserverBaseline({
      bridge,
      info,
      outputDir: path.join(ROUTE_ROOT, timestampId(), 'atomic_final_full_resync')
    });
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runBambooPromptToResolvedAtomic({
  state,
  expectedGain = 1,
  zeroTargetId = null,
  zeroTargetSource = null,
  secondGainActivationKey = 'E10',
  onBambooSelected = null,
  targetBambooId = null,
  priorBambooGainIds = [],
  stopAtNextBamboo = false
}) {
  if (!['E10', 'E02'].includes(secondGainActivationKey) ||
      (secondGainActivationKey === 'E02' && (![2, 3].includes(expectedGain) || zeroTargetId !== 'M17' || zeroTargetSource !== 'GRAVE')) ||
      (expectedGain === 3 && (secondGainActivationKey !== 'E02' ||
        (stopAtNextBamboo ? targetBambooId !== 'M20' || priorBambooGainIds.length !== 0 :
          targetBambooId !== 'M14' || priorBambooGainIds.length !== 1 || priorBambooGainIds[0] !== 'M20'))) ||
      (stopAtNextBamboo && expectedGain !== 3)) {
    throw new Error('BAMBOO_DUAL_SECOND_GAIN_INVALID:zero_input=1');
  }
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_bamboo_prompt_to_resolved');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  let bambooSelection = null;
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 Y3：当前竹光检索窗口 -> 选择真实竹光 -> 提交 -> 结算验收。');
    console.log('============================================================');
    bambooSelection = await selectBambooSearchTarget({
      bridge, info, library, templates,
      targetId: targetBambooId,
      debugDir: path.join(routeDir, 'bamboo_search')
    });
    const selectedId = bambooSelection?.selected?.id || null;
    if (targetBambooId && selectedId !== targetBambooId) throw new Error('BAMBOO_FIXED_TARGET_NOT_PROVEN');
    if (typeof onBambooSelected === 'function') onBambooSelected({ bambooGainId: selectedId,
      bambooGainIds: [...priorBambooGainIds, selectedId] });
    await sleep(1600);
    if (stopAtNextBamboo) {
      await waitForBambooPromptAfterM19({ bridge, info, originalCandidateCount: 0,
        debugDir: path.join(routeDir, 'next_bamboo'), skipRemainingOptionalCancel: true });
      return { state, bambooGainId: selectedId, nextBambooPrompt: true, routeDir };
    }
  } finally {
    await bridge.stop().catch(() => {});
  }
  const bambooId = bambooSelection && bambooSelection.selected && bambooSelection.selected.id || null;
  if (!bambooId) throw new Error('V5_BAMBOO_ATOMIC_SELECTED_ID_MISSING');
  const finalState = expectedGain > 1
    ? await verifyKnownMultiGainAtomic({
      state,
      label: 'Y3/D4最终零点击验收',
      settleMs: 300,
      gains: [
        {
          id: zeroTargetId,
          activationKey: secondGainActivationKey,
          fromDeck: zeroTargetSource === 'DECK',
          reason: `${secondGainActivationKey}_TARGET_GAIN`
        },
        ...priorBambooGainIds.map(id => ({ id, activationKey: 'M19', fromDeck: true,
          reason: 'M19_BAMBOO_SEARCH_GAIN' })),
        {
          id: bambooId,
          activationKey: 'M19',
          fromDeck: true,
          reason: 'M19_BAMBOO_SEARCH_GAIN'
        }
      ]
    })
    // ISSUE-076: Y3 owns one complete atomic transaction. Its final observer
    // validates only the newly resolved bottom block and hand gain; it must not
    // scroll upward to reconstruct pre-Y3 Link/equip history.
    : runObserver({
      adjacentCheckpointOnly: true,
      expectedAtomicActivationKey: 'M19'
    });
  if (expectedGain <= 1 && zeroTargetId === 'M17' && zeroTargetSource === 'DECK') {
    commitKnownDeckExit(
      'M17',
      `E10_DECK_ENGAGE:${path.basename(path.dirname(routeDir))}:${path.basename(routeDir)}`,
      'E10_ENGAGE_GAIN_FROM_DECK'
    );
  }
  if (finalState.handCount !== state.handCount + expectedGain) {
    throw new Error(
      `V5_BAMBOO_ATOMIC_HAND_DELTA_INVALID:${state.handCount}->${finalState.handCount};expected=+${expectedGain}`
    );
  }
  if (bambooId && countId(finalState, bambooId) < countId(state, bambooId) + 1) {
    throw new Error(`V5_BAMBOO_ATOMIC_GAIN_NOT_CONFIRMED:${bambooId}`);
  }
  if (zeroTargetId && countId(finalState, zeroTargetId) < countId(state, zeroTargetId) + 1) {
    throw new Error(`V5_DUAL_ZERO_ATOMIC_GAIN_NOT_CONFIRMED:${zeroTargetId}`);
  }
  console.log(
    `Y3 PASS: observer手牌 ${state.handCount}->${finalState.handCount}; ` +
    `竹光=${bambooId || 'UNKNOWN'}${zeroTargetId ? `; 零梦目标=${zeroTargetId}` : ''}`
  );
  return { state: finalState, bambooGainId: bambooId, zeroTargetId, routeDir };
}

async function recoverClosedBambooPromptAtomic({
  state,
  expectedGain = 1,
  zeroTargetId = null,
  zeroTargetSource = null,
  secondGainActivationKey = 'E10',
  bambooGainId = null,
  bambooGainIds = []
}) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_closed_bamboo_prompt_recovery');
  ensureDir(routeDir);

  console.log('\n============================================================');
  console.log('V5恢复节点 D4R：竹光选择窗口已经消失，只验收结算结果。');
  console.log('本节点不会点击竹光候选、确认按钮或任何保存坐标。');
  console.log('============================================================');
  console.log('D4R先纯等待3000ms越过固定结算动画，再重建当前真实手牌。');
  await sleep(3000);

  if (secondGainActivationKey === 'E02') {
    const ids = expectedGain === 3 ? bambooGainIds : [bambooGainId];
    if (![2, 3].includes(expectedGain) || zeroTargetId !== 'M17' || zeroTargetSource !== 'GRAVE' ||
        (expectedGain === 3 ? ids.length !== 2 || ids[0] !== 'M20' || ids[1] !== 'M14' :
          !['M20', 'M14'].includes(bambooGainId))) throw new Error('KAGARI_DUAL_CLOSED_GAIN_PROOF_MISSING:zero_input=1');
    const finalState = await verifyKnownMultiGainAtomic({ state, label: 'KD4R最终零点击验收', gains: [
      { id: 'M17', activationKey: 'E02', fromDeck: false, reason: 'E02_TARGET_GAIN' },
      ...ids.map(id => ({ id, activationKey: 'M19', fromDeck: true, reason: 'M19_BAMBOO_SEARCH_GAIN' }))
    ] });
    return { state: finalState, bambooGainId, zeroTargetId, routeDir, recoveredClosedPrompt: true };
  }

  const finalState = await rebuildCurrentHandBaselineAtomic('D4R窗口消失后的最终验收');
  if (zeroTargetId === 'M17' && zeroTargetSource === 'DECK') {
    commitKnownDeckExit(
      'M17',
      `E10_DECK_ENGAGE_RECOVERY:${path.basename(path.dirname(routeDir))}:${path.basename(routeDir)}`,
      'E10_ENGAGE_GAIN_FROM_DECK'
    );
  }
  const expectedCount = state.handCount + expectedGain;
  if (finalState.handCount !== expectedCount) {
    throw new Error(
      `V5_CLOSED_BAMBOO_RECOVERY_HAND_DELTA_INVALID:${state.handCount}->${finalState.handCount};` +
      `expected=+${expectedGain};未证明结算完成，禁止提交状态`
    );
  }

  if (zeroTargetId && countId(finalState, zeroTargetId) < countId(state, zeroTargetId) + 1) {
    throw new Error(`V5_CLOSED_BAMBOO_RECOVERY_ZERO_GAIN_NOT_CONFIRMED:${zeroTargetId}`);
  }

  const bambooId = ['M20', 'M14'].find(
    id => countId(finalState, id) >= countId(state, id) + 1
  ) || null;
  if (!bambooId) {
    throw new Error('V5_CLOSED_BAMBOO_RECOVERY_BAMBOO_GAIN_NOT_CONFIRMED:M20|M14');
  }

  console.log(
    `D4R PASS: observer手牌 ${state.handCount}->${finalState.handCount}; ` +
    `竹光=${bambooId}${zeroTargetId ? `; 零梦目标=${zeroTargetId}` : ''}; 全程未点击已消失窗口。`
  );
  return { state: finalState, bambooGainId: bambooId, zeroTargetId, routeDir, recoveredClosedPrompt: true };
}

async function runDualSelectM19CL1Atomic({ state, onM19Selected = null, expectedRemaining = 1, chainLink = 1 }) {
  if (![1, 2].includes(expectedRemaining) || ![1, 2].includes(chainLink) ||
      (chainLink === 2 && expectedRemaining !== 1)) throw new Error('M19_OPTIONAL_COUNT_INVALID:zero_input=1');
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_dual_select_m19_cl1');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log(`V6原子节点：${expectedRemaining + 1}效果池 -> 只选择妖刀竹光作为CL${chainLink}。`);
    console.log('本节点不选择第二个效果。');
    console.log('============================================================');
    const selected = await selectM19FromOptionalPool({
      bridge, info, library, templates,
      expectedPoolCount: expectedRemaining + 1,
      debugDir: path.join(routeDir, 'm19_cl1')
    });
    if (typeof onM19Selected === 'function') onM19Selected({ selected, routeDir });
    console.log('D1提交完成：先纯等待500ms越过可选效果池收缩动画，再开始稳定检查。');
    await sleep(500);
    let remaining = null;
    const started = Date.now();
    let sample = 0;
    while (Date.now() - started < 6000) {
      sample += 1;
      remaining = await waitOptionalPool({
        bridge, info,
        debugDir: path.join(routeDir, `remaining_optional_${String(sample).padStart(2, '0')}`),
        timeoutMs: 1200
      });
      if (Number(remaining.candidateCount || 0) === expectedRemaining) break;
      console.log(
        `D1提交后仍看到${remaining.candidateCount || 0}个旧候选：视为界面过渡帧，继续纯等待，不再点击。`
      );
      await sleep(250);
    }
    if (Number(remaining.candidateCount || 0) !== expectedRemaining) {
      throw new Error(`V5_D1_REMAINING_OPTIONAL_NOT_SINGLE:${remaining.candidateCount || 0}`);
    }
    console.log(`D1 PASS: 妖刀[M19]已提交为CL${chainLink}；剩余${expectedRemaining}个可选效果，未点击。`);
    return { state, selected, remaining, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runDualSelectE10CL2ToTargetPromptAtomic({ state, secondEffectId = 'E10', onSecondSelected = null, chainLink = 2 }) {
  if (!['E10', 'E02'].includes(secondEffectId)) throw new Error('DUAL_SECOND_EFFECT_UNSUPPORTED:zero_input=1');
  if (![2, 3].includes(chainLink) || (chainLink === 3 && secondEffectId !== 'E02')) throw new Error('OPTIONAL_CHAIN_LINK_INVALID:zero_input=1');
  const routeDir = path.join(ROUTE_ROOT, timestampId(), `atomic_dual_select_${secondEffectId.toLowerCase()}_cl2`);
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  const secondName = secondEffectId === 'E02' ? '火刀' : '零梦';
  try {
    console.log('\n============================================================');
    console.log(`V6原子节点 D2：剩余${secondName}效果 -> 提交为CL${chainLink} -> 停在目标窗口。`);
    console.log(`本节点不选择${secondName}目标。`);
    console.log('============================================================');
    const selected = await selectOptionalEffectById({
      bridge, info, library, templates,
      targetId: secondEffectId,
      expectedPoolCount: 1,
      debugDir: path.join(routeDir, `${secondEffectId.toLowerCase()}_cl2`),
      onSubmitted: typeof onSecondSelected === 'function'
        ? selected => onSecondSelected({ ...selected, routeDir }) : null
    });
    console.log(`D2提交完成：先纯等待3000ms，再检查${secondName}目标窗口。`);
    await sleep(3000);
    const prompt = await waitSkyTargetPrompt({
      bridge, info,
      debugDir: path.join(routeDir, `${secondEffectId.toLowerCase()}_target_prompt`)
    });
    const points = await waitForStableSkyTargetPoints({
      bridge, info,
      debugDir: path.join(routeDir, `${secondEffectId.toLowerCase()}_target_prompt`),
      label: `CL${chainLink}${secondName}实际候选`
    });
    console.log(`D2 PASS: ${secondName}[${secondEffectId}]已提交为CL${chainLink}；目标窗口稳定，physical=${points.length}；未选择目标。`);
    return { state, selected, prompt, points, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runDualE10TargetToBambooPromptAtomic({ state, secondEffectId = 'E10', onTargetSelected = null }) {
  if (!['E10', 'E02'].includes(secondEffectId)) throw new Error('DUAL_SECOND_EFFECT_UNSUPPORTED:zero_input=1');
  const routeDir = path.join(ROUTE_ROOT, timestampId(), `atomic_dual_${secondEffectId.toLowerCase()}_target_to_bamboo_prompt`);
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log(`V6原子节点 D3：当前${secondEffectId === 'E02' ? '火刀回收' : '零梦'}目标窗口 -> 选择实际目标 -> 停在妖刀竹光检索窗口。`);
    console.log('本节点不选择竹光。');
    console.log('============================================================');
    const zeroTarget = secondEffectId === 'E02' ? await selectKagariRecoveryTarget({
      bridge, info, library, templates, targetId: 'M17',
      debugDir: path.join(routeDir, 'kagari_target')
    }) : await selectPreferredSkyStrikerTarget({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'zero_target'),
      engageSourcePolicy: currentE10EngageSourcePolicy(library, state)
    });
    const zeroTargetId = zeroTarget && zeroTarget.selected && zeroTarget.selected.recognized && zeroTarget.selected.recognized.id || null;
    if (secondEffectId === 'E02' && zeroTargetId !== 'M17') throw new Error('DUAL_KAGARI_RECOVERY_TARGET_NOT_PROVEN');
    if (typeof onTargetSelected === 'function') onTargetSelected({ zeroTargetId, routeDir });
    await sleep(900);
    const prompt = await waitForBambooPromptAfterM19({
      bridge, info,
      originalCandidateCount: 2,
      debugDir: path.join(routeDir, 'wait_bamboo'),
      skipRemainingOptionalCancel: true
    });
    console.log(`D3 PASS: ${secondEffectId}目标=${zeroTargetId || 'UNKNOWN'}已提交；逆序结算已进入妖刀检索窗口。`);
    return {
      state,
      zeroTargetId,
      zeroTargetSource: secondEffectId === 'E02' ? 'GRAVE' : (zeroTarget.selectedSource || null),
      zeroTarget,
      prompt,
      routeDir
    };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runRayeEffectToE10OptionalAtomic({ state, equippedYoto = false, onE10Selected = null }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), equippedYoto ? 'atomic_raye_e10_dual_optional' : 'atomic_raye_e10_optional');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log(
      equippedYoto
        ? 'V6原子节点 R1D：带妖刀零衣发动自身效果 -> 直出零梦 -> 停在双效果池。'
        : 'V6原子节点 R1：零衣发动自身效果 -> 直出零梦 -> 停在零梦单效果池。'
    );
    console.log('本节点不发动妖刀/零梦的可选效果。');
    console.log('============================================================');
    const raye = await locateFieldRaye({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'field_raye')
    });
    await clickFieldRayeEffect({
      bridge, info,
      fieldReference: raye.reference,
      debugDir: path.join(routeDir, 'raye_effect')
    });
    await sleep(650);
    const prompt = await waitForSummonCandidates({
      bridge, info,
      debugDir: path.join(routeDir, 'zero_candidates')
    });
    await selectSpecificLink({
      bridge, info, library, templates,
      promptProof: prompt,
      targetId: 'E10',
      carrierId: 'M06',
      debugDir: path.join(routeDir, 'select_zero')
    });
    if (typeof onE10Selected === 'function') {
      onE10Selected({ equippedYoto, routeDir });
    }
    await submitRayeExtraSelection({ bridge, info, debugDir: path.join(routeDir, 'zero_submit') });
    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge, info,
      debugDir: path.join(routeDir, 'optional_pool')
    });
    const expected = equippedYoto ? 2 : 1;
    if (Number(optionalPool.candidateCount || 0) !== expected) {
      throw new Error(`V5_R1_OPTIONAL_POOL_INVALID:${optionalPool.candidateCount || 0};expected=${expected}`);
    }
    console.log(
      `R1${equippedYoto ? 'D' : ''} PASS: 零衣直出零梦完成；optional=${expected}; ` +
      '以当前可选效果池为原子提交证明，不再让后置右栏读取否定已经完成的召唤。'
    );
    return { state, optionalPool, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runSelectedRayeE10SubmitToOptionalAtomic({ state, equippedYoto = true }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_raye_e10_selected_submit_recovery');
  ensureDir(routeDir);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6恢复原子节点 R1S：零梦已在额外卡组窗口选中 -> 只提交“选择” -> 停在效果池。');
    console.log('本节点不重新发动零衣、不重新点击零梦候选、不发动任何可选效果。');
    console.log('============================================================');
    await submitRayeExtraSelection({
      bridge,
      info,
      debugDir: path.join(routeDir, 'zero_submit')
    });
    await sleep(1700);
    const optionalPool = await waitForPostLinkOptionalPool({
      bridge,
      info,
      debugDir: path.join(routeDir, 'optional_pool')
    });
    const expected = equippedYoto ? 2 : 1;
    if (Number(optionalPool.candidateCount || 0) !== expected) {
      throw new Error(`V5_R1S_OPTIONAL_POOL_INVALID:${optionalPool.candidateCount || 0};expected=${expected}`);
    }
    console.log(`R1S PASS: 已提交当前选中的零梦；optional=${expected}；未发动可选效果。`);
    return { state, optionalPool, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runE10OptionalToTargetPromptAtomic({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_e10_optional_to_target_prompt');
  ensureDir(routeDir);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const { bridge, info } = await startBridge();
  try {
    console.log('\n============================================================');
    console.log('V6原子节点 R2：当前零梦单效果池 -> 发动零梦 -> 停在目标窗口。');
    console.log('本节点不选择目标。');
    console.log('============================================================');
    const selected = await selectOptionalEffectById({
      bridge, info, library, templates,
      targetId: 'E10',
      debugDir: path.join(routeDir, 'e10_optional')
    });
    console.log('R2提交完成：按零梦效果动画时长先纯等待3000ms，再检查目标窗口。');
    await sleep(3000);
    const prompt = await waitSkyTargetPrompt({
      bridge, info,
      debugDir: path.join(routeDir, 'e10_target_prompt')
    });
    const points = await waitForStableSkyTargetPoints({
      bridge, info,
      debugDir: path.join(routeDir, 'e10_target_prompt'),
      label: '零梦实际候选'
    });
    console.log(`R2 PASS: 零梦效果已发动；目标窗口稳定，physical=${points.length}；未选择目标。`);
    return { state, selected, prompt, points, routeDir };
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function runE10TargetToResolvedAtomic({ state }) {
  const routeDir = path.join(ROUTE_ROOT, timestampId(), 'atomic_e10_target_to_resolved');
  ensureDir(routeDir);
  const runtime = readJsonIfExists(DECISION_STATE_PATH) || {};
  let receipt = runtime.v5Branch && runtime.v5Branch.e10SubmittedResolution;
  let target = receipt && receipt.targetProof || null;
  if (receipt) {
    if (receipt.version !== 1 || runtime.v5Branch.currentState !== 'E10_TARGET_PROMPT' ||
        !receipt.baseline || !target?.selected?.recognized?.accepted ||
        target.selected.recognized.id !== receipt.targetId) {
      throw new Error('V5_R3_SUBMITTED_CHECKPOINT_INVALID_NO_REPLAY');
    }
    if (state.revision === receipt.baseline.revision + 1) {
      const { verifyE10IncrementalResolution } = require('../../lib/e10-resolution-policy');
      const saved = verifyE10IncrementalResolution({ baseline: receipt.baseline,
        targetId: receipt.targetId, targetSource: receipt.targetSource,
        log: readJson(path.join(ROOT, 'debug/duel-log-live/latest_result.json')),
        incremental: readJson(path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json')),
        hand: state, ledger: readJson(path.join(ROOT, 'debug/main-deck-ledger/state.json')) });
      console.log('R3保存验收完成：仅核验已提交结果，不重选目标、不重跑observer。');
      return { ...saved, target, routeDir };
    }
    if (state.revision !== receipt.baseline.revision || state.handCount !== receipt.baseline.handCount ||
        JSON.stringify(state.cards.map(card => card.id)) !== JSON.stringify(receipt.baseline.cards.map(card => card.id))) {
      throw new Error('V5_R3_SUBMITTED_BASELINE_MISMATCH_NO_REPLAY');
    }
    console.log('R3目标已提交：只恢复正式observer验收，不再进入选择窗口。');
  } else {
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const { bridge, info } = await startBridge();
    try {
    console.log('\n============================================================');
    console.log('V6原子节点 R3：当前零梦目标窗口 -> 选择实际目标 -> 提交 -> observer验收入手。');
    console.log('============================================================');
    target = await selectPreferredSkyStrikerTarget({
      bridge, info, library, templates,
      debugDir: path.join(routeDir, 'zero_target'),
      engageSourcePolicy: currentE10EngageSourcePolicy(library, state)
    });
    const selected = target && target.selected && target.selected.recognized;
    if (!selected?.accepted || !/^M\d+$/.test(String(selected.id || ''))) {
      throw new Error('V5_R3_SUBMITTED_TARGET_IDENTITY_INVALID');
    }
    receipt = { version: 1, baseline: state, targetId: selected.id,
      targetSource: target.selectedSource || null, targetProof: target,
      submittedAt: new Date().toISOString(), routeDir };
    const current = readJsonIfExists(DECISION_STATE_PATH) || {};
    if (current.v5Branch?.currentState !== 'E10_TARGET_PROMPT') {
      throw new Error('V5_R3_SUBMITTED_RUNTIME_STAGE_CHANGED');
    }
    writeJsonAtomic(DECISION_STATE_PATH, { ...current,
      v5Branch: { ...current.v5Branch, e10SubmittedResolution: receipt } }, { trailingNewline: true });
    writeJson(path.join(routeDir, 'e10_submitted_checkpoint.json'), receipt);
    await sleep(1500);
    } finally {
      await bridge.stop().catch(() => {});
    }
  }
  const finalState = runObserver({
    expectedAtomicActivationKey: 'E10',
    e10TargetSource: target && target.selectedSource || null
  });
  const targetId = target && target.selected && target.selected.recognized && target.selected.recognized.id || null;
  if (finalState.handCount !== state.handCount + 1) {
    throw new Error(`V5_R3_HAND_DELTA_INVALID:${state.handCount}->${finalState.handCount};expected=+1`);
  }
  if (targetId && countId(finalState, targetId) < countId(state, targetId) + 1) {
    throw new Error(`V5_R3_TARGET_GAIN_NOT_CONFIRMED:${targetId}`);
  }
  console.log(`R3 PASS: observer手牌 ${state.handCount}->${finalState.handCount}; 零梦目标=${targetId || 'UNKNOWN'}。`);
  return {
    state: finalState,
    zeroTargetId: targetId,
    zeroTargetSource: target && target.selectedSource || null,
    target,
    routeDir
  };
}

module.exports = {
  runM20FieldEffectToDeckPromptAtomic,
  runM20SelectYotoFromDeckAtomic,
  runM20EquipSelectedYotoAtomic,
  runEquippedYotoLinkToOptionalAtomic,
  recoverYotoLinkResolvedOptionalAtomic,
  runYotoOptionalToBambooPromptAtomic,
  runBambooPromptToResolvedAtomic,
  recoverClosedBambooPromptAtomic,
  runDualSelectM19CL1Atomic,
  runDualSelectE10CL2ToTargetPromptAtomic,
  runDualE10TargetToBambooPromptAtomic,
  runRayeEffectToE10OptionalAtomic,
  runSelectedRayeE10SubmitToOptionalAtomic,
  runE10OptionalToTargetPromptAtomic,
  runE10TargetToResolvedAtomic,
  runHornetTokenToKagariLinkAtomic,
  runKagariEffectToRecoveryPromptAtomic,
  runKagariRecoveryCurrentPromptAtomic,
  runTokenToKagariRecover,
  resumeKagariRecoveryCurrentPrompt,
  recoverResolvedKagariAtomic,
  resumeSwordEquipTargetAtomic,
  dismissSelectedHandActionMenuAtomic,
  runYotoContinuation,
  runTrueContinuation,
  runTruePostConversionContinuation,
  resumeM20YotoEquipTargetCurrentPrompt,
  runRayeZeroDirect,
  equipSwordFromHand,
  normalSummonRaye,
  convertEquippedTrueToYoto,
  runEquippedYotoContinuation,
  loadTrueRouteStage,
  clearTrueRouteStage,
  TRUE_ROUTE_STATE_PATH
};
