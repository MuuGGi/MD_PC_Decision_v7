'use strict';

const fs = require('fs');
const path = require('path');
const { MdFastBridge, captureReferenceRoi, mapReferencePoint, sleep } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE = { width: 2048, height: 1152 };
const GEAR_ROI = { x: 10, y: 10, width: 90, height: 90 };
const SETTINGS_HEADER_ROI = { x: 0, y: 0, width: 525, height: 330 };
const SURRENDER_ROI = { x: 80, y: 940, width: 420, height: 190 };
const SURRENDER_CONFIRM_ALERT_ROI = { x: 940, y: 410, width: 180, height: 85 };
const SURRENDER_CONFIRM_YES_ROI = { x: 1160, y: 665, width: 120, height: 65 };
const DEFEAT_TITLE_ROI = { x: 500, y: 450, width: 1050, height: 230 };
const DEFEAT_CONFIRM_ROI = { x: 950, y: 1005, width: 150, height: 65 };
const GEAR_REFERENCE = { x: 54, y: 55 };
const SURRENDER_CONFIRM_YES_REFERENCE = { x: 1218, y: 697 };
const DEFEAT_CONFIRM_REFERENCE = { x: 1024, y: 1037 };

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sampledColorRatio(image, predicate, step = 2) {
  let matches = 0;
  let total = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) matches += 1;
      total += 1;
    }
  }
  return total ? matches / total : 0;
}

function detectDuelGear(gearImage) {
  const cyanRatio = sampledColorRatio(
    gearImage,
    (r, g, b) => b > 100 && g > 80 && b > r * 1.25 && g > r * 1.20
  );
  return {
    pass: cyanRatio >= 0.10,
    detector: 'DUEL_GEAR_CYAN_ROI_V1',
    cyanRatio,
    reference: { ...GEAR_REFERENCE }
  };
}

function detectSurrenderSettings(headerImage, surrenderImage) {
  const headerDarkRatio = sampledColorRatio(
    headerImage,
    (r, g, b) => Math.max(r, g, b) < 70
  );
  const redRatio = sampledColorRatio(
    surrenderImage,
    (r, g, b) => r > 90 && r > g * 1.5 && r > b * 1.25
  );

  let sumX = 0;
  let sumY = 0;
  let redPixels = 0;
  for (let y = 0; y < surrenderImage.height; y++) {
    for (let x = 0; x < surrenderImage.width; x++) {
      const i = (y * surrenderImage.width + x) * 4;
      const r = surrenderImage.data[i];
      const g = surrenderImage.data[i + 1];
      const b = surrenderImage.data[i + 2];
      if (r > 90 && r > g * 1.5 && r > b * 1.25) {
        sumX += x;
        sumY += y;
        redPixels += 1;
      }
    }
  }

  const centroid = redPixels
    ? {
        x: SURRENDER_ROI.x + sumX / redPixels,
        y: SURRENDER_ROI.y + sumY / redPixels
      }
    : null;
  const centroidSafe = centroid &&
    centroid.x >= 170 && centroid.x <= 410 &&
    centroid.y >= 995 && centroid.y <= 1090;

  return {
    pass: headerDarkRatio >= 0.65 && redRatio >= 0.18 && Boolean(centroidSafe),
    detector: 'DUEL_SETTINGS_SURRENDER_RED_ROI_V1',
    headerDarkRatio,
    redRatio,
    redPixels,
    reference: centroidSafe
      ? { x: Math.round(centroid.x), y: Math.round(centroid.y) }
      : null
  };
}

function detectSurrenderConfirmation(alertImage, yesImage) {
  const alertRedRatio = sampledColorRatio(
    alertImage,
    (r, g, b) => r > 140 && r > g * 1.6 && r > b * 1.3,
    1
  );
  const alertDarkRatio = sampledColorRatio(
    alertImage,
    (r, g, b) => Math.max(r, g, b) < 60,
    1
  );
  const yesLimeRatio = sampledColorRatio(
    yesImage,
    (r, g, b) => r > 100 && g > 110 && g > b * 1.5 && r > b * 1.5,
    1
  );
  const yesDarkRatio = sampledColorRatio(
    yesImage,
    (r, g, b) => Math.max(r, g, b) < 60,
    1
  );
  return {
    pass: alertRedRatio >= 0.07 && alertDarkRatio >= 0.70 &&
      yesLimeRatio >= 0.02 && yesDarkRatio >= 0.75,
    detector: 'SURRENDER_CONFIRM_ALERT_AND_YES_V1',
    alertRedRatio,
    alertDarkRatio,
    yesLimeRatio,
    yesDarkRatio,
    reference: { ...SURRENDER_CONFIRM_YES_REFERENCE }
  };
}

function detectSurrenderDefeatResult(titleImage, confirmImage) {
  const titleWhiteRatio = sampledColorRatio(
    titleImage,
    (r, g, b) => Math.min(r, g, b) > 185,
    1
  );
  const confirmLimeRatio = sampledColorRatio(
    confirmImage,
    (r, g, b) => r > 100 && g > 110 && g > b * 1.5 && r > b * 1.5,
    1
  );
  const confirmDarkRatio = sampledColorRatio(
    confirmImage,
    (r, g, b) => Math.max(r, g, b) < 60,
    1
  );
  return {
    pass: titleWhiteRatio >= 0.20 && confirmLimeRatio >= 0.025 && confirmDarkRatio >= 0.75,
    detector: 'SURRENDER_DEFEAT_RESULT_CONFIRM_V1',
    titleWhiteRatio,
    confirmLimeRatio,
    confirmDarkRatio,
    reference: { ...DEFEAT_CONFIRM_REFERENCE }
  };
}

async function safeForeground(bridge, label) {
  const activation = await activateAndVerifyMasterDuel(bridge, {
    requireSelfPriorityBlue: false,
    priorityLabel: label
  });
  return activation.info;
}

async function captureSettingsProof(bridge, info) {
  const [header, surrender] = await Promise.all([
    captureReferenceRoi(bridge, info, SETTINGS_HEADER_ROI),
    captureReferenceRoi(bridge, info, SURRENDER_ROI)
  ]);
  return {
    header,
    surrender,
    proof: detectSurrenderSettings(header, surrender)
  };
}

async function captureSurrenderConfirmationProof(bridge, info) {
  const [alert, yes] = await Promise.all([
    captureReferenceRoi(bridge, info, SURRENDER_CONFIRM_ALERT_ROI),
    captureReferenceRoi(bridge, info, SURRENDER_CONFIRM_YES_ROI)
  ]);
  return {
    alert,
    yes,
    proof: detectSurrenderConfirmation(alert, yes)
  };
}

async function captureDefeatResultProof(bridge, info) {
  const [title, confirm] = await Promise.all([
    captureReferenceRoi(bridge, info, DEFEAT_TITLE_ROI),
    captureReferenceRoi(bridge, info, DEFEAT_CONFIRM_ROI)
  ]);
  return {
    title,
    confirm,
    proof: detectSurrenderDefeatResult(title, confirm)
  };
}

async function waitForDefeatResult(bridge, info, debugDir) {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    last = await captureDefeatResultProof(bridge, info);
    stable = last.proof.pass ? stable + 1 : 0;
    if (stable >= 2) return last;
    await sleep(150);
    info = await safeForeground(bridge, 'WAIT_SURRENDER_DEFEAT_RESULT');
  }
  if (last) {
    saveRgbaPng(last.title, path.join(debugDir, '04_defeat_title_failed.png'));
    saveRgbaPng(last.confirm, path.join(debugDir, '04_defeat_confirm_failed.png'));
  }
  throw new Error('SURRENDER_DEFEAT_RESULT_NOT_PROVEN');
}

async function waitForSurrenderConfirmation(bridge, info, debugDir) {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    last = await captureSurrenderConfirmationProof(bridge, info);
    stable = last.proof.pass ? stable + 1 : 0;
    if (stable >= 2) return last;
    await sleep(120);
    info = await safeForeground(bridge, 'WAIT_SURRENDER_CONFIRMATION');
  }
  if (last) {
    saveRgbaPng(last.alert, path.join(debugDir, '03_confirm_alert_failed.png'));
    saveRgbaPng(last.yes, path.join(debugDir, '03_confirm_yes_failed.png'));
  }
  throw new Error('SURRENDER_CONFIRMATION_NOT_PROVEN');
}

async function runConfirmedDeadlockSurrender(options = {}) {
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  const debugDir = options.debugDir || path.join(
    ROOT,
    'debug',
    'execution',
    'deadlock-surrender',
    timestampForPath()
  );
  fs.mkdirSync(debugDir, { recursive: true });

  try {
    if (ownsBridge) await bridge.start();
    let info = await safeForeground(bridge, 'DEADLOCK_SURRENDER_START');
    let defeat = await captureDefeatResultProof(bridge, info);
    if (defeat.proof.pass) {
      await sleep(150);
      info = await safeForeground(bridge, 'RESUME_EXISTING_DEFEAT_RESULT');
      defeat = await captureDefeatResultProof(bridge, info);
      if (!defeat.proof.pass) throw new Error('SURRENDER_DEFEAT_RESULT_NOT_STABLE_ON_RESUME');
      console.log('检测到已经打开的投降结果页；跳过齿轮、投降按钮和确认框，不重复点击。');
    }

    let confirmation = await captureSurrenderConfirmationProof(bridge, info);
    if (!defeat.proof.pass && confirmation.proof.pass) {
      await sleep(120);
      info = await safeForeground(bridge, 'RESUME_EXISTING_SURRENDER_CONFIRMATION');
      confirmation = await captureSurrenderConfirmationProof(bridge, info);
      if (!confirmation.proof.pass) {
        throw new Error('SURRENDER_CONFIRMATION_NOT_STABLE_ON_RESUME');
      }
      console.log('检测到已经打开的“是否投降？”窗口；跳过齿轮和投降按钮，不重复点击。');
    }

    let settings = null;
    if (!defeat.proof.pass && !confirmation.proof.pass) {
      settings = await captureSettingsProof(bridge, info);
    }
    if (!defeat.proof.pass && !confirmation.proof.pass && !settings.proof.pass) {
      const gearImage = await captureReferenceRoi(bridge, info, GEAR_ROI);
      saveRgbaPng(gearImage, path.join(debugDir, '01_gear_roi.png'));
      const gear = detectDuelGear(gearImage);
      if (!gear.pass) {
        throw new Error(`DEADLOCK_SURRENDER_GEAR_NOT_PROVEN:cyan=${gear.cyanRatio.toFixed(4)}`);
      }

      info = await safeForeground(bridge, 'BEFORE_DEADLOCK_GEAR_CLICK');
      const gearPoint = mapReferencePoint(info, gear.reference);
      await bridge.click(gearPoint.x, gearPoint.y);

      let stable = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(120);
        info = await safeForeground(bridge, 'WAIT_DEADLOCK_SETTINGS');
        settings = await captureSettingsProof(bridge, info);
        stable = settings.proof.pass ? stable + 1 : 0;
        if (stable >= 2) break;
      }
      if (stable < 2) {
        saveRgbaPng(settings.header, path.join(debugDir, '02_settings_header_failed.png'));
        saveRgbaPng(settings.surrender, path.join(debugDir, '02_surrender_roi_failed.png'));
        throw new Error('DEADLOCK_SURRENDER_SETTINGS_NOT_PROVEN');
      }
    }

    if (!defeat.proof.pass && !confirmation.proof.pass) {
      saveRgbaPng(settings.header, path.join(debugDir, '02_settings_header.png'));
      saveRgbaPng(settings.surrender, path.join(debugDir, '02_surrender_roi.png'));
      console.log(
        `投降按钮识别 PASS: headerDark=${settings.proof.headerDarkRatio.toFixed(4)}; ` +
        `red=${settings.proof.redRatio.toFixed(4)}; reference=(${settings.proof.reference.x},${settings.proof.reference.y})`
      );

      info = await safeForeground(bridge, 'BEFORE_DEADLOCK_SURRENDER_CLICK');
      const surrenderPoint = mapReferencePoint(info, settings.proof.reference);
      await bridge.click(surrenderPoint.x, surrenderPoint.y);
      confirmation = await waitForSurrenderConfirmation(bridge, info, debugDir);
    }
    if (!defeat.proof.pass) {
      saveRgbaPng(confirmation.alert, path.join(debugDir, '03_confirm_alert.png'));
      saveRgbaPng(confirmation.yes, path.join(debugDir, '03_confirm_yes.png'));
      console.log(
        `投降确认框 PASS: alertRed=${confirmation.proof.alertRedRatio.toFixed(4)}; ` +
        `yesLime=${confirmation.proof.yesLimeRatio.toFixed(4)}; ` +
        `reference=(${confirmation.proof.reference.x},${confirmation.proof.reference.y})`
      );

      info = await safeForeground(bridge, 'BEFORE_SURRENDER_CONFIRM_YES_CLICK');
      const yesPoint = mapReferencePoint(info, confirmation.proof.reference);
      await bridge.click(yesPoint.x, yesPoint.y);
      console.log('BRANCH PURE WAIT: SURRENDER_AFTER_YES; 4000ms; no capture, recognition or input.');
      await sleep(4000);
      info = await safeForeground(bridge, 'AFTER_SURRENDER_PURE_WAIT');
      defeat = await waitForDefeatResult(bridge, info, debugDir);
    }

    saveRgbaPng(defeat.title, path.join(debugDir, '04_defeat_title.png'));
    saveRgbaPng(defeat.confirm, path.join(debugDir, '04_defeat_confirm.png'));
    console.log(
      `投降结果页 PASS: titleWhite=${defeat.proof.titleWhiteRatio.toFixed(4)}; ` +
      `confirmLime=${defeat.proof.confirmLimeRatio.toFixed(4)}; ` +
      `reference=(${defeat.proof.reference.x},${defeat.proof.reference.y})`
    );

    info = await safeForeground(bridge, 'BEFORE_SURRENDER_RESULT_CONFIRM_CLICK');
    const resultConfirmPoint = mapReferencePoint(info, defeat.proof.reference);
    await bridge.click(resultConfirmPoint.x, resultConfirmPoint.y);

    await sleep(900);
    info = await safeForeground(bridge, 'AFTER_SURRENDER_RESULT_CONFIRM_CLICK');
    const after = await captureReferenceRoi(bridge, info, {
      x: 0,
      y: 0,
      width: REFERENCE.width,
      height: REFERENCE.height
    });
    const afterPath = path.join(debugDir, '05_after_result_confirm_full.png');
    saveRgbaPng(after, afterPath);

    return {
      status: 'SURRENDER_COMPLETE',
      debugDir,
      afterPath,
      surrenderReference: settings && settings.proof ? settings.proof.reference : null,
      resumedExistingConfirmation: !settings
    };
  } finally {
    if (ownsBridge) await bridge.stop().catch(() => {});
  }
}

module.exports = {
  GEAR_ROI,
  SETTINGS_HEADER_ROI,
  SURRENDER_ROI,
  SURRENDER_CONFIRM_ALERT_ROI,
  SURRENDER_CONFIRM_YES_ROI,
  DEFEAT_TITLE_ROI,
  DEFEAT_CONFIRM_ROI,
  detectDuelGear,
  detectSurrenderSettings,
  detectSurrenderConfirmation,
  detectSurrenderDefeatResult,
  runConfirmedDeadlockSurrender,
  // Backward-compatible alias for the first material-collection command.
  openSurrenderConfirmation: runConfirmedDeadlockSurrender
};
