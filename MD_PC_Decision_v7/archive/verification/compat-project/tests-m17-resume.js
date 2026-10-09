'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');
const { selectedCardBadge, provePreservedCandidateLayout } = require('./engine/execution/core/selected-card-badge');
const { detectCandidateCenters } = require('./engine/execution/core/prompt-candidate-centers');
const { prepareResume, validateResumeTicket, STATE_FILES } = require('./resume-m17');
const { TestStore } = require('./store');
const { playOne } = require('./session');
const { classifyFailure } = require('./policy');
async function test() {
  const roi = { x: 620, y: 830, width: 800, height: 200 };
  const full = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures/m17-selected-hamp-full.png')));
  const current = new PNG({ width: roi.width, height: roi.height });
  PNG.bitblt(full, current, roi.x, roi.y, roi.width, roi.height, 0, 0);
  const sourceCandidatePath = path.join(__dirname, 'fixtures/m17-before-selection-strip.png');
  const previous = PNG.sync.read(fs.readFileSync(sourceCandidatePath));
  const points = detectCandidateCenters(previous, roi, 925, { mode: 'components' });
  assert.deepStrictEqual(points.map(p => p.x), [787, 945, 1103, 1261]);
  assert.strictEqual(detectCandidateCenters(current, roi, 925, { mode: 'components' }).length, 1,
    'selected modal dims three candidates: ordinary brightness count is not recovery proof');
  assert.strictEqual(provePreservedCandidateLayout(current, previous, points, roi).pass, true);
  assert.deepStrictEqual(points.filter(p => selectedCardBadge(current, p, roi).pass).map(p => p.x), [1261]);
  const blank = { width: 800, height: 200, data: Buffer.alloc(800 * 200 * 4) };
  assert.strictEqual(provePreservedCandidateLayout(blank, previous, points, roi).pass, false);
  assert.strictEqual(selectedCardBadge(blank, points[3], roi).pass, false);
  const changed = { ...current, data: Buffer.from(current.data) };
  for (let y = 35; y < 165; y++) for (let x = 740 - 620; x < 835 - 620; x++) {
    const i = (y * 800 + x) * 4; changed.data[i] = 255; changed.data[i + 1] = 0; changed.data[i + 2] = 255;
  }
  assert.strictEqual(provePreservedCandidateLayout(changed, previous, points, roi).pass, false);
  // Run the actual recovery function with only the hardware surface stubbed.
  const source = fs.readFileSync(path.join(__dirname, 'engine/execution/core/m17-engage-search.js'), 'utf8');
  const from = source.indexOf('async function resumeSelectedM17Search('), to = source.indexOf('function measureBonusDrawPrompt(', from);
  async function replay(image = current, id = 'M08', highest = 'M08', beforeFails = false) {
    const inputs = [], stages = [];
    const context = vm.createContext({ fs, path, PNG, detectCandidateCenters,
      require: () => ({ selectedCardBadge, provePreservedCandidateLayout }),
      waitForEngageSearchDialog: async () => ({ dialog: { candidateRoi: roi, candidateY: 925 } }),
      captureReferenceRoi: async () => image, sleep: async () => {},
      recognizeCurrentCard: async () => ({ accepted: true, id, name: id }), normalizeRecognized: x => x,
      LEGAL: new Map([['M08', 'HAMP'], ['M06', 'Raye']]), saveRgbaPng: () => {},
      confirmCurrentDialogSelection: async ({ bridge, beforeClick }) => { await beforeClick(); await bridge.click(1024, 1082); return { point: { x: 1024, y: 1082 } }; }
    });
    vm.runInContext(source.slice(from, to), context);
    let proof, error;
    try { proof = await context.resumeSelectedM17Search({ bridge: { click: async (x, y) => inputs.push([x, y]) },
      info: {}, library: {}, templates: {}, baseline: {}, debugDir: 'OFFLINE', sourceCandidatePath,
      priorityPlan: { expectedCandidateCount: 4, targets: [{ id: highest }] },
      beforeSubmit: () => { stages.push('SUBMIT_IN_FLIGHT'); if (beforeFails) throw new Error('WRITE_FAILED'); } }); }
    catch (e) { error = e; }
    return { inputs, stages, proof, error };
  }
  const success = await replay();
  assert.ifError(success.error); assert.deepStrictEqual(success.inputs, [[1024, 1082]]);
  assert.deepStrictEqual(success.stages, ['SUBMIT_IN_FLIGHT']);
  assert.strictEqual(success.proof.selected.id, 'M08'); assert.strictEqual(success.proof.clickReference, null);
  assert.strictEqual(success.proof.candidateIndex, 4);
  for (const args of [[blank], [changed], [current, 'M06'], [current, 'M08', 'M06'], [current, 'M08', 'M08', true]]) {
    const result = await replay(...args); assert.ok(result.error); assert.deepStrictEqual(result.inputs, []);
  }
  // Run the actual main recovery branch and accounting helper. The production
  // executor's generic accounting MUST be skipped: recovery owns one commit.
  const mainSource = fs.readFileSync(path.join(__dirname, 'engine/runtime/main-v6.js'), 'utf8');
  const accountingFrom = mainSource.indexOf('function repairResolvedM17DecisionAccounting(');
  const accountingTo = mainSource.indexOf('function malletPolicyForState(', accountingFrom);
  const branchMarker = '} else if (resumeM17Search) {';
  const branchFrom = mainSource.indexOf(branchMarker) + branchMarker.length;
  const branchTo = mainSource.indexOf('} else if (resumeM17Resolved)', branchFrom);
  let runtime = { graveSpellCount: 6, usedCounts: {} }, executorCalls = 0;
  const branchContext = vm.createContext({ path, ROOT: 'OFFLINE', process: { env: { MD_AUTOTEST_RESUME_TICKET: 'TICKET' } },
    readJson: file => file === 'TICKET' ? {} : file.endsWith('execution_click.json') ? { searchProof: { selected: { id: 'M08', name: 'HAMP' } } } :
      { stage: 'VERIFIED', attemptDir: path.join('OFFLINE', 'debug/execution/M17_engage_bonus_draw/RESUMED') },
    require: () => ({ validateResumeTicket: () => {} }),
    loadObserverSessionState: () => ({ handCount: 1, cards: [{ id: 'M17', index: 1 }] }),
    runExecutor: (_, slot, card, flags, options) => { executorCalls++; assert.strictEqual(slot, 1);
      assert.strictEqual(card.id, 'M17'); assert.strictEqual(flags[0], '--resume-current-search'); assert.strictEqual(options.skipDecisionUpdate, true); },
    loadDecisionState: () => structuredClone(runtime), DECISION_STATE_PATH: 'DECISION',
    incrementUsedCount: (s, id) => { s.usedCounts[id] = (s.usedCounts[id] || 0) + 1; },
    writeJsonAtomic: (file, value) => { if (file === 'DECISION') runtime = structuredClone(value); }, console: { log: () => {} }, state: null
  });
  vm.runInContext(mainSource.slice(accountingFrom, accountingTo), branchContext);
  vm.runInContext(`function replayMainBranch() { ${mainSource.slice(branchFrom, branchTo)} }`, branchContext);
  branchContext.replayMainBranch();
  assert.strictEqual(executorCalls, 1); assert.strictEqual(runtime.graveSpellCount, 7); assert.strictEqual(runtime.usedCounts.M17, 1);
  branchContext.repairResolvedM17DecisionAccounting({ attemptId: 'RESUMED', selected: { id: 'M08', name: 'HAMP' } });
  assert.strictEqual(runtime.graveSpellCount, 7); assert.strictEqual(runtime.usedCounts.M17, 1, 'same attempt never double-counts');
  const evidenceDir = path.join(__dirname, 'test-evidence'); fs.mkdirSync(evidenceDir, { recursive: true });
  const temp = fs.mkdtempSync(path.join(evidenceDir, 'm17-resume-'));
  const runs = path.join(temp, 'runs'), runDir = path.join(runs, 'test'), engine = path.join(temp, 'engine');
  const store = new TestStore(runDir), game = store.begin(); game.duelStarted = true;
  store.finish(game, 'INTERRUPTED', { error: 'MOUSE_INTERFERENCE' });
  const gameDir = path.join(runDir, 'game-00001'), archive = path.join(gameDir, 'before-recovery');
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  for (const name of STATE_FILES) {
    const data = name === 'decision-state.json' ? { graveSpellCount: 6 } : name.includes('session_state') ?
      { handCount: 1, cards: [{ id: 'M17' }] } : {};
    write(path.join(engine, name), JSON.stringify(data)); write(path.join(archive, name), JSON.stringify(data));
  }
  const attempt = path.join(engine, 'debug/execution/M17_engage_bonus_draw/2026-10-03T08-44-15-291Z');
  write(path.join(attempt, 'm17_search_dialog_signature.png'), 'TEST');
  write(path.join(attempt, 'm17_search_candidates_latest.png'), 'TEST');
  write(path.join(runDir, 'STOP'), 'MOUSE_INTERFERENCE');
  const command = { cmd: 'click', x: 1261, y: 903 };
  write(path.join(gameDir, 'actions.jsonl'), ['INPUT_REQUEST', 'INPUT_COMPLETE'].map(type =>
    JSON.stringify({ type, command, at: '2026-10-03T08:44:21.937Z' })).join('\n'));
  const latest = { runDir, pid: -1, stopPath: path.join(runDir, 'STOP') };
  const plan = prepareResume(latest, runs, engine, () => false);
  assert.strictEqual(plan.gameId, 1); assert.strictEqual(validateResumeTicket(plan, engine).handCount, 1);
  assert.throws(() => prepareResume(latest, runs, engine, () => true), /PROCESS_ALIVE/);
  assert.throws(() => prepareResume({ ...latest, stopPath: path.join(gameDir, 'resume/STOP') }, runs, engine, () => false), /ALREADY_RESUMED_EPOCH/);
  write(path.join(engine, 'decision-state.json'), '{}');
  assert.throws(() => validateResumeTicket(plan, engine), /STATE_CHANGED/);
  assert.throws(() => prepareResume(latest, runs, engine, () => false), /STATE_CHANGED/);
  const loaded = new TestStore(runDir, { resume: true });
  const resumed = loaded.resumeInterruptedGame(1), calls = [];
  assert.strictEqual(loaded.state.totals.started, 1); assert.strictEqual(resumed.resumeHistory.length, 1);
  assert.throws(() => loaded.resumeInterruptedGame(1), /NOT_INTERRUPTED/);
  const adapters = { stopped: () => false, start: async () => { throw new Error('NEW_DUEL_STARTED'); },
    waitMain1: async () => { throw new Error('OPENING_RESET'); }, play: async () => ({ outcome: 'WIN', proven: true, gems: 0 }),
    archive: async (_, label) => calls.push(label), finishBoard: async () => ({ gems: 0 }) };
  await playOne(loaded, adapters, resumed);
  assert.strictEqual(loaded.state.totals.started, 1); assert.strictEqual(loaded.state.totals.completed, 1);
  assert.strictEqual(loaded.state.games.length, 1); assert.strictEqual(loaded.state.games[0].resumeHistory[0].error, 'MOUSE_INTERFERENCE');
  assert.strictEqual(fs.readFileSync(latest.stopPath, 'utf8'), 'MOUSE_INTERFERENCE');
  assert.strictEqual(classifyFailure(new Error('AUTOTEST_RESUME_M17_NOT_COMPLETED')), 'STOP_TEST');
  const failureStore = new TestStore(path.join(runs, 'failure')), interrupted = failureStore.begin(); interrupted.duelStarted = true;
  failureStore.finish(interrupted, 'INTERRUPTED'); const retry = failureStore.resumeInterruptedGame(1);
  const failureCalls = [];
  const stoppedResult = await playOne(failureStore, { ...adapters,
    play: async () => { throw new Error('AUTOTEST_RESUME_M17_SINGLE_SELECTED_BADGE_NOT_PROVEN'); },
    archive: async () => failureCalls.push('ARCHIVE'), surrender: async () => failureCalls.push('SURRENDER') }, retry);
  assert.strictEqual(stoppedResult.stop, true); assert.deepStrictEqual(failureCalls, ['ARCHIVE']);
  console.log('M17_SELECTED_SEARCH_RESUME_OFFLINE_PASS; actual screenshot; one submit only; no new duel; no surrender on recovery failure; NO_NATIVE_INPUT');
}
if (require.main === module) test().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { test };
