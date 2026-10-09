'use strict';
const { invalidateHandWindow } = require('./hand-window-validity');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const config = require(path.join(ROOT, 'live-config'));
const {
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { waitForSelfPriorityBlue } = require(path.join(ROOT, 'lib', 'self-priority-gate'));
const { locateHandActivateIcon } = require('./hand-action-icon');

function chooseActivationButton(stats, roi, clickReference, image) {
  return locateHandActivateIcon(stats, roi, clickReference, image).chosen;
}

async function probeActivationButton(bridge, info, clickReference, debugDir, attempt) {
  const u = config.toonChain.activationRoi;
  const roi = {
    x: Math.max(0, Math.min(config.screen.width - u.width, Math.round(clickReference.x + u.offsetX))),
    y: Math.max(0, Math.min(config.screen.height - u.height, Math.round(clickReference.y + u.offsetY))),
    width: u.width,
    height: u.height,
    minComponentPixels: u.minComponentPixels
  };
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    saveRgbaPng(image, path.join(debugDir, `activation_roi_attempt${attempt}.png`));
  }
  const stats = yellowUsableStats(image);
  const proof = locateHandActivateIcon(stats, roi, clickReference, image);
  return { roi, stats, button: proof.chosen, proof };
}

async function clickSelectedHandSpellActivation(options) {
  const {
    bridge,
    info,
    expectedId,
    expectedName,
    clickReference,
    debugDir
  } = options;

  // Reuse the existing ROI and yellow sampling, but require a hand-menu icon,
  // not just the largest yellow blob. After physical selection and identity
  // verification, never reselect the card to repair a missing menu. At most
  // re-observe once with zero input, then stop safely.
  let probe = await probeActivationButton(bridge, info, clickReference, debugDir, 1);
  let probeAttempts = 1;
  if (!probe.button) {
    await sleep(180);
    probe = await probeActivationButton(bridge, info, clickReference, debugDir, 2);
    probeAttempts = 2;
  }

  const { roi, stats, button, proof } = probe;
  if (!button) {
    throw new Error(
      `EXEC_ACTIVATION_BUTTON_NOT_PROVEN:${expectedName || expectedId}[${expectedId}];` +
      `reason=${proof.rejectionReason};yellowPixels=${stats.estimatedYellowPixels};` +
      '目标牌已经点击，禁止重复点击候选牌。'
    );
  }

  const referenceButton = {
    x: roi.x + button.centerX,
    y: roi.y + button.centerY
  };
  const physicalButton = mapReferencePoint(info, referenceButton);
  console.log(
    `发动按钮确认: ${expectedName || expectedId}[${expectedId}] ` +
    `reference=(${Math.round(referenceButton.x)},${Math.round(referenceButton.y)}); ` +
    `component=${button.width}x${button.height}; yellowPixels=${stats.estimatedYellowPixels}`
  );
  invalidateHandWindow(bridge);
  await bridge.click(physicalButton.x, physicalButton.y);
  const priority = await waitForSelfPriorityBlue({
    bridge,
    info,
    label: `AFTER_${expectedId}_ACTIVATION_RESPONSE_BOUNDARY`,
    timeoutMs: 30000
  });

  return {
    activationButton: {
      reference: referenceButton,
      width: button.width,
      height: button.height,
      fillRatio: button.fillRatio,
      estimatedPixels: button.estimatedPixels,
      menuMode: button.menuMode,
      expectedReference: button.expectedReference,
      drift: button.drift,
      glyph: button.glyph
    },
    yellowPixels: stats.estimatedYellowPixels,
    probeAttempts,
    detector: proof.detector,
    selectionPolicy: 'ONE_TARGET_CLICK_ONLY',
    responseBoundaryPriority: priority
  };
}

module.exports = {
  chooseActivationButton,
  clickSelectedHandSpellActivation
};
