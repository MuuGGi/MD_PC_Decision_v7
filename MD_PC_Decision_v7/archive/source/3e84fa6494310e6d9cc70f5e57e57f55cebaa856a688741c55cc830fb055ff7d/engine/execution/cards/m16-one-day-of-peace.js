'use strict';

// 暂时休战：自身从手牌发动后我方抽1。
// 普通发动/定位/observer验收全部复用已经现场封板的 M09/M15 公共执行层。
module.exports = {
  id: 'M16',
  name: '暂时休战',
  // 双方各抽1，动画比普通单边抽1稍长；期间严格纯等待。
  settleAfterActivationMs: 3200
};
