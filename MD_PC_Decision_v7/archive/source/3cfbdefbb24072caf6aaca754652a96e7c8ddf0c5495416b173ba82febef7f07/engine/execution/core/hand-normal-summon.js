'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const config = require(path.join(ROOT, 'live-config'));
const { captureReferenceRoi, mapReferencePoint, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { cropImage } = require(path.join(ROOT, 'lib', 'png-utils'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));

const FULL_REFERENCE_ROI = { x: 0, y: 0, width: 2048, height: 1152 };
const ACTION_BUTTON_GEOMETRY = Object.freeze({
  minDy: -230,
  maxDy: -105,
  summonMinDx: -155,
  summonMaxDx: -25,
  setMinDx: 25,
  setMaxDx: 155,
  minPairSeparationX: 110,
  maxPairSeparationX: 260,
  maxPairCenterDeltaY: 45,
  minPairPixelRatio: 0.45,
  maxPairPixelRatio: 2.2
});

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function isSummonButtonPixel(r, g, b) {
  return b >= 120 && g >= 70 && b > r * 1.25 && g > r * 1.02 && b >= r + 28;
}

function buildNormalSummonActionRoi(clickReference, options = {}) {
  if (!clickReference || !Number.isFinite(clickReference.x) || !Number.isFinite(clickReference.y)) {
    throw new Error('EXEC_NORMAL_SUMMON_HAND_ANCHOR_MISSING');
  }
  const padding = options.horizontalPadding || 190;
  const left = Math.max(0, Math.round(clickReference.x - padding));
  const top = Math.max(0, Math.round(clickReference.y - (options.topOffset || 300)));
  const right = Math.min(FULL_REFERENCE_ROI.width, Math.round(clickReference.x + padding));
  const bottom = Math.min(FULL_REFERENCE_ROI.height, Math.round(clickReference.y - (options.bottomOffset || 55)));
  if (right - left < 80 || bottom - top < 80) {
    throw new Error(`EXEC_NORMAL_SUMMON_ACTION_ROI_INVALID:${JSON.stringify(clickReference)}`);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function colorDistanceAt(a, b, offset) {
  return Math.abs(a.data[offset] - b.data[offset]) +
    Math.abs(a.data[offset + 1] - b.data[offset + 1]) +
    Math.abs(a.data[offset + 2] - b.data[offset + 2]);
}

function detectNormalSummonButton(neutralImage, selectedImage, options = {}) {
  if (!neutralImage || !selectedImage ||
      neutralImage.width !== selectedImage.width || neutralImage.height !== selectedImage.height) {
    throw new Error('EXEC_NORMAL_SUMMON_DIFFERENTIAL_IMAGE_MISMATCH');
  }

  const handAnchor = options.handAnchorLocal || {
    x: selectedImage.width / 2,
    y: selectedImage.height + 55
  };
  const mask = new Uint8Array(selectedImage.width * selectedImage.height);
  let newBluePixels = 0;

  for (let y = 0; y < selectedImage.height; y++) {
    for (let x = 0; x < selectedImage.width; x++) {
      const offset = (y * selectedImage.width + x) * 4;
      const currentBlue = isSummonButtonPixel(
        selectedImage.data[offset], selectedImage.data[offset + 1], selectedImage.data[offset + 2]
      );
      if (!currentBlue) continue;
      const neutralBlue = isSummonButtonPixel(
        neutralImage.data[offset], neutralImage.data[offset + 1], neutralImage.data[offset + 2]
      );
      if (!neutralBlue || colorDistanceAt(neutralImage, selectedImage, offset) >= 75) {
        mask[y * selectedImage.width + x] = 1;
        newBluePixels++;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const components = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let pixels = 0;
    let minX = selectedImage.width;
    let minY = selectedImage.height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;

    while (top > 0) {
      const index = stack[--top];
      const x = index % selectedImage.width;
      const y = Math.floor(index / selectedImage.width);
      pixels++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= selectedImage.width || ny >= selectedImage.height) continue;
          const next = ny * selectedImage.width + nx;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack[top++] = next;
        }
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const centerX = sumX / pixels;
    const centerY = sumY / pixels;
    const fillRatio = pixels / (width * height);
    const dxFromHand = centerX - handAnchor.x;
    const dyFromHand = centerY - handAnchor.y;
    components.push({
      pixels,
      x: minX,
      y: minY,
      width,
      height,
      centerX,
      centerY,
      fillRatio,
      dxFromHand,
      dyFromHand
    });
  }

  const candidates = components
    .filter(component =>
      component.pixels >= 700 &&
      component.width >= 42 && component.width <= 120 &&
      component.height >= 28 && component.height <= 90 &&
      component.fillRatio >= 0.18 &&
      component.dyFromHand >= ACTION_BUTTON_GEOMETRY.minDy &&
      component.dyFromHand <= ACTION_BUTTON_GEOMETRY.maxDy
    )
    .map(component => ({
      ...component,
      score: component.pixels + component.fillRatio * 400
    }))
    .sort((a, b) => b.score - a.score);

  const summonCandidates = candidates.filter(component =>
    component.dxFromHand >= ACTION_BUTTON_GEOMETRY.summonMinDx &&
    component.dxFromHand <= ACTION_BUTTON_GEOMETRY.summonMaxDx
  );
  const setCandidates = candidates.filter(component =>
    component.dxFromHand >= ACTION_BUTTON_GEOMETRY.setMinDx &&
    component.dxFromHand <= ACTION_BUTTON_GEOMETRY.setMaxDx
  );
  const pairs = [];
  for (const summon of summonCandidates) {
    for (const set of setCandidates) {
      const separationX = set.centerX - summon.centerX;
      const centerDeltaY = Math.abs(set.centerY - summon.centerY);
      const pixelRatio = summon.pixels / set.pixels;
      if (separationX < ACTION_BUTTON_GEOMETRY.minPairSeparationX ||
          separationX > ACTION_BUTTON_GEOMETRY.maxPairSeparationX ||
          centerDeltaY > ACTION_BUTTON_GEOMETRY.maxPairCenterDeltaY ||
          pixelRatio < ACTION_BUTTON_GEOMETRY.minPairPixelRatio ||
          pixelRatio > ACTION_BUTTON_GEOMETRY.maxPairPixelRatio) {
        continue;
      }
      pairs.push({
        summon,
        set,
        separationX,
        centerDeltaY,
        pixelRatio,
        score: summon.score + set.score - centerDeltaY * 8
      });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const chosenPair = pairs[0] || null;
  const rejectionReason = chosenPair
    ? null
    : summonCandidates.length === 0
      ? 'LEFT_SUMMON_COMPONENT_MISSING'
      : setCandidates.length === 0
        ? 'RIGHT_SET_COMPONENT_MISSING'
        : 'SUMMON_SET_PAIR_GEOMETRY_INVALID';

  return {
    visible: Boolean(chosenPair),
    detector: 'NORMAL_SUMMON_PAIRED_BLUE_COMPONENT_V3',
    newBluePixels,
    handAnchorLocal: handAnchor,
    geometry: ACTION_BUTTON_GEOMETRY,
    chosen: chosenPair ? chosenPair.summon : null,
    rejectedSet: chosenPair ? chosenPair.set : null,
    chosenPair,
    rejectionReason,
    summonCandidates: summonCandidates.slice(0, 4),
    setCandidates: setCandidates.slice(0, 4),
    candidates: candidates.slice(0, 8),
    componentCount: components.length
  };
}

async function captureNeutralNormalSummonFrame(options) {
  const { bridge, info, debugDir } = options;
  const safeRef = config.handFan.slotResetMousePoint || { x: 856, y: 195 };
  const safe = mapReferencePoint(info, safeRef);
  await bridge.click(safe.x, safe.y);
  await sleep(Math.max(80, Number(config.handFan.slotResetClickSettleMs || 80)));
  await bridge.key('ESC').catch(() => {});
  await sleep(Math.max(120, Number(config.handFan.slotResetSettleMs || 120)));
  const image = await captureReferenceRoi(bridge, info, FULL_REFERENCE_ROI);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, 'neutral_before_hand_selection.png'));
  }
  return image;
}

async function clickSelectedMonsterNormalSummon(options) {
  const { bridge, info, expectedId, expectedName, clickReference, neutralFrame, neutralActionFrame, debugDir } = options;
  if (!neutralActionFrame && (!neutralFrame || neutralFrame.width !== 2048 || neutralFrame.height !== 1152)) {
    throw new Error('EXEC_NORMAL_SUMMON_NEUTRAL_FRAME_MISSING');
  }

  const roi = neutralActionFrame ? neutralActionFrame.roi : buildNormalSummonActionRoi(clickReference);
  const neutralImage = neutralActionFrame ? neutralActionFrame.image : cropImage(neutralFrame, roi);
  if (!neutralImage || neutralImage.width !== roi.width || neutralImage.height !== roi.height ||
      (neutralActionFrame && (Math.abs(neutralActionFrame.clickReference.x - clickReference.x) > 1 ||
        Math.abs(neutralActionFrame.clickReference.y - clickReference.y) > 1))) {
    throw new Error('EXEC_NORMAL_SUMMON_NEUTRAL_ANCHOR_MISMATCH');
  }
  const handAnchorLocal = { x: clickReference.x - roi.x, y: clickReference.y - roi.y };
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(neutralImage, path.join(debugDir, 'normal_summon_neutral_roi.png'));
  }
  let last = null;

  // The hand card is already selected and identity-proven by hand-target.
  // Re-observe the newly appeared action UI only; never click the selected card again.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const image = await captureReferenceRoi(bridge, info, roi);
    if (debugDir) saveRgbaPng(image, path.join(debugDir, `normal_summon_selected_attempt${attempt}.png`));
    const proof = detectNormalSummonButton(neutralImage, image, { handAnchorLocal });
    last = { attempt, roi, proof };
    if (debugDir) writeJson(path.join(debugDir, `normal_summon_button_attempt${attempt}.json`), last);

    if (proof.visible && proof.chosen) {
      // Revalidate the actual pair immediately before input. A changed menu
      // must stop without retrying the hand click or substituting Set/Effect.
      const current = await captureReferenceRoi(bridge, info, roi);
      const currentProof = detectNormalSummonButton(neutralImage, current, { handAnchorLocal });
      if (debugDir) {
        saveRgbaPng(current, path.join(debugDir, 'normal_summon_before_click.png'));
        writeJson(path.join(debugDir, 'normal_summon_before_click.json'), { roi, proof: currentProof });
      }
      if (!currentProof.visible ||
          Math.abs(currentProof.chosen.centerX - proof.chosen.centerX) > 10 ||
          Math.abs(currentProof.chosen.centerY - proof.chosen.centerY) > 10 ||
          Math.abs(currentProof.rejectedSet.centerX - proof.rejectedSet.centerX) > 10 ||
          Math.abs(currentProof.rejectedSet.centerY - proof.rejectedSet.centerY) > 10) {
        throw new Error('EXEC_NORMAL_SUMMON_MENU_CHANGED_BEFORE_CLICK');
      }
      const reference = { x: roi.x + currentProof.chosen.centerX, y: roi.y + currentProof.chosen.centerY };
      const physical = mapReferencePoint(info, reference);
      console.log(
        `通常召唤按钮确认: ${expectedName || expectedId}[${expectedId}]; ` +
        `detector=${currentProof.detector}; newBlue=${currentProof.newBluePixels}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)}); ` +
        `已拒绝右侧设置=(${Math.round(roi.x + currentProof.rejectedSet.centerX)},${Math.round(roi.y + currentProof.rejectedSet.centerY)})`
      );
      await bridge.click(physical.x, physical.y);
      const priority = await waitForSelfPriorityBlue({
        bridge,
        info,
        label: `AFTER_${expectedId}_NORMAL_SUMMON_RESPONSE_BOUNDARY`,
        timeoutMs: 30000
      });
      return {
        detector: currentProof.detector,
        clickReference: reference,
        handAnchorReference: clickReference,
        roi,
        chosen: currentProof.chosen,
        newBluePixels: currentProof.newBluePixels,
        attempt,
        rejectedSet: currentProof.rejectedSet,
        chosenPair: currentProof.chosenPair,
        selectionPolicy: 'ONE_HAND_CARD_CLICK_ONLY_PAIRED_RELATIVE_GEOMETRY_LEFT_SUMMON',
        responseBoundaryPriority: priority
      };
    }
    if (attempt < 2) await sleep(180);
  }

  throw new Error(
    `EXEC_NORMAL_SUMMON_BUTTON_NOT_PROVEN:${expectedName || expectedId}[${expectedId}];` +
    `newBlue=${last && last.proof && last.proof.newBluePixels || 0};` +
    `reason=${last && last.proof && last.proof.rejectionReason || 'UNKNOWN'};` +
    '目标牌已经选中，禁止重复点击手牌。'
  );
}

module.exports = {
  isSummonButtonPixel,
  buildNormalSummonActionRoi,
  detectNormalSummonButton,
  captureNeutralNormalSummonFrame,
  clickSelectedMonsterNormalSummon
};
