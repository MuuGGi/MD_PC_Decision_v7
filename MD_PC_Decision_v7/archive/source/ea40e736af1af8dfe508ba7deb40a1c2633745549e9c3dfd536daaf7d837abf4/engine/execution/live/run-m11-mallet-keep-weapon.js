'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeJsonAtomic, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const card = require(path.join(ROOT, 'execution', 'cards', 'm11-magical-mallet'));
const config = require(path.join(ROOT, 'live-config'));
const {
  MdFastBridge,
  captureReferenceRoi,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { loadLibrary, loadTemplates } = require(path.join(ROOT, 'lib', 'recognizer'));
const {
  isExodiaComponentId,
  isExodiaComponentCard,
  normalizeExodiaComponentCard,
  countRuntimeCardIds,
  canonicalRuntimeCardId
} = require(path.join(ROOT, 'lib', 'exodia-policy'));
const { runLiveScan } = require(path.join(ROOT, 'runtime', 'observer', 'test-scan-state-live'));
const { runDenseHandScan } = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));
const { saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const {
  validateMalletActivationStage,
  validateMalletFullRescan
} = require(path.join(ROOT, 'lib', 'mallet-material-flow'));
const {
  selectMalletReturnCards,
  confirmMalletSelection,
  probeMalletSelectionPrompt
} = require(path.join(ROOT, 'execution', 'core', 'm11-mallet-selection'));
const { MALLET_RESUME_STATUSES, committedSelectionState, completeMalletSelection } = require(
  path.join(ROOT, 'execution', 'core', 'm11-mallet-completion')
);
const {
  loadMalletEvidenceTemplates,
  analyzeMalletResolutionEvidence
} = require(path.join(ROOT, 'execution', 'core', 'm11-mallet-resolution-evidence'));
const { establishCurrentObserverBaseline } = require(path.join(
  ROOT, 'execution', 'core', 'observer-current-baseline'
));
const { selectObservedHandCard } = require(path.join(
  ROOT, 'execution', 'core', 'hand-target'
));
const { clickSelectedHandSpellActivation } = require(path.join(
  ROOT, 'execution', 'core', 'hand-spell-activation'
));
const { markExecutionPass } = require(path.join(
  ROOT, 'execution', 'core', 'verified-status'
));

// PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_M11
const { reconcileMalletFullResync } = require(path.join(ROOT, 'lib', 'main-deck-ledger'));
const CARD_ID = card.id;
const CARD_NAME = card.name;

const PREPARED_DIR = path.join(ROOT, 'debug', 'scan-state-live', 'prepared');
const PREPARED_RESULT = path.join(PREPARED_DIR, 'result.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const LOG_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const LOG_RESULT_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const RESUME_DIR = path.join(ROOT, 'debug', 'execution', 'M11_mallet_keep_weapon', '_resume');
const RESUME_STATE_PATH = path.join(RESUME_DIR, 'resume_state.json');
const ATTEMPT_ROOT = path.join(ROOT, 'debug', 'execution', 'M11_mallet_keep_weapon');
const RESUME_MAX_AGE_MS = 20 * 60 * 1000;
const FULL_CLIENT_ROI = { x: 0, y: 0, width: config.screen.width, height: config.screen.height };
const M11_RIGHT_PANEL_ROI = { x: 1650, y: 95, width: 380, height: 970 };
const DEFAULT_KEEP_IDS = card.keepIds.slice();


function assertSupportedNode() {
  const major = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(
      `NODE_VERSION_TOO_OLD:${process.versions.node || 'UNKNOWN'}; ` +
      '需要 Node >= 20。此检查发生在任何 Master Duel 点击之前。'
    );
  }
  console.log(`Node运行时: v${process.versions.node} PASS`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseKeepIds(argv) {
  const token = argv.find(arg => String(arg).startsWith('--keep='));
  const raw = token ? token.slice('--keep='.length) : DEFAULT_KEEP_IDS.join(',');
  const ids = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set(ids));
}

function cardName(library, id) {
  const found = (library.cards || []).find(card => card.id === id);
  return found ? found.name : id;
}

function denseTargetEvidence(denseOut, targetId) {
  const result = denseOut && denseOut.result;
  const sweep = result && Array.isArray(result.sweeps) ? result.sweeps[0] : null;
  const windows = sweep && Array.isArray(sweep.windows) ? sweep.windows : [];
  const stitched = sweep && sweep.stitched;
  const stitchedCards = stitched && Array.isArray(stitched.cards) ? stitched.cards : [];
  const handCount = Number(denseOut && denseOut.scan && denseOut.scan.handCount);
  if (!Number.isInteger(handCount) || !stitchedCards.length) return null;

  // 有多张M11时固定使用完整全局序列中最左侧那张。
  // 把该全局槽位映射回刚才真实识别过它的DENSE窗口/ordinal，
  // 禁止再做第二套slot->x推导。
  const targetGlobalSlot = stitchedCards.findIndex(card => card && card.id === targetId) + 1;
  if (targetGlobalSlot <= 0) return null;

  const windowIds = handCount <= 10
    ? ['LEFT_EDGE', 'RIGHT_EDGE']
    : ['LEFT_EDGE', 'MIDDLE', 'RIGHT_EDGE'];
  const hits = [];

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i] || {};
    const windowId = windowIds[i] || `WINDOW_${i + 1}`;
    const strategy = window.strategy ||
      (windowId === 'LEFT_EDGE' ? 'left' : windowId === 'RIGHT_EDGE' ? 'right' : 'center');

    let globalStartSlot = null;
    if (handCount <= 10) {
      globalStartSlot = i === 0
        ? 1
        : handCount - (Array.isArray(window.cards) ? window.cards.length : 0) + 1;
    } else if (i === 0) {
      globalStartSlot = 1;
    } else if (i === windows.length - 1) {
      globalStartSlot = handCount - (Array.isArray(window.cards) ? window.cards.length : 0) + 1;
    }

    for (const row of window.recognitions || []) {
      const rec = row && row.recognition;
      if (!rec || rec.accepted !== true || rec.id !== targetId) continue;
      const ordinal = Number(row.ordinal);
      if (!Number.isInteger(ordinal)) continue;
      const globalSlot = Number.isInteger(globalStartSlot)
        ? globalStartSlot + ordinal - 1
        : null;
      if (globalSlot !== targetGlobalSlot) continue;
      hits.push({
        windowId,
        strategy,
        ordinal,
        globalSlot,
        clickReference: row.clickReference || null,
        recognized: { id: rec.id, name: rec.name },
        windowIndex: i
      });
    }
  }

  if (!hits.length) return null;
  // 双窗扫描最后停在右侧锚定窗口；重叠区同一张牌优先复用当前窗口。
  hits.sort((a, b) => b.windowIndex - a.windowIndex);
  return hits[0];
}

function densePreparedResult(denseOut, handCount, targetEvidence = null) {
  const scan = denseOut && denseOut.scan;
  if (!scan || scan.status !== 'PASS' || scan.handCount !== handCount ||
      !Array.isArray(scan.cards) || scan.cards.length !== handCount) {
    throw new Error(
      `EXEC_BASELINE_DENSE_INVALID:${scan && scan.status}/${scan && scan.handCount}/` +
      `${scan && scan.cards && scan.cards.length}`
    );
  }
  return {
    status: 'PASS',
    expectedOwn: handCount,
    handCount,
    layoutMode: scan.layoutMode || 'DENSE_HAND_SEGMENTED_SCROLL',
    slotsScanned: scan.cards.length,
    cards: scan.cards.map((card, index) => ({
      ...card,
      index: index + 1,
      accepted: card.accepted !== false
    })),
    denseHandBaseline: true,
    denseConfidence: scan.confidence || null,
    denseExecutionReference: targetEvidence,
    source: scan.source || denseOut.resultPath || null
  };
}

function normalizeCurrentCard(result) {
  const judged = result && result.judged;
  const best = judged && judged.best;
  return {
    accepted: Boolean(judged && judged.accepted && best),
    id: best ? best.id : 'UNKNOWN',
    name: best ? best.name : 'UNKNOWN',
    mad: best && best.mad != null ? best.mad : null
  };
}

async function selectMalletFromMeasuredBaseline({
  bridge,
  info,
  library,
  templates,
  baseline,
  malletSlot,
  debugDir
}) {
  const selected = await selectObservedHandCard({
    bridge,
    info,
    library,
    templates,
    baseline,
    expectedId: CARD_ID,
    debugDir: path.join(debugDir, 'm11_observed_hand_target')
  });
  if (!selected || selected.slot !== malletSlot || !selected.selected || selected.selected.id !== CARD_ID) {
    throw new Error(
      `M11_OBSERVER_TARGET_WITNESS_INVALID:${selected && selected.slot}/${malletSlot};` +
      `${selected && selected.selected && selected.selected.id || 'NONE'}`
    );
  }
  return selected;
}
async function establishCurrentStateBaseline(bridge, info, outputDir = null) {
  return establishCurrentObserverBaseline({
    bridge,
    info,
    outputDir: outputDir || path.join(ATTEMPT_ROOT, '_observer_baseline')
  });
}


function findMalletSlot(result) {
  const matches = (result.cards || []).filter(card => card && card.id === CARD_ID);
  if (!matches.length) throw new Error(`EXEC_TARGET_NOT_IN_CURRENT_HAND:${CARD_NAME}[${CARD_ID}]`);
  const chosen = matches[0];
  const slot = Number(chosen.index) || result.cards.indexOf(chosen) + 1;
  console.log(
    `执行目标: ${CARD_NAME}[${CARD_ID}] @手牌${slot}` +
    (matches.length > 1 ? `（当前共${matches.length}张，先使用最左侧这一张）` : '')
  );
  return slot;
}

function buildRemainingPlan(baseline, malletSlot, keepIds) {
  const keepSet = new Set(keepIds.map(canonicalRuntimeCardId));
  const remainingCards = [];
  for (let i = 0; i < baseline.cards.length; i++) {
    if (i + 1 === malletSlot) continue;
    remainingCards.push({
      ...baseline.cards[i],
      originalSlot: i + 1,
      promptSlot: remainingCards.length + 1
    });
  }

  const kept = remainingCards.filter(card => keepSet.has(canonicalRuntimeCardId(card)));
  if (keepIds.length > 0) {
    const missing = keepIds.filter(id => !kept.some(card => canonicalRuntimeCardId(card) === canonicalRuntimeCardId(id)));
    if (missing.length) {
      throw new Error(
        `M11_KEEP_TARGET_NOT_IN_HAND:${missing.join(',')}; ` +
        `当前手牌=${baseline.cards.map(card => card.id).join('>')}`
      );
    }
  }

  const returned = remainingCards.filter(card => !keepSet.has(canonicalRuntimeCardId(card)));
  if (!returned.length) {
    throw new Error('M11_NO_NON_PROTECTED_CARD_TO_RETURN');
  }

  return {
    remainingCards,
    kept,
    returned
  };
}

function countIds(cards) {
  return countRuntimeCardIds(cards);
}

function verifyProtectedStillPresent(beforeCards, afterCards, keepIds) {
  const before = countIds(beforeCards);
  const after = countIds(afterCards);
  const exodiaBefore = (beforeCards || []).filter(isExodiaComponentCard).length;
  const exodiaAfter = (afterCards || []).filter(isExodiaComponentCard).length;
  const rows = [];
  for (const id of keepIds) {
    if (isExodiaComponentId(id)) {
      if (exodiaAfter < exodiaBefore) {
        throw new Error(`M11_PROTECTED_EXODIA_COUNT_DROPPED:${exodiaBefore}->${exodiaAfter}`);
      }
      rows.push({ id: 'EXODIA_COMPONENT_CLASS', before: exodiaBefore, after: exodiaAfter });
      continue;
    }
    const b = before.get(id) || 0;
    const a = after.get(id) || 0;
    if (b > 0 && a < b) {
      throw new Error(`M11_PROTECTED_CARD_COUNT_DROPPED:${id}:${b}->${a}`);
    }
    rows.push({ id, before: b, after: a });
  }
  return rows;
}

function normalizeMalletFinalExodia(scan) {
  return {
    ...scan,
    cards: (scan.cards || []).map((card, index) => ({
      ...(isExodiaComponentCard(card) ? normalizeExodiaComponentCard(card) : card),
      index: index + 1
    }))
  };
}

function malletResolutionStableWaitMs(expectedDrawCount) {
  const count = Math.max(1, Number(expectedDrawCount) || 1);
  // The shuffle/redraw animation grows with the submitted set.  Wait through
  // its stable part before opening the log; repeated early screenshots only
  // capture the card-detail overlay and cannot make the animation finish.
  return Math.min(7000, 1800 + count * 450);
}

async function observeMalletResolutionTail({
  bridge,
  info,
  templates,
  expectedDrawCount,
  debugDir,
  maxAttempts = 8,
  retryWaitMs = 700,
  throwOnNotReady = true
}) {
  console.log(
    '万宝槌结算准备：使用成熟右栏模块确认/打开日志面板并回到当前底部；' +
    '不读取关闭面板后的空右侧游戏画面。'
  );
  await runDuelLogLive({
    bridge,
    skipActivation: true,
    skipForegroundReactivate: true,
    verbose: false,
    observerFast: true,
    rebaselineCurrentBottom: true,
    allowBacktrack: false
  });

  const evidenceTemplates = await loadMalletEvidenceTemplates(ROOT);
  let lastEvidence = null;

  console.log('\n===== 万宝槌结算右栏观察 =====');
  console.log(
    `本轮实际返回=${expectedDrawCount}张；右栏已由成熟模块打开并定位当前底部，` +
    '现在只读取“返回 + 抽卡”尾部，不按i、不点手牌。'
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const frame = await captureReferenceRoi(bridge, info, FULL_CLIENT_ROI);
    const imagePath = path.join(
      debugDir,
      `m11_resolution_observe_${String(attempt).padStart(2, '0')}.png`
    );
    await saveRgbaPng(frame, imagePath);

    const evidence = analyzeMalletResolutionEvidence(
      frame,
      M11_RIGHT_PANEL_ROI,
      evidenceTemplates,
      templates,
      { expectedDrawCount }
    );
    lastEvidence = evidence;
    writeJson(
      path.join(debugDir, `m11_resolution_observe_${String(attempt).padStart(2, '0')}.json`),
      evidence
    );

    const returnPass = evidence.returnBeforePrimaryDrawCount > 0;
    const drawLabelPass = evidence.drawLabelCount > 0;
    const drawCountPass = evidence.drawResultCount === expectedDrawCount;
    console.log(
      `结算观察${attempt}: 返回=${returnPass ? 'PASS' : 'WAIT'} ` +
      `(${evidence.returnBeforePrimaryDrawCount}); ` +
      `抽卡=${drawLabelPass ? 'PASS' : 'WAIT'}; ` +
      `DRAW数量=${evidence.drawResultCount}/${expectedDrawCount}`
    );

    if (returnPass && drawLabelPass && drawCountPass) {
      if (evidence.primaryDraw) {
        const observed = (evidence.primaryDraw.rowObservedCounts || []).join('+') || '0';
        const inferred = (evidence.primaryDraw.rowInferredCounts || []).join('+') || '0';
        console.log(`万宝槌结算右栏确认: PASS; DRAW布局=${observed} -> ${inferred}`);
      } else {
        console.log('万宝槌结算右栏确认: PASS');
      }
      return {
        status: 'PASS',
        expectedDrawCount,
        returnBeforePrimaryDrawCount: evidence.returnBeforePrimaryDrawCount,
        drawLabelCount: evidence.drawLabelCount,
        drawResultCount: evidence.drawResultCount,
        evidence
      };
    }

    if (attempt < maxAttempts) await sleep(retryWaitMs);
  }

  const notReady = {
    status: 'NOT_READY',
    expectedDrawCount,
    returnBeforePrimaryDrawCount: lastEvidence && lastEvidence.returnBeforePrimaryDrawCount || 0,
    drawLabelCount: lastEvidence && lastEvidence.drawLabelCount || 0,
    drawResultCount: lastEvidence && lastEvidence.drawResultCount || 0,
    evidence: lastEvidence
  };
  if (!throwOnNotReady) return notReady;

  throw new Error(
    `M11_RESOLUTION_TAIL_NOT_READY:` +
    `return=${notReady.returnBeforePrimaryDrawCount};` +
    `drawLabel=${notReady.drawLabelCount};` +
    `drawCount=${notReady.drawResultCount}/${expectedDrawCount}`
  );
}

function persistFinalHand(scan, attemptDir) {
  writeJsonAtomic(HAND_STATE_PATH, {
    version: 1,
    capturedAt: new Date().toISOString(),
    revision: 0,
    handCount: scan.handCount,
    cards: scan.cards,
    handImagePath: scan.handImagePath || path.join(PREPARED_DIR, 'hand_detect.png'),
    fullResync: true,
    source: path.join(attemptDir, 'final_full_resync.json')
  }, { trailingNewline: true });
}


function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function sameStringArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, index) => value === b[index]);
}

function handFingerprint(baseline) {
  return (baseline && Array.isArray(baseline.cards))
    ? baseline.cards.map(card => card && card.id || 'UNKNOWN').join('>')
    : '';
}

function stateIsRecent(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs <= RESUME_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

function latestAttemptDir() {
  if (!fs.existsSync(ATTEMPT_ROOT)) return null;
  const rows = fs.readdirSync(ATTEMPT_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const full = path.join(ATTEMPT_ROOT, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.length ? rows[0].full : null;
}

function countContiguousCompletedSelectSteps(attemptDir) {
  if (!attemptDir || !fs.existsSync(attemptDir)) return 0;
  const done = new Set();
  for (const name of fs.readdirSync(attemptDir)) {
    const m = /^m11_step_(\d+)_after_select\.png$/i.exec(name);
    if (m) done.add(Number(m[1]));
  }
  let count = 0;
  while (done.has(count + 1)) count += 1;
  return count;
}

function readRecentResumeState(keepIds) {
  if (!fs.existsSync(RESUME_STATE_PATH) || !stateIsRecent(RESUME_STATE_PATH)) return null;
  try {
    const state = readJson(RESUME_STATE_PATH);
    if (!state || state.version !== 2) return null;
    if (!sameStringArray(state.keepIds || [], keepIds)) return null;
    if (!state.baseline || !Array.isArray(state.baseline.cards)) return null;
    if (!state.plan || !Array.isArray(state.plan.remainingCards)) return null;
    if (!MALLET_RESUME_STATUSES.includes(state.status)) return null;
    return state;
  } catch (_) {
    return null;
  }
}

function readForcedCurrentSelectionState(keepIds) {
  if (!fs.existsSync(RESUME_STATE_PATH)) {
    throw new Error('M11_FORCED_RESUME_STATE_NOT_FOUND');
  }

  const state = readJson(RESUME_STATE_PATH);
  if (!state || state.version !== 2) {
    throw new Error(`M11_FORCED_RESUME_STATE_VERSION_INVALID:${state && state.version}`);
  }
  if (!sameStringArray(state.keepIds || [], keepIds)) {
    throw new Error(
      `M11_FORCED_RESUME_KEEP_MISMATCH:` +
      `saved=${(state.keepIds || []).join(',')};requested=${(keepIds || []).join(',')}`
    );
  }
  if (!state.baseline || !Array.isArray(state.baseline.cards) ||
      !state.plan || !Array.isArray(state.plan.remainingCards)) {
    throw new Error('M11_FORCED_RESUME_STATE_STRUCTURE_INVALID');
  }
  if (!MALLET_RESUME_STATUSES.includes(state.status)) {
    throw new Error(`M11_FORCED_RESUME_STATUS_INVALID:${state.status || 'NONE'}`);
  }

  // This explicit recovery mode intentionally ignores checkpoint age.  Safety
  // comes from verifyResumePrompt() proving the live M11 modal before any input.
  // It must never fall through to the fresh hand-activation path.
  return state;
}

function validateCurrentActivationLog() {
  if (!fs.existsSync(LOG_RESULT_PATH)) return null;
  try {
    return validateMalletActivationStage(readJson(LOG_RESULT_PATH));
  } catch (_) {
    return null;
  }
}

function bootstrapResumeFromCurrentArtifacts(keepIds) {
  // Compatibility bridge for the user's CURRENT failed run, which was made
  // before resume_state.json existed.  The selection helper already saved one
  // m11_step_N_after_select.png after every truly successful "选择" click.
  // Therefore the contiguous count is a safe commit count; a failed next-card
  // click has no after_select image and is never treated as committed.
  if (!fs.existsSync(PREPARED_RESULT)) return null;
  const activationProof = validateCurrentActivationLog();
  if (!activationProof) return null;

  let baseline;
  try { baseline = readJson(PREPARED_RESULT); } catch (_) { return null; }
  if (!baseline || baseline.status !== 'PASS' ||
      !Array.isArray(baseline.cards) || baseline.cards.length !== baseline.handCount) {
    return null;
  }

  const malletMatch = baseline.cards.find(card => card && card.id === CARD_ID);
  if (!malletMatch) return null;
  const malletSlot = Number(malletMatch.index) || baseline.cards.indexOf(malletMatch) + 1;
  let plan;
  try { plan = buildRemainingPlan(baseline, malletSlot, keepIds); } catch (_) { return null; }

  const attemptDir = latestAttemptDir();
  if (!attemptDir || !stateIsRecent(attemptDir)) return null;
  const completedSteps = countContiguousCompletedSelectSteps(attemptDir);
  if (completedSteps < 0 || completedSteps > plan.returned.length) return null;

  // Do not auto-bootstrap a stale activated M11 if there is zero evidence that
  // this exact attempt entered the return selector.
  const hasPromptEvidence = fs.existsSync(path.join(attemptDir, 'm11_step_01_before.png')) ||
    fs.existsSync(path.join(attemptDir, 'm11_step_01_select_button.png')) ||
    fs.existsSync(path.join(attemptDir, 'm11_step_01_after_select.png'));
  if (!hasPromptEvidence) return null;

  const committedIds = plan.returned.slice(0, completedSteps).map(card => card.id);
  return {
    version: 2,
    status: 'SELECTION_ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'AUTO_BOOTSTRAP_FROM_AFTER_SELECT_ARTIFACTS',
    baselineFingerprint: handFingerprint(baseline),
    baseline,
    malletSlot,
    keepIds,
    plan,
    attemptDir,
    activationProof,
    actionProof: null,
    committedIds
  };
}

function persistResumeState(state) {
  writeJsonAtomic(RESUME_STATE_PATH, {
    ...state,
    updatedAt: new Date().toISOString()
  }, { trailingNewline: true });
}

async function verifyResumePrompt(bridge, info, state) {
  const activationProof = validateCurrentActivationLog();
  if (!activationProof) {
    throw new Error('M11_RESUME_ACTIVATION_LOG_NOT_VALID');
  }
  const prompt = await probeMalletSelectionPrompt({
    bridge,
    info,
    debugDir: state.attemptDir,
    label: 'm11_resume_current_prompt_probe'
  });
  if (!prompt.likelyVisible) {
    throw new Error(
      `M11_RESUME_PROMPT_NOT_VISIBLE:candidates=${prompt.componentCandidateCount}/` +
      `${prompt.centeredCandidateCount};action=${prompt.action && prompt.action.mode}`
    );
  }
  return { activationProof, prompt };
}

function makeFreshResumeState({ baseline, malletSlot, keepIds, plan, attemptDir, activationProof, actionProof }) {
  return {
    version: 2,
    status: 'SELECTION_ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'LIVE_M11_EXECUTION',
    baselineFingerprint: handFingerprint(baseline),
    baseline,
    malletSlot,
    keepIds,
    plan,
    attemptDir,
    activationProof,
    actionProof,
    committedIds: []
  };
}

async function finishSubmittedMalletSelection({ checkpoint, bridge, info, templates, attemptDir }) {
  console.log('万宝槌返回集合已全部提交：先验收当前返回+抽卡尾；不重选、不重新发动。');
  return completeMalletSelection({ checkpoint,
    waitStable: count => sleep(malletResolutionStableWaitMs(count)),
    observeResolution: options => observeMalletResolutionTail({ bridge, info, templates,
      debugDir: attemptDir, ...options }),
    probePrompt: () => probeMalletSelectionPrompt({ bridge, info, debugDir: attemptDir,
      label: 'm11_completion_modal_probe' }),
    confirmSelection: () => confirmMalletSelection({ bridge, info, debugDir: attemptDir }),
    persistCheckpoint: persistResumeState
  });
}

async function main() {
  assertSupportedNode();

  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const forceResumeCurrentSelection = argv.includes('--resume-current-selection');
  const keepIds = parseKeepIds(argv);
  const library = loadLibrary(ROOT);
  const templates = await loadTemplates(ROOT, library);
  const keepLabel = keepIds.length
    ? keepIds.map(id => `${cardName(library, id)}[${id}]`).join(' / ')
    : '无（除万宝槌自身外全部返回）';

  console.log('\n============================================================');
  console.log('M11执行测试：万宝槌自动选择返回牌');
  console.log(`本轮指定“不返回牌组”: ${keepLabel}`);
  console.log('规则：万宝槌自身发动后，除保护名单外，其余剩余手牌全部选择返回牌组。');
  console.log(`本轮保护规则: ${keepLabel}；脚本不会预置当前手牌数量、顺序或其他卡名，全部以本次实时扫描为准。`);
  console.log('V5会显式传入动态 --keep=...；空 --keep= 表示不额外保护，除万宝槌自身外全部返回。');
  console.log('正常测试只运行这一条命令一次：程序自己发动M11、观察、返回选择、再观察、最后FULL RESYNC全部手牌。');
  console.log('--fresh 仅保留为人工清理旧恢复状态的应急参数，正常新测试不要求输入。');
  console.log('============================================================');

  let attemptDir = null;
  let baseline;
  let malletSlot;
  let plan;
  let selectionProof;
  let activationProof;
  let actionProof;
  let confirmProof;
  let resolutionProof;
  if (fresh && forceResumeCurrentSelection) {
    throw new Error('M11_FRESH_AND_FORCED_RESUME_ARE_MUTUALLY_EXCLUSIVE');
  }
  if (fresh) {
    removeIfExists(RESUME_STATE_PATH);
    console.log('本轮 --fresh：忽略并清除旧M11恢复状态，强制从当前真实局面重新建立baseline。');
  }
  let resumeState = fresh
    ? null
    : forceResumeCurrentSelection
      ? readForcedCurrentSelectionState(keepIds)
      : readRecentResumeState(keepIds);
  let resumingPartialSelection = false;

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;

    if (!resumeState && forceResumeCurrentSelection) {
      throw new Error('M11_FORCED_RESUME_MUST_NOT_FALL_BACK_TO_FRESH_EXECUTION');
    }

    if (!resumeState && !fresh) {
      resumeState = bootstrapResumeFromCurrentArtifacts(keepIds);
      if (resumeState) persistResumeState(resumeState);
    }

    if (resumeState) {
      baseline = resumeState.baseline;
      malletSlot = resumeState.malletSlot;
      plan = resumeState.plan;
      attemptDir = resumeState.attemptDir;
      activationProof = resumeState.activationProof;
      actionProof = resumeState.actionProof || null;
      const savedSelection = committedSelectionState(resumeState);
      if (savedSelection.complete) {
        const completed = await finishSubmittedMalletSelection({ checkpoint: resumeState,
          bridge, info, templates, attemptDir });
        resumeState = completed.checkpoint;
        selectionProof = completed.selectionProof;
        confirmProof = completed.confirmProof;
        resolutionProof = completed.resolutionProof;
      } else {
        const resumeProof = await verifyResumePrompt(bridge, info, resumeState);
        resumingPartialSelection = true;
        activationProof = resumeProof.activationProof;
        console.log('检测到万宝槌部分选择恢复：只继续尚未提交的返回牌，不重发M11。');
        console.log('此前已提交=' + resumeState.committedIds.join(' / '));
      }
    } else {
      attemptDir = path.join(ATTEMPT_ROOT, timestampId());
      ensureDir(attemptDir);

      baseline = await establishCurrentStateBaseline(bridge, info, path.join(attemptDir, 'observer_baseline'));
      malletSlot = findMalletSlot(baseline);
      plan = buildRemainingPlan(baseline, malletSlot, keepIds);

      const remainingCount = baseline.handCount - 1;
      // Do not re-introduce the later temporary "<=8 candidates" gate here.
      // Mature M11 targeting already treats the return prompt as its own
      // horizontally scrollable physical-card strip.  The selector below
      // anchors the prompt to a real edge when needed, re-detects current
      // physical card frames after every commit, and clicks by the current
      // logical candidate index.  It must not fall back to a synthetic grid.
      if (remainingCount < 1 || remainingCount > 11) {
        throw new Error(`M11_SELECTION_CANDIDATE_COUNT_OUT_OF_SUPPORTED_HAND_RANGE:${remainingCount}`);
      }
      if (remainingCount > 8) {
        console.log(
          `万宝槌高手牌选择: 当前返回候选=${remainingCount}；` +
          '使用成熟专用横向候选条（真实卡框 + 左/右边界锚定），不再使用新聊天的 <=8 临时限制。'
        );
      }

      console.log('\n万宝槌本轮策略：');
      console.log(
        `  保留: ${plan.kept.map(card => `${card.name}[${card.id}]@原手牌${card.originalSlot}`).join(' / ')}`
      );
      console.log(
        `  返回: ${plan.returned.map(card => `${card.name}[${card.id}]@原手牌${card.originalSlot}`).join(' / ')}`
      );

      console.log('\n============================================================');
      console.log(`准备自动操作：${CARD_NAME}[${CARD_ID}]`);
      console.log('先发动万宝槌；进入返回选择界面后，程序只点“需要返回”的牌。');
      console.log(`保护名单中的 ${keepLabel} 不点、不返回。`);
      console.log('============================================================');

      const selected = await selectMalletFromMeasuredBaseline({
        bridge,
        info,
        library,
        templates,
        baseline,
        malletSlot,
        debugDir: attemptDir
      });
      console.log(`发动前卡名确认: ${selected.selected.name}[${selected.selected.id}] PASS`);

      actionProof = await clickSelectedHandSpellActivation({
        bridge,
        info,
        expectedId: CARD_ID,
        expectedName: CARD_NAME,
        clickReference: selected.clickReference,
        library,
        templates,
        debugDir: attemptDir
      });
      console.log(`已点击“发动”：${CARD_NAME}[${CARD_ID}]；等待返回选择界面稳定。`);

      await sleep(650);
      await runDuelLogLive({
        bridge,
        skipActivation: true,
        skipForegroundReactivate: true,
        verbose: false,
        allowBacktrack: false,
      expectedAtomicActivationKey: 'M11'
      });
      const activationLog = readJson(LOG_RESULT_PATH);
      activationProof = validateMalletActivationStage(activationLog);
      console.log('万宝槌发动右栏确认: PASS；当前仍处于返回选择阶段。');

      resumeState = makeFreshResumeState({
        baseline,
        malletSlot,
        keepIds,
        plan,
        attemptDir,
        activationProof,
        actionProof
      });
      persistResumeState(resumeState);
    }

    if (!selectionProof) {
      const committedIds = Array.isArray(resumeState && resumeState.committedIds)
        ? resumeState.committedIds.slice()
        : [];

      selectionProof = await selectMalletReturnCards({
        bridge,
        info,
        library,
        templates,
        remainingCards: plan.remainingCards,
        keepIds,
        debugDir: attemptDir,
        alreadyCommittedIds: committedIds,
        stepOffset: committedIds.length,
        resumeSelection: resumingPartialSelection,
        onCommitted: async ({ committedIds: nowCommitted }) => {
          resumeState = {
            ...resumeState,
            status: 'SELECTION_ACTIVE',
            committedIds: nowCommitted.slice()
          };
          persistResumeState(resumeState);
          console.log(`  恢复检查点已写入: 已成功提交=${nowCommitted.length}张`);
        }
      });

      console.log(
        `返回选择完成: 已选=${selectionProof.selectedCount}; ` +
        `保留=${selectionProof.keptCount}; 开始验收结算。`
      );
      console.log('当前需要返回的牌已全部提交：停止候选点击，先观察是否已自动结算；仍有真实确认窗口才点左侧确认。');

      resumeState = {
        ...resumeState,
        status: 'READY_TO_CONFIRM',
        committedIds: [
          ...(selectionProof.alreadyCommittedIds || []),
          ...selectionProof.rows.map(row => row.card.id)
        ],
        selectionProof
      };
      persistResumeState(resumeState);

      const completed = await finishSubmittedMalletSelection({ checkpoint: resumeState,
        bridge, info, templates, attemptDir });
      resumeState = completed.checkpoint;
      selectionProof = completed.selectionProof;
      confirmProof = completed.confirmProof;
      resolutionProof = completed.resolutionProof;

      writeJson(path.join(attemptDir, 'execution_click.json'), {
        capturedAt: new Date().toISOString(),
        target: { id: CARD_ID, name: CARD_NAME, slot: malletSlot },
        beforeHandCount: baseline.handCount,
        keepIds,
        keepLabel,
        plan,
        actionProof,
        activationProof,
        selectionProof,
        confirmProof,
        resolutionProof
      });
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const expectedAfter = baseline.handCount - 1;

  console.log('\n===== 万宝槌结算后 FULL RESYNC：重新点击识别当前全部手牌 =====');
  console.log(
    `最终应有 ${expectedAfter} 张手牌；这里会逐张重新识别并验收每一张，` +
    '不会只检查手牌数量。'
  );
  let finalScan;
  if (expectedAfter <= 7) {
    finalScan = await runLiveScan({
      expected: expectedAfter,
      preparedBaseline: true,
      verbose: false,
      observerFast: false,
      persistObserverBaseline: false
    });
  } else {
    // 8~12 张绝不能回退到 FIXED_FAN。这里直接复用已经在开局、M12、
    // observer 高手牌路径验证过的 DENSE 横向拖拽分段识别：先用 INFO
    // 实读最终权威数量，再左右探边/滑动，把所有牌拖进中央安全区识别。
    const denseOut = await runDenseHandScan({
      expectedCount: expectedAfter,
      repeats: 1,
      verifyOwnTurn: true,
      outputDir: path.join(attemptDir, 'final_dense_full_resync'),
      writeLatest: true,
      mode: 'M11_FINAL_FULL_RESYNC'
    });
    finalScan = densePreparedResult(denseOut, expectedAfter);
    finalScan.handImagePath = denseOut.baselineHandImagePath || null;
    console.log(
      `M11结算后高手牌FULL RESYNC: DENSE PASS; ` +
      `手牌=${finalScan.handCount}; confidence=${finalScan.denseConfidence || 'NA'}`
    );
  }

  finalScan = normalizeMalletFinalExodia(finalScan);
  const fullResyncProof = validateMalletFullRescan(
    baseline.handCount,
    finalScan
  );
  const protectedProof = verifyProtectedStillPresent(
    baseline.cards,
    finalScan.cards,
    keepIds
  );
  // PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_M11: M11 is the one main-deck reverse move (hand -> Deck).
  // Reconcile returned cards and actual FULL RESYNC draws as one atomic ledger update.
  const malletLedger = reconcileMalletFullResync({ baseline, plan, finalScan });
  const returnedThenRedrawn = Array.isArray(malletLedger && malletLedger.lastMallet && malletLedger.lastMallet.returnedThenRedrawn)
    ? malletLedger.lastMallet.returnedThenRedrawn
    : [];
  const cardNamesById = new Map(
    [...baseline.cards, ...finalScan.cards]
      .filter(card => card && card.id)
      .map(card => [String(card.id), String(card.name || card.id)])
  );
  const returnedThenRedrawnLabel = returnedThenRedrawn
    .map(id => `${cardNamesById.get(String(id)) || id}[${id}]`)
    .join(' / ');
  if (returnedThenRedrawnLabel) {
    console.log(
      `万宝槌返回后又抽回: ${returnedThenRedrawnLabel}；` +
      '这些牌已经成功返回牌组，只是本次抽卡再次抽到，不能判定为漏选。'
    );
  }

  writeJson(path.join(attemptDir, 'final_full_resync.json'), finalScan);
  persistFinalHand(finalScan, attemptDir);

  const logBridge = new MdFastBridge();
  await logBridge.start();
  try {
    await activateAndVerifyMasterDuel(logBridge);
    await runDuelLogLive({
      bridge: logBridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      rebaselineCurrentBottom: true,
      allowBacktrack: false,
      verbose: false
    });
  } finally {
    await logBridge.stop().catch(() => {});
  }

  copyIfExists(LOG_RESULT_PATH, path.join(attemptDir, 'duel_log_after_resolution.json'));

  writeJson(path.join(attemptDir, 'result.json'), {
    status: 'PASS',
    completedAt: new Date().toISOString(),
    target: { id: CARD_ID, name: CARD_NAME },
    keepIds,
    keepLabel,
    beforeHandCount: baseline.handCount,
    afterHandCount: finalScan.handCount,
    activationProof,
    selectionProof,
    resolutionProof,
    fullResyncProof,
    protectedProof,
    finalHand: finalScan.cards
  });

  removeIfExists(RESUME_STATE_PATH);

  markExecutionPass({
    id: CARD_ID,
    name: CARD_NAME,
    testEntry: 'execution\\live\\run-m11-mallet-keep-weapon.cmd',
    evidenceDir: attemptDir,
    scope: 'DYNAMIC_KEEP_IDS_RETURN_ALL_OTHERS + RIGHT_LOG_RETURN_DRAW_TAIL + FULL_RESYNC'
  });

  console.log('\n============================================================');
  console.log(`M11执行测试 PASS: ${CARD_NAME}`);
  console.log(`本轮保护不返回: ${keepLabel}`);
  console.log(
    `实际选择返回=${selectionProof.selectedCount}张；` +
    `保护/取消选择=${selectionProof.keptCount}张`
  );
  console.log(`手牌数: ${baseline.handCount} -> ${finalScan.handCount}`);
  console.log(`返回后又抽回: ${returnedThenRedrawnLabel || '无'}`);
  console.log(
    `最终手牌: ${finalScan.cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`
  );
  console.log(`素材目录: ${attemptDir}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(`\nM11执行测试停止: ${error && error.stack ? error.stack : error}`);
  console.error(
    '本执行器正常是一条命令自动走完整路线。若安全检查意外停止，请保持当前游戏画面并把完整日志发回来；' +
    '不要手动补点、不要reset、不要--new。'
  );
  process.exitCode = 1;
});
