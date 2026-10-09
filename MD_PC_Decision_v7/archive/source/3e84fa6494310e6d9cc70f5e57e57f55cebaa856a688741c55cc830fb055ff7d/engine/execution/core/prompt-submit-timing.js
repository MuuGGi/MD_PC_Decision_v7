'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { sleep } = require(path.join(ROOT, 'lib', 'win-fast'));

// Global execution safety timing for dedicated selection dialogs.
// Once a card/candidate has been physically selected and its identity has been
// proven, give Master Duel a conservative settling interval before pressing an
// OK / 选择 / 确定 / confirm button.  The important rule is that this delay sends
// zero additional card clicks; if submit is late, retry only the submit button.
const POST_CARD_SELECTION_SUBMIT_DELAY_MS = 1000;

async function waitBeforePromptSubmit(label, delayMs = POST_CARD_SELECTION_SUBMIT_DELAY_MS) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (!ms) return;
  console.log(`${label}: 候选已确认，纯等待${ms}ms后再点击“选择/确认”。`);
  await sleep(ms);
}

module.exports = {
  POST_CARD_SELECTION_SUBMIT_DELAY_MS,
  waitBeforePromptSubmit
};