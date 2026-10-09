'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const locator = require('../../lib/incremental-hand-locator');
const policy = require('../../lib/exodia-policy');
const library = require('../../card-library.json');
const saved = require('../../material/issues/issue-113-m21-incremental.json');
const log = require('../../material/issues/issue-113-m21-log.json');

const ids = cards => cards.map(card => card.id);
const indexed = cards => cards.map((card, index) => ({ ...card, index: index + 1 }));
const component = policy.normalizeExodiaComponentCard({ id: 'M03' });
function fieldDraw(cards) {
  return {
    activationKey: 'M21',
    relationship: { type: 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD' },
    details: cards.map(card => ({ side: 'SELF', role: 'HAND_GAIN_CANDIDATE', card, confidenceMargin: 0.1 }))
  };
}
function assertOldOrder(inference) {
  for (const scenario of inference.scenarios) {
    assert.deepStrictEqual(scenario.oldMappings.map(row => row.cardId), ids(inference.remaining));
    const positions = scenario.oldMappings.map(row => row.afterSlot);
    assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b));
  }
}

(async () => {
  // Replay the real M21 event through the production locator and insertion
  // block. Do not override success or predicted slots as ISSUE-112's test did.
  const block = log.newOperationBlocks.find(row => row.activationKey === 'M21');
  const inference = locator.inferIncrementalSlots(saved.before.cards, block, 5, library);
  assert.strictEqual(inference.success, true);
  assert.deepStrictEqual(inference.predictedSlots, [5]);
  assertOldOrder(inference);
  const source = fs.readFileSync(path.resolve(__dirname, '../../runtime/observer/observe-hand-change-incremental-live.js'), 'utf8');
  const start = source.indexOf('    const clickStageStarted =');
  const end = source.indexOf('    timer.stages.push({', start);
  assert.ok(start >= 0 && end > start);
  let clicks = 0;
  const context = vm.createContext({
    process, Map, console: { log() {}, error() {} }, inference, library,
    PERSISTENT_EXODIA_IDS: policy.buildExodiaComponentSet(),
    EXODIA_UNKNOWN_ID: policy.EXODIA_UNKNOWN_ID,
    normalizeExodiaComponentCard: policy.normalizeExodiaComponentCard,
    inferPersistentExodiaAtSlot: locator.inferPersistentExodiaAtSlot,
    strongCertainInsertion: () => null,
    assertNoNewHandClicks: slots => assert.deepStrictEqual([...slots], []),
    info: {}, observedHandCount: 5, templates: [],
    bridge: { info: async () => ({}), click: async () => { clicks++; }, key: async () => {} },
    validateClient() {}, mapReferencePoint: (_info, point) => point, sleep: async () => {},
    locateSlotWithoutHandClick: async () => { throw new Error('FORBIDDEN_NEW_CARD_PROBE'); },
    recognizeCurrentCard: async () => { throw new Error('FORBIDDEN_NEW_CARD_RECOGNITION'); },
    config: { mouseSettleMs: 0, handFan: { slotResetSettleMs: 0 } }
  });
  const result = await vm.runInContext(`(async()=>{${source.slice(start, end)};return {insertedCards,finalClicks};})()`, context);
  const inserted = JSON.parse(JSON.stringify(result.insertedCards));
  const committed = locator.commitInsertionsAtSlots(inference.remaining, inserted, 5);
  assert.deepStrictEqual(ids(committed), ['EXODIA_UNKNOWN', 'M06', 'M11', 'M14', 'M18']);
  assert.deepStrictEqual(committed.map(card => card.index), [1, 2, 3, 4, 5]);
  assert.strictEqual(clicks, 0);
  assert.strictEqual(result.finalClicks[0].physicalClicksIssued, 0);
  assert.deepStrictEqual(ids(locator.commitRecognizedInsertions(saved.before.cards, [inserted[0].card], library)), ids(committed));
  // The known-gain atomic adapters formerly repeated the same raw sort and
  // moved EXODIA_UNKNOWN to the end. Execute their actual provisional blocks.
  const atomic = fs.readFileSync(path.resolve(__dirname, '../core/atomic-route-executor.js'), 'utf8');
  let offset = 0;
  for (const gains of [[{ id: 'M17' }], [{ id: 'M17' }, { id: 'M22' }]]) {
    const a = atomic.indexOf('  const provisionalCards = commitRecognizedInsertions', offset);
    const b = atomic.indexOf('  const provisional =', a);
    assert.ok(a >= offset && b > a);
    offset = b;
    const output = vm.runInNewContext(`${atomic.slice(a, b)}; provisionalCards`, {
      commitRecognizedInsertions: locator.commitRecognizedInsertions,
      state: saved.before, library, gainMeta: gains[0],
      rows: gains.map((meta, index) => ({ meta, token: `gain-${index}` }))
    });
    assert.deepStrictEqual(ids(output).slice(0, 4), ids(saved.before.cards));
    assert.deepStrictEqual(ids(output).slice(4), ids(gains));
    assert.strictEqual(output[4].index, 5);
  }

  // Every ordinary main-deck draw with zero through four aggregate components
  // must preserve old order; component count cannot shift an ordinary slot.
  for (let count = 0; count <= 4; count++) {
    const before = indexed([...Array.from({ length: count }, () => ({ ...component })), { id: 'M06' }, { id: 'M11' }, { id: 'M14' }]);
    for (const card of library.cards.filter(row => /^M\d+$/.test(row.id) && !policy.isExodiaComponentId(row.id))) {
      const inferred = locator.inferIncrementalSlots(before, fieldDraw([card]), before.length + 1, library);
      assert.strictEqual(inferred.success, true, `${count}:${card.id}`);
      assertOldOrder(inferred);
      assert.ok(inferred.predictedSlots[0] > count);
      const after = locator.commitInsertionsAtSlots(inferred.remaining, [{ slot: inferred.predictedSlots[0], card }], before.length + 1);
      assert.strictEqual(policy.countExodiaComponents(after), count);
    }
  }

  // Inside the component band all placements have the same class/count hand
  // and ordinary-card slots. Do not stop or probe to identify which component
  // moved: accept a canonical equivalent layout, not an exact physical ID.
  const before = indexed([component, component, { id: 'M06' }]);
  for (const id of [...policy.EXODIA_COMPONENT_IDS, policy.EXODIA_UNKNOWN_ID]) {
    const drawn = id === policy.EXODIA_UNKNOWN_ID ? component : { id };
    const inferred = locator.inferIncrementalSlots(before, fieldDraw([drawn]), 4, library);
    assert.strictEqual(inferred.success, true);
    assert.strictEqual(inferred.componentEquivalentLayout, true);
    assert.deepStrictEqual(inferred.predictedSlots, [3]);
    assert.deepStrictEqual(inferred.scenarios.map(row => row.newSlots), [[3], [2], [1]]);
    assertOldOrder(inferred);
    const after = locator.commitRecognizedInsertions(before, [drawn], library);
    assert.strictEqual(policy.countExodiaComponents(after), 3);
    assert.strictEqual(after[3].id, 'M06');
  }
  const mixed = locator.inferIncrementalSlots(before, fieldDraw([{ id: 'M05' }, { id: 'M18' }]), 5, library);
  assert.strictEqual(mixed.componentEquivalentLayout, true);
  assert.deepStrictEqual(mixed.predictedSlots, [3, 5]);
  assert.deepStrictEqual(mixed.scenarios.map(row => row.newSlots), [[3, 5], [2, 5], [1, 5]]);
  assertOldOrder(mixed);
  // Unsound old ordering must never be silently sorted into invented mappings.
  const invalid = locator.inferIncrementalSlots(indexed([{ id: 'M18' }, { id: 'M06' }]), fieldDraw([{ id: 'M11' }]), 3, library);
  assert.strictEqual(invalid.success, false);
  assert.strictEqual(invalid.scenarios.length, 0);
  const classOnly = locator.inferPersistentExodiaAtSlot([{ id: 'M06', index: 1 }], [1], 1, library, [[component]]);
  assert.strictEqual(classOnly.id, policy.EXODIA_UNKNOWN_ID);
  // Unknown class versus an ordinary spell is a meaningful difference and
  // must still request passive position evidence rather than invent a draw.
  const unresolvedBlock = fieldDraw([{ id: 'M03' }]);
  unresolvedBlock.details[0].confidenceMargin = 0;
  unresolvedBlock.details[0].top3 = [{ id: 'M03' }, { id: 'M09' }];
  const unresolved = locator.inferIncrementalSlots(before, unresolvedBlock, 4, library);
  assert.strictEqual(unresolved.success, false);
  assert.strictEqual(unresolved.componentEquivalentLayout, undefined);
  assert.strictEqual(unresolved.reason, 'NEW_SLOT_NOT_UNIQUE_ACROSS_LOG_CANDIDATES');
  console.log('EXODIA_INCREMENTAL_SLOT_ORDER_OFFLINE_PASS; ISSUE-113 real M21->M18@5; production insert clicks0; old-order invariant; equivalent component class/count layouts accepted');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
