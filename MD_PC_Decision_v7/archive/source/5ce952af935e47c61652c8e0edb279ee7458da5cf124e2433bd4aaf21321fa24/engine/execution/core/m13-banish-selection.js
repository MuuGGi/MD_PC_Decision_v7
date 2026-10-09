'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { buildAllureBanishPriority } = require(path.join(ROOT, 'lib', 'allure-policy'));
const { EXODIA_UNKNOWN_ID } = require(path.join(ROOT, 'lib', 'exodia-policy'));
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
const { waitBeforePromptSubmit } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-submit-timing'
));
const {
  recognizeCurrentCard,
  saveRgbaPng
} = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { detectCandidateCenters } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-candidate-centers'
));

// Mature M13 dedicated prompt geometry from the previous executor.  This is a
// special selection dialog, not the normal hand fan and not DENSE.
const M13_BANISH_PROMPT = {
  headerRoi: { x: 650, y: 720, width: 750, height: 80 },
  candidateRoi: { x: 490, y: 770, width: 1080, height: 270 },
  candidateY: 925,
  clickYOffset: 0,
  timeoutMs: 8000
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}



// The strip includes ordinary hand cards beside smaller dialogs. Derive the
// dialog interior from the empty band ABOVE the cards. The bottom band can
// contain a horizontal scrollbar when many DARK candidates are present.
function candidateRoiForImage(image) {
  // Retain support for saved compact-strip captures and their old border proof.
  return image && image.width === 970 && image.height === 250
    ? { x: 540, y: 790, width: 970, height: 250 }
    : M13_BANISH_PROMPT.candidateRoi;
}

function detectM13DialogBounds(image) {
  const roi = candidateRoiForImage(image);
  if (!image || image.width !== roi.width || image.height !== roi.height ||
      !image.data || image.data.length !== image.width * image.height * 4) return null;
  const darkColumns = [];
  const compact = roi.width === 970;
  for (let x = 0; x < image.width; x++) {
    let dark = 0;
    for (let y = compact ? image.height - 8 : 5; y < (compact ? image.height : 18); y++) {
      const offset = (y * image.width + x) * 4;
      if (Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2]) < 86) dark++;
    }
    darkColumns[x] = dark >= (compact ? 7 : 12);
  }
  const center = 1024 - roi.x;
  if (!darkColumns[center]) return null;
  let left = center;
  let right = center;
  while (left > 0 && darkColumns[left - 1]) left--;
  while (right < image.width - 1 && darkColumns[right + 1]) right++;
  const width = right - left + 1;
  // Both borders must be visible; a dark full strip is not a dialog proof.
  if (left === 0 || right === image.width - 1 || width < 650 || width > (compact ? 950 : 1040) ||
      Math.abs((left + right) / 2 - center) > 8) return null;
  return { left: roi.x + left, right: roi.x + right, width };
}

function detectM13BanishCandidateCenters(image) {
  const dialogBounds = detectM13DialogBounds(image);
  if (!dialogBounds) return [];
  const points = detectCandidateCenters(image, candidateRoiForImage(image),
    M13_BANISH_PROMPT.candidateY, { mode: 'components' }) || [];
  return points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Number.isFinite(point.width) && point.width >= 60 &&
    point.x - point.width / 2 >= dialogBounds.left &&
    point.x + point.width / 2 <= dialogBounds.right)
    .sort((a, b) => a.x - b.x);
}

async function captureBanishCandidateCenters({ bridge, info, debugDir, label }) {
  const image = await captureReferenceRoi(bridge, info, M13_BANISH_PROMPT.candidateRoi);
  const points = detectM13BanishCandidateCenters(image);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, `m13_banish_candidates_${label}.png`));
    fs.writeFileSync(path.join(debugDir, `m13_banish_geometry_${label}.json`),
      JSON.stringify({ dialogBounds: detectM13DialogBounds(image), points }, null, 2) + '\n');
  }
  return points;
}

async function waitForBanishPrompt({ bridge, info, debugDir }) {
  const started = Date.now();
  let attempt = 0;
  let bestHeader = 0;
  let bestCandidates = 0;

  while (Date.now() - started < M13_BANISH_PROMPT.timeoutMs) {
    attempt++;

    const header = await captureReferenceRoi(
      bridge,
      info,
      M13_BANISH_PROMPT.headerRoi
    );
    const headerDark = imageDarkRatio(header, 86);
    bestHeader = Math.max(bestHeader, headerDark);

    const points = await captureBanishCandidateCenters({
      bridge,
      info,
      debugDir,
      label: String(attempt).padStart(2, '0')
    });
    bestCandidates = Math.max(bestCandidates, points.length);

    if (debugDir && (attempt === 1 || (headerDark >= 0.68 && points.length >= 1))) {
      saveRgbaPng(
        header,
        path.join(debugDir, `m13_banish_header_${String(attempt).padStart(2, '0')}.png`)
      );
    }

    // Same mature proof used by the previous M13 special branch: dark prompt
    // header + at least one full-card candidate in the dedicated strip.
    if (headerDark >= 0.68 && points.length >= 1) {
      console.log(
        `暗之诱惑除外窗口: PASS; ` +
        `headerDark=${headerDark.toFixed(3)}; candidates=${points.length}`
      );
      return {
        attempts: attempt,
        headerDarkRatio: headerDark,
        candidateCount: points.length,
        points
      };
    }

    await sleep(120);
  }

  throw new Error(
    `M13_BANISH_PROMPT_TIMEOUT:` +
    `bestHeader=${bestHeader.toFixed(3)};bestCandidates=${bestCandidates}`
  );
}

async function waitForSingleCandidateResolution({ bridge, info, debugDir }) {
  let consecutiveMissing = 0;
  let lastCandidateCount = 1;

  // A one-card Master Duel selection prompt may submit immediately when that
  // card is clicked. Observe the prompt after the click; never click the old
  // card coordinate a second time after the dialog may have disappeared.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await sleep(120);
    const points = await captureBanishCandidateCenters({
      bridge,
      info,
      debugDir,
      label: `single_after_${String(attempt).padStart(2, '0')}`
    });
    lastCandidateCount = points.length;
    consecutiveMissing = points.length === 0 ? consecutiveMissing + 1 : 0;
    if (consecutiveMissing >= 2) {
      return {
        autoSubmitted: true,
        attempts: attempt,
        consecutiveMissing
      };
    }
  }

  return {
    autoSubmitted: false,
    attempts: 6,
    lastCandidateCount
  };
}

async function confirmCurrentDialogSelection({ bridge, info, debugDir, label }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.point || !cfg.roi) {
    throw new Error('M13_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const started = Date.now();
  let lastYellow = 0;

  // IMPORTANT: the candidate is already physically selected.  This loop only
  // retries observing/clicking the submit button.  It never re-clicks the card.
  while (Date.now() - started < 3500) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;

    if (debugDir) {
      saveRgbaPng(image, path.join(debugDir, 'm13_banish_confirm_latest.png'));
    }

    const enoughTotal =
      stats.estimatedYellowPixels >= (cfg.minYellowPixels || 600);
    const enoughComponent =
      stats.buttonComponent &&
      stats.buttonComponent.estimatedPixels >=
        ((cfg.minButtonPixels || cfg.minYellowPixels || 600) * 0.4);

    if (enoughTotal || enoughComponent) {
      const point = mapReferencePoint(info, cfg.point);
      await bridge.click(point.x, point.y);
      console.log(`${label}: 已点击底部“选择/确认”；yellowPixels=${lastYellow}`);
      return {
        yellowPixels: lastYellow,
        point: cfg.point
      };
    }

    await sleep(120);
  }

  throw new Error(
    `M13_BANISH_CONFIRM_NOT_PROVEN:yellow=${lastYellow};` +
    '候选牌已选中，只允许重试确认按钮，禁止重新点击候选牌。'
  );
}

async function selectM13BanishTarget(options) {
  const {
    bridge,
    info,
    library,
    templates,
    priority,
    plannedBeforeActivation,
    lastResort,
    onBeforeSubmit,
    debugDir
  } = options;

  const safePriority = Array.isArray(priority) && priority.length
    ? priority
    : buildAllureBanishPriority();

  const promptProof = await waitForBanishPrompt({ bridge, info, debugDir });

  // Re-capture after the prompt is stable so the centers belong to the final
  // prompt layout, rather than to an animation frame.
  const points = await captureBanishCandidateCenters({
    bridge,
    info,
    debugDir,
    label: 'stable'
  });

  console.log(
    `暗之诱惑合法除外候选中心: ` +
    `${points.map(point => `(${Math.round(point.x)},${Math.round(point.y)})`).join(', ') || 'NONE'}`
  );

  if (!points.length) throw new Error('M13_BANISH_CANDIDATES_EMPTY');

  const highestId = safePriority[0] && safePriority[0].id;
  const fallbackId = safePriority[1] && safePriority[1].id;
  const seen = [];
  let fallback = null;

  // ISSUE-110: with exactly one legal DARK candidate, Master Duel can submit
  // immediately on the first card click. The old multi-candidate scanner then
  // clicked the obsolete coordinate again while trying to toggle H.A.M.P. off
  // and later misread the already activated Allure in the normal hand area.
  // The pre-activation baseline has already proved the safe M06/M08 card, and
  // one prompt candidate proves that this surviving safe DARK is the sole
  // legal choice. Click once, then only observe whether the prompt disappeared.
  const plannedId = String(plannedBeforeActivation && plannedBeforeActivation.id || '');
  const plannedRank = plannedId === highestId ? 1 : (plannedId === fallbackId ? 2 : 0);
  if (points.length === 1 && lastResort !== true && plannedRank > 0) {
    const selected = {
      id: plannedId,
      name: plannedBeforeActivation.name || plannedId,
      accepted: true,
      source: 'PREACTIVATION_SAFE_SINGLE_CANDIDATE'
    };
    const ref = {
      x: points[0].x,
      y: points[0].y + M13_BANISH_PROMPT.clickYOffset
    };
    const physical = mapReferencePoint(info, ref);

    // If a caller maintains a transaction checkpoint, persist it before the
    // only click because that click itself may be the irreversible submit.
    if (onBeforeSubmit) await onBeforeSubmit({ selected, promptProof,
      submitMode: 'SINGLE_CANDIDATE_MAY_AUTO_SUBMIT' });
    await bridge.click(physical.x, physical.y);
    await sleep(config.toonChain.selectSettleMs || 260);
    seen.push({ candidateIndex: 1, clickReference: ref, card: selected,
      identityProof: 'SOLE_PROMPT_CANDIDATE_PLUS_PREACTIVATION_SAFE_CARD' });

    const resolution = await waitForSingleCandidateResolution({ bridge, info, debugDir });
    let confirmProof;
    if (resolution.autoSubmitted) {
      confirmProof = {
        mode: 'SINGLE_CANDIDATE_AUTO_SUBMITTED',
        ...resolution
      };
      console.log(
        `暗之诱惑唯一候选: ${selected.name}[${selected.id}]；` +
        '单击后窗口连续消失，确认游戏已自动提交；禁止再次点击旧候选坐标。'
      );
    } else {
      await waitBeforePromptSubmit('暗之诱惑唯一候选');
      confirmProof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir,
        label: '暗之诱惑唯一候选'
      });
      confirmProof.mode = 'SINGLE_CANDIDATE_EXPLICIT_CONFIRM';
    }

    return {
      promptProof,
      selected,
      candidateIndex: 1,
      priorityRank: plannedRank,
      plannedBeforeActivation,
      seen,
      confirmProof,
      policy: 'M06_THEN_M08_SINGLE_CANDIDATE_ONE_CLICK'
    };
  }

  // Preserve the mature M13 behavior: scan the dedicated prompt right -> left;
  // every clicked candidate is identified through the left detail panel.  Any
  // non-final candidate is immediately toggled OFF by clicking the exact same
  // coordinate once.  No adjacent candidate fallback is ever used.
  for (let i = points.length - 1; i >= 0; i--) {
    const ref = {
      x: points[i].x,
      y: points[i].y + M13_BANISH_PROMPT.clickYOffset
    };
    const physical = mapReferencePoint(info, ref);

    await bridge.click(physical.x, physical.y);
    await sleep(config.toonChain.selectSettleMs || 260);

    const raw = await recognizeCurrentCard(
      bridge,
      info,
      library,
      templates,
      { stableAcceptedSamples: 2 }
    );
    const card = normalizeRecognized(raw);

    seen.push({
      candidateIndex: i + 1,
      clickReference: ref,
      card
    });

    console.log(
      `暗之诱惑候选${i + 1}: ${card.name}[${card.id}] ` +
      `${card.accepted ? 'PASS' : 'UNKNOWN'}`
    );

    if (card.accepted && card.id === highestId) {
      console.log(
        `除外优先级命中: ${card.name}[${card.id}]；保持选中，不再扫描低优先级候选。`
      );
      await waitBeforePromptSubmit('暗之诱惑除外目标');
      if (onBeforeSubmit) await onBeforeSubmit({ selected: card, promptProof });
      const confirmProof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir,
        label: '暗之诱惑除外目标'
      });
      return {
        promptProof,
        selected: card,
        candidateIndex: i + 1,
        priorityRank: 1,
        plannedBeforeActivation,
        seen,
        confirmProof,
        policy: 'M06_THEN_M08_DEDICATED_PROMPT'
      };
    }

    if (card.accepted && fallbackId && card.id === fallbackId && !fallback) {
      fallback = {
        candidateIndex: i + 1,
        clickReference: ref,
        card
      };
    }

    // Not final: restore this exact candidate to unselected before moving on.
    await bridge.click(physical.x, physical.y);
    await sleep(150);
    console.log(`  候选${i + 1}不是最终目标：同点恢复为未选中。`);
  }

  if (lastResort === true) {
    if (seen.some(row => !row.card.accepted || !row.card.id || row.card.id === 'UNKNOWN')) {
      throw new Error('M13_LAST_RESORT_CANDIDATE_UNKNOWN_NO_RAYE_NOT_PROVEN');
    }
    const darkIds = new Set(['M01', 'M02', 'M03', 'M04', 'M05', EXODIA_UNKNOWN_ID, 'M06', 'M08']);
    if (seen.some(row => !darkIds.has(row.card.id))) {
      throw new Error('M13_LAST_RESORT_NON_DARK_CANDIDATE_WRONG_PROMPT');
    }
    // All candidates must be known before accepting the HAMP fallback.
    // Components are always protected, but a precisely identified HAMP is safe.
    if (!fallback) return { status: 'NO_SAFE_DARK_IN_PROMPT', promptProof, seen,
      policy: 'LAST_RESORT_M06_THEN_M08_OR_SURRENDER' };
  }

  // No M06 found.  Re-select the previously verified M08 and verify identity
  // once more before allowing the submit button.
  if (fallback) {
    const physical = mapReferencePoint(info, fallback.clickReference);
    await bridge.click(physical.x, physical.y);
    await sleep(config.toonChain.selectSettleMs || 260);

    const raw = await recognizeCurrentCard(
      bridge,
      info,
      library,
      templates,
      { stableAcceptedSamples: 2 }
    );
    const card = normalizeRecognized(raw);

    if (!card.accepted || card.id !== fallbackId) {
      throw new Error(
        `M13_FALLBACK_RESELECT_MISMATCH:` +
        `${card.name}[${card.id}];expected=${fallbackId}`
      );
    }

    console.log(
      `未发现${safePriority[0].name}[${highestId}]；回到后备目标 ` +
      `${card.name}[${card.id}] @候选${fallback.candidateIndex}`
    );

    await waitBeforePromptSubmit('暗之诱惑除外目标');
    if (onBeforeSubmit) await onBeforeSubmit({ selected: card, promptProof });
    const confirmProof = await confirmCurrentDialogSelection({
      bridge,
      info,
      debugDir,
      label: '暗之诱惑除外目标'
    });

    return {
      promptProof,
      selected: card,
      candidateIndex: fallback.candidateIndex,
      priorityRank: 2,
      plannedBeforeActivation,
      seen,
      confirmProof,
      policy: 'M06_THEN_M08_DEDICATED_PROMPT'
    };
  }

  throw new Error(
    `M13_NO_SAFE_BANISH_TARGET_IN_PROMPT:` +
    `${seen.map(row => `${row.card.name}[${row.card.id}]`).join('|') || 'NONE'}`
  );
}

module.exports = {
  M13_BANISH_PROMPT,
  detectM13DialogBounds,
  detectM13BanishCandidateCenters,
  waitForBanishPrompt,
  selectM13BanishTarget
};
