'use strict';
const assert = require('assert');
const { completeEffectPhase } = require('../../../src/core/field-state');
const { deriveAfterYotoResolution } = require('../../../engine/runtime/mature-driver');
const { extraDeckMonsterPresent, chooseEngageTarget } = require('../../../engine/lib/engage-policy');
const { planGoldenBambooSetup } = require('../../../engine/lib/golden-bamboo-setup-policy');
for (const carrierId of ['E02', 'E03', 'E10', 'M06', 'TOKEN_SKY_STRIKER']) {
  assert.equal(completeEffectPhase({ carrierId }, { active: false, carrierId: null }).carrierId, carrierId);
  assert.throws(() => completeEffectPhase({ carrierId }, { carrierId: 'OTHER' }), /REPLACEMENT_REQUIRES_EVIDENCE/);
  assert.equal(completeEffectPhase({ carrierId }, {}, { kind: 'DEPARTED', proven: true, actor: 'SELF', affectedController: 'SELF', fromCardId: carrierId }).carrierId, null);
}
assert.equal(completeEffectPhase({ carrierId: 'E10' }, {}, { kind: 'DEPARTED', proven: true,
  actor: 'OPPONENT', affectedController: 'SELF', fromCardId: 'E10' }).carrierId, null);
assert.throws(() => completeEffectPhase({ carrierId: 'E10' }, {}, { kind: 'DEPARTED', proven: true,
  actor: 'SELF', affectedController: 'OPPONENT', fromCardId: 'E10' }), /NOT_PROVEN/);
assert.throws(() => completeEffectPhase({}, {}), /CONTINUITY_UNKNOWN/);
const before = { usedCounts: {}, graveSpellCount: 2, bambooSwordEquipped: false, normalSummonUsed: true,
  rayeNormalSummoned: true, equippedBambooCounts: {}, effectUsage: { E10_SUMMON: 1 },
  v5Branch: { carrierId: 'E10', active: true, currentState: 'DUAL_M19_BAMBOO_PROMPT' } };
const fixed = deriveAfterYotoResolution(before, { carrierId: null, consumeRaye: true, m19SearchUsed: true });
assert.equal(fixed.v5Branch.carrierId, 'E10'); assert.equal(fixed.rayeNormalSummoned, false);
assert.equal(fixed.graveSpellCount, 3, 'Yoto -> GY adds one; DECK search does not subtract it');
assert.equal(deriveAfterYotoResolution(before, { carrierId: null, consumeRaye: true, m19SearchUsed: true,
  usedRemove: ['M17'] }).graveSpellCount, 2, 'one Yoto -> GY minus one spell recovered from GY = net zero');
assert.equal(deriveAfterYotoResolution({ ...before, v5Branch: { ...before.v5Branch, carrierId: 'E02' } },
  { carrierId: 'E02', m19SearchUsed: true, m19SearchCount: 2, usedRemove: ['M17'], kagariRecovery: true }).graveSpellCount,
  3, 'two Yoto -> GY minus one recovered spell = net plus one');
assert.equal(extraDeckMonsterPresent(fixed), true, 'resolving both effects cannot create an empty field');
assert.equal(before.v5Branch.active, true, 'pure reducer must not mutate before');
const deck = { handCounts: { M12: 1, M17: 1, M19: 1, M20: 1 }, usedCounts: {},
  deckRemaining: { M06: 1, M08: 2, M22: 1, M10: 3, M14: 3, M19: 0, M20: 0 }, byId: {} };
assert.equal(chooseEngageTarget(deck, fixed).id, 'M08', 'known E10 + Trade-In needs HAMP, not empty-field Hornet');
const cards = [{ id: 'M19', index: 1 }, { id: 'M14', index: 2 }];
assert.equal(planGoldenBambooSetup(cards, fixed, deck).carrierId, 'E10', 'remaining E10 can still be equipped for ordinary draw2');
console.log('V7_FIELD_CONTINUITY_PASS; effect completion retains 5 carrier kinds; departure/replacement needs proof; E10 blocks Hornet and remains an equip carrier; actual mature reducer pure');
