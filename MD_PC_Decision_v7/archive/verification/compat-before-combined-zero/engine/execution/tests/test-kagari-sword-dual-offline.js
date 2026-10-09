'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const byId = Object.fromEntries(library.cards.map(c => [c.id, c]));
const policy = require('../../lib/kagari-sword-plan');
const bamboo = require('../../lib/yoto-search-value');
const gain = require('../../lib/true-bamboo-gain-policy');
const proof = require('../../lib/known-multi-gain-proof');
const { commitRecognizedInsertions } = require('../../lib/incremental-hand-locator');
const cards = ids => ids.map((id, i) => ({ id, name: byId[id].name, index: i + 1, usable: true }));
const state = ids => ({ revision: 7, handCount: ids.length, cards: cards(ids) });
const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
const atoms = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
const ledgerSource = fs.readFileSync(path.join(ROOT, 'lib/main-deck-ledger.js'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
const runtime = material => ({ graveSpellCount: 3, bambooSwordEquipped: false,
  usedCounts: { M17: 1 }, effectUsage: { M19_SEARCH: 1 },
  v5Branch: { active: material === 'TOKEN_SKY_STRIKER',
    currentState: material === 'TOKEN_SKY_STRIKER' ? 'HORNET_TOKEN_READY' : 'YOTO_SEARCH_DONE', carrierId: material } });
const deck = { deckRemaining: { M19: 2, M20: 0, M14: 2, M06: 1 }, byId };
const plan = (ids, r = runtime('E04'), d = deck, material = 'E04') =>
  policy.planKagariSwordPreparation(cards(ids), r, d, material);
assert.strictEqual(plan(['M19', 'M20']).plannedSwordId, 'M19');
assert.strictEqual(plan(['M20']).plannedSwordId, 'M20');
assert.strictEqual(plan(['M20'], runtime('E04'), { ...deck, deckRemaining: { M19: 1, M14: 2 } }), null,
  'True conversion consumes its deck Yoto; it cannot pretend the same Yoto is a spare');
assert.strictEqual(plan(['M19'], runtime('E04'), { ...deck, deckRemaining: { M20: 1 } }).continuation.searchId, 'M20');
assert.strictEqual(plan(['M19', 'M14'], runtime('E04'), { ...deck, deckRemaining: { M19: 1, M14: 1 } }), null);
assert.strictEqual(plan(['M20', 'M14'], runtime('E04')), null, 'held Golden needs an immediate spare after converting True');
for (const material of ['E10', 'E02', 'M06', 'UNKNOWN']) assert.strictEqual(plan(['M20'], runtime(material), deck, material), null);
for (const patch of [{ usedCounts: {} }, { effectUsage: { KAGARI_RECOVERY: 1 } }, { bambooSwordEquipped: true }])
  assert.strictEqual(plan(['M20'], { ...runtime('E04'), ...patch }), null);

async function runCase(ids, material, { badPool = false, failAfterCl1 = false, failAfterCl2 = false, badGain = false,
  failAfterSecondM19 = false, failAfterFirstSearch = false, initialGrave = 3 } = {}) {
  const triple = ids.filter(id => id === 'M19').length === 2;
  const gainCount = triple ? 3 : 2;
  let saved = runtime(material), held = state(ids), remaining = { ...deck.deckRemaining };
  saved.graveSpellCount = initialGrave;
  // A hand Yoto is not also in Deck.
  remaining.M19 -= ids.filter(id => id === 'M19').length;
  if (triple) remaining.M20 = 1;
  let currentPoolCount = badPool ? 1 : gainCount, blocks = [], infoCount = 0, failedLedger = false;
  let selectedM19Count = 0, selectedSearchCount = 0;
  let selectedBamboo = 'M14';
  const calls = [], writes = new Map();
  let ledger = { lastHandRevision: held.revision, outsideDeckCounts: ids.reduce((counts, id) =>
    (counts[id] = (counts[id] || 0) + 1, counts), { M17: 1 }) };
  const ledgerCtx = vm.createContext({ console: { log() {} }, loadLibrary: () => library,
    getExistingLedger: () => structuredClone(ledger), validateLedger() {},
    countById: list => list.reduce((a, c) => (a[c.id] = (a[c.id] || 0) + 1, a), {}),
    bumpOutside: (_, value, id, n) => { value.outsideDeckCounts[id] = (value.outsideDeckCounts[id] || 0) + n; },
    persistLedger: value => { if (failedLedger) throw new Error('OFFLINE_LEDGER_FAILURE'); ledger = value; }
  });
  vm.runInContext(section(ledgerSource, 'function commitKnownAtomicHandGains(', '\nfunction '), ledgerCtx);
  const physical = vm.createContext({ ROOT, path, ROUTE_ROOT: 'MEMORY',
    HAND_STATE_PATH: 'HAND', INCREMENTAL_PATH: 'INCREMENTAL', DUEL_LOG_RESULT_PATH: 'LOG',
    ensureDir() {}, timestampId: () => 'OFFLINE', console: { log() {} },
    sleep: async () => {}, loadLibrary: () => library, loadTemplates: async () => ({}),
    startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    require: name => {
      if (name.endsWith('branch-adjacent-observer')) return {};
      if (name.endsWith('capture-hand-scroll-segments-live')) return { readOwnHandCount: async () => infoCount };
      if (name.endsWith('hand-info-overlay')) return { loadInfoDigitTemplates: () => [] };
      if (name.endsWith('test-duel-log-live')) return { runDuelLogLive: async () => {} };
      if (name.endsWith('known-multi-gain-proof')) return proof;
      throw new Error(`Unexpected physical require:${name}`);
    },
    clickExtraDeckSummonButton: async () => calls.push('OPEN_EXTRA'),
    waitForSummonCandidates: async () => ({}),
    selectSpecificLink: async opts => { assert.strictEqual(opts.targetId, 'E02'); assert.strictEqual(opts.carrierId, material);
      calls.push('SELECT_E02'); return { selected: { id: 'E02' } }; },
    clickBottomSummonSubmit: async () => calls.push('SUBMIT_LINK'),
    choosePreferredEquipCarrier: async opts => {
      assert.strictEqual(opts.requiredKind, material === 'TOKEN_SKY_STRIKER' ? 'CENTRAL_MAIN' : 'EXTRA_LINK');
      return { kind: opts.requiredKind, reference: { x: 840, y: 540 } };
    },
    proveCarrierMaterialSelectable: async () => {}, clickCarrierMaterial: async () => calls.push('MATERIAL'),
    clickMaterialBlueConfirm: async () => calls.push('CONFIRM_MATERIAL'),
    waitForPostLinkOptionalPool: async () => ({ visible: true, candidateCount: currentPoolCount }),
    selectM19FromOptionalPool: async opts => {
      assert.strictEqual(opts.expectedPoolCount, gainCount - selectedM19Count);
      selectedM19Count++; calls.push(selectedM19Count === 1 ? 'CL1_M19' : 'CL2_M19'); return { id: 'M19' };
    },
    waitOptionalPool: async () => {
      if ((failAfterCl1 && selectedM19Count === 1) || (failAfterSecondM19 && selectedM19Count === 2)) throw new Error('OFFLINE_POOL_ANIMATION_TIMEOUT');
      return { candidateCount: gainCount - selectedM19Count };
    },
    selectOptionalEffectById: async opts => {
      assert.strictEqual(opts.targetId, 'E02'); calls.push(triple ? 'CL3_E02' : 'CL2_E02');
      opts.onSubmitted?.({ selected: { id: opts.targetId } });
      if (failAfterCl2) throw new Error('OFFLINE_CL2_PRIORITY_TIMEOUT');
      return { id: opts.targetId };
    },
    waitSkyTargetPrompt: async () => ({}), waitForStableSkyTargetPoints: async () => [{}],
    selectKagariRecoveryTarget: async opts => {
      assert.strictEqual(opts.targetId, 'M17'); calls.push('RECOVER_M17');
      return { selected: { recognized: { accepted: true, id: 'M17' } } };
    },
    waitForBambooPromptAfterM19: async opts => {
      assert.strictEqual(opts.skipRemainingOptionalCancel, true);
      if (failAfterFirstSearch && selectedSearchCount === 1) throw new Error('OFFLINE_NEXT_BAMBOO_TIMEOUT');
      return {};
    },
    selectBambooSearchTarget: async opts => {
      assert.ok(calls.includes('RECOVER_M17')); selectedSearchCount++;
      selectedBamboo = triple && selectedSearchCount === 1 ? 'M20' : 'M14';
      if (triple) assert.strictEqual(opts.targetId, selectedBamboo);
      calls.push(triple ? `SEARCH_${selectedBamboo}` : 'SEARCH_BAMBOO');
      infoCount = held.handCount + gainCount;
      blocks = [...Array(triple ? 2 : 1)].map(() => ({ activationKey: 'M19', details: [] }));
      blocks.push({ activationKey: 'E02', details: [
        { role: 'HAND_GAIN', side: 'SELF', card: { id: 'M17' }, box: { y: 10 } },
        ...(triple ? [{ role: 'HAND_GAIN', side: 'SELF', card: { id: 'M20' }, box: { y: 20 } }] : []),
        { role: 'HAND_GAIN', side: 'SELF', card: { id: badGain ? 'M19' : selectedBamboo }, box: { y: 30 } }
      ] });
      return { selected: { id: selectedBamboo } };
    },
    commitRecognizedInsertions, countId: (s, id) => s.cards.filter(c => c.id === id).length,
    readJson: () => ({ operationBlocks: blocks }),
    writeJsonAtomic: (p, value) => writes.set(p, value),
    commitKnownAtomicHandGains: opts => ledgerCtx.commitKnownAtomicHandGains(opts)
  });
  vm.runInContext(section(atoms, 'async function runEquippedYotoLinkToOptionalAtomic(', 'function semanticDetailRoles(') +
    section(atoms, 'async function runBambooPromptToResolvedAtomic(', 'async function recoverClosedBambooPromptAtomic(') +
    section(atoms, 'async function recoverClosedBambooPromptAtomic(', 'async function runDualSelectM19CL1Atomic(') +
    section(atoms, 'async function runDualSelectM19CL1Atomic(', 'async function runRayeEffectToE10OptionalAtomic(') +
    section(atoms, 'async function verifyKnownMultiGainAtomic(', 'async function resumeKagariRecoveryCurrentPrompt('), physical);
  const ctx = vm.createContext({ ROOT, path, ...policy, ...bamboo, ...gain,
    console: { log() {} }, hornetTrueYotoWindPlan: () => null,
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    incrementUsedCount: (s, id) => { s.usedCounts[id] = (s.usedCounts[id] || 0) + 1; },
    decrementUsedCount: (s, id) => { s.usedCounts[id]--; },
    require: name => {
      if (name.endsWith('recognizer')) return { loadLibrary: () => library };
      if (name.endsWith('decision-engine')) return { buildDeckState: () => ({ deckRemaining: remaining, byId }) };
      if (name.endsWith('main-deck-ledger')) return { commitKnownDeckExit: id => { remaining[id]--; ledger.outsideDeckCounts[id] = (ledger.outsideDeckCounts[id] || 0) + 1; } };
      throw new Error(`Unexpected main require:${name}`);
    },
    equipSwordFromHand: async opts => {
      assert.strictEqual(opts.requiredCarrierKind, material === 'TOKEN_SKY_STRIKER' ? 'CENTRAL_MAIN' : 'EXTRA_LINK');
      calls.push(`EQUIP_${opts.cardId}`);
      const list = held.cards.map(c => c.id); list.splice(list.indexOf(opts.cardId), 1);
      held = { ...held, revision: held.revision + 1, handCount: list.length, cards: cards(list) };
      ledger.lastHandRevision = held.revision;
      return { state: held, carrier: { recognized: { id: material, accepted: true } } };
    },
    runM20FieldEffectToDeckPromptAtomic: async () => calls.push('TRUE_EFFECT'),
    runM20SelectYotoFromDeckAtomic: async () => calls.push('TRUE_SELECT_YOTO'),
    runM20EquipSelectedYotoAtomic: async opts => {
      assert.strictEqual(opts.requiredCarrierKind, material === 'TOKEN_SKY_STRIKER' ? 'CENTRAL_MAIN' : null);
      assert.strictEqual(opts.expectedCarrierId, material === 'TOKEN_SKY_STRIKER' ? null : material); calls.push('TRUE_EQUIP_YOTO');
    },
    runEquippedYotoLinkToOptionalAtomic: o => physical.runEquippedYotoLinkToOptionalAtomic(o),
    runDualSelectM19CL1Atomic: o => physical.runDualSelectM19CL1Atomic(o),
    runDualSelectE10CL2ToTargetPromptAtomic: o => physical.runDualSelectE10CL2ToTargetPromptAtomic(o),
    runDualE10TargetToBambooPromptAtomic: o => physical.runDualE10TargetToBambooPromptAtomic(o),
    runBambooPromptToResolvedAtomic: o => physical.runBambooPromptToResolvedAtomic(o),
    recoverClosedBambooPromptAtomic: o => physical.recoverClosedBambooPromptAtomic(o)
  });
  vm.runInContext(section(main, 'function branchCarrierId(', 'function hornetTrueYotoWindPlan(') +
    section(main, 'function isHornetTokenSwordRoute(', 'function commitRayeNormalSummonAtomic(') +
    section(main, 'function commitAfterYotoResolution(', 'function normalizeCards(') +
    section(main, 'async function executeFieldTransition(', 'async function executeAtomicResponseInterval(') +
    section(main, 'async function prepareSwordForPlannedKagari(', 'async function executeSelected('), ctx);
  if (material === 'TOKEN_SKY_STRIKER') held = (await ctx.executeFieldTransition({ state: held })).state;
  else if (triple) held = (await ctx.prepareSwordForPlannedKagari(held, saved, material)).state;
  else held = (await ctx.executeKagariLinkBeforeTrue({ state: held })).state;
  if (ids.includes('M20') && !ids.includes('M19')) {
    for (let n = 0; n < 3; n++) await ctx.executeFieldTransition({ state: held });
    assert.strictEqual(remaining.M19, 1);
    assert.strictEqual(saved.graveSpellCount, 4);
  }
  assert.strictEqual(saved.v5Branch.currentState, 'M19_EQUIPPED');
  if (triple) {
    held = (await ctx.executeFieldTransition({ state: held })).state;
    assert.strictEqual(saved.equippedBambooCounts.M19, 2);
    assert.strictEqual(saved.bambooSwordEquipped, true);
    assert.strictEqual(calls.filter(c => c === 'EQUIP_M19').length, 2);
    const resources = bamboo.summarizeBambooEquipResources(remaining, held.cards, { runtime: saved, byId });
    assert.strictEqual(resources.fieldCount, 2); assert.strictEqual(resources.byId.M19.field, 2);
  }
  if (badPool) {
    await assert.rejects(ctx.executeFieldTransition({ state: held }), /OPTIONAL_POOL_INVALID/);
    assert.strictEqual(saved.v5Branch.currentState, 'KAGARI_SWORD_LINK_IN_FLIGHT');
    const before = calls.length; await ctx.executeFieldTransition({ state: held }); assert.strictEqual(calls.length, before);
    return;
  }
  await ctx.executeFieldTransition({ state: held });
  assert.strictEqual(saved.v5Branch.carrierId, 'E02');
  assert.strictEqual(saved.bambooSwordEquipped, false);
  if (failAfterCl1) {
    await assert.rejects(ctx.executeFieldTransition({ state: held }), /POOL_ANIMATION_TIMEOUT/);
    assert.strictEqual(saved.v5Branch.currentState, 'DUAL_M19_CL1_SELECTED');
    await ctx.executeFieldTransition({ state: held });
    assert.strictEqual(calls.filter(c => c === 'CL1_M19').length, 1);
    return;
  }
  if (failAfterCl2) {
    await ctx.executeFieldTransition({ state: held });
    if (triple) await ctx.executeFieldTransition({ state: held });
    await assert.rejects(ctx.executeFieldTransition({ state: held }), /CL2_PRIORITY_TIMEOUT/);
    assert.strictEqual(saved.v5Branch.currentState, 'DUAL_E10_TARGET_PROMPT');
    await ctx.executeFieldTransition({ state: held });
    assert.strictEqual(calls.filter(c => c === (triple ? 'CL3_E02' : 'CL2_E02')).length, 1);
    return;
  }
  if (failAfterSecondM19) {
    await ctx.executeFieldTransition({ state: held });
    await assert.rejects(ctx.executeFieldTransition({ state: held }), /POOL_ANIMATION_TIMEOUT/);
    assert.strictEqual(saved.v5Branch.currentState, 'TRIPLE_M19_CL2_SELECTED');
    await ctx.executeFieldTransition({ state: held });
    assert.strictEqual(calls.filter(c => c === 'CL2_M19').length, 1);
    return;
  }
  for (let n = 0; n < 3; n++) await ctx.executeFieldTransition({ state: held });
  if (triple) await ctx.executeFieldTransition({ state: held });
  assert.strictEqual(saved.v5Branch.currentState, 'DUAL_M19_BAMBOO_PROMPT');
  if (triple) {
    if (failAfterFirstSearch) await assert.rejects(ctx.executeFieldTransition({ state: held }), /NEXT_BAMBOO_TIMEOUT/);
    else await ctx.executeFieldTransition({ state: held });
    assert.strictEqual(saved.v5Branch.currentState, 'TRIPLE_SECOND_BAMBOO_PROMPT');
    assert.strictEqual(saved.v5Branch.bambooGainIds[0], 'M20');
    assert.strictEqual(writes.has('HAND'), false, 'partial gain cannot prematurely commit hand/ledger');
  }
  if (badGain) {
    await assert.rejects(ctx.executeFieldTransition({ state: held }), /RIGHT_LOG_GAIN_NOT_UNIQUE/);
    assert.strictEqual(writes.has('HAND'), false); assert.strictEqual(saved.effectUsage.KAGARI_RECOVERY, undefined);
    blocks.at(-1).details.at(-1).card.id = selectedBamboo;
  }
  const final = await ctx.executeFieldTransition({ state: held });
  assert.strictEqual(final.state.handCount, held.handCount + gainCount);
  assert.strictEqual(final.state.cards.filter(c => c.id === 'M17').length, 1);
  assert.strictEqual(final.state.cards.filter(c => c.id === 'M14').length, 1);
  assert.strictEqual(saved.graveSpellCount, initialGrave + (triple || (ids.includes('M20') && !ids.includes('M19')) ? 1 : 0));
  assert.strictEqual(saved.usedCounts.M17, 0); assert.strictEqual(saved.effectUsage.KAGARI_RECOVERY, 1);
  assert.strictEqual(saved.effectUsage.M19_SEARCH, triple ? 3 : 2); assert.strictEqual(saved.v5Branch.carrierId, 'E02');
  assert.strictEqual(saved.v5Branch.currentState, 'KAGARI_RECOVERY_DONE'); assert.strictEqual(saved.v5Branch.active, false);
  assert.strictEqual(saved.v5Branch.trueBambooGainBeforeEquip, true, 'keep route provenance, not a post-Kagari priority override');
  if (final.state.cards.some(c => c.id === 'M20')) {
    assert.strictEqual(gain.planTrueBambooGain(final.state.cards, saved,
      { deckRemaining: remaining, byId, remainingMainDeck: 10 }), null,
      'spent Kagari: no gain-policy override of atomic True equip');
  }
  assert.strictEqual(calls.filter(c => /^SEARCH_/.test(c)).length, triple ? 2 : 1, 'retry only proves results, never resubmits a closed search');
  assert.strictEqual(ledger.outsideDeckCounts.M17, 1, 'grave recovery must not consume another deck Engage');
  assert.strictEqual(ledger.outsideDeckCounts.M14, 1);
  assert.deepStrictEqual(calls.filter(c => /CL1|CL2|CL3|RECOVER|SEARCH/.test(c)), triple
    ? ['CL1_M19', 'CL2_M19', 'CL3_E02', 'RECOVER_M17', 'SEARCH_M20', 'SEARCH_M14']
    : ['CL1_M19', 'CL2_E02', 'RECOVER_M17', 'SEARCH_BAMBOO']);
  if (triple) {
    assert.strictEqual(ledger.outsideDeckCounts.M20, 1);
    assert.strictEqual(saved.equipSentToGraveCount, 2);
    assert.strictEqual(saved.equippedBambooCounts.M19, undefined);
    const finalEquip = require('../../lib/golden-bamboo-setup-policy').planGoldenBambooSetup(final.state.cards,
      saved, { deckRemaining: remaining, byId });
    assert.strictEqual(finalEquip.sword.id, 'M20');
    assert.strictEqual(finalEquip.convertsTrue, false, 'both Yotos are out; final True stays to enable draw2');
    return;
  }
  const prior = JSON.stringify(ledger);
  failedLedger = true; physical.readJson = () => ({ operationBlocks: blocks }); infoCount = final.state.handCount + 2;
  await assert.rejects(physical.verifyKnownMultiGainAtomic({ state: final.state, gains: [
    { id: 'M17', activationKey: 'E02', fromDeck: false }, { id: 'M14', activationKey: 'M19', fromDeck: true }
  ], label: 'ROLLBACK' }), /POST_HAND_INVALID|LEDGER_FAILURE/);
  assert.strictEqual(JSON.stringify(ledger), prior);
  assert.strictEqual(writes.get('HAND').revision, final.state.revision, 'failed ledger restores prior hand');
}

(async () => {
  // Real equip executor: a different carrier may be highlighted for diagnosis,
  // but must never receive the irreversible equip confirmation.
  let confirmCalls = 0, observerCalls = 0;
  const equipCtx = vm.createContext({ ROOT, path, console: { log() {} },
    loadLibrary: () => library, loadTemplates: async () => [], sleep: async () => {},
    startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    selectCurrentObservedHandCard: async () => ({ selected: { id: 'M19' }, slot: 1 }),
    clickSelectedHandSpellActivation: async () => {},
    clickPreferredEquipCarrier: async () => ({ recognized: { accepted: true, id: 'E05' } }),
    clickObservedEquipConfirm: async () => { confirmCalls++; },
    runObserver: () => { observerCalls++; }
  });
  vm.runInContext(section(atoms, 'async function equipSwordFromHand(', 'async function clickRayeNormalSummonButton('), equipCtx);
  await assert.rejects(equipCtx.equipSwordFromHand({ state: state(['M19']), cardId: 'M19',
    debugDir: 'MEMORY', expectedCarrierId: 'E04' }), /CARRIER_NOT_PROVEN/);
  assert.strictEqual(confirmCalls, 0); assert.strictEqual(observerCalls, 0);
  const activationEvents = [];
  const activation = vm.createContext({ config: {}, console: { log() {} },
    waitOptionalPool: async () => ({}), OPTIONAL_EFFECT_PROMPT: {},
    selectExactPromptCard: async () => ({ recognized: { id: 'E02', name: '火刀' } }),
    clickYellowButton: async () => activationEvents.push('SUBMIT'),
    waitForSelfPriorityBlue: async () => { activationEvents.push('PRIORITY'); throw new Error('OFFLINE_PRIORITY_TIMEOUT'); }
  });
  vm.runInContext(section(atoms, 'async function selectOptionalEffectById(', 'async function waitSkyTargetPrompt('), activation);
  await assert.rejects(activation.selectOptionalEffectById({ targetId: 'E02',
    onSubmitted: () => activationEvents.push('CHECKPOINT') }), /PRIORITY_TIMEOUT/);
  assert.deepStrictEqual(activationEvents, ['SUBMIT', 'CHECKPOINT', 'PRIORITY']);
  const rows = [{ id: 'M17', activationKey: 'E02', fromDeck: false },
    { id: 'M14', activationKey: 'M19', fromDeck: true }];
  const exact = [{ activationKey: 'M19', details: [{ role: 'HAND_GAIN', side: 'SELF', card: { id: 'M14' } }] },
    { activationKey: 'E02', details: [{ role: 'HAND_GAIN', side: 'SELF', card: { id: 'M17' } }] }];
  assert.strictEqual(proof.proveKnownMultiGainBlocks(exact, rows).pass, true);
  assert.strictEqual(proof.proveKnownMultiGainBlocks(exact, [{ ...rows[0], fromDeck: true }, rows[1]]).pass, false);
  exact[1].details[0].side = 'OPPONENT';
  assert.strictEqual(proof.proveKnownMultiGainBlocks(exact, rows).pass, false);
  let secondSelected = null;
  const oldDual = vm.createContext({ ROOT, path, ROUTE_ROOT: 'MEMORY', timestampId: () => 'OFFLINE', ensureDir() {},
    console: { log() {} }, loadLibrary: () => library, loadTemplates: async () => [], sleep: async () => {},
    startBridge: async () => ({ bridge: { stop: async () => {} }, info: {} }),
    selectOptionalEffectById: async opts => { secondSelected = opts.targetId; return {}; },
    waitSkyTargetPrompt: async () => ({}), waitForStableSkyTargetPoints: async () => [] });
  vm.runInContext(section(atoms, 'async function runDualSelectE10CL2ToTargetPromptAtomic(',
    'async function runDualE10TargetToBambooPromptAtomic('), oldDual);
  await oldDual.runDualSelectE10CL2ToTargetPromptAtomic({ state: state([]) });
  assert.strictEqual(secondSelected, 'E10', 'legacy Zeke dual keeps its default second actor');
  await assert.rejects(oldDual.runDualSelectE10CL2ToTargetPromptAtomic({ state: state([]), secondEffectId: 'E03' }), /UNSUPPORTED/);
  for (const material of ['E03', 'E04', 'E05', 'TOKEN_SKY_STRIKER']) {
    await runCase(['M19', 'M20'], material); await runCase(['M20'], material);
  }
  await runCase(['M19', 'M20'], 'E04', { badPool: true });
  await runCase(['M19', 'M20'], 'E04', { failAfterCl1: true });
  await runCase(['M19', 'M20'], 'E04', { failAfterCl2: true });
  await runCase(['M19', 'M20'], 'E04', { badGain: true });
  for (const material of ['E03', 'E04', 'E05', 'TOKEN_SKY_STRIKER']) await runCase(['M12', 'M19', 'M19'], material);
  await runCase(['M01', 'M12', 'M19', 'M19'], 'TOKEN_SKY_STRIKER');
  await runCase(['M01', 'M12', 'M19', 'M19'], 'TOKEN_SKY_STRIKER', { initialGrave: 2 });
  for (const options of [{ badPool: true }, { failAfterCl1: true }, { failAfterCl2: true },
    { failAfterSecondM19: true }, { failAfterFirstSearch: true }, { badGain: true }]) {
    await runCase(['M12', 'M19', 'M19'], 'TOKEN_SKY_STRIKER', options);
  }
  console.log('KAGARI_SWORD_DUAL_OFFLINE_PASS; production scheduler+atoms+ledger; single/2 Yotos; token/3 Links; optional 3->2->1; reverse Engage/True/Golden gains; final True draw2; partial-chain rollback/no replay; nativeInputs=0');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
