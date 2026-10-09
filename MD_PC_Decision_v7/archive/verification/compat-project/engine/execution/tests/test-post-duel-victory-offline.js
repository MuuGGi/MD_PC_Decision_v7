'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const file = path.resolve(__dirname, '../core/post-duel-victory.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-post-victory-'));

function settlementHarness() {
  const settlementFile = path.resolve(__dirname, '../core/duel-settlement.js');
  const realRequire = createRequire(settlementFile);
  const full = PNG.sync.read(fs.readFileSync(path.resolve(__dirname,
    '../../material/verified/duel-settlement-01-gems-79.png')));
  let clicks = 0;
  let animationClicks = 0;
  let fakeNow = 1000;
  class FakeDate extends Date { static now() { return fakeNow; } }
  const context = vm.createContext({
    Date: FakeDate,
    __dirname: path.dirname(settlementFile), module: { exports: {} },
    console: { log() {} },
    require: id => {
      if (id.endsWith('win-fast')) return {
        MdFastBridge: class { async start() {} async stop() {} async click(x, y) {
          if (x === 1024 && y === 1000) animationClicks++;
          else { assert.strictEqual(x, 1824); assert.strictEqual(y, 1052); clicks++; }
        } },
        captureReferenceRoi: async (_, info, roi) => {
          assert.strictEqual(clicks, 0, 'no capture after the final settlement click');
          return cropImage(full, roi);
        },
        mapReferencePoint: (_, point) => point, sleep: async ms => {
          assert.strictEqual(clicks, 0, 'no wait after the final settlement click');
          fakeNow += ms;
        }
      };
      if (id.endsWith('md-foreground')) return { activateAndVerifyMasterDuel: async () => {
        assert.strictEqual(clicks, 0, 'no foreground verification after the final settlement click');
        return { info: {} };
      } };
      if (id.endsWith('scan-state')) return { saveRgbaPng() {} };
      return realRequire(id);
    }
  });
  vm.runInContext(fs.readFileSync(settlementFile, 'utf8'), context);
  return { run: context.module.exports.runDuelSettlement, get clicks() { return clicks; },
    get animationClicks() { return animationClicks; } };
}

function harness(page = 'VICTORY', failSettlement = false) {
  const calls = [];
  const context = vm.createContext({
    __dirname: path.dirname(file), module: { exports: {} }, console: { log() {} },
    require: id => {
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      if (id === 'crypto') return crypto;
      if (id.endsWith('win-fast')) return {
        MdFastBridge: class {
          async start() { calls.push('start'); }
          async stop() { calls.push('stop'); }
        }, captureReferenceRoi: async () => ({ page })
      };
      if (id.endsWith('md-foreground')) return {
        activateAndVerifyMasterDuel: async () => { calls.push('foreground'); return { info: {} }; }
      };
      if (id.endsWith('png-utils')) return { cropImage: image => image };
      if (id.endsWith('runtime-files')) return { readJson, writeJsonAtomic };
      if (id.endsWith('scan-state')) return { saveRgbaPng() {} };
      if (id === './duel-result-confirm') return {
        VICTORY_TITLE_ROI: {}, VICTORY_CROWN_ROI: {}, RESULT_CONFIRM_ROI: {},
        detectVictoryResultConfirm: image => ({ pass: image.page === 'VICTORY' }),
        runVictoryResultConfirm: async () => { calls.push('victory-click'); page = 'SETTLEMENT'; }
      };
      if (id === './duel-settlement') return {
        SETTLEMENT_HEADER_ROI: {}, SETTLEMENT_CONTINUE_ROI: {},
        detectSettlementPage: image => ({ pass: image.page === 'SETTLEMENT' }),
        runDuelSettlement: async options => {
          calls.push(`settlement:${options.settlementId}`);
          calls.push(`correctionAllowed:${options.allowProvisionalCorrection}`);
          if (!options.skipRewardAnimation) {
            calls.push('animation');
            await options.onRewardAnimationDone({ clicks: 25, elapsedMs: 5000 });
          }
          const reward = { gems: 21, ledger: { dateKey: '2026-09-30', observedTotal: 100 } };
          await options.onRewardCommitted(reward);
          if (failSettlement) throw new Error('CONTINUE_UNRESOLVED');
          if (!await options.beforeContinue(reward)) return { status: 'DUEL_SETTLEMENT_PAUSED', ...reward };
          calls.push('settlement-click');
          return reward;
        }
      };
      throw new Error(`unexpected dependency: ${id}`);
    }
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { run: context.module.exports.runPostVictorySettlement,
    prompt: context.module.exports.createPostDuelTerminalPrompt, calls };
}
async function main() {
  const checkpointPath = path.join(tempDir, 'state.json');
  const options = { checkpointPath, debugDir: path.join(tempDir, 'debug'), resume: true,
    requestContinue: async () => true };
  let enter;
  const waitForEnter = harness('VICTORY');
  const pendingEnter = waitForEnter.run({ ...options, requestContinue: () => new Promise(resolve => { enter = resolve; }) });
  assert.strictEqual(waitForEnter.calls.length, 0, 'no bridge or click before the user presses Enter');
  enter(false);
  assert.strictEqual((await pendingEnter).status, 'POST_VICTORY_PAUSED');
  assert.strictEqual(waitForEnter.calls.length, 0);
  assert.strictEqual(fs.existsSync(checkpointPath), false);

  const terminal = harness();
  const prompts = [];
  const answers = ['', 'q'];
  const ask = terminal.prompt({ question: async text => { prompts.push(text); return answers.shift(); } });
  assert.strictEqual(await ask({ phase: 'POST_DUEL_START' }), true);
  assert.strictEqual(await ask({ phase: 'SETTLEMENT_CONTINUE', gems: 21,
    ledger: { dateKey: '2026-09-30', observedTotal: 100 } }), false);
  assert.ok(prompts[0].includes('回车'));
  assert.ok(prompts[1].includes('本局钻石=21'));
  assert.ok(prompts[1].includes('累计=100'));
  const resumePrompt = [];
  const askResume = terminal.prompt({ question: async text => { resumePrompt.push(text); return 'q'; } });
  assert.strictEqual(await askResume({ phase: 'POST_DUEL_START',
    checkpoint: { rewardAnimationComplete: true } }), false);
  assert.ok(resumePrompt[0].includes('不重放胜利确认和5秒动画'));

  const pauseAfterReward = harness('VICTORY');
  const pause = await pauseAfterReward.run({ ...options,
    requestContinue: async step => step.phase === 'POST_DUEL_START' });
  assert.strictEqual(pause.status, 'POST_VICTORY_PAUSED');
  assert.ok(!pauseAfterReward.calls.includes('settlement-click'));
  assert.strictEqual(readJson(checkpointPath).stage, 'REWARD_RECORDED');
  fs.unlinkSync(checkpointPath);
  const failed = harness('VICTORY', true);
  await assert.rejects(failed.run(options), /CONTINUE_UNRESOLVED/);
  assert.ok(failed.calls.includes('victory-click'));
  assert.ok(failed.calls.includes('stop'));
  const pending = readJson(checkpointPath);
  assert.strictEqual(pending.stage, 'REWARD_RECORDED');
  assert.strictEqual(pending.gems, 21);

  const recover = harness('SETTLEMENT');
  const result = await recover.run(options);
  assert.strictEqual(result.status, 'POST_VICTORY_COMPLETE');
  assert.ok(!recover.calls.includes('victory-click'));
  assert.ok(recover.calls.includes(`settlement:${pending.settlementId}`));
  assert.ok(!recover.calls.includes('animation'), 'completed animation is not repeated on resume');
  assert.strictEqual(readJson(checkpointPath).stage, 'COMPLETE');
  assert.strictEqual(readJson(checkpointPath).observedTotal, 100);

  const complete = harness('MENU');
  assert.strictEqual((await complete.run(options)).status, 'POST_VICTORY_ALREADY_COMPLETE');
  assert.strictEqual(complete.calls.length, 0, 'completed resume never captures or clicks');

  const unknown = harness('MENU');
  await assert.rejects(unknown.run({ ...options, checkpointPath: path.join(tempDir, 'unknown.json') }),
    /POST_DUEL_CURRENT_PAGE_NOT_PROVEN/);
  assert.ok(!unknown.calls.some(call => call.includes('click')));
  assert.strictEqual(fs.existsSync(path.join(tempDir, 'unknown.json')), false);

  const inspect = harness('VICTORY');
  assert.strictEqual((await inspect.run({ ...options, inspectOnly: true,
    checkpointPath: path.join(tempDir, 'inspect.json') })).status, 'POST_DUEL_INSPECTED');
  assert.ok(!inspect.calls.some(call => call.includes('click')));
  assert.strictEqual(fs.existsSync(path.join(tempDir, 'inspect.json')), false);

  const legacyPath = path.join(tempDir, 'legacy-preview.json');
  writeJsonAtomic(legacyPath, { stage: 'REWARD_RECORDED', settlementId: 'old-preview', gems: 94 });
  const legacy = harness('SETTLEMENT');
  await legacy.run({ ...options, checkpointPath: legacyPath });
  assert.ok(legacy.calls.includes('animation'));
  assert.ok(legacy.calls.includes('correctionAllowed:true'));
  assert.strictEqual(readJson(legacyPath).rewardRecheckPending, false);
  assert.strictEqual(readJson(legacyPath).rewardAnimationComplete, true);

  // Also execute the actual reward executor: recognize the real 79 fixture,
  // record once, pause before input, then resume and end immediately on click.
  const realSettlement = settlementHarness();
  let animationRecorded = false;
  const rewardOptions = { ledgerPath: path.join(tempDir, 'rewards.json'),
    debugDir: path.join(tempDir, 'reward-debug'), settlementId: 'real-executor-fixture',
    onRewardAnimationDone: async () => { animationRecorded = true; } };
  const preview = await realSettlement.run({ ...rewardOptions, beforeContinue: async reward => {
    assert.strictEqual(reward.gems, 79);
    assert.strictEqual(reward.ledger.observedTotal, 79);
    assert.strictEqual(realSettlement.clicks, 0);
    assert.ok(realSettlement.animationClicks >= 8 && realSettlement.animationClicks <= 25);
    assert.strictEqual(animationRecorded, true, 'reward counting happens after animation clicks');
    return false;
  } });
  assert.strictEqual(preview.status, 'DUEL_SETTLEMENT_PAUSED');
  assert.strictEqual(realSettlement.clicks, 0);
  const previousAnimationClicks = realSettlement.animationClicks;
  const confirmed = await realSettlement.run({ ...rewardOptions, skipRewardAnimation: animationRecorded,
    beforeContinue: async () => true });
  assert.strictEqual(confirmed.status, 'DUEL_SETTLEMENT_CONFIRMED');
  assert.strictEqual(confirmed.ledger.duplicate, true);
  assert.strictEqual(confirmed.ledger.observedTotal, 79);
  assert.strictEqual(realSettlement.clicks, 1);
  assert.strictEqual(realSettlement.animationClicks, previousAnimationClicks);
  console.log('POST_DUEL_VICTORY_OFFLINE_PASS; EnterGates=2; ordered=PASS; resume=PASS; idempotent=PASS; unknown=STOP');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolvedTemp = path.resolve(tempDir);
  assert.strictEqual(path.dirname(resolvedTemp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolvedTemp).startsWith('v6-post-victory-'));
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
});
