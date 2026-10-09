'use strict';

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { runDuelSettlement } = require('../core/duel-settlement');

const REQUIRED_NODE = '20.11.1';

async function main() {
  if (String(process.versions.node || '') !== REQUIRED_NODE) {
    throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node || 'UNKNOWN'}; expected ${REQUIRED_NODE}`);
  }
  console.log(`Node运行时: v${process.versions.node} PASS`);
  console.log('结算页实机回归：识别本局宝石、更新每日账本，再点击右下角视觉按钮。');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = String(await rl.question('确认处理当前结算页？请输入 SETTLE：\n> ')).trim();
    if (answer !== 'SETTLE') {
      console.log('未收到精确确认；没有向游戏发送任何输入。');
      return;
    }
    const result = await runDuelSettlement({ source: 'MANUAL_LIVE_REGRESSION' });
    console.log(`结算完成: ${result.status}; 本局宝石=${result.gems}; 今日累计=${result.ledger.observedTotal}`);
    console.log(`账本: ${result.ledger.ledgerPath}`);
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`\n结算页处理停止: ${error && error.stack ? error.stack : error}`);
  console.error('FAIL-CLOSED：不记账、不点击右下角、不自动重试。');
  process.exitCode = 1;
});
