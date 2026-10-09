'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm15-into-the-void'));
const { runSimpleDrawSpellTest } = require(path.join(ROOT, 'execution', 'core', 'simple-draw-spell-test'));

runSimpleDrawSpellTest({
  card,
  debugName: 'M15_into_the_void',
  testEntry: 'execution\\live\\run-m15-into-the-void.cmd',
  passScope: '1~12张手牌；复用observer TITLE_COMPONENTS/DENSE；无之炼狱发动后抽1；正式observer验证M15离手+新增1张+手牌数不变'
}).catch(error => {
  console.error(`\nM15执行测试停止: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
