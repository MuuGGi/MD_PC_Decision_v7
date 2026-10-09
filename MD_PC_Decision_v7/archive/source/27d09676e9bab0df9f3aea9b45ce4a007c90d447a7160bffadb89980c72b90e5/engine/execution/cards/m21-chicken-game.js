'use strict';

// 试胆竞速：先从手牌发动成为场地魔法，再发动场上抽1效果。
// 手牌发动部分完全复用已封板执行层；场上阶段只保留此前现场验证过的固定场地区、
// “发动效果”按钮和默认抽1确认窗口。
module.exports = {
  id: 'M21',
  name: '试胆竞速',

  // 2048x1152 Master Duel 客户端参考坐标。历史现场截图已实测。
  fieldCardPoint: { x: 476, y: 727 },

  fieldEffectButton: {
    point: { x: 555, y: 571 },
    roi: { x: 490, y: 500, width: 130, height: 140 },
    minYellowPixels: 900
  },

  drawOptionDialog: {
    bodyRoi: { x: 455, y: 280, width: 1135, height: 590 },
    okRoi: { x: 870, y: 735, width: 310, height: 110 },
    okPoint: { x: 1024, y: 790 },
    timeoutMs: 5000,
    minDarkRatio: 0.34,
    minOkYellowPixels: 180
  },

  // 历史现场900ms偏早；先纯等待1700ms，再只读右栏，必要时650ms重读。
  fieldPlacementInitialWaitMs: 1700,
  fieldPlacementRetryWaitMs: 650,
  fieldPlacementLogAttempts: 3,

  // 用户现场要求：点完卡后再点“选择/确定/OK”等动作统一留出更长稳定时间。
  // 这里把相同安全节奏用于“场地卡 -> 发动效果”以及“选项窗口 -> OK”。
  afterFieldCardVerifyMs: 1000,
  afterDrawDialogProofMs: 1000,

  // 点击OK后只等待抽1动画，不发送其他输入。
  settleAfterDrawConfirmMs: 1200
};