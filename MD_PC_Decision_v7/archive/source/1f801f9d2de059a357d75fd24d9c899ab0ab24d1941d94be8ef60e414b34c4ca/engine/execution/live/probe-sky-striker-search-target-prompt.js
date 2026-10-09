'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'sky-striker-target-prompt');
const STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const {
  updateCompositeRouteState,
  summarizeCompositeRouteState,
  initialState
} = require(path.join(ROOT, 'lib', 'composite-route-observer'));
const {
  probeSkyStrikerSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'sky-striker-search-target-prompt-observer'));


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log('\n===== SKY STRIKER MONSTER TARGET PASSIVE PROBE =====');
  console.log('本阶段只截图检测零罗/新怪兽效果结算时的“选择闪刀卡加入手卡”窗口；不会点击候选、不会确认、不会发 ESC/INFO/滚轮。');

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    await bridge.activateMasterDuel();
    await sleep(350);
    const info = await bridge.info();
    const title = String(info && info.title || '').toLowerCase();
    if (!title.includes('masterduel') && !title.includes('master duel')) {
      throw new Error(`MASTER_DUEL_WINDOW_NOT_FOUND_AFTER_ACTIVATE:${info && info.title || 'UNKNOWN'}`);
    }

    const probe = await probeSkyStrikerSearchTargetPrompt({
      bridge,
      info,
      debugDir: DEBUG_DIR,
      suffix: new Date().toISOString().replace(/[:.]/g, '-')
    });

    console.log(
      `零罗/新怪兽对象窗口: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `headerDark=${probe.headerDark.toFixed(3)}; bodyDark=${probe.bodyDark.toFixed(3)}; ` +
      `candidates=${probe.candidateCount}`
    );
    console.log(
      `当前闪刀合法素材库: ${probe.allowedTargets.map(row => `${row.name}[${row.id}]x${row.count}`).join(' | ') || 'NONE'}`
    );
    if (probe.candidateCenters.length) {
      console.log(`实时物理候选中心: ${probe.candidateCenters.map(p => `(${p.x},${p.y})`).join(', ')}`);
    }

    const previous = readJsonIfExists(STATE_PATH) || initialState();
    const observationId = new Date().toISOString();
    const events = probe.visible ? [{
      kind: 'EFFECT_TARGET_SELECTION',
      mode: 'AVAILABLE',
      effectMode: 'MONSTER_OPTIONAL',
      candidateCount: probe.candidateCount,
      allowedTargets: probe.allowedTargets,
      detector: probe.detector,
      activationKey: null,
      activationName: '零罗/新怪兽效果对象选择',
      signature: `MONSTER_OPTIONAL_TARGET_SELECTION|AVAILABLE|${probe.detector}`,
      observationId
    }] : [];
    const updated = updateCompositeRouteState(previous, events, observationId);
    const summary = summarizeCompositeRouteState(updated.state);
    const result = {
      status: probe.visible ? 'PASS' : 'NOT_CONFIRMED',
      mode: 'SKY_STRIKER_MONSTER_TARGET_PROMPT_PASSIVE',
      appliedEvents: updated.applied,
      events,
      targetPromptProbe: probe,
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
  console.error(`零罗/新怪兽对象窗口纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
