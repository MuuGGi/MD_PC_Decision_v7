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

// Ported from the live-PASS M10 dedicated executor.  This is the Toon Table
// search dialog, not a normal hand fan and not DENSE.


function loadSearchSignature() {
  const dialog = config.toonChain && config.toonChain.searchDialog;
  const signature = dialog && dialog.signature;
  if (!dialog || !dialog.calibrated || !signature || !signature.template || !signature.roi) {
    throw new Error('M10_TOON_SEARCH_DIALOG_NOT_CALIBRATED');
  }
  const templatePath = path.join(ROOT, signature.template);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`M10_TOON_SEARCH_TEMPLATE_MISSING:${signature.template}`);
  }
  return {
    dialog,
    signature,
    template: PNG.sync.read(fs.readFileSync(templatePath))
  };
}

async function waitForToonSearchDialog({ bridge, info, debugDir }) {
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
        saveRgbaPng(image, path.join(debugDir, 'm10_search_dialog_signature.png'));
      }
      console.log(`卡通目录检索窗口: PASS; signatureMad=${mad.toFixed(4)}`);
      return {
        dialog: bundle.dialog,
        signatureMad: mad
      };
    }

    await sleep(180);
  }

  throw new Error(`M10_TOON_SEARCH_DIALOG_TIMEOUT:bestMad=${bestMad.toFixed(4)}`);
}

async function confirmCurrentDialogSelection({ bridge, info, debugDir, label }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.point || !cfg.roi) {
    throw new Error('M10_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const started = Date.now();
  let lastYellow = 0;

  // Candidate is already selected.  Submit retry is button-only; never click
  // the candidate again if the confirm button is late.
  while (Date.now() - started < 3500) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;

    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      saveRgbaPng(image, path.join(debugDir, 'm10_search_confirm_latest.png'));
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
    `M10_SEARCH_CONFIRM_NOT_PROVEN:yellow=${lastYellow};` +
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
  await sleep(config.mouseSettleMs || 260);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const recognized = normalizeRecognized(raw);

  console.log(
    `卡通目录检索候选${candidateIndex}: ` +
    `${recognized.name}[${recognized.id}] ${recognized.accepted ? 'PASS' : 'UNKNOWN'}`
  );
  return recognized;
}

async function selectM10SearchTarget(options) {
  const {
    bridge,
    info,
    library,
    templates,
    priority,
    debugDir
  } = options;

  const searchPriority = Array.isArray(priority) && priority.length
    ? priority
    : [
        { id: 'M10', name: '卡通目录' },
        { id: 'M07', name: '青眼卡通龙' }
      ];

  const promptProof = await waitForToonSearchDialog({ bridge, info, debugDir });
  const dialog = promptProof.dialog;

  const candidateImage = await captureReferenceRoi(bridge, info, dialog.candidateRoi);
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    saveRgbaPng(candidateImage, path.join(debugDir, 'm10_search_candidates.png'));
  }

  const points = detectCandidateCenters(
    candidateImage,
    dialog.candidateRoi,
    dialog.candidateY,
    { mode: 'components' }
  );

  const traversalPoints = points.slice().sort((a, b) => b.x - a.x);
  console.log(
    `卡通目录实时候选中心（从右向左）: ` +
    `${traversalPoints.map(point => `(${Math.round(point.x)},${Math.round(point.y)})`).join(', ') || 'NONE'}`
  );
  if (!points.length) throw new Error('M10_TOON_SEARCH_NO_CANDIDATE_FRAMES');

  const primary = searchPriority[0];
  const fallbackRule = searchPriority[1];
  let fallback = null;
  let lastClickedCandidate = null;
  const seen = [];

  // Keep the mature candidate/confirm rhythm, but scan right-to-left so the
  // usual priority target is reached sooner. M10 is absolute priority; M07 is
  // fallback and is only submitted after all candidates prove that no M10 is
  // available.
  for (let index = 0; index < traversalPoints.length; index++) {
    const reference = {
      x: traversalPoints[index].x,
      y: traversalPoints[index].y + (dialog.candidateClickYOffset || 0)
    };

    const recognized = await recognizeCandidateAt({
      bridge,
      info,
      library,
      templates,
      reference,
      candidateIndex: index + 1
    });

    // recognizeCandidateAt() itself physically clicks this candidate once.
    // Remember which candidate is currently selected so the fallback path
    // never toggles the same card OFF by clicking it a second time.
    lastClickedCandidate = {
      candidateIndex: index + 1,
      clickReference: reference,
      recognized
    };

    seen.push({
      candidateIndex: index + 1,
      clickReference: reference,
      recognized
    });

    if (!recognized.accepted) continue;

    if (recognized.id === primary.id) {
      console.log(
        `检索优先级命中: ${recognized.name}[${recognized.id}]；` +
        '保持选中，不再扫描低优先级候选。'
      );
      await waitBeforePromptSubmit('卡通目录检索目标');
      const confirmProof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir,
        label: '卡通目录检索目标'
      });
      return {
        promptProof,
        selected: recognized,
        candidateIndex: index + 1,
        clickReference: reference,
        priorityRank: 1,
        selectionReason: 'PRIORITY_M10_AVAILABLE',
        seen,
        confirmProof,
        traversal: 'RIGHT_TO_LEFT',
        positioning: 'M10_DEDICATED_SEARCH_PROMPT'
      };
    }

    if (fallbackRule && recognized.id === fallbackRule.id && !fallback) {
      fallback = {
        candidateIndex: index + 1,
        clickReference: reference,
        recognized
      };
      console.log(
        `已发现${recognized.name}[${recognized.id}]，暂存为后备；` +
        `继续向左确认是否还有${primary.name}[${primary.id}]。`
      );
    }
  }

  if (fallback) {
    console.log(
      `全部候选中未发现${primary.name}[${primary.id}]；` +
      `按成熟规则使用${fallbackRule.name}[${fallbackRule.id}]。`
    );

    // Important: every scan candidate was already clicked exactly once by
    // recognizeCandidateAt().  If the fallback is also the last candidate we
    // touched (the common final-Toon-Table case where only Blue-Eyes Toon
    // Dragon remains), it is ALREADY SELECTED.  Clicking it again would toggle
    // it OFF and make the bottom Select button disappear.
    const fallbackStillSelected = Boolean(
      lastClickedCandidate &&
      lastClickedCandidate.candidateIndex === fallback.candidateIndex
    );

    if (fallbackStillSelected) {
      console.log(
        `后备目标${fallback.recognized.name}[${fallback.recognized.id}]仍保持选中；` +
        '不再重复点击候选，直接进入提交。'
      );
    } else {
      // Another lower-priority candidate was inspected after the fallback.
      // In that case one physical click is necessary to re-select the already
      // identified fallback.  Do NOT call recognizeCandidateAt() here because
      // that helper includes its own click.
      const physical = mapReferencePoint(info, fallback.clickReference);
      await bridge.click(physical.x, physical.y);
      await sleep(config.mouseSettleMs || 260);
      console.log(
        `已单次重新选中后备目标${fallback.recognized.name}[${fallback.recognized.id}]；` +
        '不做第二次候选点击。'
      );
    }

    await waitBeforePromptSubmit('卡通目录检索目标');
    const confirmProof = await confirmCurrentDialogSelection({
      bridge,
      info,
      debugDir,
      label: '卡通目录检索目标'
    });

    return {
      promptProof,
      selected: fallback.recognized,
      candidateIndex: fallback.candidateIndex,
      clickReference: fallback.clickReference,
      priorityRank: 2,
      selectionReason: 'NO_M10_FALLBACK_M07',
      seen,
      confirmProof,
      traversal: 'LEFT_TO_RIGHT',
      positioning: 'M10_DEDICATED_SEARCH_PROMPT'
    };
  }

  throw new Error(
    `M10_NO_VALID_SEARCH_TARGET_RECOGNIZED:` +
    `${seen.map(row => `${row.recognized.name}[${row.recognized.id}]`).join('|') || 'NONE'}`
  );
}

module.exports = {
  waitForToonSearchDialog,
  selectM10SearchTarget
};
