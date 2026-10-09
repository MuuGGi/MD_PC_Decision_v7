'use strict';

const path = require('path');
const { sameRuntimeCardIdentity } = require('../../lib/exodia-policy');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const {
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { getHandLayout } = require(path.join(ROOT, 'lib', 'hand-state'));
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { resolveMeasuredHandTarget } = require('../../lib/live-hand-geometry');


function findObservedSlot(baseline, expectedId) {
  const cards = baseline && Array.isArray(baseline.cards) ? baseline.cards : [];
  const matches = cards.filter(card => card && sameRuntimeCardIdentity(expectedId, card));
  if (!matches.length) {
    throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${expectedId}`);
  }
  const chosen = matches[0];
  const slot = cards.indexOf(chosen) + 1;
  if (!Number.isInteger(slot) || slot < 1 || slot > baseline.handCount) {
    throw new Error(`EXEC_TARGET_SLOT_INVALID:${slot}/${baseline && baseline.handCount}`);
  }
  return { slot, card: chosen, matches };
}

async function resolveCurrentTitleComponentTarget(options) {
  const {
    bridge,
    info,
    handCount,
    slot,
    baseline,
    debugDir
  } = options;

  if (!Number.isInteger(handCount) || handCount < 1 || handCount > 7) {
    throw new Error(`EXEC_LOW_HAND_COUNT_UNSUPPORTED:${handCount}`);
  }

  const detectRoi = config.handFan.detectRoi;
  const baseLayout = getHandLayout(handCount);
  if (!baseLayout || baseLayout.status !== 'OK' ||
      baseLayout.layoutMode !== 'FIXED_FAN' ||
      !Array.isArray(baseLayout.slots) || baseLayout.slots.length !== handCount) {
    throw new Error(`EXEC_CURRENT_TITLE_BASE_LAYOUT_INVALID:${handCount}`);
  }

  const safeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
  const safe = mapReferencePoint(info, safeRef);
  const maxAttempts = Math.max(2, Number(config.handFan.slotResetMaxAttempts || 3));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Keep the same mature observer reset sequence used by runtime/observer/scan-state.js:
    // neutral click on the opponent spell/trap zone -> ESC -> recapture.
    await bridge.click(safe.x, safe.y);
    await sleep(Math.max(80, Number(config.handFan.slotResetClickSettleMs || 80)));
    await bridge.key('ESC').catch(() => {});
    await sleep(Math.max(100, Number(config.handFan.slotResetSettleMs || 120)) * attempt);

    const handImage = await captureReferenceRoi(bridge, info, detectRoi);
    if (debugDir) {
      saveRgbaPng(
        handImage,
        path.join(debugDir, `current_title_target_${String(attempt).padStart(2, '0')}.png`)
      );
    }

    const geometry = resolveMeasuredHandTarget(handImage, handCount, slot, { baselineCards: baseline?.cards });
    const target = geometry.target, centers = geometry.resolvedCenters;
    last = { attempt, source: geometry.source, titleCount: geometry.titleCount, centers };

    // Execution is stricter than passive incremental recognition: the actual
    // target click must come from this frame's real TITLE_COMPONENTS.  A saved
    // baseline may prove which outer title is missing, but the inferred slot
    // itself is never clickable.
    if (geometry.clickable) {
      return {
        x: Number(target.x),
        y: Number(target.titleY),
        source: geometry.source,
        centers
      };
    }
  }

  throw new Error(
    `EXEC_CURRENT_TITLE_COMPONENT_TARGET_NOT_PROVEN:slot=${slot};` +
    `source=${last && last.source};titleCount=${last && last.titleCount};` +
    `centers=${last && last.centers ? last.centers.join(',') : ''}`
  );
}

async function selectObservedLowHandCard(options) {
  const {
    bridge,
    info,
    library,
    templates,
    baseline,
    expectedId,
    debugDir
  } = options;

  if (!baseline || !Number.isInteger(baseline.handCount) || baseline.handCount < 1 || baseline.handCount > 7 ||
      !Array.isArray(baseline.cards) || baseline.cards.length !== baseline.handCount) {
    throw new Error(`EXEC_LOW_HAND_BASELINE_INVALID:${baseline && baseline.handCount}`);
  }

  const found = findObservedSlot(baseline, expectedId);
  const observedX = Number.isFinite(found.card?.x) ? found.card.x : null;
  const observedY = Number.isFinite(found.card?.y) ? found.card.y : null;

  const current = await resolveCurrentTitleComponentTarget({
    bridge,
    info,
    handCount: baseline.handCount,
    slot: found.slot,
    baseline,
    debugDir
  });

  const clickReference = { x: current.x, y: current.y };
  const drift = observedX === null || observedY === null ? null : Math.hypot(current.x - observedX, current.y - observedY);
  console.log(
    `执行目标复用观察序号: 手牌${found.slot}; ` +
    `观察中心=(${observedX},${observedY}); 当前真实中心=(${current.x},${current.y}); ` +
    `漂移=${drift === null ? '无历史坐标（只用当前实测）' : drift.toFixed(1) + 'px'}`
  );

  const physical = mapReferencePoint(info, clickReference);
  if (options.onBeforeSelect) {
    await options.onBeforeSelect({ bridge, info, slot: found.slot, clickReference });
  }
  await bridge.click(physical.x, physical.y);
  await sleep(config.toonChain.selectSettleMs || 260);

  const raw = await recognizeCurrentCard(bridge, info, library, templates, {
    stableAcceptedSamples: 2
  });
  const selected = normalizeRecognized(raw);
  if (!selected.accepted || !sameRuntimeCardIdentity(expectedId, selected)) {
    await bridge.key('ESC').catch(() => {});
    throw new Error(
      `EXEC_HAND_SELECTION_MISMATCH:slot=${found.slot};expected=${expectedId};` +
      `actual=${selected.name}[${selected.id}];禁止相邻手牌兜底。`
    );
  }

  return {
    slot: found.slot,
    duplicateCount: found.matches.length,
    selected,
    clickReference,
    positioning: {
      mode: 'CURRENT_TITLE_COMPONENTS',
      source: current.source,
      centers: current.centers,
      observedCenter: { x: observedX, y: observedY },
      currentCenter: { x: current.x, y: current.y },
      driftPx: drift
    }
  };
}

module.exports = {
  findObservedSlot,
  resolveCurrentTitleComponentTarget,
  selectObservedLowHandCard
};
