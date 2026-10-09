'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const {
  SETTLEMENT_HEADER_ROI,
  SETTLEMENT_REWARD_PANEL_ROI,
  SETTLEMENT_CONTINUE_ROI,
  recognizeSettlementGemRewards,
  detectSettlementPage,
  commitGemReward
} = require('../core/duel-settlement');

const ROOT = path.resolve(__dirname, '..', '..');

function load(rel) {
  return PNG.sync.read(fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
}

function crop(image, roi) {
  const data = Buffer.alloc(roi.width * roi.height * 4);
  for (let y = 0; y < roi.height; y++) {
    const from = ((roi.y + y) * image.width + roi.x) * 4;
    const to = y * roi.width * 4;
    image.data.copy(data, to, from, from + roi.width * 4);
  }
  return { width: roi.width, height: roi.height, data };
}

const settlement = load('material/verified/duel-settlement-01-gems-79.png');
const page = detectSettlementPage(
  crop(settlement, SETTLEMENT_HEADER_ROI),
  crop(settlement, SETTLEMENT_CONTINUE_ROI)
);
assert.strictEqual(page.pass, true, `settlement page should pass: ${JSON.stringify(page)}`);

const rewardPanel = crop(settlement, SETTLEMENT_REWARD_PANEL_ROI);
const gems = recognizeSettlementGemRewards(rewardPanel);
assert.strictEqual(gems.pass, true, `gem count should pass: ${JSON.stringify(gems)}`);
assert.strictEqual(gems.rewards.length, 1);
assert.strictEqual(gems.total, 79);
assert.strictEqual(gems.rewards[0].count.text, '79');
assert.ok(gems.rewards[0].count.digits[0].confidence >= 0.75);
assert.ok(gems.rewards[0].count.digits[1].confidence >= 0.69);

const material94 = load('material/verified/duel-settlement-02-gems-94.png');
assert.strictEqual(detectSettlementPage(crop(material94, SETTLEMENT_HEADER_ROI),
  crop(material94, SETTLEMENT_CONTINUE_ROI)).pass, true);
const rewardPanel94 = crop(material94, SETTLEMENT_REWARD_PANEL_ROI);
const gems94 = recognizeSettlementGemRewards(rewardPanel94);
assert.strictEqual(gems94.pass, true, JSON.stringify(gems94));
assert.strictEqual(gems94.total, 94);

// Real 2026-10-02 settlement: the first slot is 106 and a second slot is 10.
// This guards both the settlement-font classifier and removal of the old
// per-slot <=100 assumption.
const material106Plus10 = load('material/verified/duel-settlement-03-gems-106-plus-10.png');
const gems106Plus10 = recognizeSettlementGemRewards(material106Plus10);
assert.strictEqual(gems106Plus10.pass, true, JSON.stringify(gems106Plus10));
assert.deepStrictEqual(gems106Plus10.rewards.map(row => row.count.value), [106, 10]);
assert.strictEqual(gems106Plus10.total, 116);
assert.ok(gems106Plus10.rewards.every(row =>
  row.count.digits.every(digit => digit.source === 'SETTLEMENT_VERIFIED')));

// Synthetic layout proof only: clone the verified gem icon and its count into
// another row/column.  This checks that recognition is panel-wide rather than
// tied to a fixed slot; real multi-row layouts still require live material.
const synthetic = {
  width: rewardPanel.width,
  height: rewardPanel.height,
  data: Buffer.from(rewardPanel.data)
};
function copyRect(image, source, target) {
  const rows = [];
  for (let y = 0; y < source.height; y++) {
    const from = ((source.y + y) * image.width + source.x) * 4;
    rows.push(Buffer.from(image.data.subarray(from, from + source.width * 4)));
  }
  for (let y = 0; y < source.height; y++) {
    const to = ((target.y + y) * image.width + target.x) * 4;
    rows[y].copy(image.data, to);
  }
}
copyRect(synthetic, { x: 53, y: 33, width: 96, height: 96 }, { x: 260, y: 210 });
copyRect(synthetic, { x: 85, y: 125, width: 70, height: 40 }, { x: 292, y: 302 });
const syntheticGems = recognizeSettlementGemRewards(synthetic);
assert.strictEqual(syntheticGems.pass, true, `synthetic multi-slot should pass: ${JSON.stringify(syntheticGems)}`);
assert.strictEqual(syntheticGems.rewards.length, 2);
assert.strictEqual(syntheticGems.total, 158);

const eight = { width: rewardPanel94.width, height: rewardPanel94.height,
  data: Buffer.alloc(rewardPanel94.data.length) };
function pasteFrom(source, image, roi, target) {
  for (let y = 0; y < roi.height; y++) {
    const from = ((roi.y + y) * source.width + roi.x) * 4;
    const to = ((target.y + y) * image.width + target.x) * 4;
    source.data.copy(image.data, to, from, from + roi.width * 4);
  }
}
for (const y of [20, 230]) for (const x of [10, 130, 250, 370]) {
  pasteFrom(rewardPanel94, eight, { x: 52, y: 32, width: 96, height: 96 }, { x, y });
  pasteFrom(rewardPanel94, eight, { x: 84, y: 124, width: 70, height: 40 }, { x: x + 32, y: y + 92 });
}
const eightGems = recognizeSettlementGemRewards(eight);
assert.strictEqual(eightGems.pass, true, JSON.stringify(eightGems));
assert.strictEqual(eightGems.rewards.length, 8);
assert.strictEqual(eightGems.total, 752);

const victory = load('material/verified/duel-result-01-victory.png');
const notSettlement = detectSettlementPage(
  crop(victory, SETTLEMENT_HEADER_ROI),
  crop(victory, SETTLEMENT_CONTINUE_ROI)
);
assert.strictEqual(notSettlement.pass, false, 'victory result must not look like settlement');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-gem-ledger-'));
const ledgerPath = path.join(tempDir, 'daily-gems.json');
try {
  const first = commitGemReward({
    ledgerPath,
    value: 79,
    fingerprint: 'sample-a',
    now: new Date('2026-09-29T10:00:00.000Z'),
    source: 'OFFLINE_TEST'
  });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.observedTotal, 79);
  assert.strictEqual(first.nominalCapRemaining, 21);

  const retry = commitGemReward({
    ledgerPath,
    value: 79,
    fingerprint: 'sample-b-with-particle-drift',
    now: new Date('2026-09-29T10:00:10.000Z'),
    source: 'OFFLINE_TEST'
  });
  assert.strictEqual(retry.duplicate, true);
  assert.strictEqual(retry.observedTotal, 79);

  const later = commitGemReward({
    ledgerPath,
    value: 21,
    fingerprint: 'sample-c',
    now: new Date('2026-09-29T10:01:00.000Z'),
    source: 'OFFLINE_TEST'
  });
  assert.strictEqual(later.duplicate, false);
  assert.strictEqual(later.observedTotal, 100);
  assert.strictEqual(later.nominalCapRemaining, 0);

  const identified = commitGemReward({ ledgerPath, value: 10, settlementId: 'duel-1',
    now: new Date('2026-09-29T10:02:00.000Z') });
  assert.strictEqual(identified.observedTotal, 110);
  const delayedRetry = commitGemReward({ ledgerPath, value: 10, settlementId: 'duel-1',
    now: new Date('2026-09-29T10:12:00.000Z') });
  assert.strictEqual(delayedRetry.duplicate, true);
  assert.strictEqual(delayedRetry.observedTotal, 110);
  const nextDuel = commitGemReward({ ledgerPath, value: 10, settlementId: 'duel-2',
    now: new Date('2026-09-29T10:12:01.000Z') });
  assert.strictEqual(nextDuel.duplicate, false, 'equal rewards in adjacent different duels are distinct');
  const multiSlot = commitGemReward({ ledgerPath, value: 158, settlementId: 'duel-3',
    now: new Date('2026-09-29T10:13:00.000Z') });
  assert.strictEqual(multiSlot.observedTotal, 278);
  const nextDay = commitGemReward({ ledgerPath, value: 7, settlementId: 'duel-4',
    now: new Date('2026-09-29T16:00:00.000Z') });
  assert.strictEqual(nextDay.dateKey, '2026-09-30');
  assert.strictEqual(nextDay.observedTotal, 7);
  const midnightRetry = commitGemReward({ ledgerPath, value: 10, settlementId: 'duel-1',
    now: new Date('2026-09-29T16:01:00.000Z') });
  assert.strictEqual(midnightRetry.duplicate, true);
  assert.strictEqual(midnightRetry.dateKey, '2026-09-29');
  assert.throws(() => commitGemReward({ ledgerPath, value: 11, settlementId: 'duel-1' }),
    /SETTLEMENT_REWARD_CHANGED_FOR_ID/);
  const corrected = commitGemReward({ ledgerPath, value: 11, settlementId: 'duel-1',
    allowProvisionalCorrection: true, now: new Date('2026-09-29T16:02:00.000Z') });
  assert.strictEqual(corrected.corrected, true);
  assert.strictEqual(corrected.observedTotal, 279);
  const correctedRetry = commitGemReward({ ledgerPath, value: 11, settlementId: 'duel-1',
    now: new Date('2026-09-29T16:03:00.000Z') });
  assert.strictEqual(correctedRetry.duplicate, true);
  assert.strictEqual(correctedRetry.observedTotal, 279);
} finally {
  assert.strictEqual(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tempDir).startsWith('v6-gem-ledger-'));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const mainSource = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
assert.match(mainSource, /runPostVictorySettlement/);
assert.match(fs.readFileSync(path.join(ROOT, 'execution/core/post-duel-victory.js'), 'utf8'), /runDuelSettlement/);
assert.ok(fs.existsSync(path.join(ROOT, 'execution/live/run-duel-settlement.js')));

console.log(
  `DUEL SETTLEMENT OFFLINE PASS; gems=${gems.total}; ` +
  `realMultiSlot=${gems106Plus10.rewards.map(row => row.count.value).join('+')}=${gems106Plus10.total}; ` +
  `confidence=${gems.rewards[0].count.digits.map(row => row.confidence.toFixed(3)).join(',')}; ` +
  `syntheticSlots=${syntheticGems.rewards.length}; page=PASS; victoryRejected=PASS; ledger=PASS; formalIntegration=ON`
);
