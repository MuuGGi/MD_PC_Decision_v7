'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'optional-effect-prompt');
const STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const {
  updateCompositeRouteState,
  summarizeCompositeRouteState,
  initialState
} = require(path.join(ROOT, 'lib', 'composite-route-observer'));
const { probeOptionalEffectPrompt } = require(path.join(ROOT, 'execution', 'core', 'optional-effect-prompt-observer'));


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log('\n===== OPTIONAL EFFECT PROMPT PASSIVE PROBE =====');
  console.log('本阶段只截图检测；会先把 Master Duel 切到前台，但不发送鼠标、键盘、INFO、滚轮，也不打开/关闭右栏。');

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    // The user returns to the terminal to trigger this passive probe, so VS Code /
    // PowerShell is normally foreground at this exact moment. ROI capture in win-fast
    // intentionally requires Master Duel to be foreground. Bring the game forward
    // first, then capture only pixels. This does not click or press anything in-game.
    await bridge.activateMasterDuel();
    await sleep(350);
    const info = await bridge.info();
    const title = String(info && info.title || '').toLowerCase();
    if (!title.includes('masterduel') && !title.includes('master duel')) {
      throw new Error(`MASTER_DUEL_WINDOW_NOT_FOUND_AFTER_ACTIVATE:${info && info.title || 'UNKNOWN'}`);
    }

    const probe = await probeOptionalEffectPrompt({
      bridge,
      info,
      debugDir: DEBUG_DIR,
      suffix: new Date().toISOString().replace(/[:.]/g, '-')
    });

    console.log(
      `可选效果窗口: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `headerDark=${probe.headerDark.toFixed(3)}; ` +
      `bodyDark=${probe.bodyDark.toFixed(3)}; ` +
      `candidates=${probe.candidateCount}`
    );

    const previous = readJsonIfExists(STATE_PATH) || initialState();
    const observationId = new Date().toISOString();
    const events = probe.visible ? [{
      kind: 'OPTIONAL_EFFECT',
      mode: 'AVAILABLE',
      candidateCount: probe.candidateCount,
      detector: probe.detector,
      activationKey: null,
      activationName: '召唤后可选效果窗口',
      signature: `OPTIONAL_EFFECT|AVAILABLE|${probe.detector}`,
      observationId
    }] : [];
    const updated = updateCompositeRouteState(previous, events, observationId);
    const summary = summarizeCompositeRouteState(updated.state);
    const result = {
      status: probe.visible ? 'PASS' : 'NOT_CONFIRMED',
      mode: 'OPTIONAL_EFFECT_PROMPT_PASSIVE',
      appliedEvents: updated.applied,
      events,
      promptProbe: probe,
      summary,
      state: updated.state,
      capturedAt: observationId
    };
    if (probe.visible) writeJson(STATE_PATH, updated.state);
    writeJson(RESULT_PATH, result);
    process.exitCode = probe.visible ? 0 : 2;
  } finally {
    await bridge.stop();
  }
}

main().catch(error => {
  console.error(`可选效果窗口纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
