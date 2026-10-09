'use strict';

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { runPostVictorySettlement, createPostDuelTerminalPrompt } = require('../core/post-duel-victory');

async function main() {
  if (process.versions.node !== '20.11.1') throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const result = await runPostVictorySettlement({
      resume: true, inspectOnly: process.argv.includes('--inspect'),
      source: 'V6_RESUME_VICTORY_SETTLEMENT', requestContinue: createPostDuelTerminalPrompt(rl)
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { rl.close(); }
}
main().catch(error => {
  console.error(error.stack || error.message);
  console.error('胜利后续停止；保留结算保存点和已记录钻石，未重放抽牌。');
  process.exitCode = 1;
});
