'use strict';
const { assertNoNewHandClicks } = require('../../lib/incremental-observer-policy');

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { validateMasterDuelClient } = require('../../lib/live-client-guard');
const { absoluteComponentEstimate } = require('../../lib/live-hand-geometry');
const config = require('../../live-config');
const {
  MdFastBridge,
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { loadInfoDigitTemplates } = require('../../lib/hand-info-overlay');
const { readPng, savePng } = require('../../lib/png-utils');
const { runFastOwnAutoHold, runAutoHold } = require('./test-hand-info-live');
const {
  detectHandCountFromImage,
  getHandLayout,
  resolveExposedFanSlots
} = require('../../lib/hand-state');
const { recognizeCurrentCard } = require('./scan-state');
const {
  selectSingleHandOperation,
  inferIncrementalSlots,
  recoverTrueBambooDeckYotoKagariCompound,
  recoverPersistentLifecycleAcrossCheckpoint,
  reconcileKnownEffectExpectedCount,
  expectedHandCountFromOperation,
  buildPositionOnlyScenarios,
  resolveAmbiguousSlotsFromPassiveImages,
  inferPersistentExodiaAtSlot,
  commitInsertionsAtSlots
} = require('../../lib/incremental-hand-locator');
const { RunTimer } = require('../../lib/run-timer');
const { buildOperationFanProof } = require('../../lib/hand-count-proof');
const { validateMalletActivationStage } = require('../../lib/mallet-material-flow');
const { recognizeDenseTargetSlots } = require('./capture-hand-scroll-segments-live');
const { observeCompositeRoute } = require('../../lib/composite-route-observer');
const {
  EXODIA_UNKNOWN_ID,
  buildExodiaComponentSet,
  normalizeExodiaComponentCard,
  sameRuntimeCardIdentity
} = require('../../lib/exodia-policy');
const { isLegalBambooSearchTarget } = require('../../lib/bamboo-search-policy');

// PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_OBSERVER
const { applyIncrementalResultToMainDeckLedger } = require('../../lib/main-deck-ledger');
const { commitIncrementalObserverResult } = require('../../lib/incremental-observer-transaction');
const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'hand-change-live');
const STATE_PATH = path.join(DEBUG_DIR, 'session_state.json');
const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const COMPOSITE_STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const PERSISTENT_EXODIA_IDS = buildExodiaComponentSet();
const CLI_VERBOSE = process.argv.includes('--verbose');
const EXODIA_VICTORY_RISK = process.env.MD_V5_EXODIA_VICTORY_RISK === '1';

function writeNoChangeIncrementalResult(state, mode, reason, extra = {}) {
  const incrementalResultPath = path.join(DEBUG_DIR, 'latest_incremental_result.json');
  const incrementalResult = {
    status: 'PASS',
    mode,
    reason,
    capturedAt: new Date().toISOString(),
    before: state,
    after: state,
    inference: {
      activationKey: null,
      consumed: null,
      costConsumed: [],
      addedCount: 0,
      predictedSlots: []
    },
    insertedCards: [],
    finalClicks: [],
    recognitionTimings: [],
    ...extra
  };
  writeJson(incrementalResultPath, incrementalResult);
  return incrementalResultPath;
}

function validateClient(info) {
  return validateMasterDuelClient(info, {
    requireTitle: true,
    errorMessage: 'MASTER_DUEL_CLIENT_NOT_SAFE'
  });
}

function resolveSlotForPhysicalClick(count, slotNumber, detected) {
  const layout = getHandLayout(count);
  const estimate = absoluteComponentEstimate(detected);
  const resolved = resolveExposedFanSlots(layout, estimate);
  if (resolved.source === 'FIXED_FAN_GEOMETRY' || resolved.slots.length !== count) {
    throw new Error(`HAND_LIVE_LAYOUT_UNCERTAIN: components=${estimate ? estimate.count : 0}`);
  }
  const slot = resolved.slots[slotNumber - 1];
  if (!slot) throw new Error(`HAND_SLOT_NOT_FOUND:${slotNumber}/${count}`);
  return { ...slot, source: resolved.source, liveComponentCount: estimate ? estimate.count : 0 };
}

async function neutralResetForHandGeometry(bridge, info) {
  const safeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
  const safePoint = mapReferencePoint(info, safeRef);
  await bridge.click(safePoint.x, safePoint.y);
  await sleep(config.handFan.slotResetClickSettleMs);
  await bridge.key('ESC');
  await sleep(config.handFan.slotResetSettleMs);
}

async function locateSlotWithoutHandClick(bridge, info, count, slotNumber) {
  await neutralResetForHandGeometry(bridge, info);
  const image = await captureReferenceRoi(bridge, info, config.handFan.detectRoi);
  const detected = detectHandCountFromImage(image, count);
  return resolveSlotForPhysicalClick(count, slotNumber, detected);
}


function knownGainEffectLabel(activationKey, addedCount) {
  if (activationKey === 'M12' && addedCount === 2) return '抵价交易：发动卡+8星cost离手后抽2';
  if (activationKey === 'M14' && addedCount === 2) return '金黄色的竹光：发动卡离手后抽2';
  if (activationKey === 'M17' && addedCount === 2) return '闪刀起动－交闪：检索1+追加抽1';
  if (activationKey === 'M17' && addedCount === 1) return '闪刀起动－交闪：仅检索1';
  return null;
}

function strongCertainInsertion(inference, slot) {
  const row = (inference && inference.certainNewCardsBySlot || [])
    .find(item => item && item.slot === slot && item.card);
  if (!row || !row.card || !/^M\d+$/.test(String(row.card.id || ''))) return null;
  return row.card;
}

async function recoverCertainDenseInsertionByNeighborProbe(options = {}) {
  const {
    bridge, info, library, templates, handCount, semanticSlot, expectedCard, outputDir, stepPx
  } = options;
  if (!expectedCard || !expectedCard.id || !Number.isInteger(semanticSlot)) return null;

  // 11/12-card fans can shift one physical card when a new card is inserted in
  // the middle.  The semantic slot inferred from old-hand continuity remains
  // correct, but the targeted geometry may land on the old neighbour.  Before
  // paying the cost of a full DENSE rescan, probe only the two adjacent
  // physical slots and require the right-log-certain card name to match.
  const probeSlots = [semanticSlot - 1, semanticSlot + 1]
    .filter(slot => slot >= 1 && slot <= handCount);

  for (const probeSlot of probeSlots) {
    try {
      const probe = await recognizeDenseTargetSlots({
        bridge,
        info,
        library,
        templates,
        handCount,
        targetSlots: [probeSlot],
        outputDir: path.join(outputDir, `neighbor_probe_${semanticSlot}_via_${probeSlot}`),
        stepPx
      });
      const row = probe && probe.success && Array.isArray(probe.recognized) && probe.recognized.length === 1
        ? probe.recognized[0]
        : null;
      if (!row || !row.card || !sameRuntimeCardIdentity(expectedCard, row.card)) continue;

      console.log(
        `高手牌新增槽位视觉邻位恢复 PASS: 语义槽位=${semanticSlot}; ` +
        `探测槽位=${probeSlot}; ${row.card.name}[${row.card.id}]。`
      );
      return { semanticSlot, probeSlot, row };
    } catch (error) {
      console.log(
        `高手牌新增槽位邻位探测未命中: 语义槽位=${semanticSlot}; ` +
        `探测槽位=${probeSlot}; ${error.message}`
      );
    }
  }
  return null;
}

function sameIdMultiset(left, right) {
  const canonical = id => normalizeExodiaComponentCard({ id: String(id) }).id;
  const a = (left || []).map(canonical).sort();
  const b = (right || []).map(canonical).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateDenseGainEvidence(inference, reconciliation) {
  const rows = inference && Array.isArray(inference.candidateRows) ? inference.candidateRows : [];
  const addedCount = Number(inference && inference.addedCount);
  if (!Number.isInteger(addedCount) || addedCount <= 0 || rows.length !== addedCount) return;
  if (!rows.every(row => Array.isArray(row) && row.length === 1 && row[0] && row[0].id)) return;
  const expectedIds = rows.map(row => row[0].id);
  const actualIds = (reconciliation.insertedCards || []).map(item => item.card && item.card.id);
  if (!sameIdMultiset(expectedIds, actualIds)) {
    throw new Error(`DENSE_RIGHT_LOG_VISUAL_MISMATCH:${expectedIds.join(',')}/${actualIds.join(',')}`);
  }
}

function canCommitPureRemovalWithoutPassiveGeometry(inference, beforeCards, observedHandCount, operationExpectedCount) {
  if (!inference || inference.success !== true || inference.addedCount !== 0) return null;
  if (!Array.isArray(inference.remaining) || !Array.isArray(beforeCards)) return null;
  if (!Number.isInteger(observedHandCount) || !Number.isInteger(operationExpectedCount)) return null;
  if (observedHandCount !== operationExpectedCount || inference.remaining.length !== observedHandCount) return null;

  const removedCount = beforeCards.length - inference.remaining.length;
  const accountedRemoved = (inference.consumed ? 1 : 0) +
    (Array.isArray(inference.costConsumed) ? inference.costConsumed.length : 0);
  if (removedCount <= 0 || accountedRemoved !== removedCount) return null;

  return { removedCount, accountedRemoved };
}

// Raye's on-field self effect does not consume/add cards in the hand. In the
// current mature right-log recognizer, however, the summoned Extra Deck result
// can be rendered as HAND_GAIN_CANDIDATE rows inside a new M06 block. If Raye
// has already left the hand in a previous checkpoint, and this M06 block now
// exposes an E* result without a real LINK_SUMMON, treat the block as a field
// transition only. This deliberately avoids INFO reads, safe-point clicks and
// ESC presses, which are unnecessary for a hand-neutral field effect and could
// interfere with a just-resolved optional-effect prompt.
function detectRayeFieldEffectHandNeutral(state, block) {
  if (!block || String(block.activationKey || '') !== 'M06') return null;
  const handHasRaye = Array.isArray(state && state.cards) &&
    state.cards.some(card => String(card && card.id || '') === 'M06');
  if (handHasRaye) return null;

  const details = Array.isArray(block.details) ? block.details : [];
  const hasRealLink = details.some(detail => String(detail && detail.rawType || '') === 'LINK_SUMMON');
  const extraResult = details.find(detail => {
    const id = String(detail && detail.card && detail.card.id || '');
    return /^E\d+$/.test(id);
  });
  if (!extraResult || hasRealLink) return null;

  return {
    resultCardId: String(extraResult.card && extraResult.card.id || ''),
    resultCardName: String(extraResult.card && extraResult.card.name || ''),
    renderedRoles: details.map(detail => String(detail && detail.role || '')).filter(Boolean)
  };
}


function sanitizeR7FinalContinuationLog(log) {
  let compositeState = null;
  try {
    compositeState = readJson(COMPOSITE_STATE_PATH);
  } catch (_) {
    return { log, filtered: false, predecessorKey: null };
  }
  const current = compositeState && compositeState.current || {};
  const materialRows = current.material && Array.isArray(current.material.summoned)
    ? current.material.summoned
    : [];
  const materialModes = new Set(materialRows.map(item => String(item && item.mode || '').toUpperCase()));
  const hasPreexisting = materialModes.has('PREEXISTING_LINK');
  const predecessorKey = materialModes.has('RAYE_NORMAL_SUMMON')
    ? 'M06'
    : materialModes.has('HORNET_TOKEN')
      ? 'M22'
      : null;
  const target = current.targetSelection || {};
  const active = current.activeEffect || {};
  const targetMode = String(target.effectMode || '').toUpperCase();
  const targetStatus = String(target.status || '').toUpperCase();
  const activeMode = String(active.mode || '').toUpperCase();
  const finalMonsterSelection = hasPreexisting && predecessorKey &&
    targetMode === 'MONSTER_OPTIONAL' &&
    ['SUBMITTED', 'AVAILABLE', 'PENDING', 'RESOLVED'].includes(targetStatus) &&
    activeMode === 'MONSTER_OPTIONAL';
  if (!finalMonsterSelection) return { log, filtered: false, predecessorKey: null };

  const newBlocks = Array.isArray(log && (log.newOperationBlocks || log.newActivationBlocks))
    ? (log.newOperationBlocks || log.newActivationBlocks)
    : [];
  const extendedBlocks = Array.isArray(log && log.extendedOperationBlocks)
    ? log.extendedOperationBlocks
    : [];
  const hasE10 = [...newBlocks, ...extendedBlocks].some(block => String(block && block.activationKey || '') === 'E10');
  const hasRepeatedPredecessor = [...newBlocks, ...extendedBlocks].some(block => String(block && block.activationKey || '') === predecessorKey);
  if (!hasE10 || !hasRepeatedPredecessor) return { log, filtered: false, predecessorKey: null };

  const filter = blocks => (Array.isArray(blocks) ? blocks : []).filter(block =>
    String(block && block.activationKey || '') !== predecessorKey
  );
  const sanitized = {
    ...log,
    newOperationBlocks: filter(log.newOperationBlocks || log.newActivationBlocks),
    newActivationBlocks: filter(log.newActivationBlocks || log.newOperationBlocks),
    extendedOperationBlocks: filter(log.extendedOperationBlocks)
  };
  return { log: sanitized, filtered: true, predecessorKey };
}

async function runIncrementalHandChange(options = {}) {
  const VERBOSE = options.verbose != null ? Boolean(options.verbose) : CLI_VERBOSE;
  const startedNs = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const timer = new RunTimer('hand-change-incremental', path.join(ROOT, 'debug', 'performance'), {
    startedNs,
    startedAt
  });
  let status = 'FAIL';
  const { state, log } = timer.timeSync('load_previous_state_and_log', () => ({
    state: readJson(STATE_PATH),
    log: readJson(LOG_RESULT_PATH)
  }));
  const blocks = log.operationBlocks || log.activationBlocks || [];
  const sanitizedR7 = sanitizeR7FinalContinuationLog(log);
  const effectiveLog = sanitizedR7.log;
  const newBlocks = effectiveLog.newOperationBlocks || effectiveLog.newActivationBlocks || [];
  if (sanitizedR7.filtered) {
    console.log(
      `R7相邻前驱去重: 当前最终零罗检索仍带出已在上一步结算过的 ${sanitizedR7.predecessorKey}；` +
      '该前驱不再重复计入手牌交易，只处理当前E10结算。'
    );
  }

  // Flowchart-style composite route observer. This is deliberately a sidecar
  // above the sealed V1 right-log/hand recognition: it consumes only the
  // already-recognized new operation blocks, persists its own route state, and
  // never changes the hand transaction result. The old mature reconciliation
  // remains active while we live-compare the two interpretations.
  const compositeRoute = timer.timeSync('observe_composite_route', () =>
    observeCompositeRoute(effectiveLog, { rootDir: ROOT, beforeHand: state.cards })
  );
  if (compositeRoute.appliedEvents > 0) {
    const summary = compositeRoute.summary;
    console.log(
      `复合支线观察: phase=${summary.phase}; ` +
      `素材来源=${summary.materialSources && summary.materialSources.length ? summary.materialSources.join('+') : '无新增'}; ` +
      `素材=${summary.material.length ? summary.material.join('+') : '无新增'}; ` +
      `装刀=${summary.equip}; 离场=${summary.exit}; 新怪兽=${summary.summon}; ` +
      `后处理=${summary.postEffects.length ? summary.postEffects.join(' + ') : '无'}`
    );
    console.log(`复合支线详情: ${compositeRoute.resultPath}`);
  }
  if (!newBlocks.length) {
    status = 'PASS';
    const resultPath = writeNoChangeIncrementalResult(
      state,
      'NO_NEW_OPERATION',
      'NO_NEW_OPERATION',
      { sourceLogCapturedAt: log.capturedAt || null }
    );
    console.log('没有检测到尚未处理的新操作；不读取 i，不点击手牌，不修改状态。');
    console.log(`已写入本轮空增量结果，禁止复用上一轮残留结果: ${resultPath}`);
    timer.finish({ status, reason: 'NO_NEW_OPERATION' });
    console.log(`TIMING ${timer.summary()}`);
    return;
  }
  const handOperation = selectSingleHandOperation(state.cards, newBlocks, {
    runtime: fs.existsSync(path.join(ROOT, 'decision-state.json'))
      ? readJson(path.join(ROOT, 'decision-state.json')) : {},
    expectedAtomicActivationKey: String(process.env.MD_V5_EXPECTED_ATOMIC_ACTIVATION || '')
  });
  if (handOperation.reason === 'MULTIPLE_HAND_OPERATIONS_REQUIRE_SEQUENTIAL_RECONCILIATION') {
    const relevant = handOperation.relevant.map(item =>
      `${item.block.activation && item.block.activation.card && item.block.activation.card.name || item.block.activationKey || '未知操作'}[${item.block.activationKey || '?'}]`
    );
    throw new Error(`${handOperation.reason}:${relevant.join(' -> ')}`);
  }
  if (handOperation.reason === 'NO_HAND_AFFECTING_OPERATION') {
    status = 'PASS';
    const resultPath = writeNoChangeIncrementalResult(
      state,
      'NO_HAND_AFFECTING_OPERATION',
      handOperation.reason,
      { sourceLogCapturedAt: log.capturedAt || null }
    );
    console.log(`检测到 ${newBlocks.length} 个新增蓝色顶格块，但均无已证实的我方手牌增减；不读取 i、不点击手牌、手牌状态保持不变。`);
    console.log(`已写入本轮无手牌变化结果，禁止复用上一轮残留结果: ${resultPath}`);
    timer.finish({ status, reason: handOperation.reason });
    console.log(`TIMING ${timer.summary()}`);
    return;
  }
  let latestBlock = handOperation.operation;

  const rayeFieldEffect = detectRayeFieldEffectHandNeutral(state, latestBlock);
  if (rayeFieldEffect) {
    status = 'PASS';
    const resultPath = writeNoChangeIncrementalResult(
      state,
      'RAYE_FIELD_EFFECT_HAND_NEUTRAL',
      'M06_FIELD_EFFECT_EXTRA_RESULT_NO_HAND_CHANGE',
      {
        sourceLogCapturedAt: log.capturedAt || null,
        inference: {
          activationKey: 'M06',
          consumed: null,
          costConsumed: [],
          addedCount: 0,
          predictedSlots: []
        },
        rayeFieldEffect
      }
    );
    console.log(
      `零衣场上效果手牌中性处理: 零衣已不在手牌，本轮额外怪兽结果=` +
      `${rayeFieldEffect.resultCardName || rayeFieldEffect.resultCardId || '未知'}；` +
      '右栏伪 HAND_GAIN 不参与手牌数量计算。'
    );
    console.log('本轮不读取 INFO、不点击安全空白、不发送 ESC、不点击手牌；手牌状态保持不变。');
    console.log(`已写入零衣场上效果无手牌变化结果: ${resultPath}`);
    timer.finish({ status, reason: 'RAYE_FIELD_EFFECT_HAND_NEUTRAL' });
    console.log(`TIMING ${timer.summary()}`);
    return;
  }

  if (latestBlock.compoundOperations && latestBlock.compoundOperations.length > 1) {
    console.log(
      `复合结算合并: ${latestBlock.compoundOperations.map(block =>
        `${block.activation && block.activation.card && block.activation.card.name || block.activationKey}[${block.activationKey}]`
      ).join(' -> ')}`
    );
  }
  if (handOperation.ignoredFieldOperations.length) {
    const ignored = handOperation.ignoredFieldOperations.map(block =>
      `${block.activation && block.activation.card && block.activation.card.name || block.activationKey || '未知操作'}[${block.activationKey || '?'}]`
    );
    const current = latestBlock.activation && latestBlock.activation.card && latestBlock.activation.card.name ||
      latestBlock.activationKey || '未知操作';
    console.log(
      `检测到 ${newBlocks.length} 个新增蓝色顶格块：按手牌影响证据忽略 ${ignored.length} 个场面过程块（${ignored.join(' -> ')}）；` +
      `处理 ${current}[${latestBlock.activationKey || '?'}]。`
    );
  }

  // M11 (Magical Mallet) is intentionally staged in the full-duel observer.
  // Immediately after activation Master Duel is showing the return-to-deck
  // selection UI, where bottom-hand geometry and INFO count are not reliable.
  // Prove only the new M11 activation from the right log now. The next observer
  // run, after the user finishes the selection and the effect fully resolves,
  // performs a complete hand rescan instead of incremental slot inference.
  if (latestBlock.activationKey === 'M11') {
    const verified = timer.timeSync('mallet_activation_log_only', () =>
      validateMalletActivationStage(log)
    );
    const incrementalResultPath = path.join(DEBUG_DIR, 'latest_incremental_result.json');
    const incrementalResult = {
      status: 'PASS',
      mode: 'MALLET_ACTIVATION_PENDING_FULL_RESYNC',
      reason: 'M11_SELECTION_UI_LOG_ONLY',
      before: state,
      after: state,
      inference: {
        activationKey: 'M11',
        consumed: null,
        costConsumed: [],
        addedCount: 0,
        predictedSlots: []
      },
      insertedCards: [],
      finalClicks: [],
      recognitionTimings: [],
      pendingMallet: {
        activationKey: 'M11',
        beforeCount: state.handCount,
        activationSignature: verified.operation && verified.operation.signature || null,
        activationCapturedAt: new Date().toISOString()
      }
    };
    writeJson(incrementalResultPath, incrementalResult);
      applyIncrementalResultToMainDeckLedger({
        incrementalResult,
        log: effectiveLog
      });
    status = 'PASS';
    console.log('万宝槌特殊处理: 已确认 M11 发动。');
    console.log('当前为万宝槌选择/结算阶段：本轮不读取 i、不点击手牌、不修改手牌状态。');
    console.log('完成洗回选择并确认，等待抽牌全部结算、正常手牌扇形恢复后，再运行同一 observer 命令。');
    console.log(`完整增量详情: ${incrementalResultPath}`);
    timer.finish({ status, reason: incrementalResult.reason });
    console.log(`TIMING ${timer.summary()}`);
    return;
  }


  // M18 (Foolish Burial Goods / Nadir-style material route in this deck) is
  // also staged in the full-duel observer. Immediately after activation,
  // Master Duel is showing the Extra Deck selection UI and then Garura's
  // optional-effect prompt. Reading INFO here is unsafe because UI clicks can
  // dismiss/decline that prompt. Commit only the right-log M18 activation now;
  // defer the physical -M18 hand change until the full M18 -> E01 -> draw1
  // resolution has completed and the normal hand fan has returned.
  if (latestBlock.activationKey === 'M18') {
    const prematureGains = (latestBlock.details || []).filter(detail =>
      detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
    );
    if (prematureGains.length === 0) {
      const incrementalResultPath = path.join(DEBUG_DIR, 'latest_incremental_result.json');
      const incrementalResult = {
        status: 'PASS',
        mode: 'NADIR_ACTIVATION_PENDING_FULL_RESOLUTION',
        reason: 'M18_EXTRA_DECK_SELECTION_LOG_ONLY',
        before: state,
        after: state,
        inference: {
          activationKey: 'M18',
          consumed: null,
          costConsumed: [],
          addedCount: 0,
          predictedSlots: []
        },
        insertedCards: [],
        finalClicks: [],
        recognitionTimings: [],
        pendingNadir: {
          activationKey: 'M18',
          beforeCount: state.handCount,
          activationSignature: latestBlock.signature || null,
          activationCapturedAt: new Date().toISOString()
        }
      };
      writeJson(incrementalResultPath, incrementalResult);
      applyIncrementalResultToMainDeckLedger({
        incrementalResult,
        log: effectiveLog
      });
      status = 'PASS';
      console.log('愚蠢的重葬特殊处理: 已确认 M18 发动。');
      console.log('当前处于额外卡组选择 / 迦楼拉询问危险阶段：本轮不读取 i、不点击手牌、不修改手牌状态。');
      console.log('选择共命之翼 迦楼拉并发动其效果，等待抽1全部结算、正常手牌扇形恢复后，再运行同一 observer 命令。');
      console.log(`完整增量详情: ${incrementalResultPath}`);
      timer.finish({ status, reason: incrementalResult.reason });
      console.log(`TIMING ${timer.summary()}`);
      return;
    }
  }

  const resources = await timer.time('load_recognition_templates', async () => {
    const library = loadLibrary(ROOT);
    const templates = await loadTemplates(ROOT, library);
    const digitTemplates = loadInfoDigitTemplates(ROOT);
    return { library, templates, digitTemplates };
  });
  const { library, templates, digitTemplates } = resources;
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  if (ownsBridge) await timer.time('bridge_start', () => bridge.start());
  else timer.timeSync('bridge_reuse', () => null);
  try {
    const activation = options.skipActivation
      ? { info: await timer.time('reuse_verified_window', () => bridge.info()) }
      : await timer.time('activate_and_verify_window', () => activateAndVerifyMasterDuel(bridge));
    let info = activation.info;
    validateClient(info);
    let operationExpectedCount = expectedHandCountFromOperation(state.cards, latestBlock);

    info = await bridge.info();
    validateClient(info);
    const passiveSafeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
    const passiveSafePoint = mapReferencePoint(info, passiveSafeRef);
    await bridge.click(passiveSafePoint.x, passiveSafePoint.y);
    await sleep(config.handFan.slotResetClickSettleMs);
    await bridge.key('ESC');
    await sleep(config.handFan.slotResetSettleMs);
    const passiveImage = await timer.time('capture_passive_hand', () =>
      captureReferenceRoi(bridge, info, config.handFan.detectRoi)
    );
    const nextRevision = Number(state.revision || 0) + 1;
    const passivePath = path.join(DEBUG_DIR, `revision_${nextRevision}`, 'passive_hand.png');
    fs.mkdirSync(path.dirname(passivePath), { recursive: true });
    await savePng(passiveImage, passivePath);
    let passiveDetected;
    let passiveEstimate;
    let operationFanProof;
    let expectedFanCandidate;
    let expectedLiveLayout;
    const refreshPassiveProof = () => {
      passiveDetected = detectHandCountFromImage(passiveImage, operationExpectedCount);
      passiveEstimate = passiveDetected.componentEstimate;
      operationFanProof = buildOperationFanProof({
        beforeCount: state.cards.length,
        operationExpectedCount,
        passiveDetected,
        latestBlock
      });
      expectedFanCandidate = operationFanProof.expectedFanCandidate;
      expectedLiveLayout = Number.isInteger(operationExpectedCount)
        ? resolveExposedFanSlots(getHandLayout(operationExpectedCount), absoluteComponentEstimate(passiveDetected))
        : null;
    };
    refreshPassiveProof();
    const compoundGainDetails = (latestBlock.details || []).filter(detail =>
      detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
    );
    const compoundGainIds = compoundGainDetails
      .map(detail => String(detail.card && detail.card.id || ''))
      .filter(Boolean);
    const compoundTargetIds = (latestBlock.details || [])
      .filter(detail => detail && detail.side === 'SELF' && detail.role === 'TARGET')
      .map(detail => String(detail.card && detail.card.id || ''))
      .filter(Boolean);
    const hasKagariRecoveryGain = compoundGainIds.some(id => id === 'M17' || id === 'M22');
    const hasYotoBambooGain = compoundGainIds.some(id => id === 'M20' || id === 'M14');
    const hasMatchingKagariTarget = compoundTargetIds.some(id =>
      (id === 'M17' || id === 'M22') && compoundGainIds.includes(id)
    );
    const explicitCompound = latestBlock.compoundType === 'KAGARI_RECOVERY_WITH_YOTO_SEARCH';
    const zeroDreamYotoCompound = [
      'ZERO_DIRECT_RECOVERY_WITH_YOTO_SEARCH',
      'ZERO_DIRECT_RECOVERY_WITH_YOTO_SEARCH_INFERRED_BAMBOO_COUNT'
    ].includes(String(latestBlock.compoundType || ''));
    const compressedKagariCompound =
      latestBlock.activationKey === 'E02' &&
      compoundGainDetails.length === 2 &&
      hasKagariRecoveryGain &&
      hasYotoBambooGain &&
      hasMatchingKagariTarget;
    const compoundHasTwoProvenGains =
      compoundGainDetails.length === 2 &&
      (explicitCompound || compressedKagariCompound || zeroDreamYotoCompound);
    // A freshly observed M19 operation with exactly one SELF HAND_GAIN of a
    // legal Bamboo target is already sufficient proof of Yoto search resolution.
    // Do NOT require composite-route targetSelection here: that legacy summary can
    // legitimately carry stale historical M19_SEARCH entries across split V5
    // transitions. The branch observer has already proven that latestBlock is the
    // current bottom-adjacent operation; the exact HAND_GAIN row closes the +1
    // hand delta without reopening INFO. This also avoids transient INFO overlays
    // during the post-search hand fan animation.
    const singleM19SearchGainProven = Boolean(
      latestBlock.activationKey === 'M19' &&
      compoundGainDetails.length === 1 &&
      isLegalBambooSearchTarget(compoundGainIds[0])
    );
    const singleE10SearchGainProven = Boolean(
      latestBlock.activationKey === 'E10' &&
      compoundGainDetails.length === 1 &&
      ['M17', 'M22'].includes(compoundGainIds[0]) &&
      compositeRoute && compositeRoute.summary &&
      compositeRoute.summary.targetSelection &&
      compositeRoute.summary.targetSelection.effectMode === 'MONSTER_OPTIONAL' &&
      ['SUBMITTED', 'RESOLVED'].includes(compositeRoute.summary.targetSelection.status)
    );
    const m20FieldToM19NoHandDeltaProven = Boolean(
      latestBlock.activationKey === 'M20' &&
      compoundGainDetails.length === 0 &&
      compositeRoute && compositeRoute.summary &&
      compositeRoute.summary.equip === 'M20_FIELD_TO_M19' &&
      Number.isInteger(operationExpectedCount) &&
      operationExpectedCount === state.handCount
    );
    if (compressedKagariCompound && !explicitCompound) {
      console.log(
        `复合结算压缩块恢复: 右栏把妖刀检索并入闪刀姬－篝[E02]；` +
        `已从TARGET+双HAND_GAIN确认 ${compoundGainIds.join(' + ')}，按旧成熟复合路径处理。`
      );
    }
    let compoundVisualCountConfirmed = Boolean(
      compoundHasTwoProvenGains && Number.isInteger(operationExpectedCount) &&
      expectedFanCandidate && expectedFanCandidate.valid && passiveEstimate && (
        passiveEstimate.count === operationExpectedCount ||
        (passiveEstimate.count === operationExpectedCount - 1 && expectedLiveLayout &&
          String(expectedLiveLayout.source || '').startsWith('TITLE_COMPONENTS_INFERRED_'))
      )
    );
    let infoOutput;
    let infoHandCount;
    let infoReadMode = 'FAST_OWN_INFO';

    if ((compoundHasTwoProvenGains || singleM19SearchGainProven || singleE10SearchGainProven || m20FieldToM19NoHandDeltaProven) && Number.isInteger(operationExpectedCount)) {
      // When the settled right log and the composite target-selection state
      // already close the hand delta, do not reopen INFO.  This keeps the
      // mature compound path and also covers the isolated R5 M19 search: the
      // hand baseline was already synchronized when M19 left the hand, and a
      // single visible M14/M20 gain proves exactly +1.
      infoHandCount = operationExpectedCount;
      infoReadMode = singleM19SearchGainProven
        ? 'M19_SINGLE_GAIN_RIGHT_LOG_PROVEN_SKIP_INFO'
        : singleE10SearchGainProven
          ? 'E10_SINGLE_GAIN_RIGHT_LOG_PROVEN_SKIP_INFO'
          : m20FieldToM19NoHandDeltaProven
          ? 'M20_FIELD_TO_M19_ZERO_HAND_DELTA_SKIP_INFO'
          : 'COMPOUND_RIGHT_LOG_PROVEN_SKIP_INFO';
      infoOutput = {
        result: {
          status: 'OK',
          mouseReleased: true,
          failSafeTriggered: false,
          samples: 0,
          own: {
            status: 'OK',
            handCount: operationExpectedCount,
            source: 'RIGHT_LOG_PROVEN_COMPOUND_DELTA'
          },
          opponent: null,
          compoundRightLogProven: true
        }
      };
      const compoundProofText = singleM19SearchGainProven
        ? `妖刀检索右栏已明确入手${compoundGainIds[0] === 'M20' ? '真刀竹光' : '金黄色的竹光'}1张`
        : singleE10SearchGainProven
          ? `零罗检索右栏已明确入手${compoundGainIds[0] === 'M22' ? '闪刀机－大黄蜂无人机' : '闪刀起动－交闪'}1张`
          : m20FieldToM19NoHandDeltaProven
          ? '真刀场上效果已由右栏确认把妖刀装备到场，手牌净变化=0'
          : zeroDreamYotoCompound
            ? '零梦回收+妖刀检索数量闭合'
            : '右栏已证实2张入手';
      console.log(
        `完整结算快速确认: ${compoundProofText}，` +
        `操作净变化=${state.handCount}->${operationExpectedCount}；跳过 i 手牌数读取。`
      );
    } else {
      try {
        try {
          if (options.prefetchedFastOwnInfo) {
            infoReadMode = 'PREFETCHED_FAST_OWN_INFO';
            infoOutput = timer.timeSync('reuse_prefetched_fast_own_info', () =>
              options.prefetchedFastOwnInfo
            );
            console.log('复用可能胜利门已确认的 FAST OWN INFO；本轮不再第二次按住 i。');
          } else {
            const expectedForFastInfo = Number.isInteger(operationExpectedCount)
              ? { own: operationExpectedCount }
              : {};
            infoOutput = await timer.time('read_hand_count_fast_own', () => runFastOwnAutoHold(
              bridge,
              expectedForFastInfo,
              digitTemplates,
              {
                debugDir: path.join(DEBUG_DIR, 'incremental-info-fast'),
                verbose: CLI_VERBOSE
              }
            ));
          }
        } catch (fastError) {
          if (EXODIA_VICTORY_RISK) {
            console.log(
              `FAST OWN INFO 未稳定确认（${fastError.code || fastError.message}）；` +
              '本动作存在艾克佐迪亚终局风险，不再长按 i，交回上层检查胜利画面。'
            );
            throw fastError;
          }
          infoReadMode = 'SLOW_INFO_FALLBACK';
          console.log(
            `FAST OWN INFO 未稳定确认（${fastError.code || fastError.message}）；` +
            '回退原完整 INFO 读取。'
          );
          infoOutput = await timer.time('read_hand_count_slow_fallback', () => runAutoHold(
            bridge,
            {},
            digitTemplates,
            { debugDir: path.join(DEBUG_DIR, 'incremental-info'), skipCountdown: true }
          ));
        }

        const own = infoOutput && infoOutput.result && infoOutput.result.own;
        if (!infoOutput || !infoOutput.result ||
            infoOutput.result.mouseReleased !== true ||
            infoOutput.result.failSafeTriggered === true) {
          throw new Error('INFO_MOUSE_RELEASE_UNSAFE');
        }
        infoHandCount = own && own.status === 'OK' && Number.isInteger(own.handCount)
          ? own.handCount
          : null;
        if (!Number.isInteger(infoHandCount)) {
          throw new Error(`INFO_OWN_HAND_COUNT_UNAVAILABLE:${own && own.status || 'NONE'}`);
        }
        console.log(
          `我方 INFO 权威手牌数=${infoHandCount}；读取模式=${infoReadMode}` +
          (infoOutput.result.samples ? `；采样=${infoOutput.result.samples}` : '')
        );

        info = await bridge.info();
        validateClient(info);
        await bridge.key('ESC');
        await sleep(config.handFan.slotResetSettleMs);
      } catch (error) {
        // Outside the already-proven compound route, the actual post-resolution
        // INFO count remains authoritative.
        throw error;
      }
    }

    const observedHandCount = infoHandCount;
    if (Number.isInteger(operationExpectedCount) && observedHandCount !== operationExpectedCount) {
      // Known deterministic card effects get one semantic reconciliation pass
      // before any generic lifecycle recovery. This is intentionally driven by
      // the actual INFO count plus card rules, not by fragile right-log row
      // labels. Example: Trade-In can render a freshly drawn Level 8 monster
      // as COST_TO_GRAVEYARD; there is still exactly one Level 8 cost and two
      // draws when the resolved INFO count proves the effect completed.
      const knownEffectRecovery = reconcileKnownEffectExpectedCount(
        state.cards,
        latestBlock,
        observedHandCount
      );
      if (knownEffectRecovery) {
        const previousExpected = operationExpectedCount;
        latestBlock = knownEffectRecovery.operation;
        operationExpectedCount = knownEffectRecovery.expectedHandCount;
        refreshPassiveProof();
        console.log(
          `已知效果数量语义校正: ${latestBlock.activationKey}; ` +
          `${knownEffectRecovery.equation}; 原右栏理论=${previousExpected}; INFO=${observedHandCount}。`
        );
      }
    }

    if (Number.isInteger(operationExpectedCount) && observedHandCount !== operationExpectedCount) {
      // Distinct branch from the normal "M19 activated from hand" route:
      // M20 moved M19 from Deck to the field, that equipped M19 later reached
      // the GY while its carrier Link Summoned Kagari, and M19 search + Kagari
      // recovery resolve in the same settled frame. If the tiny right log clips
      // only Yoto's final gain row, INFO +2 closes the count; the exact Bamboo
      // identity is still learned from the actual hand click below.
      const trueBambooYotoKagari = recoverTrueBambooDeckYotoKagariCompound(
        state.cards,
        blocks,
        latestBlock,
        observedHandCount
      );
      if (trueBambooYotoKagari) {
        const previousExpected = operationExpectedCount;
        latestBlock = trueBambooYotoKagari.operation;
        operationExpectedCount = trueBambooYotoKagari.expectedHandCount;
        refreshPassiveProof();
        console.log(
          `真刀→卡组妖刀→篝复合支线恢复: ` +
          `M20已证明从卡组把妖刀竹光放到场上，随后M19送墓检索 + E02回收；` +
          `原右栏理论=${previousExpected}，INFO=${observedHandCount}，按本轮新增2张继续。`
        );
        if (trueBambooYotoKagari.inferredBambooGainCountOnly) {
          console.log(
            '妖刀检索结果的右栏明细本轮被裁切/压缩：只补“+1数量”语义，不猜卡名；' +
            '具体竹光由后续实际点击新增手牌识别。'
          );
        }
      }
    }

    if (Number.isInteger(operationExpectedCount) && observedHandCount !== operationExpectedCount) {
      const lifecycleRecovery = recoverPersistentLifecycleAcrossCheckpoint(
        state.cards,
        blocks,
        latestBlock,
        observedHandCount
      );
      if (lifecycleRecovery) {
        const previousExpected = operationExpectedCount;
        latestBlock = lifecycleRecovery.operation;
        operationExpectedCount = lifecycleRecovery.expectedHandCount;
        refreshPassiveProof();
        compoundVisualCountConfirmed = Boolean(
          compoundHasTwoProvenGains && Number.isInteger(operationExpectedCount) &&
          expectedFanCandidate && expectedFanCandidate.valid && passiveEstimate && (
            passiveEstimate.count === operationExpectedCount ||
            (passiveEstimate.count === operationExpectedCount - 1 && expectedLiveLayout &&
              String(expectedLiveLayout.source || '').startsWith('TITLE_COMPONENTS_INFERRED_'))
          )
        );
        console.log(
          `跨 checkpoint 持续卡生命周期自愈: ${latestBlock.activationKey}; ` +
          `原理论手牌=${previousExpected}，补回此前漏记的手牌发动后=${operationExpectedCount}，` +
          `与 INFO=${observedHandCount} 一致。`
        );
      } else {
        throw new Error(
          `HAND_COUNT_OPERATION_MISMATCH:info=${observedHandCount},operation=${operationExpectedCount};` +
          '实际手牌与右栏理论变化不一致，可能存在无效/未完整结算/日志语义缺失；停止提交状态。'
        );
      }
    }

    const denseFanMode = observedHandCount >= 8 && observedHandCount <= 12;
    if (denseFanMode) {
      console.log(
        `当前手牌=${observedHandCount}张：进入高手牌增量模式。` +
        '仅处理本轮新增手牌；已知身份不点击，证据或记账失败停止，不自动重扫旧手牌。'
      );
      const denseInference = timer.timeSync('infer_dense_high_count_operation', () =>
        inferIncrementalSlots(state.cards, latestBlock, observedHandCount, library)
      );
      if (!Array.isArray(denseInference.remaining) || !Number.isInteger(denseInference.addedCount)) {
        throw new Error(`DENSE_INCREMENTAL_SEMANTICS_UNRESOLVED:${denseInference.reason || 'NO_REMAINING_STATE'}`);
      }
      if (denseInference.addedCount < 0 || denseInference.addedCount > 2) {
        throw new Error(`DENSE_INCREMENTAL_ADD_COUNT_UNSUPPORTED:${denseInference.addedCount}`);
      }

      const canTargetOnlyNew = Boolean(
        denseInference.success &&
        Array.isArray(denseInference.predictedSlots) &&
        denseInference.predictedSlots.length === denseInference.addedCount
      );

      if (canTargetOnlyNew) {
        const insertedCards = [];
        const finalClicks = [];
        const noClickInsertionsBySlot = new Map();

        for (const slot of denseInference.predictedSlots) {
          const certainInsertion = (denseInference.certainNewCardsBySlot || [])
            .find(item => item && item.slot === slot && item.card);
          let persistent = certainInsertion
            ? PERSISTENT_EXODIA_IDS.has(certainInsertion.card.id)
              ? normalizeExodiaComponentCard(certainInsertion.card, [certainInsertion.card.id])
              : {
                  id: certainInsertion.card.id,
                  name: certainInsertion.card.name,
                  rightLogCertain: true,
                  candidateIds: [certainInsertion.card.id]
                }
            : inferPersistentExodiaAtSlot(
                denseInference.remaining,
                denseInference.predictedSlots,
                slot,
                library,
                denseInference.candidateRows
              );
          if (!persistent || (!/^M\d{2}$/.test(persistent.id) && persistent.id !== EXODIA_UNKNOWN_ID)) continue;
          noClickInsertionsBySlot.set(slot, persistent);
          insertedCards.push({ slot, card: persistent });
          finalClicks.push({
            slot,
            id: persistent.id,
            name: persistent.name,
            source: persistent.rightLogCertain ? 'RIGHT_LOG_EXACT_NO_CLICK' : 'PERSISTENT_EXODIA_NO_CLICK',
            physicalClicksIssued: 0
          });
          console.log(
            `${persistent.rightLogCertain ? '右栏唯一新增身份' : '封印组件永久保留规则'}: ` +
            `手牌${slot} ${persistent.name} [${persistent.id}]，直接记入状态，不点击新牌。`
          );
        }

        const clickSlots = denseInference.predictedSlots.filter(slot => !noClickInsertionsBySlot.has(slot));
        assertNoNewHandClicks(clickSlots);
        let targeted = null;
        let targetedError = null;
        try {
          if (clickSlots.length) {
            const denseOutputDir = path.join(DEBUG_DIR, `revision_${nextRevision}`, 'dense_targeted_new_cards');
            targeted = await timer.time('dense_high_count_targeted_new_cards', () => recognizeDenseTargetSlots({
              bridge,
              info,
              library,
              templates,
              handCount: observedHandCount,
              targetSlots: clickSlots,
              outputDir: denseOutputDir,
              stepPx: 420
            }));
            if (!targeted.success || targeted.recognized.length !== clickSlots.length) {
              throw new Error(`DENSE_TARGETED_CLICK_COUNT_MISMATCH:${targeted.recognized.length}/${clickSlots.length}`);
            }
            for (const row of targeted.recognized) {
              const logCertainCard = strongCertainInsertion(denseInference, row.slot);
              let acceptedRow = row;
              let source = `DENSE_TARGETED_${row.window}`;
              let visualProbeSlot = row.slot;

              if (logCertainCard && !sameRuntimeCardIdentity(logCertainCard, row.card)) {
                const recovery = await recoverCertainDenseInsertionByNeighborProbe({
                  bridge,
                  info,
                  library,
                  templates,
                  handCount: observedHandCount,
                  semanticSlot: row.slot,
                  expectedCard: logCertainCard,
                  outputDir: denseOutputDir,
                  stepPx: 420
                });
                if (!recovery) {
                  throw new Error(
                    `DENSE_TARGETED_RIGHT_LOG_VISUAL_MISMATCH:${row.slot}:` +
                    `${logCertainCard.id}/${row.card.id}`
                  );
                }
                // Keep the semantic insertion slot from the incremental
                // inference; the neighbour slot is only a physical visual
                // confirmation used to survive fan-layout drift.
                acceptedRow = recovery.row;
                visualProbeSlot = recovery.probeSlot;
                source = `DENSE_TARGETED_NEIGHBOR_RECOVERY_${recovery.probeSlot}_${acceptedRow.window}`;
              }

              insertedCards.push({ slot: row.slot, card: acceptedRow.card });
              finalClicks.push({
                slot: row.slot,
                visualProbeSlot,
                id: acceptedRow.card.id,
                name: acceptedRow.card.name,
                source,
                x: acceptedRow.clickReference && acceptedRow.clickReference.x,
                y: acceptedRow.clickReference && acceptedRow.clickReference.y
              });
            }
          }

          if (insertedCards.length !== denseInference.addedCount) {
            throw new Error(`DENSE_TARGETED_INSERTED_COUNT_MISMATCH:${insertedCards.length}/${denseInference.addedCount}`);
          }

          const cards = timer.timeSync('dense_targeted_commit', () =>
            commitInsertionsAtSlots(denseInference.remaining, insertedCards, observedHandCount)
          );
          const normalizedInserted = insertedCards
            .slice()
            .sort((a, b) => a.slot - b.slot)
            .map(item => ({ slot: item.slot, card: { id: item.card.id, name: item.card.name } }));
          const next = {
            version: 2,
            capturedAt: new Date().toISOString(),
            revision: nextRevision,
            handCount: observedHandCount,
            cards,
            handImagePath: passivePath,
            denseTargetedIncremental: true,
            lastOperation: {
              activationKey: latestBlock.activationKey,
              signature: latestBlock.signature,
              activationOccurrence: blocks.filter(block => block.activationKey === latestBlock.activationKey).length
            },
            lastIncremental: {
              consumed: denseInference.consumed || null,
              costConsumed: denseInference.costConsumed || [],
              predictedSlots: denseInference.predictedSlots,
              recognized: normalizedInserted.map(item => item.card),
              finalClicks
            }
          };
          const incrementalResultPath = path.join(DEBUG_DIR, 'latest_incremental_result.json');
          const incrementalResult = {
            status: 'PASS',
            mode: 'DENSE_HIGH_COUNT_TARGETED_INCREMENTAL',
            before: state,
            after: next,
            inference: {
              activationKey: latestBlock.activationKey,
              consumed: denseInference.consumed || null,
              costConsumed: denseInference.costConsumed || [],
              addedCount: denseInference.addedCount,
              predictedSlots: denseInference.predictedSlots
            },
            insertedCards: normalizedInserted,
            finalClicks,
            targetedPlan: targeted ? targeted.plan : { handCount: observedHandCount, targetSlots: [], windows: [] },
            info: infoOutput.result
          };
          commitIncrementalObserverResult({ incrementalResult, log: effectiveLog,
            statePath: STATE_PATH, resultPath: incrementalResultPath });
          status = 'PASS';
          console.log(
            `高手牌增量识别成功: 当前手牌=${observedHandCount}; ` +
            `本轮仅在右栏身份不唯一时点击=${clickSlots.length}张新增手牌` +
            `${noClickInsertionsBySlot.size ? `，另有${noClickInsertionsBySlot.size}张由右栏/永久组件证据直接记入` : ''}。`
          );
          console.log(`手牌序列: ${cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`);
          console.log(
            `本轮新增: ${normalizedInserted.length
              ? normalizedInserted.map(item => `手牌${item.slot} ${item.card.name}[${item.card.id}]`).join(' / ')
              : '无'}`
          );
          console.log(`完整增量详情: ${incrementalResultPath}`);
          return;
        } catch (error) {
          console.error('高手牌增量停止：' + error.message + '；保留提交前手牌/账本，不自动重扫。');
          throw error;
        }
      }
      throw new Error('DENSE_INCREMENTAL_LOCATION_UNRESOLVED_NO_FULL_HAND_SCAN:' +
        (denseInference.reason || 'UNKNOWN'));
    }

    let inference = timer.timeSync('infer_incremental_slots', () =>
      inferIncrementalSlots(state.cards, latestBlock, observedHandCount, library)
    );
    const deterministicPureRemoval = canCommitPureRemovalWithoutPassiveGeometry(
      inference,
      state.cards,
      observedHandCount,
      operationExpectedCount
    );
    const inferredLeftLayoutConfirmed = Boolean(
      expectedLiveLayout &&
      expectedLiveLayout.source === 'TITLE_COMPONENTS_INFERRED_LEFT' &&
      Array.isArray(expectedLiveLayout.slots) &&
      expectedLiveLayout.slots.length === observedHandCount
    );
    const leftEdgeTitleOccluded = Boolean(
      Number.isInteger(observedHandCount) && observedHandCount >= 7 &&
      (infoHandCount === observedHandCount || compoundVisualCountConfirmed) &&
      operationExpectedCount === observedHandCount &&
      passiveEstimate && passiveEstimate.count === observedHandCount - 1 &&
      (
        (expectedFanCandidate && expectedFanCandidate.valid) ||
        inferredLeftLayoutConfirmed
      )
    );
    if (leftEdgeTitleOccluded) {
      console.log(
        `底部标题组件=${passiveEstimate.count}：最左手牌标题被左下界面遮挡；` +
        `${compoundVisualCountConfirmed ? '右栏完整结算' : 'i'}、操作净变化及` +
        `${observedHandCount}张扇形采样共同确认手牌=${observedHandCount}` +
        `${inferredLeftLayoutConfirmed ? '；定位证据=TITLE_COMPONENTS_INFERRED_LEFT' : ''}`
      );
    } else if (!passiveEstimate || passiveEstimate.count !== observedHandCount) {
      if (deterministicPureRemoval) {
        const componentCount = passiveEstimate ? passiveEstimate.count : 'NONE';
        console.log(
          `被动标题组件=${componentCount} 与 INFO=${observedHandCount} 不一致；` +
          `本轮为确定性纯移出操作（移出${deterministicPureRemoval.removedCount}张，新增0张），` +
          '右栏语义 + INFO 数量已闭环，不需要依赖组件位置，跳过组件数量硬门。'
        );
      } else {
        throw new Error(
          `PASSIVE_CURRENT_HAND_COMPONENTS_UNAVAILABLE:info=${infoHandCount},` +
          `operation=${operationExpectedCount},components=${passiveEstimate ? passiveEstimate.count : 'NONE'}`
        );
      }
    }
    const needsPassivePosition = inference.remaining && inference.addedCount > 0 && (
      !inference.success ||
      (!inference.componentEquivalentLayout && (inference.candidateRows || []).some(row => row.length > 1))
    );
    if (needsPassivePosition) {
      const previousPath = state.handImagePath || path.join(DEBUG_DIR, `revision_${state.revision}`, 'hand_detect.png');
      if (!fs.existsSync(previousPath)) throw new Error(`PREVIOUS_PASSIVE_HAND_IMAGE_NOT_FOUND:${previousPath}`);
      const previousImage = await readPng(previousPath);
      const previousDetected = detectHandCountFromImage(previousImage, state.handCount);
      const positionOnlyScenarios = buildPositionOnlyScenarios(inference.remaining, observedHandCount);
      const passiveResolution = resolveAmbiguousSlotsFromPassiveImages(
        { scenarios: positionOnlyScenarios },
        previousImage,
        previousDetected.componentEstimate && previousDetected.componentEstimate.components,
        passiveImage,
        passiveEstimate.components
      );
      if (passiveResolution.success) {
        inference = {
          ...inference,
          success: true,
          reason: null,
          predictedSlots: passiveResolution.predictedSlots,
          passiveResolution
        };
      } else {
        inference = {
          ...inference,
          success: false,
          reason: `PASSIVE_POSITION_ALIGNMENT_FAILED:${passiveResolution.reason}`,
          passiveResolution
        };
      }
    }
    if (!inference.success) {
      throw new Error(`INCREMENTAL_LOCATION_UNRESOLVED:${inference.reason}`);
    }
    if (inference.predictedSlots.length !== inference.addedCount) {
      throw new Error(
        `PREDICTED_SLOT_COUNT_MISMATCH:${inference.predictedSlots.length}/${inference.addedCount}`
      );
    }
    // The right log uses the same top-level card geometry for activations and
    // summons. "Operation" is intentionally neutral and also covers a normal
    // summon such as Raye leaving the hand.
    const isFieldRecovery = ['E02', 'E10'].includes(latestBlock.activationKey) &&
      (latestBlock.details || []).some(detail => detail.role === 'HAND_GAIN_CANDIDATE');
    const isEquipSpellActivation = ['M19', 'M20'].includes(latestBlock.activationKey) &&
      (latestBlock.details || []).some(detail => detail.role === 'TARGET');
    console.log(`本次操作: ${latestBlock.activation.card.name} [${latestBlock.activationKey}]`);
    if (isFieldRecovery) {
      console.log('操作类型: 额外卡组怪兽场上效果回收（不从手牌消耗发动卡）');
    } else if (isEquipSpellActivation) {
      console.log('操作类型: 装备魔法从手牌发动（手牌-1，对象不是新增手牌）');
    }
    console.log(`移出手牌: ${inference.consumed ? `${inference.consumed.name}@手牌${inference.consumed.index}` : '无（场上效果）'}`);
    if (inference.costConsumed && inference.costConsumed.length) {
      console.log(`额外移出手牌: ${inference.costConsumed.map(card => `${card.name}@手牌${card.index}`).join(' / ')}`);
    }
    console.log(`新增数量: ${inference.addedCount}; 唯一实际槽位=${inference.predictedSlots.join(',')}`);
    const knownGainLabel = knownGainEffectLabel(latestBlock.activationKey, inference.addedCount);
    if (knownGainLabel) {
      console.log(
        `已知效果数量确认: ${knownGainLabel}；` +
        `最终实际手牌=${observedHandCount}，因此本轮按新增${inference.addedCount}张处理。`
      );
    }

    const clickStageStarted = process.hrtime.bigint();
    const insertedCards = [];
    const finalClicks = [];
    const singleCertainCandidate = inference.addedCount === 1 &&
      inference.candidateRows && inference.candidateRows.length === 1 &&
      inference.candidateRows[0].length === 1
      ? inference.candidateRows[0][0]
      : null;
    const noClickInsertionsBySlot = new Map();
    for (const slot of inference.predictedSlots) {
      const certainInsertion = (inference.certainNewCardsBySlot || [])
        .find(item => item.slot === slot && item.card);
      let persistent = certainInsertion
        ? PERSISTENT_EXODIA_IDS.has(certainInsertion.card.id)
          ? normalizeExodiaComponentCard(certainInsertion.card, [certainInsertion.card.id])
          : {
              id: certainInsertion.card.id,
              name: certainInsertion.card.name,
              rightLogCertain: true,
              candidateIds: [certainInsertion.card.id]
            }
        : inferPersistentExodiaAtSlot(
            inference.remaining,
            inference.predictedSlots,
            slot,
            library,
            inference.candidateRows
          );
      if (!persistent && inference.addedCount === 1 && singleCertainCandidate &&
          PERSISTENT_EXODIA_IDS.has(singleCertainCandidate.id)) {
        persistent = normalizeExodiaComponentCard(singleCertainCandidate, [singleCertainCandidate.id]);
      }
      if (!persistent || (!/^M\d{2}$/.test(persistent.id) && persistent.id !== EXODIA_UNKNOWN_ID)) continue;
      noClickInsertionsBySlot.set(slot, persistent);
      insertedCards.push({ slot, card: persistent });
      finalClicks.push({
        slot,
        id: persistent.id,
        name: persistent.name,
        source: persistent.rightLogCertain ? 'RIGHT_LOG_EXACT_NO_CLICK' : 'PERSISTENT_EXODIA_NO_CLICK',
        physicalClicksIssued: 0
      });
      console.log(
        `${persistent.rightLogCertain ? '右栏唯一新增身份' : '封印组件永久保留规则'}: ` +
        `手牌${slot} ${persistent.name} [${persistent.id}]` +
        `${persistent.candidateIds.length > 1 ? `，候选=${persistent.candidateIds.join('/')}` : ''}，` +
        '直接记入状态，不点击新牌。'
      );
    }
    const clickSlots = inference.predictedSlots.filter(slot => !noClickInsertionsBySlot.has(slot));
    assertNoNewHandClicks(clickSlots);
    for (let i = 0; i < clickSlots.length; i++) {
      const slotNumber = clickSlots[i];
      const logCertainCard = strongCertainInsertion(inference, slotNumber);
      let acceptedCard = null;
      let acceptedSlot = null;
      let lastFailure = null;
      let physicalClicksIssued = 0;
      const attemptFailures = [];

      // Every "click recognition" attempt must now say whether a real mouse
      // click was actually issued. Previously a localization error could be
      // caught before bridge.click(), yet the final log still said "clicked
      // twice and failed", which was misleading and could hide a no-click path.
      for (let attempt = 1; attempt <= 2 && !acceptedCard; attempt++) {
        let clickIssuedThisAttempt = false;
        try {
          console.log(`新增手牌 ${i + 1}/${clickSlots.length}: 手牌${slotNumber} 尝试${attempt}/2，重新定位。`);
          info = await bridge.info();
          validateClient(info);
          const slot = await locateSlotWithoutHandClick(bridge, info, observedHandCount, slotNumber);
          const clickY = Number.isFinite(slot.clickY) ? slot.clickY : slot.titleY;
          console.log(
            `  定位来源=${slot.source}; components=${slot.liveComponentCount ?? '?'}; ` +
            `目标=(${slot.x},${clickY})；准备发送实际鼠标点击。`
          );
          const fresh = await bridge.info();
          validateClient(fresh);
          const point = mapReferencePoint(fresh, { x: slot.x, y: clickY });
          await bridge.click(point.x, point.y);
          clickIssuedThisAttempt = true;
          physicalClicksIssued += 1;
          console.log(`  已发送实际点击: 手牌${slotNumber} attempt=${attempt} @ (${slot.x},${clickY})`);
          await sleep(attempt === 1 ? config.mouseSettleMs : Math.max(config.mouseSettleMs, 180));
          const result = await recognizeCurrentCard(bridge, fresh, library, templates);
          const best = result && result.judged && result.judged.best;
          if (!result || !result.judged || !result.judged.accepted || !best) {
            throw new Error('CARD_TEMPLATE_NOT_ACCEPTED');
          }
          if (logCertainCard && !sameRuntimeCardIdentity(logCertainCard, best)) {
            throw new Error(`RIGHT_LOG_VISUAL_MISMATCH:${logCertainCard.id}/${best.id}`);
          }
          acceptedCard = { id: best.id, name: best.name };
          acceptedSlot = slot;
        } catch (error) {
          lastFailure = error;
          attemptFailures.push({
            attempt,
            clickIssued: clickIssuedThisAttempt,
            reason: error && error.message || 'UNKNOWN'
          });
          console.log(
            `  手牌${slotNumber} 尝试${attempt}失败: ${error && error.message || 'UNKNOWN'}；` +
            `${clickIssuedThisAttempt ? '本次已实际点击' : '本次未发送点击'}`
          );
          await bridge.key('ESC').catch(() => {});
          await sleep(config.handFan.slotResetSettleMs);
        }
      }

      if (!acceptedCard && logCertainCard) {
        if (physicalClicksIssued === 0) {
          throw new Error(
            `NEW_CARD_PHYSICAL_CLICK_NOT_ISSUED:${slotNumber}:` +
            `${lastFailure && lastFailure.message || 'UNKNOWN'}`
          );
        }
        // The activation block already exposed an unambiguous acquired card
        // and INFO independently proved the final hand count. This is a safe
        // fallback for compressed 8+ card fans where the outer card may not be
        // clickable/recognizable even after re-locating twice.
        acceptedCard = { id: logCertainCard.id, name: logCertainCard.name };
        insertedCards.push({ slot: slotNumber, card: acceptedCard });
        finalClicks.push({
          slot: slotNumber,
          ...acceptedCard,
          source: 'RIGHT_LOG_EXACT_FALLBACK',
          physicalClicksIssued,
          attemptFailures,
          fallbackReason: lastFailure && lastFailure.message || 'UNKNOWN'
        });
        console.log(
          `新增手牌${slotNumber}实际点击${physicalClicksIssued}次后仍未通过视觉确认；` +
          `右栏已明确取得 ${acceptedCard.name} [${acceptedCard.id}]，且 INFO 已确认最终手牌数，使用右栏精确结果兜底。`
        );
      } else if (!acceptedCard) {
        throw new Error(`NEW_CARD_RECOGNITION_FAILED:${slotNumber}:${lastFailure && lastFailure.message || 'UNKNOWN'}`);
      } else {
        insertedCards.push({ slot: slotNumber, card: acceptedCard });
        const acceptedClickY = Number.isFinite(acceptedSlot.clickY) ? acceptedSlot.clickY : acceptedSlot.titleY;
        finalClicks.push({
          slot: slotNumber,
          ...acceptedCard,
          x: acceptedSlot.x,
          y: acceptedClickY,
          source: acceptedSlot.source,
          physicalClicksIssued,
          attemptFailures
        });
        console.log(
          `新增手牌点击 ${i + 1}/${clickSlots.length}: 手牌${slotNumber} ` +
          `${acceptedCard.name} [${acceptedCard.id}] @ (${acceptedSlot.x},${acceptedClickY}); ` +
          `实际点击次数=${physicalClicksIssued}`
        );
      }

      if (i + 1 < clickSlots.length) {
        await bridge.key('ESC');
        await sleep(config.handFan.slotResetSettleMs);
      }
    }
    timer.stages.push({
      name: 'click_and_recognize_new_cards',
      ms: Number(process.hrtime.bigint() - clickStageStarted) / 1e6
    });

    const cards = timer.timeSync('commit_and_write_state', () => {
      if (insertedCards.length !== inference.addedCount) throw new Error('INSERTED_CARD_COUNT_MISMATCH');
      const committed = commitInsertionsAtSlots(inference.remaining, insertedCards, observedHandCount);
      if (committed.length !== observedHandCount) throw new Error('COMMITTED_HAND_COUNT_MISMATCH');
      return committed;
    });
    const next = {
      version: 2,
      capturedAt: new Date().toISOString(),
      revision: Number(state.revision || 0) + 1,
      handCount: observedHandCount,
      cards,
      handImagePath: passivePath,
      lastOperation: {
        activationKey: latestBlock.activationKey,
        signature: latestBlock.signature,
        activationOccurrence: blocks.filter(block => block.activationKey === latestBlock.activationKey).length
      },
      lastIncremental: {
        consumed: inference.consumed,
        costConsumed: inference.costConsumed || [],
        predictedSlots: inference.predictedSlots,
        recognized: insertedCards.map(item => item.card),
        finalClicks
      }
    };
    const incrementalResultPath = path.join(DEBUG_DIR, 'latest_incremental_result.json');
    const incrementalResult = {
      status: 'PASS',
      before: state,
      after: next,
      inference: {
        activationKey: inference.activationKey,
        consumed: inference.consumed,
        costConsumed: inference.costConsumed || [],
        addedCount: inference.addedCount,
        predictedSlots: inference.predictedSlots
      },
      insertedCards,
      finalClicks,
      info: infoOutput.result
    };
    commitIncrementalObserverResult({ incrementalResult, log: effectiveLog,
      statePath: STATE_PATH, resultPath: incrementalResultPath });
    status = 'PASS';
    if (VERBOSE) {
      console.log(JSON.stringify({ status: 'PASS', handCount: observedHandCount, cards, finalClicks }, null, 2));
    } else {
      console.log(`增量识别成功: 当前手牌=${observedHandCount}`);
      console.log(`手牌序列: ${cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`);
      const physicalClicks = finalClicks.filter(click => Number(click.physicalClicksIssued || 0) > 0);
      console.log(`本次新增牌点击: ${physicalClicks.length
        ? physicalClicks.map(click => `手牌${click.slot} ${click.name}[${click.id}]`).join(' / ')
        : '无'}`);
      console.log(`完整增量详情: ${incrementalResultPath}`);
    }
  } finally {
    if (ownsBridge) await timer.time('bridge_stop', () => bridge.stop());
    timer.finish({ status });
    console.log(`TIMING ${timer.summary()}`);
  }
}

if (require.main === module) {
  runIncrementalHandChange().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { runIncrementalHandChange, resolveSlotForPhysicalClick, canCommitPureRemovalWithoutPassiveGeometry };
