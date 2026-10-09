'use strict';
// Loaded only into the isolated engine and its child Node executors.
const fs = require('fs');
const path = require('path');
const { chooseDecision, choosePrompt } = require('./policy');
const { recordGuardedFullCapture } = require('./diagnostics');
let failed = null;
function check() {
  if (process.env.MD_AUTOTEST_STOP && fs.existsSync(process.env.MD_AUTOTEST_STOP)) {
    throw new Error(`AUTOTEST_STOP:${fs.readFileSync(process.env.MD_AUTOTEST_STOP, 'utf8')}`);
  }
  if (failed) throw new Error(`AUTOTEST_ACTION_FAILED:${failed}`);
}
function record(type, details) {
  if (!process.env.MD_AUTOTEST_EVENTS) return;
  fs.appendFileSync(process.env.MD_AUTOTEST_EVENTS, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, type, ...details }) + '\n');
}
const logError = console.error.bind(console);
console.error = (...args) => {
  const message = args.map(String).join(' ');
  if (!failed && /(?:V[567]|M\d{2})(?:执行|原子事务|场上节点|启动).*?(?:停止|失败)|FAIL-CLOSED|后续(?:停止|结算停止)|M18支线继续停止/.test(message)) failed = message;
  logError(...args);
};
const readline = require('readline/promises');
readline.createInterface = () => ({
  async question(prompt) { check(); const answer = choosePrompt(String(prompt)); record('AUTO_CONFIRM', { prompt, answer }); return answer; },
  close() {}
});
const bridgeFile = path.join(__dirname, '../engine/lib/win-fast.js');
const { MdFastBridge } = require(bridgeFile);
const originalCommand = MdFastBridge.prototype.command;
MdFastBridge.prototype.command = async function (command) {
  if (!['quit', 'mouseUp', 'guardRelease'].includes(command.cmd)) check();
  const input = /^(?:click|clickScreen|move|mouseDown|drag|wheel|wheelBurst|wheelBurstCaptureReferenceRoi|key)$/.test(command.cmd);
  if (input) record('INPUT_REQUEST', { command });
  try {
    const result = await originalCommand.call(this, command);
    if (input) record('INPUT_COMPLETE', { command });
    try { recordGuardedFullCapture(process.env.MD_AUTOTEST_FRAME, command, result); }
    catch (error) { record('DIAGNOSTIC_FRAME_WRITE_FAILED', { error: String(error.message || error) }); }
    return result;
  } catch (error) {
    record('BRIDGE_ERROR', { command: { cmd: command.cmd }, error: String(error.stack || error),
      code: error.code, guardFailure: error.guardFailure });
    throw error;
  }
};
function decision(suggestion) {
  check(); const answer = chooseDecision(suggestion);
  record('AUTO_DECISION', { answer, selected: suggestion.selected, strategicDeadlock: suggestion.strategicDeadlock,
    branch: suggestion.runtime && suggestion.runtime.v5Branch });
  return answer;
}
module.exports = { decision, check };
