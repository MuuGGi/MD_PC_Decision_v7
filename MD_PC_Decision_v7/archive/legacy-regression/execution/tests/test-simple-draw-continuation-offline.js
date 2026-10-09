'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifySimpleDrawContinuation, createSimpleDrawAutoController } = require('../../lib/simple-draw-continuation-policy');
const ROOT = path.resolve(__dirname, '../..');
function state(ids, revision = 0) {
  return { revision, handCount: ids.length, cards: ids.map((id, i) => ({ id, index: i + 1 })) };
}
function suggestion(id, slot = 2, runtime = {}, details = {}) {
  return { selected: { id, slot, details }, runtime, strategicDeadlock: { terminal: false } };
}
const simple = state(['M01', 'M09', 'M08']);
assert.strictEqual(classifySimpleDrawContinuation(simple, suggestion('M09')).automatic, true);
for (const id of ['M10', 'M11', 'M14', 'M06', 'M17', 'M18', 'M19', 'M20', 'M22']) {
  assert.strictEqual(classifySimpleDrawContinuation(state(['M01', 'M09', id]), suggestion('M09')).automatic, true, id);
}
for (const runtime of [{ bambooSwordEquipped: true }, { rayeNormalSummoned: true },
  { engageBlockedByMainMonster: true },
  { v5Branch: { carrierId: 'E04' } }, { fieldSpell: 'UNKNOWN' }]) {
  assert.strictEqual(classifySimpleDrawContinuation(simple, suggestion('M09', 2, runtime)).automatic, true);
}
assert.strictEqual(classifySimpleDrawContinuation(state(['M01', 'M12', 'M08']),
  suggestion('M12', 2, {}, { discardTarget: { id: 'M08' } })).automatic, true);
for (const details of [{}, { discardTarget: { id: 'M08' }, protectedToonDragonCost: true }]) {
  assert.strictEqual(classifySimpleDrawContinuation(state(['M01', 'M12', 'M08']), suggestion('M12', 2, {}, details)).automatic, false);
}
assert.strictEqual(classifySimpleDrawContinuation(state(['M01', 'M13', 'M08']),
  suggestion('M13', 2, {}, { banishTarget: { id: 'M08' } })).automatic, true);
assert.strictEqual(classifySimpleDrawContinuation(state(['M01', 'M13']),
  suggestion('M13', 2, {}, { allureLastResort: true })).automatic, false);
assert.strictEqual(classifySimpleDrawContinuation(simple, suggestion('M09', 1)).automatic, false);

const main = fs.readFileSync(path.join(ROOT, 'runtime/main-v6.js'), 'utf8');
const start = main.indexOf('function parseCommand(');
const end = main.indexOf('function printHelp(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ console, process: { env: {} } });
vm.runInContext(main.slice(start, end), context);
let questions = 0;
const rl = { question: async () => { questions++; return ''; } };
async function run() {
  const controller = createSimpleDrawAutoController();
  const first = await context.readDecisionCommand(simple, suggestion('M09'), rl, controller);
  assert.strictEqual(first.automatic, true);
  assert.strictEqual(first.command.type, 'PLAY_SLOT');
  assert.strictEqual(first.command.slot, 2);
  assert.strictEqual(questions, 0);
  const after1 = state(['M01', 'M12', 'M08'], 1);
  assert.strictEqual(controller.completed(first.before, after1), true);
  const second = await context.readDecisionCommand(after1,
    suggestion('M12', 2, {}, { discardTarget: { id: 'M08' } }), rl, controller);
  assert.strictEqual(second.automatic, true);
  const after2 = state(['M01', 'M15', 'M16'], 2);
  assert.strictEqual(controller.completed(second.before, after2), true);
  const third = await context.readDecisionCommand(after2, suggestion('M15'), rl, controller);
  assert.strictEqual(third.automatic, true);
  const after3 = state(['M01', 'M16', 'M22'], 3);
  controller.completed(third.before, after3);
  const fourth = await context.readDecisionCommand(after3, suggestion('M16'), rl, controller);
  assert.strictEqual(fourth.automatic, true, 'Hornet in hand does not change the selected draw1');
  assert.strictEqual(questions, 0);
  const branch = await context.readDecisionCommand(after3, suggestion('M22', 3), rl, controller);
  assert.strictEqual(branch.automatic, false, 'the selected Hornet route requires confirmation');
  assert.strictEqual(questions, 1);
  const field = { selected: { specialAction: 'M21_FIELD_DRAW' }, runtime: { chickenGameDrawPending: true } };
  const drawField = await context.readDecisionCommand(state(['M01', 'M02']), field, rl, controller);
  assert.strictEqual(drawField.automatic, true);
  assert.strictEqual(drawField.command.type, 'SPECIAL');
  const failed = createSimpleDrawAutoController();
  failed.stop();
  assert.strictEqual((await context.readDecisionCommand(simple, suggestion('M09'), rl, failed)).automatic, false);
  assert.strictEqual(questions, 2, 'failure requires confirmation, never automatic replay');
  const stalled = createSimpleDrawAutoController();
  assert.strictEqual(stalled.completed(simple, simple), false);
  assert.strictEqual(stalled.choose(simple, suggestion('M09')).automatic, false);
  const bounded = createSimpleDrawAutoController({ maxActions: 1 });
  assert.strictEqual(bounded.choose(simple, suggestion('M09')).automatic, true);
  assert.strictEqual(bounded.choose(after1, suggestion('M12', 2, {}, { discardTarget: { id: 'M08' } })).automatic, false);
  // Production loop uses the same command/executor path and updates the controller after each observer commit.
  assert.match(main, /await readDecisionCommand\(state, suggestion, rl, simpleAuto\)/);
  assert.strictEqual((main.match(/simpleAuto\.completed\(automaticBefore, state\)/g) || []).length, 2);
  assert.strictEqual((main.match(/simpleAuto\.stop\(\)/g) || []).length, 2);
  console.log('SIMPLE_DRAW_CONTINUATION_OFFLINE_PASS; draw1/draw2=NO_QUESTION; branch=ENTER; failure=NO_REPLAY; inputs=0');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
