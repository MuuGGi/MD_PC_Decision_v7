'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MdFastBridge, captureReferenceRoi } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { cropImage } = require('../../lib/png-utils');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');
const {
  VICTORY_TITLE_ROI, VICTORY_CROWN_ROI, RESULT_CONFIRM_ROI,
  detectVictoryResultConfirm, runVictoryResultConfirm
} = require('./duel-result-confirm');
const {
  SETTLEMENT_HEADER_ROI, SETTLEMENT_CONTINUE_ROI,
  detectSettlementPage, runDuelSettlement
} = require('./duel-settlement');

const ROOT = path.resolve(__dirname, '../..');
const CHECKPOINT_PATH = path.join(ROOT, 'debug/post-duel-victory/state.json');

function rewardSummary(gems, ledger) {
  return `本局钻石=${gems == null ? '未知（已保存记录）' : gems}；` +
    (ledger ? `${ledger.dateKey}累计=${ledger.observedTotal}。` : '数量未计入累计。');
}

function createPostDuelTerminalPrompt(rl) {
  if (!rl || typeof rl.question !== 'function') throw new Error('POST_DUEL_TERMINAL_REQUIRED');
  return async step => {
    const prompt = step.phase === 'SETTLEMENT_CONTINUE'
      ? `\n${rewardSummary(step.gems, step.ledger)}\n` +
        '回车=点击结算页右下角并结束；q=退出，保留已记录钻石。\nV6[结算确认]> '
      : (step.checkpoint?.rewardAnimationComplete === true
        ? '\n艾克佐迪亚胜利与奖励动画保存点已确认。\n' +
          '回车=只恢复结算页奖励识别；不重放胜利确认和5秒动画；q=退出保留画面。\nV6[胜利后续]> '
        : '\n艾克佐迪亚胜利已确认。\n' +
          '回车=继续结果/结算页，点击底部区域加速奖励动画5秒后读取钻石；q=退出保留画面。\nV6[胜利后续]> ');
    const answer = String(await rl.question(prompt)).trim();
    return answer === '';
  };
}

async function runPostVictorySettlement(options = {}) {
  const checkpointPath = options.checkpointPath || CHECKPOINT_PATH;
  let checkpoint = options.resume && fs.existsSync(checkpointPath) ? readJson(checkpointPath) : null;
  if (!options.inspectOnly && checkpoint && checkpoint.stage === 'COMPLETE') {
    console.log(`本局结算已经完成：${rewardSummary(checkpoint.gems, checkpoint.dateKey ? checkpoint : null)}不重放点击。`);
    return { status: 'POST_VICTORY_ALREADY_COMPLETE', checkpoint };
  }
  if (!options.inspectOnly) {
    if (typeof options.requestContinue !== 'function') throw new Error('POST_DUEL_TERMINAL_CONFIRMATION_REQUIRED');
    if (!await options.requestContinue({ phase: 'POST_DUEL_START', checkpoint })) {
      return { status: 'POST_VICTORY_PAUSED', checkpoint };
    }
  }
  const bridge = options.bridge || new MdFastBridge();
  const ownsBridge = !options.bridge;
  const debugDir = options.debugDir || path.join(ROOT, 'debug/post-duel-victory',
    new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(debugDir, { recursive: true });
  const save = extra => {
    checkpoint = { ...checkpoint, ...extra, updatedAt: new Date().toISOString() };
    writeJsonAtomic(checkpointPath, checkpoint);
  };
  try {
    if (ownsBridge) await bridge.start();
    const { info } = await activateAndVerifyMasterDuel(bridge, { requireSelfPriorityBlue: false });
    const frame = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
    saveRgbaPng(frame, path.join(debugDir, 'current_page.png'));
    const victory = detectVictoryResultConfirm(cropImage(frame, VICTORY_TITLE_ROI),
      cropImage(frame, VICTORY_CROWN_ROI), cropImage(frame, RESULT_CONFIRM_ROI));
    const settlement = detectSettlementPage(cropImage(frame, SETTLEMENT_HEADER_ROI),
      cropImage(frame, SETTLEMENT_CONTINUE_ROI));
    writeJsonAtomic(path.join(debugDir, 'current_page_proof.json'), { victory, settlement });
    if (options.inspectOnly) return { status: 'POST_DUEL_INSPECTED', victory, settlement, debugDir };
    if (options.resume && !victory.pass && !settlement.pass) {
      throw new Error(`POST_DUEL_CURRENT_PAGE_NOT_PROVEN:${debugDir}`);
    }
    // A normal newly detected victory may still be finishing its overlay.
    // Its mature result-confirm executor waits for proof; a recovery instead
    // requires a current recognized page and never falls into hand decisions.
    if (!checkpoint) {
      save({ version: 1, settlementId: crypto.randomUUID(), stage: 'VICTORY_READY',
        source: options.source || 'V6_TERMINAL_VICTORY', startedAt: new Date().toISOString() });
    }
    if (!settlement.pass) {
      await runVictoryResultConfirm({ bridge, debugDir: path.join(debugDir, 'victory-confirm') });
      save({ stage: 'VICTORY_CONFIRMED' });
      console.log('胜利页确认已完成；继续读取结算奖励并累计本局所有钻石槽。');
    } else {
      console.log('当前已在结算页；直接继续奖励识别，不重放胜利确认。');
    }
    // Old pre-animation previews may already have recorded a partial reward.
    // Reconcile only this unfinished settlement ID after the new final proof.
    if (checkpoint.stage === 'REWARD_RECORDED' && checkpoint.rewardAnimationComplete !== true) {
      save({ rewardRecheckPending: true });
    }
    const recordReward = async reward => save({ stage: 'REWARD_RECORDED', gems: reward.gems,
      observedTotal: reward.ledger?.observedTotal ?? null, dateKey: reward.ledger?.dateKey ?? null,
      rewardStatus: reward.rewardStatus || 'VERIFIED', rewardEvidencePath: reward.rewardEvidencePath || null,
      confirmedSubtotal: reward.confirmedSubtotal ?? reward.gems,
      rewardRecheckPending: false });
    const result = await runDuelSettlement({
      bridge, debugDir: path.join(debugDir, 'settlement'),
      source: options.source || 'V6_TERMINAL_VICTORY',
      settlementId: checkpoint.settlementId, ledgerPath: options.ledgerPath,
      rewardPolicy: options.rewardPolicy || 'record-first',
      skipRewardAnimation: checkpoint.rewardAnimationComplete === true,
      allowProvisionalCorrection: checkpoint.rewardRecheckPending === true,
      onRewardAnimationDone: async animation => save({ rewardAnimationComplete: true,
        animationClicks: animation.clicks, animationDurationMs: animation.elapsedMs }),
      onRewardRecorded: recordReward,
      onRewardCommitted: recordReward,
      beforeContinue: reward => options.requestContinue({ phase: 'SETTLEMENT_CONTINUE', ...reward })
    });
    if (result.status === 'DUEL_SETTLEMENT_PAUSED') {
      return { status: 'POST_VICTORY_PAUSED', result, checkpoint, debugDir };
    }
    save({ stage: 'COMPLETE', gems: result.gems, observedTotal: result.ledger?.observedTotal ?? null,
      dateKey: result.ledger?.dateKey ?? null });
    console.log(`胜利后续完成：${rewardSummary(result.gems, result.ledger)}结算右下角已确认。`);
    return { status: 'POST_VICTORY_COMPLETE', result, checkpoint, debugDir };
  } finally {
    if (ownsBridge) await bridge.stop().catch(() => {});
  }
}

module.exports = { CHECKPOINT_PATH, createPostDuelTerminalPrompt, runPostVictorySettlement };
