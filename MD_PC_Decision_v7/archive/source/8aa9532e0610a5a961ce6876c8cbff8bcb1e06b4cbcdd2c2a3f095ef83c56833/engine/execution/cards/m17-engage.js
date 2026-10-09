'use strict';

const { buildEngageLegalTargets } = require('../../lib/engage-policy');

// 闪刀起动－交闪：候选合法集合与战略优先级均由共享 Engage policy 管理。
// 物理执行器仍逐张识别当前检索窗口，不依赖固定坐标。
module.exports = {
  id: 'M17',
  name: '闪刀起动－交闪',
  branch: 'NO_BONUS_DRAW',
  settleAfterSearchMs: 1200,
  noBonusProbeMs: 2800,
  legalTargets: buildEngageLegalTargets()
};
