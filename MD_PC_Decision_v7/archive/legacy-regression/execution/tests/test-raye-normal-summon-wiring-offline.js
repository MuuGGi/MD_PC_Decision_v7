'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { PNG } = require('pngjs');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const config = require('../../live-config'), hs = require('../../lib/hand-state');
const shared = require('../core/hand-normal-summon'), { cropImage } = require('../../lib/png-utils');
const atoms = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
const buttons = fs.readFileSync(path.join(ROOT, 'execution/core/hand-normal-summon.js'), 'utf8');
const frame = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/issues/issue-137-selected-summon-roi.png')));
const background = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'material/issues/issue-137-after-failed-click.png')));
const run = path.resolve(ROOT, '../runs/2026-10-05T03-52-44-028Z');
const baseline = JSON.parse(fs.readFileSync(path.join(run, 'game-00003/before-recovery/debug/hand-change-live/session_state.json')));
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
const roi = { x: 776, y: 730, width: 460, height: 220 };
const neutral = cropImage(background, roi);
// This is a real AFTER-failure background, not the unavailable original
// pre-selection frame. It tests the actual pixels; virtual bridge ordering
// separately proves that production obtains its neutral reference BEFORE click.
async function replayOldEntry() {
  const archived = fs.readFileSync(path.join(run, 'engine-source/execution/core/atomic-route-executor.js'), 'utf8');
  const clicks = [], ctx = vm.createContext({ path, console: { log() {} }, ensureDir() {}, saveRgbaPng() {},
    captureReferenceRoi: async () => frame, mapReferencePoint: (_, p) => p });
  vm.runInContext(section(archived, 'function blueMaskPixel(', 'async function locateFieldRaye('), ctx);
  await ctx.clickRayeNormalSummonButton({ bridge: { click: async (x, y) => clicks.push({ x: Math.round(x), y: Math.round(y) }) },
    info: {}, selectedReference: { x: 1006, y: 1000 }, debugDir: 'MEMORY' });
  assert.deepStrictEqual(clicks, [{ x: 887, y: 898 }]);
}
assert.ok(!atoms.includes('function blueMaskPixel('), 'remove the second raw-blue implementation');
async function replay(mode = 'PASS') {
  const events = [], clicks = [], waits = [], captures = [];
  let selected = false, queries = 0, observerCalls = 0, actionCaptures = 0, stopped = false;
  const bridge = { info: async () => ({ client: { width: 2048, height: 1152 } }),
    key: async k => events.push(k), stop: async () => { stopped = true; },
    click: async (x, y) => {
      clicks.push({ x, y });
      if (Math.abs(x-1006) < 8 && Math.abs(y-1000) < 8) { selected = true; events.push('SELECT_RAYE'); }
      else if (y < 860 && x > 920 && x < 950) events.push('CLICK_SUMMON');
      else assert.ok(y < 300, `no Set, neighbour or guessed-background clicks: ${x},${y}`);
    } };
  const capture = async (_, __, area) => {
    captures.push(area);
    if (area.height === 220) {
      actionCaptures++;
      if (!selected) { events.push('NEUTRAL_ACTION_ROI'); return neutral; }
      assert.deepStrictEqual({ ...area }, roi, 'same ROI/anchor for neutral and selected');
      if (mode === 'CHANGED' && actionCaptures >= 3) return neutral;
      if (mode === 'RIGHT_ONLY') {
        const right = { ...frame, data: Buffer.from(frame.data) };
        for (let y = 0; y < frame.height; y++) neutral.data.copy(right.data, y*frame.width*4,
          y*frame.width*4, (y*frame.width+230)*4);
        return right;
      }
      if (mode === 'NO_MENU') return neutral;
      return frame;
    }
    assert.deepStrictEqual({ ...area }, config.handFan.detectRoi, 'never capture full client or rescan identities');
    return cropImage(background, area);
  };
  const ctx = vm.createContext({ ROOT, path, config, console: { log() {} }, require: createRequire(path.join(ROOT, 'execution/core/atomic-route-executor.js')),
    fs: { mkdirSync() {} }, ensureDir() {}, writeJson() {}, saveRgbaPng() {}, cropImage,
    buildNormalSummonActionRoi: shared.buildNormalSummonActionRoi,
    detectNormalSummonButton: shared.detectNormalSummonButton,
    captureReferenceRoi: capture, mapReferencePoint: (_, p) => p,
    sleep: async ms => waits.push(ms), loadLibrary: () => ({}), loadTemplates: async () => [],
    startBridge: async () => ({ bridge, info: { client: { width: 2048, height: 1152 } } }),
    detectHandCountFromImage: hs.detectHandCountFromImage, getHandLayout: hs.getHandLayout,
    resolveExposedFanSlots: hs.resolveExposedFanSlots, normalizeRecognized: x => x,
    recognizeCurrentCard: async () => { queries++; return { accepted: true, id: mode === 'WRONG_CARD' ? 'M08' : 'M06', name: 'Raye' }; },
    countId: (state, id) => state.cards.filter(c => c.id === id).length,
    waitForSelfPriorityBlue: async () => { events.push('RESPONSE_PROOF'); return { pass: true }; },
    runObserver: () => {
      observerCalls++; assert.ok(stopped, 'close bridge before observer');
      assert.ok(events.includes('CLICK_SUMMON'), 'no observer on failed input proof');
      return mode === 'BAD_DELTA' ? baseline : { ...baseline, handCount: 6,
        cards: baseline.cards.filter(c => c.id !== 'M06') };
    }
  });
  vm.runInContext(section(buttons, 'async function clickSelectedMonsterNormalSummon(', 'module.exports =') +
    section(atoms, 'async function selectCurrentObservedHandCard(', 'function runObserver(') +
    section(atoms, 'async function clickRayeNormalSummonButton(', 'async function locateFieldRaye(') +
    section(atoms, 'async function normalSummonRaye(', 'async function linkCarrierAndResolveYoto('), ctx);
  const action = ctx.normalSummonRaye({ state: baseline, debugDir: 'MEMORY' });
  if (mode === 'PASS') {
    const after = await action; assert.strictEqual(after.handCount, 6);
    assert.strictEqual(queries, 1); assert.strictEqual(observerCalls, 1);
    assert.strictEqual(events.indexOf('NEUTRAL_ACTION_ROI') < events.indexOf('SELECT_RAYE'), true);
    assert.strictEqual(events.filter(e => e === 'SELECT_RAYE').length, 1);
    assert.strictEqual(events.filter(e => e === 'CLICK_SUMMON').length, 1);
    assert.strictEqual(actionCaptures, 3, 'one small neutral, selected, final proof; no full screenshot');
    assert.strictEqual(waits.filter(ms => ms === 1700).length, 1, 'retain existing settle only');
    assert.ok(!waits.includes(180), 'normal path has no new fixed retry delay');
    console.log(`RAYE_ACTUAL_ENTRY old=(887,898); new=${JSON.stringify(clicks.at(-1))}; identityQueries=1; stateWrites=0; nativeInputs=0`);
  } else {
    const errors = { CHANGED: /MENU_CHANGED/, RIGHT_ONLY: /BUTTON_NOT_PROVEN/, NO_MENU: /BUTTON_NOT_PROVEN/,
      WRONG_CARD: /HAND_SELECTION_MISMATCH/, BAD_DELTA: /HAND_DELTA_INVALID/ };
    await assert.rejects(action, errors[mode]);
    assert.strictEqual(events.filter(e => e === 'SELECT_RAYE').length, 1, 'never retry hand selection');
    assert.strictEqual(events.filter(e => e === 'CLICK_SUMMON').length, mode === 'BAD_DELTA' ? 1 : 0);
    assert.strictEqual(observerCalls, mode === 'BAD_DELTA' ? 1 : 0);
  }
  assert.ok(stopped);
}
async function runTest() {
  await replayOldEntry();
  for (const mode of ['PASS', 'CHANGED', 'RIGHT_ONLY', 'NO_MENU', 'WRONG_CARD', 'BAD_DELTA']) await replay(mode);
  assert.match(atoms, /const \{ captureNeutralNormalSummonFrame, buildNormalSummonActionRoi,[\s\S]*clickSelectedMonsterNormalSummon \} = require/);
  console.log('PASS test-raye-normal-summon-wiring-offline; real raw/after images; actual selector -> shared button -> response -> observer; failed gates zero action; no game input');
}
runTest().catch(error => { console.error(error); process.exitCode = 1; });
