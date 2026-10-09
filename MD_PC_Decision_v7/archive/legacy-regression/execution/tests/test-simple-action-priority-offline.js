'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const evidence = require('../../material/issues/issue-105-simple-auto-before.json');
const library = require('../../card-library.json');
const { classifySimpleDrawContinuation: classify, createSimpleDrawAutoController } = require('../../lib/simple-draw-continuation-policy');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const { buildLastResortAllureAction } = require('../../lib/allure-policy');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const protectedFiles = ['decision-state.json', 'debug/hand-change-live/session_state.json',
  'debug/main-deck-ledger/state.json', 'debug/duel-log-live/latest_result.json',
  'debug/duel-log-live/observer_state.json', 'debug/hand-change-live/latest_incremental_result.json',
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
let runtime = evidence.decision;
const main = read('runtime/main-v6.js');
const context = vm.createContext({ ROOT, path, process: { env: {} }, console: { log() {}, error() {} },
  STRATEGIC_SPELL_IDS: new Set(library.cards.filter(c => /^M\d+$/.test(c.id) && Number(c.id.slice(1)) >= 9).map(c => c.id)),
  loadDecisionState: () => runtime, knownNonRayeMonsterPresent: () => false,
  buildLastResortAllureAction, validateHandState: s => s, require: id => {
    if (id.endsWith('recognizer')) return { loadLibrary: () => library };
    if (id.endsWith('decision-engine')) return { collectActions: engineModule.exports.collectActions };
    if (id.endsWith('deadlock-detector')) return { analyzeReachableResourceDeadlock };
    throw new Error('Unexpected dependency: ' + id);
  } });
function extract(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return main.slice(a, b);
}
vm.runInContext(extract('function isStrategicallyUsable(', 'function defaultDecisionState(') +
  extract('function buildDecisionSuggestion(', 'function shortExtraForDecision('), context);
assert.deepStrictEqual(evidence.hand.cards.map(c => c.id), ['M05', 'M13', 'M14', 'M21', 'M21']);
assert.strictEqual(evidence.hand.revision, 2);
assert.strictEqual(evidence.decision.usedCounts.M18, 1);
const current = context.buildDecisionSuggestion(evidence.hand);
assert.strictEqual(current.selected.id, 'M21');
assert.strictEqual(current.selected.slot, 4);
assert.strictEqual(classify(evidence.hand, current).automatic, true, 'inert Golden Bamboo cannot block Chicken draw1');
function hand(ids) {
  return { revision: 0, handCount: ids.length, cards: ids.map((id, i) => ({ id, index: i + 1,
    name: library.cards.find(c => c.id === id)?.name || id, usable: true })) };
}
function suggest(id, slot = 2, fields = {}, details = {}) {
  return { selected: { id, slot, details }, runtime: fields };
}
for (const graveSpellCount of [0, 1, 2, 3, 8]) {
  for (const ids of [['M05', 'M18', 'M21'], ['M05', 'M21', 'M18']]) {
    for (const fieldSpell of [null, 'M21']) {
      runtime = { graveSpellCount, fieldSpell, usedCounts: {} };
      const actual = context.buildDecisionSuggestion(hand(ids));
      assert.strictEqual(actual.selected.id, 'M21', `field before Burial: grave=${graveSpellCount}; field=${fieldSpell}`);
      assert.strictEqual(classify(hand(ids), actual).automatic, true);
    }
  }
}
runtime = { graveSpellCount: 0, usedCounts: {} };
const opening = hand(['M05', 'M13', 'M18', 'M21', 'M21']);
assert.strictEqual(context.buildDecisionSuggestion(opening).selected.id, 'M21');
const burialHand = hand(['M05', 'M18', 'M14', 'M17', 'M20']);
assert.strictEqual(classify(burialHand, suggest('M18')).automatic, true, 'fixed Garura route is draw1');
assert.strictEqual(classify(hand(['M05', 'M14']), suggest('M14')).automatic, false);
assert.strictEqual(classify(hand(['M05', 'M14']), suggest('M14', 2, { bambooSwordEquipped: true })).automatic, true);
assert.strictEqual(classify(hand(['M05', 'M13', 'M06']), suggest('M13', 2, {}, { banishTarget: { id: 'M06' } })).automatic, true);
for (const id of ['M06', 'M10', 'M11', 'M17', 'M19', 'M20', 'M22']) {
  assert.strictEqual(classify(hand(['M05', id, 'M18']), suggest(id)).automatic, false, `selected ${id} is complex`);
}
assert.strictEqual(classify(hand(['M05', 'M09', 'UNKNOWN']), suggest('M09')).automatic, false);
assert.strictEqual(classify({ ...hand(['M05', 'M09']), handCount: 3 }, suggest('M09')).automatic, false);
assert.strictEqual(classify(hand(['M05', 'M09']), suggest('M09', 2, { v5Branch: { active: true } })).automatic, false);
assert.strictEqual(classify(burialHand, suggest('M18', 2, {}, { phase: 'OTHER_TARGET_BRANCH' })).automatic, false);
// Exercise the real terminal interaction: simple actions skip question(),
// while each selected complex action retains the ordinary Enter workflow.
vm.runInContext(extract('function parseCommand(', 'function printHelp('), context);
(async () => {
  let questions = 0;
  const rl = { question: async () => { questions++; return ''; } };
  const controller = createSimpleDrawAutoController();
  for (const [h, s] of [[burialHand, suggest('M18')], [evidence.hand, current],
      [hand(['M05', 'M09', 'M17', 'M19']), suggest('M09')]]) {
    const answer = await context.readDecisionCommand(h, s, rl, controller);
    assert.strictEqual(answer.automatic, true);
    assert.strictEqual(answer.command.type, 'PLAY_SLOT');
    assert.strictEqual(questions, 0);
  }
  for (const id of ['M06', 'M10', 'M11', 'M17', 'M19', 'M20', 'M22']) {
    const answer = await context.readDecisionCommand(hand(['M05', id, 'M18']), suggest(id), rl, controller);
    assert.strictEqual(answer.automatic, false, id);
  }
  assert.strictEqual(questions, 7);
  assert.ok(!main.includes('simpleAutoUntilReview'), 'production keeps one interactive main loop');
  for (const [rel, bytes] of protectedBytes) assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, rel))), rel);
  console.log('SIMPLE_ACTION_PRIORITY_OFFLINE_PASS; current Chicken+Garura+draw1 question0; selected complex ENTER; field before Burial grave0/1/2/3/8; ordinary interactive loop; stateWrites0/gameInputs0');
})().catch(error => { console.error(error); process.exitCode = 1; });
