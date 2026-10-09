'use strict';

const { mainDeckCandidates } = require('./incremental-hand-locator');
const {
  EXODIA_COMPONENT_IDS,
  EXODIA_UNKNOWN_ID,
  canonicalRuntimeCardId,
  countRuntimeCardIds,
  changeRuntimeCardCount
} = require('./exodia-policy');
const SAFE_DARK_IDS = new Set(['M06', 'M08']);
const classId = canonicalRuntimeCardId;
const ids = cards => (cards || []).map(row => classId(row && row.id));
const sameHand = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));
function counts(cards) {
  for (const row of cards || []) {
    const rawId = typeof row === 'string' ? row : row && row.id;
    const id = classId(rawId);
    if (!/^M\d+$/.test(id) && id !== EXODIA_UNKNOWN_ID) {
      throw new Error('M13_HAND_IDENTITY_UNRESOLVED');
    }
  }
  return countRuntimeCardIds(cards);
}
function change(map, id, delta) {
  changeRuntimeCardCount(map, id, delta, 'M13_REMOVE_ABSENT_CARD');
}
function verifyFinalMultiset({ baseline, selectedBanishId, drawnIds, finalCards }) {
  const expected = counts(baseline.cards);
  change(expected, 'M13', -1);
  // Allure draws first. A freshly drawn DARK is present before it is banished.
  for (const id of drawnIds) change(expected, id, 1);
  change(expected, selectedBanishId, -1);
  const actual = counts(finalCards);
  const mismatches = [...new Set([...expected.keys(), ...actual.keys()])]
    .filter(id => (expected.get(id) || 0) !== (actual.get(id) || 0))
    .map(id => `${id}:${expected.get(id) || 0}->${actual.get(id) || 0}`);
  if (mismatches.length) throw new Error(`M13_FINAL_HAND_MULTISET_INVALID:${mismatches.join(',')}`);
}
function observationFingerprint(incremental, block, banishedId, drawnIds) {
  return [incremental.before.capturedAt || '', incremental.after.capturedAt || '',
    incremental.before.revision, incremental.after.revision, block.signature || '',
    'M13', drawnIds.slice().sort().join(','), banishedId].join('|');
}
function verifyM13Observation({ baseline, banishProof, log, incremental }) {
  const blocks = log && log.newOperationBlocks || [];
  if (blocks.length !== 1 || blocks[0].activationKey !== 'M13') {
    throw new Error(`M13_LOG_OPERATION_INVALID:${blocks.map(b => b.activationKey).join('>')}`);
  }
  if (!incremental || incremental.status !== 'PASS') throw new Error('M13_INCREMENTAL_NOT_PASS');
  const before = incremental.before || {};
  const after = incremental.after || {};
  if (!baseline || !sameHand(baseline.cards, before.cards) ||
      (baseline.capturedAt && baseline.capturedAt !== before.capturedAt) ||
      (baseline.revision !== undefined && Number(baseline.revision) !== Number(before.revision)) ||
      !Number.isInteger(Number(before.revision)) ||
      Number(after.revision) !== Number(before.revision) + 1) {
    throw new Error('M13_OBSERVER_BASELINE_OR_REVISION_MISMATCH');
  }
  if (baseline.handCount !== before.handCount || after.handCount !== baseline.handCount ||
      (after.cards || []).length !== after.handCount || (before.cards || []).length !== before.handCount) {
    throw new Error('M13_HAND_COUNT_INVALID');
  }
  if (incremental.inference?.activationKey !== 'M13' || incremental.inference?.consumed?.id !== 'M13') {
    throw new Error('M13_CONSUMED_INVALID');
  }
  const block = blocks[0];
  const gains = (block.details || []).filter(d => d.side === 'SELF' && d.role === 'HAND_GAIN_CANDIDATE');
  const banishes = (block.details || []).filter(d => d.side === 'SELF' &&
    d.role === 'HAND_BANISH_COST' && d.rawType === 'BANISH_FROM_HAND');
  if (gains.length !== 2) throw new Error(`M13_DRAW_COUNT_INVALID:${gains.length}/2`);
  if (banishes.length !== 1) throw new Error(`M13_BANISH_COUNT_INVALID:${banishes.length}/1`);
  const banishCandidates = mainDeckCandidates(banishes[0]);
  const banishedId = banishes[0].card?.id;
  if (banishCandidates.length !== 1 || !SAFE_DARK_IDS.has(banishedId)) {
    throw new Error('M13_BANISH_IDENTITY_UNRESOLVED');
  }
  if (banishProof && (banishProof.selected?.accepted !== true || banishProof.selected.id !== banishedId)) {
    throw new Error('M13_BANISH_TARGET_MISMATCH');
  }
  // Weak thumbnails may have been resolved from passive hand alignment. Keep
  // those bounded candidates, but require one unique resulting draw multiset.
  const candidates = gains.map(d => mainDeckCandidates(d).map(c => c.id));
  const valid = new Map();
  for (const first of candidates[0]) for (const second of candidates[1]) {
    const drawnIds = [first, second];
    try {
      verifyFinalMultiset({ baseline, selectedBanishId: banishedId, drawnIds, finalCards: after.cards });
      const classDraws = drawnIds.map(classId);
      valid.set(classDraws.slice().sort().join(','), classDraws);
    } catch (error) {
      if (!/M13_FINAL_HAND_MULTISET_INVALID|M13_REMOVE_ABSENT_CARD/.test(error.message)) throw error;
    }
  }
  if (valid.size !== 1) throw new Error(`M13_DRAW_MULTISET_UNRESOLVED:${valid.size}`);
  const drawnIds = [...valid.values()][0];
  return { beforeCount: baseline.handCount, afterCount: after.handCount,
    beforeRevision: before.revision, afterRevision: after.revision,
    fingerprint: observationFingerprint(incremental, block, banishedId, drawnIds),
    banished: { id: banishedId, name: banishes[0].card.name || banishedId },
    drawn: drawnIds.map(id => ({
      id,
      name: id === EXODIA_UNKNOWN_ID ? '被封印组件（身份无需区分）' : id,
      ...(id === EXODIA_UNKNOWN_ID ? { persistentExodia: true } : {})
    })),
    insertedCards: incremental.insertedCards || [], finalHand: after.cards, operation: block };
}
function verifySavedM13Observation({ checkpoint, log, incremental, hand, ledger }) {
  if (checkpoint?.stage !== 'OBSERVER_STARTED' || !checkpoint.banishProof?.confirmProof ||
      !Number.isInteger(checkpoint.baseline?.revision)) {
    throw new Error('M13_SAVED_OBSERVATION_NOT_SUBMITTED');
  }
  const verified = verifyM13Observation({ baseline: checkpoint.baseline,
    banishProof: checkpoint.banishProof, log, incremental });
  if (!hand || Number(hand.revision) !== verified.afterRevision ||
      hand.handCount !== verified.afterCount || !sameHand(hand.cards, verified.finalHand) ||
      Number(ledger?.lastHandRevision) !== verified.afterRevision ||
      ledger?.lastM13Draw?.fingerprint !== verified.fingerprint ||
      ledger.lastM13Draw.banishedId !== verified.banished.id ||
      JSON.stringify(ledger.lastM13Draw.drawnIds?.slice().sort()) !==
        JSON.stringify(verified.drawn.map(row => row.id).sort())) {
    throw new Error('M13_SAVED_OBSERVATION_COMMIT_MISMATCH');
  }
  const ledgerOutside = id => id === EXODIA_UNKNOWN_ID
    ? Number(ledger.unknownExodiaOutsideCount || 0) + EXODIA_COMPONENT_IDS.reduce(
      (sum, componentId) => sum + Number(ledger.outsideDeckCounts?.[componentId] || 0), 0)
    : Number(ledger.outsideDeckCounts?.[id] || 0);
  for (const [id, count] of counts(hand.cards)) {
    if (count > ledgerOutside(id)) throw new Error('M13_SAVED_LEDGER_HAND_MISMATCH');
  }
  const minimumOutside = counts(incremental.before.cards);
  for (const row of verified.drawn) change(minimumOutside, row.id, 1);
  for (const [id, count] of minimumOutside) {
    if (count > ledgerOutside(id)) throw new Error('M13_SAVED_LEDGER_DRAW_MISMATCH');
  }
  return { status: 'PASS', observerVerification: verified, savedObservationOnly: true };
}
function accountM13DecisionState({ state, log, incremental }) {
  const verified = verifyM13Observation({ baseline: incremental?.before, log, incremental });
  if (state.lastM13Accounting?.fingerprint === verified.fingerprint) return state;
  const usedCounts = { ...(state.usedCounts || {}) };
  for (const id of ['M13', verified.banished.id]) usedCounts[id] = Number(usedCounts[id] || 0) + 1;
  return { ...state, usedCounts, graveSpellCount: Number(state.graveSpellCount || 0) + 1,
    lastM13Accounting: { fingerprint: verified.fingerprint, banishedId: verified.banished.id,
      beforeRevision: verified.beforeRevision, afterRevision: verified.afterRevision } };
}
module.exports = { verifyFinalMultiset, verifyM13Observation, verifySavedM13Observation,
  accountM13DecisionState };
