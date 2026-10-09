'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { readPng } = require(path.join(ROOT, 'lib', 'png-utils'));
const {
  detectNormalSummonButton
} = require(path.join(ROOT, 'execution', 'core', 'hand-normal-summon'));

function blankImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4, 255) };
}

function paintBlueRect(image, centerX, centerY, width = 60, height = 40) {
  const left = Math.round(centerX - width / 2);
  const top = Math.round(centerY - height / 2);
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = 20;
      image.data[offset + 1] = 145;
      image.data[offset + 2] = 230;
      image.data[offset + 3] = 255;
    }
  }
}

function syntheticTests() {
  const handAnchorLocal = { x: 190, y: 300 };
  const neutral = blankImage(380, 245);
  const paired = blankImage(380, 245);
  paintBlueRect(paired, 100, 157);
  paintBlueRect(paired, 265, 157);
  const positive = detectNormalSummonButton(neutral, paired, { handAnchorLocal });
  assert.strictEqual(positive.visible, true);
  assert(positive.chosen.dxFromHand < 0, 'must choose the left summon component');
  assert(positive.rejectedSet.dxFromHand > 0, 'must explicitly reject the right set component');

  const rightOnly = blankImage(380, 245);
  paintBlueRect(rightOnly, 265, 157);
  const missingLeft = detectNormalSummonButton(neutral, rightOnly, { handAnchorLocal });
  assert.strictEqual(missingLeft.visible, false);
  assert.strictEqual(missingLeft.rejectionReason, 'LEFT_SUMMON_COMPONENT_MISSING');

  const verticallyMisaligned = blankImage(380, 245);
  paintBlueRect(verticallyMisaligned, 100, 115);
  paintBlueRect(verticallyMisaligned, 265, 180);
  const badPair = detectNormalSummonButton(neutral, verticallyMisaligned, { handAnchorLocal });
  assert.strictEqual(badPair.visible, false);
  assert.strictEqual(badPair.rejectionReason, 'SUMMON_SET_PAIR_GEOMETRY_INVALID');
}

async function historicalReplay() {
  const attemptDir = process.argv[2] || path.join(
    ROOT,
    'material',
    'verified',
    'evidence',
    'M06_raye_normal_summon',
    '2026-09-11T09-09-13-490Z'
  );
  const evidenceDir = path.join(attemptDir, 'normal_summon_button');
  const neutralPath = path.join(evidenceDir, 'normal_summon_neutral_roi.png');
  const selectedPath = path.join(evidenceDir, 'normal_summon_selected_attempt1.png');
  const clickPath = path.join(attemptDir, 'execution_click.json');
  if (![neutralPath, selectedPath, clickPath].every(file => fs.existsSync(file))) {
    throw new Error(`HISTORICAL_M06_EVIDENCE_MISSING:${attemptDir}`);
  }
  const click = JSON.parse(fs.readFileSync(clickPath, 'utf8'));
  const neutral = await readPng(neutralPath);
  const selected = await readPng(selectedPath);
  const roi = click.summonProof.roi;
  const hand = click.summonProof.handAnchorReference;
  const proof = detectNormalSummonButton(neutral, selected, {
    handAnchorLocal: { x: hand.x - roi.x, y: hand.y - roi.y }
  });
  assert.strictEqual(proof.visible, true);
  assert(proof.chosen.dxFromHand < 0, 'historical replay must choose left summon');
  assert(proof.rejectedSet.dxFromHand > 0, 'historical replay must reject right set');
  assert(Math.abs(proof.chosen.dxFromHand + 73) < 20, `unexpected summon dx: ${proof.chosen.dxFromHand}`);
  assert(Math.abs(proof.rejectedSet.dxFromHand - 101) < 20, `unexpected set dx: ${proof.rejectedSet.dxFromHand}`);
  console.log(JSON.stringify({
    status: 'PASS',
    detector: proof.detector,
    historicalAttempt: attemptDir,
    summon: { dx: proof.chosen.dxFromHand, dy: proof.chosen.dyFromHand },
    rejectedSet: { dx: proof.rejectedSet.dxFromHand, dy: proof.rejectedSet.dyFromHand }
  }, null, 2));
}

if (process.versions.node !== '20.11.1') {
  throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
}

syntheticTests();
historicalReplay().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
