'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const evidence = require('../../material/issues/issue-104-deadlock-before.json');
const library = require('../../card-library.json');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const protectedFiles = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json',
  'debug/duel-log-live/observer_state.json', 'debug/hand-change-live/latest_incremental_result.json',
  'debug/composite-route-live/session_state.json', 'debug/composite-route-live/latest_result.json',
  'material/verified/verified-cards.json', 'debug/settlement-rewards/daily-gems.json'];
const protectedBytes = new Map(protectedFiles.filter(rel => fs.existsSync(path.join(ROOT,rel))).map(rel => [rel, fs.readFileSync(path.join(ROOT, rel))]));
const engineFile = path.join(ROOT, 'lib/decision-engine.js'), engineModule = { exports: {} };
const engineRequire = createRequire(engineFile);
const totals = Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id)).map(c => [c.id, c.count]));
vm.runInNewContext(read('lib/decision-engine.js'), { module: engineModule, exports: engineModule.exports,
  console, require: id => id === './main-deck-ledger' ? {
    getSharedDeckState: () => ({ ledger: evidence.ledger, outsideDeckCounts: evidence.ledger.outsideDeckCounts,
      deckRemaining: Object.fromEntries(Object.entries(totals).map(([id, total]) =>
        [id, total - Number(evidence.ledger.outsideDeckCounts[id] || 0)])) })
  } : engineRequire(id) });
const main = read('runtime/main-v6.js');
const context = vm.createContext({ ROOT, path, console: { log() {}, error() {} },
  STRATEGIC_SPELL_IDS: new Set(library.cards.filter(c => /^M\d+$/.test(c.id) && Number(c.id.slice(1)) >= 9).map(c => c.id)),
  loadDecisionState: () => evidence.decision, knownNonRayeMonsterPresent: () => false,
  buildLastResortAllureAction, validateHandState: s => s, currentFieldActionLabel: () => null,
  shortExtraForDecision: () => '', require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return { collectActions: engineModule.exports.collectActions };
    if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock };
    throw new Error('Unexpected dependency: ' + id);
  } });
const usableStart = main.indexOf('function isStrategicallyUsable(');
const usableEnd = main.indexOf('function defaultDecisionState(', usableStart);
const suggestionStart = main.indexOf('function buildDecisionSuggestion(');
const suggestionEnd = main.indexOf('function shortExtraForDecision(', suggestionStart);
const printStart = main.indexOf('function printDecisionPoint(');
const printEnd = main.indexOf('function printInternalHand(', printStart);
const parseStart = main.indexOf('function parseCommand(');
const parseEnd = main.indexOf('async function readDecisionCommand(', parseStart);
vm.runInContext(main.slice(usableStart, usableEnd) + main.slice(suggestionStart, suggestionEnd) +
  main.slice(printStart, printEnd) + main.slice(parseStart, parseEnd), context);
assert.deepStrictEqual(evidence.hand.cards.map(c => c.id), ['M02', 'M04', 'M06', 'M08', 'M14', 'M14']);
assert.strictEqual(evidence.hand.revision, 12);
assert.strictEqual(evidence.decision.normalSummonUsed, true);
assert.strictEqual(evidence.decision.v5Branch.carrierId, 'E10');
const current = context.buildDecisionSuggestion(evidence.hand);
assert.strictEqual(current.selected, null);
assert.strictEqual(current.result.actions.length, 0);
assert.strictEqual(current.strategicDeadlock.terminal, true);
assert.strictEqual(current.strategicDeadlock.confidence, 'HIGH');
assert.strictEqual(context.printDecisionPoint(evidence.hand).deadEnd, true);
assert.strictEqual(context.parseCommand('x').type, 'SURRENDER');
assert.strictEqual(context.parseCommand('X').type, 'SURRENDER');
assert.strictEqual(context.parseCommand('q').type, 'QUIT');
function forecast(ids, runtime = {}, deck = {}, actions = []) {
  return analyzeReachableResourceDeadlock({
    cards: ids.map((id, i) => ({ id, index: i + 1 })),
    runtime: { graveSpellCount: 9, normalSummonUsed: true, usedCounts: {}, ...runtime },
    decisionResult: { deck: { deckRemaining: deck }, actions, engageTargets: [] }
  });
}
assert.strictEqual(forecast(['M06', 'M14'], {}, { M19: 2, M20: 1, M01: 5 }).terminal, true,
  'spent normal summon and Deck-only equipment do not create a route');
assert.strictEqual(forecast(['M06', 'M14'], { normalSummonUsed: false }, { M19: 2, M01: 5 }).terminal, true,
  'an available carrier alone cannot fetch unrelated equipment');
assert.strictEqual(forecast(['M06', 'M14'], { normalSummonUsed: false }, { M17: 1, M01: 5 }).terminal, false,
  'a real Raye -> Zero fixed Engage search remains available');
assert.strictEqual(forecast(['M06', 'M19', 'M14'], { normalSummonUsed: false }, { M01: 5 }).terminal, false);
assert.strictEqual(forecast(['M14', 'M20'], { v5Branch: { carrierId: 'E10' } }, { M01: 5 }).terminal, false,
  'Zero can still carry equipment for Golden Bamboo draw2');
assert.strictEqual(forecast(['M14'], { bambooSwordEquipped: true }, { M01: 5 }).terminal, false);
assert.strictEqual(forecast(['M01'], { chickenGameDrawPending: true }, { M01: 5 }).terminal, false);
assert.strictEqual(forecast(['M01'], { v5Branch: { active: true, currentState: 'KAGARI_RECOVERY_PROMPT' } }, { M01: 5 }).terminal, false);
assert.strictEqual(forecast(['UNKNOWN'], {}, { M01: 5 }).terminal, false);
assert.strictEqual(forecast(['M10'], {}, { M07: 1 }, [{ id: 'M10' }]).terminal, false);
const surrenderStart = main.indexOf("      if (command.type === 'SURRENDER') {");
const surrenderEnd = main.indexOf("      if (command.type === 'FIELD') {", surrenderStart);
const surrenderBlock = main.slice(surrenderStart, surrenderEnd);
assert.ok(surrenderStart >= 0 && surrenderEnd > surrenderStart);
async function exercise(proof, fail = false) {
  let calls = 0, questions = 0, foreground = 0;
  const ctx = vm.createContext({ command: { type: 'SURRENDER' }, suggestion: { strategicDeadlock: proof },
    console: { log() {}, error() {} }, assertFreshRuntimeBeforeGameAction: () => foreground++,
    rl: { question: async () => { questions++; throw new Error('UNEXPECTED_SECOND_CONFIRMATION'); } },
    runConfirmedDeadlockSurrender: async () => { calls++; if (fail) throw new Error('INJECTED_FAILURE'); return { status: 'PASS' }; }
  });
  await vm.runInContext('(async () => { for (let once = 0; once < 1; once++) {\n' + surrenderBlock + '\n} })()', ctx);
  return { calls, questions, foreground };
}
(async () => {
  assert.deepStrictEqual(await exercise(current.strategicDeadlock), { calls: 1, questions: 0, foreground: 1 });
  assert.deepStrictEqual(await exercise({ terminal: false }), { calls: 0, questions: 0, foreground: 0 });
  assert.deepStrictEqual(await exercise(current.strategicDeadlock, true), { calls: 1, questions: 0, foreground: 1 });
  for (const [rel, bytes] of protectedBytes) assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  console.log('DEADLOCK_ONE_KEY_OFFLINE_PASS; actual rev12=terminal; reachable searches kept; x=executor1/question0; failures no replay; stateWrites0/gameInputs0');
})().catch(error => { console.error(error); process.exitCode = 1; });
