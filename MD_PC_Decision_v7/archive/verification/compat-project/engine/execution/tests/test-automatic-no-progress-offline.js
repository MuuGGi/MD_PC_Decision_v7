'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { assertAutomaticExecutionResult } = require('../../lib/simple-draw-continuation-policy');
const { atomicContinuationDecision } = require('../../lib/atomic-response-continuation-policy');
const main = fs.readFileSync(path.join(__dirname, '../../runtime/main-v6.js'), 'utf8');
const start = main.indexOf('async function executeAtomicResponseInterval(');
const end = main.indexOf('function showNeedRouteDecision(', start);
assert(start >= 0 && end > start);
assert.strictEqual(assertAutomaticExecutionResult({ executed: true, savedObservationOnly: true }).executed, true);
assert.strictEqual(assertAutomaticExecutionResult({ executed: false, quit: true }).quit, true);
assert.throws(() => assertAutomaticExecutionResult({ executed: false }, 'M20'), /NO_EXECUTION_PROGRESS:M20/);

async function replay(automatic, executed = false) {
  let calls = 0;
  const state = { revision: 3, handCount: 1, cards: [{ id: 'M20', index: 1 }] };
  const context = vm.createContext({ console: { log() {} }, assertAutomaticExecutionResult,
    atomicContinuationDecision,
    currentAtomicNode: () => calls ? 'KAGARI_RECOVERY_DONE' : 'KAGARI_SWORD_LINK_IN_FLIGHT',
    executeFieldTransition: async options => {
      calls++;
      return { executed, state: options.state, quit: false, savedObservationOnly: executed };
    } });
  vm.runInContext(main.slice(start, end), context);
  const task = () => context.executeAtomicResponseInterval({ state, automatic });
  if (automatic && !executed) await assert.rejects(task, /NO_EXECUTION_PROGRESS:KAGARI_SWORD_LINK_IN_FLIGHT/);
  else assert.strictEqual((await task()).executed, executed);
  assert.strictEqual(calls, 1, 'no second auto-Enter/transition, no busy loop');
  assert.strictEqual(state.revision, 3);
}
(async () => {
  await replay(true);
  await replay(false);
  await replay(true, true);
  // Ensure both pending-field and ordinary field dispatches opt in, and the
  // real card dispatch also rejects "not executed" before starting next loop.
  assert.strictEqual((main.match(/automatic: Boolean\(process\.env\.MD_AUTOTEST_RUN\)/g) || []).length, 2);
  assert(main.includes('assertAutomaticExecutionResult(result, attemptedCard.id)'));
  console.log('PASS automated no-progress: unsupported/in-flight stage stops after one dispatch; no repeated Enter/action; manual no-op preserved; observer-only success accepted; current state unchanged, no game input.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
