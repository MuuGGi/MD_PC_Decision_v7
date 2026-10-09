'use strict';

const { captureReferenceRoi, sleep } = require('./win-fast');
const {
  SELF_BLUE_CAPTURE_ROI,
  classifyDuelPriorityState
} = require('./duel-priority-state');

async function waitForSelfPriorityBlue(options) {
  const {
    bridge,
    info,
    label = 'SELF_PRIORITY_GATE',
    timeoutMs = 15000,
    pollMs = 80,
    stableFrames = 2,
    recoverForeground = false
  } = options || {};
  if (!bridge) throw new Error(`${label}_BRIDGE_MISSING`);

  const started = Date.now();
  let currentInfo = info || null;
  let foregroundRecoveries = 0;
  let stable = 0;
  let attempts = 0;
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    attempts++;
    try {
      if (!currentInfo) currentInfo = await bridge.info();
      const frame = await captureReferenceRoi(bridge, currentInfo, SELF_BLUE_CAPTURE_ROI);
      last = classifyDuelPriorityState(frame, { referenceCaptureRoi: SELF_BLUE_CAPTURE_ROI });
    } catch (error) {
      const foregroundLost = /Foreground window is not Master Duel/i.test(String(error && error.message || error));
      if (!foregroundLost || !recoverForeground) throw error;
      foregroundRecoveries++;
      console.log(
        `我方优先权被动验收检测到前台暂时离开Master Duel: ${label}; ` +
        '只恢复游戏窗口焦点，不发送游戏内输入。'
      );
      currentInfo = await bridge.activateMasterDuel();
      await sleep(60);
      continue;
    }
    stable = last.safeForRecognitionAndControl ? stable + 1 : 0;
    if (stable >= stableFrames) {
      const elapsedMs = Date.now() - started;
      console.log(
        `我方底部淡蓝光晕 PASS: ${label}; stable=${stableFrames}; votes=${last.votes}/${last.requiredVotes}; ` +
        `median=${last.medianBlueRatio.toFixed(4)}; outer=${last.outerEdgeAgreement
          ? 'PASS'
          : last.glowBackedOuterEdgeAgreement ? 'PASS_GLOW_BACKED' : 'N/A'}; ` +
        `glowColumns=${last.bottomGlow.passingColumns}/${last.bottomGlow.requiredPassingColumns}; ` +
        `glowEdges=${last.bottomGlow.leftEdgePassing}+${last.bottomGlow.rightEdgePassing}; ` +
        `attempts=${attempts}; elapsed=${elapsedMs}ms。`
      );
      return { ...last, attempts, stableFrames, foregroundRecoveries, elapsedMs };
    }
    // UNKNOWN includes animations and the future opponent-red state.  Both are
    // passive waits: no card recognition, click, key or wheel is allowed here.
    await sleep(pollMs);
  }

  throw new Error(
    `${label}_SELF_PRIORITY_BOTTOM_BLUE_GLOW_NOT_PROVEN:` +
    `state=${last && last.state || 'NONE'};votes=${last && last.votes || 0};` +
    `attempts=${attempts};zero_input_wait=1;red_detector=UNCALIBRATED`
  );
}

module.exports = { waitForSelfPriorityBlue };
