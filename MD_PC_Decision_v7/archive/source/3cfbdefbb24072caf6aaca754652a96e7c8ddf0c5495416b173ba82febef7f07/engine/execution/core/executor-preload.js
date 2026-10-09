'use strict';

// V5 executor adapter.
// Loaded with Node --require before a mature single-card executor starts.
// It changes only the V5 entry path:
//   1) reuse the already-verified observer hand session instead of rescanning all cards;
//   2) honor the exact hand ordinal selected by the user when duplicate IDs exist.
// Mature observer / target / card executors remain unchanged on disk.

const fs = require('fs');
const path = require('path');
const { sameRuntimeCardIdentity } = require('../../lib/exodia-policy');
const { readJson } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');


function normalizeSessionState(raw) {
  const handCount = Number(raw && raw.handCount);
  const cards = Array.isArray(raw && raw.cards) ? raw.cards.map((card, index) => ({
    ...card,
    index: index + 1,
    id: String(card && card.id || ''),
    name: String(card && card.name || card && card.id || 'UNKNOWN')
  })) : [];

  if (!Number.isInteger(handCount) || handCount < 1 || handCount > 12) {
    throw new Error(`V5_REUSE_HAND_COUNT_INVALID:${handCount}`);
  }
  if (cards.length !== handCount) {
    throw new Error(`V5_REUSE_HAND_LENGTH_INVALID:${cards.length}/${handCount}`);
  }
  if (cards.some(card => !card.id || card.id === 'UNKNOWN')) {
    throw new Error('V5_REUSE_HAND_HAS_UNKNOWN_CARD');
  }

  return {
    ...raw,
    status: 'PASS',
    handCount,
    cards,
    v5ReusedObserverState: true
  };
}

function installBaselineReuse() {
  if (process.env.MD_V5_REUSE_BASELINE !== '1') return;
  if (!fs.existsSync(HAND_STATE_PATH)) {
    throw new Error('V5_REUSE_HAND_STATE_MISSING');
  }

  const observerPath = require.resolve(path.join(ROOT, 'execution', 'core', 'observer-current-baseline'));
  const observerModule = require(observerPath);

  observerModule.establishCurrentObserverBaseline = async function v5ReuseCurrentObserverBaseline() {
    const state = normalizeSessionState(readJson(HAND_STATE_PATH));
    console.log('\n============================================================');
    console.log('V5快速接续：复用上一动作正式observer维护的当前手牌状态。');
    console.log(`当前内部手牌=${state.handCount}张；本次不重新逐张扫描、不重建右栏baseline。`);
    console.log('真正执行目标时仍由成熟 hand-target 重新确认当前物理位置和目标卡名。');
    console.log('============================================================');
    return state;
  };
}


async function selectExactLowHandOrdinal(options, requestedSlot, requestedId, cards) {
  const config = require(path.join(ROOT, 'live-config'));
  const { captureReferenceRoi, mapReferencePoint, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
  const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
  const { detectHandCountFromImage, getHandLayout, resolveExposedFanSlots } = require(path.join(ROOT, 'lib', 'hand-state'));
  const { resolveMeasuredHandTarget } = require(path.join(ROOT, 'lib', 'live-hand-geometry'));

  async function resolveMeasuredCurrentTarget() {
    const handCount = Number(options.baseline.handCount);
    const detectRoi = config.handFan.detectRoi;
    const layout = getHandLayout(handCount);
    if (!layout || layout.status !== 'OK' || !Array.isArray(layout.slots) || layout.slots.length !== handCount) {
      throw new Error(`V5_CURRENT_TITLE_LAYOUT_INVALID:${handCount}`);
    }

    const safeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
    const safe = mapReferencePoint(options.info, safeRef);
    const maxAttempts = Math.max(2, Number(config.handFan.slotResetMaxAttempts || 3));
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await options.bridge.click(safe.x, safe.y);
      await sleep(Math.max(80, Number(config.handFan.slotResetClickSettleMs || 80)));
      await options.bridge.key('ESC').catch(() => {});
      await sleep(Math.max(100, Number(config.handFan.slotResetSettleMs || 120)) * attempt);

      const image = await captureReferenceRoi(options.bridge, options.info, detectRoi);
      if (options.debugDir) {
        saveRgbaPng(
          image,
          path.join(options.debugDir, `v5_current_title_target_${String(attempt).padStart(2, '0')}.png`)
        );
      }

      const geometry = resolveMeasuredHandTarget(image, handCount, requestedSlot, {
        baselineCards: cards, detector: { detectHandCountFromImage, getHandLayout, resolveExposedFanSlots }
      });
      const target = geometry.target;
      const targetX = Number(target && target.x);
      const targetY = Number(target && target.titleY);
      last = geometry;

      // Important V5 relaxation: a seven-card fan can legitimately lose ONE
      // outer title component.  If slot 1 is inferred but the user selected slot
      // 5, slot 5 is still a real measured component and is safe to click.
      // We accept only when THIS requested target x matches a measured component;
      // the inferred card itself is never clicked.
      if (geometry.clickable) {
        if (geometry.source !== 'TITLE_COMPONENTS') {
          console.log(
            `V5低手牌边缘缺块容忍: source=${geometry.source}; ` +
            `手牌${requestedSlot}本身仍是实测TITLE组件，允许继续。`
          );
        }
        return {
          x: targetX,
          y: targetY,
          source: geometry.source,
          centers: last.resolvedCenters,
          measuredCenters: geometry.measuredCenters
        };
      }
    }

    throw new Error(
      `V5_CURRENT_TITLE_TARGET_NOT_MEASURED:slot=${requestedSlot};` +
      `source=${last && last.source};titleCount=${last && last.titleCount};` +
      `measured=${last && last.measuredCenters ? last.measuredCenters.map(Math.round).join(',') : ''};` +
      `resolved=${last && last.resolvedCenters ? last.resolvedCenters.join(',') : ''}`
    );
  }

  const current = await resolveMeasuredCurrentTarget();

  const fresh = await options.bridge.info();
  const physical = mapReferencePoint(fresh, { x: current.x, y: current.y });
  await options.bridge.click(physical.x, physical.y);
  await sleep(config.toonChain.selectSettleMs || 260);

  const raw = await recognizeCurrentCard(
    options.bridge,
    fresh,
    options.library,
    options.templates,
    { stableAcceptedSamples: 2 }
  );
  const selected = normalizeRecognized(raw);
  if (options.debugDir && raw && raw.query) saveRgbaPng(raw.query, path.join(options.debugDir, 'selected_card_query.png'));
  if (!selected.accepted || !sameRuntimeCardIdentity(requestedId, selected)) {
    await options.bridge.key('ESC').catch(() => {});
    throw new Error(
      `V5_HAND_SELECTION_MISMATCH:slot=${requestedSlot};expected=${requestedId};` +
      `actual=${selected.name}[${selected.id}]`
    );
  }

  console.log(
    `V5当前槽位确认: 手牌${requestedSlot} ${selected.name}[${selected.id}] ` +
    `@(${Math.round(current.x)},${Math.round(current.y)}); 本次为正式执行前的目标确认。`
  );

  return {
    slot: requestedSlot,
    duplicateCount: cards.filter(card => String(card && card.id || '') === requestedId).length,
    selected,
    clickReference: { x: current.x, y: current.y },
    positioning: {
      mode: 'V5_CURRENT_MEASURED_TITLE_COMPONENT_BY_ORDINAL',
      source: current.source,
      centers: current.centers,
      currentCenter: { x: current.x, y: current.y }
    }
  };
}

async function selectExactDenseOrdinalWithoutOldWitness(options, requestedSlot, requestedId, cards) {
  const { recognizeDenseTargetSlots } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
  const outputDir = path.join(options.debugDir, 'v5_dense_current_slot');
  const targeted = await recognizeDenseTargetSlots({
    bridge: options.bridge,
    info: options.info,
    library: options.library,
    templates: options.templates,
    handCount: options.baseline.handCount,
    targetSlots: [requestedSlot],
    outputDir,
    stepPx: 420,
    keepFinalSelection: true
  });

  const row = targeted && targeted.recognized && targeted.recognized[0];
  if (!targeted || targeted.success !== true || !targeted.selectionKept || !row) {
    throw new Error(`V5_DENSE_CURRENT_SLOT_NOT_PROVEN:${requestedSlot}`);
  }
  if (!row.card || String(row.card.id || '') !== requestedId) {
    await options.bridge.key('ESC').catch(() => {});
    throw new Error(
      `V5_DENSE_SELECTION_MISMATCH:slot=${requestedSlot};expected=${requestedId};` +
      `actual=${row && row.card ? `${row.card.name}[${row.card.id}]` : 'NONE'}`
    );
  }

  console.log(
    `V5高手牌当前槽位确认: 手牌${requestedSlot} ${row.card.name}[${row.card.id}] ` +
    `(${row.window}); 本次为正式执行前的目标确认。`
  );

  return {
    slot: requestedSlot,
    duplicateCount: cards.filter(card => String(card && card.id || '') === requestedId).length,
    selected: row.recognition,
    clickReference: row.clickReference,
    positioning: {
      mode: 'V5_DENSE_CURRENT_SLOT_TARGET',
      window: row.window,
      currentCenter: row.clickReference,
      finalKnownWindow: targeted.finalKnownWindow || null
    }
  };
}

function installExactSlotSelection() {
  const requestedSlot = Number(process.env.MD_V5_SELECTED_SLOT);
  const requestedId = String(process.env.MD_V5_SELECTED_CARD_ID || '');
  if (!Number.isInteger(requestedSlot) || requestedSlot < 1 || !requestedId) return;

  const handTargetPath = require.resolve(path.join(ROOT, 'execution', 'core', 'hand-target'));
  const handTarget = require(handTargetPath);
  const original = handTarget.selectObservedHandCard;
  if (typeof original !== 'function') {
    throw new Error('V5_HAND_TARGET_EXPORT_MISSING');
  }

  handTarget.selectObservedHandCard = async function v5SelectExactOrdinal(options) {
    const baseline = options && options.baseline;
    const cards = Array.isArray(baseline && baseline.cards) ? baseline.cards : [];
    const selected = cards[requestedSlot - 1];

    if (!selected) {
      throw new Error(`V5_SELECTED_SLOT_NOT_IN_BASELINE:${requestedSlot}/${cards.length}`);
    }
    if (String(selected.id || '') !== requestedId) {
      throw new Error(
        `V5_SELECTED_SLOT_ID_CHANGED:slot=${requestedSlot};expected=${requestedId};actual=${selected.id || 'UNKNOWN'}`
      );
    }
    if (String(options.expectedId || '') !== requestedId) {
      throw new Error(
        `V5_EXECUTOR_EXPECTED_ID_MISMATCH:slot=${requestedSlot};decision=${requestedId};executor=${options.expectedId || 'UNKNOWN'}`
      );
    }

    // For 1~7 cards, newly drawn cards are still clicked and recognized by the
    // incremental observer. However, that committed card record may not carry
    // the old opening-baseline x/y fields. Do not fail on missing historical
    // coordinates: the ordinal and identity are already known, so resolve the
    // current real TITLE_COMPONENT and re-confirm the card for the actual action.
    if (Number(baseline.handCount) <= 7) {
      return selectExactLowHandOrdinal(options, requestedSlot, requestedId, cards);
    }

    // Old cards that came from a full DENSE baseline keep using the mature exact
    // witness path. A newly gained high-hand card may have been clicked/recognized
    // by the incremental observer but still not carry a reusable denseWitness in
    // session_state.json. In that case target only the chosen current ordinal with
    // the live DENSE window and keep that one selection for activation.
    if (!selected.denseWitness) {
      return selectExactDenseOrdinalWithoutOldWitness(options, requestedSlot, requestedId, cards);
    }

    const targetedBaseline = {
      ...baseline,
      cards: cards.map((card, index) => {
        if (index === requestedSlot - 1) return { ...card, index: index + 1 };
        if (String(card && card.id || '') !== requestedId) return { ...card, index: index + 1 };
        return {
          ...card,
          index: index + 1,
          id: `V5_MASKED_DUPLICATE_${requestedId}_${index + 1}`
        };
      })
    };

    return original({
      ...options,
      baseline: targetedBaseline
    });
  };
}

installBaselineReuse();
installExactSlotSelection();
