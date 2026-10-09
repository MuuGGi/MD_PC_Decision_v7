'use strict';

const DEFAULT_NO_MOTION_THRESHOLD = 0.020;

function sampledLocalImageDifference(left, right, step = 8) {
  if (!left || !right || left.width !== right.width || left.height !== right.height) return Infinity;
  const stride = Math.max(2, Number(step) || 8);
  let total = 0;
  let samples = 0;
  for (let y = 0; y < left.height; y += stride) {
    for (let x = 0; x < left.width; x += stride) {
      const offset = (y * left.width + x) * 4;
      total += Math.abs(left.data[offset] - right.data[offset]);
      total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
      total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
      samples += 3;
    }
  }
  return samples ? total / samples / 255 : Infinity;
}

function isNoMotionProbe(difference, threshold = DEFAULT_NO_MOTION_THRESHOLD) {
  return Number.isFinite(Number(difference)) && Number(difference) <= Number(threshold);
}

function adaptiveBottomBurstPlan(thumbRecognized) {
  // If the scrollbar is visible and says we are not at bottom, skip the tiny
  // probe and move down more decisively. If it is hidden/unrecognized, start
  // with only four high-delta wheel messages. That cheap probe is enough to
  // prove "already at bottom" when the right log does not move at all.
  return thumbRecognized
    ? [12, 36, 36]
    : [4, 12, 36, 36];
}

module.exports = {
  DEFAULT_NO_MOTION_THRESHOLD,
  sampledLocalImageDifference,
  isNoMotionProbe,
  adaptiveBottomBurstPlan
};
