'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { performance } = require('perf_hooks');
const { readPng, cropImage } = require('../../lib/png-utils');
const { completeMalletSelection } = require('../core/m11-mallet-completion');
const hs = require('../../lib/hand-state'), config = require('../../live-config');
const { resolveMeasuredHandTarget } = require('../../lib/live-hand-geometry');
const ROOT = path.resolve(__dirname, '../..');
const RUN = path.resolve(ROOT, '../runs/2026-10-04T06-13-06-592Z');
function segment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
async function testModal() {
  const file = path.join(ROOT, 'execution/core/m11-mallet-selection.js'), native = createRequire(file);
  let scene = await readPng(path.join(RUN, 'game-00003/before-recovery/last-guarded-frame.png'));
  let captures = 0; const clicks = [], logs = [];
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(file), Buffer,
    console: { log: x => logs.push(x) }, require: id => {
      if (id.replace(/\\/g, '/').endsWith('lib/win-fast')) return {
        captureReferenceRoi: async (_, info, roi) => { captures++; return cropImage(scene, roi); },
        mapReferencePoint: (_, p) => p, sleep: async () => {}
      };
      if (id.replace(/\\/g, '/').endsWith('observer/scan-state')) return {
        saveRgbaPng() { throw new Error('DISK_WRITE_FORBIDDEN'); }, recognizeCurrentCard() { throw new Error('CARD_RESELECTION_FORBIDDEN'); }
      };
      return native(id);
    } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const options = { bridge: { click: async (x, y) => clicks.push({ x, y }) }, info: {}, debugDir: null };
  const oldCrop = cropImage(scene, { x: 520, y: 820, width: 1025, height: 225 });
  assert.strictEqual(context.classifyMalletPromptBody(oldCrop).modalBodyProven, false,
    'reproduce old count-dependent false negative on actual four-protected-card window');
  const prompt = await context.probeMalletSelectionPrompt(options);
  assert.strictEqual(captures, 1, 'header, candidates and buttons use one actual frame');
  assert.strictEqual(prompt.modalBodyProven, true);
  assert.strictEqual(prompt.action.usable.left, true);
  assert.strictEqual(prompt.action.usable.right, false);
  const checkpoint = { status: 'READY_TO_CONFIRM', committedIds: ['M06', 'M12', 'M22'],
    plan: { returned: ['M06', 'M12', 'M22'].map(id => ({ id })),
      kept: Array.from({ length: 4 }, () => ({ id: 'EXODIA_UNKNOWN' })) } };
  const proven = { status: 'PASS', expectedDrawCount: 3, drawResultCount: 3,
    returnBeforePrimaryDrawCount: 3, drawLabelCount: 1 };
  let observations = 0; const saves = [];
  const result = await completeMalletSelection({ checkpoint, waitStable: async () => {},
    observeResolution: async () => ++observations === 1 ? { status: 'NOT_READY' } : proven,
    probePrompt: () => context.probeMalletSelectionPrompt(options),
    confirmSelection: () => context.confirmMalletSelection(options),
    persistCheckpoint: state => saves.push(state) });
  assert.deepStrictEqual(clicks, [{ x: 875, y: 1088 }], 'one final Confirm, no candidate/activation replay');
  assert.strictEqual(result.checkpoint.status, 'RESOLUTION_PROVEN');
  assert.strictEqual(saves[0].status, 'CONFIRMED');
  assert.strictEqual(checkpoint.status, 'READY_TO_CONFIRM', 'saved input remains immutable');

  // The modal can disappear after a valid initial probe. The final input guard
  // must use its new full frame, not yellow hand artwork or a cached proof.
  const modalScene = scene;
  const closedScene = await readPng(path.join(RUN, 'game-00005/runtime-debug/scan-state-live/prepared/error_state.png'));
  scene = closedScene;
  assert.strictEqual((await context.probeMalletSelectionPrompt(options)).modalBodyProven, false);
  let finalProbe = false;
  context.waitForConfirmAction = async () => { finalProbe = true; scene = closedScene; return prompt.action; };
  scene = modalScene;
  await assert.rejects(context.confirmMalletSelection(options), /CURRENT_MODAL_NOT_PROVEN/);
  assert.strictEqual(finalProbe, true);
  assert.strictEqual(clicks.length, 1, 'closed window never receives a confirm click');
  for (const rel of ['material/issues/issue-117-selected-component.png', 'material/issues/issue-098-user-scene.png']) {
    scene = await readPng(path.join(ROOT, rel));
    const current = await context.probeMalletSelectionPrompt(options);
    assert.strictEqual(current.modalBodyProven, rel.includes('117'), 'seven-card modal retained; old closed modal rejected');
  }
  console.log('M11_MODAL_COMPLETION_OFFLINE_PASS; actual G3 four-protected-card window; same-frame proof; final Confirm once; closed/current-frame guard; no game input');
}
async function testResync() {
  const file = path.join(ROOT, 'runtime/observer/scan-state.js'), source = fs.readFileSync(file, 'utf8');
  const initial = await readPng(path.join(RUN, 'game-00005/runtime-debug/scan-state-live/prepared/hand_detect.png'));
  const recovered = cropImage(await readPng(path.join(RUN, 'game-00005/runtime-debug/scan-state-live/prepared/error_state.png')), config.handFan.detectRoi);
  for (const archived of [true, false]) for (const permanent of [false, true]) {
    let frame = initial, captures = 0, queries = 0, misses = 0;
    const clicks = [], logs = [], saved = [];
    const ids = ['M04', 'M07', 'M09', 'M14', 'M16', 'M19', 'M21'];
    const context = vm.createContext({ path, performance, config, resolveMeasuredHandTarget, console: { log: x => logs.push(String(x)) },
      fs: { writeFileSync: (file, value) => saved.push({ file, value }) },
      normalizeScanOptions: x => x, printTop3() {}, recognitionConfidence: () => 1,
      normalizeExodiaComponentCard: x => x, getHandLayout: hs.getHandLayout,
      resolveExposedFanSlots: hs.resolveExposedFanSlots,
      isSpellCardId: hs.isSpellCardId,
      mapReferencePoint: (_, p) => p, sleep: async () => {},
      captureReferenceRoi: async () => { captures++; return frame; },
      saveRgbaPng: (image, file) => saved.push({ file, image }),
      detectHandCountFromImage: (image, count, options) => {
        const actual = hs.detectHandCountFromImage(image, count, options);
        if (options?.purpose === 'CLICK_TARGET' && queries === 1 && (permanent || misses < 2)) {
          misses++;
          // Explicit fault injection at the production detector boundary:
          // one title is temporarily absent but the resolver still infers 7.
          const components = actual.componentEstimate.components.filter((_, i) => i !== 1);
          actual.componentEstimate = { ...actual.componentEstimate, count: components.length, components };
        }
        return actual;
      },
      recognizeCurrentCard: async () => {
        const id = ids[queries++], best = { id, name: id, mad: 0, rmse: 0, dhash: 0 };
        frame = recovered;
        return { judged: { accepted: true, best, margin: 1 }, ranked: [best] };
      }
    });
    const testedSource = archived ? fs.readFileSync(path.join(RUN, 'engine-source/runtime/observer/scan-state.js'), 'utf8') : source;
    vm.runInContext(segment(testedSource, 'async function scanOneState(', 'async function main('), context);
    const bridge = { key: async () => {}, move: async () => {}, click: async (x, y) => clicks.push({ x, y }) };
    const options = { authoritativeCount: 7, previousCount: 7, debugDir: 'MEMORY',
      openingHandClickReset: false, observerFast: true, initialCardSettleMs: 0, checkUsability: false };
    if (archived) {
      await assert.rejects(context.scanOneState(bridge, {}, {}, [], options), /HAND_CLICK_TITLE_2D_UNPROVEN:slot=2/);
      assert.strictEqual(clicks.length, 1);
      assert.strictEqual(misses, 1, 'archived production scan exits reset loop too early on the inferred layout');
      continue;
    }
    if (permanent) {
      await assert.rejects(context.scanOneState(bridge, {}, {}, [], options), /HAND_CLICK_TITLE_2D_UNPROVEN:slot=2/);
      assert.strictEqual(clicks.length, 1, 'unmeasured second card is never clicked');
      assert.strictEqual(misses, config.handFan.slotResetMaxAttempts || 3);
      const diagnostic = saved.find(row => row.file.endsWith('live_layout_uncertain_slot_02.json'));
      assert.ok(diagnostic, 'the exact rejected layout is archived, not a later healthy frame');
      assert.strictEqual(JSON.parse(diagnostic.value).target.measuredTitle2D, undefined);
    } else {
      const state = await context.scanOneState(bridge, {}, {}, [], options);
      assert.strictEqual(state.cards.length, 7);
      assert.strictEqual(clicks.length, 7);
      assert.strictEqual(misses, 2, 'both failed 2D frames are retried before target input');
      const actual = hs.resolveExposedFanSlots(hs.getHandLayout(7), {
        ...hs.detectHandCountFromImage(recovered, 7, { purpose: 'CLICK_TARGET' }).componentEstimate,
        components: hs.detectHandCountFromImage(recovered, 7, { purpose: 'CLICK_TARGET' }).componentEstimate.components.map(c => ({
          ...c, centerX: c.centerX + config.handFan.detectRoi.x, centerY: c.centerY + config.handFan.detectRoi.y }))
      }).slots[1];
      assert.deepStrictEqual(clicks[1], { x: actual.x, y: actual.titleY });
    }
    assert.ok(logs.filter(x => x.includes('目标尚未实测')).length >= 2);
  }
  console.log('M11_RESYNC_OFFLINE_PASS; archived full scan premature exit reproduced; actual G5 frames plus explicit transient/permanent missing-title injection; current full scan retries recover all 7; permanent failure no guessed click; diskWrites=0/nativeInputs=0');
}
(async () => { await testModal(); await testResync(); })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
