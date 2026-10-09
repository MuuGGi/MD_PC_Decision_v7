'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { recognizeDenseTargetSlots } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
const { selectObservedLowHandCard } = require('./low-hand-target');
const { sameRuntimeCardIdentity } = require('../../lib/exodia-policy');

function findObservedTarget(baseline, expectedId) {
  const cards = baseline && Array.isArray(baseline.cards) ? baseline.cards : [];
  if (!baseline || !Number.isInteger(baseline.handCount) || cards.length !== baseline.handCount) {
    throw new Error('EXEC_CURRENT_HAND_STATE_INVALID');
  }
  const matches = cards.filter(card => card && sameRuntimeCardIdentity(expectedId, card));
  if (!matches.length) throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${expectedId}`);
  const chosen = matches[0];
  // The current observer array is ordered after removals/insertions. An old
  // card.index or denseWitness ordinal must not override that current order.
  return { slot: cards.indexOf(chosen) + 1, chosen, matches };
}

async function selectObservedHandCard(options) {
  const { bridge, info, library, templates, baseline, expectedId, debugDir } = options;
  const found = findObservedTarget(baseline, expectedId);
  // Restore/prove the requested window using the mature target locator. This
  // only invalidates the edge marker; it does not scan every card again.
  bridge.__mdDenseHandWindow = null;
  if (baseline.handCount <= 7) {
    const current = {...baseline, cards: baseline.cards.map((c, i) => ({...c, index: i + 1}))};
    return selectObservedLowHandCard({...options, baseline: current});
  }
  if (baseline.handCount > 12) {
    throw new Error(`EXEC_HAND_TARGET_COUNT_UNSUPPORTED:${baseline.handCount}`);
  }
  console.log(`公共手牌定位：按当前手牌${found.slot}/${baseline.handCount}定点确认 ${expectedId}；不复用旧窗口序号。`);
  const dense = await recognizeDenseTargetSlots({
    bridge, info, library, templates, handCount: baseline.handCount,
    targetSlots: [found.slot], stepPx: 420, keepFinalSelection: true,
    onBeforeSelect: options.onBeforeSelect,
    outputDir: path.join(debugDir, 'dense_current_target')
  });
  const row = dense && dense.recognized && dense.recognized[0];
  if (!dense || dense.success !== true || dense.selectionKept !== true ||
      !Array.isArray(dense.recognized) || dense.recognized.length !== 1 ||
      !row || row.slot !== found.slot || !row.card || !sameRuntimeCardIdentity(expectedId, row.card) ||
      !row.clickReference || !Number.isFinite(row.clickReference.x) || !Number.isFinite(row.clickReference.y)) {
    // Never try a neighbour or re-click after a mismatched card. The caller
    // cannot proceed to an activation button unless this function succeeds.
    await bridge.key('ESC').catch(() => {});
    throw new Error(`EXEC_DENSE_CURRENT_TARGET_MISMATCH:slot=${found.slot};expected=${expectedId};actual=${row && row.card ? row.card.id : 'NONE'}`);
  }
  return {
    slot: found.slot,
    duplicateCount: found.matches.length,
    selected: row.recognition,
    clickReference: row.clickReference,
    positioning: {
      mode: 'DENSE_CURRENT_TARGET_SLOT', window: row.window,
      currentSlot: found.slot, currentCenter: row.clickReference,
      finalKnownWindow: dense.finalKnownWindow || null
    }
  };
}

module.exports = { findObservedTarget, selectObservedHandCard };
