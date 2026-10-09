'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const settlement = require('../core/duel-settlement');
const ROOT = path.resolve(__dirname, '../..');
const full = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/verified/duel-settlement-02-gems-94.png')));
const source = fs.readFileSync(path.join(ROOT, 'execution/core/duel-settlement.js'), 'utf8');
const start = source.indexOf('async function captureSettlementPage(');
const end = source.indexOf('function settlementRewardSignature(', start);
assert.ok(start >= 0 && end > start);

function harness({ pageLostAfter = Infinity, foregroundLostAfter = Infinity, pageInitiallyMissing = false } = {}) {
  let now = 1000;
  const calls = [];
  const clicks = [];
  class FakeDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: FakeDate, Math, path,
    SETTLEMENT_HEADER_ROI: settlement.SETTLEMENT_HEADER_ROI,
    SETTLEMENT_CONTINUE_ROI: settlement.SETTLEMENT_CONTINUE_ROI,
    REWARD_ANIMATION_REFERENCE: settlement.REWARD_ANIMATION_REFERENCE,
    REWARD_ANIMATION_DURATION_MS: 5000, REWARD_ANIMATION_CLICK_INTERVAL_MS: 200,
    console: { log() {} }, saveRgbaPng() {}, writeJsonAtomic() {},
    detectSettlementPage: settlement.detectSettlementPage,
    safeForeground: async () => {
      calls.push('foreground');
      if (clicks.length >= foregroundLostAfter) throw new Error('FOREGROUND_LOST');
      return {};
    },
    captureReferenceRoi: async (_, info, roi) => {
      assert.ok(roi === settlement.SETTLEMENT_HEADER_ROI || roi === settlement.SETTLEMENT_CONTINUE_ROI,
        'animation phase must not inspect or count partial reward numbers');
      calls.push('page');
      now += 10;
      return pageInitiallyMissing || clicks.length >= pageLostAfter
        ? { width: roi.width, height: roi.height, data: Buffer.alloc(roi.width * roi.height * 4) }
        : cropImage(full, roi);
    },
    mapReferencePoint: (_, point) => point,
    sleep: async ms => { now += ms; calls.push('sleep'); }
  });
  vm.runInContext(source.slice(start, end), context);
  const bridge = { click: async (x, y) => {
    assert.strictEqual(x, 1024);
    assert.strictEqual(y, 1000);
    assert.strictEqual(calls[calls.length - 1], 'page');
    clicks.push({ x, y, at: now });
  } };
  return { context, bridge, clicks };
}
async function main() {
  const valid = harness();
  await valid.context.waitForSettlementPage(valid.bridge);
  const result = await valid.context.accelerateSettlementRewards(valid.bridge);
  assert.ok(result.clicks >= 8 && result.clicks <= 25);
  assert.ok(result.elapsedMs >= 5000 && result.elapsedMs <= 5020);
  assert.ok(valid.clicks.every(point => point.x < settlement.SETTLEMENT_CONTINUE_ROI.x));

  const changed = harness({ pageLostAfter: 3 });
  await assert.rejects(changed.context.accelerateSettlementRewards(changed.bridge), /PAGE_CHANGED/);
  assert.strictEqual(changed.clicks.length, 3);
  const unfocused = harness({ foregroundLostAfter: 2 });
  await assert.rejects(unfocused.context.accelerateSettlementRewards(unfocused.bridge), /FOREGROUND_LOST/);
  assert.strictEqual(unfocused.clicks.length, 2);
  const wrongPage = harness({ pageInitiallyMissing: true });
  await assert.rejects(wrongPage.context.waitForSettlementPage(wrongPage.bridge, { timeoutMs: 600 }),
    /PAGE_AND_BUTTON_NOT_PROVEN/);
  assert.strictEqual(wrongPage.clicks.length, 0);
  console.log('SETTLEMENT_ANIMATION_OFFLINE_PASS; duration=5000ms; handArea=ONLY; currentPage=REQUIRED; rewards=AFTER');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
