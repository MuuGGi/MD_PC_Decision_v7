'use strict';

module.exports = {
  id: 'M14',
  name: '金黄色的竹光',
  settleAfterActivationMs: 3200,
  // 当前封板 hand observer 只覆盖到 12 张；M14 是 -1 +2 = 净+1，
  // 所以发动前最多 11 张，避免结算后 13 张进入未验证区间。
  maxHandCountBeforeActivation: 11
};
