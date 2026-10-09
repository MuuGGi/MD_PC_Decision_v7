'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const policy = require('../../lib/exodia-policy');
const { committedSelectionState } = require('../core/m11-mallet-completion');
const { verifyFinalMultiset: verifyAllure } = require('../../lib/m13-observer-verification');
const protectedPaths = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json',
  'debug/hand-change-live/latest_incremental_result.json', 'material/verified/verified-cards.json'];
const before = protectedPaths.map(rel => [rel, fs.existsSync(path.join(ROOT, rel))
  ? fs.readFileSync(path.join(ROOT, rel)) : null]);
const read = rel => fs.readFileSync(path.join(
  // Original pre-fix backups remain immutable in the formal evidence archive;
  // prepare deliberately excludes debug history from the isolated engine.
  rel.startsWith('debug/issue-119-shared-component-count/backup/') ? path.resolve(ROOT, '../..') : ROOT,
  rel), 'utf8');
const cards = ids => ids.map((id, i) => ({ id, index: i + 1 }));
const clone = value => JSON.parse(JSON.stringify(value));
let virtualLog, virtualIncremental;
function load(rel) {
  const activeRel = rel.replace('debug/issue-119-shared-component-count/backup/', '');
  const filename = path.join(ROOT, activeRel), module = { exports: {} };
  const nativeRequire = createRequire(filename);
  const context = vm.createContext({ module, exports: module.exports, __dirname: path.dirname(filename),
    __filename: filename, Buffer, process: { argv: [], versions: { node: '20.11.1' } }, console: { log() {} },
    require: id => {
      const normalized = id.replace(/\\/g, '/');
      if (id === 'fs') return { ...fs, existsSync: () => false,
        writeFileSync: () => { throw new Error('unexpected write'); } };
      if (normalized.endsWith('lib/runtime-files')) return {
        readJson: file => file.replace(/\\/g, '/').includes('duel-log-live') ? virtualLog : virtualIncremental };
      if (normalized.endsWith('lib/win-fast')) return {}; // No bridge exists in this harness.
      return nativeRequire(id);
    } });
  let source = read(rel);
  // Legacy entrypoints run main unconditionally: remove ONLY that dispatch.
  const dispatch = source.lastIndexOf('\nmain().catch(');
  if (dispatch >= 0) source = source.slice(0, dispatch);
  vm.runInContext(source, context, { filename });
  return context;
}
function segment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
const trade = load('execution/live/run-m12-trade-in.js');
const table = load('execution/live/run-m10-toon-table.js');
const engage = load('execution/live/run-m17-engage-bonus-draw.js');
const noBonus = load('execution/live/run-m17-engage-no-bonus-draw.js');
const mallet = load('execution/live/run-m11-mallet-keep-weapon.js');
const golden = load('execution/live/run-m14-golden-bamboo-sword.js');
const aliases = [...policy.EXODIA_COMPONENT_IDS, policy.EXODIA_UNKNOWN_ID];

// ISSUE-120's recorded M14 gain identities and actual incremental result.
// The later FULL RESYNC cleared the log delta; reconstruct ONLY the two gain
// rows in memory, never treat that old log as fresh live-action evidence.
const issue120Log = JSON.parse(read('material/issues/issue-120-m14-log.json'));
const issue120Incremental = JSON.parse(read('material/issues/issue-120-m14-incremental.json'));
const recordedM14 = issue120Log.operationBlocks.find(block => block.activationKey === 'M14');
assert.ok(recordedM14);
const recordedGains = recordedM14.details.filter(detail => ['M03', 'M20'].includes(detail.card && detail.card.id));
assert.strictEqual(recordedGains.length, 2);
virtualLog = { newOperationBlocks: [{ activationKey: 'M14', details: recordedGains.map(detail =>
  ({ ...detail, side: 'SELF', role: 'HAND_GAIN_CANDIDATE' })) }] };
virtualIncremental = clone(issue120Incremental);
const beforeM14 = virtualIncremental.before.handCount;
assert.notDeepStrictEqual(recordedGains.map(row => row.card.id).sort(),
  virtualIncremental.insertedCards.map(row => row.card.id).sort(), 'old exact comparison reproduces mismatch');
assert.strictEqual(golden.verifyGoldenBambooDraw(beforeM14, 'NO_WRITES').afterCount, beforeM14 + 1);

// Every exact/generic alias pair flows through the ACTUAL final validators.
// Do not replace the production count helper or the verifier being tested.
for (const logged of aliases) for (const observed of aliases) {
  virtualLog = { newOperationBlocks: [{ activationKey: 'M14', details: [logged, 'M20'].map(id =>
    ({ side: 'SELF', role: 'HAND_GAIN_CANDIDATE', card: { id } })) }] };
  virtualIncremental = { status: 'PASS', inference: { consumed: { id: 'M14' }, addedCount: 2 },
    after: { handCount: 3, cards: cards(['M11', observed, 'M20']) },
    insertedCards: cards(['M20', observed]).map(card => ({ card })) };
  assert.strictEqual(golden.verifyGoldenBambooDraw(2, 'NO_WRITES').afterCount, 3);
  for (const invalid of ['UNKNOWN', '', 'M06', 'M19']) {
    virtualIncremental.insertedCards = cards(['M20', invalid]).map(card => ({ card }));
    assert.throws(() => golden.verifyGoldenBambooDraw(2, 'NO_WRITES'), /DRAW_ID_MISMATCH/);
  }
  virtualIncremental.insertedCards = cards([observed, observed]).map(card => ({ card }));
  assert.throws(() => golden.verifyGoldenBambooDraw(2, 'NO_WRITES'), /DRAW_ID_MISMATCH/);
  const final = cards([observed, 'M11']);
  trade.verifyFinalMultiset({ baseline: { cards: cards(['M12', 'M08']) }, costId: 'M08',
    drawnIds: [logged, 'M11'], finalCards: final });
  engage.verifyFinalMultiset({ baseline: { cards: cards(['M17']) }, searchedId: 'M06',
    drawId: logged, finalCards: cards(['M06', observed]) });
  table.verifyFinalMultiset({ baseline: { cards: cards([logged, 'M10']) }, searchedId: 'M07',
    finalCards: cards([observed, 'M07']) });
  noBonus.verifyFinalMultiset({ baseline: { cards: cards([logged, 'M17']) }, searchedId: 'M06',
    finalCards: cards([observed, 'M06']) });
  verifyAllure({ baseline: { cards: cards(['M13', 'M06']) }, selectedBanishId: 'M06',
    drawnIds: [logged, 'M11'], finalCards: final });
  const checkpoint = { status: 'READY_TO_CONFIRM', plan: { returned: cards([logged, 'M11']) },
    committedIds: [observed, 'M11'] };
  assert.strictEqual(committedSelectionState(checkpoint).complete, true);
  const kept = mallet.buildRemainingPlan({ cards: cards([logged, 'M06', 'M11']) }, 3, [observed]);
  assert.strictEqual(kept.kept.length, 1);
  assert.strictEqual(kept.returned[0].id, 'M06');
  checkpoint.committedIds.push(observed);
  assert.throws(() => committedSelectionState(checkpoint), /UNPLANNED_COMMIT/);
}
for (let n = 0; n <= 5; n++) {
  const expected = cards(aliases.slice(0, n)), actual = cards(Array(n).fill('EXODIA_UNKNOWN'));
  assert.strictEqual(policy.sameRuntimeCardMultiset(expected, actual), true);
  assert.strictEqual(policy.countRuntimeCardIds(expected).get('EXODIA_UNKNOWN') || 0, n);
  table.verifyFinalMultiset({ baseline: { cards: [...expected, { id: 'M10' }] }, searchedId: 'M07',
    finalCards: [...actual, { id: 'M07' }] });
  for (const bad of [actual.slice(1), [...actual, { id: 'EXODIA_UNKNOWN' }]]) {
    if (n === 0 && bad.length === 0) continue;
    assert.throws(() => table.verifyFinalMultiset({ baseline: { cards: [...expected, { id: 'M10' }] },
      searchedId: 'M07', finalCards: [...bad, { id: 'M07' }] }), /MULTISET_INVALID/);
  }
}
for (const bad of ['UNKNOWN', 'M06', 'M08', 'M09', '']) {
  assert.throws(() => trade.verifyFinalMultiset({ baseline: { cards: cards(['M12', 'M08']) },
    costId: 'M08', drawnIds: ['M04', 'M11'], finalCards: cards([bad, 'M11']) }), /INVALID|UNRESOLVED/);
}
assert.throws(() => trade.verifyFinalMultiset({ baseline: { cards: cards(['M12']) }, costId: 'M08',
  drawnIds: ['M04', 'M11'], finalCards: cards(['EXODIA_UNKNOWN', 'M11']) }), /REMOVE_ABSENT/);

// Reproduce both real failures with the saved pre-action card/cost proofs and
// logged gains, then run the complete M12 observer acceptance chain.
for (const [fixture, piece, finalIds] of [
  ['issue-119-m12-first-click.json', 'M04', ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M08', 'M11', 'M12']],
  ['issue-119-m12-second-click.json', 'M05', ['EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'EXODIA_UNKNOWN', 'M11', 'M11']]
]) {
  const saved = JSON.parse(read(`material/issues/${fixture}`));
  const baseline = { handCount: saved.baselineHandCount, cards: saved.baselineHand };
  virtualLog = { newOperationBlocks: [{ activationKey: 'M12', details: [
    { side: 'SELF', role: 'HAND_COST', rawType: 'COST_TO_GRAVEYARD', card: { id: 'M08' } },
    ...['M11', piece].map(id => ({ side: 'SELF', role: 'HAND_GAIN_CANDIDATE', card: { id } }))
  ] }] };
  virtualIncremental = { status: 'PASS', after: { handCount: 5, cards: cards(finalIds) },
    inference: { consumed: { id: 'M12' }, costConsumed: [{ id: 'M08' }] },
    insertedCards: cards(['EXODIA_UNKNOWN', 'M11']).map(card => ({ card })) };
  const legacy = load('debug/issue-119-shared-component-count/backup/execution/live/run-m12-trade-in.js');
  assert.throws(() => legacy.verifyFinalMultiset({ baseline, costId: 'M08', drawnIds: ['M11', piece],
    finalCards: virtualIncremental.after.cards }), /M12_FINAL_HAND_MULTISET_INVALID/);
  const result = trade.verifyM12ObserverResult({ baseline, plan: saved.plan,
    costProof: saved.costProof, attemptDir: 'NO_WRITES' });
  assert.strictEqual(result.afterCount, 5);
  assert.strictEqual(result.drawn[1].id, 'EXODIA_UNKNOWN');
  const original = clone(virtualLog);
  virtualLog.newOperationBlocks[0].details[0].card.id = 'M07';
  assert.throws(() => trade.verifyM12ObserverResult({ baseline, plan: saved.plan,
    costProof: saved.costProof, attemptDir: 'NO_WRITES' }), /RIGHT_LOG_COST_INVALID/);
  virtualLog = original;
  virtualIncremental.after.cards.pop();
  assert.throws(() => trade.verifyM12ObserverResult({ baseline, plan: saved.plan,
    costProof: saved.costProof, attemptDir: 'NO_WRITES' }), /MULTISET_INVALID/);
}

// Same alias boundary in field draw1 and Garura draw1, including generic IDs
// already present in the right log. Ordinary/unknown cards cannot pass as pieces.
const chicken = load('execution/core/m21-chicken-game-route.js');
const garura = load('execution/live/run-m18-foolish-burial.js');
for (const logged of aliases) for (const observed of aliases) {
  virtualLog = { newOperationBlocks: [{ activationKey: 'M21', details: [
    { side: 'SELF', role: 'HAND_GAIN_CANDIDATE', card: { id: logged } }
  ] }] };
  virtualIncremental = { status: 'PASS', before: { handCount: 1 }, after: { handCount: 2, cards: cards(['M11', observed]) },
    insertedCards: [{ card: { id: observed } }] };
  assert.strictEqual(chicken.validateFinalDraw({ baselineHandCount: 2, card: { id: 'M21' } }).drawn.id, 'EXODIA_UNKNOWN');
  virtualIncremental.insertedCards[0].card.id = 'M09';
  assert.throws(() => chicken.validateFinalDraw({ baselineHandCount: 2, card: { id: 'M21' } }), /INSERTED_INVALID/);
  virtualIncremental.insertedCards[0].card.id = observed;
  virtualLog.newOperationBlocks[0].activationKey = 'E01';
  virtualLog.newOperationBlocks.unshift({ activationKey: 'M18', details: [
    { card: { id: 'E01' }, rawType: 'SEND_EXTRA_DECK_TO_GRAVEYARD' }
  ] });
  assert.strictEqual(garura.validateFinalM18Resolution({ routeState: { baselineHandCount: 2 },
    attemptDir: 'NO_WRITES' }).drawn.id, 'EXODIA_UNKNOWN');
  const nadirSource = segment(read('runtime/observer/run-duel-observer.js'),
    '    const gains = (garuraBlocks[0].details || []).filter(', '    const visibleBlocks = log.operationBlocks');
  const nadirContext = vm.createContext({ ...policy, garuraBlocks: [virtualLog.newOperationBlocks[1]],
    incremental: virtualIncremental, baselineCount: 2, readJson: () => { throw new Error('unexpected read'); } });
  vm.runInContext(nadirSource + '\nresult = drawn;', nadirContext);
  assert.strictEqual(nadirContext.result.id, 'EXODIA_UNKNOWN');
}
for (const [rel, bytes] of before) assert.ok(bytes
  ? bytes.equals(fs.readFileSync(path.join(ROOT, rel))) : !fs.existsSync(path.join(ROOT, rel)), rel);
console.log('SHARED_COMPONENT_COUNT_OFFLINE_PASS; actual M10/M12/M13/M14/M17+/M17-/M11/M21/M18/NADIR consumers; 6x6 aliases; 0..5 quantity; real M12 twice; strict costs+ordinary+missing/extra/unknown; gameInputs0/stateWrites0');
