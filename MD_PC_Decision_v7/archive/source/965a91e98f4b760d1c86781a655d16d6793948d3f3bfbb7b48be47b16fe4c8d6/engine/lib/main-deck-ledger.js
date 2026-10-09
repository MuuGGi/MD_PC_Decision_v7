'use strict';

const path = require('path');
const { readJsonIfExistsSafe, writeJsonAtomic } = require('./runtime-files');
const { verifyM13Observation } = require('./m13-observer-verification');
const {
  EXODIA_COMPONENT_IDS,
  EXODIA_UNKNOWN_ID,
  isExodiaComponentCard,
  isExactExodiaComponentId,
  canonicalRuntimeCardId
} = require('./exodia-policy');

const ROOT = path.resolve(__dirname, '..');
const DECISION_STATE_PATH = path.join(ROOT, 'decision-state.json');
const LEDGER_STATE_PATH = path.join(ROOT, 'debug', 'main-deck-ledger', 'state.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const LIBRARY_PATH = path.join(ROOT, 'card-library.json');



function countById(cards) {
  const out = {};
  for (const card of cards || []) {
    const id = String(card && card.id || '');
    if (!/^M\d+$/.test(id)) continue;
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

function countUnknownExodia(cards) {
  return (cards || []).filter(card =>
    card && String(card.id || '') === EXODIA_UNKNOWN_ID && isExodiaComponentCard(card)
  ).length;
}

function totalsFromLibrary(library) {
  const totals = {};
  for (const row of (library && library.cards) || []) {
    const id = String(row && row.id || '');
    if (!/^M\d+$/.test(id)) continue;
    totals[id] = Number(row.count || 0);
  }
  return totals;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idsOf(cards) {
  return (cards || []).map(card => String(card && card.id || '')).filter(Boolean);
}

function sameSequence(a, b) {
  const aa = idsOf(a);
  const bb = idsOf(b);
  return aa.length === bb.length && aa.every((id, i) => id === bb[i]);
}

function runtimeShowsDuelProgress(runtimeState) {
  const runtime = runtimeState || readJsonIfExistsSafe(DECISION_STATE_PATH) || {};
  const used = runtime.usedCounts || {};
  const hasUsedCard = Object.values(used).some(value => Number(value || 0) > 0);
  const branchState = String(runtime && runtime.v5Branch && runtime.v5Branch.currentState || '');
  return hasUsedCard || Number(runtime.graveSpellCount || 0) > 0 ||
    Boolean(branchState && !['NONE', 'IDLE'].includes(branchState));
}

function repairKnownKagariRecovery(ledger, cards, runtimeState) {
  const runtime = runtimeState || readJsonIfExistsSafe(DECISION_STATE_PATH) || {};
  const branchState = String(runtime && runtime.v5Branch && runtime.v5Branch.currentState || '');
  if (branchState !== 'KAGARI_RECOVERY_DONE') return false;

  const handM17 = Number(countById(cards).M17 || 0);
  const outsideM17 = Number(ledger.outsideDeckCounts.M17 || 0);
  if (handM17 <= outsideM17) return false;

  // H3 has already proved that this exact M17 moved GY -> Hand.  It was
  // therefore outside the Deck before and after recovery.  This targeted
  // repair is safe even when an older --resume baseline accidentally erased
  // the GY copy from a freshly initialized ledger.
  ledger.outsideDeckCounts.M17 = handM17;
  ledger.lastKnownRecoveryRepair = {
    id: 'M17',
    branchState,
    handCount: handM17,
    reason: 'KAGARI_GY_TO_HAND_COPY_REMAINS_OUTSIDE_DECK',
    repairedAt: new Date().toISOString()
  };
  ledger.lastUpdatedAt = new Date().toISOString();
  persistLedger(ledger);
  console.log(
    `MAIN DECK LEDGER RECOVERY REPAIR: M17 outside ${outsideM17} -> ${handM17}; ` +
    'evidence=KAGARI_RECOVERY_DONE+HAND_M17'
  );
  return true;
}

function initializeLedger(library, cards, meta = {}) {
  const totals = totalsFromLibrary(library);
  const opening = countById(cards);
  const outsideDeckCounts = {};
  for (const id of Object.keys(totals)) outsideDeckCounts[id] = Number(opening[id] || 0);
  const ledger = {
    version: 2,
    mode: 'OUTSIDE_DECK_COUNT',
    initializedAt: new Date().toISOString(),
    openingBaselineCapturedAt: meta.openingBaselineCapturedAt || null,
    openingHand: idsOf(cards),
    outsideDeckCounts,
    unknownExodiaOutsideCount: countUnknownExodia(cards),
    lastHandRevision: Number(meta.lastHandRevision || 0),
    lastIncrementalFingerprint: null,
    processedLogEvents: [],
    notes: 'Deck remaining = fixed card-library count - copies currently known outside Deck. Hand/field/GY/banished moves do not change outside count; draws/searches do; Kagari recovery does not; Magical Mallet returns do.'
  };
  validateLedger(library, ledger);
  return ledger;
}

function validateLedger(library, ledger) {
  if (!ledger || ledger.version !== 2 || ledger.mode !== 'OUTSIDE_DECK_COUNT') {
    throw new Error('MAIN_DECK_LEDGER_INVALID_VERSION');
  }
  const totals = totalsFromLibrary(library);
  for (const [id, total] of Object.entries(totals)) {
    const outside = Number(ledger.outsideDeckCounts && ledger.outsideDeckCounts[id] || 0);
    if (!Number.isInteger(outside) || outside < 0 || outside > total) {
      throw new Error(`MAIN_DECK_LEDGER_COUNT_INVALID:${id};outside=${outside};total=${total}`);
    }
  }
  const unknownExodia = Number(ledger.unknownExodiaOutsideCount || 0);
  const exactExodiaOutside = EXODIA_COMPONENT_IDS.reduce(
    (sum, id) => sum + Number(ledger.outsideDeckCounts && ledger.outsideDeckCounts[id] || 0),
    0
  );
  if (!Number.isInteger(unknownExodia) || unknownExodia < 0 ||
      unknownExodia > 5 || exactExodiaOutside + unknownExodia > 5) {
    throw new Error(
      `MAIN_DECK_LEDGER_EXODIA_COUNT_INVALID:exact=${exactExodiaOutside};unknown=${unknownExodia}`
    );
  }
}

function persistLedger(ledger) {
  writeJsonAtomic(LEDGER_STATE_PATH, ledger, { trailingNewline: true });
}

function loadLibrary() {
  const library = readJsonIfExistsSafe(LIBRARY_PATH);
  if (!library || !Array.isArray(library.cards)) {
    throw new Error('MAIN_DECK_LEDGER_CARD_LIBRARY_MISSING');
  }
  return library;
}

function getExistingLedger(runtimeState) {
  const dedicated = readJsonIfExistsSafe(LEDGER_STATE_PATH);
  if (dedicated) return clone(dedicated);

  // Migration only: an earlier experimental patch stored the ledger inside
  // decision-state.json.  Read it once if present, but all new writes use the
  // dedicated ledger file so run-v5 strategic-state writes cannot erase it.
  const disk = readJsonIfExistsSafe(DECISION_STATE_PATH) || {};
  return (disk.mainDeckLedger && clone(disk.mainDeckLedger)) ||
    (runtimeState && runtimeState.mainDeckLedger && clone(runtimeState.mainDeckLedger)) || null;
}

function ensureLedger(library, cards, runtimeState, options = {}) {
  const handState = readJsonIfExistsSafe(HAND_STATE_PATH);
  let ledger = getExistingLedger(runtimeState);

  if (ledger && handState && Number(handState.revision || 0) === 0 &&
      handState.fullResync !== true &&
      handState.capturedAt && ledger.openingBaselineCapturedAt &&
      handState.capturedAt !== ledger.openingBaselineCapturedAt &&
      sameSequence(handState.cards, cards) &&
      !runtimeShowsDuelProgress(runtimeState)) {
    // A new verified opening baseline replaced the previous duel.  M11 also
    // deliberately resets the hand revision to 0, but marks fullResync=true;
    // that is the SAME duel and must never reinitialize deck counts.
    ledger = null;
  }

  if (!ledger) {
    const explicitBefore = options.explicitBefore || null;
    if (explicitBefore && Number(explicitBefore.revision || 0) === 0 && Array.isArray(explicitBefore.cards)) {
      ledger = initializeLedger(library, explicitBefore.cards, {
        openingBaselineCapturedAt: explicitBefore.capturedAt || null,
        lastHandRevision: 0
      });
      persistLedger(ledger);
      return ledger;
    }

    const revision = Number(handState && handState.revision || 0);
    if (!handState || revision !== 0 || !Array.isArray(handState.cards) || !sameSequence(handState.cards, cards)) {
      throw new Error(
        `MAIN_DECK_LEDGER_MISSING_AFTER_DUEL_PROGRESS:handRevision=${revision};` +
        '需要从新开局/新baseline开始建立固定牌数账本，禁止中途按当前手牌猜牌组。'
      );
    }
    ledger = initializeLedger(library, handState.cards, {
      openingBaselineCapturedAt: handState.capturedAt || null,
      lastHandRevision: revision
    });
    persistLedger(ledger);
  }

  validateLedger(library, ledger);

  repairKnownKagariRecovery(ledger, cards, runtimeState);

  const handCounts = countById(cards);
  for (const [id, count] of Object.entries(handCounts)) {
    if (id === EXODIA_UNKNOWN_ID) continue;
    const outside = Number(ledger.outsideDeckCounts[id] || 0);
    if (count > outside) {
      throw new Error(`MAIN_DECK_LEDGER_HAND_EXCEEDS_OUTSIDE:${id};hand=${count};outside=${outside}`);
    }
  }
  const unknownInHand = countUnknownExodia(cards);
  if (unknownInHand > Number(ledger.unknownExodiaOutsideCount || 0)) {
    throw new Error(
      `MAIN_DECK_LEDGER_UNKNOWN_EXODIA_HAND_EXCEEDS_OUTSIDE:` +
      `hand=${unknownInHand};outside=${ledger.unknownExodiaOutsideCount || 0}`
    );
  }
  return ledger;
}

function deckRemainingFromLedger(library, ledger) {
  const totals = totalsFromLibrary(library);
  const deckRemaining = {};
  for (const [id, total] of Object.entries(totals)) {
    deckRemaining[id] = total - Number(ledger.outsideDeckCounts[id] || 0);
  }
  return deckRemaining;
}

function initializeSharedDeckState(library, cards, runtimeState) {
  const ledger = ensureLedger(library, cards, runtimeState);
  return {
    ledger,
    deckRemaining: deckRemainingFromLedger(library, ledger),
    outsideDeckCounts: clone(ledger.outsideDeckCounts),
    unknownExodiaOutsideCount: Number(ledger.unknownExodiaOutsideCount || 0)
  };
}

function operationBlocks(log) {
  const all = [];
  for (const key of ['newOperationBlocks', 'extendedOperationBlocks']) {
    for (const block of (log && log[key]) || []) all.push(block);
  }
  return all;
}

function returnToHandMultiset(log) {
  const out = {};
  for (const block of operationBlocks(log)) {
    for (const detail of block && block.details || []) {
      const id = String(detail && detail.card && detail.card.id || '');
      if (!/^M\d+$/.test(id)) continue;
      const raw = String(detail.rawType || '').toUpperCase();
      const role = String(detail.role || '').toUpperCase();
      if (raw === 'RETURN_TO_HAND' || role === 'RETURN_TO_HAND') {
        out[id] = (out[id] || 0) + 1;
      }
    }
  }
  return out;
}

function bumpOutside(library, ledger, id, delta, reason) {
  if (!/^M\d+$/.test(String(id || ''))) return;
  const totals = totalsFromLibrary(library);
  const total = Number(totals[id] || 0);
  if (total <= 0) throw new Error(`MAIN_DECK_LEDGER_UNKNOWN_MAIN_CARD:${id}:${reason}`);
  const next = Number(ledger.outsideDeckCounts[id] || 0) + Number(delta || 0);
  if (!Number.isInteger(next) || next < 0 || next > total) {
    throw new Error(`MAIN_DECK_LEDGER_TRANSITION_INVALID:${id};next=${next};total=${total};reason=${reason}`);
  }
  ledger.outsideDeckCounts[id] = next;
}

function incrementalFingerprint(incrementalResult) {
  const after = incrementalResult && incrementalResult.after || {};
  const inf = incrementalResult && incrementalResult.inference || {};
  const inserted = (incrementalResult && incrementalResult.insertedCards || [])
    .map(item => String(item && item.card && item.card.id || ''))
    .join(',');
  return `${Number(after.revision || 0)}|${String(inf.activationKey || '')}|${inserted}`;
}

function applyIncrementalResultToMainDeckLedger(options = {}) {
  const incrementalResult = options.incrementalResult;
  const log = options.log || {};
  if (!incrementalResult || incrementalResult.status !== 'PASS') return null;

  const library = loadLibrary();
  const before = incrementalResult.before || {};
  const after = incrementalResult.after || {};
  const beforeCards = Array.isArray(before.cards) ? before.cards : [];
  const afterCards = Array.isArray(after.cards) ? after.cards : [];
  const ledger = ensureLedger(library, beforeCards, null, { explicitBefore: before });
  const fp = incrementalFingerprint(incrementalResult);
  if (ledger.lastIncrementalFingerprint === fp) return ledger;

  const returns = returnToHandMultiset(log);
  const e10TargetSource = String(
    options.e10TargetSource || process.env.V5_E10_TARGET_SOURCE || ''
  ).toUpperCase();
  const activationKey = String(
    incrementalResult && incrementalResult.inference &&
    incrementalResult.inference.activationKey || ''
  );
  const inserted = Array.isArray(incrementalResult.insertedCards)
    ? incrementalResult.insertedCards
    : [];

  // A drawn DARK immediately banished by M13 never becomes an insertion, but
  // both cards have still left the Deck. Validate and count the gross draws.
  const m13 = activationKey === 'M13'
    ? verifyM13Observation({ baseline: before, log, incremental: incrementalResult }) : null;
  const deckGains = m13 ? m13.drawn.map(card => ({ card })) : inserted;
  for (const item of deckGains) {
    const id = String(item && item.card && item.card.id || '');
    if (id === EXODIA_UNKNOWN_ID && isExodiaComponentCard(item && item.card)) {
      ledger.unknownExodiaOutsideCount = Number(ledger.unknownExodiaOutsideCount || 0) + 1;
      continue;
    }
    if (!/^M\d+$/.test(id)) continue;
    if (activationKey === 'E10' && id === 'M17' && e10TargetSource === 'GRAVE') {
      if (Number(returns[id] || 0) > 0) returns[id] -= 1;
      // Explicit Zeke source proof: GY -> hand, already outside the Deck.
    } else if (activationKey === 'E10' && id === 'M17' && e10TargetSource === 'DECK') {
      if (Number(returns[id] || 0) > 0) returns[id] -= 1;
      // The generic right-log verb cannot distinguish Deck from GY here.
      bumpOutside(library, ledger, id, +1, 'E10_ENGAGE_GAIN_FROM_DECK');
    } else if (Number(returns[id] || 0) > 0) {
      returns[id] -= 1;
      // Grave/field -> hand. The copy was already outside Deck.
    } else {
      bumpOutside(library, ledger, id, +1, 'HAND_GAIN_FROM_DECK');
    }
  }

  ledger.lastHandRevision = Number(after.revision || ledger.lastHandRevision || 0);
  ledger.lastIncrementalFingerprint = fp;
  if (m13) ledger.lastM13Draw = { fingerprint: m13.fingerprint,
    drawnIds: m13.drawn.map(card => card.id), banishedId: m13.banished.id,
    beforeRevision: m13.beforeRevision, afterRevision: m13.afterRevision };
  ledger.lastUpdatedAt = new Date().toISOString();
  validateLedger(library, ledger);

  const afterCounts = countById(afterCards);
  for (const [id, count] of Object.entries(afterCounts)) {
    if (id === EXODIA_UNKNOWN_ID) continue;
    if (count > Number(ledger.outsideDeckCounts[id] || 0)) {
      throw new Error(`MAIN_DECK_LEDGER_POST_HAND_INVALID:${id};hand=${count};outside=${ledger.outsideDeckCounts[id] || 0}`);
    }
  }
  const unknownAfter = countUnknownExodia(afterCards);
  if (unknownAfter > Number(ledger.unknownExodiaOutsideCount || 0)) {
    throw new Error(
      `MAIN_DECK_LEDGER_POST_UNKNOWN_EXODIA_INVALID:` +
      `hand=${unknownAfter};outside=${ledger.unknownExodiaOutsideCount || 0}`
    );
  }

  persistLedger(ledger);
  const deck = deckRemainingFromLedger(library, ledger);
  console.log(
    'MAIN DECK LEDGER COMMIT: ' +
    `revision=${ledger.lastHandRevision}; ` +
    `M06=${deck.M06 ?? '-'}; M08=${deck.M08 ?? '-'}; M17=${deck.M17 ?? '-'}; M22=${deck.M22 ?? '-'}`
  );
  return ledger;
}

function logEventFingerprint(block, detail, index) {
  return [
    String(block && block.activationKey || ''),
    String(block && block.signature || ''),
    String(detail && detail.rawType || ''),
    String(detail && detail.role || ''),
    String(detail && detail.card && detail.card.id || ''),
    String(index)
  ].join('|');
}

function applyLogOnlyToMainDeckLedger(log) {
  // Only process operations that are unambiguously Deck -> non-hand and are
  // already proven by mature field observers. Ordinary HAND_GAIN is committed
  // only by the incremental hand observer above.
  const library = loadLibrary();
  let ledger = getExistingLedger(null);
  if (!ledger) return null;
  const seen = new Set(Array.isArray(ledger.processedLogEvents) ? ledger.processedLogEvents : []);
  let changed = false;

  for (const block of operationBlocks(log)) {
    const activationKey = String(block && block.activationKey || '');
    const details = block && block.details || [];
    for (let i = 0; i < details.length; i++) {
      const detail = details[i];
      const id = String(detail && detail.card && detail.card.id || '');
      const raw = String(detail && detail.rawType || '').toUpperCase();
      const role = String(detail && detail.role || '').toUpperCase();
      // Verified True Bamboo field effect: M19 moves directly Deck -> field.
      const knownDeckToField = activationKey === 'M20' && id === 'M19' &&
        raw === 'MOVE_TO_FIELD' && role === 'FIELD_PROCESSING';
      if (!knownDeckToField) continue;
      const fp = logEventFingerprint(block, detail, i);
      if (seen.has(fp)) continue;
      bumpOutside(library, ledger, id, +1, 'M20_DECK_TO_FIELD_M19');
      seen.add(fp);
      changed = true;
    }
  }

  if (!changed) return ledger;
  ledger.processedLogEvents = Array.from(seen).slice(-120);
  ledger.lastUpdatedAt = new Date().toISOString();
  validateLedger(library, ledger);
  persistLedger(ledger);
  return ledger;
}

function commitKnownDeckExit(id, evidenceKey, reason = 'PROVEN_DECK_EXIT') {
  const cardId = String(id || '');
  const key = String(evidenceKey || '');
  if (!/^M\d+$/.test(cardId) || !key) {
    throw new Error(`MAIN_DECK_LEDGER_DIRECT_EXIT_INPUT_INVALID:${cardId}:${key}`);
  }

  const library = loadLibrary();
  const ledger = getExistingLedger(null);
  if (!ledger) throw new Error('MAIN_DECK_LEDGER_DIRECT_EXIT_WITHOUT_LEDGER');
  validateLedger(library, ledger);

  const committed = new Set(
    Array.isArray(ledger.processedDirectDeckExits) ? ledger.processedDirectDeckExits : []
  );
  if (committed.has(key)) return ledger;

  const totals = totalsFromLibrary(library);
  const total = Number(totals[cardId] || 0);
  const outsideBefore = Number(ledger.outsideDeckCounts[cardId] || 0);
  if (outsideBefore < total) {
    bumpOutside(library, ledger, cardId, +1, reason);
  }

  committed.add(key);
  ledger.processedDirectDeckExits = Array.from(committed).slice(-120);
  ledger.lastKnownDirectDeckExit = {
    id: cardId,
    evidenceKey: key,
    reason,
    outsideBefore,
    outsideAfter: Number(ledger.outsideDeckCounts[cardId] || 0),
    committedAt: new Date().toISOString()
  };
  ledger.lastUpdatedAt = new Date().toISOString();
  validateLedger(library, ledger);
  persistLedger(ledger);
  console.log(
    `MAIN DECK LEDGER DIRECT EXIT: ${cardId} outside ${outsideBefore} -> ` +
    `${ledger.outsideDeckCounts[cardId]}; evidence=${key}`
  );
  return ledger;
}

function commitKnownNonDeckHandGain({ beforeState, afterState, gainId, evidenceKey }) {
  const id = String(gainId || '');
  const key = String(evidenceKey || '');
  const beforeRevision = Number(beforeState && beforeState.revision || 0);
  const afterRevision = Number(afterState && afterState.revision || 0);
  if (!/^M\d+$/.test(id) || !key || afterRevision !== beforeRevision + 1) {
    throw new Error(
      `MAIN_DECK_LEDGER_NON_DECK_GAIN_INPUT_INVALID:` +
      `${id}:${key}:${beforeRevision}->${afterRevision}`
    );
  }

  const library = loadLibrary();
  const ledger = getExistingLedger(null);
  if (!ledger) throw new Error('MAIN_DECK_LEDGER_NON_DECK_GAIN_WITHOUT_LEDGER');
  validateLedger(library, ledger);

  const committed = new Set(
    Array.isArray(ledger.processedKnownNonDeckHandGains)
      ? ledger.processedKnownNonDeckHandGains
      : []
  );
  if (committed.has(key)) return ledger;

  const ledgerRevision = Number(ledger.lastHandRevision || 0);
  if (ledgerRevision !== beforeRevision) {
    throw new Error(
      `MAIN_DECK_LEDGER_NON_DECK_GAIN_REVISION_MISMATCH:` +
      `ledger=${ledgerRevision};before=${beforeRevision};after=${afterRevision}`
    );
  }

  // A proven GY/field -> hand move changes the hand revision but not the
  // number of copies outside the Deck.  Validate that the resulting hand is
  // still covered by the existing outside-Deck counts before advancing.
  const afterCards = Array.isArray(afterState && afterState.cards) ? afterState.cards : [];
  const afterCounts = countById(afterCards);
  for (const [cardId, count] of Object.entries(afterCounts)) {
    if (count > Number(ledger.outsideDeckCounts[cardId] || 0)) {
      throw new Error(
        `MAIN_DECK_LEDGER_NON_DECK_GAIN_HAND_EXCEEDS_OUTSIDE:` +
        `${cardId};hand=${count};outside=${ledger.outsideDeckCounts[cardId] || 0}`
      );
    }
  }

  ledger.lastHandRevision = afterRevision;
  ledger.lastIncrementalFingerprint = `${afterRevision}|KNOWN_NON_DECK_GAIN|${id}`;
  committed.add(key);
  ledger.processedKnownNonDeckHandGains = Array.from(committed).slice(-120);
  ledger.lastKnownNonDeckHandGain = {
    id,
    evidenceKey: key,
    beforeRevision,
    afterRevision,
    committedAt: new Date().toISOString()
  };
  ledger.lastUpdatedAt = new Date().toISOString();
  persistLedger(ledger);
  console.log(
    `MAIN DECK LEDGER NON-DECK GAIN: ${id}; revision ${beforeRevision}->${afterRevision}; ` +
    'outsideDeckCounts unchanged.'
  );
  return ledger;
}

function commitKnownAtomicHandGains({ beforeState, afterState, gains, evidenceKey }) {
  const key = String(evidenceKey || '');
  const beforeRevision = Number(beforeState && beforeState.revision || 0);
  const afterRevision = Number(afterState && afterState.revision || 0);
  const rows = Array.isArray(gains) ? gains : [];
  if (!key || !rows.length || afterRevision !== beforeRevision + 1) {
    throw new Error(
      `MAIN_DECK_LEDGER_ATOMIC_GAINS_INPUT_INVALID:${key}:${beforeRevision}->${afterRevision};` +
      `gains=${rows.length}`
    );
  }
  for (const row of rows) {
    if (!/^M\d+$/.test(String(row && row.id || ''))) {
      throw new Error(`MAIN_DECK_LEDGER_ATOMIC_GAIN_ID_INVALID:${row && row.id || 'NONE'}`);
    }
  }

  const library = loadLibrary();
  const ledger = getExistingLedger(null);
  if (!ledger) throw new Error('MAIN_DECK_LEDGER_ATOMIC_GAINS_WITHOUT_LEDGER');
  validateLedger(library, ledger);
  const committed = new Set(
    Array.isArray(ledger.processedKnownAtomicHandGains)
      ? ledger.processedKnownAtomicHandGains
      : []
  );
  if (committed.has(key)) return ledger;
  if (Number(ledger.lastHandRevision || 0) !== beforeRevision) {
    throw new Error(
      `MAIN_DECK_LEDGER_ATOMIC_GAINS_REVISION_MISMATCH:` +
      `${ledger.lastHandRevision || 0}!=${beforeRevision}`
    );
  }

  for (const row of rows) {
    if (row.fromDeck === true) {
      bumpOutside(library, ledger, String(row.id), +1, row.reason || 'KNOWN_ATOMIC_HAND_GAIN_FROM_DECK');
    }
  }
  ledger.lastHandRevision = afterRevision;
  ledger.lastIncrementalFingerprint = `${afterRevision}|KNOWN_ATOMIC_GAINS|${rows.map(row => row.id).join(',')}`;
  committed.add(key);
  ledger.processedKnownAtomicHandGains = Array.from(committed).slice(-120);
  ledger.lastKnownAtomicHandGains = {
    evidenceKey: key,
    gains: rows.map(row => ({
      id: String(row.id),
      fromDeck: row.fromDeck === true,
      activationKey: row.activationKey || null
    })),
    beforeRevision,
    afterRevision,
    committedAt: new Date().toISOString()
  };
  ledger.lastUpdatedAt = new Date().toISOString();
  validateLedger(library, ledger);
  const afterCounts = countById(afterState.cards || []);
  for (const [id, count] of Object.entries(afterCounts)) {
    if (count > Number(ledger.outsideDeckCounts[id] || 0)) {
      throw new Error(
        `MAIN_DECK_LEDGER_ATOMIC_GAINS_POST_HAND_INVALID:` +
        `${id};hand=${count};outside=${ledger.outsideDeckCounts[id] || 0}`
      );
    }
  }
  persistLedger(ledger);
  console.log(
    `MAIN DECK LEDGER ATOMIC GAINS: revision=${beforeRevision}->${afterRevision}; ` +
    rows.map(row => `${row.id}:${row.fromDeck === true ? 'DECK' : 'NON_DECK'}`).join(',')
  );
  return ledger;
}


function commitKnownNonDeckHandRemoval({ beforeState, afterState, removeId, evidenceKey }) {
  const id = String(removeId || '');
  const key = String(evidenceKey || '');
  const beforeRevision = Number(beforeState && beforeState.revision || 0);
  const afterRevision = Number(afterState && afterState.revision || 0);
  if (!/^M\d+$/.test(id) || !key || afterRevision !== beforeRevision + 1) {
    throw new Error(
      `MAIN_DECK_LEDGER_NON_DECK_REMOVAL_INPUT_INVALID:` +
      `${id}:${key}:${beforeRevision}->${afterRevision}`
    );
  }

  const library = loadLibrary();
  const ledger = getExistingLedger(null);
  if (!ledger) throw new Error('MAIN_DECK_LEDGER_NON_DECK_REMOVAL_WITHOUT_LEDGER');
  validateLedger(library, ledger);

  const committed = new Set(
    Array.isArray(ledger.processedKnownNonDeckHandRemovals)
      ? ledger.processedKnownNonDeckHandRemovals
      : []
  );
  if (committed.has(key)) return ledger;

  const ledgerRevision = Number(ledger.lastHandRevision || 0);
  if (ledgerRevision !== beforeRevision) {
    throw new Error(
      `MAIN_DECK_LEDGER_NON_DECK_REMOVAL_REVISION_MISMATCH:` +
      `ledger=${ledgerRevision};before=${beforeRevision};after=${afterRevision}`
    );
  }

  // Hand -> field/GY/banished does not change how many copies are outside the
  // Main Deck. It only advances the authoritative hand revision.
  const afterCards = Array.isArray(afterState && afterState.cards) ? afterState.cards : [];
  const afterCounts = countById(afterCards);
  for (const [cardId, count] of Object.entries(afterCounts)) {
    if (count > Number(ledger.outsideDeckCounts[cardId] || 0)) {
      throw new Error(
        `MAIN_DECK_LEDGER_NON_DECK_REMOVAL_HAND_EXCEEDS_OUTSIDE:` +
        `${cardId};hand=${count};outside=${ledger.outsideDeckCounts[cardId] || 0}`
      );
    }
  }

  ledger.lastHandRevision = afterRevision;
  ledger.lastIncrementalFingerprint = `${afterRevision}|KNOWN_NON_DECK_REMOVAL|${id}`;
  committed.add(key);
  ledger.processedKnownNonDeckHandRemovals = Array.from(committed).slice(-120);
  ledger.lastKnownNonDeckHandRemoval = {
    id,
    evidenceKey: key,
    beforeRevision,
    afterRevision,
    committedAt: new Date().toISOString()
  };
  ledger.lastUpdatedAt = new Date().toISOString();
  persistLedger(ledger);
  console.log(
    `MAIN DECK LEDGER NON-DECK REMOVAL: ${id}; revision ${beforeRevision}->${afterRevision}; ` +
    'outsideDeckCounts unchanged.'
  );
  return ledger;
}


function multisetSubtract(cards, removeCards) {
  const remaining = (cards || []).map(card => ({ ...card }));
  for (const remove of removeCards || []) {
    const id = isExodiaComponentCard(remove)
      ? EXODIA_UNKNOWN_ID
      : String(remove && remove.id || '');
    const index = remaining.findIndex(card => (
      isExodiaComponentCard(card) ? EXODIA_UNKNOWN_ID : String(card && card.id || '')
    ) === id);
    if (index < 0) throw new Error(`MAIN_DECK_LEDGER_MULTISET_SUBTRACT_FAILED:${id}`);
    remaining.splice(index, 1);
  }
  return remaining;
}

function multisetIdIntersection(leftIds, rightIds) {
  const remaining = new Map();
  for (const rawId of rightIds || []) {
    const id = canonicalRuntimeCardId(rawId);
    if (!id) continue;
    remaining.set(id, Number(remaining.get(id) || 0) + 1);
  }
  const overlap = [];
  for (const rawId of leftIds || []) {
    const id = canonicalRuntimeCardId(rawId);
    const count = Number(remaining.get(id) || 0);
    if (!id || count <= 0) continue;
    overlap.push(id);
    remaining.set(id, count - 1);
  }
  return overlap;
}

function reconcileMalletFullResync(options = {}) {
  const baseline = options.baseline;
  const plan = options.plan;
  const finalScan = options.finalScan;
  if (!baseline || !Array.isArray(baseline.cards) || !plan || !finalScan || !Array.isArray(finalScan.cards)) {
    throw new Error('MAIN_DECK_LEDGER_M11_INPUT_INVALID');
  }
  const library = loadLibrary();
  const ledger = ensureLedger(library, baseline.cards, null);
  const returned = Array.isArray(plan.returned) ? plan.returned : [];
  const kept = Array.isArray(plan.kept) ? plan.kept : [];

  // M11 performs a full hand scan.  Normalize every sealed component to the
  // class token before persistence; migrate any earlier exact hand identities
  // into the aggregate counter so later decisions never depend on head/limb.
  if ((finalScan.cards || []).some(card => String(card && card.id || '') === EXODIA_UNKNOWN_ID)) {
    for (const card of baseline.cards) {
      const id = String(card && card.id || '');
      if (!isExactExodiaComponentId(id)) continue;
      const outside = Number(ledger.outsideDeckCounts[id] || 0);
      if (outside <= 0) throw new Error(`MAIN_DECK_LEDGER_M11_EXODIA_MIGRATION_MISSING:${id}`);
      ledger.outsideDeckCounts[id] = outside - 1;
      ledger.unknownExodiaOutsideCount = Number(ledger.unknownExodiaOutsideCount || 0) + 1;
    }
  }

  for (const card of returned) {
    if (isExodiaComponentCard(card)) {
      ledger.unknownExodiaOutsideCount = Number(ledger.unknownExodiaOutsideCount || 0) - 1;
    } else {
      bumpOutside(library, ledger, String(card && card.id || ''), -1, 'M11_RETURN_TO_DECK');
    }
  }

  const drawn = multisetSubtract(finalScan.cards, kept);
  if (drawn.length !== returned.length) {
    throw new Error(`MAIN_DECK_LEDGER_M11_DRAW_COUNT_MISMATCH:${drawn.length}/${returned.length}`);
  }
  for (const card of drawn) {
    if (isExodiaComponentCard(card)) {
      ledger.unknownExodiaOutsideCount = Number(ledger.unknownExodiaOutsideCount || 0) + 1;
    } else {
      bumpOutside(library, ledger, String(card && card.id || ''), +1, 'M11_REDRAW_FROM_DECK');
    }
  }

  ledger.lastHandRevision = 0; // M11 FULL RESYNC intentionally rebuilds the hand baseline.
  ledger.lastIncrementalFingerprint = null;
  ledger.lastUpdatedAt = new Date().toISOString();
  const returnedIds = returned.map(card => isExodiaComponentCard(card)
    ? EXODIA_UNKNOWN_ID : String(card && card.id || ''));
  const drawnIds = drawn.map(card => isExodiaComponentCard(card)
    ? EXODIA_UNKNOWN_ID : String(card && card.id || ''));
  ledger.lastMallet = {
    returned: returnedIds,
    drawn: drawnIds,
    returnedThenRedrawn: multisetIdIntersection(returnedIds, drawnIds)
  };
  validateLedger(library, ledger);
  persistLedger(ledger);
  const deck = deckRemainingFromLedger(library, ledger);
  console.log(
    `MAIN DECK LEDGER M11 RECONCILE: returned=${ledger.lastMallet.returned.join(',') || 'NONE'}; ` +
    `drawn=${ledger.lastMallet.drawn.join(',') || 'NONE'}; ` +
    `returnedThenRedrawn=${ledger.lastMallet.returnedThenRedrawn.join(',') || 'NONE'}; ` +
    `M22=${deck.M22 ?? '-'}; M08=${deck.M08 ?? '-'}`
  );
  return ledger;
}


// Pure query: initialization/repair belongs to explicit observer/driver work.
function getReadOnlySharedDeckState(library, cards, runtimeState) {
  const fs = require('fs');
  if (fs.existsSync(LEDGER_STATE_PATH)) JSON.parse(fs.readFileSync(LEDGER_STATE_PATH, 'utf8'));
  const ledger = getExistingLedger(runtimeState);
  if (!ledger) throw new Error('MAIN_DECK_LEDGER_READ_ONLY_SOURCE_MISSING');
  validateLedger(library, ledger);
  for (const id of Object.keys(totalsFromLibrary(library))) {
    if (!Number.isInteger(ledger.outsideDeckCounts && ledger.outsideDeckCounts[id]))
      throw new Error('MAIN_DECK_LEDGER_READ_ONLY_COUNT_UNKNOWN:' + id);
  }
  if (countUnknownExodia(cards) > Number(ledger.unknownExodiaOutsideCount || 0))
    throw new Error('MAIN_DECK_LEDGER_READ_ONLY_COMPONENT_HAND_MISMATCH');
  // Snapshot revision alignment is checked once by V7 before decision/dispatch.
  // A pure hypothetical resource query must not depend on another disk hand.
  for (const [id, count] of Object.entries(countById(cards))) {
    if (count > Number(ledger.outsideDeckCounts[id] || 0))
      throw new Error('MAIN_DECK_LEDGER_READ_ONLY_HAND_MISMATCH:' + id);
  }
  return { ledger, deckRemaining: deckRemainingFromLedger(library, ledger),
    outsideDeckCounts: clone(ledger.outsideDeckCounts), unknownExodiaOutsideCount: Number(ledger.unknownExodiaOutsideCount || 0) };
}

module.exports = {
  getReadOnlySharedDeckState,
  initializeSharedDeckState,
  countById,
  getSharedDeckState: getReadOnlySharedDeckState,
  applyIncrementalResultToMainDeckLedger,
  applyLogOnlyToMainDeckLedger,
  commitKnownDeckExit,
  commitKnownAtomicHandGains,
  commitKnownNonDeckHandGain,
  commitKnownNonDeckHandRemoval,
  reconcileMalletFullResync
};
