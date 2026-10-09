'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');
const { harness, CP, LEDGER } = require('../../../tests-settlement');
const { playOne } = require('../../../session');
const { summarize } = require('../../../policy');
const { choosePrompt } = require('../../../policy');
const { createPostDuelTerminalPrompt } = require('../core/post-duel-victory');
const settlement = require('../core/duel-settlement');
const AUTOTEST = path.resolve(__dirname, '../../..');
const RUN = path.join(AUTOTEST, 'runs/2026-10-04T10-11-07-804Z');
const GAME = path.join(RUN, 'game-00002/finish-stopped/debug/post-duel-victory');
const saved = JSON.parse(fs.readFileSync(path.join(GAME, 'state.json')));
const DIR = path.join(GAME, '2026-10-04T10-26-53-344Z/settlement');
const report = JSON.parse(fs.readFileSync(path.join(DIR, 'settlement_recognition_failed.json')));
const game = JSON.parse(fs.readFileSync(path.join(RUN, 'summary.json'))).games[1];
const files = [path.join(RUN, 'summary.json'), path.join(GAME, 'state.json'),
  path.join(AUTOTEST, 'statistics.json'), path.join(AUTOTEST, 'latest-run.json'), CP, LEDGER];
const original = files.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);

function actualRois() {
  return new Map([
    [settlement.SETTLEMENT_HEADER_ROI, 'settlement_header_failed.png'],
    [settlement.SETTLEMENT_REWARD_PANEL_ROI, 'settlement_reward_panel_failed.png'],
    [settlement.SETTLEMENT_CONTINUE_ROI, 'settlement_continue_failed.png']
  ].map(([roi, file]) => [JSON.stringify(roi), PNG.sync.read(fs.readFileSync(path.join(DIR, file)))]));
}
function blank(image) { return { ...image, data: Buffer.alloc(image.data.length) }; }
function recorded(h) {
  const file = [...h.disk.keys()].find(file => file.endsWith('settlement_reward_record.json'));
  assert.ok(file, 'raw reward record is required before continue');
  return h.readJson(file);
}

async function test() {
  // Real screen visually says 72, but the unchanged classifier rejects its 2
  // and ranks the nearest known glyph as 9. Do NOT turn that guess into 79.
  assert.strictEqual(report.gems.pass, false);
  assert.strictEqual(report.gems.rewards[0].count.text, '79');
  const panel = actualRois().get(JSON.stringify(settlement.SETTLEMENT_REWARD_PANEL_ROI));
  assert.strictEqual(settlement.recognizeSettlementGemRewards(panel).pass, false);
  const h = harness(saved, undefined, actualRois());
  const target = { ...game, gems: null }; delete target.finishError;
  const archives = [];
  const store = { save() {}, finish: (_, outcome, details) => Object.assign(target, details, { outcome }) };
  const result = await playOne(store, { stopped: () => false,
    play: async () => ({ outcome: 'WIN', proven: true }), finishBoard: () => h.finish(game),
    archive: async (_, label) => archives.push(label) }, target);
  assert.strictEqual(result.stop, false, 'unknown reward must not stop the next game');
  assert.deepStrictEqual(archives, ['completed']);
  assert.strictEqual(target.outcome, 'WIN');
  assert.strictEqual(target.gems, null);
  assert.strictEqual(target.rewardStatus, 'UNKNOWN');
  assert.strictEqual(target.returnedToStarter, true);
  assert.strictEqual(h.disk.has(LEDGER), false, 'unknown is neither guessed 79 nor a zero ledger entry');
  assert.deepStrictEqual(h.clicks, [{ x: 1824, y: 1052 }], 'existing animation checkpoint is not replayed');
  assert.strictEqual(h.readJson(CP).stage, 'COMPLETE');
  assert.strictEqual(h.readJson(CP).gems, null);
  const proof = recorded(h);
  assert.strictEqual(proof.rewardStatus, 'UNKNOWN');
  assert.strictEqual(proof.gems, null);
  assert.strictEqual(proof.recognition.rewards[0].count.text, '79');
  assert.ok([...h.disk.keys()].some(file => file.endsWith('settlement_reward_panel.png')));
  assert.strictEqual(summarize([target]).wins, 1);
  assert.strictEqual(summarize([target]).errorGames, 0);
  assert.strictEqual(summarize([target]).unknownGemGames, 1);
  assert.strictEqual((await h.finish(game, { outcome: 'WIN', gems: null, proof: h.readJson(CP) })).gems, null);
  assert.strictEqual(h.clicks.length, 1, 'completed unknown checkpoint cannot replay continue');

  const paused = harness(saved, undefined, actualRois());
  const pausedReward = await paused.settlement.runDuelSettlement({ bridge: { click() { throw new Error('PAUSED_INPUT'); } },
    debugDir: 'MEMORY_PAUSED', skipRewardAnimation: true, rewardPolicy: 'record-first',
    settlementId: saved.settlementId, beforeContinue: async reward => {
      assert.strictEqual(reward.gems, null); assert.strictEqual(reward.ledger, null); return false;
    } });
  assert.strictEqual(pausedReward.status, 'DUEL_SETTLEMENT_PAUSED');
  assert.strictEqual(paused.disk.has(LEDGER), false);
  recorded(paused);

  // A valid page with no readable gem icon is also record-only. No invented 0.
  const noSlotRois = actualRois();
  noSlotRois.set(JSON.stringify(settlement.SETTLEMENT_REWARD_PANEL_ROI), blank(panel));
  const noSlot = harness(saved, undefined, noSlotRois);
  assert.strictEqual((await noSlot.finish(game)).gems, null);
  assert.strictEqual(recorded(noSlot).recognition.reason, 'NO_GEM_REWARD_SLOT');
  assert.strictEqual(noSlot.clicks.length, 1);

  const partial = harness(); partial.setMissingEight(true);
  assert.strictEqual((await partial.finish()).gems, null);
  assert.strictEqual(recorded(partial).confirmedSubtotal, 10);
  assert.strictEqual(partial.disk.has(LEDGER), false, 'known partial slot must not masquerade as the complete reward');
  let unknownPrompt;
  const ask = createPostDuelTerminalPrompt({ question: async prompt => {
    unknownPrompt = prompt; return choosePrompt(prompt);
  } });
  assert.strictEqual(await ask({ phase: 'SETTLEMENT_CONTINUE', gems: null, ledger: null }), true);
  assert.ok(unknownPrompt.includes('未知（已保存记录）'));
  assert.ok(!unknownPrompt.includes('本局钻石=0'));

  // Page validity and human-stop remain mandatory despite optional numbers.
  const changedRois = actualRois(), changed = harness(saved, undefined, changedRois);
  await assert.rejects(changed.settlement.runDuelSettlement({ bridge: { click() { throw new Error('UNSAFE_CLICK'); } },
    debugDir: 'MEMORY_CHANGED', skipRewardAnimation: true, rewardPolicy: 'record-first',
    beforeContinue: async () => {
      const key = JSON.stringify(settlement.SETTLEMENT_CONTINUE_ROI);
      changedRois.set(key, blank(changedRois.get(key))); return true;
    } }), /CHANGED_BEFORE_CLICK/);
  assert.strictEqual(changed.clicks.length, 0);
  const stopped = harness(saved, undefined, actualRois());
  stopped.setStop(); await assert.rejects(stopped.finish(game), /USER_STOP/);
  assert.strictEqual(stopped.clicks.length, 0);
  for (const [file, before] of original) assert.ok(before ? before.equals(fs.readFileSync(file)) : !fs.existsSync(file), file);
  console.log('RECORD_FIRST_SETTLEMENT_OFFLINE_PASS; real rejected72 -> UNKNOWN record/WIN/continue; classifier unchanged; no guessed79/zero ledger; no repeated animation/click; pause/no-slot/page-change/human-stop; real state/statistics unchanged; nativeInputs=0');
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { test };
