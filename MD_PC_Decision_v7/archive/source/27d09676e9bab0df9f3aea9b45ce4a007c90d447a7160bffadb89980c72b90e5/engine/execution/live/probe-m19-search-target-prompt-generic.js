'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'm19-generic-target-prompt');
const STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const {
  updateCompositeRouteState,
  summarizeCompositeRouteState,
  initialState
} = require(path.join(ROOT, 'lib', 'composite-route-observer'));
const {
  probeBambooSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'bamboo-search-target-prompt-observer'));


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log('\n===== GENERIC M19 BAMBOO SEARCH TARGET PASSIVE PROBE =====');
  console.log('只截图确认“妖刀竹光结算时选择竹光加入手卡”的对象窗口；不点击候选、不确认、不读INFO、不滚轮。');
  console.log('本探针不假设零衣/零罗/篝/衍生物，也不替任何其他效果补写已结算状态；只认当前M19检索窗口。');

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

    const probe = await probeBambooSearchTargetPrompt({
      bridge,
      info,
      debugDir: DEBUG_DIR,
      suffix: new Date().toISOString().replace(/[:.]/g, '-')
    });

    console.log(
      `妖刀检索对象窗口: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `headerDark=${probe.headerDark.toFixed(3)}; bodyDark=${probe.bodyDark.toFixed(3)}; ` +
      `candidates=${probe.candidateCount}`
    );
    console.log(`竹光合法素材库: ${probe.allowedTargets.map(row => `${row.name}[${row.id}]x${row.count}`).join(' | ') || 'NONE'}`);
    if (probe.candidateCenters.length) {
      console.log(`实时物理候选中心: ${probe.candidateCenters.map(p => `(${p.x},${p.y})`).join(', ')}`);
    }

    const previous = readJsonIfExists(STATE_PATH) || initialState();
    const observationId = new Date().toISOString();
    const events = probe.visible ? [{
      kind: 'EFFECT_TARGET_SELECTION',
      mode: 'AVAILABLE',
      effectMode: 'M19_SEARCH',
      candidateCount: probe.candidateCount,
      allowedTargets: probe.allowedTargets,
      detector: probe.detector,
      activationKey: 'M19',
      activationName: '妖刀竹光检索对象选择',
      signature: `M19_TARGET_SELECTION|AVAILABLE|${probe.detector}`,
      observationId
    }] : [];
    const updated = updateCompositeRouteState(previous, events, observationId);
    const result = {
      status: probe.visible ? 'PASS' : 'NOT_CONFIRMED',
      mode: 'M19_BAMBOO_TARGET_PROMPT_GENERIC_PASSIVE',
      appliedEvents: updated.applied,
      events,
      targetPromptProbe: probe,
      summary: summarizeCompositeRouteState(updated.state),
      state: updated.state,
      capturedAt: observationId
    };
    if (probe.visible) writeJson(STATE_PATH, updated.state);
    writeJson(RESULT_PATH, result);
    process.exitCode = probe.visible ? 0 : 2;
  } finally {
    await bridge.stop().catch(() => {});
  }
}

main().catch(error => {
  console.error(`通用妖刀检索对象窗口纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
