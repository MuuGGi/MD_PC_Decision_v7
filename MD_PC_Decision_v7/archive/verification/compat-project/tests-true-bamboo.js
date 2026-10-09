'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, 'engine');
const { cropImage } = require('./engine/lib/png-utils');
const modal = require('./engine/execution/core/m19-deck-prompt-proof');
const { detectCandidateCenters } = require('./engine/execution/core/prompt-candidate-centers');
const gainPolicy = require('./engine/lib/true-bamboo-gain-policy');
const library = require('./engine/card-library.json');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const cards = ids => ids.map((id, i) => ({ id, name: byId[id].name, index: i + 1, usable: true }));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function slice(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}

async function test() {
  const png = name => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
  const positive = cropImage(png('m19-actual-modal-full.png'), modal.PROMPT_ROI);
  const negativeFrame = strip => {
    const result = { width: 800, height: 305, data: Buffer.alloc(800 * 305 * 4) };
    for (let y = 0; y < 200; y++) strip.data.copy(result.data, ((y + 105) * 800) * 4, y * 800 * 4, (y + 1) * 800 * 4);
    return result;
  };
  const negative = negativeFrame(png('m19-false-animation-strip.png'));
  for (const name of ['m19-false-animation-strip.png', 'm19-historical-false-pass-strip.png']) {
    const strip = png(name);
    assert.ok(detectCandidateCenters(strip, { x: 620, y: 830, width: 800, height: 200 }, 925,
      { mode: 'components' }).length > 0, 'old detector reproduces false PASS on both historical and current animation');
    assert.strictEqual(modal.classifyM19DeckPrompt(negativeFrame(strip)).pass, false,
      'even a synthetic perfectly dark header cannot turn field/hand strips into a modal');
  }
  const proof = modal.classifyM19DeckPrompt(positive);
  assert.strictEqual(proof.pass, true);
  assert.strictEqual(proof.points[0].x, 1024);
  const noHeader = { ...positive, data: Buffer.from(positive.data) };
  for (let y = 0; y < 75; y++) noHeader.data.fill(255, y * 800 * 4, (y + 1) * 800 * 4);
  assert.strictEqual(modal.classifyM19DeckPrompt(noHeader).pass, false);
  const gate = modal.createPromptStabilityGate();
  assert.strictEqual(gate(proof).ready, false);
  assert.strictEqual(gate(proof).ready, false);
  assert.strictEqual(gate({ pass: false, points: [] }).ready, false);
  assert.strictEqual(gate(proof).ready, false);
  assert.strictEqual(gate(proof).ready, false);
  assert.strictEqual(gate(proof).ready, true);

  // Actual wait/select functions, with read-only saved frames and a recording
  // input stub. No window, process bridge, or native input is started.
  let clock = 0, captures = 0, clicks = 0;
  const conversionFile = path.join(ROOT, 'execution/core/m20-true-bamboo-conversion.js');
  const nativeConversionRequire = createRequire(conversionFile);
  const conversion = vm.createContext({ __dirname: path.dirname(conversionFile), module: { exports: {} },
    console: { log() {} }, Date: { now: () => clock }, require: id => {
      const normalized = id.replace(/\\/g, '/');
      if (normalized.endsWith('lib/win-fast')) return { sleep: async ms => { clock += ms; }, mapReferencePoint: (_, p) => p,
        captureReferenceRoi: async (_, __, roi) => roi.height === 305 ? (++captures <= 2 ? negative : positive) : positive };
      if (normalized.endsWith('observer/scan-state')) return { saveRgbaPng() {},
        recognizeCurrentCard: async () => ({ id: 'M19', name: '妖刀竹光', accepted: true }) };
      if (id.endsWith('recognition-result')) return { normalizeRecognized: r => r };
      if (normalized.endsWith('lib/hand-state')) return { yellowUsableStats: () => ({ estimatedYellowPixels: 1000 }) };
      if (id.endsWith('prompt-submit-timing')) return { waitBeforePromptSubmit: async () => {} };
      if (id.endsWith('self-priority-gate')) return { waitForSelfPriorityBlue: async () => ({ pass: true }) };
      return nativeConversionRequire(id);
    } });
  vm.runInContext(read('execution/core/m20-true-bamboo-conversion.js'), conversion);
  const recordedBridge = { click: async () => { assert.ok(captures >= 5); clicks++; } };
  const ready = await conversion.module.exports.waitForM19DeckPrompt({ bridge: recordedBridge, info: {} });
  assert.strictEqual(ready.attempts, 5);
  assert.strictEqual(clicks, 0, 'animation and all stability samples are zero-input waits');
  await conversion.module.exports.selectM19FromDeckPrompt({ bridge: recordedBridge, info: {}, promptProof: ready });
  assert.strictEqual(clicks, 2, 'one real candidate + one submit, no animation click');
  captures = -100; clicks = 0;
  await assert.rejects(conversion.module.exports.selectM19FromDeckPrompt({ bridge: recordedBridge, info: {}, promptProof: ready }),
    /PROMPT_CHANGED_BEFORE_CLICK/);
  assert.strictEqual(clicks, 0);
  captures = -100; clock = 0;
  await assert.rejects(conversion.module.exports.waitForM19DeckPrompt({ bridge: recordedBridge, info: {}, timeoutMs: 400 }),
    /DECK_PROMPT_TIMEOUT/);
  assert.strictEqual(clicks, 0);

  let remaining = Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, c.count]));
  Object.assign(remaining, { M19: 1, M20: 0, M22: 0, M08: 0 });
  const engineFile = path.join(ROOT, 'lib/decision-engine.js'), nativeEngineRequire = createRequire(engineFile);
  const engine = vm.createContext({ module: { exports: {} }, console, require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) }
    : nativeEngineRequire(id) });
  vm.runInContext(read('lib/decision-engine.js'), engine);
  const decision = engine.module.exports;
  let saved = { graveSpellCount: 3, bambooSwordEquipped: false, rayeNormalSummoned: false,
    usedCounts: { M12: 1, M08: 1, M22: 1, M19: 1 }, effectUsage: { M19_SEARCH: 1 },
    v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E04' } };
  let hand = { revision: 4, handCount: 4, cards: cards(['M13', 'M16', 'M17', 'M20']) };
  const decide = () => decision.collectActions(hand.cards, library, saved);
  assert.strictEqual(decide().selected.id, 'M17', 'actual faulty-run rev4 hand now earns Engage before True');
  assert.strictEqual(decide().selected.details.searchTarget.id, 'M06', 'retain actual Allure/Raye target policy');
  assert.strictEqual(decision.collectActions(cards(['M13', 'M17', 'M20', 'M10']), library, saved).selected.id, 'M10',
    'established Toon fixed-search priority survives the gain exception');
  const deck = () => decision.buildDeckState(library, hand.cards, saved);
  for (const blocked of [
    { bambooSwordEquipped: true }, { rayeNormalSummoned: true }, { engageBlockedByMainMonster: true },
    { effectUsage: { M19_SEARCH: 1, KAGARI_RECOVERY: 1 } },
    { v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E10' } },
    { v5Branch: { active: true, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E04' } }
  ]) assert.strictEqual(gainPolicy.planTrueBambooGain(hand.cards, { ...saved, ...blocked }, deck()), null);
  const emptyDeck = { ...deck(), deckRemaining: { M19: 1 }, byId };
  assert.strictEqual(gainPolicy.planTrueBambooGain(hand.cards, saved, emptyDeck), null, 'no invented Engage target');

  const main = read('runtime/main-v6.js');
  const inputs = [];
  const ctx = vm.createContext({ ROOT, path, ...gainPolicy,
    ...require('./engine/lib/golden-bamboo-setup-policy'),
    ...require('./engine/lib/kagari-sword-plan'), console: { log() {} },
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    DECISION_STATE_PATH: 'MEMORY', writeJsonAtomic: (_, value) => { saved = value; },
    cardAtUserSlot: (s, slot) => s.cards[slot - 1],
    decrementUsedCount: (s, id) => { s.usedCounts[id]--; },
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library } : decision,
    runEquippedYotoLinkToOptionalAtomic: async opts => {
      assert.strictEqual(opts.equippedYoto, false); assert.strictEqual(opts.singleTargetLinkId, 'E02');
      assert.strictEqual(opts.materialCarrierId, 'E04'); assert.strictEqual(opts.requiredCarrierKind, 'EXTRA_LINK');
      assert.strictEqual(saved.v5Branch.currentState, 'KAGARI_LINK_BEFORE_TRUE_IN_FLIGHT');
      inputs.push('G1_LINK_KAGARI'); await opts.onOptionalPoolProven(); return { state: opts.state };
    },
    runKagariEffectToRecoveryPromptAtomic: async () => { inputs.push('H2'); },
    runKagariRecoveryCurrentPromptAtomic: async ({ state }) => {
      inputs.push('H3_RECOVER_ENGAGE'); return { state: { ...state, cards: cards([...state.cards.map(c => c.id), 'M17']) } };
    },
    equipSwordFromHand: async ({ state }) => { inputs.push('EQUIP_TRUE'); return { state, carrier: { id: 'E02' } }; },
    commitSwordEquipped: () => { saved.bambooSwordEquipped = true; },
  });
  vm.runInContext(slice(main, 'function branchCarrierId(', 'function hornetTrueYotoWindPlan(') +
    slice(main, 'function commitKagariRecoveryAccounting(', 'function canRecoverEngageAfterHornet(') +
    slice(main, 'async function executeFieldTransition(', 'async function executeAtomicResponseInterval(') +
    slice(main, 'async function prepareSwordForPlannedKagari(', 'function parseCommand('), ctx);
  const premature = await ctx.executeSelected({ state: hand, slot: 4 });
  assert.strictEqual(premature.executed, false); assert.strictEqual(inputs.length, 0, 'manual/stale True selection cannot bypass gain');
  // Simulate a proven first Engage resolution; actual physical Engage remains
  // the existing mature executor. Then exercise actual G1/H2/H3/equip scheduling.
  inputs.push('ENGAGE_SEARCH'); saved.usedCounts.M17 = 1; saved.graveSpellCount++;
  hand.cards = cards(['M13', 'M16', 'M20', 'M06']);
  assert.strictEqual(decide().selected.specialAction, 'KAGARI_LINK_BEFORE_TRUE');
  await ctx.executeKagariLinkBeforeTrue({ state: hand });
  assert.strictEqual(saved.v5Branch.currentState, 'KAGARI_EFFECT_PENDING');
  await assert.rejects(ctx.executeSelected({ state: hand, slot: 3 }), /GAIN_TRANSACTION_PENDING/,
    'cannot equip True while the Kagari recovery transaction owns the modal');
  await ctx.executeFieldTransition({ state: hand });
  hand = (await ctx.executeFieldTransition({ state: hand })).state;
  assert.strictEqual(saved.usedCounts.M17, 0); assert.strictEqual(saved.graveSpellCount, 3);
  assert.strictEqual(saved.effectUsage.KAGARI_RECOVERY, 1);
  assert.strictEqual(saved.v5Branch.trueBambooGainBeforeEquip, true);
  assert.strictEqual(decide().selected.id, 'M20', 'Kagari recovered: equip True first even with a live bonus Engage');
  // Below three the same atomic equip/conversion order remains valid.
  saved.graveSpellCount = 2;
  assert.strictEqual(decide().selected.id, 'M20');
  await ctx.executeSelected({ state: hand, slot: hand.cards.find(c => c.id === 'M20').index });
  assert.deepStrictEqual(inputs, ['ENGAGE_SEARCH', 'G1_LINK_KAGARI', 'H2', 'H3_RECOVER_ENGAGE', 'EQUIP_TRUE']);

  const atom = read('execution/core/atomic-route-executor.js');
  const atomCtx = vm.createContext({});
  vm.runInContext(slice(atom, 'function buildUnequippedKagariGainProof(', 'function semanticDetailRoles('), atomCtx);
  assert.throws(() => atomCtx.buildYotoSingleLinkResolutionProof('E02', { visible: true, candidateCount: 1 }), /ID_INVALID/,
    'equipped Yoto route still excludes Kagari');
  assert.throws(() => atomCtx.buildUnequippedKagariGainProof('E10', { visible: true, candidateCount: 1 }), /NOT_PROVEN/);
  assert.throws(() => atomCtx.buildUnequippedKagariGainProof('E02', { visible: false, candidateCount: 1 }), /NOT_PROVEN/);
  assert.strictEqual(atomCtx.buildUnequippedKagariGainProof('E02', { visible: true, candidateCount: 1 }).expectedLinkId, 'E02');

  // Exercise the actual G1 executor's parameter gate and one-atom dispatch.
  const physical = [];
  const atomInputCtx = vm.createContext({ ROOT, path, ROUTE_ROOT: 'MEMORY', timestampId: () => 'OFFLINE',
    ensureDir() {}, console: { log() {} }, loadLibrary: () => library, loadTemplates: async () => ({}),
    sleep: async () => {}, startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    require: () => ({ observeAdjacentLogEventually: async () => { throw new Error('UNEXPECTED_LOG_REPLAY'); } }),
    clickExtraDeckSummonButton: async () => { physical.push('EXTRA'); },
    waitForSummonCandidates: async () => ({}),
    selectSpecificLink: async opts => { assert.strictEqual(opts.targetId, 'E02'); return { selected: { id: 'E02' } }; },
    clickBottomSummonSubmit: async () => { physical.push('SUBMIT'); },
    choosePreferredEquipCarrier: async opts => {
      assert.strictEqual(opts.requiredKind, 'EXTRA_LINK'); return { kind: 'EXTRA_LINK', reference: { x: 844, y: 520 } }; },
    proveCarrierMaterialSelectable: async () => {}, clickCarrierMaterial: async () => { physical.push('MATERIAL'); },
    clickMaterialBlueConfirm: async () => { physical.push('CONFIRM'); },
    waitForPostLinkOptionalPool: async () => ({ visible: true, candidateCount: 1 })
  });
  vm.runInContext(slice(atom, 'async function runEquippedYotoLinkToOptionalAtomic(', 'function semanticDetailRoles('), atomInputCtx);
  for (const invalid of [
    { singleTargetLinkId: 'E02', equippedYoto: true },
    { singleTargetLinkId: 'E02', equippedYoto: false, materialCarrierId: 'E10', requiredCarrierKind: 'EXTRA_LINK' },
    { singleTargetLinkId: 'E02', equippedYoto: false, materialCarrierId: 'E04', requiredCarrierKind: 'CENTRAL_MAIN' }
  ]) await assert.rejects(atomInputCtx.runEquippedYotoLinkToOptionalAtomic(invalid), /TARGET_UNSUPPORTED/);
  assert.strictEqual(physical.length, 0, 'equipped/last/E10/wrong-zone Kagari request rejected before input');
  let checkpoint = 0;
  const atomResult = await atomInputCtx.runEquippedYotoLinkToOptionalAtomic({
    state: hand, singleTargetLinkId: 'E02', equippedYoto: false, materialCarrierId: 'E04', requiredCarrierKind: 'EXTRA_LINK',
    onOptionalPoolProven: () => { checkpoint++; }
  });
  assert.strictEqual(atomResult.targetLinkId, 'E02'); assert.strictEqual(checkpoint, 1);
  assert.deepStrictEqual(physical, ['EXTRA', 'SUBMIT', 'MATERIAL', 'CONFIRM']);
  console.log('TRUE_BAMBOO_ROOT_AND_GAIN_OFFLINE_PASS; historical false PASS reproduced; modal+stable3 zero-input; Engage->Kagari->recover->equip; last-equip/E10/spent-Kagari protected; GUI_INPUTS=0');
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { test };
