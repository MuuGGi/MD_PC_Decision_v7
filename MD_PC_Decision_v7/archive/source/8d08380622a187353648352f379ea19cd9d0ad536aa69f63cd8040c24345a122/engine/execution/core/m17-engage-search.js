'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const { sampledMad } = require('./image-metrics');
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
const { detectCandidateCenters } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-candidate-centers'
));
const { waitBeforePromptSubmit } = require(path.join(
  ROOT,
  'execution',
  'core',
  'prompt-submit-timing'
));

const {
  buildDeckState
} = require(path.join(ROOT, 'lib', 'decision-engine'));
const {
  buildEngageTargetPriority,
  buildEngageLegalTargets
} = require(path.join(ROOT, 'lib', 'engage-policy'));

const LEGAL = new Map(
  buildEngageLegalTargets().map(item => [item.id, item.name])
);



// PATCH_V5_M17_STATE_AWARE_PRIORITY_V1
function buildSearchPriority(baseline) {
  // PATCH_V5_M17_SHARED_DECK_LEDGER_V1
  // The top-level decision layer has always owned the authoritative main-deck
  // count calculation.  M17 must use that SAME buildDeckState() result instead
  // of keeping a second hard-coded M06/M08/M22 copy counter here.
  const cards = Array.isArray(baseline && baseline.cards) ? baseline.cards : [];

  let decisionState = {};
  try {
    const statePath = path.join(ROOT, 'decision-state.json');
    if (fs.existsSync(statePath)) {
      decisionState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (_) {
    decisionState = {};
  }

  let library;
  try {
    library = JSON.parse(fs.readFileSync(path.join(ROOT, 'card-library.json'), 'utf8'));
  } catch (error) {
    throw new Error(`M17_SHARED_DECK_LEDGER_LIBRARY_READ_FAILED:${error.message}`);
  }

  if (typeof buildDeckState !== 'function') {
    throw new Error('M17_SHARED_DECK_LEDGER_BUILD_DECK_STATE_MISSING');
  }

  const deck = buildDeckState(library, cards, decisionState);
  const totals = {};
  for (const row of library.cards || []) {
    if (row && LEGAL.has(row.id)) totals[row.id] = Number(row.count || 0);
  }

  const remaining = {
    M06: Number(deck && deck.deckRemaining && deck.deckRemaining.M06 || 0),
    M08: Number(deck && deck.deckRemaining && deck.deckRemaining.M08 || 0),
    M22: Number(deck && deck.deckRemaining && deck.deckRemaining.M22 || 0)
  };

  // A one-copy target already used this duel is known outside the Deck even if
  // a stale ledger snapshot briefly says otherwise.
  if (Number(totals.M22 || 0) === 1 && Number(decisionState.usedCounts && decisionState.usedCounts.M22 || 0) > 0) {
    remaining.M22 = 0;
  }

  const sharedPriority = buildEngageTargetPriority(deck, decisionState);
  const targets = sharedPriority.targets.map(target => ({
    id: target.id,
    name: LEGAL.get(target.id) || target.name
  }));
  const fallbackReason = sharedPriority.reason;

  const expectedCandidateCount = Object.values(remaining)
    .reduce((sum, count) => sum + Number(count || 0), 0);

  if (!targets.length || expectedCandidateCount <= 0) {
    throw new Error(
      'M17_NO_SEARCHABLE_TARGET_BY_SHARED_DECK_LEDGER:' +
      `M06=${remaining.M06};M08=${remaining.M08};M22=${remaining.M22}`
    );
  }

  const totalM06 = Number(totals.M06 || 0);
  const totalM08 = Number(totals.M08 || 0);
  const totalM22 = Number(totals.M22 || 0);
  console.log(
    '交闪共享牌组账本: source=lib/decision-engine.buildDeckState; ' +
    `零衣=${remaining.M06}/${totalM06}; ` +
    `H.A.M.P.=${remaining.M08}/${totalM08}; ` +
    `大黄蜂=${remaining.M22}/${totalM22}; ` +
    `expectedCandidates=${expectedCandidateCount}`
  );

  const reason = `交闪目标按共享牌组账本与既定优先级排序：${fallbackReason}`;

  return {
    reason,
    targets,
    remaining,
    expectedCandidateCount,
    totals: {
      M06: totalM06,
      M08: totalM08,
      M22: totalM22
    },
    handCounts: deck.handCounts || {},
    usedCounts: deck.usedCounts || {},
    stateSource: 'SHARED_DECISION_ENGINE_BUILD_DECK_STATE'
  };
}

function loadSearchSignature() {
  const dialog = config.toonChain && config.toonChain.searchDialog;
  const signature = dialog && dialog.signature;
  if (!dialog || !dialog.calibrated || !signature || !signature.template || !signature.roi) {
    throw new Error('M17_ENGAGE_SEARCH_DIALOG_NOT_CALIBRATED');
  }
  const templatePath = path.join(ROOT, signature.template);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`M17_ENGAGE_SEARCH_TEMPLATE_MISSING:${signature.template}`);
  }
  return {
    dialog,
    signature,
    template: PNG.sync.read(fs.readFileSync(templatePath))
  };
}

async function waitForEngageSearchDialog({ bridge, info, debugDir }) {
  const bundle = loadSearchSignature();
  const started = Date.now();
  let bestMad = Infinity;

  while (Date.now() - started < 10000) {
    const image = await captureReferenceRoi(bridge, info, bundle.signature.roi);
    const mad = sampledMad(image, bundle.template, 2);
    bestMad = Math.min(bestMad, mad);

    if (mad <= bundle.signature.maxMad) {
      if (debugDir) {
        fs.mkdirSync(debugDir, { recursive: true });
        saveRgbaPng(image, path.join(debugDir, 'm17_search_dialog_signature.png'));
      }
      console.log(`交闪检索窗口: PASS; signatureMad=${mad.toFixed(4)}`);
      return { dialog: bundle.dialog, signatureMad: mad };
    }
    await sleep(180);
  }

  throw new Error(`M17_ENGAGE_SEARCH_DIALOG_TIMEOUT:bestMad=${bestMad.toFixed(4)}`);
}

async function confirmCurrentDialogSelection({ bridge, info, debugDir, label, beforeClick }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.point || !cfg.roi) {
    throw new Error('M17_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const started = Date.now();
  let lastYellow = 0;
  while (Date.now() - started < 3500) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;

    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      saveRgbaPng(image, path.join(debugDir, 'm17_search_confirm_latest.png'));
    }

    const enoughTotal = stats.estimatedYellowPixels >= (cfg.minYellowPixels || 600);
    const enoughComponent = stats.buttonComponent &&
      stats.buttonComponent.estimatedPixels >=
        ((cfg.minButtonPixels || cfg.minYellowPixels || 600) * 0.4);

    if (enoughTotal || enoughComponent) {
      if (beforeClick) await beforeClick();
      const point = mapReferencePoint(info, cfg.point);
      await bridge.click(point.x, point.y);
      console.log(`${label}: 已点击底部“选择/确认”；yellowPixels=${lastYellow}`);
      return { yellowPixels: lastYellow, point: cfg.point };
    }
    await sleep(120);
  }

  throw new Error(
    `M17_SEARCH_CONFIRM_NOT_PROVEN:yellow=${lastYellow};` +
    '检索候选已经选中，只允许重试确认按钮，禁止重新点击候选牌。'
  );
}

async function recognizeCandidateAt({
  bridge,
  info,
  library,
  templates,
  reference,
  candidateIndex
}) {
  const physical = mapReferencePoint(info, reference);
  await bridge.click(physical.x, physical.y);
  await sleep(config.toonChain.selectSettleMs || config.mouseSettleMs || 260);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const recognized = normalizeRecognized(raw);
  console.log(
    `交闪检索候选${candidateIndex}: ${recognized.name}[${recognized.id}] ` +
    `${recognized.accepted ? 'PASS' : 'UNKNOWN'}`
  );
  return recognized;
}

async function captureStableM17CandidatePoints({ bridge, info, dialog, debugDir }) {
  const started = Date.now();
  const samples = [];
  const minObserveMs = 1500;
  const timeoutMs = 2600;
  const intervalMs = 140;

  while (Date.now() - started < timeoutMs) {
    const image = await captureReferenceRoi(bridge, info, dialog.candidateRoi);
    let points = [];
    try {
      points = detectCandidateCenters(
        image,
        dialog.candidateRoi,
        dialog.candidateY,
        { mode: 'components' }
      ) || [];
    } catch (_) {
      points = [];
    }

    points = points
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
      .sort((a, b) => a.x - b.x);

    const rounded = points.map(point => ({
      x: Math.round(point.x),
      y: Math.round(point.y)
    }));
    const signature = rounded.map(point => `${point.x}:${point.y}`).join('|');
    samples.push({ elapsed: Date.now() - started, points, rounded, signature });

    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      saveRgbaPng(image, path.join(debugDir, 'm17_search_candidates_latest.png'));
    }

    await sleep(intervalMs);
  }

  const eligible = samples.filter(
    sample => sample.elapsed >= minObserveMs && sample.points.length > 0
  );
  const pool = eligible.length
    ? eligible
    : samples.filter(sample => sample.points.length > 0);

  if (!pool.length) return { points: [], samples };

  // 候选数量不是固定值。这里只防止刚入检索窗口时边缘候选尚未完全展开。
  // 不信第一帧；在观察窗口内采用“反复出现的最大候选布局”。
  const groups = new Map();
  for (const sample of pool) {
    const key = sample.signature;
    const row = groups.get(key) || { count: 0, sample };
    row.count += 1;
    row.sample = sample;
    groups.set(key, row);
  }

  const repeated = [...groups.values()].filter(row => row.count >= 2);
  const candidates = repeated.length ? repeated : [...groups.values()];
  candidates.sort((a, b) =>
    b.sample.points.length - a.sample.points.length ||
    b.count - a.count ||
    b.sample.elapsed - a.sample.elapsed
  );

  const chosen = candidates[0];
  console.log(
    `交闪候选稳定采样: samples=${samples.length}; ` +
    `chosenCount=${chosen.sample.points.length}; repeated=${chosen.count}; ` +
    `elapsed=${chosen.sample.elapsed}ms`
  );
  return { points: chosen.sample.points, samples, chosen };
}

async function finalizeSingleM17CandidateSelection({ bridge, info, debugDir }) {
  const confirmCfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!confirmCfg || !confirmCfg.point || !confirmCfg.roi) {
    throw new Error('M17_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const searchBundle = loadSearchSignature();
  const bonusRoi = { x: 1040, y: 590, width: 290, height: 80 };
  const started = Date.now();
  let searchGoneReads = 0;
  let lastSearchMad = Infinity;
  let lastConfirmYellow = 0;

  while (Date.now() - started < 2400) {
    // Single-candidate Engage may auto-advance immediately.  The bonus prompt
    // must be checked before the generic yellow confirm button, otherwise the
    // YES button could be mistaken for the old search-dialog submit button.
    const bonusImage = await captureReferenceRoi(bridge, info, bonusRoi);
    const bonus = measureBonusDrawPrompt(bonusImage);
    if (bonus.detected) {
      if (debugDir) {
        fs.mkdirSync(debugDir, { recursive: true });
        saveRgbaPng(
          bonusImage,
          path.join(debugDir, 'm17_single_candidate_auto_bonus_prompt.png')
        );
      }
      console.log(
        '交闪单候选：游戏已自动提交唯一候选并进入追加抽1确认框；' +
        '禁止取消、禁止重选、禁止再次点击检索候选。'
      );
      return {
        mode: 'AUTO_ADVANCED_TO_BONUS',
        autoAdvanced: true,
        bonus
      };
    }

    // If the ordinary bottom search-confirm button still exists, submit it
    // exactly once.  This covers UI variants where a single candidate does not
    // auto-submit.
    const confirmImage = await captureReferenceRoi(bridge, info, confirmCfg.roi);
    const confirmStats = yellowUsableStats(confirmImage);
    lastConfirmYellow = confirmStats.estimatedYellowPixels;
    const enoughTotal = confirmStats.estimatedYellowPixels >=
      (confirmCfg.minYellowPixels || 600);
    const enoughComponent = confirmStats.buttonComponent &&
      confirmStats.buttonComponent.estimatedPixels >=
        ((confirmCfg.minButtonPixels || confirmCfg.minYellowPixels || 600) * 0.4);

    if (enoughTotal || enoughComponent) {
      await waitBeforePromptSubmit('交闪单候选检索目标');
      const proof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir,
        label: '交闪单候选检索目标'
      });
      return {
        mode: 'SUBMITTED_WITH_CONFIRM_BUTTON',
        autoAdvanced: false,
        confirmProof: proof
      };
    }

    // No bonus prompt and no submit button.  Require two consecutive reads
    // proving that the search dialog itself has disappeared before accepting
    // automatic resolution.
    const searchImage = await captureReferenceRoi(
      bridge,
      info,
      searchBundle.signature.roi
    );
    lastSearchMad = sampledMad(searchImage, searchBundle.template, 2);
    searchGoneReads = lastSearchMad > searchBundle.signature.maxMad
      ? searchGoneReads + 1
      : 0;

    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      saveRgbaPng(
        searchImage,
        path.join(debugDir, 'm17_single_candidate_stage_latest.png')
      );
    }

    if (searchGoneReads >= 2) {
      console.log(
        '交闪单候选：检索窗口已自行关闭；视为唯一候选已自动结算。' +
        '后续只进入对应的追加抽1/无追加抽1验收阶段。'
      );
      return {
        mode: 'AUTO_RESOLVED_SEARCH',
        autoAdvanced: true,
        lastSearchMad
      };
    }

    await sleep(160);
  }

  throw new Error(
    `M17_SINGLE_CANDIDATE_STAGE_UNRESOLVED:` +
    `searchMad=${Number.isFinite(lastSearchMad) ? lastSearchMad.toFixed(4) : 'INF'};` +
    `confirmYellow=${lastConfirmYellow}; 已停止，禁止重选唯一候选。`
  );
}

async function selectM17SearchTarget(options) {
  const {
    bridge,
    info,
    library,
    templates,
    baseline,
    priorityPlan,
    debugDir
  } = options;

  const plan = priorityPlan || buildSearchPriority(baseline);
  const rankById = new Map(plan.targets.map((target, index) => [target.id, index + 1]));
  const promptProof = await waitForEngageSearchDialog({ bridge, info, debugDir });
  const dialog = promptProof.dialog;

  const stableCandidates = await captureStableM17CandidatePoints({
    bridge,
    info,
    dialog,
    debugDir
  });
  const points = stableCandidates.points;

  const expectedCandidateCount = Number.isInteger(options.expectedCandidateCount)
    ? options.expectedCandidateCount
    : (Number.isInteger(plan.expectedCandidateCount) ? plan.expectedCandidateCount : null);

  if (Number.isInteger(expectedCandidateCount) && expectedCandidateCount > 0 &&
      points.length !== expectedCandidateCount) {
    throw new Error(
      `M17_CANDIDATE_STATE_MISMATCH:expected=${expectedCandidateCount};` +
      `observed=${points.length};remaining=${JSON.stringify(plan.remaining || {})};` +
      '已安全停止；禁止在候选集合不完整时降级选择。'
    );
  }

  const traversalPoints = points.slice().sort((a, b) => b.x - a.x);
  console.log(
    `交闪实时候选中心（从右向左）: ` +
    `${traversalPoints.map(point => `(${Math.round(point.x)},${Math.round(point.y)})`).join(', ') || 'NONE'}`
  );
  if (!points.length) throw new Error('M17_ENGAGE_SEARCH_NO_CANDIDATE_FRAMES');

  // A single legal candidate is already the final search target.  Never apply
  // the multi-candidate "click again to deselect" rule here: Master Duel can
  // auto-submit a sole candidate and immediately move to the bonus-draw prompt.
  if (points.length === 1) {
    const reference = {
      x: points[0].x,
      y: points[0].y + (dialog.candidateClickYOffset || 0)
    };
    const recognized = await recognizeCandidateAt({
      bridge,
      info,
      library,
      templates,
      reference,
      candidateIndex: 1
    });

    if (!recognized.accepted || !LEGAL.has(recognized.id)) {
      throw new Error(
        `M17_SINGLE_CANDIDATE_NOT_LEGAL:${recognized.name}[${recognized.id}]`
      );
    }

    const rank = rankById.get(recognized.id) || null;
    console.log(
      `交闪只有1个真实候选：${recognized.name}[${recognized.id}]；` +
      '直接作为最终检索目标，保持当前选择，绝不执行同点取消或fallback重选。'
    );

    const singleProof = await finalizeSingleM17CandidateSelection({
      bridge,
      info,
      debugDir
    });

    return {
      promptProof,
      priorityPlan: plan,
      selected: recognized,
      candidateIndex: 1,
      clickReference: reference,
      priorityRank: rank,
      seen: [{
        candidateIndex: 1,
        clickReference: reference,
        recognized,
        priorityRank: rank
      }],
      confirmProof: singleProof.confirmProof || singleProof,
      traversal: 'SINGLE_CANDIDATE',
      positioning: 'M17_DEDICATED_SEARCH_PROMPT',
      singleCandidate: true,
      autoAdvanced: Boolean(singleProof.autoAdvanced),
      singleCandidateResolution: singleProof.mode
    };
  }

  const seen = [];
  for (let index = 0; index < traversalPoints.length; index++) {
    const reference = {
      x: traversalPoints[index].x,
      y: traversalPoints[index].y + (dialog.candidateClickYOffset || 0)
    };
    const physical = mapReferencePoint(info, reference);
    const recognized = await recognizeCandidateAt({
      bridge,
      info,
      library,
      templates,
      reference,
      candidateIndex: index + 1
    });

    const rank = recognized.accepted && LEGAL.has(recognized.id)
      ? rankById.get(recognized.id) || null
      : null;

    seen.push({
      candidateIndex: index + 1,
      clickReference: reference,
      recognized,
      priorityRank: rank
    });

    if (rank === 1) {
      console.log(
        `交闪检索优先级命中: ${recognized.name}[${recognized.id}]；` +
        '保持选中，不再扫描低优先级候选。'
      );
      await waitBeforePromptSubmit('交闪检索目标');
      const confirmProof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir,
        label: '交闪检索目标'
      });
      return {
        promptProof,
        priorityPlan: plan,
        selected: recognized,
        candidateIndex: index + 1,
        clickReference: reference,
        priorityRank: 1,
        seen,
        confirmProof,
        traversal: 'RIGHT_TO_LEFT',
        positioning: 'M17_DEDICATED_SEARCH_PROMPT'
      };
    }

    // 非最终目标必须在同一点取消选中，再看下一张。不能残留多选。
    await bridge.click(physical.x, physical.y);
    await sleep(150);
    console.log(`  候选${index + 1}不是最终目标：同点恢复为未选中。`);
  }

  const observedCounts = { M06: 0, M08: 0, M22: 0 };
  for (const row of seen) {
    const id = row && row.recognized && row.recognized.id;
    if (Object.prototype.hasOwnProperty.call(observedCounts, id)) {
      observedCounts[id] += 1;
    }
  }

  const highest = plan.targets && plan.targets[0];
  throw new Error(
    'M17_PRIORITY_TARGET_MISSING_FROM_COMPLETE_PROMPT:' +
    `highest=${highest ? highest.id : 'NONE'};` +
    `expected=${JSON.stringify(plan.remaining || {})};` +
    `observed=${JSON.stringify(observedCounts)};` +
    '禁止fallback重新点击已经取消选择的候选。'
  );
}

// Explicit recovery of an ALREADY selected search card. No candidate click,
// hand activation, rescan or fallback is allowed on this path.
async function resumeSelectedM17Search(options) {
  const { bridge, info, library, templates, baseline, priorityPlan, debugDir, beforeSubmit, sourceCandidatePath } = options;
  const plan = priorityPlan || buildSearchPriority(baseline);
  const promptProof = await waitForEngageSearchDialog({ bridge, info, debugDir });
  const dialog = promptProof.dialog;
  const previousImage = PNG.sync.read(fs.readFileSync(sourceCandidatePath));
  const points = detectCandidateCenters(previousImage, dialog.candidateRoi, dialog.candidateY, { mode: 'components' });
  if (points.length !== plan.expectedCandidateCount || points.length < 2 ||
      points.some(p => p.width < 60 || p.width > 170 || p.x < 750 || p.x > 1300)) {
    throw new Error('AUTOTEST_RESUME_M17_CANDIDATE_COUNT_NOT_PROVEN');
  }
  const { selectedCardBadge, provePreservedCandidateLayout } = require('./selected-card-badge');
  let chosen = null;
  for (let sample = 0; sample < 3; sample++) {
    // Re-prove the header and exact selection immediately before submit.
    await waitForEngageSearchDialog({ bridge, info, debugDir });
    const image = await captureReferenceRoi(bridge, info, dialog.candidateRoi);
    if (!provePreservedCandidateLayout(image, previousImage, points, dialog.candidateRoi).pass) {
      throw new Error('AUTOTEST_RESUME_M17_CANDIDATE_LAYOUT_CHANGED');
    }
    const selected = points.filter(p => selectedCardBadge(image, p, dialog.candidateRoi).pass);
    if (selected.length !== 1 || (chosen && Math.abs(chosen.x - selected[0].x) > 3)) {
      throw new Error('AUTOTEST_RESUME_M17_SINGLE_SELECTED_BADGE_NOT_PROVEN');
    }
    chosen = selected[0];
    await sleep(120);
  }
  const recognized = normalizeRecognized(await recognizeCurrentCard(bridge, info, library, templates,
    { stableAcceptedSamples: 2 }));
  if (!recognized.accepted || recognized.id !== plan.targets[0].id || !LEGAL.has(recognized.id)) {
    throw new Error('AUTOTEST_RESUME_M17_SELECTED_PRIORITY_IDENTITY_NOT_PROVEN');
  }
  await waitForEngageSearchDialog({ bridge, info, debugDir });
  const finalImage = await captureReferenceRoi(bridge, info, dialog.candidateRoi);
  const finalSelected = points.filter(p => selectedCardBadge(finalImage, p, dialog.candidateRoi).pass);
  if (!provePreservedCandidateLayout(finalImage, previousImage, points, dialog.candidateRoi).pass ||
      finalSelected.length !== 1 || Math.abs(finalSelected[0].x - chosen.x) > 3) {
    throw new Error('AUTOTEST_RESUME_M17_SELECTION_CHANGED');
  }
  saveRgbaPng(finalImage, path.join(debugDir, 'm17_resume_selected_proof.png'));
  const confirmProof = await confirmCurrentDialogSelection({ bridge, info, debugDir,
    label: '交闪局内恢复（只提交已选中卡）', beforeClick: beforeSubmit });
  return { promptProof, priorityPlan: plan, selected: recognized, priorityRank: 1,
    candidateIndex: points.indexOf(chosen) + 1, clickReference: null,
    selectedCenter: chosen, confirmProof, traversal: 'RESUME_ALREADY_SELECTED_NO_CANDIDATE_CLICK',
    positioning: 'M17_DEDICATED_SEARCH_PROMPT' };
}

function measureBonusDrawPrompt(image) {
  let yellow = 0;
  let dark = 0;
  const total = image.width * image.height;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    if (r >= 120 && g >= 150 && b <= 90 && g > b * 1.8) yellow++;
    if ((r + g + b) / 3 <= 45) dark++;
  }
  const darkRatio = total ? dark / total : 0;
  return {
    yellow,
    darkRatio,
    detected: yellow >= 35 && darkRatio >= 0.45
  };
}

async function verifyNoBonusDrawPrompt({ bridge, info, debugDir, durationMs = 2800 }) {
  // 直接沿用旧 M17 no-draw PASS 使用的确认框 ROI。这里只截图检测；
  // 如果真实出现“是否抽1”，绝不点击是/否，安全停止。
  const roi = { x: 1040, y: 590, width: 290, height: 80 };
  const started = Date.now();
  let consecutive = 0;
  let maxYellow = 0;
  let maxDark = 0;

  while (Date.now() - started < durationMs) {
    const image = await captureReferenceRoi(bridge, info, roi);
    const measured = measureBonusDrawPrompt(image);
    maxYellow = Math.max(maxYellow, measured.yellow);
    maxDark = Math.max(maxDark, measured.darkRatio);
    consecutive = measured.detected ? consecutive + 1 : 0;

    if (consecutive >= 2) {
      if (debugDir) {
        fs.mkdirSync(debugDir, { recursive: true });
        saveRgbaPng(image, path.join(debugDir, 'm17_unexpected_bonus_draw_prompt.png'));
      }
      throw new Error(
        'M17_BONUS_DRAW_PROMPT_APPEARED:' +
        '当前实际是“可追加抽1”分支；程序未点击“是/否”，本轮安全停止。'
      );
    }
    await sleep(180);
  }

  console.log(
    `交闪追加抽1确认框: 未出现 PASS（本轮按“无追加抽1”分支继续）；` +
    `maxYellow=${maxYellow}; maxDarkRatio=${maxDark.toFixed(3)}`
  );
  return { detected: false, maxYellow, maxDarkRatio: maxDark, durationMs };
}


async function confirmM17BonusDrawPrompt({
  bridge,
  info,
  debugDir,
  beforeYes,
  timeoutMs = 10000
}) {
  // 直接复用旧 M17 可追加抽1现场 PASS 的确认框判据和“是”坐标：
  // ROI=(1040,590,290,80), YES=(1183,630)。
  // 必须连续稳定看到 3 帧，再额外等待 650ms 复核，避免点到入场动画帧。
  const roi = { x: 1040, y: 590, width: 290, height: 80 };
  const yesReference = { x: 1183, y: 630 };
  const started = Date.now();
  let stableDetections = 0;
  let bestYellow = 0;
  let bestDark = 0;

  while (Date.now() - started < timeoutMs) {
    const image = await captureReferenceRoi(bridge, info, roi);
    const measured = measureBonusDrawPrompt(image);
    bestYellow = Math.max(bestYellow, measured.yellow);
    bestDark = Math.max(bestDark, measured.darkRatio);
    stableDetections = measured.detected ? stableDetections + 1 : 0;

    if (stableDetections >= 3) {
      await sleep(650);
      const finalImage = await captureReferenceRoi(bridge, info, roi);
      const finalMeasured = measureBonusDrawPrompt(finalImage);
      if (!finalMeasured.detected) {
        stableDetections = 0;
        continue;
      }

      if (debugDir) {
        fs.mkdirSync(debugDir, { recursive: true });
        saveRgbaPng(
          finalImage,
          path.join(debugDir, 'm17_bonus_draw_prompt_confirmed.png')
        );
      }

      const yes = mapReferencePoint(info, yesReference);
      if (beforeYes) await beforeYes();
      await bridge.click(yes.x, yes.y);
      console.log(
        `交闪追加抽1确认框: PASS；已点击“是”；` +
        `yellow=${finalMeasured.yellow}; darkRatio=${finalMeasured.darkRatio.toFixed(3)}`
      );

      await sleep(650);
      const afterClick = await captureReferenceRoi(bridge, info, roi);
      if (measureBonusDrawPrompt(afterClick).detected) {
        // 已经确认是这个按钮未响应：这里只允许补点“是”，不能回去重选检索牌。
        console.log('交闪追加抽1确认框仍在：等待500ms后只补点“是”1次，不重选检索牌。');
        await sleep(500);
        await bridge.click(yes.x, yes.y);
        await sleep(700);

        const afterRetry = await captureReferenceRoi(bridge, info, roi);
        if (measureBonusDrawPrompt(afterRetry).detected) {
          if (debugDir) {
            saveRgbaPng(
              afterRetry,
              path.join(debugDir, 'm17_bonus_draw_prompt_still_visible.png')
            );
          }
          throw new Error(
            'M17_BONUS_DRAW_CONFIRM_NOT_ACCEPTED:' +
            '两次“是”后确认框仍存在；已停止，不继续点击，也不重选检索牌。'
          );
        }
      }

      console.log('交闪追加抽1确认框已关闭：随后只等待检索牌+额外抽1结算。');
      return {
        detected: true,
        clicked: true,
        roi,
        yesReference,
        bestYellow,
        bestDarkRatio: bestDark,
        finalYellow: finalMeasured.yellow,
        finalDarkRatio: finalMeasured.darkRatio
      };
    }

    await sleep(250);
  }

  throw new Error(
    `M17_BONUS_DRAW_PROMPT_NOT_FOUND:${timeoutMs}ms内未稳定识别到追加抽1确认框；` +
    `bestYellow=${bestYellow};bestDarkRatio=${bestDark.toFixed(3)}；` +
    '本轮要求“有追加抽1”分支，因此停止，不能误记成无追加抽1。'
  );
}

module.exports = {
  buildSearchPriority,
  selectM17SearchTarget,
  resumeSelectedM17Search,
  verifyNoBonusDrawPrompt,
  confirmM17BonusDrawPrompt
};
