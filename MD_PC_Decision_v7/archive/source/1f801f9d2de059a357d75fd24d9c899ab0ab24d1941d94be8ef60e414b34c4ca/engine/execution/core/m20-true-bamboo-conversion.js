'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const { captureReferenceRoi, mapReferencePoint, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { PROMPT_ROI, classifyM19DeckPrompt, sameCandidates, createPromptStabilityGate } = require('./m19-deck-prompt-proof');
const { waitBeforePromptSubmit } = require(path.join(ROOT, 'execution', 'core', 'prompt-submit-timing'));
const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
const { locateFieldActivateIcon } = require('./hand-action-icon');

const M20 = { id: 'M20', name: '真刀竹光' };
const M19 = { id: 'M19', name: '妖刀竹光' };
const CONFIRM = config.toonChain.genericDialogConfirm;

// Mature live M20 field probe row from the previously PASSed implementation.
// Every point is only a probe: the card name must be confirmed as M20 before
// the field effect button can ever be clicked.
const FIELD_PROBE_POINTS = [650, 825, 1000, 1175, 1350].map(x => ({ x, y: 842 }));

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

async function recognizeCurrent({ bridge, info, library, templates }) {
  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  return normalizeRecognized(raw);
}

async function locateFieldM20({ bridge, info, library, templates, debugDir }) {
  const seen = [];
  console.log('\n===== 场上定位真刀竹光[M20] =====');
  console.log('只探测成熟魔陷区实际点并读取左侧卡名；精确认M20之前绝不点“发动效果”。');

  for (let i = 0; i < FIELD_PROBE_POINTS.length; i++) {
    const reference = FIELD_PROBE_POINTS[i];
    const physical = mapReferencePoint(info, reference);
    await bridge.click(physical.x, physical.y);
    await sleep(config.mouseSettleMs || 230);
    const recognized = await recognizeCurrent({ bridge, info, library, templates });
    seen.push({ index: i + 1, reference, recognized });
    console.log(
      `场上探测${i + 1}: (${reference.x},${reference.y}) -> ` +
      `${recognized.name}[${recognized.id}] ${recognized.accepted && recognized.id === M20.id ? 'PASS' : 'UNKNOWN'}`
    );

    if (recognized.accepted && recognized.id === M20.id) {
      await sleep(1000);
      if (debugDir) writeJson(path.join(debugDir, 'field_m20_location.json'), {
        status: 'PASS',
        selectedPoint: reference,
        recognized,
        seen
      });
      console.log(`场上真刀精确认 PASS: 真刀竹光[M20] @(${reference.x},${reference.y})`);
      return { reference, recognized, seen };
    }
  }

  throw new Error(
    `D4_FIELD_M20_NOT_FOUND:${seen.map(x => `${x.recognized.name}[${x.recognized.id}]`).join('>') || 'NONE'}`
  );
}

async function clickFieldM20Effect({ bridge, info, fieldReference, debugDir }) {
  // Historical live proof: M20 probe around (1000,842), round effect button
  // around (1022,734). Keep the detector relative to the actually confirmed
  // field M20 probe, rather than blindly clicking that old absolute point.
  const expected = { x: fieldReference.x + 22, y: fieldReference.y - 108 };
  const roi = {
    x: Math.max(0, fieldReference.x - 170),
    y: Math.max(0, fieldReference.y - 230),
    width: 360,
    height: 190
  };
  const started = Date.now();
  let last = null;

  while (Date.now() - started < 4500) {
    const image = await captureReferenceRoi(bridge, info, roi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'field_m20_effect_button_latest.png'));
    }
    const stats = yellowUsableStats(image);
    const glyphProof = locateFieldActivateIcon(image, stats, roi, expected);
    const chosen = glyphProof.chosen;
    last = { stats, chosen };
    if (chosen) {
      const reference = { x: roi.x + chosen.centerX, y: roi.y + chosen.centerY };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `真刀场上局部发动图标 PASS: reference=(${Math.round(reference.x)},${Math.round(reference.y)}); ` +
        `component=${chosen.width}x${chosen.height}; componentYellow=${chosen.estimatedPixels}; ` +
        `totalYellow=${stats.estimatedYellowPixels}`
      );
      const priority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: 'AFTER_M20_FIELD_EFFECT_ACTIVATION_RESPONSE_BOUNDARY',
        timeoutMs: 30000
      });
      return {
        reference,
        chosen,
        totalYellow: stats.estimatedYellowPixels,
        roi,
        detector: glyphProof.detector,
        responseBoundaryPriority: priority
      };
    }
    await sleep(120);
  }

  throw new Error(
    `D4_M20_FIELD_EFFECT_BUTTON_NOT_PROVEN:` +
    `yellow=${last && last.stats && last.stats.estimatedYellowPixels || 0}`
  );
}

async function waitForM19DeckPrompt({ bridge, info, debugDir, timeoutMs = 6000 }) {
  const started = Date.now();
  let attempt = 0;
  const stabilize = createPromptStabilityGate(3);
  let proof = null;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    const image = await captureReferenceRoi(bridge, info, PROMPT_ROI);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, `m19_deck_prompt_${String(attempt).padStart(2, '0')}.png`));
    }
    proof = stabilize(classifyM19DeckPrompt(image));
    if (debugDir) writeJson(path.join(debugDir, 'm19_deck_prompt_latest.json'), { ...proof, attempt });
    if (proof.ready) {
      console.log(
        `妖刀牌组选卡窗口 PASS: 真实弹窗结构+稳定${proof.stableFrames}帧; 候选=${proof.points.length}张; ` +
        `centers=[${proof.points.map(p => Math.round(p.x)).join(', ')}]`
      );
      return { ...proof, candidateCount: proof.points.length, attempts: attempt };
    }
    await sleep(140);
  }
  throw new Error(`D4_M19_DECK_PROMPT_TIMEOUT:modal_not_proven;attempts=${attempt};zero_input_wait=1`);
}

async function clickGenericSelect({ bridge, info, debugDir, label }) {
  const started = Date.now();
  let lastYellow = 0;
  while (Date.now() - started < 4000) {
    const image = await captureReferenceRoi(bridge, info, CONFIRM.roi);
    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'generic_select_latest.png'));
    }
    const stats = yellowUsableStats(image);
    lastYellow = stats.estimatedYellowPixels;
    if (lastYellow >= (CONFIRM.minYellowPixels || 650)) {
      const physical = mapReferencePoint(info, CONFIRM.point);
      await bridge.click(physical.x, physical.y);
      console.log(`${label}: yellowPixels=${lastYellow}; reference=(${CONFIRM.point.x},${CONFIRM.point.y})`);
      return { yellowPixels: lastYellow, reference: CONFIRM.point };
    }
    await sleep(120);
  }
  throw new Error(
    `D4_M19_DECK_SELECT_NOT_PROVEN:yellow=${lastYellow};` +
    '妖刀候选已经选中，只允许重试底部“选择”，禁止重新点候选。'
  );
}

async function selectM19FromDeckPrompt({ bridge, info, library, templates, promptProof, debugDir }) {
  const seen = [];
  for (let i = 0; i < promptProof.points.length; i++) {
    const current = classifyM19DeckPrompt(await captureReferenceRoi(bridge, info, PROMPT_ROI));
    if (!promptProof.ready || !sameCandidates(promptProof, current)) {
      throw new Error('D4_M19_DECK_PROMPT_CHANGED_BEFORE_CLICK:zero_input=1');
    }
    const reference = promptProof.points[i];
    const physical = mapReferencePoint(info, reference);
    await bridge.click(physical.x, physical.y);
    await sleep(config.mouseSettleMs || 230);
    const recognized = await recognizeCurrent({ bridge, info, library, templates });
    seen.push({ index: i + 1, reference, recognized });
    console.log(
      `妖刀牌组选卡候选${i + 1}: ${recognized.name}[${recognized.id}] ` +
      `${recognized.accepted && recognized.id === M19.id ? 'PASS' : 'UNKNOWN'}`
    );

    if (recognized.accepted && recognized.id === M19.id) {
      await waitBeforePromptSubmit('真刀效果选择妖刀');
      const submitProof = await clickGenericSelect({
        bridge,
        info,
        debugDir,
        label: '妖刀“选择”按钮 PASS'
      });
      const priority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: 'AFTER_M20_DECK_EQUIP_RESOLUTION_RESPONSE_BOUNDARY',
        timeoutMs: 30000
      });
      return {
        selected: recognized,
        selectedIndex: i + 1,
        selectedReference: reference,
        seen,
        submitProof,
        responseBoundaryPriority: priority
      };
    }

    // Restore an unrelated candidate to unselected state before probing next.
    await bridge.click(physical.x, physical.y);
    await sleep(150);
  }

  throw new Error(
    `D4_M19_NOT_FOUND_IN_DECK_PROMPT:` +
    `${seen.map(x => `${x.recognized.name}[${x.recognized.id}]`).join('|') || 'NONE'}`
  );
}

module.exports = {
  FIELD_PROBE_POINTS,
  locateFieldM20,
  clickFieldM20Effect,
  waitForM19DeckPrompt,
  selectM19FromDeckPrompt
};
