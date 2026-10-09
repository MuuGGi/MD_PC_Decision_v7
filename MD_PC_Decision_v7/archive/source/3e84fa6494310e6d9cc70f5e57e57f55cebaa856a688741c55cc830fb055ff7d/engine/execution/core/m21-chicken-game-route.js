'use strict';

const fs = require('fs');
const path = require('path');
const { isExodiaComponentId, sameRuntimeCardIdentity, normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const { readJson } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const { imageDarkRatio } = require('./image-metrics');
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
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const { cropImage } = require('../../lib/png-utils');
const { locateFieldActivateIcon } = require('./hand-action-icon');
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));

const LOG_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'duel-log-live',
  'latest_result.json'
);
const INCREMENTAL_RESULT_PATH = path.join(
  ROOT,
  'debug',
  'hand-change-live',
  'latest_incremental_result.json'
);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}




function validateFieldPlacementLog(log, card) {
  const newBlocks = log.newOperationBlocks || [];
  const blocks = newBlocks.filter(block => block && block.activationKey === card.id);
  if (!blocks.length) {
    throw new Error('M21_FIELD_PLACEMENT_LOG_MISSING');
  }

  const gains = blocks
    .flatMap(block => block.details || [])
    .filter(detail =>
      detail &&
      detail.side === 'SELF' &&
      detail.role === 'HAND_GAIN_CANDIDATE'
    );
  if (gains.length) {
    throw new Error(`M21_FIELD_PLACEMENT_TOO_LATE:DRAW_ALREADY_VISIBLE:${gains.length}`);
  }

  // 历史现场有时同一次落场会呈现多个M21顶格块；只要都还没有抽卡详情，
  // 取最后一个作为场地阶段checkpoint。
  return {
    block: blocks[blocks.length - 1],
    blockCount: blocks.length
  };
}

async function waitForFieldPlacementLog(options) {
  const {
    bridge,
    info,
    card
  } = options;

  await sleep(card.fieldPlacementInitialWaitMs);

  let lastError = null;
  for (let attempt = 1; attempt <= card.fieldPlacementLogAttempts; attempt += 1) {
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      verbose: false,
      allowBacktrack: false,
      performanceFast: true,
      expectedAtomicActivationKey: card.id
    });

    const log = readJson(LOG_RESULT_PATH);
    try {
      const verified = validateFieldPlacementLog(log, card);
      console.log(
        `M21落场日志确认: PASS; M21块=${verified.blockCount}; ` +
        `右栏重读=${attempt}/${card.fieldPlacementLogAttempts}`
      );
      return {
        ...verified,
        log,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;
    }

    if (attempt < card.fieldPlacementLogAttempts) {
      console.log(
        `M21落场动画/右栏尚未追上：纯等待${card.fieldPlacementRetryWaitMs}ms后只重读右栏 ` +
        `(${attempt}/${card.fieldPlacementLogAttempts})。`
      );
      await sleep(card.fieldPlacementRetryWaitMs);
    }
  }

  throw new Error(
    `M21_FIELD_PLACEMENT_LOG_TIMEOUT:${lastError && lastError.message || 'UNKNOWN'}`
  );
}

function commitKnownM21Consumption(beforeState, operation, card, selectedSlot = null) {
  const consumedIndex = selectedSlot == null
    ? (beforeState.cards || []).findIndex(item => item && item.id === card.id)
    : Number(selectedSlot) - 1;
  if (consumedIndex < 0 || beforeState.cards[consumedIndex]?.id !== card.id) {
    throw new Error('M21_FIELD_STAGE_M21_NOT_IN_COMMITTED_HAND');
  }

  const consumed = beforeState.cards[consumedIndex];
  const cards = beforeState.cards
    .filter((_, index) => index !== consumedIndex)
    .map((item, index) => ({ ...item, index: index + 1 }));

  if (!Number.isInteger(beforeState.handCount) || cards.length !== beforeState.handCount - 1) {
    throw new Error(
      `M21_FIELD_STAGE_HAND_INVALID:${beforeState.handCount}/${cards.length}`
    );
  }

  return {
    ...beforeState,
    capturedAt: new Date().toISOString(),
    revision: Number(beforeState.revision || 0) + 1,
    handCount: cards.length,
    cards,
    lastOperation: {
      activationKey: card.id,
      signature: operation && operation.signature
        ? operation.signature
        : 'M21|FIELD_ACTIVATION',
      activationOccurrence: operation && operation.activationOccurrence
        ? operation.activationOccurrence
        : null
    },
    lastIncremental: {
      mode: 'M21_FIELD_ACTIVATION_KNOWN_CONSUMPTION',
      consumed,
      costConsumed: [],
      predictedSlots: [],
      recognized: [],
      finalClicks: []
    }
  };
}

async function clickFieldCardAndVerify(options) {
  const {
    bridge,
    info,
    library,
    templates,
    card,
    debugDir
  } = options;

  const reference = card.fieldCardPoint;
  const physical = mapReferencePoint(info, reference);

  console.log(
    `场上试胆竞速固定位置: MD参考坐标=(${reference.x},${reference.y})；` +
    '沿用此前现场实测场地区。'
  );

  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 280);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const recognized = normalizeRecognized(raw);

  console.log(
    `场地固定位置卡名确认: ${recognized.name}[${recognized.id}] ` +
    `${recognized.accepted ? 'PASS' : 'UNKNOWN'}`
  );

  if (!recognized.accepted || recognized.id !== card.id) {
    throw new Error(
      `M21_FIELD_FIXED_POINT_MISMATCH:${recognized.name}[${recognized.id}];` +
      `point=(${reference.x},${reference.y})`
    );
  }

  // 用户要求的统一安全节奏：点卡确认后不要立刻点下一步按钮。
  console.log(
    `场上M21已精确认：纯等待${card.afterFieldCardVerifyMs}ms后再点“发动效果”。`
  );
  await sleep(card.afterFieldCardVerifyMs);

  return {
    reference,
    recognized
  };
}

async function clickFieldEffectButton(options) {
  const {
    bridge,
    info,
    card,
    debugDir
  } = options;

  const cfg = card.fieldEffectButton;
  const image = await captureReferenceRoi(bridge, info, cfg.roi);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, 'm21_field_effect_button.png'));
  }

  const stats = yellowUsableStats(image);
  const yellowPixels = Number(stats.estimatedYellowPixels || 0);
  const glyphProof = locateFieldActivateIcon(image, stats, cfg.roi, cfg.point);

  console.log(
    `试胆竞速“发动效果”预期位置与图案检查: yellowPixels=${yellowPixels}; ` +
    `reference=(${cfg.point.x},${cfg.point.y})`
  );

  if (!glyphProof.chosen) {
    throw new Error(
      `M21_FIELD_EFFECT_BUTTON_NOT_PROVEN:${yellowPixels}/${cfg.minYellowPixels}`
    );
  }

  const reference = { x: cfg.roi.x + glyphProof.chosen.centerX, y: cfg.roi.y + glyphProof.chosen.centerY };
  const physical = mapReferencePoint(info, reference);
  if (options.beforeSubmit) options.beforeSubmit();
  await bridge.click(physical.x, physical.y);
  console.log(
    `试胆竞速场上“发动效果”: 已点击局部真实图标 (${reference.x},${reference.y})`
  );
  const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
  const priority = await waitForSelfPriorityBlue({
    bridge,
    info,
    label: 'AFTER_M21_FIELD_EFFECT_ACTIVATION_RESPONSE_BOUNDARY',
    timeoutMs: 30000
  });

  return {
    reference,
    glyphProof,
    yellowPixels,
    responseBoundaryPriority: priority
  };
}

function proveFirstDrawTab(image, origin = { x: 0, y: 0 }) {
  const underlineRatios = [226, 568, 910].map(cx => {
    let lime = 0, total = 0;
    for (let x = cx - 90; x < cx + 90; x += 2) {
      const px = x - origin.x, py = 161 - origin.y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) return 0;
      const i = (py * image.width + px) * 4;
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (r >= 130 && g >= 190 && b <= 100 && g - b >= 100) lime++;
      total++;
    }
    return lime / Math.max(1, total);
  });
  const ratios = [226, 568, 910].map(cx => {
    let lime = 0, total = 0;
    for (let y = 127; y < 148; y += 2) for (let x = cx - 70; x < cx + 70; x += 2) {
      const px = x - origin.x, py = y - origin.y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) return 0;
      const i = (py * image.width + px) * 4;
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (r >= 80 && g >= 110 && b <= 100 && g - b >= 60) lime++;
      total++;
    }
    return lime / Math.max(1, total);
  });
  const tabStripProven = underlineRatios.every(value => value >= 0.70);
  const selectedTabs = ratios.map((value, i) => value >= 0.60 ? i + 1 : 0).filter(Boolean);
  const selectedTab = tabStripProven && selectedTabs.length === 1 ? selectedTabs[0] : null;
  return { selected: selectedTab === 1 && ratios[1] < 0.25 && ratios[2] < 0.25,
    selectedTab, tabStripProven, underlineRatios, tabLimeRatios: ratios,
    detector: 'M21_FIRST_DRAW_TAB_SELECTED_V1' };
}

async function waitForDrawOptionDialog(options) {
  const {
    bridge,
    info,
    card,
    debugDir
  } = options;
  const cfg = card.drawOptionDialog;
  const started = Date.now();
  let bestDark = 0;
  let bestOkYellow = 0;

  while (Date.now() - started < cfg.timeoutMs) {
    const body = await captureReferenceRoi(bridge, info, cfg.bodyRoi);
    // The button is contained in the body ROI. One frame proves the window,
    // selected effect and OK together; never merge cues from different frames.
    const ok = cropImage(body, { x: cfg.okRoi.x - cfg.bodyRoi.x, y: cfg.okRoi.y - cfg.bodyRoi.y,
      width: cfg.okRoi.width, height: cfg.okRoi.height });

    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(body, path.join(debugDir, 'm21_draw_option_body_latest.png'));
      saveRgbaPng(ok, path.join(debugDir, 'm21_draw_option_ok_latest.png'));
    }

    const darkRatio = imageDarkRatio(body, 86);
    const okStats = yellowUsableStats(ok);
    const okYellowPixels = Number(okStats.estimatedYellowPixels || 0);
    const drawOneProof = proveFirstDrawTab(body);
    bestDark = Math.max(bestDark, darkRatio);
    bestOkYellow = Math.max(bestOkYellow, okYellowPixels);

    if (
      darkRatio >= cfg.minDarkRatio &&
      okYellowPixels >= cfg.minOkYellowPixels
    ) {
      console.log(
        `试胆竞速抽1选项窗口: PASS; darkRatio=${darkRatio.toFixed(3)}; ` +
        `okYellowPixels=${okYellowPixels}`
      );
      if (drawOneProof.selectedTab === 2 || drawOneProof.selectedTab === 3) {
        throw new Error('M21_DRAW_ONE_NOT_SELECTED:不猜默认选项，不点击OK。');
      }
      if (!drawOneProof.selected) { await sleep(120); continue; }
      return {
        darkRatio,
        okYellowPixels,
        drawOneProof
      };
    }

    // 只截图等待，不发送任何输入。
    await sleep(120);
  }

  throw new Error(
    `M21_DRAW_OPTION_DIALOG_TIMEOUT:bestDark=${bestDark.toFixed(3)};` +
    `bestOkYellow=${bestOkYellow}`
  );
}

async function confirmDefaultDrawOne(options) {
  const {
    bridge,
    info,
    card,
    debugDir
  } = options;

  const proof = await waitForDrawOptionDialog({
    bridge,
    info,
    card,
    debugDir
  });

  // Preserve the proven first Draw1 tab without clicking tabs speculatively.
  // Its selected state must be observed, not inferred from the old default.
  console.log(
    `试胆竞速抽1默认项保持不动：纯等待${card.afterDrawDialogProofMs}ms后再点击OK。`
  );
  await sleep(card.afterDrawDialogProofMs);

  // Use the capture saved by same-frame body/OK probing for a final, small tab
  // check after the existing wait. Normal capture count remains two; no new
  // hand scan, fixed wait, image file or speculative tab click is introduced.
  const bodyRoi = card.drawOptionDialog.bodyRoi;
  const tabOrigin = { x: 60, y: 115 };
  const tabRoi = { x: bodyRoi.x + 60, y: bodyRoi.y + 115, width: 1020, height: 49 };
  const tabs = await captureReferenceRoi(bridge, info, tabRoi);
  const finalDrawOneProof = proveFirstDrawTab(tabs, tabOrigin);
  if (!finalDrawOneProof.selected) throw new Error('M21_DRAW_ONE_SELECTION_CHANGED:确认前选项改变，保留现场。');

  const reference = card.drawOptionDialog.okPoint;
  const physical = mapReferencePoint(info, reference);
  if (options.beforeSubmit) options.beforeSubmit();
  await bridge.click(physical.x, physical.y);

  console.log(
    `试胆竞速抽1: 已点击 OK @(${reference.x},${reference.y})；` +
    `随后纯等待${card.settleAfterDrawConfirmMs}ms。`
  );

  await sleep(card.settleAfterDrawConfirmMs);

  return {
    ...proof,
    finalDrawOneProof,
    confirmPoint: reference,
    policy: 'DEFAULT_DRAW1_FIXED_OK'
  };
}

function validateFinalDraw(options) {
  const {
    baselineHandCount,
    card
  } = options;

  const log = readJson(LOG_RESULT_PATH);
  const incremental = readJson(INCREMENTAL_RESULT_PATH);
  const newBlocks = log.newOperationBlocks || [];
  const m21Blocks = newBlocks.filter(block => block && block.activationKey === card.id);

  const gainRows = m21Blocks
    .flatMap(block => block.details || [])
    .filter(detail =>
      detail &&
      detail.side === 'SELF' &&
      detail.role === 'HAND_GAIN_CANDIDATE'
    );

  if (!m21Blocks.length || gainRows.length !== 1) {
    throw new Error(
      `M21_FINAL_LOG_INVALID:blocks=${m21Blocks.length};gains=${gainRows.length}`
    );
  }

  const drawn = normalizeExodiaComponentCard(gainRows[0] && gainRows[0].card);
  if (!drawn || (!/^M\d+$/.test(String(drawn.id || '')) && !isExodiaComponentId(drawn.id))) {
    throw new Error(`M21_FINAL_DRAW_CARD_INVALID:${drawn && drawn.id || 'UNKNOWN'}`);
  }

  const drawBlock = m21Blocks.find(block => (block.details || []).includes(gainRows[0]));
  const relationship = drawBlock && drawBlock.relationship && drawBlock.relationship.type;
  if (!options.effectContext && relationship && relationship !== 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD') {
    throw new Error(`M21_FINAL_RELATIONSHIP_INVALID:${relationship}`);
  }

  if (!incremental || incremental.status !== 'PASS') {
    throw new Error(`M21_FINAL_INCREMENTAL_NOT_PASS:${incremental && incremental.status}`);
  }

  const beforeCount = incremental.before && incremental.before.handCount;
  const after = incremental.after || {};
  const inserted = incremental.insertedCards || [];

  if (beforeCount !== baselineHandCount - 1) {
    throw new Error(
      `M21_FINAL_INTERMEDIATE_COUNT_INVALID:${beforeCount}/${baselineHandCount - 1}`
    );
  }
  if (after.handCount !== baselineHandCount) {
    throw new Error(
      `M21_FINAL_HAND_COUNT_INVALID:${after.handCount}/${baselineHandCount}`
    );
  }
  if (
    inserted.length !== 1 ||
    !inserted.some(item => item && item.card && sameRuntimeCardIdentity(item.card, drawn))
  ) {
    throw new Error(`M21_FINAL_INSERTED_INVALID:${inserted.length}/${drawn.id}`);
  }

  const effectReceipt = options.effectContext && require('../../../src/core/effect-receipt').verifyOwnedFieldGain({
    ...options.effectContext, cardId: card.id, log, incremental,
    identity: value => { const normalized = normalizeExodiaComponentCard(value); return normalized && normalized.id; }
  });

  return {
    drawn,
    effectReceipt: effectReceipt || null,
    relationship: relationship || null,
    beforeCount,
    afterCount: after.handCount,
    inserted,
    finalHand: after.cards || []
  };
}

module.exports = {
  LOG_RESULT_PATH,
  INCREMENTAL_RESULT_PATH,
  validateFieldPlacementLog,
  waitForFieldPlacementLog,
  commitKnownM21Consumption,
  clickFieldCardAndVerify,
  clickFieldEffectButton,
  waitForDrawOptionDialog,
  proveFirstDrawTab,
  confirmDefaultDrawOne,
  validateFinalDraw
};
