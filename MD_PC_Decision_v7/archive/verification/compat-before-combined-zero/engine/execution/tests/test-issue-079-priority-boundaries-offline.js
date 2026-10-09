'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  classifyDuelPriorityState,
  glowBackedOuterAgreement,
  SELF_BLUE_ROIS,
  SELF_BLUE_CAPTURE_ROI
} = require('../../lib/duel-priority-state');
const { cropImage } = require('../../lib/png-utils');
const { RESPONSE_BOUNDARIES } = require('../../lib/response-boundary-policy');
const {
  atomicContinuationDecision
} = require('../../lib/atomic-response-continuation-policy');
const { shouldPreferPostKagariYoto } = require('../../lib/decision-engine');

const ROOT = path.resolve(__dirname, '..', '..');
const material = PNG.sync.read(fs.readFileSync(
  path.join(ROOT, 'material', 'verified', 'issue-079-self-priority-blue.png')
));
const blue = classifyDuelPriorityState(material);
assert.strictEqual(blue.state, 'SELF_PRIORITY_BLUE');
assert.strictEqual(blue.detector, 'BOTTOM_BLUE_GLOW_DISTRIBUTED_V2');
assert(blue.votes >= 3, `expected at least three independent blue votes, got ${blue.votes}`);
assert(blue.bottomGlow.passingColumns >= 6);
const croppedBlue = classifyDuelPriorityState(
  cropImage(material, SELF_BLUE_CAPTURE_ROI),
  { referenceCaptureRoi: SELF_BLUE_CAPTURE_ROI }
);
assert.strictEqual(croppedBlue.state, 'SELF_PRIORITY_BLUE');
assert.strictEqual(croppedBlue.votes, blue.votes);

const optionalPromptMaterial = PNG.sync.read(fs.readFileSync(
  path.join(ROOT, 'material', 'verified', 'issue-080-self-priority-blue-optional-prompt.png')
));
const optionalPromptBlue = classifyDuelPriorityState(
  cropImage(optionalPromptMaterial, SELF_BLUE_CAPTURE_ROI),
  { referenceCaptureRoi: SELF_BLUE_CAPTURE_ROI }
);
assert.strictEqual(optionalPromptBlue.state, 'SELF_PRIORITY_BLUE');

// 2026-09-29 Kagari optional-effect prompt: the strict distributed floor glow
// passed 7/12 with bilateral 3+2 edges, while the broad left ROI was 0.0344 --
// only 0.0006 below the old 0.035 threshold.  This exact evidence class must
// pass without weakening the bottom-glow requirement.
assert.strictEqual(
  glowBackedOuterAgreement(0.0344, 0.0632, { pass: true }),
  true
);
assert.strictEqual(
  glowBackedOuterAgreement(0.0344, 0.0632, { pass: false }),
  false,
  'relaxed outer agreement is forbidden without distributed bottom glow'
);
assert.strictEqual(
  glowBackedOuterAgreement(0.0299, 0.0632, { pass: true }),
  false,
  'one weak/covered side must still fail closed'
);
const kagariOptionalMaterial = PNG.sync.read(fs.readFileSync(
  path.join(ROOT, 'material', 'verified', 'issue-088-kagari-optional-blue-glow.png')
));
const kagariOptionalBlue = classifyDuelPriorityState(kagariOptionalMaterial);
assert.strictEqual(kagariOptionalBlue.state, 'SELF_PRIORITY_BLUE');
assert.strictEqual(kagariOptionalBlue.votes, 1);
assert.strictEqual(kagariOptionalBlue.outerEdgeAgreement, false);
assert.strictEqual(kagariOptionalBlue.glowBackedOuterEdgeAgreement, true);
assert.strictEqual(kagariOptionalBlue.bottomGlow.passingColumns, 7);
assert.strictEqual(kagariOptionalBlue.bottomGlow.leftEdgePassing, 3);
assert.strictEqual(kagariOptionalBlue.bottomGlow.rightEdgePassing, 2);

const latestBottomGlowMaterial = PNG.sync.read(fs.readFileSync(
  path.join(ROOT, 'material', 'verified', 'issue-082-bottom-blue-glow-latest.png')
));
const latestBottomGlow = classifyDuelPriorityState(
  cropImage(latestBottomGlowMaterial, SELF_BLUE_CAPTURE_ROI),
  { referenceCaptureRoi: SELF_BLUE_CAPTURE_ROI }
);
assert.strictEqual(latestBottomGlow.state, 'SELF_PRIORITY_BLUE');
assert.strictEqual(latestBottomGlow.bottomGlow.passingColumns, 12);

// One covered field strip must not suppress the other three votes.
const occluded = PNG.sync.read(PNG.sync.write(material));
const blocked = SELF_BLUE_ROIS[1];
for (let y = blocked.y; y < blocked.y + blocked.height; y++) {
  for (let x = blocked.x; x < blocked.x + blocked.width; x++) {
    const i = (y * occluded.width + x) * 4;
    occluded.data[i] = 35;
    occluded.data[i + 1] = 35;
    occluded.data[i + 2] = 35;
  }
}
assert.strictEqual(classifyDuelPriorityState(occluded).state, 'SELF_PRIORITY_BLUE');

const neutral = new PNG({ width: 2048, height: 1152 });
neutral.data.fill(35);
for (let i = 3; i < neutral.data.length; i += 4) neutral.data[i] = 255;
assert.strictEqual(classifyDuelPriorityState(neutral).state, 'UNKNOWN_NOT_PROVEN');

// Two compact blue cards deliberately satisfy the old outer-edge shortcut.
// They must still fail because they do not form a distributed bottom glow.
const compactBlueCards = PNG.sync.read(PNG.sync.write(neutral));
for (const card of [{ x: 520, y: 700 }, { x: 1430, y: 700 }]) {
  for (let y = card.y; y < card.y + 170; y++) {
    for (let x = card.x; x < card.x + 80; x++) {
      const i = (y * compactBlueCards.width + x) * 4;
      compactBlueCards.data[i] = 20;
      compactBlueCards.data[i + 1] = 85;
      compactBlueCards.data[i + 2] = 210;
    }
  }
}
const compactCardsResult = classifyDuelPriorityState(compactBlueCards);
assert.strictEqual(compactCardsResult.outerEdgeAgreement, true);
assert.strictEqual(compactCardsResult.bottomGlow.pass, false);
assert.strictEqual(compactCardsResult.state, 'UNKNOWN_NOT_PROVEN');

assert(RESPONSE_BOUNDARIES.SKY_STRIKER.includes('KAGARI_RECOVERY_RESOLVED'));
assert(RESPONSE_BOUNDARIES.EQUIPMENT.includes('EQUIP_SEARCH_TARGET_TAKEN'));
assert.deepStrictEqual(
  RESPONSE_BOUNDARIES.GENERIC_SPELLS.M13_ALLURE,
  ['ACTIVATED', 'DRAW_AND_BANISH_FULLY_RESOLVED']
);
assert.strictEqual(
  atomicContinuationDecision('HORNET_TOKEN_READY', 'KAGARI_EFFECT_PENDING').autoContinue,
  true
);
assert.strictEqual(
  atomicContinuationDecision('KAGARI_EFFECT_PENDING', 'KAGARI_RECOVERY_PROMPT').autoContinue,
  false,
  'Kagari activation reaches the next user-supplied response boundary'
);
assert.strictEqual(
  atomicContinuationDecision('M20_FIELD_EFFECT_ACTIVATED', 'M19_SELECTED_FROM_DECK').autoContinue,
  true,
  'deck selection and equip target belong to the same response interval'
);
assert.strictEqual(
  atomicContinuationDecision('M19_SELECTED_FROM_DECK', 'M19_EQUIPPED').autoContinue,
  false,
  'completed equip is the next response boundary'
);
assert.strictEqual(
  shouldPreferPostKagariYoto({ yoto: { id: 'M19' }, trueSwordInDeck: true, yotoInDeck: false }),
  true,
  'post-Kagari M19->Link->search M20 must not require another M19 in Deck'
);

const branchObserverSource = fs.readFileSync(
  path.join(ROOT, 'execution', 'core', 'branch-adjacent-observer.js'),
  'utf8'
);
assert(branchObserverSource.includes('expectedAtomicActivationKey: expectedActivationKey'));

const atomicSource = fs.readFileSync(
  path.join(ROOT, 'execution', 'core', 'atomic-route-executor.js'),
  'utf8'
);
const fallbackStart = atomicSource.indexOf('async function verifyKnownSingleGainAtomic');
const fallbackEnd = atomicSource.indexOf('async function resumeKagariRecoveryCurrentPrompt');
const fallback = atomicSource.slice(fallbackStart, fallbackEnd);
assert(!fallback.includes('selectCurrentObservedHandCard('));
assert(!fallback.includes("bridge.key('ESC')"));
assert(fallback.includes('RIGHT_LOG_EXACT_NO_CLICK'));

const mainSource = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
const decisionResumeBranch = mainSource.slice(
  mainSource.indexOf('} else if (resumeCurrentDecision) {'),
  mainSource.indexOf('} else if (resumeCurrentAtomic) {')
);
assert(decisionResumeBranch.includes('isTransactionPendingNode(savedNode)'));
assert(decisionResumeBranch.includes('安全转入 --resume-current-atomic 语义'));
assert(decisionResumeBranch.includes('state = loadObserverSessionState()'));

console.log(
  `ISSUE_079_PRIORITY_BOUNDARIES_OFFLINE_PASS votes=${blue.votes}; ` +
  `median=${blue.medianBlueRatio.toFixed(4)}; glow=${blue.bottomGlow.passingColumns}`
);
