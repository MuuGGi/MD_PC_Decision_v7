'use strict';
const { hashValue } = require('./json-store');
const RELIABILITY = Object.freeze({ PROVEN: 'PROVEN', SUPPORTED: 'SUPPORTED', UNKNOWN: 'UNKNOWN' });
const ACTOR = Object.freeze({ SELF: 'SELF', OPPONENT: 'OPPONENT', UNKNOWN: 'UNKNOWN' });
function actorOf(value) { return Object.values(ACTOR).includes(String(value || '').toUpperCase()) ? String(value).toUpperCase() : ACTOR.UNKNOWN; }
function normDetail(detail = {}) {
  return { type: detail.type || null, rawType: detail.rawType || null, role: detail.role || null,
    actor: actorOf(detail.side), cardId: detail.card && detail.card.id || null, cardName: detail.card && detail.card.name || null,
    source: detail.source || null, inferred: detail.inferred === true, box: detail.box || null };
}
function semanticSignature(block = {}) {
  return hashValue({ action: block.activationKey || null, actor: actorOf(block.activation && block.activation.side),
    details: (block.details || []).map(d => { const n = normDetail(d); delete n.box; return n; }) });
}
function headerKey(block) {
  return hashValue({ action: block.activationKey || null, actor: actorOf(block.activation && block.activation.side),
    source: block.activation && block.activation.source || null });
}
function detailKey(detail) { const n = normDetail(detail); delete n.box; return hashValue(n); }
function subset(previous, current) {
  const pool = current.map(detailKey);
  return previous.every(detail => { const i = pool.indexOf(detailKey(detail)); if (i < 0) return false; pool.splice(i, 1); return true; });
}
function adaptV6ObserverResult(log = {}, options = {}) {
  const duelId = options.duelId || null, previous = options.previousContract && options.previousContract.duelId === duelId ? options.previousContract : null;
  const newRows = Array.isArray(log.newOperationBlocks) ? log.newOperationBlocks : log.newActivationBlocks || [];
  const extended = Array.isArray(log.extendedOperationBlocks) ? log.extendedOperationBlocks : [];
  const transitions = Array.isArray(log.observerFieldTransitions) ? log.observerFieldTransitions : [];
  const anchor = hashValue(log.matchedContinuityAnchor || { continuity: log.continuity || null }).slice(0, 24);
  const observationId = 'OBS-' + hashValue({ duelId, anchor, new: newRows.map(semanticSignature), extended: extended.map(semanticSignature), transitions }).slice(0, 28);
  if (previous && previous.observationId === observationId) return previous;
  const history = previous ? previous.history || previous.events || [] : [];
  const priorEvents = history.filter(e => e.kind === 'OPERATION');
  const events = [], used = new Set(), occurrences = new Map();
  let sequence = previous && previous.sequence || 0;
  for (const [sourceClass, rows] of [['NEW', newRows], ['EXTENDED', extended]]) {
    for (const block of rows) {
      const signature = semanticSignature(block), header = headerKey(block), occurrence = occurrences.get(header) || 0;
      occurrences.set(header, occurrence + 1);
      const matches = priorEvents.filter(e => e.headerKey === header && !used.has(e.eventInstanceKey) &&
        subset(e.evidence.rawDetails || [], block.details || []));
      // Only EXTENDED is authorized to update a prior operation. NEW means a new event.
      const prior = sourceClass === 'EXTENDED' && matches.length === 1 ? matches[0] : null;
      const identityUncertain = sourceClass === 'EXTENDED' && previous && matches.length !== 1;
      let eventInstanceKey = prior && prior.eventInstanceKey;
      if (!eventInstanceKey) {
        sequence++;
        eventInstanceKey = 'EV-' + hashValue({ duelId, birthAnchor: anchor, header, occurrence, sequence }).slice(0, 28);
      }
      used.add(eventInstanceKey);
      const details = (block.details || []).map(normDetail);
      // The actor of activation is NOT the owner of its affected target/result.
      const actor = actorOf(block.activation && block.activation.side);
      const counterpart = events.find(e => e.headerKey === header && e.evidence.signature === signature && e.sourceClass === 'NEW');
      if (sourceClass === 'EXTENDED' && counterpart && !prior) {
        counterpart.sourceClass = 'MULTI_PATH'; continue;
      }
      events.push({ eventInstanceKey, kind: 'OPERATION', actionType: block.activationKey || null, actor,
        headerKey: header, occurrence, sourceClass, sourceZone: null, targetZone: null, count: null,
        continuityAnchor: anchor, reliability: identityUncertain ? RELIABILITY.UNKNOWN : details.length ? RELIABILITY.SUPPORTED : RELIABILITY.UNKNOWN,
        identityStatus: identityUncertain ? 'AMBIGUOUS' : 'TRACKED',
        evidence: { signature, details, rawDetails: block.details || [], relationship: block.relationship || null },
        consumptionState: prior && prior.consumptionState || 'UNCONSUMED' });
    }
  }
  for (const transition of transitions) {
    const candidates = [...newRows, ...extended].filter(b => b.activationKey === transition.activationKey);
    const corroborations = candidates.flatMap(block => (block.details || []).filter(d =>
      String(d.rawType || d.type) === 'LINK_SUMMON' && d.card && d.card.id === transition.to &&
      actorOf(d.side) === ACTOR.SELF && d.inferred !== true &&
      ['SEMANTIC_LABEL', 'ACTION_LABEL_AND_ZONE_ICONS'].includes(d.source)).map(detail => ({ block, detail })));
    const c = corroborations.length === 1 ? corroborations[0] : null;
    const tokenInBlock = c && (c.block.details || []).some(d => d.card && d.card.id === transition.from &&
      String(d.rawType || d.type) === 'SPECIAL_SUMMON' && d.side === 'SELF' && d.inferred !== true);
    // A past summon event alone is NOT proof that its token still exists.
    const field = options.fieldFacts && options.fieldFacts[transition.from];
    const savedToken = Boolean(field && field.status === 'PROVEN' && field.duelId === duelId &&
      field.continuityAnchor === anchor && field.consumed !== true);
    const proven = Boolean(duelId && c && (tokenInBlock || savedToken) &&
      (!log.previousCheckpointFound || log.matchedContinuityAnchor));
    const old = history.find(e => e.kind === 'FIELD_TRANSITION' && e.continuityAnchor === anchor &&
      e.actionType === transition.type && e.fromCardId === transition.from && e.toCardId === transition.to);
    events.push({ eventInstanceKey: old ? old.eventInstanceKey : 'EV-' + hashValue({ duelId, anchor, transition }).slice(0, 28),
      kind: 'FIELD_TRANSITION', actionType: transition.type || null, actor: c ? actorOf(c.detail.side) : ACTOR.UNKNOWN,
      sourceClass: 'FIELD_TRANSITION', sourceZone: 'FIELD', targetZone: 'FIELD', fromCardId: transition.from || null,
      toCardId: transition.to || null, count: 1, continuityAnchor: anchor,
      reliability: proven ? RELIABILITY.PROVEN : RELIABILITY.SUPPORTED,
      evidence: { declared: transition.evidence || [], corroboration: c ? normDetail(c.detail) : null },
      consumptionState: old && old.consumptionState || 'UNCONSUMED' });
  }
  return { version: 2, duelId, observationId, continuity: log.continuity || null, continuityAnchor: anchor,
    sequence, events, history: dedupeAcrossFrames([{ events: history }, { events }]),
    source: { capturedAt: log.capturedAt || log.checkedAt || null, matchedContinuityAnchor: log.matchedContinuityAnchor || null } };
}
function dedupeAcrossFrames(contracts) {
  const map = new Map();
  for (const contract of contracts || []) for (const event of contract.events || []) map.set(event.eventInstanceKey, event);
  return [...map.values()];
}
module.exports = { RELIABILITY, ACTOR, actorOf, normDetail, semanticSignature, adaptV6ObserverResult, dedupeAcrossFrames };
