'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'm19-target-prompt');
const SKY_DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'sky-striker-target-prompt-from-bamboo-guard');
const STATE_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'session_state.json');
const RESULT_PATH = path.join(ROOT, 'debug', 'composite-route-live', 'latest_result.json');

const { MdFastBridge, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const {
  updateCompositeRouteState,
  summarizeCompositeRouteState,
  initialState,
  enterCompositeResolutionSelection,
  submitCompositeTargetSelection
} = require(path.join(ROOT, 'lib', 'composite-route-observer'));
const {
  probeBambooSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'bamboo-search-target-prompt-observer'));
const {
  probeSkyStrikerSearchTargetPrompt
} = require(path.join(ROOT, 'execution', 'core', 'sky-striker-search-target-prompt-observer'));


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function currentTargetMode(state) {
  return String(state && state.current && state.current.targetSelection && state.current.targetSelection.effectMode || '').toUpperCase();
}

function currentTargetStatus(state) {
  return String(state && state.current && state.current.targetSelection && state.current.targetSelection.status || '').toUpperCase();
}

async function main() {
  console.log('\n===== M19 BAMBOO SEARCH TARGET PASSIVE PROBE =====');
  console.log('本阶段只截图判断当前到底是“零罗选闪刀卡”还是“妖刀选竹光”；不会点击候选、不会确认、不会发 ESC/INFO/滚轮。');

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

    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const bambooProbe = await probeBambooSearchTargetPrompt({ bridge, info, debugDir: DEBUG_DIR, suffix });

    console.log(
      `妖刀检索对象窗口: ${bambooProbe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `headerDark=${bambooProbe.headerDark.toFixed(3)}; bodyDark=${bambooProbe.bodyDark.toFixed(3)}; ` +
      `candidates=${bambooProbe.candidateCount}`
    );

    // 如果竹光检测未通过，额外只读一次零罗对象窗口检测。
    // 这不是兜底猜测：两类窗口拥有不同合法卡池；看到零罗窗口时绝不能推进到 M19。
    if (!bambooProbe.visible) {
      const skyProbe = await probeSkyStrikerSearchTargetPrompt({ bridge, info, debugDir: SKY_DEBUG_DIR, suffix });
      if (skyProbe.visible) {
        console.log(
          `当前实际仍是零罗/新怪兽对象窗口: PASS; candidates=${skyProbe.candidateCount}`
        );
        console.log('状态保护: 不允许把 CL2 零罗提前记为 RESOLVED，也不允许切到妖刀 M19 结算。');

        const repaired = enterCompositeResolutionSelection({
          rootDir: ROOT,
          effectMode: 'MONSTER_OPTIONAL',
          resolvedBefore: [],
          source: 'R3B_VISUAL_GUARD_MONSTER_TARGET_STILL_VISIBLE'
        });
        const observationId = new Date().toISOString();
        const event = {
          kind: 'EFFECT_TARGET_SELECTION',
          mode: 'AVAILABLE',
          effectMode: 'MONSTER_OPTIONAL',
          candidateCount: skyProbe.candidateCount,
          allowedTargets: skyProbe.allowedTargets,
          detector: skyProbe.detector,
          activationKey: null,
          activationName: '零罗/新怪兽效果对象选择',
          signature: `MONSTER_OPTIONAL_TARGET_SELECTION|AVAILABLE|${skyProbe.detector}`,
          observationId
        };
        const updated = updateCompositeRouteState(repaired.state, [event], observationId);
        writeJson(STATE_PATH, updated.state);
        const result = {
          status: 'MONSTER_TARGET_STILL_VISIBLE',
          mode: 'R3B_STAGE_GUARD_MONSTER_BEFORE_BAMBOO',
          appliedEvents: updated.applied,
          events: [event],
          bambooProbe,
          skyStrikerProbe: skyProbe,
          summary: summarizeCompositeRouteState(updated.state),
          state: updated.state,
          capturedAt: observationId
        };
        writeJson(RESULT_PATH, result);
        console.log('请先在游戏里完成零罗的闪刀卡选择并确认；等真正出现竹光候选后，再回终端输入 R。');
        process.exitCode = 2;
        return;
      }
    }

    console.log(
      `竹光合法素材库: ${bambooProbe.allowedTargets.map(row => `${row.name}[${row.id}]x${row.count}`).join(' | ') || 'NONE'}`
    );
    if (bambooProbe.candidateCenters.length) {
      console.log(`实时物理候选中心: ${bambooProbe.candidateCenters.map(p => `(${p.x},${p.y})`).join(', ')}`);
    }

    if (!bambooProbe.visible) {
      const previous = readJsonIfExists(STATE_PATH) || initialState();
      const result = {
        status: 'NOT_CONFIRMED',
        mode: 'M19_BAMBOO_TARGET_PROMPT_PASSIVE',
        appliedEvents: 0,
        events: [],
        targetPromptProbe: bambooProbe,
        summary: summarizeCompositeRouteState(previous),
        state: previous,
        capturedAt: new Date().toISOString()
      };
      writeJson(RESULT_PATH, result);
      process.exitCode = 2;
      return;
    }

    // 只有视觉上已经真正进入竹光窗口，才允许确认：CL2 零罗已完成，并推进到 CL1 妖刀。
    let previous = readJsonIfExists(STATE_PATH) || initialState();
    const mode = currentTargetMode(previous);
    const status = currentTargetStatus(previous);
    if (mode === 'MONSTER_OPTIONAL' && ['AVAILABLE', 'PENDING'].includes(status)) {
      const submitted = submitCompositeTargetSelection({
        rootDir: ROOT,
        effectMode: 'MONSTER_OPTIONAL',
        source: 'R3B_VISUAL_TRANSITION_BAMBOO_VISIBLE_AFTER_MONSTER_TARGET'
      });
      previous = submitted.state;
    }
    const chainMode = String(previous && previous.current && previous.current.chain && previous.current.chain.currentResolvingMode || '').toUpperCase();
    if (chainMode !== 'M19_SEARCH' || currentTargetMode(previous) !== 'M19_SEARCH') {
      const advanced = enterCompositeResolutionSelection({
        rootDir: ROOT,
        effectMode: 'M19_SEARCH',
        resolvedBefore: ['MONSTER_OPTIONAL'],
        source: 'R3B_VISUAL_TRANSITION_M19_BAMBOO_PROMPT_VISIBLE'
      });
      previous = advanced.state;
    }

    const observationId = new Date().toISOString();
    const events = [{
      kind: 'EFFECT_TARGET_SELECTION',
      mode: 'AVAILABLE',
      effectMode: 'M19_SEARCH',
      candidateCount: bambooProbe.candidateCount,
      allowedTargets: bambooProbe.allowedTargets,
      detector: bambooProbe.detector,
      activationKey: 'M19',
      activationName: '妖刀竹光检索对象选择',
      signature: `M19_TARGET_SELECTION|AVAILABLE|${bambooProbe.detector}`,
      observationId
    }];
    const updated = updateCompositeRouteState(previous, events, observationId);
    const summary = summarizeCompositeRouteState(updated.state);
    const result = {
      status: 'PASS',
      mode: 'M19_BAMBOO_TARGET_PROMPT_PASSIVE',
      appliedEvents: updated.applied,
      events,
      targetPromptProbe: bambooProbe,
      summary,
      state: updated.state,
      capturedAt: observationId
    };
    writeJson(STATE_PATH, updated.state);
    writeJson(RESULT_PATH, result);
    process.exitCode = 0;
  } finally {
    await bridge.stop();
  }
}

main().catch(error => {
  console.error(`妖刀检索对象窗口纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
