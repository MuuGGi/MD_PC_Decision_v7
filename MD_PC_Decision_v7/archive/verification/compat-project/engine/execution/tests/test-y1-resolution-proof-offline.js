'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'execution/core/atomic-route-executor.js'), 'utf8');
// Execute the production functions with mock GUI dependencies. No bridge,
// disk state, game input, or timer is used by this regression.
function declarationBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'production function boundaries must exist');
  return source.slice(from, to);
}
const production = declarationBetween(
  'async function runEquippedYotoLinkToOptionalAtomic(', 'function semanticDetailRoles('
) + declarationBetween(
  'async function recoverYotoLinkResolvedOptionalAtomic(', 'async function runYotoOptionalToBambooPromptAtomic('
);

function harness({ id = 'E04', count = 1, visible = true, logFails = true } = {}) {
  const calls = [];
  const pool = { visible, candidateCount: count, detector: 'GENERIC_OPTIONAL_EFFECT_POOL_V2' };
  const bridge = { stop: async () => { calls.push('stop'); } };
  const input = name => async () => { calls.push(name); return {}; };
  const observe = async () => {
    calls.push('right-log');
    if (logFails) throw new Error('DUEL_LOG_BOTTOM_ONLY_CHECKPOINT_NOT_PROVEN:expected=M19;visible=M19');
    return { proof: { mode: 'ADJACENT_BOTTOM_ONLY', upwardBacktrackSteps: 0 } };
  };
  const context = vm.createContext({
    ROOT, ROUTE_ROOT: 'mock-route', ALL_LINK_IDS: ['E02', 'E03', 'E04', 'E05', 'E10'],
    RAYE_MAIN_ANCHOR: { x: 1024, y: 705 }, path,
    console: { log() {} }, ensureDir() {}, timestampId: () => 'offline',
    loadLibrary: () => ({}), loadTemplates: async () => ({}),
    require: () => ({ observeAdjacentLogEventually: observe }),
    startBridge: async () => ({ bridge, info: {} }),
    sleep: async ms => { calls.push(`wait:${ms}`); },
    clickExtraDeckSummonButton: input('extra'),
    waitForSummonCandidates: async () => ({}),
    selectNextLegalLink: async () => ({ selected: { id } }),
    selectSpecificLink: async () => ({ selected: { id } }),
    clickBottomSummonSubmit: input('submit-link'),
    choosePreferredEquipCarrier: async () => ({ kind: 'GENERIC', reference: { x: 1024, y: 705 } }),
    proveCarrierMaterialSelectable: async () => ({}),
    clickCarrierMaterial: input('material'),
    clickMaterialBlueConfirm: input('confirm-material'),
    waitForPostLinkOptionalPool: async () => { calls.push('pool'); return pool; },
    inferUniqueLinkSummonIdFromObservedBlock: () => id
  });
  vm.runInContext(production, context);
  return { context, calls, pool };
}

async function main() {
  for (const id of ['E03', 'E04', 'E05']) {
    const h = harness({ id });
    const state = { handCount: 3, revision: 10 };
    const result = await h.context.runEquippedYotoLinkToOptionalAtomic({
      state,
      onOptionalPoolProven: async evidence => {
        assert.strictEqual(evidence.targetLinkId, id);
        h.calls.push('durable-checkpoint');
      }
    });
    assert.strictEqual(result.targetLinkId, id);
    assert.strictEqual(result.state, state);
    assert.strictEqual(result.proof.mode, 'SAVED_SELECTED_LINK_PLUS_CURRENT_YOTO_OPTIONAL_POOL');
    assert.strictEqual(h.calls.includes('right-log'), false, 'stale M19 must not reject completed single Y1');
    assert.deepStrictEqual(h.calls.filter(x => ['submit-link', 'material', 'confirm-material'].includes(x)),
      ['submit-link', 'material', 'confirm-material'], 'each irreversible input occurs once');
    assert.ok(h.calls.indexOf('durable-checkpoint') > h.calls.indexOf('pool'));
    assert.strictEqual(h.calls.at(-1), 'stop');

    const recovery = harness({ id });
    const recovered = await recovery.context.recoverYotoLinkResolvedOptionalAtomic({ state, expectedLinkId: id });
    assert.strictEqual(recovered.targetLinkId, id);
    assert.strictEqual(JSON.stringify(recovered.proof), JSON.stringify(result.proof), 'Y1 and Y1R share the mature proof');
    assert.deepStrictEqual(recovery.calls, ['pool', 'stop'], 'Y1R is passive and never replays Link');
  }
  for (const id of ['', 'E02', 'E10']) {
    const h = harness({ id });
    await assert.rejects(h.context.runEquippedYotoLinkToOptionalAtomic({ state: {} }), /ACTUAL_TARGET_INVALID/);
    assert.strictEqual(h.calls.includes('submit-link'), false, 'illegal identity fails before submission');
  }
  for (const count of [0, 2]) {
    const h = harness({ count });
    await assert.rejects(h.context.runEquippedYotoLinkToOptionalAtomic({ state: {} }), /OPTIONAL_POOL_INVALID/);
  }
  const absent = harness({ visible: false });
  await assert.rejects(absent.context.runEquippedYotoLinkToOptionalAtomic({ state: {} }), /POOL_NOT_PROVEN/);
  const persistence = harness();
  await assert.rejects(persistence.context.runEquippedYotoLinkToOptionalAtomic({
    state: {}, onOptionalPoolProven: async () => { throw new Error('PERSIST_FAILED'); }
  }), /PERSIST_FAILED/);
  assert.strictEqual(persistence.calls.at(-1), 'stop');
  const dual = harness({ id: 'E10', count: 2, logFails: false });
  const dualResult = await dual.context.runEquippedYotoLinkToOptionalAtomic({ state: {}, doubleWithRaye: true });
  assert.strictEqual(dualResult.proof.mode, 'ADJACENT_BOTTOM_ONLY');
  assert.strictEqual(dual.calls.filter(x => x === 'material').length, 2);
  assert.strictEqual(dual.calls.filter(x => x === 'right-log').length, 1);
  console.log('Y1_RESOLUTION_PROOF_OFFLINE_PASS; single=E03/E04/E05; recovery=passive; invalid=closed; checkpoint=required; dual=preserved');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
