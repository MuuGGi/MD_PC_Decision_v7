'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const config = require(path.join(ROOT, 'live-config'));
const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { readPng, cropImage } = require(path.join(ROOT, 'lib', 'png-utils'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const {
  loadDuelLogLabelTemplates,
  recognizeDuelLogLabels
} = require(path.join(ROOT, 'lib', 'duel-log-label-reader'));
const {
  recognizeMain1Baseline,
  recognizeCardEventsAfterMain1,
  recognizeVisibleCardEvents,
  semanticEventsFromLabels,
  mergeSemanticEvents
} = require(path.join(ROOT, 'lib', 'duel-log-reader'));
const {
  buildActivationBlocks,
  annotateBlockRelationships,
  normalizeInterposedKagariBambooResults,
  checkpointFrom
} = require(path.join(ROOT, 'lib', 'duel-log-state'));
const { compactTailBlocks } = require(path.join(ROOT, 'lib', 'duel-log-tail-continuity'));

const OBSERVER_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const DEBUG_DIR = path.join(ROOT, 'debug', 'duel-log-live', 'adjacent-checkpoint');

const args = process.argv.slice(2);
function argValue(prefix, fallback = null) {
  const raw = args.find(arg => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}
const step = Number(argValue('--step=', '0')) || 0;
const stageLabel = String(argValue('--stage=', 'ADJACENT_STAGE') || 'ADJACENT_STAGE');
const preferLastKey = String(argValue('--prefer-last-key=', '') || '').trim();


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log('\n===== PASSIVE ADJACENT LOG CHECKPOINT =====');
  console.log('只切回 Master Duel 并截图读取当前可见右栏；不点击游戏、不读 INFO、不发 ESC、不滚轮。');
  console.log('用途：把当前复合阶段的“相邻上一步”写成 checkpoint，后续正式 observer 禁止再向上追更早历史。');

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    await bridge.activateMasterDuel();
    await sleep(300);
    const info = await bridge.info();
    const title = String(info && info.title || '').toLowerCase();
    if (!title.includes('masterduel') && !title.includes('master duel')) {
      throw new Error(`MASTER_DUEL_WINDOW_NOT_FOUND_AFTER_ACTIVATE:${info && info.title || 'UNKNOWN'}`);
    }

    const screenshot = await captureReferenceRoi(bridge, info, {
      x: 0, y: 0, width: config.screen.width, height: config.screen.height
    });

    const phaseTemplate = await readPng(path.join(ROOT, 'templates', 'ui', 'duel_log_main1_phase.png'));
    const library = loadLibrary(ROOT);
    const loaded = await loadTemplates(ROOT, library);
    const labelTemplates = await loadDuelLogLabelTemplates(ROOT);
    const cardTemplates = loaded.map(item => ({ ...item.card, image: item.image }));

    const recognized = recognizeMain1Baseline(screenshot, phaseTemplate);
    if (recognized.status === 'OK') {
      recognized.events = recognizeCardEventsAfterMain1(screenshot, recognized, cardTemplates);
    } else if (recognized.status === 'MAIN1_NOT_FOUND') {
      recognized.status = 'OK_MAIN1_SCROLLED_OUT';
      recognized.events = recognizeVisibleCardEvents(
        screenshot,
        recognized.rightPanel,
        recognized.rightPanel.y,
        cardTemplates
      );
    } else {
      recognized.events = [];
    }

    if (recognized.status === 'OK' || recognized.status === 'OK_MAIN1_SCROLLED_OUT') {
      const panel = cropImage(screenshot, recognized.rightPanel);
      recognized.semanticLabels = recognizeDuelLogLabels(panel, labelTemplates);
      const semanticEvents = semanticEventsFromLabels(
        screenshot,
        recognized.rightPanel,
        recognized.semanticLabels,
        cardTemplates
      );
      recognized.events = mergeSemanticEvents(recognized.events, semanticEvents);
    }

    const grouped = buildActivationBlocks(recognized.events || []);
    const blocks = annotateBlockRelationships(
      normalizeInterposedKagariBambooResults(grouped.blocks || [])
    );
    if (!blocks.length) {
      throw new Error('PASSIVE_ADJACENT_NO_VISIBLE_OPERATION_BLOCKS');
    }

    let cutIndex = blocks.length - 1;
    if (preferLastKey) {
      let found = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i] && blocks[i].activationKey === preferLastKey) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        throw new Error(
          `PASSIVE_ADJACENT_PREFERRED_KEY_NOT_VISIBLE:${preferLastKey};visible=${blocks.map(block => block.activationKey).join('>') || 'NONE'}`
        );
      }
      cutIndex = found;
    }

    // Deliberately cut the visible log at the chosen adjacent predecessor.
    // Example for R3B final verification: current viewport may already show
    // M06 > M19 > E10. We save only through the LAST M19 grave-effect header,
    // leaving E10 to be recognized as the immediate NEW block by the formal
    // observer. This is the same “only confirm adjacent previous stage” policy
    // used by the mature Bamboo material capture flow; it does not chase the
    // older M19 equip activation farther up the history.
    const adjacentBlocks = blocks.slice(0, cutIndex + 1);
    const checkpoint = checkpointFrom(adjacentBlocks);
    if (!checkpoint) throw new Error('PASSIVE_ADJACENT_CHECKPOINT_EMPTY');

    const capturedAt = new Date().toISOString();
    const previous = readJsonIfExists(OBSERVER_STATE_PATH);
    const state = {
      version: 1,
      capturedAt,
      checkpoint,
      tailBlocks: compactTailBlocks(adjacentBlocks, 6),
      materialAdjacentStep: {
        step,
        stageLabel,
        source: 'PASSIVE_VISIBLE_RIGHT_LOG_CUT',
        capturedAt,
        preferredLastKey: preferLastKey || null,
        visibleOperationKeys: blocks.map(block => block.activationKey),
        acceptedOperationKeys: adjacentBlocks.map(block => block.activationKey),
        deferredVisibleOperationKeys: blocks.slice(cutIndex + 1).map(block => block.activationKey),
        previousCheckpointKey: previous && previous.checkpoint && previous.checkpoint.activationKey || null
      }
    };
    writeJson(OBSERVER_STATE_PATH, state);

    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    writeJson(path.join(DEBUG_DIR, 'latest_result.json'), {
      status: 'PASS',
      capturedAt,
      step,
      stageLabel,
      preferredLastKey: preferLastKey || null,
      visibleOperationKeys: blocks.map(block => block.activationKey),
      acceptedOperationKeys: adjacentBlocks.map(block => block.activationKey),
      deferredVisibleOperationKeys: blocks.slice(cutIndex + 1).map(block => block.activationKey),
      checkpoint,
      observerStatePath: OBSERVER_STATE_PATH
    });

    console.log(
      `素材相邻检查点 #${step || '?'}: ${stageLabel}; ` +
      `checkpoint=${checkpoint.activationKey}; ` +
      `当前可见=${blocks.map(block => block.activationKey).join('>')}; ` +
      `本轮接受到=${adjacentBlocks.map(block => block.activationKey).join('>')}`
    );
    if (blocks.length > adjacentBlocks.length) {
      console.log(
        `相邻新增保留给正式 observer: ${blocks.slice(cutIndex + 1).map(block => block.activationKey).join('>')}; ` +
        '不会把这些块提前吞进 checkpoint。'
      );
    }
    console.log('下一次 test-duel-log-live 只允许底部/相邻连续性；若当前底部不能证明该 checkpoint，将直接失败，不会向上滚动追旧历史。');
  } finally {
    await bridge.stop();
  }
}

main().catch(error => {
  console.error(`相邻右栏检查点纯观察失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
