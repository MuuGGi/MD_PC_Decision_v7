'use strict';
const path = require('path');
const { readJsonFact, hashValue } = require('./json-store');
function known(fact) { return Boolean(fact && fact.status === 'KNOWN' && fact.data && typeof fact.data === 'object' && !Array.isArray(fact.data)); }
function loadSnapshot(root, options = {}) {
  const common = Number.isFinite(options.maxAgeMs) ? { maxAgeMs: options.maxAgeMs } : {};
  const read = (rel, opts = common) => readJsonFact(path.join(root, rel), opts);
  const snapshot = { root, capturedAt: new Date().toISOString(),
    hand: read('debug/hand-change-live/session_state.json'), runtime: read('decision-state.json'),
    ledger: read('debug/main-deck-ledger/state.json'), log: read('debug/duel-log-live/latest_result.json'),
    observerState: read('debug/duel-log-live/observer_state.json'), library: read('card-library.json', {}),
    victory: read('debug/duel-outcome-live/latest_result.json'),
    session: read('debug/v7/session.json', {}) };
  snapshot.consistency = [];
  if (known(snapshot.hand)) {
    const { cards, handCount } = snapshot.hand.data;
    if (!Array.isArray(cards) || !Number.isInteger(handCount) || handCount < 0 || cards.length !== handCount)
      snapshot.consistency.push({ code: 'HAND_COUNT_SCHEMA_INVALID' });
    else if (cards.some(c => !c || typeof c.id !== 'string' || c.id === 'UNKNOWN' || !c.id))
      snapshot.consistency.push({ code: 'HAND_IDENTITY_UNKNOWN' });
  }
  if (known(snapshot.runtime)) {
    const runtime = snapshot.runtime.data;
    if (!Number.isInteger(runtime.graveSpellCount) || runtime.graveSpellCount < 0 ||
        typeof runtime.normalSummonUsed !== 'boolean' || typeof runtime.bambooSwordEquipped !== 'boolean' ||
        !runtime.usedCounts || Array.isArray(runtime.usedCounts) || typeof runtime.usedCounts !== 'object' ||
        Object.values(runtime.usedCounts).some(n => !Number.isInteger(n) || n < 0))
      snapshot.consistency.push({ code: 'RUNTIME_RESOURCE_SCHEMA_UNKNOWN' });
  }
  if (known(snapshot.library) && known(snapshot.ledger)) {
    const rows = snapshot.library.data.cards, ledger = snapshot.ledger.data;
    if (!Array.isArray(rows) || !rows.length || rows.filter(r => /^M\d+$/.test(r.id || '')).some(r =>
      !Number.isInteger(r.count) || r.count < 0 || !Number.isInteger(ledger.outsideDeckCounts && ledger.outsideDeckCounts[r.id]) ||
      ledger.outsideDeckCounts[r.id] < 0 || ledger.outsideDeckCounts[r.id] > r.count))
      snapshot.consistency.push({ code: 'LEDGER_RESOURCE_SCHEMA_UNKNOWN' });
    if (known(snapshot.hand) && Array.isArray(snapshot.hand.data.cards)) {
      const counts = {};
      for (const card of snapshot.hand.data.cards) { const id = card && card.id; counts[id] = (counts[id] || 0) + 1; }
      for (const [id, count] of Object.entries(counts)) {
        const outside = id === 'EXODIA_UNKNOWN' ? ledger.unknownExodiaOutsideCount : ledger.outsideDeckCounts && ledger.outsideDeckCounts[id];
        if (!Number.isInteger(outside) || outside < count) snapshot.consistency.push({ code: 'HAND_EXCEEDS_LEDGER_OR_UNKNOWN', id });
      }
    }
  }
  if (known(snapshot.hand) && known(snapshot.ledger)) {
    const h = snapshot.hand.data.revision, l = snapshot.ledger.data.lastHandRevision;
    if (!Number.isInteger(h) || !Number.isInteger(l) || h < 0 || l < 0 || h !== l)
      snapshot.consistency.push({ code: 'HAND_LEDGER_REVISION_MISMATCH', handRevision: h, ledgerRevision: l });
  }
  if (known(snapshot.hand) && !Array.isArray(snapshot.hand.data.cards)) snapshot.consistency.push({ code: 'HAND_CARDS_INVALID' });
  snapshot.snapshotKey = hashValue(Object.fromEntries(['hand', 'runtime', 'ledger', 'log', 'observerState', 'library', 'session'].map(k =>
    [k, known(snapshot[k]) ? snapshot[k].hash : 'UNKNOWN:' + (snapshot[k].reason || 'INVALID_SCHEMA')])));
  return snapshot;
}
function deriveDuelIdentity(snapshot) {
  if (known(snapshot.session) && snapshot.session.data.duelId && snapshot.session.data.startProven === true)
    return { status: 'KNOWN', source: 'V7_PROVEN_SESSION', value: snapshot.session.data.duelId };
  if (known(snapshot.ledger) && snapshot.ledger.data.openingBaselineCapturedAt)
    return { status: 'KNOWN', source: 'LEDGER_OPENING_BASELINE', value: 'DUEL-' +
      hashValue({ at: snapshot.ledger.data.openingBaselineCapturedAt, openingHand: snapshot.ledger.data.openingHand || null }).slice(0, 24) };
  if (known(snapshot.hand) && snapshot.hand.data.revision === 0 && snapshot.hand.data.fullResync !== true && snapshot.hand.data.capturedAt)
    return { status: 'KNOWN', source: 'HAND_OPENING_BASELINE', value: 'DUEL-' +
      hashValue({ at: snapshot.hand.data.capturedAt, cards: (snapshot.hand.data.cards || []).map(card => card.id) }).slice(0, 24) };
  return { status: 'UNKNOWN', reason: 'NO_STABLE_DUEL_BASELINE' };
}
function buildActionBaseline(snapshot, extra = {}) {
  // Evidence timestamps are not action identity. Only relevant business revisions/facts.
  return { hand: known(snapshot.hand) ? { revision: snapshot.hand.data.revision, cards: snapshot.hand.data.cards.map(c => c.id) } : { unknown: true },
    ledger: known(snapshot.ledger) ? { revision: snapshot.ledger.data.lastHandRevision, counts: snapshot.ledger.data.outsideDeckCounts } : { unknown: true },
    observer: known(snapshot.observerState) ? { checkpoint: snapshot.observerState.data.checkpoint || null } : { unknown: true },
    runtime: known(snapshot.runtime) ? { fieldSpell: snapshot.runtime.data.fieldSpell || null,
      branch: snapshot.runtime.data.v5Branch || null, normalSummonUsed: snapshot.runtime.data.normalSummonUsed === true,
      bambooSwordEquipped: snapshot.runtime.data.bambooSwordEquipped === true, usedCounts: snapshot.runtime.data.usedCounts || {} } : { unknown: true },
    extra };
}
module.exports = { known, loadSnapshot, deriveDuelIdentity, buildActionBaseline };
