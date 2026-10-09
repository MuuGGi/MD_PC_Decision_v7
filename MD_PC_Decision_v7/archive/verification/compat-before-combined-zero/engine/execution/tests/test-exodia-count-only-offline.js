'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const library = require('../../card-library.json');
const hand = require('../../material/issues/issue-112-hand-before.json');
const ledgerBefore = require('../../material/issues/issue-112-ledger-before.json');
const decisionBefore = require('../../material/issues/issue-112-decision-before.json');
const log = require('../../material/issues/issue-112-m09-log.json');
const locator = require('../../lib/incremental-hand-locator');
const policy = require('../../lib/exodia-policy');
const mallet = require('../../lib/mallet-policy');
const deadlock = require('../../lib/deadlock-detector');
const m13 = require('../../lib/m13-observer-verification');
const simpleDraw = require('../../lib/simple-draw-continuation-policy');
const observerSession = require('../../lib/duel-observer-session');

function segment(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

function loadWithMocks(relative, mocks) {
  const filename = path.join(ROOT, relative);
  const mod = { exports: {} };
  const nativeRequire = Module.createRequire(filename);
  vm.runInNewContext(read(relative), {
    module: mod,
    exports: mod.exports,
    __filename: filename,
    __dirname: path.dirname(filename),
    Buffer,
    process,
    console: { log() {}, error() {} },
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id)
  }, { filename });
  return mod.exports;
}

(async () => {
  const block = log.newOperationBlocks.find(row => row.activationKey === 'M09');
  assert.ok(block);
  const inference = locator.inferIncrementalSlots(hand.cards, block, 5, library);
  // The live passive before/after alignment already proved physical slot 1.
  inference.success = true;
  inference.predictedSlots = [1];
  const component = locator.inferPersistentExodiaAtSlot(
    inference.remaining,
    inference.predictedSlots,
    1,
    library,
    inference.candidateRows
  );
  assert.strictEqual(component.id, policy.EXODIA_UNKNOWN_ID);
  assert.strictEqual(component.persistentExodia, true);
  assert.deepStrictEqual(component.candidateIds, ['M01', 'M02', 'M03', 'M04', 'M05']);

  // Execute the production insertion block. Weak head/arm/leg pixels must
  // commit one class token with zero card clicks and zero safety stop.
  const observer = read('runtime/observer/observe-hand-change-incremental-live.js');
  const insertionCode = segment(observer, '    const clickStageStarted =', '    timer.stages.push({');
  let clicks = 0;
  const insertionContext = vm.createContext({
    process,
    Map,
    console: { log() {}, error() {} },
    inference,
    PERSISTENT_EXODIA_IDS: policy.buildExodiaComponentSet(),
    EXODIA_UNKNOWN_ID: policy.EXODIA_UNKNOWN_ID,
    normalizeExodiaComponentCard: policy.normalizeExodiaComponentCard,
    library,
    templates: [],
    inferPersistentExodiaAtSlot: locator.inferPersistentExodiaAtSlot,
    strongCertainInsertion: () => null,
    assertNoNewHandClicks: slots => {
      if (slots.length) throw new Error('UNEXPECTED_CLICK_SLOT');
    },
    info: {},
    observedHandCount: 5,
    bridge: { info: async () => ({}), click: async () => { clicks++; }, key: async () => {} },
    validateClient() {},
    mapReferencePoint: (_info, point) => point,
    sleep: async () => {},
    locateSlotWithoutHandClick: async () => { throw new Error('FORBIDDEN_NEW_CARD_PROBE'); },
    recognizeCurrentCard: async () => { throw new Error('FORBIDDEN_NEW_CARD_RECOGNITION'); },
    config: { mouseSettleMs: 0, handFan: { slotResetSettleMs: 0 } }
  });
  const inserted = await vm.runInContext(
    `(async()=>{${insertionCode};return {insertedCards,finalClicks};})()`,
    insertionContext
  );
  assert.strictEqual(clicks, 0);
  assert.strictEqual(inserted.insertedCards[0].card.id, policy.EXODIA_UNKNOWN_ID);
  assert.strictEqual(inserted.finalClicks[0].physicalClicksIssued, 0);

  // Commit through the real ledger code in memory: one aggregate component
  // leaves the Deck, exact M01-M05 counters remain deliberately unresolved.
  const files = new Map();
  const handPath = path.join(ROOT, 'debug/hand-change-live/session_state.json');
  const ledgerPath = path.join(ROOT, 'debug/main-deck-ledger/state.json');
  const libraryPath = path.join(ROOT, 'card-library.json');
  const decisionPath = path.join(ROOT, 'decision-state.json');
  const put = (filename, value) => files.set(filename, clone(value));
  put(handPath, hand);
  put(ledgerPath, ledgerBefore);
  put(libraryPath, library);
  put(decisionPath, decisionBefore);
  const runtimeFiles = {
    readJsonIfExistsSafe: filename => files.has(filename) ? clone(files.get(filename)) : null,
    writeJsonAtomic: (filename, value) => put(filename, value)
  };
  const ledgerModule = loadWithMocks('lib/main-deck-ledger.js', {
    './runtime-files': runtimeFiles,
    './m13-observer-verification': { verifyM13Observation: () => { throw new Error('UNUSED_M13'); } }
  });
  const after = {
    ...clone(hand),
    revision: 5,
    cards: [
      { ...component, index: 1 },
      ...hand.cards.filter(card => card.id !== 'M09').map((card, index) => ({ ...card, index: index + 2 }))
    ]
  };
  const incremental = {
    status: 'PASS',
    before: clone(hand),
    after,
    inference: { activationKey: 'M09' },
    insertedCards: [{ slot: 1, card: component }]
  };
  const committed = ledgerModule.applyIncrementalResultToMainDeckLedger({ incrementalResult: incremental, log });
  assert.strictEqual(committed.lastHandRevision, 5);
  assert.strictEqual(committed.unknownExodiaOutsideCount, 1);
  for (const id of policy.EXODIA_COMPONENT_IDS) {
    assert.strictEqual(committed.outsideDeckCounts[id], ledgerBefore.outsideDeckCounts[id]);
  }
  const deckState = ledgerModule.getSharedDeckState(library, after.cards, decisionBefore);
  assert.strictEqual(deckState.unknownExodiaOutsideCount, 1);
  assert.strictEqual(
    policy.adjustedMainDeckRemainingCount(deckState),
    Object.values(deckState.deckRemaining).reduce((sum, value) => sum + value, 0) - 1
  );

  const malletCards = [component, { id: 'M11' }, { id: 'M14' }];
  const malletPlan = mallet.buildMalletKeepPolicy({
    handCounts: { EXODIA_UNKNOWN: 1, M11: 1, M14: 1 },
    deckRemaining: { M01: 1, M02: 1, M03: 1, M04: 1, M05: 1, M14: 2 },
    unknownExodiaOutsideCount: 1,
    byId: {}
  }, malletCards, {});
  assert.ok(!malletPlan.keepIds.includes(policy.EXODIA_UNKNOWN_ID));
  assert.ok(malletPlan.returnableIds.includes(policy.EXODIA_UNKNOWN_ID));
  assert.strictEqual(malletPlan.protectExodiaComponents, false);

  const fiveUnknown = Array.from({ length: 5 }, (_, index) => ({
    ...policy.normalizeExodiaComponentCard({ id: `M0${index + 1}` }),
    index: index + 1
  }));
  assert.strictEqual(policy.countExodiaComponents(fiveUnknown), 5);
  assert.deepStrictEqual(
    observerSession.cleanCards([{ id: 'M03', name: '被封印的右腕', index: 1 }])
      .map(card => ({ id: card.id, index: card.index })),
    [{ id: policy.EXODIA_UNKNOWN_ID, index: 1 }]
  );
  assert.strictEqual(simpleDraw.classifySimpleDrawContinuation({
    handCount: 3,
    cards: [component, { id: 'M09', index: 2 }, { id: 'M08', index: 3 }]
      .map((card, index) => ({ ...card, index: index + 1 })),
    runtime: {}
  }, {
    selected: { id: 'M09', slot: 2, details: {} },
    runtime: {}
  }).automatic, true);
  assert.strictEqual(deadlock.analyzeReachableResourceDeadlock({
    cards: fiveUnknown,
    runtime: {},
    decisionResult: {
      deck: { deckRemaining: { M09: 1 }, unknownExodiaOutsideCount: 5 },
      actions: [],
      engageTargets: []
    }
  }).reason, 'EXODIA_COMPLETE_AWAIT_TERMINAL_OUTCOME');

  m13.verifyFinalMultiset({
    baseline: { cards: [{ id: 'M13' }, { id: 'M06' }, { id: 'M11' }] },
    selectedBanishId: 'M06',
    drawnIds: ['M03', 'M21'],
    finalCards: [component, { id: 'M11' }, { id: 'M21' }]
  });

  const main = read('runtime/main-v6.js');
  const m11Source = read('execution/live/run-m11-mallet-keep-weapon.js');
  const outcomeSource = read('lib/duel-outcome-detector.js');
  const banishSource = read('execution/core/m13-banish-selection.js');
  const lastResortSource = read('execution/core/m13-last-resort.js');
  assert.ok(main.includes('countExodiaComponents(state.cards)'));
  assert.ok(main.includes('EXODIA_UNKNOWN_ID'));
  assert.ok(m11Source.includes('normalizeMalletFinalExodia'));
  assert.ok(!outcomeSource.includes('unique.size === 5'));
  assert.ok(outcomeSource.includes('lastFiveIds.every(id => EXODIA_ID_SET.has(id))'));
  assert.ok(banishSource.includes('EXODIA_UNKNOWN_ID'));
  assert.ok(lastResortSource.includes('EXODIA_UNKNOWN_ID'));

  console.log(
    'EXODIA_COUNT_ONLY_OFFLINE_PASS; ISSUE-112 weak M09 draw -> EXODIA_UNKNOWN@slot1; ' +
    'no exact head/arm/leg dependency; clicks0; ledger aggregate1; conditional Mallet protection; five-count terminal gate'
  );
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
