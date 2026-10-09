'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const config = require(path.join(ROOT, 'live-config'));
const {
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const { detectCandidateCenters } = require(path.join(ROOT, 'execution', 'core', 'prompt-candidate-centers'));
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const { cropImage } = require('../../lib/png-utils');
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { waitBeforePromptSubmit } = require(path.join(ROOT, 'execution', 'core', 'prompt-submit-timing'));
const { sameRuntimeCardIdentity, normalizeExodiaComponentCard, countRuntimeCardIds, canonicalRuntimeCardId } = require('../../lib/exodia-policy');

// M11 selection prompt semantics established by the live tests:
//   1) click exactly ONE candidate card;
//   2) click the currently available "选择" control to commit it;
//   3) repeat until only protected cards remain;
//   4) click "确认" to resolve.
//
// Important: the action-button layout is phase-dependent.  Before the first
// committed card Master Duel shows one centered "选择" button.  After at least
// one card has been committed the prompt can expose the historical two-button
// layout (left "确认", right "选择").  Never assume one fixed X coordinate.
const M11_PROMPT_ROI = { x: 520, y: 820, width: 1025, height: 225 };
// Header, candidates and action controls must describe the same modal frame.
// Candidate panels move horizontally as cards are returned; the header does not.
const M11_MODAL_PROOF_ROI = { x: 520, y: 725, width: 1025, height: 415 };
const M11_CARD_Y = 925;
const M11_LEFT_VISIBLE_X = [596, 754, 912, 1070, 1228, 1386];
const M11_VISIBLE_CAPACITY = M11_LEFT_VISIBLE_X.length;

const GENERIC_CONFIRM = (config.toonChain && config.toonChain.genericDialogConfirm) || {};
const M11_SINGLE_SELECT_BUTTON = GENERIC_CONFIRM.point || { x: 1024, y: 1082 };
const M11_MULTI_CONFIRM_BUTTON = { x: 875, y: 1088 };
const M11_MULTI_SELECT_BUTTON = { x: 1175, y: 1088 };

// Wide action strip used only for passive yellow-label localization.
const M11_ACTION_SCAN_ROI = { x: 700, y: 1035, width: 650, height: 105 };
const M11_ACTION_TEXT_MIN_Y = 1078;
const M11_ACTION_TEXT_MAX_Y = 1128;
const M11_ACTION_ZONE_MIN_PIXELS = 100;

// 2026-09-16 regression guard: after a prompt card is clicked, the left detail
// panel can remain on the previously selected card for several hundred ms,
// especially when the prompt collapses to one final card.  Never treat that
// stale panel as proof that the physical click missed, and never re-click a
// candidate just because the detail panel is late.
const M11_CARD_IDENTITY_INITIAL_WAIT_MS = 500;
const M11_CARD_IDENTITY_POLL_MS = 250;
const M11_CARD_IDENTITY_TIMEOUT_MS = 2200;
const M11_AFTER_SELECT_SETTLE_MS = 1000;
const M11_LAST_SINGLETON_STABLE_SAMPLES = 3;
const M11_LAST_SINGLETON_STABLE_MS = 650;
const M11_LAST_SINGLETON_POLL_MS = 180;

// Horizontal candidate strip scrollbar.  1024 lies safely on the thumb in the
// observed 7/8-candidate layouts; dragging it to an edge is idempotent.
const M11_SCROLL_Y = 1035;
const M11_SCROLL_GRAB_X = 1024;
const M11_SCROLL_LEFT_X = 570;
const M11_SCROLL_RIGHT_X = 1450;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function snapshotPrompt(bridge, info, debugDir, label) {
  const image = await captureReferenceRoi(bridge, info, M11_PROMPT_ROI);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, `${label}.png`));
  }
  return image;
}

function cleanCenters(points) {
  return (points || [])
    .filter(point =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 545 &&
      point.x <= 1475
    )
    .sort((a, b) => a.x - b.x);
}

const M11_EXPECTED_CARD_SPACING = 158;
const M11_EXPECTED_CARD_WIDTH = 118;

function choosePhysicalCardRun(points, expectedVisible) {
  const rows = cleanCenters(points);
  if (!Number.isInteger(expectedVisible) || expectedVisible < 1 || rows.length < expectedVisible) {
    return null;
  }

  // M11 prompt detection can see narrow/partial card edges at the two sides.
  // Reuse the same principle as the mature dense-hand locator: trust measured
  // physical frames, then choose a contiguous, evenly-spaced safe window.
  // Never invent a centered grid from the logical candidate count.
  if (expectedVisible === 1) {
    return rows
      .slice()
      .sort((a, b) => {
        const sa = Math.abs((a.width || M11_EXPECTED_CARD_WIDTH) - M11_EXPECTED_CARD_WIDTH) * 2 +
          Math.abs(a.x - 1024) * 0.03;
        const sb = Math.abs((b.width || M11_EXPECTED_CARD_WIDTH) - M11_EXPECTED_CARD_WIDTH) * 2 +
          Math.abs(b.x - 1024) * 0.03;
        return sa - sb;
      })
      .slice(0, 1);
  }

  const candidates = [];
  for (let start = 0; start <= rows.length - expectedVisible; start++) {
    const run = rows.slice(start, start + expectedVisible);
    const gaps = run.slice(1).map((row, index) => row.x - run[index].x);
    if (gaps.some(gap => gap < 118 || gap > 205)) continue;

    const gapScore = gaps.reduce(
      (sum, gap) => sum + Math.abs(gap - M11_EXPECTED_CARD_SPACING),
      0
    );
    const widthScore = run.reduce(
      (sum, row) => sum + Math.abs((row.width || M11_EXPECTED_CARD_WIDTH) - M11_EXPECTED_CARD_WIDTH),
      0
    );
    const meanX = run.reduce((sum, row) => sum + row.x, 0) / run.length;
    const centerScore = Math.abs(meanX - 1024) * 0.02;
    candidates.push({ run, score: gapScore * 2 + widthScore * 0.5 + centerScore });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].run : null;
}

function rawCandidateEvidence(image) {
  let componentPoints = [];
  let centeredPoints = [];
  try {
    componentPoints = cleanCenters(detectCandidateCenters(
      image,
      M11_PROMPT_ROI,
      M11_CARD_Y,
      { mode: 'components' }
    ));
  } catch (_) {}
  // Retain the old heuristic only as a non-clicking prompt-visibility signal.
  // Physical targeting below never consumes centeredPoints.
  try {
    centeredPoints = cleanCenters(detectCandidateCenters(
      image,
      M11_PROMPT_ROI,
      M11_CARD_Y
    ));
  } catch (_) {}
  return { componentPoints, centeredPoints };
}

async function getCurrentCandidateCenters({
  bridge,
  info,
  debugDir,
  label,
  expectedCandidateCount
}) {
  const expectedVisible = Math.min(expectedCandidateCount, M11_VISIBLE_CAPACITY);
  let last = null;

  // Same safety rule as dense-hand targeting: only click a position backed by
  // a real current-frame card component.  M11 used to synthesize CENTERED_GRID
  // coordinates when component counts disagreed; that is exactly how a valid
  // logical M21 target could still miss physically.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const image = await snapshotPrompt(
      bridge,
      info,
      debugDir,
      `${label}${attempt > 1 ? `_retry${attempt}` : ''}`
    );
    const evidence = rawCandidateEvidence(image);
    const physicalRun = choosePhysicalCardRun(evidence.componentPoints, expectedVisible);
    last = { image, ...evidence, physicalRun };

    if (physicalRun && physicalRun.length === expectedVisible) {
      console.log(
        `  当前候选物理卡框: ${physicalRun.map(point => `(${Math.round(point.x)},${Math.round(point.y)})`).join(', ')} ` +
        `(PHYSICAL_RUN ${expectedVisible}/${expectedVisible}; raw=${evidence.componentPoints.length})`
      );
      return {
        image,
        points: physicalRun,
        source: 'PROMPT_PHYSICAL_CARD_RUN'
      };
    }

    if (attempt < 5) await sleep(180);
  }

  throw new Error(
    `M11_PHYSICAL_CANDIDATE_FRAMES_UNAVAILABLE:` +
    `expectedVisible=${expectedVisible};raw=${last ? last.componentPoints.length : 0};` +
    '不会再回退到猜测的居中/固定几何坐标。'
  );
}

async function clickReference(bridge, info, ref) {
  const point = mapReferencePoint(info, ref);
  await bridge.click(point.x, point.y);
}

async function dragReference(bridge, info, fromRef, toRef) {
  const a = mapReferencePoint(info, fromRef);
  const b = mapReferencePoint(info, toRef);
  await bridge.drag(a.x, a.y, b.x, b.y, { durationMs: 180, steps: 12 });
}

async function forceCandidateScrollEdge({ bridge, info, edge, debugDir, label }) {
  const targetX = edge === 'RIGHT' ? M11_SCROLL_RIGHT_X : M11_SCROLL_LEFT_X;
  await dragReference(
    bridge,
    info,
    { x: M11_SCROLL_GRAB_X, y: M11_SCROLL_Y },
    { x: targetX, y: M11_SCROLL_Y }
  );
  await sleep(260);
  if (debugDir) {
    await snapshotPrompt(bridge, info, debugDir, `${label}_scroll_${edge.toLowerCase()}`);
  }
}

async function resolveVisibleCandidate({
  bridge,
  info,
  currentCandidateCount,
  candidateIndex,
  debugDir,
  label
}) {
  if (candidateIndex < 0 || candidateIndex >= currentCandidateCount) {
    throw new Error(
      `M11_CANDIDATE_INDEX_INVALID:${candidateIndex}/${currentCandidateCount}`
    );
  }

  let visibleStart = 0;
  let anchoredEdge = null;

  // This mirrors dense-hand positionTargetWindow(): when the strip is wider
  // than one viewport, first drag to a proven semantic edge, then index inside
  // that anchored window.  Recovery no longer assumes the scrollbar happened
  // to stay where the previous process left it.
  if (currentCandidateCount > M11_VISIBLE_CAPACITY) {
    if (candidateIndex < M11_VISIBLE_CAPACITY) {
      anchoredEdge = 'LEFT';
      await forceCandidateScrollEdge({ bridge, info, edge: 'LEFT', debugDir, label });
      visibleStart = 0;
    } else {
      anchoredEdge = 'RIGHT';
      await forceCandidateScrollEdge({ bridge, info, edge: 'RIGHT', debugDir, label });
      visibleStart = currentCandidateCount - M11_VISIBLE_CAPACITY;
    }
  }

  const visibleIndex = candidateIndex - visibleStart;
  if (visibleIndex < 0 || visibleIndex >= M11_VISIBLE_CAPACITY) {
    throw new Error(
      `M11_TARGET_NOT_VISIBLE:index=${candidateIndex};visibleStart=${visibleStart};` +
      `count=${currentCandidateCount}`
    );
  }

  const centers = await getCurrentCandidateCenters({
    bridge,
    info,
    debugDir,
    label,
    expectedCandidateCount: currentCandidateCount
  });
  const ref = centers.points[visibleIndex];
  if (!ref) {
    throw new Error(
      `M11_TARGET_CENTER_MISSING:index=${candidateIndex};visibleIndex=${visibleIndex};` +
      `centers=${centers.points.length}`
    );
  }

  return {
    ref: {
      x: ref.x,
      y: M11_CARD_Y,
      width: Number(ref.width || M11_EXPECTED_CARD_WIDTH),
      source: centers.source
    },
    visibleIndex,
    visibleStart,
    anchoredEdge,
    source: centers.source
  };
}

async function resolveStableLastRemainingCandidate({ bridge, info, debugDir, label }) {
  const started = Date.now();
  let firstStableAt = 0;
  let lastSignature = '';
  let stableSamples = 0;
  let lastRawCount = 0;

  for (let attempt = 1; attempt <= 16; attempt++) {
    const image = await snapshotPrompt(
      bridge,
      info,
      debugDir,
      `${label}_stable_${String(attempt).padStart(2, '0')}`
    );
    const evidence = rawCandidateEvidence(image);
    const physicalRun = choosePhysicalCardRun(evidence.componentPoints, 1);
    lastRawCount = evidence.componentPoints.length;

    // The previous Select animation can briefly collapse several moving cards
    // into one component at x~=1024.  A single detected frame is therefore not
    // enough proof for the last-card click.  Require the best physical-card
    // frame to keep the same measured geometry across several captures and for
    // a minimum settled duration.  Do not require raw component count=1: the
    // selected-card pile/badge and prompt decoration remain visible beside the
    // real singleton and legitimately produce extra raw components.
    if (physicalRun && physicalRun.length === 1) {
      const ref = physicalRun[0];
      const signature = [
        Math.round(ref.x / 3),
        Math.round(ref.y / 3),
        Math.round(Number(ref.width || M11_EXPECTED_CARD_WIDTH) / 3)
      ].join(':');

      if (signature === lastSignature) {
        stableSamples += 1;
      } else {
        lastSignature = signature;
        stableSamples = 1;
        firstStableAt = Date.now();
      }

      if (
        stableSamples >= M11_LAST_SINGLETON_STABLE_SAMPLES &&
        Date.now() - firstStableAt >= M11_LAST_SINGLETON_STABLE_MS
      ) {
        console.log(
          `  末张候选稳定 PASS: center=(${Math.round(ref.x)},${Math.round(ref.y)}); ` +
          `stableSamples=${stableSamples}; stableMs=${Date.now() - firstStableAt}; ` +
          `raw=${evidence.componentPoints.length}`
        );
        return {
          ref: { x: ref.x, y: M11_CARD_Y },
          visibleIndex: 0,
          visibleStart: 0,
          anchoredEdge: null,
          source: 'PROMPT_STABLE_BEST_SINGLE_PHYSICAL_CARD',
          stableSamples
        };
      }
    } else {
      lastSignature = '';
      stableSamples = 0;
      firstStableAt = 0;
    }

    await sleep(M11_LAST_SINGLETON_POLL_MS);
  }

  throw new Error(
    `M11_LAST_REMAINING_PHYSICAL_FRAME_UNSTABLE:raw=${lastRawCount};` +
    `elapsedMs=${Date.now() - started}`
  );
}

function normalizePromptRecognition(result) {
  const judged = result && result.judged;
  const best = judged && judged.best;
  return {
    accepted: Boolean(judged && judged.accepted && best),
    id: best ? best.id : 'UNKNOWN',
    name: best ? best.name : 'UNKNOWN',
    mad: best && best.mad != null ? best.mad : null
  };
}

async function verifyPromptCardSelection({ bridge, info, library, templates, expectedCard }) {
  if (!library || !templates) return null;
  const raw = await recognizeCurrentCard(bridge, info, library, templates, {
    stableAcceptedSamples: 2
  });
  const selected = normalizePromptRecognition(raw);
  if (!selected.accepted || !sameRuntimeCardIdentity(expectedCard, selected)) {
    throw new Error(
      `M11_PROMPT_CARD_VERIFY_FAILED:expected=${expectedCard.name}[${expectedCard.id}];` +
      `actual=${selected.name}[${selected.id}];mad=${selected.mad}`
    );
  }
  return normalizeExodiaComponentCard(selected);
}

// The blue diamond/check overlays the selected card's top-right corner.
// Prove its geometry and white check, not just blue card artwork. This is used
// only to recover an existing selection, never to invent a card identity.
function classifyMalletSelectedBadge(image, ref) {
  const cx = Math.round(ref.x + 38 - M11_PROMPT_ROI.x);
  const cy = Math.round(ref.y - 58 - M11_PROMPT_ROI.y);
  if (cx < 30 || cy < 30 || cx + 30 >= image.width || cy + 30 >= image.height) return { pass: false };
  let blue = 0, white = 0, dark = 0, inner = 0;
  const quadrants = [0, 0, 0, 0];
  for (let dy = -30; dy <= 30; dy++) {
    for (let dx = -30; dx <= 30; dx++) {
      const distance = Math.abs(dx) + Math.abs(dy);
      const i = ((cy + dy) * image.width + cx + dx) * 4;
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (distance >= 20 && distance <= 29 && b > 120 && b > r + 50 && g > 60) {
        blue++; quadrants[(dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0)]++;
      }
      if (distance <= 19) {
        inner++;
        if (Math.min(r, g, b) > 180) white++;
        if (Math.max(r, g, b) < 86) dark++;
      }
    }
  }
  const darkRatio = inner ? dark / inner : 0;
  return { pass: blue >= 200 && quadrants.every(n => n >= 30) && white >= 30 && darkRatio >= 0.5,
    blue, white, darkRatio, quadrants };
}

async function recoverSelectedReturnCard({ bridge, info, library, templates,
  currentCandidateCount, candidateIndex, card, debugDir, step }) {
  const target = await resolveVisibleCandidate({ bridge, info, currentCandidateCount, candidateIndex,
    debugDir, label: `m11_step_${String(step).padStart(2, '0')}_resume_selected` });
  const prompt = await probeMalletSelectionPrompt({ bridge, info, debugDir,
    label: 'm11_resume_modal', includeCandidateImage: true });
  const image = prompt.candidateImage;
  if (!prompt.modalBodyProven) throw new Error('M11_RESUME_MODAL_NOT_PROVEN');
  const badge = classifyMalletSelectedBadge(image, target.ref);
  const layout = prompt.action;
  if (!badge.pass) {
    const otherSelected = rawCandidateEvidence(image).componentPoints.some(point =>
      classifyMalletSelectedBadge(image, { x: point.x, y: M11_CARD_Y }).pass);
    if (otherSelected || layout.usable.right || layout.usable.center) {
      throw new Error('M11_RESUME_SELECTION_AMBIGUOUS_NO_RECLICK');
    }
    return null; // No selected badge and Select disabled: normal first click.
  }
  if (!layout.usable.right && !layout.usable.center) throw new Error('M11_RESUME_SELECTED_WITHOUT_SELECT_ACTION');
  if (!library || !templates) throw new Error('M11_RESUME_SELECTED_IDENTITY_DEPENDENCIES_MISSING');
  const selected = await waitForPromptCardSelection({ bridge, info, library, templates, expectedCard: card, step });
  console.log(`  第${step}次返回: 当前目标选中菱形/详情/选择按钮均已证明；只提交“选择”，不再次点卡。`);
  return { target, selected, badge };
}

async function waitForPromptCardSelection({ bridge, info, library, templates, expectedCard, step }) {
  if (!library || !templates) return null;

  await sleep(M11_CARD_IDENTITY_INITIAL_WAIT_MS);
  const started = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - started <= M11_CARD_IDENTITY_TIMEOUT_MS) {
    attempt += 1;
    try {
      const selected = await verifyPromptCardSelection({
        bridge,
        info,
        library,
        templates,
        expectedCard
      });
      console.log(
        `  第${step}次返回: 左侧详情稳定 PASS; identityProbe=${attempt}; ` +
        `${selected.name}[${selected.id}]`
      );
      return selected;
    } catch (error) {
      lastError = error;
      console.log(
        `  第${step}次返回: 左侧详情尚未稳定(${error.message})；` +
        `本轮只等待${M11_CARD_IDENTITY_POLL_MS}ms后重读，不重复点击候选牌。`
      );
      if (Date.now() - started > M11_CARD_IDENTITY_TIMEOUT_MS) break;
      await sleep(M11_CARD_IDENTITY_POLL_MS);
    }
  }

  throw new Error(
    `${lastError ? lastError.message : 'M11_PROMPT_CARD_VERIFY_TIMEOUT'};` +
    `NO_RECLICK_AFTER_CARD_CLICK;timeoutMs=${M11_CARD_IDENTITY_TIMEOUT_MS}`
  );
}

function summarizeActionLayout(stats) {
  const zones = { left: 0, center: 0, right: 0 };
  const textComponents = [];

  for (const component of stats.components || []) {
    const absX = M11_ACTION_SCAN_ROI.x + component.centerX;
    const absY = M11_ACTION_SCAN_ROI.y + component.centerY;
    if (component.estimatedPixels < 40) continue;
    if (absY < M11_ACTION_TEXT_MIN_Y || absY > M11_ACTION_TEXT_MAX_Y) continue;

    let zone;
    if (absX < 950) zone = 'left';
    else if (absX > 1090) zone = 'right';
    else zone = 'center';
    zones[zone] += component.estimatedPixels;
    textComponents.push({
      zone,
      x: absX,
      y: absY,
      pixels: component.estimatedPixels
    });
  }

  const usable = {
    left: zones.left >= M11_ACTION_ZONE_MIN_PIXELS,
    center: zones.center >= M11_ACTION_ZONE_MIN_PIXELS,
    right: zones.right >= M11_ACTION_ZONE_MIN_PIXELS
  };
  const mode = usable.left && usable.right
    ? 'DUAL_LEFT_CONFIRM_RIGHT_SELECT'
    : usable.center
      ? 'SINGLE_CENTER_ACTION'
      : usable.right
        ? 'RIGHT_ACTION_ONLY'
        : usable.left
          ? 'LEFT_ACTION_ONLY'
          : 'NO_YELLOW_ACTION_LABEL';

  return { zones, usable, mode, textComponents };
}

async function probeMalletActionLayout({ bridge, info, debugDir, label }) {
  const image = await captureReferenceRoi(bridge, info, M11_ACTION_SCAN_ROI);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, `${label}.png`));
  }
  const stats = yellowUsableStats(image);
  return {
    ...summarizeActionLayout(stats),
    totalYellowPixels: stats.estimatedYellowPixels
  };
}

async function waitForSelectableAction({ bridge, info, debugDir, label }) {
  let layout = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    layout = await probeMalletActionLayout({
      bridge,
      info,
      debugDir,
      label: `${label}${attempt > 1 ? `_retry${attempt}` : ''}`
    });
    if (layout.usable.right || layout.usable.center) return layout;
    if (attempt < 5) await sleep(150);
  }
  throw new Error(
    `M11_SELECT_ACTION_NOT_ENABLED:${label};mode=${layout && layout.mode};` +
    `left=${layout && layout.zones.left};center=${layout && layout.zones.center};` +
    `right=${layout && layout.zones.right};total=${layout && layout.totalYellowPixels}`
  );
}

async function waitForConfirmAction({ bridge, info, debugDir, label }) {
  let layout = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    layout = await probeMalletActionLayout({
      bridge,
      info,
      debugDir,
      label: `${label}${attempt > 1 ? `_retry${attempt}` : ''}`
    });

    // M11 最终阶段与首次逐张“选择”不是同一个按钮语义：
    // 一旦已有返回牌被提交，最终【确认】固定在左侧；中央按钮只属于
    // “尚未提交任何牌时的单一选择按钮”布局，绝不能拿来当最终确认。
    // 2026-09-07 实战再次验证：所有非保护牌返回完后，界面明确为
    // 左侧“确认”可用、右侧“选择”禁用。即使黄色组件误落到 center，
    // 也必须继续等待左侧确认，而不是点击中央位置。
    if (layout.usable.left) return layout;
    if (attempt < 8) await sleep(180);
  }
  throw new Error(
    `M11_FINAL_LEFT_CONFIRM_NOT_ENABLED:${label};mode=${layout && layout.mode};` +
    `left=${layout && layout.zones.left};center=${layout && layout.zones.center};` +
    `right=${layout && layout.zones.right};total=${layout && layout.totalYellowPixels}`
  );
}

// PATCH_M11_LAST_REMAINING_CANDIDATE_V1
async function commitLastRemainingReturnCard({
  bridge,
  info,
  library,
  templates,
  currentCandidateCount,
  candidateIndex,
  card,
  debugDir,
  step
}) {
  if (currentCandidateCount !== 1 || candidateIndex !== 0) {
    throw new Error(
      `M11_LAST_REMAINING_STAGE_INVALID:count=${currentCandidateCount};index=${candidateIndex}`
    );
  }

  let target = null;
  let cardReference = null;
  let selected = null;

  // LAST_REMAINING_CANDIDATE is still an unselected physical card.  Earlier
  // submitted cards have left the candidate strip, but the immediately
  // following frame can still belong to their reflow animation.  Prove a
  // stable singleton before clicking.  If the click does not take, retry only
  // when the action strip independently proves that Select is still disabled;
  // this prevents a second click from toggling an already-selected card off.
  for (let clickAttempt = 1; clickAttempt <= 2; clickAttempt++) {
    target = await resolveStableLastRemainingCandidate({
      bridge,
      info,
      debugDir,
      label: `m11_step_${String(step).padStart(2, '0')}_last_remaining_click${clickAttempt}`
    });
    cardReference = { x: target.ref.x, y: target.ref.y };
    console.log(
      `  第${step}次返回: LAST_REMAINING_CANDIDATE; ` +
      `候选账本唯一剩余=${card.name}[${card.id}]; ` +
      `稳定卡框点击${clickAttempt}/2 reference=(${Math.round(cardReference.x)},${Math.round(cardReference.y)})/${target.source}`
    );
    await clickReference(bridge, info, cardReference);

    try {
      selected = await waitForPromptCardSelection({
        bridge,
        info,
        library,
        templates,
        expectedCard: card,
        step
      });
      break;
    } catch (error) {
      const layout = await probeMalletActionLayout({
        bridge,
        info,
        debugDir,
        label: `m11_step_${String(step).padStart(2, '0')}_last_remaining_post_click${clickAttempt}`
      });
      if (layout.usable.right || layout.usable.center) {
        throw new Error(
          `${error.message};M11_LAST_REMAINING_SELECT_ENABLED_NO_RECLICK;layout=${layout.mode}`
        );
      }
      if (clickAttempt >= 2) {
        throw new Error(
          `${error.message};M11_LAST_REMAINING_NOT_FOCUSED_AFTER_STABLE_REMEASURE;layout=${layout.mode}`
        );
      }
      console.log(
        `  第${step}次返回: 首次稳定卡框点击后身份未变化，且选择按钮仍未启用(${layout.mode})；` +
        '证明尚未选中。等待并重新测量当前唯一卡框后，仅重试1次。'
      );
      await sleep(500);
    }
  }

  if (!selected) {
    throw new Error('M11_LAST_REMAINING_IDENTITY_NOT_PROVEN');
  }
  await waitBeforePromptSubmit(`万宝槌第${step}次返回（最后唯一候选）`);
  const layout = await waitForSelectableAction({
    bridge,
    info,
    debugDir,
    label: `m11_step_${String(step).padStart(2, '0')}_last_remaining_select`
  });
  const selectButton = layout.usable.right
    ? M11_MULTI_SELECT_BUTTON
    : M11_SINGLE_SELECT_BUTTON;
  console.log(
    `  第${step}次返回: 最后候选“选择”按钮 PASS; layout=${layout.mode}; ` +
    `click=(${selectButton.x},${selectButton.y}); ` +
    `yellow(L/C/R)=${layout.zones.left}/${layout.zones.center}/${layout.zones.right}`
  );
  await clickReference(bridge, info, selectButton);
  await sleep(M11_AFTER_SELECT_SETTLE_MS);
  await snapshotPrompt(
    bridge,
    info,
    debugDir,
    `m11_step_${String(step).padStart(2, '0')}_last_remaining_after_select`
  );

  return {
    step,
    card,
    candidateIndex,
    currentCandidateCount,
    clickReference: cardReference,
    detectedCenter: target.ref,
    anchoredEdge: target.anchoredEdge,
    selectedCardProof: selected,
    selectButton,
    actionLayout: layout.mode,
    actionZones: layout.zones,
    finalCandidateAutoCommitted: false,
    policy: 'LAST_REMAINING_PHYSICAL_CENTER_IDENTITY_THEN_EXPLICIT_SELECT'
  };
}

async function commitOneReturnCard({
  bridge,
  info,
  library,
  templates,
  currentCandidateCount,
  candidateIndex,
  card,
  debugDir,
  step,
  preselected = null
}) {
  let target = preselected && preselected.target;
  let selected = preselected && preselected.selected;
  let lastError = null;

  if (preselected) await waitBeforePromptSubmit(`万宝槌第${step}次返回（恢复已选中卡）`);

  // Locate -> click -> card-name verify before pressing “选择”.  This is the
  // same physical-truth pattern used by selectKnownHandCard()/dense targeting.
  // A miss can never be committed merely because the logical list says M21.
  for (let attempt = 1; !preselected && attempt <= 2; attempt++) {
    try {
      target = await resolveVisibleCandidate({
        bridge,
        info,
        currentCandidateCount,
        candidateIndex,
        debugDir,
        label: `m11_step_${String(step).padStart(2, '0')}_before${attempt > 1 ? `_retry${attempt}` : ''}`
      });

      console.log(
        `  第${step}次返回: 当前候选第${candidateIndex + 1}张 ` +
        `${card.name}[${card.id}] -> 点击物理卡框 ` +
        `reference=(${Math.round(target.ref.x)},${Math.round(target.ref.y)})/${target.source}` +
        `${target.anchoredEdge ? `; 锚定=${target.anchoredEdge}` : ''}`
      );
      await clickReference(bridge, info, target.ref);

      selected = await waitForPromptCardSelection({
        bridge,
        info,
        library,
        templates,
        expectedCard: card,
        step
      });
      if (selected) {
        console.log(
          `  第${step}次返回: 卡名精确认 PASS -> ${selected.name}[${selected.id}]`
        );
      }
      // V2 已封板的统一节奏：候选卡精确认后，不要紧贴着点“选择”。
      // 只等待，不发送任何额外卡牌点击。
      await waitBeforePromptSubmit(`万宝槌第${step}次返回`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      // If target was already clicked, do not click it again. A second click can
      // toggle selection off while the left detail panel is merely stale.
      if (target) {
        console.log(
          `  第${step}次返回: 候选点击已发送但身份仍未闭环(${error.message})；` +
          'FAIL-CLOSED，不重复点击该候选。'
        );
        break;
      }
      if (attempt < 2) {
        console.log(
          `  第${step}次返回: 物理定位尚未完成(${error.message})；` +
          '尚未发送候选点击，重新锚定同一逻辑目标再试1次。'
        );
        await sleep(350);
      }
    }
  }

  if (lastError) throw lastError;

  const layout = await waitForSelectableAction({
    bridge,
    info,
    debugDir,
    label: `m11_step_${String(step).padStart(2, '0')}_select_button`
  });

  const selectButton = layout.usable.right
    ? M11_MULTI_SELECT_BUTTON
    : M11_SINGLE_SELECT_BUTTON;
  console.log(
    `  第${step}次返回: “选择”按钮 PASS; layout=${layout.mode}; ` +
    `click=(${selectButton.x},${selectButton.y}); ` +
    `yellow(L/C/R)=${layout.zones.left}/${layout.zones.center}/${layout.zones.right}`
  );
  await clickReference(bridge, info, selectButton);
  await sleep(M11_AFTER_SELECT_SETTLE_MS);

  await snapshotPrompt(
    bridge,
    info,
    debugDir,
    `m11_step_${String(step).padStart(2, '0')}_after_select`
  );

  return {
    step,
    card,
    candidateIndex,
    currentCandidateCount,
    clickReference: target.ref,
    anchoredEdge: target.anchoredEdge,
    selectedCardProof: selected,
    selectButton,
    actionLayout: layout.mode,
    actionZones: layout.zones,
    recoveredAlreadySelected: Boolean(preselected)
  };
}

/**
 * General M11 return selector.
 *
 * remainingCards is the pre-activation prompt order after M11 itself left the
 * hand.  alreadyCommittedIds removes cards that were successfully committed by
 * an earlier process before a safe in-duel restart.
 */
async function selectMalletReturnCards({
  bridge,
  info,
  library = null,
  templates = null,
  remainingCards,
  keepIds,
  debugDir,
  alreadyCommittedIds = [],
  onCommitted = null,
  stepOffset = null,
  resumeSelection = false
}) {
  const keepSet = new Set((keepIds || []).map(canonicalRuntimeCardId));
  const committedCounts = countRuntimeCardIds(alreadyCommittedIds);

  let currentCandidates = [];
  for (const card of remainingCards || []) {
    const id = canonicalRuntimeCardId(card);
    const n = committedCounts.get(id) || 0;
    if (n > 0) {
      committedCounts.set(id, n - 1);
      continue;
    }
    currentCandidates.push({ ...card });
  }

  if (!currentCandidates.length) {
    throw new Error('M11_NO_CURRENT_CANDIDATES');
  }

  console.log('\n万宝槌返回选择：逐张“卡 -> 选择”。');
  console.log('保护牌只留在候选区，不点击。');
  if ((alreadyCommittedIds || []).length) {
    console.log(
      `局内恢复: 已确认此前成功提交=${alreadyCommittedIds.length}张；` +
      `不会重复点击这些牌。`
    );
  }

  const rows = [];
  let localStep = 0;
  const baseStep = Number.isInteger(stepOffset)
    ? stepOffset
    : (alreadyCommittedIds || []).length;

  while (true) {
    const candidateIndex = currentCandidates.findIndex(card => !keepSet.has(canonicalRuntimeCardId(card)));
    if (candidateIndex < 0) break;

    if (candidateIndex > 0) {
      const skippedProtected = currentCandidates
        .slice(0, candidateIndex)
        .filter(card => keepSet.has(canonicalRuntimeCardId(card)));
      if (skippedProtected.length) {
        console.log(
          `  跳过前方保护牌: ${skippedProtected.map(card => `${card.name}[${card.id}]`).join(' / ')}；` +
          `继续返回其后的下一张非保护牌。`
        );
      }
    }

    const card = currentCandidates[candidateIndex];
    localStep += 1;
    const step = baseStep + localStep;
    const committedBeforeThis = (alreadyCommittedIds || []).length + rows.length;
    const preselected = resumeSelection && localStep === 1
      ? await recoverSelectedReturnCard({ bridge, info, library, templates,
          currentCandidateCount: currentCandidates.length, candidateIndex, card, debugDir, step })
      : null;

    // LAST_REMAINING_CANDIDATE is kept as a separate stage so it can use the
    // one-frame physical proof without re-clicking any submitted historical
    // candidate.  It is not auto-committed: the sole current card is clicked
    // at its measured center, then identity and the real Select action must
    // both pass before the ledger counts it as returned.
    const useLastRemainingStage = !preselected &&
      currentCandidates.length === 1 &&
      candidateIndex === 0 &&
      committedBeforeThis > 0;

    const proof = useLastRemainingStage
      ? await commitLastRemainingReturnCard({
          bridge,
          info,
          library,
          templates,
          currentCandidateCount: currentCandidates.length,
          candidateIndex,
          card,
          debugDir,
          step
        })
      : await commitOneReturnCard({
          bridge,
          info,
          library,
          templates,
          currentCandidateCount: currentCandidates.length,
          candidateIndex,
          card,
          debugDir,
          step,
          preselected
        });

    rows.push({
      ...proof,
      action: 'CLICK_CARD_THEN_PHASE_AWARE_SELECT'
    });

    currentCandidates.splice(candidateIndex, 1);
    if (typeof onCommitted === 'function') {
      await onCommitted({
        proof,
        card,
        committedIds: [
          ...(alreadyCommittedIds || []),
          ...rows.map(row => row.card.id)
        ],
        currentCandidates: currentCandidates.map(item => ({ ...item }))
      });
    }

    console.log(
      `  已提交返回；候选区剩余: ` +
      `${currentCandidates.map(c => `${c.name}[${c.id}]`).join(' | ')}`
    );
  }

  const protectedRemaining = currentCandidates.filter(card => keepSet.has(canonicalRuntimeCardId(card)));
  const unexpected = currentCandidates.filter(card => !keepSet.has(canonicalRuntimeCardId(card)));
  if (unexpected.length) {
    throw new Error(
      `M11_UNEXPECTED_NONPROTECTED_REMAINS:` +
      `${unexpected.map(card => card.id).join('>')}`
    );
  }

  console.log(
    `万宝槌逐张返回完成: 新提交=${rows.length}张；` +
    `候选区仅剩保护牌=${protectedRemaining.map(card => `${card.name}[${card.id}]`).join(' / ')}`
  );

  return {
    selectedCount: rows.length + (alreadyCommittedIds || []).length,
    newlyCommittedCount: rows.length,
    alreadyCommittedIds: alreadyCommittedIds || [],
    protectedRemaining,
    keptCount: protectedRemaining.length,
    rows,
    policy: 'EDGE_ANCHORED_SINGLE_CLICK_WAIT_IDENTITY_THEN_SELECT'
  };
}

async function waitForConfirmPromptToClose({ bridge, info, debugDir, label }) {
  let lastLayout = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(attempt === 1 ? 500 : 280);
    lastLayout = await probeMalletActionLayout({
      bridge,
      info,
      debugDir,
      label: `${label}_${String(attempt).padStart(2, '0')}`
    });

    const anyAction =
      lastLayout.usable.left ||
      lastLayout.usable.center ||
      lastLayout.usable.right;

    if (!anyAction) {
      return {
        closed: true,
        attempts: attempt,
        lastLayout
      };
    }
  }

  return {
    closed: false,
    attempts: 5,
    lastLayout
  };
}

async function confirmMalletSelection({ bridge, info, debugDir }) {
  await snapshotPrompt(bridge, info, debugDir, 'm11_before_confirm');

  // 成熟 M11 规则：所有非保护牌都已逐张“卡 -> 选择”提交后，
  // 这里只负责【一次】最终“确认”点击。不要再用“按钮/窗口是否马上消失”
  // 判断提交是否成功——确认后会有约数百毫秒动画，旧按钮区域在转场帧里
  // 仍可能保持黄色，拿它做 close proof 会导致误判并重复点击。
  // 最终提交是否成立，交给 run-m11-execute-test.js 的成熟右栏
  // “返回 + 抽卡”尾证据确认。
  // 最后一张“选择”提交后给UI更充足的稳定时间；与其它“点卡 -> OK/确认”
  // 统一保持偏保守节奏，避免按钮刚切换时的瞬时黄字/残影误判。
  await sleep(700);

  const layout = await waitForConfirmAction({
    bridge,
    info,
    debugDir,
    label: 'm11_final_confirm_button'
  });

  // 所有需要返回的牌已经逐张提交后，最终确认只允许点左侧确认。
  // 不再允许 SINGLE_CENTER_ACTION 作为最终确认兜底。
  const confirmButton = M11_MULTI_CONFIRM_BUTTON;

  const current = await probeMalletSelectionPrompt({ bridge, info, debugDir,
    label: 'm11_final_confirm_current_window' });
  if (!current.modalBodyProven || !current.likelyVisible || !current.action.usable.left) {
    throw new Error('M11_FINAL_CONFIRM_CURRENT_MODAL_NOT_PROVEN');
  }

  console.log(
    `万宝槌返回集合完成：“确认”按钮 PASS; layout=${layout.mode}; ` +
    `click=(${confirmButton.x},${confirmButton.y}); ` +
    `yellow(L/C/R)=${layout.zones.left}/${layout.zones.center}/${layout.zones.right}`
  );

  await clickReference(bridge, info, confirmButton);
  console.log(
    '万宝槌最终“确认”已点击 1 次；不再依据按钮消失/黄色残影重复点击。' +
    '后续纯等待，再以右栏“返回 + 抽卡”尾证据判断是否真正结算。'
  );

  return {
    confirmButton,
    actionLayout: layout.mode,
    actionZones: layout.zones,
    clickCount: 1,
    commitValidation: 'DEFER_TO_M11_RIGHT_LOG_TAIL'
  };
}

async function waitAfterMalletConfirm({ waitMs = 500 }) {
  console.log(
    `万宝槌已确认：纯等待 ${waitMs}ms；动画期间不发送任何鼠标/键盘输入。`
  );
  await sleep(waitMs);
  return {
    waitedMs: waitMs,
    inputPolicy: 'NO_INPUT_DURING_M11_ANIMATION'
  };
}

function classifyMalletPromptBody(image) {
  if (image.width === 1025 && image.height === 415) {
    let left = 0, right = 0, total = 0, headerTextPixels = 0;
    for (let y = 25; y < 55; y++) {
      for (let x = 165; x < 185; x++) {
        const li = (y * image.width + x) * 4;
        const ri = (y * image.width + x + 650) * 4;
        if (Math.max(image.data[li], image.data[li + 1], image.data[li + 2]) < 86) left++;
        if (Math.max(image.data[ri], image.data[ri + 1], image.data[ri + 2]) < 86) right++;
        total++;
      }
      for (let x = 250; x < 775; x++) {
        const i = (y * image.width + x) * 4;
        if (Math.min(image.data[i], image.data[i + 1], image.data[i + 2]) > 180) headerTextPixels++;
      }
    }
    const leftDarkRatio = left / total, rightDarkRatio = right / total;
    return { modalBodyProven: leftDarkRatio >= 0.8 && rightDarkRatio >= 0.8 && headerTextPixels >= 100,
      leftDarkRatio, rightDarkRatio, headerTextPixels, evidence: 'SAME_FRAME_MODAL_HEADER' };
  }
  // Compatibility for archived candidate-only evidence. Live authorization
  // uses the full header frame above, never this count-dependent crop.
  // In the mature 1025x225 prompt ROI, both upper side bands are inside the
  // centered dark modal and above candidate art. Hand cards and battlefield
  // pixels can contain yellow labels, but do not provide this dark body.
  function darkRatio(left, right) {
    let dark = 0, total = 0;
    for (let y = 0; y < Math.min(12, image.height); y++) {
      for (let x = left; x < Math.min(right, image.width); x++) {
        const i = (y * image.width + x) * 4;
        if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) < 86) dark++;
        total++;
      }
    }
    return total ? dark / total : 0;
  }
  const leftDarkRatio = darkRatio(185, 345), rightDarkRatio = darkRatio(680, 840);
  return { modalBodyProven: image.width === 1025 && image.height === 225 &&
    leftDarkRatio >= 0.8 && rightDarkRatio >= 0.8, leftDarkRatio, rightDarkRatio };
}

async function probeMalletSelectionPrompt({ bridge, info, debugDir = null, label = 'm11_prompt_probe',
  includeCandidateImage = false }) {
  const windowImage = await captureReferenceRoi(bridge, info, M11_MODAL_PROOF_ROI);
  const image = cropImage(windowImage, { x: 0, y: 95, width: 1025, height: 225 });
  const actionImage = cropImage(windowImage, { x: 180, y: 310, width: 650, height: 105 });
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(windowImage, path.join(debugDir, `${label}_window.png`));
    saveRgbaPng(image, path.join(debugDir, `${label}.png`));
    saveRgbaPng(actionImage, path.join(debugDir, `${label}_action.png`));
  }
  const body = classifyMalletPromptBody(windowImage);
  const candidates = rawCandidateEvidence(image);
  const stats = yellowUsableStats(actionImage);
  const action = { ...summarizeActionLayout(stats), totalYellowPixels: stats.estimatedYellowPixels };
  return {
    ...body,
    likelyVisible: body.modalBodyProven && Boolean(
      candidates.componentPoints.length ||
      candidates.centeredPoints.length ||
      action.usable.left ||
      action.usable.center ||
      action.usable.right
    ),
    componentCandidateCount: candidates.componentPoints.length,
    centeredCandidateCount: candidates.centeredPoints.length,
    ...(includeCandidateImage ? { candidateImage: image } : {}),
    action
  };
}

module.exports = {
  classifyMalletPromptBody,
  M11_SINGLE_SELECT_BUTTON,
  M11_MULTI_SELECT_BUTTON,
  M11_MULTI_CONFIRM_BUTTON,
  selectMalletReturnCards,
  confirmMalletSelection,
  waitAfterMalletConfirm,
  probeMalletSelectionPrompt,
  probeMalletActionLayout
};
