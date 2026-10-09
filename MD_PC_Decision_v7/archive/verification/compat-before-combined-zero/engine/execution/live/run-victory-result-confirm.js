'use strict';

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { runVictoryResultConfirm } = require('../core/duel-result-confirm');

const REQUIRED_NODE = '20.11.1';

async function main() {
  if (String(process.versions.node || '') !== REQUIRED_NODE) {
    throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node || 'UNKNOWN'}; expected ${REQUIRED_NODE}`);
  }
  console.log(`Node运行时: v${process.versions.node} PASS`);
  console.log('胜利结果页实机回归：只在证明 VICTORY、左侧胜利皇冠和底部确认按钮后点击。');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = String(await rl.question('确认点击当前胜利结果页？请输入 CONFIRM：\n> ')).trim();
    if (answer !== 'CONFIRM') {
      console.log('未收到精确确认；没有向游戏发送任何输入。');
      return;
    }
    const result = await runVictoryResultConfirm({ source: 'MANUAL_LIVE_REGRESSION' });
    console.log(`胜利结果确认完成: ${result.status}`);
    console.log(`调试目录: ${result.debugDir}`);
    console.log('本独立测试只确认胜利页；正式主入口会由用户回车继续钻石识别与结算确认。');
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`\n胜利结果确认停止: ${error && error.stack ? error.stack : error}`);
  console.error('FAIL-CLOSED：不会自动重试，不会继续点击。');
  process.exitCode = 1;
});
