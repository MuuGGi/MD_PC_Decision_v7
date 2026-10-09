'use strict';

const assert = require('assert');
const {
  plausibleGaruraEffectCandidate
} = require('../core/m18-garura-route');

// Repeated successful live M18 samples produce a real single-card frame near
// x=1024 with width about 118 reference pixels.
assert.strictEqual(
  plausibleGaruraEffectCandidate({ x: 1024, y: 925, width: 118 }),
  true
);

// ISSUE-055 supplied this exact false merged component.  It spans the full
// effect-candidate ROI and must never be accepted as one card again.
assert.strictEqual(
  plausibleGaruraEffectCandidate({ x: 1025, y: 925, width: 410 }),
  false
);

assert.strictEqual(
  plausibleGaruraEffectCandidate({ x: 801, y: 1128, width: 26 }),
  false
);

console.log('M18_EFFECT_WINDOW_GUARDS_OFFLINE_PASS');
