'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const modal = require('../core/m19-deck-prompt-proof');
const { detectCandidateCenters } = require('../core/prompt-candidate-centers');
const ROOT = path.resolve(__dirname, '../..');
const AUTOTEST = path.dirname(ROOT);
const RUN = path.join(AUTOTEST, 'runs/2026-10-04T02-41-54-766Z');
const png = file => PNG.sync.read(fs.readFileSync(file));
const g4 = path.join(RUN, 'game-00004/runtime-debug/execution/V5_hornet_link_current');

// Old archives stored header/body/strip in separate captures. Composite them
// ONLY for geometry regression, not as evidence that a live frame was atomic.
// Unobserved pixels are white (fail closed), never invented dark modal pixels.
function archivedComposite(dir, suffix, candidateFile) {
  const image = { width: 800, height: 305, data: Buffer.alloc(800 * 305 * 4, 255) };
  for (const [file, x, y] of [
    [`m19_target_header_${suffix}.png`, 60, 0],
    [`m19_target_body_${suffix}.png`, -20, 75],
    [candidateFile || `m19_target_candidates_${suffix}.png`, 0, 105]
  ]) {
    const part = png(path.join(dir, file));
    for (let row = 0; row < part.height; row++) {
      for (let col = 0; col < part.width; col++) {
        if (row + y < image.height && col + x >= 0 && col + x < image.width) {
          part.data.copy(image.data, ((row + y) * 800 + col + x) * 4,
            (row * part.width + col) * 4, (row * part.width + col + 1) * 4);
        }
      }
    }
  }
  return image;
}

const waitAnimation = archivedComposite(path.join(g4,
  '2026-10-04T03-01-17-423Z/atomic_dual_e02_target_to_bamboo_prompt/wait_bamboo'),
  'd3_bamboo_wait_02', 'd3_bamboo_physical_02.png');
const selectAnimation = archivedComposite(path.join(g4,
  '2026-10-04T03-01-23-144Z/atomic_bamboo_prompt_to_resolved/bamboo_search'),
  'before_select_02', 'bamboo_candidates_actual_02.png');
const fullAnimation = cropImage(png(path.join(RUN,
  'game-00004/before-recovery/last-guarded-frame.png')), modal.PROMPT_ROI);
const singleModal = cropImage(png(path.join(AUTOTEST,
  'fixtures/m19-actual-modal-full.png')), modal.PROMPT_ROI);
const fourModal = archivedComposite(path.join(RUN,
  'game-00001/runtime-debug/execution/V5_hornet_link_current/2026-10-04T02-43-09-995Z/atomic_bamboo_prompt_to_resolved/bamboo_search'),
  'before_select_01', 'bamboo_candidates_actual_01.png');
const g3Modal = archivedComposite(path.join(RUN,
  'game-00003/runtime-debug/execution/V5_hornet_link_current/2026-10-04T02-58-13-874Z/atomic_bamboo_prompt_to_resolved/bamboo_search'),
  'before_select_01', 'bamboo_candidates_actual_01.png');
const latestRun = path.join(AUTOTEST, 'runs/2026-10-04T05-26-53-681Z');
const selectionPairs = [
  [1, '2026-10-04T05-29-52-322Z'],
  [3, '2026-10-04T05-36-14-347Z'],
  [4, '2026-10-04T05-38-18-625Z']
].map(([game, stamp]) => {
  const dir = path.join(latestRun, `game-${String(game).padStart(5, '0')}`,
    'runtime-debug/execution/V5_hornet_link_current', stamp,
    'atomic_bamboo_prompt_to_resolved/bamboo_search');
  return { game, before: png(path.join(dir, 'm19_target_modal_d3_bamboo_wait_03.png')),
    after: png(path.join(dir, 'm19_target_modal_before_input.png')) };
});

function oldStripPoints(frame) {
  return detectCandidateCenters(cropImage(frame, { x: 0, y: 105, width: 800, height: 200 }),
    { x: 620, y: 830, width: 800, height: 200 }, 925, { mode: 'components' });
}
assert.deepStrictEqual(oldStripPoints(waitAnimation).map(p => p.x), [1020]);
assert.deepStrictEqual(oldStripPoints(selectAnimation).map(p => p.x), [753, 962]);
for (const frame of [waitAnimation, selectAnimation, fullAnimation]) {
  assert.strictEqual(modal.classifyBambooSearchPrompt(frame).pass, false,
    'actual G4 animation/hand must not prove a search modal');
}
for (const frame of [singleModal, fourModal, g3Modal]) {
  assert.strictEqual(modal.classifyBambooSearchPrompt(frame).pass, true,
    'actual modal geometry, including successful G1/G3 grave search, remains usable');
}
assert.strictEqual(modal.classifyBambooSearchPrompt(fourModal).points.length, 4);

// Execute the REAL observer, wait and selector. Only native capture, clock,
// card recognition and physical input are replaced; modal readiness is not.
function harness(frames, options = {}) {
  let clock = 0, captures = 0, optionalProbes = 0, recognizes = 0;
  let selectionActive = false;
  const clicks = [];
  const frameAt = n => selectionActive && options.selectedFrame
    ? options.selectedFrame : frames[Math.min(n - 1, frames.length - 1)];
  const win = { sleep: async ms => { clock += ms; }, mapReferencePoint: (_, p) => p,
    captureReferenceRoi: async (_, __, roi) => {
      if (roi.width === 800 && roi.height === 305) return frameAt(++captures);
      return { width: roi.width, height: roi.height, data: Buffer.alloc(roi.width * roi.height * 4) };
    } };
  const scan = { saveRgbaPng() {}, recognizeCurrentCard: async () => {
    recognizes++;
    return { accepted: true, id: options.ids?.[Math.min(recognizes - 1, options.ids.length - 1)] || 'M20', name: 'sealed card' };
  } };
  const load = (name, extras = {}) => {
    const file = path.join(ROOT, 'execution/core', name);
    const nativeRequire = createRequire(file);
    const ctx = vm.createContext({ __dirname: path.dirname(file), module: { exports: {} },
      console: { log() {} }, Date: { now: () => clock }, require: id => {
        const normalized = id.replace(/\\/g, '/');
        if (normalized.endsWith('lib/win-fast')) return win;
        if (normalized.endsWith('observer/scan-state')) return scan;
        if (normalized.endsWith('lib/hand-state')) return { yellowUsableStats: () => ({
          estimatedYellowPixels: 1000, components: [{ estimatedPixels: 500,
            width: 60, height: 30, centerX: 180, centerY: 63 }] }) };
        if (normalized.endsWith('prompt-submit-timing')) return { waitBeforePromptSubmit: async () => { clock += 1000; } };
        if (normalized.endsWith('recognition-result')) return { normalizeRecognized: r => r };
        if (normalized.endsWith('optional-effect-prompt-observer')) return {
          OPTIONAL_EFFECT_PROMPT: {}, probeOptionalEffectPrompt: async () => {
            optionalProbes++; return { visible: true, candidateCount: 1 };
          } };
        if (normalized.endsWith('bamboo-search-target-prompt-observer')) return extras.observer;
        return nativeRequire(id);
      } });
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    return ctx.module.exports;
  };
  const observer = load('bamboo-search-target-prompt-observer.js');
  const executor = load('m19-search-execution.js', { observer });
  const bridge = { click: async (x, y) => {
    clicks.push({ x, y, captures });
    if (options.allowOptionalCancel && x === 870 && y === 1088) return;
    assert.strictEqual(modal.classifyBambooSearchPrompt(frameAt(captures)).pass, true,
      'every candidate/submit input must follow a fresh real modal proof');
    if (y === 925) selectionActive = !selectionActive;
  } };
  return { executor, observer, bridge, clicks, get captures() { return captures; },
    get optionalProbes() { return optionalProbes; }, get recognizes() { return recognizes; } };
}

async function test() {
  for (const pair of selectionPairs) {
    const before = modal.classifyBambooSearchPrompt(pair.before);
    const after = modal.classifyBambooSearchPrompt(pair.after);
    const reference = before.points.at(-1);
    assert.strictEqual(before.pass, true);
    assert.strictEqual(after.pass, true);
    assert.strictEqual(modal.sameCandidates(before, after), false,
      `G${pair.game}: reproduce the old false window-change rejection`);
    assert.strictEqual(modal.sameBambooSelectionLayout(before, after, reference), true);
    assert.strictEqual(modal.sameBambooSelectionLayout(before, after, before.points[0]), false,
      'a dimmed/unselected card cannot replace the proven active target');
    for (const bad of [
      { ...after, pass: false },
      { ...after, points: after.points.slice(1) },
      { ...after, points: after.points.map((p, i) => i === after.points.length - 1 ? { ...p, x: p.x + 8 } : p) },
      { ...after, points: after.points.map((p, i) => i === after.points.length - 1 ? { ...p, width: 83 } : p) }
    ]) assert.strictEqual(modal.sameBambooSelectionLayout(before, bad, reference), false);
    const liveState = harness([pair.before], { selectedFrame: pair.after });
    const target = await liveState.executor.selectBambooSearchTarget({ bridge: liveState.bridge, info: {} });
    assert.strictEqual(target.selected.id, 'M20');
    assert.strictEqual(liveState.clicks.length, 2,
      `G${pair.game}: actual unselected -> selected/dimmed pixels -> one submit`);
    assert.strictEqual(liveState.clicks[0].x, reference.x);
    assert.strictEqual(liveState.clicks[1].y, require('../../live-config').toonChain.genericDialogConfirm.point.y);
  }
  const h = harness([waitAnimation, selectAnimation, fullAnimation, fourModal]);
  const args = { bridge: h.bridge, info: {}, originalCandidateCount: 2, skipRemainingOptionalCancel: true };
  const oneProbe = await h.observer.probeBambooSearchTargetPrompt(args);
  assert.strictEqual(h.captures, 1, 'one probe must use exactly one capture');
  assert.strictEqual(oneProbe.visible, false);
  const ready = await h.executor.waitForBambooPromptAfterM19(args);
  assert.strictEqual(ready.prompt.modalProof.stableFrames, 3);
  assert.strictEqual(h.captures, 6, 'animation cannot contribute to stable modal frames');
  assert.strictEqual(h.clicks.length, 0);
  assert.strictEqual(h.optionalProbes, 0, 'dual-chain skip flag must prevent even optional-cancel probing');
  await h.executor.selectBambooSearchTarget(args);
  assert.strictEqual(h.clicks.length, 2, 'True priority: one candidate, one submit, no deselect');
  assert.strictEqual(h.clicks[0].x, 1261);

  for (const frame of [waitAnimation, selectAnimation, fullAnimation]) {
    const negative = harness([frame]);
    const params = { bridge: negative.bridge, info: {}, originalCandidateCount: 2,
      skipRemainingOptionalCancel: true, timeoutMs: 1000 };
    await assert.rejects(negative.executor.waitForBambooPromptAfterM19(params), /BAMBOO_TARGET_PROMPT_TIMEOUT/);
    await assert.rejects(negative.executor.selectBambooSearchTarget(params), /BAMBOO_TARGET_PROMPT_TIMEOUT/);
    assert.strictEqual(negative.clicks.length, 0, 'no candidate, deselect, cancel or submit on animation');
    assert.strictEqual(negative.recognizes, 0, 'card recognition must not be used to justify probing a non-modal');
    assert.strictEqual(negative.optionalProbes, 0);
  }

  const gone = harness([singleModal, singleModal, singleModal, fullAnimation]);
  await assert.rejects(gone.executor.selectBambooSearchTarget({ bridge: gone.bridge, info: {} }),
    /PROMPT_CHANGED_BEFORE_CLICK/);
  assert.strictEqual(gone.clicks.length, 0, 'fresh pre-click gate rejects modal loss after stable wait');

  for (const ids of [['M20'], ['M13']]) {
    const lost = harness([singleModal, singleModal, singleModal, singleModal, fullAnimation], { ids });
    await assert.rejects(lost.executor.selectBambooSearchTarget({ bridge: lost.bridge, info: {} }),
      /PROMPT_CHANGED_BEFORE_CLICK/);
    assert.strictEqual(lost.clicks.length, 1, 'loss after recognition blocks both submit and deselect');
  }

  const golden = harness([singleModal], { ids: ['M14'] });
  const selected = await golden.executor.selectBambooSearchTarget({ bridge: golden.bridge, info: {} });
  assert.strictEqual(selected.selected.id, 'M14');
  assert.strictEqual(golden.clicks.length, 2, 'sole Golden stays selected without deselect/reselect');

  const fallback = harness([fourModal], { ids: ['M14'] });
  const last = await fallback.executor.selectBambooSearchTarget({ bridge: fallback.bridge, info: {} });
  assert.strictEqual(last.selected.id, 'M14');
  assert.strictEqual(fallback.clicks.length, 10, 'multi-card Golden fallback retains guarded deselect/reselect');

  const fixedGolden = harness([fourModal], { ids: ['M20', 'M14'] });
  const fixed = await fixedGolden.executor.selectBambooSearchTarget({ bridge: fixedGolden.bridge, info: {}, targetId: 'M14' });
  assert.strictEqual(fixed.selected.id, 'M14', 'second Yoto searches Golden even if a True candidate is seen first');
  const missingGolden = harness([singleModal], { ids: ['M20'] });
  await assert.rejects(missingGolden.executor.selectBambooSearchTarget({ bridge: missingGolden.bridge, info: {}, targetId: 'M14' }),
    /NO_LEGAL_BAMBOO_TARGET/);
  assert.strictEqual(missingGolden.clicks.length, 2, 'missing fixed target never submits the unrelated True');

  // Keep the old isolated single-effect route's opt-in/default cancellation;
  // dual routes explicitly disable it. This test does not touch the game.
  const legacy = harness([fullAnimation, fourModal], { allowOptionalCancel: true });
  const legacyReady = await legacy.executor.waitForBambooPromptAfterM19({
    bridge: legacy.bridge, info: {}, originalCandidateCount: 2 });
  assert.strictEqual(legacyReady.remainingCancelled, true);
  assert.strictEqual(legacy.optionalProbes, 1);
  assert.strictEqual(legacy.clicks.length, 1);
  assert.deepStrictEqual([legacy.clicks[0].x, legacy.clicks[0].y], [870, 1088]);
  console.log('BAMBOO_MODAL_BOUNDARY_OFFLINE PASS; G1/G3/G4 actual unselected -> dimmed selection -> submit; G4 animation zero input');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
