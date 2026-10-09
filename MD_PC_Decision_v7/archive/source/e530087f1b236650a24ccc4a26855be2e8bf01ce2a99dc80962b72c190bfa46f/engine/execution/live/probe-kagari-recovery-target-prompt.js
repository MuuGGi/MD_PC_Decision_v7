'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'kagari-recovery-target-prompt');
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

function readCard(cardId) {
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'card-library.json'), 'utf8'));
  const card = (db.cards || []).find(row => row && String(row.id || '') === String(cardId));
  return card ? { id: card.id, name: card.name, count: Number(card.count || 0) } : { id: cardId, name: cardId, count: 0 };
}

async function main() {
  console.log('\n===== KAGARI RECOVERY TARGET PASSIVE PROBE =====');
  console.log('本阶段只截图检测闪刀姬－篝发动时的墓地回收对象选择窗口；不会点击候选、不会确认、不会发 ESC/INFO/滚轮。');
  console.log('本 R4 路线保证大黄蜂[M22]刚刚因发动进入墓地，因此 M22 是本次至少一个合法回收对象。');

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

    const rawProbe = await probeSkyStrikerSearchTargetPrompt({
      bridge,
      info,
      debugDir: DEBUG_DIR,
      suffix: new Date().toISOString().replace(/[:.]/g, '-')
    });
    const guaranteedTarget = readCard('M22');
    const probe = {
      ...rawProbe,
      allowedTargets: [guaranteedTarget],
      detector: 'KAGARI_RECOVERY_TARGET_PROMPT_PASSIVE_V1',
      targetZone: 'GRAVEYARD',
      guaranteedByRoute: ['M22']
    };

    console.log(
      `篝回收对象窗口: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `headerDark=${probe.headerDark.toFixed(3)}; bodyDark=${probe.bodyDark.toFixed(3)}; ` +
      `candidates=${probe.candidateCount}`
    );
    console.log(`本路线保证合法回收对象: ${guaranteedTarget.name}[${guaranteedTarget.id}]`);
    if (probe.candidateCenters.length) {
      console.log(`实时物理候选中心: ${probe.candidateCenters.map(p => `(${p.x},${p.y})`).join(', ')}`);
    }

    const previous = readJsonIfExists(STATE_PATH) || initialState();
    const observationId = new Date().toISOString();
    const events = probe.visible ? [{
      kind: 'EFFECT_TARGET_SELECTION',
      mode: 'AVAILABLE',
      effectMode: 'MONSTER_OPTIONAL',
      selectionTiming: 'CHAIN_ACTIVATION',
      candidateCount: probe.candidateCount,
      allowedTargets: probe.allowedTargets,
      detector: probe.detector,
      activationKey: 'E02',
      activationName: '闪刀姬－篝发动时回收对象选择',
      signature: `KAGARI_RECOVERY_TARGET_SELECTION|AVAILABLE|${probe.detector}`,
      observationId
    }] : [];
    const updated = updateCompositeRouteState(previous, events, observationId);
    const summary = summarizeCompositeRouteState(updated.state);
    const result = {
      status: probe.visible ? 'PASS' : 'NOT_CONFIRMED',
      mode: 'KAGARI_RECOVERY_TARGET_PROMPT_PASSIVE',
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
  console.error(`篝回收对象窗口纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
