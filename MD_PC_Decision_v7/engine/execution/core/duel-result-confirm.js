'use strict';

const fs = require('fs');
const path = require('path');
const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');
const { cropImage } = require('../../lib/png-utils');

const ROOT = path.resolve(__dirname, '..', '..');
const VICTORY_TITLE_ROI = { x: 180, y: 420, width: 1480, height: 310 };
const VICTORY_CROWN_ROI = { x: 90, y: 820, width: 190, height: 170 };
const RESULT_CONFIRM_ROI = { x: 950, y: 1005, width: 150, height: 65 };
const RESULT_CONFIRM_REFERENCE = { x: 1024, y: 1037 };

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sampledRatio(image, predicate) {
  let matched = 0;
  let total = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) matched += 1;
      total += 1;
    }
  }
  return total ? matched / total : 0;
}

function detectVictoryResultConfirm(titleImage, crownImage, confirmImage) {
  const titleWhiteRatio = sampledRatio(titleImage, (r, g, b) => Math.min(r, g, b) > 185);
  const leftCrownGoldRatio = sampledRatio(
    crownImage,
    (r, g, b) => r > 150 && g > 100 && b < 90 && r > b * 1.8 && g > b * 1.4
  );
  const confirmLimeRatio = sampledRatio(
    confirmImage,
    (r, g, b) => r > 100 && g > 110 && g > b * 1.5 && r > b * 1.5
  );
  const confirmDarkRatio = sampledRatio(
    confirmImage,
    (r, g, b) => Math.max(r, g, b) < 60
  );
  const normalButton = confirmLimeRatio >= 0.025 && confirmDarkRatio >= 0.75;
  const hoveredButton = confirmLimeRatio >= 0.08 && confirmDarkRatio >= 0.65;
  return {
    pass: titleWhiteRatio >= 0.30 && leftCrownGoldRatio >= 0.08 &&
      (normalButton || hoveredButton),
    detector: 'VICTORY_RESULT_CONFIRM_V2',
    buttonMode: normalButton ? 'NORMAL' : (hoveredButton ? 'HOVERED' : 'UNPROVEN'),
    titleWhiteRatio,
    leftCrownGoldRatio,
    confirmLimeRatio,
    confirmDarkRatio,
    reference: { ...RESULT_CONFIRM_REFERENCE }
  };
}

async function safeForeground(bridge, label) {
  const activation = await activateAndVerifyMasterDuel(bridge, {
    requireSelfPriorityBlue: false,
    priorityLabel: label
  });
  return activation.info;
}

async function captureVictoryProof(bridge, info) {
  // All three proofs belong to one frame, using one bridge capture rather
  // than three serialized IPC/capture rounds.
  const roi = { x: 90, y: 420, width: 1570, height: 650 };
  const frame = await captureReferenceRoi(bridge, info, roi);
  const crop = part => cropImage(frame, { ...part, x: part.x - roi.x, y: part.y - roi.y });
  const title = crop(VICTORY_TITLE_ROI);
  const crown = crop(VICTORY_CROWN_ROI);
  const confirm = crop(RESULT_CONFIRM_ROI);
  return {
    title,
    crown,
    confirm,
    proof: detectVictoryResultConfirm(title, crown, confirm)
  };
}

async function runVictoryResultConfirm(options = {}) {
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  const debugDir = options.debugDir || path.join(
    ROOT,
    'debug',
    'execution',
    'duel-result-confirm',
    timestampForPath()
  );
  fs.mkdirSync(debugDir, { recursive: true });

  try {
    if (ownsBridge) await bridge.start();
    let info = await safeForeground(bridge, 'VICTORY_RESULT_CONFIRM_START');
    let last = null;
    let stable = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      last = await captureVictoryProof(bridge, info);
      stable = last.proof.pass ? stable + 1 : 0;
      if (stable >= 2) break;
      await sleep(180);
      info = await safeForeground(bridge, 'WAIT_VICTORY_RESULT_CONFIRM');
    }
    if (!last || stable < 2) {
      if (last) {
        fs.writeFileSync(path.join(debugDir, 'failed_proof.json'), JSON.stringify(last.proof, null, 2));
        saveRgbaPng(last.title, path.join(debugDir, 'victory_title_failed.png'));
        saveRgbaPng(last.crown, path.join(debugDir, 'victory_crown_failed.png'));
        saveRgbaPng(last.confirm, path.join(debugDir, 'victory_confirm_failed.png'));
      }
      throw new Error('VICTORY_RESULT_CONFIRM_NOT_PROVEN');
    }

    saveRgbaPng(last.title, path.join(debugDir, 'victory_title.png'));
    saveRgbaPng(last.crown, path.join(debugDir, 'victory_crown.png'));
    saveRgbaPng(last.confirm, path.join(debugDir, 'victory_confirm.png'));
    console.log(
      `胜利结果页 PASS: titleWhite=${last.proof.titleWhiteRatio.toFixed(4)}; ` +
      `leftCrownGold=${last.proof.leftCrownGoldRatio.toFixed(4)}; ` +
      `confirmLime=${last.proof.confirmLimeRatio.toFixed(4)}; ` +
      `reference=(${last.proof.reference.x},${last.proof.reference.y})`
    );

    info = await safeForeground(bridge, 'BEFORE_VICTORY_RESULT_CONFIRM_CLICK');
    const current = await captureVictoryProof(bridge, info);
    if (!current.proof.pass) throw new Error('VICTORY_RESULT_CONFIRM_CHANGED_BEFORE_CLICK');
    const point = mapReferencePoint(info, last.proof.reference);
    await bridge.click(point.x, point.y);
    await sleep(900);

    return {
      status: 'VICTORY_RESULT_CONFIRMED',
      debugDir,
      reference: last.proof.reference
    };
  } finally {
    if (ownsBridge) await bridge.stop().catch(() => {});
  }
}

module.exports = {
  VICTORY_TITLE_ROI,
  VICTORY_CROWN_ROI,
  RESULT_CONFIRM_ROI,
  detectVictoryResultConfirm,
  runVictoryResultConfirm
};
