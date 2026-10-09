'use strict';
// V7 owns the production loop. The mature facade has no self-starting V6 loop.
require('../../src/runtime/duel-loop').run().catch(error => {
  console.error('V7启动/执行失败: ' + String(error.stack || error));
  process.exitCode = 1;
});
