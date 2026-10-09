'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const Module = require('module');
const ROOT = path.resolve(__dirname, '../..');
const fixture = require('../../material/issues/issue-102-observer-evidence.json');
const library = require('../../card-library.json');
const { verifyFinalMultiset, verifyM13Observation, verifySavedM13Observation,
  accountM13DecisionState } = require('../../lib/m13-observer-verification');
const { runM13LastResort } = require('../core/m13-last-resort');
const { readJson, writeJsonAtomic } = require('../../lib/runtime-files');
const clone = value => JSON.parse(JSON.stringify(value));
const verify = evidence => verifyM13Observation({ baseline: evidence.checkpoint.baseline,
  banishProof: evidence.checkpoint.banishProof, log: evidence.log, incremental: evidence.incremental });
const handPath = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const ledgerPath = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const resultPath = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
function isolated(evidence, overrideLedger) {
  const files = new Map();
  const put = (file, value) => files.set(file, Buffer.from(JSON.stringify(value)));
  const ledger = overrideLedger || clone(evidence.ledger);
  if (!overrideLedger) {
    ledger.lastHandRevision = evidence.incremental.before.revision;
    ledger.lastIncrementalFingerprint = null;
    for (const item of evidence.incremental.insertedCards) ledger.outsideDeckCounts[item.card.id] -= 1;
  }
  put(handPath, evidence.incremental.before); put(ledgerPath, ledger); put(resultPath, { old: true });
  put(path.join(ROOT, 'card-library.json'), library); put(path.join(ROOT, 'decision-state.json'), evidence.decision);
  const fakeFs = { existsSync: file => files.has(file),
    readFileSync: (file, encoding) => encoding ? files.get(file).toString(encoding) : Buffer.from(files.get(file)) };
  const runtimeFiles = {
    readJsonIfExistsSafe: file => files.has(file) ? JSON.parse(files.get(file)) : null,
    writeJsonAtomic: put,
    restoreBuffer: (file, buffer) => buffer == null ? files.delete(file) : files.set(file, Buffer.from(buffer))
  };
  function load(rel, overrides) {
    const file = path.join(ROOT, rel), mod = { exports: {} }, actualRequire = Module.createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { __dirname: path.dirname(file),
      module: mod, exports: mod.exports, Buffer, process, console: { log() {} },
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : actualRequire(name) }, { filename: file });
    return mod.exports;
  }
  const ledgerModule = load('lib/main-deck-ledger.js', { './runtime-files': runtimeFiles });
  const transaction = load('lib/incremental-observer-transaction.js', {
    fs: fakeFs, './runtime-files': runtimeFiles, './main-deck-ledger': ledgerModule });
  const commit = () => transaction.commitIncrementalObserverResult({ incrementalResult: evidence.incremental,
    log: evidence.log, statePath: handPath, resultPath });
  return { files, commit, ledgerModule, get: file => JSON.parse(files.get(file)) };
}
function scenario(beforeIds, drawnIds, banishedId, afterIds) {
  const evidence = clone(fixture);
  const cards = rows => rows.map((id, i) => ({ id, name: id, index: i + 1 }));
  const before = { revision: 0, capturedAt: 'SCENARIO_BEFORE', handCount: beforeIds.length, cards: cards(beforeIds) };
  const after = { revision: 1, capturedAt: 'SCENARIO_AFTER', handCount: afterIds.length, cards: cards(afterIds) };
  evidence.incremental.before = before; evidence.incremental.after = after;
  evidence.incremental.inference = { activationKey: 'M13', consumed: before.cards.find(row => row.id === 'M13'),
    costConsumed: before.cards.filter(row => row.id === banishedId).slice(0, 1) };
  evidence.incremental.insertedCards = [];
  evidence.checkpoint.baseline = before;
  evidence.checkpoint.banishProof.selected = { id: banishedId, accepted: true };
  const detail = (id, role, rawType) => ({ card: { id, name: id }, confidenceMargin: 0.1, side: 'SELF', role, rawType });
  evidence.log.newOperationBlocks = [{ activationKey: 'M13', signature: 'SCENARIO',
    details: [...drawnIds.map(id => detail(id, 'HAND_GAIN_CANDIDATE', 'HAND_GAIN')),
      detail(banishedId, 'HAND_BANISH_COST', 'BANISH_FROM_HAND')] }];
  return evidence;
}
async function main() {
  const actual = verify(fixture);
  assert.deepStrictEqual(actual.drawn.map(row => row.id), ['M21', 'M08']);
  assert.strictEqual(actual.banished.id, 'M08');
  assert.strictEqual(actual.afterCount, 5);
  // Preserve every sealed ordinary M13 run, including old prepared baselines
  // whose scan result did not itself contain the observer revision field.
  const evidenceRoot = path.join(ROOT, 'material/verified/evidence/M13_allure_of_darkness');
  const sealed = fs.readdirSync(evidenceRoot);
  assert.ok(sealed.length >= 7);
  for (const name of sealed) {
    const dir = path.join(evidenceRoot, name);
    const incremental = readJson(path.join(dir, 'hand_incremental_result.json'));
    const log = readJson(path.join(dir, 'duel_log_result.json'));
    const banishProof = readJson(path.join(dir, 'execution_click.json')).banishProof;
    verifyM13Observation({ baseline: incremental.before, log, banishProof, incremental });
    verifyM13Observation({ baseline: { handCount: incremental.before.handCount,
      cards: incremental.before.cards }, log, banishProof, incremental });
  }
  for (const dark of ['M06', 'M08']) {
    verify(scenario(['M01', 'M13'], ['M21', dark], dark, ['M01', 'M21']));
    verify(scenario(['M01', dark, 'M13'], ['M09', 'M21'], dark, ['M01', 'M09', 'M21']));
    verify(scenario(['M01', dark, 'M13'], [dark, 'M21'], dark, ['M01', dark, 'M21']));
    verify(scenario(['M01', 'M13'], [dark, dark], dark, ['M01', dark]));
  }
  assert.throws(() => verifyFinalMultiset({ baseline: { cards: [{ id: 'M13' }] },
    selectedBanishId: 'M08', drawnIds: ['M21', 'M09'], finalCards: [] }), /REMOVE_ABSENT_CARD/);
  for (const mutate of [
    e => { e.incremental.after.revision += 1; },
    e => { e.checkpoint.baseline.capturedAt = 'STALE'; },
    e => { e.log.newOperationBlocks.push(clone(e.log.newOperationBlocks[0])); },
    e => { e.log.newOperationBlocks[0].details.pop(); },
    e => { e.checkpoint.banishProof.selected.id = 'M06'; },
    e => { e.incremental.after.cards[3].id = 'M08'; },
    e => { e.log.newOperationBlocks[0].details[0].card.id = 'UNKNOWN'; e.log.newOperationBlocks[0].details[0].top3 = []; }
  ]) { const bad = clone(fixture); mutate(bad); assert.throws(() => verify(bad), /M13_/); }
  const componentAlias = clone(fixture);
  componentAlias.checkpoint.baseline.cards[0].id = 'M02';
  verify(componentAlias);

  const transaction = isolated(fixture);
  transaction.commit();
  const committed = transaction.get(ledgerPath);
  assert.strictEqual(committed.outsideDeckCounts.M08, 1, 'freshly drawn then banished card leaves Deck');
  assert.strictEqual(committed.outsideDeckCounts.M21, 1, 'surviving draw counted once');
  assert.strictEqual(committed.lastM13Draw.fingerprint, actual.fingerprint);
  transaction.commit();
  assert.deepStrictEqual(transaction.get(ledgerPath), committed, 'observer commit is idempotent');
  const savedArgs = { checkpoint: fixture.checkpoint, log: fixture.log,
    incremental: fixture.incremental, hand: fixture.hand, ledger: committed };
  const saved = verifySavedM13Observation(savedArgs);
  assert.strictEqual(saved.savedObservationOnly, true);
  for (const mutate of [
    a => { a.hand.revision += 1; },
    a => { a.ledger.outsideDeckCounts.M08 = 0; }, a => { delete a.ledger.lastM13Draw; },
    a => { a.checkpoint.stage = 'BANISH_SUBMIT_STARTED'; },
    a => { delete a.checkpoint.banishProof.confirmProof; }
  ]) { const bad = clone(savedArgs); mutate(bad); assert.throws(() => verifySavedM13Observation(bad), /M13_/); }
  const savedComponentAlias = clone(savedArgs);
  savedComponentAlias.hand.cards[0].id = 'M02';
  assert.strictEqual(verifySavedM13Observation(savedComponentAlias).status, 'PASS');
  const bad = clone(fixture); bad.incremental.after.cards[3].id = 'M08';
  const rejected = isolated(bad), before = [...rejected.files].map(([key, buffer]) => [key, buffer.toString()]);
  assert.throws(rejected.commit, /M13_/);
  assert.deepStrictEqual([...rejected.files].map(([key, buffer]) => [key, buffer.toString()]), before,
    'invalid M13 proof rolls back ledger, hand and result');

  const double = scenario(['M01', 'M13'], ['M08', 'M08'], 'M08', ['M01', 'M08']);
  const doubleLedger = clone(fixture.ledger);
  doubleLedger.lastHandRevision = 0; doubleLedger.lastIncrementalFingerprint = null;
  for (const id of Object.keys(doubleLedger.outsideDeckCounts)) doubleLedger.outsideDeckCounts[id] = 0;
  doubleLedger.outsideDeckCounts.M01 = 1; doubleLedger.outsideDeckCounts.M13 = 1;
  const doubleTransaction = isolated(double, doubleLedger); doubleTransaction.commit();
  assert.strictEqual(doubleTransaction.get(ledgerPath).outsideDeckCounts.M08, 2);

  const accounted = accountM13DecisionState({ state: clone(fixture.decision), log: fixture.log, incremental: fixture.incremental });
  assert.deepStrictEqual(accounted.usedCounts, { M10: 2, M13: 1, M08: 1 });
  assert.strictEqual(accounted.graveSpellCount, 3);
  assert.deepStrictEqual(accountM13DecisionState({ state: accounted, log: fixture.log,
    incremental: fixture.incremental }), accounted, 'no duplicate cost or spell accounting');

  // Execute both actual live adapters without invoking their main()/GUI path.
  const live = fs.readFileSync(path.join(ROOT, 'execution/live/run-m13-allure-of-darkness.js'), 'utf8');
  const adapters = live.slice(live.indexOf('function verifyM13ObserverResult('), live.indexOf('async function main()'));
  const virtual = new Map([['log', fixture.log], ['incremental', fixture.incremental],
    [handPath, fixture.hand], [ledgerPath, committed]]);
  const context = { ROOT, path, LOG_RESULT_PATH: 'log', INCREMENTAL_RESULT_PATH: 'incremental',
    readJson: file => virtual.get(file), copyIfExists() {},
    require: Module.createRequire(path.join(ROOT, 'execution/live/run-m13-allure-of-darkness.js')) };
  vm.runInNewContext(adapters, context);
  assert.strictEqual(context.verifyM13ObserverResult({ baseline: fixture.checkpoint.baseline,
    banishProof: fixture.checkpoint.banishProof, attemptDir: 'unused' }).banished.id, 'M08');
  assert.strictEqual(context.verifySavedM13ObserverResult(fixture.checkpoint).status, 'PASS');
  assert.ok(live.includes('verifySavedObservation: verifySavedM13ObserverResult'));

  const runtime = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
  const accountContext = { fs: { existsSync: () => true }, ROOT, path, DECISION_STATE_PATH: 'decision',
    INCREMENTAL_PATH: 'incremental', readJson: file => file === 'incremental' ? fixture.incremental : fixture.log,
    loadDecisionState: () => clone(fixture.decision), writeJsonAtomic: (_, value) => { accountContext.updated = value; },
    require: Module.createRequire(path.join(ROOT, 'runtime/main-v6.js')) };
  vm.runInNewContext(runtime.slice(runtime.indexOf('function incrementUsedCount('),
    runtime.indexOf('function m21ReplacementUnlocksEngage(')), accountContext);
  accountContext.updateDecisionStateAfterSuccess({ id: 'M13' }, fixture.decision);
  assert.deepStrictEqual(accountContext.updated, accounted, 'real parent records drawn banish once');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-m13-saved-observer-'));
  const checkpointPath = path.join(temp, 'checkpoint.json');
  writeJsonAtomic(checkpointPath, fixture.checkpoint);
  let calls = 0;
  const options = { resume: true, checkpointPath, debugDir: path.join(temp, 'recovered'),
    bridge: new Proxy({}, { get() { throw new Error('GUI_INPUT_FORBIDDEN'); } }),
    observe() { throw new Error('OBSERVER_REPLAY_FORBIDDEN'); },
    verifySavedObservation: checkpoint => { calls++; return verifySavedM13Observation({ ...savedArgs, checkpoint }); } };
  assert.strictEqual((await runM13LastResort(options)).status, 'PASS');
  assert.strictEqual(readJson(checkpointPath).stage, 'COMPLETE_HAMP');
  await runM13LastResort(options);
  assert.strictEqual(calls, 1, 'completed recovery does not reverify or replay');
  writeJsonAtomic(checkpointPath, fixture.checkpoint);
  await assert.rejects(runM13LastResort({ ...options, verifySavedObservation: checkpoint =>
    verifySavedM13Observation({ ...savedArgs, checkpoint, ledger: fixture.ledger }) }), /COMMIT_MISMATCH/);
  assert.strictEqual(readJson(checkpointPath).stage, 'OBSERVER_STARTED');
  console.log('M13_DRAW_BANISH_OBSERVER_OFFLINE PASS (actual ISSUE-102; 7 sealed M13 runs; fresh/old/duplicate DARK; gross Deck exits; rollback; live adapters; parent accounting; saved recovery with zero GUI/observer replay)');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
