'use strict';

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { runConfirmedDeadlockSurrender } = require('../core/deadlock-surrender');

const REQUIRED_NODE = '20.11.1';

async function main() {
  if (String(process.versions.node || '') !== REQUIRED_NODE) {
    throw new Error(
      `NODE_VERSION_MISMATCH:${process.versions.node || 'UNKNOWN'}; expected ${REQUIRED_NODE}`
    );
  }

  console.log(`Node运行时: v${process.versions.node} PASS`);
  console.log('============================================================');
  console.log('必定死局投降：正式实机回归');
  console.log('将切回 Master Duel，识别齿轮并打开设置，再识别并点击红色“投降”。');
  console.log('会识别“是否投降？”确认框并点击右侧“是”。');
  console.log('点击“是”后纯等待4000ms，再识别投降结果页并点击“确认”。');
  console.log('确认点击完成后保存调试截图并返回 SURRENDER_COMPLETE。');
  console.log('============================================================');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = String(
      await rl.question('确认当前对局可以投降？请输入 SURRENDER 继续：\n> ')
    ).trim();
    if (answer !== 'SURRENDER') {
      console.log('未收到精确确认；没有向游戏发送任何输入。');
      return;
    }

    const result = await runConfirmedDeadlockSurrender({ source: 'MANUAL_LIVE_REGRESSION' });
    console.log('\n投降结果页的“确认”已点击；正式投降流程完成。');
    console.log(`状态: ${result.status}`);
    console.log(`完成后调试截图: ${result.afterPath}`);
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`\n投降实机回归停止: ${error && error.stack ? error.stack : error}`);
  console.error('FAIL-CLOSED：不会自动重试，不会继续点击。');
  process.exitCode = 1;
});
