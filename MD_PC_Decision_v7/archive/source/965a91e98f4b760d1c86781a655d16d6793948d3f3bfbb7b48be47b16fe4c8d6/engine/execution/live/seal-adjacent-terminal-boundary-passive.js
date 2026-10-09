'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const DEBUG_DIR = path.join(ROOT, 'debug', 'duel-log-live', 'adjacent-terminal-boundary');
const DEBUG_RESULT_PATH = path.join(DEBUG_DIR, 'latest_result.json');

const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { readPng, savePng, cropImage } = require(path.join(ROOT, 'lib', 'png-utils'));
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
const { buildActivationBlocks, checkpointFrom } = require(path.join(ROOT, 'lib', 'duel-log-state'));
const { compactTailBlocks } = require(path.join(ROOT, 'lib', 'duel-log-tail-continuity'));
const { observeCompositeRoute } = require(path.join(ROOT, 'lib', 'composite-route-observer'));

function cliValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function cliBool(name, fallback = false) {
  const raw = String(cliValue(name, fallback ? '1' : '0')).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildAdjacentMaterialObserverState({
  previousState,
  operationBlocks,
  terminalKey,
  step,
  stageLabel,
  capturedAt = new Date().toISOString()
}) {
  const blocks = Array.isArray(operationBlocks) ? operationBlocks.filter(Boolean) : [];
  if (!blocks.length) throw new Error('ADJACENT_TERMINAL_BOUNDARY_NO_VISIBLE_OPERATION');

  let terminalIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (String(blocks[index] && blocks[index].activationKey || '') === String(terminalKey || '')) {
      terminalIndex = index;
      break;
    }
  }
  if (terminalIndex < 0) {
    throw new Error(
      `ADJACENT_TERMINAL_BOUNDARY_KEY_NOT_VISIBLE:${terminalKey || 'UNKNOWN'};` +
      `visible=${blocks.map(block => block.activationKey).join('>') || 'NONE'}`
    );
  }

  // Newer verified adjacent-stage mechanism: seal only the TERMINAL boundary
  // of the just-finished stage.  Do not carry the whole older history forward.
  // The next production observer will use the standard tailBlocks overlap path.
  const terminalBlock = blocks[terminalIndex];
  const terminalOnly = [terminalBlock];
  const checkpoint = checkpointFrom(terminalOnly);
  const tailBlocks = compactTailBlocks(terminalOnly, 6);
  if (!checkpoint || !tailBlocks.length) {
    throw new Error('ADJACENT_TERMINAL_BOUNDARY_BUILD_FAILED');
  }

  const nextState = {
    version: 1,
    capturedAt,
    checkpoint,
    tailBlocks,
    materialAdjacentStep: {
      step: Number(step || 0) || null,
      stageLabel: String(stageLabel || ''),
      terminalKey: String(terminalKey || '')
    },
    terminalBoundaryOnly: true,
    terminalBoundarySource: 'PASSIVE_VISIBLE_RIGHT_LOG_STANDARD_TAILBLOCKS',
    terminalBoundaryVisibleKeys: blocks.map(block => block.activationKey),
    terminalBoundaryOriginalIndex: terminalIndex
  };

  // Preserve only non-continuity metadata that is useful to the prepared hand
  // session.  Never retain an older checkpoint/tail/baseline here.
  if (previousState && Array.isArray(previousState.initialHand)) {
    nextState.initialHand = previousState.initialHand;
  }
  if (previousState && previousState.preparedCurrentState) {
    nextState.preparedCurrentState = true;
  }

  return { state: nextState, terminalBlock, terminalIndex };
}

async function recognizeCurrentVisibleRightLog(bridge, info, screenshot) {
  const phaseTemplate = await readPng(path.join(ROOT, 'templates', 'ui', 'duel_log_main1_phase.png'));
  const library = loadLibrary(ROOT);
  const loaded = await loadTemplates(ROOT, library);
  const labelTemplates = await loadDuelLogLabelTemplates(ROOT);
  const cardTemplates = loaded.map(item => ({ ...item.card, image: item.image }));

  const result = recognizeMain1Baseline(screenshot, phaseTemplate);
  if (result.status === 'OK') {
    result.events = recognizeCardEventsAfterMain1(screenshot, result, cardTemplates);
  } else if (result.status === 'MAIN1_NOT_FOUND') {
    result.status = 'OK_MAIN1_SCROLLED_OUT';
    result.events = recognizeVisibleCardEvents(screenshot, result.rightPanel, result.rightPanel.y, cardTemplates);
  } else {
    result.events = [];
  }

  if (result.status === 'OK' || result.status === 'OK_MAIN1_SCROLLED_OUT') {
    const panel = cropImage(screenshot, result.rightPanel);
    result.semanticLabels = recognizeDuelLogLabels(panel, labelTemplates);
    const semanticEvents = semanticEventsFromLabels(
      screenshot,
      result.rightPanel,
      result.semanticLabels,
      cardTemplates
    );
    result.events = mergeSemanticEvents(result.events, semanticEvents);
  }

  const grouped = buildActivationBlocks(result.events || []);
  return { result, grouped };
}

async function main() {
  const terminalKey = String(cliValue('terminal-key', 'M19')).toUpperCase();
  const step = Number(cliValue('step', '0')) || null;
  const stageLabel = String(cliValue('stage', 'ADJACENT_STAGE'));
  const syncCompositeLink = cliBool('sync-composite-link', false);

  console.log('\n===== STANDARD ADJACENT TERMINAL-BOUNDARY SEAL =====');
  console.log('采用新版已验证机制：当前阶段只封存 terminal boundary + 标准 tailBlocks；下一阶段直接走 production bottom-tail continuity。');
  console.log('本阶段只切回 Master Duel 并截图读取当前可见右栏；不点击、不滚轮、不读 INFO、不发 ESC。');

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
      x: 0,
      y: 0,
      width: 2048,
      height: 1152
    });
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const screenshotPath = path.join(DEBUG_DIR, 'latest_client.png');
    await savePng(screenshot, screenshotPath);

    const recognized = await recognizeCurrentVisibleRightLog(bridge, info, screenshot);
    const blocks = recognized.grouped.blocks || [];
    if (!['OK', 'OK_MAIN1_SCROLLED_OUT'].includes(recognized.result.status)) {
      throw new Error(`ADJACENT_TERMINAL_BOUNDARY_LOG_NOT_RECOGNIZED:${recognized.result.status}`);
    }

    let compositeSync = null;
    if (syncCompositeLink) {
      const linkBlocks = blocks.filter(block => (block && block.details || []).some(detail =>
        String(detail && (detail.rawType || detail.type) || '') === 'LINK_SUMMON'
      ));
      if (!linkBlocks.length) {
        throw new Error(`ADJACENT_COMPOSITE_LINK_SYNC_NO_LINK_BLOCK:visible=${blocks.map(block => block.activationKey).join('>') || 'NONE'}`);
      }
      // Passive semantic sync before the terminal-only continuity state is written.
      // Feed only the visible Link-bearing block(s) as newly extended evidence so
      // the composite sidecar records MATERIAL_EXIT + SUMMON_RESULT without
      // treating older unrelated history as new operations.
      compositeSync = observeCompositeRoute({
        capturedAt: new Date().toISOString(),
        operationBlocks: blocks,
        newOperationBlocks: [],
        extendedOperationBlocks: linkBlocks
      }, { rootDir: ROOT });
      console.log(
        `复合支线被动同步: Link块=${linkBlocks.map(block => block.activationKey).join('>')}; ` +
        `应用事件=${compositeSync.appliedEvents}; ` +
        `离场=${compositeSync.summary && compositeSync.summary.exit || 'NONE'}; ` +
        `新怪兽=${compositeSync.summary && compositeSync.summary.summon || 'NONE'}`
      );
    }

    const previousState = readJsonIfExists(LOG_STATE_PATH);
    const sealed = buildAdjacentMaterialObserverState({
      previousState,
      operationBlocks: blocks,
      terminalKey,
      step,
      stageLabel
    });
    writeJson(LOG_STATE_PATH, sealed.state);

    const debugResult = {
      status: 'PASS',
      mode: 'STANDARD_ADJACENT_TERMINAL_BOUNDARY',
      terminalKey,
      step,
      stageLabel,
      visibleOperationKeys: blocks.map(block => block.activationKey),
      sealedCheckpoint: sealed.state.checkpoint,
      sealedTailBlocks: sealed.state.tailBlocks,
      observerStatePath: LOG_STATE_PATH,
      screenshot: screenshotPath,
      compositeSync: compositeSync ? {
        appliedEvents: compositeSync.appliedEvents,
        summary: compositeSync.summary
      } : null,
      capturedAt: sealed.state.capturedAt
    };
    writeJson(DEBUG_RESULT_PATH, debugResult);

    console.log(
      `相邻阶段已封存: #${step || '?'} ${stageLabel}; ` +
      `terminal=${terminalKey}; visible=${debugResult.visibleOperationKeys.join('>') || '无'}。`
    );
    console.log(
      `标准 tailBlocks=${sealed.state.tailBlocks.map(block => block.activationKey).join('>')}; ` +
      '旧历史未带入下一阶段。'
    );
    console.log('下一次正式 observer 应直接看到“底部尾部连续性已确认 ... 无需上滑”。');
  } finally {
    await bridge.stop();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { buildAdjacentMaterialObserverState };
