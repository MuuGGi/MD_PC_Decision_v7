'use strict';

const base = require('./m17-engage');

// 闪刀起动－交闪：三张以上魔法已在墓地时的“检索1 + 追加抽1”分支。
// 普通发动、检索目标策略和专用检索窗口全部复用无追加抽1分支；
// 本文件只声明追加抽1阶段自己的验证/等待参数。
module.exports = {
  ...base,
  branch: 'BONUS_DRAW',
  bonusPromptTimeoutMs: 10000,
  settleAfterBonusConfirmMs: 1500
};
