'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { isTradeInCostId } = require(path.join(ROOT, 'lib', 'trade-in-policy'));
const { imageDarkRatio } = require('./image-metrics');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const { detectCandidateCenters } = require('./prompt-candidate-centers');
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

// Directly retained from the mature M12 dedicated executor.  This is a special
// cost-selection prompt, not the normal hand fan and not DENSE.
const M12_COST_PROMPT = {
  titleRoi: { x: 680, y: 730, width: 688, height: 60 },
  bodyRoi: { x: 700, y: 790, width: 648, height: 250 },
  candidateY: 925,
  candidateSpacing: 158,
  centerX: 1024,
  timeoutMs: 5000
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}



async function waitForTradeInCostPrompt({ bridge, info, debugDir, candidateCount }) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 6) {
    throw new Error('M12_COST_PROMPT_EXPECTED_CANDIDATE_COUNT_INVALID');
  }
  const startedAt = Date.now();
  let attempt = 0;
  let lastTitleDark = 0;
  let lastBodyDark = 0;

  while (Date.now() - startedAt < M12_COST_PROMPT.timeoutMs) {
    attempt++;
    const title = await captureReferenceRoi(
      bridge,
      info,
      M12_COST_PROMPT.titleRoi
    );
    const body = await captureReferenceRoi(
      bridge,
      info,
      M12_COST_PROMPT.bodyRoi
    );

    lastTitleDark = imageDarkRatio(title, 80);
    lastBodyDark = imageDarkRatio(body, 80);

    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(
        title,
        path.join(debugDir, 'm12_cost_prompt_title_latest.png')
      );
      saveRgbaPng(
        body,
        path.join(debugDir, 'm12_cost_prompt_body_latest.png')
      );
    }

    // ISSUE-033: bodyDark is not invariant.  Every additional legal Level-8
    // card replaces a large part of the dark dialog body with bright card art.
    // Prove the prompt by its stable dark title plus the mature physical-frame
    // detector finding exactly the ledger/hand-derived number of candidates.
    if (lastTitleDark >= 0.82) {
      try {
        const references = await tradeInPromptReferences({
          bridge,
          info,
          debugDir,
          candidateCount
        });
        console.log(
          `抵价交易费用窗口: PASS; ` +
          `titleDark=${lastTitleDark.toFixed(3)}; bodyDark=${lastBodyDark.toFixed(3)}(仅诊断); ` +
          `stableCandidates=${references.length}`
        );
        return {
          attempts: attempt,
          titleDarkRatio: lastTitleDark,
          bodyDarkRatio: lastBodyDark,
          expectedCandidateCount: candidateCount,
          references
        };
      } catch (_) {
        // The title can appear before all candidate cards finish animating.
        // Retry passively; tradeInPromptReferences sends no input.
      }
    }

    await sleep(120);
  }

  throw new Error(
    `M12_COST_PROMPT_NOT_PROVEN:` +
    `titleDark=${lastTitleDark.toFixed(3)};bodyDark=${lastBodyDark.toFixed(3)};` +
    `expectedCandidates=${candidateCount}`
  );
}

async function tradeInPromptReferences({bridge, info, debugDir, candidateCount}) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 6) throw new Error('M12_COST_CANDIDATE_COUNT_INVALID');
  const roi = {x:500,y:790,width:1048,height:250};
  let previous = null;
  for (let attempt=0;attempt<8;attempt++) {
    const image = await captureReferenceRoi(bridge,info,roi);
    if(debugDir) saveRgbaPng(image,path.join(debugDir,'m12_physical_candidates.png'));
    const points=detectCandidateCenters(image,roi,M12_COST_PROMPT.candidateY,{mode:'components'})
      .filter(p=>p.width>=75 && p.width<=155).sort((a,b)=>a.x-b.x);
    if(points.length===candidateCount && previous && previous.length===points.length &&
        points.every((p,i)=>Math.abs(p.x-previous[i].x)<=5)) return points;
    previous=points; await sleep(180);
  }
  throw new Error('M12_PHYSICAL_COST_FRAMES_NOT_PROVEN');
}

async function recognizeSelectedCostCandidate({
  bridge,
  info,
  library,
  templates,
  candidateIndex
}) {
  let last = null;

  // The clicked candidate is already selected.  Any retries below are passive
  // left-detail reads only; no additional candidate click is sent.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await recognizeCurrentCard(
      bridge,
      info,
      library,
      templates,
      { stableAcceptedSamples: 2 }
    );
    last = normalizeRecognized(raw);

    if (last.accepted && isTradeInCostId(last.id)) {
      return last;
    }

    if (attempt < 3) await sleep(140);
  }

  throw new Error(
    `M12_COST_CANDIDATE_IDENTIFY_FAILED:candidate=${candidateIndex};` +
    `last=${last ? `${last.name}[${last.id}]` : 'NONE'};` +
    '候选已物理选中，未继续遍历，也未点击确认。'
  );
}

async function confirmCurrentDialogSelection({ bridge, info, debugDir }) {
  const cfg = config.toonChain && config.toonChain.genericDialogConfirm;
  if (!cfg || !cfg.point || !cfg.roi) {
    throw new Error('M12_GENERIC_DIALOG_CONFIRM_NOT_CONFIGURED');
  }

  const startedAt = Date.now();
  let lastYellow = 0;

  // Target candidate is already physically selected.  If the submit button is
  // late, only retry observing/clicking this button.  Never click the candidate
  // again, matching the global execution safety rule.
  while (Date.now() - startedAt < 3500) {
    const image = await captureReferenceRoi(bridge, info, cfg.roi);
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;

    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'm12_cost_confirm_latest.png'));
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
      console.log(
        `抵价交易费用目标: 已点击底部“选择/确认”；yellowPixels=${lastYellow}`
      );
      return {
        yellowPixels: lastYellow,
        point: cfg.point
      };
    }

    await sleep(120);
  }

  throw new Error(
    `M12_COST_CONFIRM_NOT_PROVEN:yellow=${lastYellow};` +
    '费用候选已经选中，只允许重试确认按钮，禁止重新点击候选牌。'
  );
}

async function selectM12CostTarget(options) {
  const {
    bridge,
    info,
    library,
    templates,
    plannedCost,
    eligibleCosts,
    debugDir
  } = options;

  if (!plannedCost || !plannedCost.id) {
    throw new Error('M12_PLANNED_COST_REQUIRED');
  }
  if (!Array.isArray(eligibleCosts) || !eligibleCosts.length) {
    throw new Error('M12_ELIGIBLE_COSTS_EMPTY');
  }

  const promptProof = await waitForTradeInCostPrompt({
    bridge,
    info,
    debugDir,
    candidateCount: eligibleCosts.length
  });

  const references = promptProof.references;

  console.log(
    `抵价交易合法费用候选中心（从左向右）: ` +
    `${references.map(ref => `(${ref.x},${ref.y})`).join(', ')}`
  );
  console.log(
    `费用优先级目标: ${plannedCost.name}[${plannedCost.id}]；` +
    '本轮从左向右逐候选精确认。'
  );

  const scanned = [];

  // Intentionally left -> right.  This follows the mature M12 prompt indexing
  // and makes the physical traversal match the on-screen candidate order.
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    const physical = mapReferencePoint(info, ref);

    await bridge.click(physical.x, physical.y);
    await sleep(config.mouseSettleMs || 260);

    const recognized = await recognizeSelectedCostCandidate({
      bridge,
      info,
      library,
      templates,
      candidateIndex: i + 1
    });

    scanned.push({
      candidateIndex: i + 1,
      clickReference: { x: ref.x, y: ref.y },
      recognized
    });

    console.log(
      `抵价交易候选${i + 1}: ${recognized.name}[${recognized.id}] ` +
      `${recognized.id === plannedCost.id ? 'PASS' : '非目标'}`
    );

    if (recognized.id === plannedCost.id) {
      console.log(
        `费用优先级命中: ${recognized.name}[${recognized.id}]；` +
        '保持选中，不再遍历后续候选。'
      );

      await waitBeforePromptSubmit('抵价交易费用目标');
      const confirmProof = await confirmCurrentDialogSelection({
        bridge,
        info,
        debugDir
      });

      return {
        selected: recognized,
        candidateIndex: i + 1,
        candidateCount: references.length,
        clickReference: { x: ref.x, y: ref.y },
        promptProof,
        confirmProof,
        scanned,
        traversal: 'LEFT_TO_RIGHT',
        positioning: 'M12_DEDICATED_COST_PROMPT'
      };
    }

    // This is a proven legal candidate but not our planned priority target.
    // Toggle the exact same card OFF before moving to the next one.
    await bridge.click(physical.x, physical.y);
    await sleep(180);
    console.log(
      `  候选${i + 1}不是最终费用：同点恢复为未选中，继续向右。`
    );
  }

  throw new Error(
    `M12_PLANNED_COST_NOT_FOUND_IN_PROMPT:${plannedCost.name}[${plannedCost.id}];` +
    `scanned=${scanned.map(item => item.recognized.id).join('>') || 'NONE'}`
  );
}

module.exports = {
  M12_COST_PROMPT,
  waitForTradeInCostPrompt,
  tradeInPromptReferences,
  selectM12CostTarget
};
