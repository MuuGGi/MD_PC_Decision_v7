'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { resolveEquipmentCarrier, mainMonsterConstraint } = require('../../../src/core/field-state');
const mature = require('../../../engine/runtime/mature-driver');
const { createDecisionContext } = require('../../../src/strategy/decision-context');
const { evaluateDecision } = require('../../../src/strategy/decision');
const { loadSnapshot } = require('../../../src/core/snapshot');
const { hashValue } = require('../../../src/core/json-store');
const { decide } = require('./unified-strategy');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const ROOT = path.resolve(__dirname, '../../..');
const runDir = path.join(ROOT, 'archive/autotest/runs/2026-10-08T09-52-50-247Z');
const read = rel => JSON.parse(fs.readFileSync(path.join(runDir, rel)));
const options = { isStrategicallyUsable: mature.isStrategicallyUsable,
  hasNonRayeMonster: () => false, isTransactionPending: mature.isTransactionPendingNode,
  isFieldPlanning: mature.isFieldPlanningNode };
let cases = 0;
async function run() {
  await withStrictReadOnly(async () => {
    const target = read('game-00003/completed/debug/execution/V5_formal_atomic/2026-10-08T10-03-02-539Z_M20_equip/equip_target/preferred_equip_carrier.json');
    assert.equal(target.recognized.accepted, false); assert.equal(target.recognized.id, 'CENTRAL_MONSTER');
    const before = { graveSpellCount: 3, usedCounts: {}, bambooSwordEquipped: false,
      v5Branch: { carrierId: 'TOKEN_SKY_STRIKER', currentState: 'HORNET_TOKEN_READY' } };
    const reduced = mature.deriveSwordEquippedState(before, 'M20', target);
    assert.equal(reduced.v5Branch.carrierId, 'TOKEN_SKY_STRIKER');
    assert.equal(reduced.v5Branch.carrierEvidence.kind, 'CENTRAL_MAIN');
    assert.equal(before.bambooSwordEquipped, false); cases++;
    // G1's token preparation passed a whole old branch as plan metadata. It
    // must not overwrite the new equip receipt's phase, identity or source.
    const oldPlan = { ...before.v5Branch, active: false, source: 'OLD_PLAN', plannedSwordId: 'M19' };
    const equippedYoto = mature.deriveSwordEquippedState(before, 'M19', target,
      { carrierId: 'TOKEN_SKY_STRIKER', source: 'CURRENT_EQUIP_RECEIPT', extra: oldPlan });
    assert.equal(equippedYoto.v5Branch.currentState, 'M19_EQUIPPED');
    assert.equal(equippedYoto.v5Branch.source, 'CURRENT_EQUIP_RECEIPT');
    assert.equal(equippedYoto.v5Branch.active, true);
    assert.equal(decide(['M12', 'M11'], equippedYoto).selected.details.fieldIntent, 'EQUIPPED_BAMBOO_DEPARTURE'); cases++;
    for (const [id, kind] of [['TOKEN_SKY_STRIKER', 'CENTRAL_MAIN'], ['M06', 'CENTRAL_MAIN'], ['E02', 'EXTRA_LINK'], ['E10', 'EXTRA_LINK']]) {
      const proof = { ...target, kind, recognized: { accepted: false, id: kind === 'CENTRAL_MAIN' ? 'CENTRAL_MONSTER' : 'EXTRA_LINK' } };
      const current = { v5Branch: { carrierId: id } };
      assert.equal(resolveEquipmentCarrier(current, proof).carrierId, id); cases++;
      assert.equal(resolveEquipmentCarrier(current, { ...proof, selectableProof: { stableFrames: 1 } }).carrierId, null); cases++;
      assert.equal(resolveEquipmentCarrier(current, { ...proof, kind: kind === 'CENTRAL_MAIN' ? 'EXTRA_LINK' : 'CENTRAL_MAIN' }).carrierId, null); cases++;
      assert.throws(() => resolveEquipmentCarrier(current, { ...proof, recognized: { accepted: true, id: 'E03' } }, id), /BINDING_NOT_PROVEN/); cases++;
    }
    assert.equal(resolveEquipmentCarrier({}, target).carrierId, null);
    assert(mainMonsterConstraint({ v5Branch: resolveEquipmentCarrier({}, target) }).blocked); cases++;
    assert.equal(resolveEquipmentCarrier({ rayeNormalSummoned: true, v5Branch: { carrierId: 'E02' } }, target).carrierId, 'M06'); cases++;
    assert.equal(resolveEquipmentCarrier({ rayeNormalSummoned: true, v5Branch: { carrierId: 'TOKEN_SKY_STRIKER' } }, target).carrierId, null); cases++;
    // A Link in Main remains Main if actually observed there. Old zone evidence
    // does not attach to a different Link after a proven replacement.
    const mainLink = { v5Branch: { carrierId: 'E02', carrierEvidence: { proven: true, cardId: 'E02', kind: 'CENTRAL_MAIN' } } };
    assert.equal(resolveEquipmentCarrier(mainLink, target).carrierId, 'E02');
    assert(mainMonsterConstraint(mainLink).blocked);
    assert(!mainMonsterConstraint({ v5Branch: { ...mainLink.v5Branch, carrierId: 'E03' } }).blocked); cases++;
    for (const id of ['M06', 'TOKEN_SKY_STRIKER', 'CENTRAL_MONSTER']) {
      const d = decide(['M17', 'M09'], { graveSpellCount: 3, engageBlockedByMainMonster: false,
        v5Branch: { carrierId: id, currentState: 'IDLE', active: false } });
      assert(!d.result.actions.some(a => a.id === 'M17')); assert.equal(d.selected.id, 'M09'); cases++;
    }
    const staleRecovery = decide(['M17', 'M09'], { graveSpellCount: 3, rayeNormalSummoned: true,
      v5Branch: { carrierId: 'E02', currentState: 'KAGARI_RECOVERY_DONE', active: false } });
    assert(!staleRecovery.result.actions.some(a => a.id === 'M17')); cases++;
    assert.equal(decide(['M17', 'M09'], { graveSpellCount: 3,
      v5Branch: { carrierId: 'E02', currentState: 'KAGARI_RECOVERY_DONE', active: false } }).selected.id, 'M17'); cases++;
    for (const n of [2, 3, 4]) {
      const saved = path.join(runDir, 'game-' + String(n).padStart(5, '0'), 'completed');
      const snapshot = loadSnapshot(saved), hand = snapshot.hand.data;
      snapshot.library = { status: 'KNOWN', data: require('../../../engine/card-library.json'), hash: hashValue(require('../../../engine/card-library.json')) };
      const decision = evaluateDecision(createDecisionContext(snapshot, hand), options);
      if (n !== 3) { assert.equal(decision.strategicDeadlock.terminal, true); assert.equal(decision.selected, null); }
      else {
        assert(!decision.result.actions.some(a => a.id === 'M17'), 'generic Main role is not empty field');
        snapshot.runtime.data.v5Branch.carrierId = 'TOKEN_SKY_STRIKER';
        snapshot.runtime.data.v5Branch.currentState = 'M19_EQUIPPED';
        const restored = evaluateDecision(createDecisionContext(snapshot, hand), options);
        assert.equal(restored.selected.details.fieldIntent, 'EQUIPPED_BAMBOO_DEPARTURE');
        assert.equal(restored.selected.details.targetLinkId, 'E02');
        assert.equal(restored.strategicDeadlock.terminal, false);
      }
      cases++;
    }
  });
  console.log('V7_FIELD_IDENTITY_CONTRACT_PASS; cases=' + cases + '; real G3 target + actual final evaluator; role is not identity; inputs=0/businessWrites=0');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
