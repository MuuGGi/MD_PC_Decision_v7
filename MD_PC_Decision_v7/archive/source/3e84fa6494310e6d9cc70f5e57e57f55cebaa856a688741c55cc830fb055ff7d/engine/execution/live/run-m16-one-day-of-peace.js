'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm16-one-day-of-peace'));
const { runSimpleDrawSpellTest } = require(path.join(ROOT, 'execution', 'core', 'simple-draw-spell-test'));

runSimpleDrawSpellTest({
  card,
  debugName: 'M16_one_day_of_peace',
  testEntry: 'execution\\live\\run-m16-one-day-of-peace.cmd',
  passScope: '1~12张手牌；完全复用封板M09/M15的observer TITLE_COMPONENTS/DENSE真实定位；暂时休战发动后动画纯等待；正式observer验证M16离手+我方抽1+最终手牌数不变'
}).catch(error => {
  console.error(`\nM16执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
