'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  buildBambooSearchPriority, chooseBambooSearchTarget
} = require(path.join(ROOT, 'lib', 'bamboo-search-policy'));
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
const {
  recognizeCurrentCard,
  saveRgbaPng
} = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const {
  detectCandidateCenters
} = require(path.join(ROOT, 'execution', 'core', 'prompt-candidate-centers'));
const {
  waitBeforePromptSubmit
} = require(path.join(ROOT, 'execution', 'core', 'prompt-submit-timing'));
const {
  OPTIONAL_EFFECT_PROMPT,
  probeOptionalEffectPrompt
} = require(path.join(ROOT, 'execution', 'core', 'optional-effect-prompt-observer'));
const {
  BAMBOO_TARGET_PROMPT,
  probeBambooSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'bamboo-search-target-prompt-observer'));

const M19 = { id: 'M19', name: '妖刀竹光' };
const { sameCandidates, sameBambooSelectionLayout, createPromptStabilityGate } = require('./m19-deck-prompt-proof');
const BAMBOO_PRIORITY = buildBambooSearchPriority();
const OPTIONAL_SELECT_EXPECTED =
  config.extraDeck && config.extraDeck.summonDialog && config.extraDeck.summonDialog.confirmPoint ||
  { x: 1178, y: 1088 };
const OPTIONAL_SELECT_ROI = { x: 1030, y: 1025, width: 340, height: 120 };
const OPTIONAL_CANCEL_EXPECTED = { x: 870, y: 1088 };
const OPTIONAL_CANCEL_ROI = { x: 690, y: 1025, width: 340, height: 120 };

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}


async function captureCandidatePoints({ bridge, info, roi, candidateY, debugPath = null }) {
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
  return points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

async function recognizeAt({ bridge, info, library, templates, reference, label }) {
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
  console.log(`${label}: ${recognized.name}[${recognized.id}] ${recognized.accepted ? 'PASS' : 'UNKNOWN'}`);
  return recognized;
}

function chooseYellowComponent(stats, roi, expected, options = {}) {
  const expectedLocal = {
    x: expected.x - roi.x,
    y: expected.y - roi.y
  };
  return (stats.components || [])
    .filter(c =>
      c.estimatedPixels >= (options.minPixels || 80) &&
      c.width >= (options.minWidth || 12) &&
      c.height >= (options.minHeight || 8)
    )
    .map(c => ({
      ...c,
      drift: Math.hypot(c.centerX - expectedLocal.x, c.centerY - expectedLocal.y)
    }))
    .filter(c => c.drift <= (options.maxDrift || 150))
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
      const reference = {
        x: roi.x + lastChosen.centerX,
        y: roi.y + lastChosen.centerY
      };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `${label}: PASS; yellow=${lastYellow}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return { clickReference: reference, yellowPixels: lastYellow, component: lastChosen };
    }
    await sleep(120);
  }
  throw new Error(`${label}_NOT_PROVEN:yellow=${lastYellow};component=${lastChosen ? 1 : 0}`);
}

async function waitOptionalPool({ bridge, info, debugDir, timeoutMs = 6000 }) {
  const started = Date.now();
  let attempt = 0;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    last = await probeOptionalEffectPrompt({
      bridge,
      info,
      debugDir,
      suffix: `d3_optional_${String(attempt).padStart(2, '0')}`
    });
    if (last.visible) return { ...last, attempts: attempt };
    await sleep(140);
  }
  throw new Error(`D3_OPTIONAL_POOL_NOT_VISIBLE:lastCandidates=${last && last.candidateCount || 0}`);
}

async function selectM19FromOptionalPool({ bridge, info, library, templates, debugDir, expectedPoolCount = null }) {
  const pool = await waitOptionalPool({ bridge, info, debugDir });
  if (expectedPoolCount !== null && Number(pool.candidateCount) !== expectedPoolCount) {
    throw new Error('M19_OPTIONAL_POOL_COUNT_CHANGED:zero_input=1');
  }
  const points = await captureCandidatePoints({
    bridge,
    info,
    roi: OPTIONAL_EFFECT_PROMPT.candidateRoi,
    candidateY: OPTIONAL_EFFECT_PROMPT.candidateY,
    debugPath: debugDir && path.join(debugDir, 'optional_candidates_actual.png')
  });
  if (!points.length) throw new Error('D3_OPTIONAL_POOL_NO_REAL_CANDIDATE_FRAMES');

  const seen = [];
  for (let index = 0; index < points.length; index++) {
    const reference = { x: points[index].x, y: points[index].y };
    const recognized = await recognizeAt({
      bridge,
      info,
      library,
      templates,
      reference,
      label: `可选效果候选${index + 1}`
    });
    seen.push({ index: index + 1, reference, recognized });

    if (recognized.accepted && recognized.id === M19.id) {
      console.log('可选效果池已精确认妖刀竹光；保持选中，不再点击候选。');
      await waitBeforePromptSubmit('妖刀墓地检索效果');
      const submitProof = await clickYellowButton({
        bridge,
        info,
        roi: OPTIONAL_SELECT_ROI,
        expected: OPTIONAL_SELECT_EXPECTED,
        debugPath: debugDir && path.join(debugDir, 'optional_select_latest.png'),
        label: '妖刀效果“选择”按钮'
      });
      return {
        pool,
        selected: recognized,
        selectedIndex: index + 1,
        selectedReference: reference,
        submitProof,
        seen
      };
    }

    // 非妖刀候选必须恢复未选中，防止多选残留。
    const physical = mapReferencePoint(info, reference);
    await bridge.click(physical.x, physical.y);
    await sleep(150);
    console.log(`  候选${index + 1}不是妖刀：同点恢复未选中。`);
  }

  throw new Error(
    `D3_M19_OPTIONAL_EFFECT_NOT_FOUND:` +
    `${seen.map(row => `${row.recognized.name}[${row.recognized.id}]`).join('|') || 'NONE'}`
  );
}

async function clickRemainingOptionalCancel({ bridge, info, debugDir }) {
  return clickYellowButton({
    bridge,
    info,
    roi: OPTIONAL_CANCEL_ROI,
    expected: OPTIONAL_CANCEL_EXPECTED,
    debugPath: debugDir && path.join(debugDir, 'optional_cancel_latest.png'),
    label: '剩余可选效果“取消”按钮'
  });
}

async function waitForBambooPromptAfterM19({
  bridge,
  info,
  originalCandidateCount,
  debugDir,
  timeoutMs = 30000,
  skipRemainingOptionalCancel = false
}) {
  const started = Date.now();
  let attempt = 0;
  let remainingCancelled = false;
  let lastBamboo = null;
  const stabilize = createPromptStabilityGate(3);

  // M19 was just submitted. Give MD a short input-free interval before deciding
  // whether a visible optional pool is genuinely the remaining pool.
  await sleep(650);

  while (Date.now() - started < timeoutMs) {
    attempt++;
    lastBamboo = await probeBambooSearchTargetPrompt({
      bridge,
      info,
      debugDir,
      suffix: `d3_bamboo_wait_${String(attempt).padStart(2, '0')}`
    });
    const stableProof = stabilize(lastBamboo.modalProof);
    if (stableProof.ready) {
      console.log(
        `妖刀竹光检索对象窗口: PASS; candidates=${lastBamboo.candidateCount}; ` +
        `detector=${lastBamboo.detector}`
      );
      return { prompt: { ...lastBamboo, modalProof: stableProof }, remainingCancelled, attempts: attempt };
    }

    // A stable card strip alone may just be our hand behind a chain animation.
    // Dual chains have already selected BOTH effects: never cancel here.
    if (!lastBamboo.visible && !skipRemainingOptionalCancel &&
        !remainingCancelled && Number(originalCandidateCount || 0) > 1) {
      const optional = await probeOptionalEffectPrompt({
        bridge,
        info,
        debugDir,
        suffix: `d3_remaining_optional_${String(attempt).padStart(2, '0')}`
      });
      // Only cancel after the pool has actually shrunk. This avoids treating the
      // just-submitted original modal as a new remaining-effect prompt.
      if (
        optional.visible &&
        optional.candidateCount >= 1 &&
        optional.candidateCount < Number(originalCandidateCount)
      ) {
        console.log(
          `妖刀已进入连锁；仍有${optional.candidateCount}个其他可选效果。` +
          'D3隔离测试只取消剩余效果，不重新点击妖刀。'
        );
        await clickRemainingOptionalCancel({ bridge, info, debugDir });
        remainingCancelled = true;
        stabilize({ pass: false, points: [] });
        await sleep(650);
      }
    }

    await sleep(160);
  }

  throw new Error(
    `D3_BAMBOO_TARGET_PROMPT_TIMEOUT:lastCandidates=${Number(lastBamboo && lastBamboo.candidateCount || 0)};` +
    `modal_not_proven=1;remainingCancelled=${remainingCancelled ? 1 : 0}`
  );
}

async function confirmCurrentSearchSelection({ bridge, info, debugDir, label, beforeClick }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.point || !cfg.roi) {
    throw new Error('D3_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const started = Date.now();
  let lastYellow = 0;
  while (Date.now() - started < 4000) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'm19_bamboo_confirm_latest.png'));
    }
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    const enoughTotal = lastYellow >= (cfg.minYellowPixels || 650);
    const enoughComponent = stats.buttonComponent &&
      stats.buttonComponent.estimatedPixels >= ((cfg.minButtonPixels || cfg.minYellowPixels || 650) * 0.4);
    if (enoughTotal || enoughComponent) {
      await beforeClick();
      const physical = mapReferencePoint(info, cfg.point);
      await bridge.click(physical.x, physical.y);
      console.log(`${label}: 已点击底部“选择”；yellowPixels=${lastYellow}`);
      return { yellowPixels: lastYellow, point: cfg.point };
    }
    await sleep(120);
  }

  throw new Error(
    `D3_BAMBOO_CONFIRM_NOT_PROVEN:yellow=${lastYellow};` +
    '竹光候选已经选中，只允许重试底部“选择”，禁止重新点击候选牌。'
  );
}

async function selectBambooSearchTarget({ bridge, info, library, templates, debugDir, timeoutMs = 30000, targetId = null, state = null }) {
  if (targetId !== null && !['M20', 'M14'].includes(targetId)) throw new Error('BAMBOO_FIXED_TARGET_INVALID:zero_input=1');
  // This is also an independently callable entry point. Re-establish the
  // stable modal here; no earlier wait or blue priority light authorizes input.
  const ready = await waitForBambooPromptAfterM19({ bridge, info, debugDir,
    originalCandidateCount: 0, skipRemainingOptionalCancel: true, timeoutMs });
  const points = ready.prompt.modalProof.points;
  let selectedReference = null;
  const beforeClick = async () => {
    const current = await probeBambooSearchTargetPrompt({ bridge, info, debugDir,
      suffix: 'before_input' });
    const layoutMatches = selectedReference
      ? sameBambooSelectionLayout(ready.prompt.modalProof, current.modalProof, selectedReference)
      : sameCandidates(ready.prompt.modalProof, current.modalProof);
    if (!current.visible || !layoutMatches) {
      throw new Error('D3_BAMBOO_PROMPT_CHANGED_BEFORE_CLICK');
    }
  };

  if (!targetId) {
    const { readJson } = require('../../lib/runtime-files');
    const currentHand = state || readJson(path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json'));
    if (!Array.isArray(currentHand.cards)) throw new Error('BAMBOO_CURRENT_HAND_REQUIRED:zero_input=1');
    const runtime = readJson(path.join(ROOT, 'decision-state.json'));
    const deck = require('../../lib/decision-engine').buildDeckState(library, currentHand.cards, runtime);
    const choice = chooseBambooSearchTarget({ deckRemaining: deck.deckRemaining, handCards: currentHand.cards });
    if (!choice.id) throw new Error('BAMBOO_CURRENT_TARGET_UNAVAILABLE:zero_input=1');
    targetId = choice.id;
    console.log(`竹光共同检索分叉：${targetId}; ${choice.reason}`);
  }
  const rankById = new Map([[targetId, 1]]);
  const seen = [];
  let fallback = null;
  const traversalPoints = points.slice().sort((a, b) => b.x - a.x);
  console.log(
    `妖刀检索候选按从右向左确认: ` +
    `${traversalPoints.map(point => `(${Math.round(point.x)},${Math.round(point.y)})`).join(', ')}`
  );

  for (let index = 0; index < traversalPoints.length; index++) {
    const reference = { x: traversalPoints[index].x, y: traversalPoints[index].y };
    await beforeClick();
    const recognized = await recognizeAt({
      bridge,
      info,
      library,
      templates,
      reference,
      label: `妖刀检索候选${index + 1}`
    });
    selectedReference = reference;
    const rank = recognized.accepted ? rankById.get(recognized.id) || null : null;
    seen.push({ index: index + 1, reference, recognized, rank });

    if (rank === 1) {
      console.log(`妖刀检索命中当前策略目标${recognized.name}；保持选中。`);
      await waitBeforePromptSubmit('妖刀检索目标');
      const confirmProof = await confirmCurrentSearchSelection({
        bridge,
        info,
        debugDir,
        beforeClick,
        label: '妖刀检索目标'
      });
      return {
        selected: recognized,
        selectedIndex: index + 1,
        selectedReference: reference,
        priorityRank: rank,
        seen,
        confirmProof
      };
    }

    if (rank && (!fallback || rank < fallback.rank)) {
      fallback = { index: index + 1, reference, recognized, rank };
      console.log(`已发现${recognized.name}[${recognized.id}]，按当前目标策略继续确认。`);
    }

    // A one-card search window has no higher-priority card left to inspect.
    // Keep the already proven legal Bamboo selected and submit it directly.
    // Clicking the sole card again can collapse/reflow the modal and turn the
    // saved prompt coordinate into a click on the hand behind it.
    if (rank && points.length === 1) {
      console.log(`妖刀检索窗口只有1张合法候选：保持${recognized.name}[${recognized.id}]选中，不执行取消/回选。`);
      await waitBeforePromptSubmit('妖刀检索目标');
      const confirmProof = await confirmCurrentSearchSelection({
        bridge,
        info,
        debugDir,
        beforeClick,
        label: '妖刀检索目标'
      });
      return {
        selected: recognized,
        selectedIndex: index + 1,
        selectedReference: reference,
        priorityRank: rank,
        seen,
        confirmProof
      };
    }

    await beforeClick();
    const physical = mapReferencePoint(info, reference);
    await bridge.click(physical.x, physical.y);
    selectedReference = null;
    await sleep(150);
    console.log(`  候选${index + 1}不是最终目标：同点恢复未选中。`);
  }

  if (!fallback) {
    throw new Error(
      `D3_NO_LEGAL_BAMBOO_TARGET:` +
      `${seen.map(row => `${row.recognized.name}[${row.recognized.id}]`).join('|') || 'NONE'}`
    );
  }

  await beforeClick();
  const recognized = await recognizeAt({
    bridge,
    info,
    library,
    templates,
    reference: fallback.reference,
    label: `妖刀检索后备候选${fallback.index}`
  });
  selectedReference = fallback.reference;
  if (!recognized.accepted || recognized.id !== fallback.recognized.id) {
    throw new Error(
      `D3_BAMBOO_FALLBACK_RESELECT_MISMATCH:${recognized.name}[${recognized.id}];` +
      `expected=${fallback.recognized.id}`
    );
  }

  console.log(`回到已确认的当前策略目标${recognized.name}[${recognized.id}]。`);
  await waitBeforePromptSubmit('妖刀检索目标');
  const confirmProof = await confirmCurrentSearchSelection({
    bridge,
    info,
    debugDir,
    beforeClick,
    label: '妖刀检索目标'
  });
  return {
    selected: recognized,
    selectedIndex: fallback.index,
    selectedReference: fallback.reference,
    priorityRank: fallback.rank,
    seen,
    confirmProof
  };
}

module.exports = {
  BAMBOO_PRIORITY,
  waitOptionalPool,
  selectM19FromOptionalPool,
  waitForBambooPromptAfterM19,
  selectBambooSearchTarget
};
