'use strict';
const { isLegalBambooSearchTarget } = require('./bamboo-search-policy');

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists, writeJsonAtomic } = require('./runtime-files');

const ROUTE_VERSION = 9;
const MAX_TRACE = 120;
const MAX_HISTORY = 20;

function cardId(detail) {
  return String(detail && detail.card && detail.card.id || '');
}

function cardName(detail) {
  return String(detail && detail.card && detail.card.name || cardId(detail) || '未知卡');
}

function blockName(block) {
  return String(
    block && block.activation && block.activation.card && block.activation.card.name ||
    block && block.activationKey ||
    '未知操作'
  );
}

function detailRawType(detail) {
  return String(detail && (detail.rawType || detail.type) || '');
}

function detailRole(detail) {
  return String(detail && detail.role || '');
}

function isSelf(detail) {
  return !detail || !detail.side || detail.side === 'SELF';
}

function eventFingerprint(event) {
  return [
    event.kind,
    event.blockIndex,
    event.activationKey || '',
    event.cardId || '',
    event.mode || '',
    event.detailIndex == null ? '' : event.detailIndex,
    event.signature || '',
    event.observationId || ''
  ].join('|');
}

function makeEvent(kind, block, blockIndex, extra = {}) {
  return {
    kind,
    blockIndex,
    activationKey: block && block.activationKey || null,
    activationName: blockName(block),
    signature: block && block.signature || null,
    ...extra
  };
}

function removalCountForBlock(block) {
  const ids = [];
  for (const detail of block && block.details || []) {
    if (detailRole(detail) !== 'REMOVAL_RESULT') continue;
    const id = cardId(detail);
    ids.push(id || `ROW_${ids.length + 1}`);
  }
  return ids.length;
}

function inferLinkMode(block, linkDetail = null) {
  const removed = removalCountForBlock(block);
  if (removed >= 2) return { mode: 'DOUBLE_LINK', materialCount: removed, inferred: false };
  if (removed === 1) return { mode: 'SINGLE_LINK', materialCount: 1, inferred: false };

  // Mature live-observer evidence: M22 -> Sky Striker Token may remain one
  // compact operation block and later grow LINK_SUMMON:E02/E10 while the
  // physical removal row is clipped. E02/E10 are the already-supported
  // single-material continuation of that token stage. Keep this narrow; do
  // not infer single/double merely from an arbitrary M22 Link row.
  const key = String(block && block.activationKey || '');
  const resultId = cardId(linkDetail);
  const hasTokenSource = (block && block.details || []).some(detail =>
    detailRawType(detail) === 'SPECIAL_SUMMON' &&
    (cardId(detail) === 'TOKEN_SKY_STRIKER' || /衍生物/.test(cardName(detail)))
  );
  if (key === 'M22' && hasTokenSource && ['E02', 'E10'].includes(resultId)) {
    return {
      mode: 'SINGLE_LINK',
      materialCount: 1,
      inferred: true,
      inference: 'M22_TOKEN_TO_LINK1_COMPACT_EXTENSION'
    };
  }
  return { mode: 'LINK_UNCLASSIFIED', materialCount: null, inferred: true };
}

function extractCompositeRouteEvents(blocks, options = {}) {
  const source = Array.isArray(blocks) ? blocks : [];
  const beforeHand = Array.isArray(options.beforeHand) ? options.beforeHand : [];
  const beforeHandIds = new Set(beforeHand.map(card => String(card && card.id || '')).filter(Boolean));
  const events = [];

  for (let blockIndex = 0; blockIndex < source.length; blockIndex++) {
    const block = source[blockIndex];
    if (!block) continue;
    const key = String(block.activationKey || '');
    const details = Array.isArray(block.details) ? block.details : [];
    const hasTarget = details.some(detail => detailRole(detail) === 'TARGET');

    // Stage 1: material source. The composite route begins when the material
    // is CREATED/PUT ON FIELD, not after a generic MATERIAL_READY assumption.
    // For the current deck there are two first-class sources we want to verify:
    //   1) M22 Hornet Drones -> Sky Striker Token
    //   2) normal summon M06 Raye from the hand
    // Keep the source explicit so later Link/equip branches can be compared by
    // their actual entry state.
    if (key === 'M22') {
      const token = details.find(detail => {
        const id = cardId(detail);
        const name = cardName(detail);
        const raw = detailRawType(detail);
        return raw === 'SPECIAL_SUMMON' && (id === 'TOKEN_SKY_STRIKER' || /衍生物/.test(name));
      });
      if (token) {
        events.push(makeEvent('MATERIAL_SOURCE', block, blockIndex, {
          mode: 'HORNET_TOKEN',
          detailIndex: details.indexOf(token),
          producerId: 'M22',
          producerName: '闪刀机－大黄蜂无人机',
          cardId: cardId(token) || 'TOKEN_SKY_STRIKER',
          cardName: cardName(token) || '闪刀姬衍生物',
          rawType: detailRawType(token) || 'SPECIAL_SUMMON',
          source: 'M22_SPECIAL_SUMMON_TOKEN'
        }));
      }
    }

    if (key === 'M06') {
      const relationship = block && block.relationship && block.relationship.type || null;
      const hasRealLink = details.some(detail => detailRawType(detail) === 'LINK_SUMMON');
      const renderedExtra = details.find(detail => /^E\d+$/.test(cardId(detail)));
      const explicitNormal = details.some(detail => detailRawType(detail) === 'NORMAL_SUMMON');
      const looksLikeIndependentHandPlacement =
        beforeHandIds.has('M06') &&
        !hasTarget &&
        !hasRealLink &&
        !renderedExtra &&
        relationship !== 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD' &&
        relationship !== 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING';
      if (explicitNormal || looksLikeIndependentHandPlacement) {
        events.push(makeEvent('MATERIAL_SOURCE', block, blockIndex, {
          mode: 'RAYE_NORMAL_SUMMON',
          producerId: 'M06',
          producerName: '闪刀姬－零衣',
          cardId: 'M06',
          cardName: '闪刀姬－零衣',
          rawType: explicitNormal ? 'NORMAL_SUMMON' : null,
          inferred: !explicitNormal,
          inference: explicitNormal ? null : 'INDEPENDENT_M06_BLOCK_CONSUMES_KNOWN_HAND_AS_NORMAL_SUMMON',
          source: explicitNormal ? 'RIGHT_LOG_NORMAL_SUMMON' : 'HAND_CONSUMPTION_PLUS_INDEPENDENT_M06_BLOCK'
        }));
      }
    }

    // Stage 2: optional equip. We deliberately record the equip source rather
    // than calling it a separate M19/M20 route.
    if (key === 'M19' && hasTarget) {
      events.push(makeEvent('EQUIP', block, blockIndex, {
        mode: 'M19_FROM_HAND',
        swordId: 'M19',
        swordName: '妖刀竹光',
        source: 'HAND_ACTIVATION'
      }));
    }
    if (key === 'M20' && hasTarget) {
      events.push(makeEvent('EQUIP', block, blockIndex, {
        mode: 'M20_FROM_HAND',
        swordId: 'M20',
        swordName: '真刀竹光',
        source: 'HAND_ACTIVATION'
      }));
    }
    if (key === 'M20') {
      const movesYoto = details.some(detail =>
        detailRawType(detail) === 'MOVE_TO_FIELD' && cardId(detail) === 'M19'
      );
      if (movesYoto) {
        events.push(makeEvent('EQUIP', block, blockIndex, {
          mode: 'M20_FIELD_TO_M19',
          swordId: 'M19',
          swordName: '妖刀竹光',
          source: 'M20_FIELD_EFFECT'
        }));
      }
    }

    // Stage 3B: Raye self-effect is an alternative carrier-exit branch rather
    // than a Link operation. Live MD can render the summoned Extra Deck card
    // as a pseudo hand-gain row, so use the already-proven narrow signature.
    if (key === 'M06') {
      const renderedExtra = details.find(detail => /^E\d+$/.test(cardId(detail)));
      const hasRealLink = details.some(detail => detailRawType(detail) === 'LINK_SUMMON');
      if (renderedExtra && !hasRealLink) {
        events.push(makeEvent('MATERIAL_EXIT', block, blockIndex, {
          mode: 'RAYE_EFFECT',
          materialCount: 1,
          resultCardId: cardId(renderedExtra),
          resultCardName: cardName(renderedExtra),
          inferred: true,
          inference: 'RAYE_SELF_EFFECT_RENDERED_EXTRA_DECK_RESULT'
        }));
        events.push(makeEvent('SUMMON_RESULT', block, blockIndex, {
          mode: 'RAYE_EFFECT',
          cardId: cardId(renderedExtra),
          cardName: cardName(renderedExtra),
          inferred: true,
          inference: 'RAYE_SELF_EFFECT_RENDERED_EXTRA_DECK_RESULT'
        }));
      }
    }

    // Stage 3A/3C + Stage 4: generic Link result. Material count is only
    // classified when the right-log block itself exposes enough removals.
    details.forEach((detail, detailIndex) => {
      if (!isSelf(detail) || detailRawType(detail) !== 'LINK_SUMMON') return;
      const link = inferLinkMode(block, detail);
      events.push(makeEvent('MATERIAL_EXIT', block, blockIndex, {
        detailIndex,
        mode: link.mode,
        materialCount: link.materialCount,
        inferred: link.inferred,
        inference: link.inference || null,
        resultCardId: cardId(detail) || null,
        resultCardName: cardName(detail)
      }));
      events.push(makeEvent('SUMMON_RESULT', block, blockIndex, {
        detailIndex,
        mode: link.mode,
        cardId: cardId(detail) || null,
        cardName: cardName(detail),
        inferred: false
      }));
    });

    // Stage 5: Yoto's graveyard search. A header-only M19 after the carrier
    // left is still useful evidence even when the final gain row is clipped.
    if (key === 'M19' && !hasTarget) {
      const gains = details.filter(detail =>
        isSelf(detail) && detailRole(detail) === 'HAND_GAIN_CANDIDATE'
      );
      const bambooGains = gains.filter(detail => isLegalBambooSearchTarget(cardId(detail)));
      if (bambooGains.length) {
        bambooGains.forEach(detail => {
          events.push(makeEvent('POST_EFFECT', block, blockIndex, {
            mode: 'M19_SEARCH',
            status: 'RESOLVED',
            cardId: cardId(detail),
            cardName: cardName(detail)
          }));
        });
      } else {
        const hasExitOrSummonEvidence = details.some(detail =>
          detailRawType(detail) === 'LINK_SUMMON' ||
          detailRole(detail) === 'REMOVAL_RESULT' ||
          detailRole(detail) === 'SUMMON_RESULT'
        );
        if (!hasExitOrSummonEvidence) {
          events.push(makeEvent('POST_EFFECT', block, blockIndex, {
            mode: 'M19_SEARCH',
            status: 'HEADER_ONLY',
            cardId: null,
            cardName: null
          }));
        }
      }
    }

    // Extra Deck monster follow-up effects are kept generic. Kagari currently
    // has the strongest mature evidence (M17/M22 recovery), but this structure
    // also accepts future E* search/recovery effects without inventing routes.
    if (/^E\d+$/.test(key)) {
      details.forEach((detail, detailIndex) => {
        if (!isSelf(detail) || detailRole(detail) !== 'HAND_GAIN_CANDIDATE') return;
        events.push(makeEvent('POST_EFFECT', block, blockIndex, {
          detailIndex,
          mode: key === 'E02' ? 'MONSTER_RECOVER' : 'MONSTER_HAND_GAIN',
          status: 'RESOLVED',
          sourceMonsterId: key,
          cardId: cardId(detail) || null,
          cardName: cardName(detail)
        }));
      });
    }
  }

  const seen = new Set();
  return events.filter(event => {
    const fp = eventFingerprint(event);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}

function emptySegment(index = 1) {
  return {
    index,
    phase: 'IDLE',
    material: {
      ready: false,
      summoned: []
    },
    equip: {
      mode: 'NONE',
      swordId: null,
      swordName: null,
      source: null
    },
    exit: {
      mode: null,
      materialCount: null,
      resultCardId: null,
      resultCardName: null,
      inferred: false
    },
    summon: {
      cardId: null,
      cardName: null,
      mode: null,
      inferred: false
    },
    optionalEffect: {
      status: 'NONE',
      mode: null,
      available: false,
      resolution: 'NONE',
      candidateCount: null,
      poolCandidateCount: 0,
      selectedCandidateCount: 0,
      resolvedCandidateCount: 0,
      detector: null,
      resolvedAt: null,
      observedCount: 0,
      resolvedCount: 0,
      resolutions: [],
      effectSelections: [],
      effectResolutions: [],
      lastResolutionScope: null
    },
    chain: {
      status: 'NONE',
      links: [],
      currentResolvingMode: null,
      startedAt: null,
      resolvedAt: null
    },
    activeEffect: {
      mode: null,
      status: 'NONE',
      requiresTargetSelection: false,
      requiresResolutionSelection: false,
      selectedAt: null,
      resolvedAt: null,
      resolutionCounted: false,
      targetSelectionTiming: null
    },
    targetSelection: {
      status: 'NONE',
      available: false,
      effectMode: null,
      selectionTiming: null,
      candidateCount: null,
      allowedTargets: [],
      selectedCardId: null,
      selectedCardName: null,
      detector: null,
      observedAt: null,
      submittedAt: null,
      resolvedAt: null
    },
    postEffects: [],
    effectQueue: [],
    trace: []
  };
}

function initialState() {
  return {
    version: ROUTE_VERSION,
    capturedAt: null,
    revision: 0,
    // Observation telemetry only. M19's graveyard search is repeatable; these
    // fields record seen activations and must never be used as a turn-level gate.
    turnUsage: {
      m19SearchUsed: false,
      m19SearchActivationCount: 0,
      m19SearchUsedAt: null,
      source: null
    },
    current: emptySegment(1),
    history: [],
    seenEvents: []
  };
}

function normalizeState(value) {
  if (!value || ![2, 3, 4, 5, 7, 8, ROUTE_VERSION].includes(Number(value.version)) || !value.current) return initialState();
  return {
    ...initialState(),
    ...value,
    version: ROUTE_VERSION,
    turnUsage: {
      ...initialState().turnUsage,
      ...(value.turnUsage || {})
    },
    current: {
      ...emptySegment(Number(value.current.index || 1)),
      ...value.current,
      material: { ...emptySegment().material, ...(value.current.material || {}) },
      equip: { ...emptySegment().equip, ...(value.current.equip || {}) },
      exit: { ...emptySegment().exit, ...(value.current.exit || {}) },
      summon: { ...emptySegment().summon, ...(value.current.summon || {}) },
      optionalEffect: {
        ...emptySegment().optionalEffect,
        ...(value.current.optionalEffect || {}),
        resolutions: Array.isArray(value.current.optionalEffect && value.current.optionalEffect.resolutions)
          ? value.current.optionalEffect.resolutions
          : [],
        effectSelections: Array.isArray(value.current.optionalEffect && value.current.optionalEffect.effectSelections)
          ? value.current.optionalEffect.effectSelections
          : [],
        effectResolutions: Array.isArray(value.current.optionalEffect && value.current.optionalEffect.effectResolutions)
          ? value.current.optionalEffect.effectResolutions
          : []
      },
      chain: {
        ...emptySegment().chain,
        ...(value.current.chain || {}),
        links: Array.isArray(value.current.chain && value.current.chain.links)
          ? value.current.chain.links
          : []
      },
      activeEffect: { ...emptySegment().activeEffect, ...(value.current.activeEffect || {}) },
      targetSelection: {
        ...emptySegment().targetSelection,
        ...(value.current.targetSelection || {}),
        allowedTargets: Array.isArray(value.current.targetSelection && value.current.targetSelection.allowedTargets)
          ? value.current.targetSelection.allowedTargets
          : []
      },
      postEffects: Array.isArray(value.current.postEffects) ? value.current.postEffects : [],
      effectQueue: Array.isArray(value.current.effectQueue) ? value.current.effectQueue : [],
      trace: Array.isArray(value.current.trace) ? value.current.trace : []
    },
    history: Array.isArray(value.history) ? value.history : [],
    seenEvents: Array.isArray(value.seenEvents) ? value.seenEvents : []
  };
}

function phaseRank(phase) {
  return {
    IDLE: 0,
    MATERIAL_READY: 1,
    OPTIONAL_EQUIP: 2,
    MATERIAL_EXIT: 3,
    SUMMON_RESULT: 4,
    OPTIONAL_EFFECT_WINDOW: 5,
    CHAIN_BUILDING: 6,
    EFFECT_TARGET_SELECTION: 7,
    POST_SUMMON: 8,
    POST_SUMMON_EFFECTS: 9
  }[phase] || 0;
}

function advancePhase(segment, phase) {
  if (phaseRank(phase) >= phaseRank(segment.phase)) segment.phase = phase;
}

function shouldStartNewSegment(segment, event) {
  if (!segment || segment.phase === 'IDLE') return false;
  if (event.kind !== 'MATERIAL_SOURCE') return false;
  // Once post-summon effects have begun, a new material summon naturally
  // represents the next pass through the flowchart after returning to decision.
  return segment.phase === 'POST_SUMMON_EFFECTS';
}

function refreshEffectQueue(segment) {
  if (!segment) return;
  const candidates = [];
  const optional = segment.optionalEffect || {};
  const poolCount = Number(optional.poolCandidateCount || optional.candidateCount || 0);
  const active = segment.activeEffect || {};
  const target = segment.targetSelection || {};
  const effectResolutions = Array.isArray(optional.effectResolutions) ? optional.effectResolutions : [];

  const addCandidate = (mode, extra = {}) => {
    const existing = candidates.find(item => item.mode === mode);
    if (existing) {
      Object.assign(existing, extra);
      return existing;
    }
    const row = { mode, status: 'POSSIBLE', ...extra };
    candidates.push(row);
    return row;
  };

  // Once a multi-effect pool is physically observed while M19 is equipped,
  // M19 search is a legitimate pool member even before the formal right-log
  // pass proves the carrier exit. This lets the pool state represent what is
  // actually on screen instead of staying empty until the later log read.
  if (poolCount > 0 && segment.equip && segment.equip.swordId === 'M19') {
    addCandidate('M19_SEARCH', {
      sourceCardId: 'M19',
      sourceCardName: '妖刀竹光'
    });
  }

  // A summon-result card gives explicit monster-effect identity. If the formal
  // log has not been read yet, a 2-candidate pool containing known M19 implies
  // the other visible candidate is the summoned monster's optional effect.
  const hasSummonedExtra = segment.summon && /^E\d+$/.test(String(segment.summon.cardId || ''));
  const hasM19Candidate = candidates.some(item => item.mode === 'M19_SEARCH');
  if (poolCount > 0 && (hasSummonedExtra || !hasM19Candidate || poolCount >= 2)) {
    addCandidate('MONSTER_OPTIONAL', {
      sourceCardId: hasSummonedExtra ? segment.summon.cardId || null : null,
      sourceCardName: hasSummonedExtra ? segment.summon.cardName || null : null
    });
  }

  // Explicit manual selection identity is stronger than pool inference.
  if (active && active.mode) {
    addCandidate(active.mode, active.mode === 'M19_SEARCH'
      ? { sourceCardId: 'M19', sourceCardName: '妖刀竹光' }
      : {});
  }
  if (target && target.effectMode) {
    addCandidate(target.effectMode, target.effectMode === 'M19_SEARCH'
      ? { sourceCardId: 'M19', sourceCardName: '妖刀竹光' }
      : {});
  }

  // Formal post-effect evidence is authoritative.
  for (const effect of segment.postEffects || []) {
    if (!effect) continue;
    if (effect.mode === 'M19_SEARCH') {
      const row = addCandidate('M19_SEARCH', { sourceCardId: 'M19', sourceCardName: '妖刀竹光' });
      row.status = effect.status === 'RESOLVED' ? 'RESOLVED' : effect.status || 'OBSERVED';
      if (effect.cardId) {
        row.resultCardId = effect.cardId;
        row.resultCardName = effect.cardName || null;
      }
    } else if (effect.mode === 'MONSTER_RECOVER' || effect.mode === 'MONSTER_HAND_GAIN') {
      const row = addCandidate('MONSTER_OPTIONAL', {
        sourceCardId: effect.sourceMonsterId || segment.summon && segment.summon.cardId || null,
        sourceCardName: segment.summon && segment.summon.cardName || null
      });
      row.status = effect.status === 'RESOLVED' ? 'RESOLVED' : effect.status || 'OBSERVED';
      if (effect.cardId) {
        row.resultCardId = effect.cardId;
        row.resultCardName = effect.cardName || null;
      }
    }
  }

  // Persisted explicit resolutions bind identity even when the right log is
  // temporarily unavailable because another effect-pool prompt is on screen.
  for (const resolution of effectResolutions) {
    if (!resolution || !resolution.mode) continue;
    const row = addCandidate(resolution.mode);
    if (resolution.status) row.status = resolution.status;
  }

  // Current nested-effect execution status overrides generic pending state.
  if (active && active.mode && active.status && active.status !== 'NONE') {
    const row = addCandidate(active.mode);
    if (active.status === 'WAITING_TARGET_SELECTION') row.status = 'TARGET_SELECTION_PENDING';
    else if (active.status === 'RESOLVING') row.status = 'RESOLVING';
    else if (active.status === 'RESOLVED') row.status = 'RESOLVED';
    else if (active.status === 'SELECTED' || active.status === 'CHAIN_SELECTED') row.status = 'SELECTED';
  }
  if (target && target.effectMode && target.status && target.status !== 'NONE') {
    const row = addCandidate(target.effectMode);
    if (target.status === 'AVAILABLE') row.status = 'TARGET_SELECTION_AVAILABLE';
    else if (target.status === 'SUBMITTED' && row.status !== 'RESOLVED') row.status = 'RESOLVING';
    else if (target.status === 'RESOLVED') row.status = 'RESOLVED';
  }

  // One cancel on a visible multi-effect pool skips every currently visible
  // candidate. Identities may be bound only later; the batch-skip flag remains
  // authoritative when they are eventually inferred.
  if (optional.lastResolutionScope === 'ALL_VISIBLE_CANDIDATES' &&
      String(optional.resolution || '').toUpperCase() === 'SKIPPED') {
    // If the skipped effect identity is known, only that still-visible effect
    // is skipped. This matters during chain construction: after M19 is chosen
    // as CL1, cancelling the remaining monster effect must NOT retroactively
    // mark M19 as skipped. A whole-pool cancel with no identity (R3) still
    // skips every visible candidate.
    const explicitSkippedModes = new Set(effectResolutions
      .filter(item => item && item.mode && String(item.status || '').toUpperCase() === 'SKIPPED')
      .map(item => String(item.mode).toUpperCase()));
    if (explicitSkippedModes.size) {
      for (const row of candidates) {
        if (explicitSkippedModes.has(String(row.mode || '').toUpperCase()) && row.status !== 'RESOLVED') {
          row.status = 'SKIPPED';
        }
      }
    } else {
      for (const row of candidates) {
        if (row.status !== 'RESOLVED') row.status = 'SKIPPED';
      }
    }
  } else {
    for (const row of candidates) {
      if (['RESOLVED', 'SKIPPED', 'TARGET_SELECTION_PENDING', 'TARGET_SELECTION_AVAILABLE', 'RESOLVING', 'SELECTED'].includes(row.status)) continue;
      row.status = optional.available ? 'PENDING' : 'POSSIBLE';
    }
  }

  segment.effectQueue = candidates;
}

function finalizeActiveEffect(segment, reason, capturedAt = new Date().toISOString()) {
  const active = segment && segment.activeEffect || {};
  if (!active.mode || active.status === 'RESOLVED') return false;

  const optional = segment.optionalEffect || {};
  const effectResolutions = Array.isArray(optional.effectResolutions) ? [...optional.effectResolutions] : [];
  const alreadyRecorded = effectResolutions.some(item =>
    item && item.mode === active.mode && item.selectionId && item.selectionId === active.selectionId && item.status === 'RESOLVED'
  );
  if (!alreadyRecorded) {
    effectResolutions.push({
      mode: active.mode,
      status: 'RESOLVED',
      reason: reason || 'OBSERVED_RESOLUTION',
      at: capturedAt,
      selectionId: active.selectionId || null
    });
  }

  const counted = active.resolutionCounted === true;
  const resolvedCandidateCount = Number(optional.resolvedCandidateCount || optional.resolvedCount || 0) + (counted ? 0 : 1);
  const poolCandidateCount = Number(optional.poolCandidateCount || 0);
  const poolComplete = poolCandidateCount > 0 && resolvedCandidateCount >= poolCandidateCount;
  segment.optionalEffect = {
    ...optional,
    status: poolComplete ? 'RESOLVED' : optional.status,
    resolution: poolComplete ? 'RESOLVED' : optional.resolution,
    available: poolComplete ? false : optional.available,
    candidateCount: poolComplete ? 0 : optional.candidateCount,
    resolvedCandidateCount,
    resolvedCount: resolvedCandidateCount,
    effectResolutions
  };
  segment.activeEffect = {
    ...active,
    status: 'RESOLVED',
    resolvedAt: capturedAt,
    resolutionCounted: true,
    resolutionReason: reason || 'OBSERVED_RESOLUTION'
  };
  if (segment.chain && Array.isArray(segment.chain.links)) {
    segment.chain = {
      ...segment.chain,
      links: segment.chain.links.map(link => link && link.mode === active.mode && link.status !== 'RESOLVED'
        ? { ...link, status: 'RESOLVED', resolvedAt: capturedAt }
        : link),
      currentResolvingMode: null
    };
    if (segment.chain.links.length && segment.chain.links.every(link => ['RESOLVED', 'SKIPPED'].includes(String(link && link.status || '')))) {
      segment.chain.status = 'RESOLVED';
      segment.chain.resolvedAt = capturedAt;
    }
  }
  if (segment.targetSelection && segment.targetSelection.effectMode === active.mode &&
      ['SUBMITTED', 'AVAILABLE'].includes(segment.targetSelection.status)) {
    segment.targetSelection = {
      ...segment.targetSelection,
      status: 'RESOLVED',
      available: false,
      resolvedAt: capturedAt
    };
  }
  return true;
}

function applyEvent(segment, event) {
  if (event.kind === 'MATERIAL_SOURCE') {
    advancePhase(segment, 'MATERIAL_READY');
    segment.material.ready = true;
    const materialKey = [event.mode || 'UNKNOWN_SOURCE', event.producerId || '', event.cardId || ''].join('|');
    const alreadyRecorded = segment.material.summoned.some(item =>
      [item.mode || 'UNKNOWN_SOURCE', item.producerId || '', item.cardId || ''].join('|') === materialKey
    );
    if (!alreadyRecorded) {
      segment.material.summoned.push({
        mode: event.mode || 'UNKNOWN_SOURCE',
        producerId: event.producerId || null,
        producerName: event.producerName || null,
        cardId: event.cardId,
        cardName: event.cardName,
        source: event.source || event.rawType || null,
        inferred: event.inferred === true
      });
    }
  } else if (event.kind === 'EQUIP') {
    advancePhase(segment, 'OPTIONAL_EQUIP');
    segment.equip = {
      mode: event.mode,
      swordId: event.swordId,
      swordName: event.swordName,
      source: event.source || null
    };
  } else if (event.kind === 'MATERIAL_EXIT') {
    advancePhase(segment, 'MATERIAL_EXIT');
    segment.exit = {
      mode: event.mode,
      materialCount: event.materialCount == null ? null : event.materialCount,
      resultCardId: event.resultCardId || null,
      resultCardName: event.resultCardName || null,
      inferred: event.inferred === true
    };
  } else if (event.kind === 'SUMMON_RESULT') {
    advancePhase(segment, 'SUMMON_RESULT');
    segment.summon = {
      cardId: event.cardId || null,
      cardName: event.cardName || null,
      mode: event.mode || null,
      inferred: event.inferred === true
    };
  } else if (event.kind === 'OPTIONAL_EFFECT') {
    // If a selected effect had been resolving and MD now shows the remaining
    // pool again, that re-prompt is strong evidence that the previously chosen
    // effect fully resolved. This is especially important for M19: selection
    // from the effect pool is NOT resolution; its Bamboo target dialog must be
    // completed first, and only then can the remaining pool reappear.
    if (segment.activeEffect && segment.activeEffect.mode &&
        segment.activeEffect.status === 'RESOLVING') {
      finalizeActiveEffect(segment, 'REMAINING_EFFECT_POOL_REPROMPT', event.observationId);
    }

    segment.phase = 'OPTIONAL_EFFECT_WINDOW';
    const previousOptional = segment.optionalEffect || {};
    const resolutions = Array.isArray(previousOptional.resolutions) ? previousOptional.resolutions : [];
    const effectSelections = Array.isArray(previousOptional.effectSelections) ? previousOptional.effectSelections : [];
    const effectResolutions = Array.isArray(previousOptional.effectResolutions) ? previousOptional.effectResolutions : [];
    const observedCount = Number(previousOptional.observedCount || 0) + 1;
    const currentCandidates = event.candidateCount == null
      ? Number(previousOptional.candidateCount || 0)
      : Math.max(0, Number(event.candidateCount || 0));
    const alreadyResolved = Number(previousOptional.resolvedCandidateCount || previousOptional.resolvedCount || 0);
    const selectedCandidateCount = Number(previousOptional.selectedCandidateCount || 0);
    const poolCandidateCount = Math.max(
      Number(previousOptional.poolCandidateCount || 0),
      currentCandidates + alreadyResolved,
      selectedCandidateCount + currentCandidates
    );
    segment.optionalEffect = {
      ...previousOptional,
      status: event.mode || 'AVAILABLE',
      mode: event.mode || 'AVAILABLE',
      available: true,
      resolution: 'PENDING',
      candidateCount: currentCandidates,
      poolCandidateCount,
      selectedCandidateCount,
      resolvedCandidateCount: alreadyResolved,
      detector: event.detector || previousOptional.detector || null,
      resolvedAt: previousOptional.resolvedAt || null,
      observedCount,
      resolvedCount: alreadyResolved,
      resolutions,
      effectSelections,
      effectResolutions,
      lastResolutionScope: null
    };
  } else if (event.kind === 'OPTIONAL_EFFECT_SELECTION') {
    const previousOptional = segment.optionalEffect || {};
    const selections = Array.isArray(previousOptional.effectSelections) ? [...previousOptional.effectSelections] : [];
    const selectionId = event.selectionId || `${event.mode || 'UNKNOWN'}@${event.observationId || Date.now()}`;
    selections.push({
      mode: event.mode || 'UNKNOWN_OPTIONAL',
      requiresTargetSelection: event.requiresTargetSelection === true,
      requiresResolutionSelection: event.requiresResolutionSelection === true,
      chainBuild: event.chainBuild === true,
      at: event.observationId || new Date().toISOString(),
      selectionId
    });
    segment.optionalEffect = {
      ...previousOptional,
      status: 'SELECTED',
      available: false,
      resolution: 'SELECTED',
      candidateCount: 0,
      selectedCandidateCount: Number(previousOptional.selectedCandidateCount || 0) + 1,
      effectSelections: selections,
      lastResolutionScope: 'ONE_SELECTED'
    };

    if (event.chainBuild === true) {
      const previousChain = segment.chain || emptySegment().chain;
      const links = Array.isArray(previousChain.links) ? [...previousChain.links] : [];
      const already = links.some(link => link && link.selectionId === selectionId);
      if (!already) {
        links.push({
          index: links.length + 1,
          mode: event.mode || 'UNKNOWN_OPTIONAL',
          status: 'CHAIN_SELECTED',
          requiresResolutionSelection: event.requiresResolutionSelection === true,
          selectedAt: event.observationId || new Date().toISOString(),
          resolvedAt: null,
          selectionId
        });
      }
      segment.chain = {
        ...previousChain,
        status: 'BUILDING',
        links,
        startedAt: previousChain.startedAt || event.observationId || new Date().toISOString(),
        resolvedAt: null
      };
      segment.activeEffect = {
        mode: event.mode || 'UNKNOWN_OPTIONAL',
        status: 'CHAIN_SELECTED',
        requiresTargetSelection: false,
        requiresResolutionSelection: event.requiresResolutionSelection === true,
        selectedAt: event.observationId || new Date().toISOString(),
        resolvedAt: null,
        resolutionCounted: false,
        selectionId
      };
      segment.targetSelection = { ...emptySegment().targetSelection };
      segment.phase = 'CHAIN_BUILDING';
    } else {
      segment.activeEffect = {
        mode: event.mode || 'UNKNOWN_OPTIONAL',
        status: event.requiresTargetSelection === true ? 'WAITING_TARGET_SELECTION' : 'RESOLVING',
        requiresTargetSelection: event.requiresTargetSelection === true,
        requiresResolutionSelection: false,
        selectedAt: event.observationId || new Date().toISOString(),
        resolvedAt: null,
        resolutionCounted: false,
        selectionId
      };
      if (event.requiresTargetSelection === true) {
        segment.phase = 'EFFECT_TARGET_SELECTION';
        segment.targetSelection = {
          ...emptySegment().targetSelection,
          status: 'PENDING',
          effectMode: event.mode || 'UNKNOWN_OPTIONAL'
        };
      } else {
        advancePhase(segment, 'POST_SUMMON_EFFECTS');
      }
    }
  } else if (event.kind === 'CHAIN_ACTIVATION_TARGET_SELECTION_READY') {
    const effectMode = String(event.effectMode || 'MONSTER_OPTIONAL').toUpperCase();
    const previousChain = segment.chain || emptySegment().chain;
    const links = Array.isArray(previousChain.links) ? previousChain.links.map(link => {
      if (!link) return link;
      const mode = String(link.mode || '').toUpperCase();
      if (mode === effectMode) {
        return {
          ...link,
          status: 'ACTIVATING_TARGET_SELECTION',
          targetSelectionTiming: 'CHAIN_ACTIVATION'
        };
      }
      return link;
    }) : [];
    segment.chain = {
      ...previousChain,
      status: 'BUILDING',
      links,
      currentResolvingMode: null
    };
    const selectedLink = links.find(link => link && String(link.mode || '').toUpperCase() === effectMode) || {};
    segment.activeEffect = {
      mode: effectMode,
      status: 'WAITING_TARGET_SELECTION',
      requiresTargetSelection: true,
      requiresResolutionSelection: false,
      targetSelectionTiming: 'CHAIN_ACTIVATION',
      selectedAt: selectedLink.selectedAt || null,
      resolvedAt: null,
      resolutionCounted: false,
      selectionId: selectedLink.selectionId || null
    };
    segment.targetSelection = {
      ...emptySegment().targetSelection,
      status: 'PENDING',
      effectMode,
      selectionTiming: 'CHAIN_ACTIVATION'
    };
    segment.phase = 'EFFECT_TARGET_SELECTION';
  } else if (event.kind === 'CHAIN_ACTIVATION_TARGET_SELECTION_SUBMITTED') {
    const effectMode = String(event.effectMode || '').toUpperCase();
    segment.targetSelection = {
      ...segment.targetSelection,
      status: 'SUBMITTED',
      available: false,
      effectMode,
      selectionTiming: 'CHAIN_ACTIVATION',
      selectedCardId: event.cardId || segment.targetSelection && segment.targetSelection.selectedCardId || null,
      selectedCardName: event.cardName || segment.targetSelection && segment.targetSelection.selectedCardName || null,
      submittedAt: event.observationId || new Date().toISOString()
    };
    if (segment.chain && Array.isArray(segment.chain.links)) {
      segment.chain = {
        ...segment.chain,
        status: 'BUILDING',
        currentResolvingMode: null,
        links: segment.chain.links.map(link => {
          if (!link || String(link.mode || '').toUpperCase() !== effectMode) return link;
          return {
            ...link,
            status: 'CHAIN_SELECTED',
            targetSelectionTiming: 'CHAIN_ACTIVATION',
            targetSelectionSubmitted: true,
            targetCardId: event.cardId || link.targetCardId || null,
            targetCardName: event.cardName || link.targetCardName || null
          };
        })
      };
    }
    if (segment.activeEffect && String(segment.activeEffect.mode || '').toUpperCase() === effectMode) {
      segment.activeEffect = {
        ...segment.activeEffect,
        status: 'CHAIN_SELECTED',
        targetSelectionTiming: 'CHAIN_ACTIVATION'
      };
    }
    segment.phase = 'CHAIN_BUILDING';
  } else if (event.kind === 'CHAIN_RESOLUTION_SELECTION_READY') {
    const previousOptional = segment.optionalEffect || {};
    const effectResolutions = Array.isArray(previousOptional.effectResolutions) ? [...previousOptional.effectResolutions] : [];
    let resolvedCandidateCount = Number(previousOptional.resolvedCandidateCount || previousOptional.resolvedCount || 0);
    const resolvedBefore = Array.isArray(event.resolvedBefore) ? event.resolvedBefore.map(mode => String(mode || '').toUpperCase()).filter(Boolean) : [];
    const alreadyResolvedModes = new Set(effectResolutions
      .filter(item => item && item.mode && String(item.status || '').toUpperCase() === 'RESOLVED')
      .map(item => String(item.mode).toUpperCase()));
    for (const mode of resolvedBefore) {
      if (!alreadyResolvedModes.has(mode)) {
        effectResolutions.push({
          mode,
          status: 'RESOLVED',
          reason: 'CHAIN_REVERSE_RESOLUTION_REACHED_NEXT_LINK',
          at: event.observationId || new Date().toISOString(),
          selectionId: null
        });
        alreadyResolvedModes.add(mode);
        resolvedCandidateCount += 1;
      }
    }
    segment.optionalEffect = {
      ...previousOptional,
      status: 'CHAIN_RESOLVING',
      available: false,
      resolution: 'CHAIN_RESOLVING',
      candidateCount: 0,
      resolvedCandidateCount,
      resolvedCount: resolvedCandidateCount,
      effectResolutions,
      lastResolutionScope: null
    };

    const effectMode = String(event.effectMode || 'M19_SEARCH').toUpperCase();
    const previousChain = segment.chain || emptySegment().chain;
    const links = Array.isArray(previousChain.links) ? previousChain.links.map(link => {
      if (!link) return link;
      const mode = String(link.mode || '').toUpperCase();
      if (resolvedBefore.includes(mode)) return { ...link, status: 'RESOLVED', resolvedAt: event.observationId || new Date().toISOString() };
      if (mode === effectMode) return { ...link, status: 'RESOLVING_SELECTION' };
      return link;
    }) : [];
    segment.chain = {
      ...previousChain,
      status: 'RESOLVING',
      links,
      currentResolvingMode: effectMode
    };
    segment.activeEffect = {
      mode: effectMode,
      status: 'WAITING_TARGET_SELECTION',
      requiresTargetSelection: true,
      requiresResolutionSelection: true,
      selectedAt: (links.find(link => link && String(link.mode || '').toUpperCase() === effectMode) || {}).selectedAt || null,
      resolvedAt: null,
      resolutionCounted: false,
      selectionId: (links.find(link => link && String(link.mode || '').toUpperCase() === effectMode) || {}).selectionId || null
    };
    segment.targetSelection = {
      ...emptySegment().targetSelection,
      status: 'PENDING',
      effectMode
    };
    segment.phase = 'EFFECT_TARGET_SELECTION';
  } else if (event.kind === 'EFFECT_TARGET_SELECTION') {
    segment.phase = 'EFFECT_TARGET_SELECTION';
    const allowedTargets = Array.isArray(event.allowedTargets) ? event.allowedTargets : [];
    segment.targetSelection = {
      ...segment.targetSelection,
      status: event.mode || 'AVAILABLE',
      available: true,
      effectMode: event.effectMode || segment.activeEffect && segment.activeEffect.mode || null,
      selectionTiming: event.selectionTiming || segment.targetSelection && segment.targetSelection.selectionTiming || null,
      candidateCount: event.candidateCount == null ? null : Number(event.candidateCount),
      allowedTargets,
      selectedCardId: segment.targetSelection && segment.targetSelection.selectedCardId || null,
      selectedCardName: segment.targetSelection && segment.targetSelection.selectedCardName || null,
      detector: event.detector || null,
      observedAt: event.observationId || new Date().toISOString(),
      submittedAt: null,
      resolvedAt: null
    };
    if (segment.activeEffect && segment.activeEffect.mode === segment.targetSelection.effectMode) {
      segment.activeEffect = { ...segment.activeEffect, status: 'WAITING_TARGET_SELECTION' };
    }
  } else if (event.kind === 'EFFECT_TARGET_SELECTION_SUBMITTED') {
    segment.targetSelection = {
      ...segment.targetSelection,
      status: 'SUBMITTED',
      available: false,
      effectMode: event.effectMode || segment.targetSelection && segment.targetSelection.effectMode || null,
      selectedCardId: event.cardId || segment.targetSelection && segment.targetSelection.selectedCardId || null,
      selectedCardName: event.cardName || segment.targetSelection && segment.targetSelection.selectedCardName || null,
      submittedAt: event.observationId || new Date().toISOString()
    };
    if (segment.activeEffect && segment.activeEffect.mode === segment.targetSelection.effectMode) {
      segment.activeEffect = { ...segment.activeEffect, status: 'RESOLVING' };
    }
    advancePhase(segment, 'POST_SUMMON_EFFECTS');
  } else if (event.kind === 'OPTIONAL_EFFECT_RESOLUTION') {
    const resolution = String(event.mode || 'UNKNOWN').toUpperCase();
    const scope = String(event.scope || 'ONE_SELECTED').toUpperCase();
    const previousOptional = segment.optionalEffect || {};
    const resolutions = Array.isArray(previousOptional.resolutions) ? [...previousOptional.resolutions] : [];
    resolutions.push(resolution);
    const effectResolutions = Array.isArray(previousOptional.effectResolutions) ? [...previousOptional.effectResolutions] : [];
    const resolvedEffectMode = String(event.effectMode || '').trim().toUpperCase();
    if (resolvedEffectMode) {
      const duplicate = effectResolutions.some(item => item && item.mode === resolvedEffectMode && item.status === resolution && item.at === event.observationId);
      if (!duplicate) {
        effectResolutions.push({
          mode: resolvedEffectMode,
          status: resolution,
          reason: 'KNOWN_MANUAL_OPTIONAL_RESOLUTION',
          at: event.observationId || new Date().toISOString(),
          selectionId: null
        });
      }
    }
    const currentCandidates = Math.max(1, Number(previousOptional.candidateCount || 1));
    const previousResolved = Number(previousOptional.resolvedCandidateCount || previousOptional.resolvedCount || 0);
    const resolvedIncrement = scope === 'ALL_VISIBLE_CANDIDATES' ? currentCandidates : 1;
    const resolvedCandidateCount = previousResolved + resolvedIncrement;
    const poolCandidateCount = Math.max(
      Number(previousOptional.poolCandidateCount || 0),
      previousResolved + currentCandidates,
      resolvedCandidateCount
    );

    segment.optionalEffect = {
      ...previousOptional,
      status: resolution,
      available: false,
      resolution,
      candidateCount: 0,
      poolCandidateCount,
      selectedCandidateCount: Number(previousOptional.selectedCandidateCount || 0),
      resolvedCandidateCount,
      resolvedAt: event.resolvedAt || event.observationId || new Date().toISOString(),
      observedCount: Number(previousOptional.observedCount || 0),
      resolvedCount: resolvedCandidateCount,
      resolutions,
      effectResolutions,
      lastResolutionScope: scope
    };
    if (resolvedEffectMode && segment.chain && Array.isArray(segment.chain.links)) {
      segment.chain = {
        ...segment.chain,
        links: segment.chain.links.map(link => link && String(link.mode || '').toUpperCase() === resolvedEffectMode
          ? { ...link, status: resolution === 'SKIPPED' ? 'SKIPPED' : link.status, resolvedAt: event.observationId || new Date().toISOString() }
          : link)
      };
    }

    if (resolution === 'ACTIVATED') advancePhase(segment, 'POST_SUMMON_EFFECTS');
    else advancePhase(segment, 'POST_SUMMON');
  } else if (event.kind === 'POST_EFFECT') {
    advancePhase(segment, 'POST_SUMMON_EFFECTS');
    const key = [event.mode, event.status, event.sourceMonsterId || '', event.cardId || ''].join('|');
    if (!segment.postEffects.some(item => item.key === key)) {
      segment.postEffects.push({
        key,
        mode: event.mode,
        status: event.status,
        sourceMonsterId: event.sourceMonsterId || null,
        cardId: event.cardId || null,
        cardName: event.cardName || null
      });
    }

    if (event.mode === 'M19_SEARCH') {
      if (segment.targetSelection && segment.targetSelection.effectMode === 'M19_SEARCH') {
        segment.targetSelection = {
          ...segment.targetSelection,
          status: 'RESOLVED',
          available: false,
          selectedCardId: event.cardId || segment.targetSelection.selectedCardId || null,
          selectedCardName: event.cardName || segment.targetSelection.selectedCardName || null,
          resolvedAt: event.observationId || new Date().toISOString()
        };
      }
      if (segment.activeEffect && segment.activeEffect.mode === 'M19_SEARCH') {
        finalizeActiveEffect(segment, 'RIGHT_LOG_M19_SEARCH_RESULT', event.observationId);
      }
    } else if (event.mode === 'MONSTER_RECOVER' || event.mode === 'MONSTER_HAND_GAIN') {
      if (segment.activeEffect && segment.activeEffect.mode === 'MONSTER_OPTIONAL') {
        finalizeActiveEffect(segment, 'RIGHT_LOG_MONSTER_EFFECT_RESULT', event.observationId);
      }
    }
  }

  refreshEffectQueue(segment);

  segment.trace.push({
    kind: event.kind,
    activationKey: event.activationKey,
    activationName: event.activationName,
    mode: event.mode || null,
    cardId: event.cardId || event.resultCardId || null,
    cardName: event.cardName || event.resultCardName || null,
    inferred: event.inferred === true
  });
  if (segment.trace.length > MAX_TRACE) segment.trace = segment.trace.slice(-MAX_TRACE);
}

function eventConsumesM19SearchActivation(event) {
  if (!event) return false;
  const mode = String(event.mode || event.effectMode || '').toUpperCase();
  if (mode !== 'M19_SEARCH') return false;
  // Count the activation once at its explicit optional-effect selection.
  // Resolution and post-effect evidence belong to that same activation.
  return event.kind === 'OPTIONAL_EFFECT_SELECTION';
}

function markM19SearchUsage(next, event, capturedAt) {
  if (!eventConsumesM19SearchActivation(event)) return;
  const usage = next.turnUsage || initialState().turnUsage;
  next.turnUsage = {
    ...usage,
    m19SearchUsed: true,
    m19SearchActivationCount: Number(usage.m19SearchActivationCount || 0) + 1,
    m19SearchUsedAt: event.observationId || capturedAt || new Date().toISOString(),
    source: event.kind || 'UNKNOWN'
  };
}

function updateCompositeRouteState(previous, events, capturedAt = new Date().toISOString()) {
  const next = normalizeState(previous);
  const seen = new Set(next.seenEvents);
  let applied = 0;

  for (const event of events || []) {
    const fp = eventFingerprint(event);
    if (seen.has(fp)) continue;
    seen.add(fp);

    if (shouldStartNewSegment(next.current, event)) {
      next.history.push(next.current);
      if (next.history.length > MAX_HISTORY) next.history = next.history.slice(-MAX_HISTORY);
      next.current = emptySegment(Number(next.current.index || 1) + 1);
    }
    applyEvent(next.current, event);
    markM19SearchUsage(next, event, capturedAt);
    applied++;
  }

  next.seenEvents = [...seen].slice(-400);
  next.capturedAt = capturedAt;
  if (applied > 0) next.revision = Number(next.revision || 0) + 1;
  return { state: next, applied };
}


function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value, { trailingNewline: true });
}

function readDecisionState(rootDir) {
  const filePath = path.join(rootDir, 'decision-state.json');
  const value = readJsonIfExists(filePath) || {};
  return { filePath, value };
}

function summarizeCompositeRouteState(state) {
  const current = state && state.current || emptySegment();
  const effects = (current.postEffects || []).map(item => {
    const suffix = item.cardName || item.cardId;
    return suffix ? `${item.mode}:${suffix}` : `${item.mode}:${item.status}`;
  });
  const effectQueue = (current.effectQueue || []).map(item => ({
    mode: item.mode,
    status: item.status,
    sourceCardId: item.sourceCardId || null,
    sourceCardName: item.sourceCardName || null
  }));
  const unresolvedStatuses = new Set([
    'PENDING', 'POSSIBLE', 'SELECTED', 'TARGET_SELECTION_PENDING',
    'TARGET_SELECTION_AVAILABLE', 'RESOLVING'
  ]);
  const pendingEffects = effectQueue.filter(item => unresolvedStatuses.has(item.status));
  const resolvedEffects = effectQueue.filter(item => !unresolvedStatuses.has(item.status));
  return {
    phase: current.phase,
    material: current.material && current.material.ready
      ? (current.material.summoned || []).map(item => item.cardName || item.cardId).filter(Boolean)
      : [],
    materialSources: current.material && current.material.ready
      ? (current.material.summoned || []).map(item => item.mode || item.source || 'UNKNOWN_SOURCE').filter(Boolean)
      : [],
    equip: current.equip && current.equip.mode || 'NONE',
    exit: current.exit && current.exit.mode || 'NONE',
    summon: current.summon && (current.summon.cardName || current.summon.cardId) || 'NONE',
    optionalEffect: current.optionalEffect && current.optionalEffect.status || 'NONE',
    optionalCandidateCount: current.optionalEffect && current.optionalEffect.candidateCount == null
      ? null
      : Number(current.optionalEffect.candidateCount),
    optionalPoolCandidateCount: Number(current.optionalEffect && current.optionalEffect.poolCandidateCount || 0),
    optionalSelectedCandidateCount: Number(current.optionalEffect && current.optionalEffect.selectedCandidateCount || 0),
    optionalResolvedCandidateCount: Number(current.optionalEffect && current.optionalEffect.resolvedCandidateCount || current.optionalEffect && current.optionalEffect.resolvedCount || 0),
    optionalPromptObservedCount: Number(current.optionalEffect && current.optionalEffect.observedCount || 0),
    optionalPromptResolvedCount: Number(current.optionalEffect && current.optionalEffect.resolvedCount || 0),
    chain: current.chain && Array.isArray(current.chain.links) && current.chain.links.length ? {
      status: current.chain.status || 'UNKNOWN',
      currentResolvingMode: current.chain.currentResolvingMode || null,
      links: current.chain.links.map(link => ({
        index: Number(link && link.index || 0),
        mode: link && link.mode || 'UNKNOWN',
        status: link && link.status || 'UNKNOWN'
      }))
    } : null,
    activeEffect: current.activeEffect && current.activeEffect.mode ? {
      mode: current.activeEffect.mode,
      status: current.activeEffect.status || 'UNKNOWN',
      requiresTargetSelection: current.activeEffect.requiresTargetSelection === true,
      requiresResolutionSelection: current.activeEffect.requiresResolutionSelection === true
    } : null,
    targetSelection: current.targetSelection && current.targetSelection.status !== 'NONE' ? {
      status: current.targetSelection.status,
      effectMode: current.targetSelection.effectMode || null,
      selectionTiming: current.targetSelection.selectionTiming || null,
      candidateCount: current.targetSelection.candidateCount == null ? null : Number(current.targetSelection.candidateCount),
      allowedTargets: Array.isArray(current.targetSelection.allowedTargets) ? current.targetSelection.allowedTargets : [],
      selectedCardId: current.targetSelection.selectedCardId || null,
      selectedCardName: current.targetSelection.selectedCardName || null
    } : null,
    effectQueue,
    pendingEffects,
    resolvedEffects,
    postEffects: effects,
    turnUsage: {
      m19SearchUsed: Boolean(state && state.turnUsage && state.turnUsage.m19SearchUsed),
      m19SearchActivationCount: Number(state && state.turnUsage && state.turnUsage.m19SearchActivationCount || 0),
      m19SearchUsedAt: state && state.turnUsage && state.turnUsage.m19SearchUsedAt || null,
      source: state && state.turnUsage && state.turnUsage.source || null
    }
  };
}

// PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_COMPOSITE
const { applyLogOnlyToMainDeckLedger } = require('./main-deck-ledger');

function observeCompositeRoute(log, options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  // PATCH_V5_SHARED_MAIN_DECK_LEDGER_V2_COMPOSITE: only proven direct Deck->field events are applied here.
  applyLogOnlyToMainDeckLedger(log);
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const newBlocks = Array.isArray(log && (log.newOperationBlocks || log.newActivationBlocks))
    ? (log.newOperationBlocks || log.newActivationBlocks)
    : [];
  const extendedBlocks = Array.isArray(log && log.extendedOperationBlocks)
    ? log.extendedOperationBlocks
    : [];

  // Compatibility/recovery for a run made immediately before this feature
  // existed: V1 may already have advanced its tail checkpoint to the grown
  // M22 block while the flow sidecar is still at HORNET_TOKEN / no exit. In
  // that one staged shape, recover the CURRENT matching M22 block once from
  // the visible operation list. This lets a live manual test continue instead
  // of forcing the duel to be replayed.
  const recoveryBlocks = [];
  const current = previous.current || emptySegment();
  const hasHornetMaterial = (current.material && current.material.summoned || []).some(item =>
    item && item.mode === 'HORNET_TOKEN'
  );
  if (hasHornetMaterial && !(current.exit && current.exit.mode)) {
    const visible = Array.isArray(log && (log.operationBlocks || log.activationBlocks))
      ? (log.operationBlocks || log.activationBlocks)
      : [];
    for (let index = visible.length - 1; index >= 0; index--) {
      const block = visible[index];
      if (!block || block.activationKey !== 'M22') continue;
      const hasLink = (block.details || []).some(detail => detailRawType(detail) === 'LINK_SUMMON');
      if (hasLink) recoveryBlocks.push(block);
      break;
    }
  }

  const semanticBlocks = [...newBlocks, ...extendedBlocks, ...recoveryBlocks];
  const uniqueBlocks = [];
  const seenBlockSignatures = new Set();
  for (const block of semanticBlocks) {
    const fp = `${String(block && block.activationKey || '')}|${String(block && block.signature || '')}`;
    if (seenBlockSignatures.has(fp)) continue;
    seenBlockSignatures.add(fp);
    uniqueBlocks.push(block);
  }

  const observationId = log && log.capturedAt || new Date().toISOString();
  const events = extractCompositeRouteEvents(uniqueBlocks, options).map(event => ({
    ...event,
    observationId
  }));
  const updated = updateCompositeRouteState(previous, events, observationId);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_SIDECAR',
    appliedEvents: updated.applied,
    events,
    summary,
    state: updated.state,
    sourceLogCapturedAt: log && log.capturedAt || null,
    semanticInput: {
      newOperationBlocks: newBlocks.length,
      extendedOperationBlocks: extendedBlocks.length,
      recoveryBlocks: recoveryBlocks.length
    }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function selectCompositeOptionalEffect(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const current = previous.current || emptySegment();
  const optional = current.optionalEffect || {};
  const effectMode = String(options.effectMode || '').trim().toUpperCase();
  if (!effectMode) throw new Error('OPTIONAL_EFFECT_SELECTION_MODE_REQUIRED');
  if (optional.available !== true || Number(optional.candidateCount || 0) < 1) {
    throw new Error(`OPTIONAL_EFFECT_NOT_AVAILABLE_FOR_SELECTION:${optional.status || 'NONE'};candidateCount=${Number(optional.candidateCount || 0)}`);
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'OPTIONAL_EFFECT_SELECTION',
    mode: effectMode,
    requiresTargetSelection: options.requiresTargetSelection === true,
    requiresResolutionSelection: options.requiresResolutionSelection === true,
    chainBuild: options.chainBuild === true,
    observationId: capturedAt,
    selectionId: `${effectMode}@${capturedAt}`,
    activationKey: current.summon && current.summon.cardId || null,
    activationName: current.summon && current.summon.cardName || '可选效果池',
    source: options.source || 'KNOWN_MANUAL_EFFECT_SELECTION'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_OPTIONAL_EFFECT_SELECTION',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: {
      effectMode,
      requiresTargetSelection: event.requiresTargetSelection,
      requiresResolutionSelection: event.requiresResolutionSelection,
      chainBuild: event.chainBuild
    }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function enterCompositeResolutionSelection(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const effectMode = String(options.effectMode || 'M19_SEARCH').trim().toUpperCase();
  const resolvedBefore = Array.isArray(options.resolvedBefore)
    ? options.resolvedBefore.map(mode => String(mode || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const current = previous.current || emptySegment();
  const selectedModes = new Set((current.optionalEffect && current.optionalEffect.effectSelections || [])
    .map(item => String(item && item.mode || '').toUpperCase()).filter(Boolean));
  if (!selectedModes.has(effectMode)) {
    throw new Error(`CHAIN_EFFECT_NOT_SELECTED:${effectMode}`);
  }
  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'CHAIN_RESOLUTION_SELECTION_READY',
    mode: 'RESOLUTION_SELECTION_READY',
    effectMode,
    resolvedBefore,
    observationId: capturedAt,
    activationKey: effectMode === 'M19_SEARCH' ? 'M19' : null,
    activationName: effectMode === 'M19_SEARCH' ? '妖刀竹光结算检索' : effectMode,
    source: options.source || 'KNOWN_CHAIN_RESOLUTION_PROGRESS'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_CHAIN_RESOLUTION_SELECTION_READY',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: { effectMode, resolvedBefore }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function enterCompositeChainActivationTargetSelection(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const effectMode = String(options.effectMode || 'MONSTER_OPTIONAL').trim().toUpperCase();
  const current = previous.current || emptySegment();
  const selectedLink = (current.chain && current.chain.links || []).find(link =>
    link && String(link.mode || '').toUpperCase() === effectMode
  );
  if (!selectedLink) throw new Error(`CHAIN_EFFECT_NOT_SELECTED:${effectMode}`);
  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'CHAIN_ACTIVATION_TARGET_SELECTION_READY',
    mode: 'ACTIVATION_TARGET_SELECTION_READY',
    effectMode,
    observationId: capturedAt,
    activationKey: current.summon && current.summon.cardId || null,
    activationName: current.summon && current.summon.cardName || effectMode,
    source: options.source || 'KNOWN_CHAIN_ACTIVATION_TARGET_SELECTION'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_CHAIN_ACTIVATION_TARGET_SELECTION_READY',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: { effectMode, selectionTiming: 'CHAIN_ACTIVATION' }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function submitCompositeChainActivationTargetSelection(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const current = previous.current || emptySegment();
  const target = current.targetSelection || {};
  const effectMode = String(options.effectMode || target.effectMode || '').trim().toUpperCase();
  if (!effectMode) throw new Error('CHAIN_ACTIVATION_TARGET_EFFECT_MODE_REQUIRED');
  const pendingEffectMode = String(target.effectMode || '').trim().toUpperCase();
  if (pendingEffectMode !== effectMode) {
    throw new Error(`CHAIN_ACTIVATION_TARGET_EFFECT_MISMATCH:${pendingEffectMode || 'NONE'}/${effectMode}`);
  }
  if (String(target.selectionTiming || '').toUpperCase() !== 'CHAIN_ACTIVATION') {
    throw new Error(`CHAIN_ACTIVATION_TARGET_WRONG_TIMING:${target.selectionTiming || 'NONE'}`);
  }
  if (!['AVAILABLE', 'PENDING'].includes(String(target.status || '').toUpperCase())) {
    throw new Error(`CHAIN_ACTIVATION_TARGET_NOT_PENDING:${target.status || 'NONE'}`);
  }
  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'CHAIN_ACTIVATION_TARGET_SELECTION_SUBMITTED',
    mode: 'SUBMITTED',
    effectMode,
    cardId: options.cardId || null,
    cardName: options.cardName || null,
    observationId: capturedAt,
    activationKey: current.summon && current.summon.cardId || null,
    activationName: current.summon && current.summon.cardName || `${effectMode}发动时对象选择`,
    source: options.source || 'KNOWN_MANUAL_CHAIN_ACTIVATION_TARGET_SUBMIT'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_CHAIN_ACTIVATION_TARGET_SELECTION_SUBMITTED',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: { effectMode, selectionTiming: 'CHAIN_ACTIVATION', selectedCardId: event.cardId }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function submitCompositeTargetSelection(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const current = previous.current || emptySegment();
  const target = current.targetSelection || {};
  const effectMode = String(options.effectMode || target.effectMode || '').trim().toUpperCase();
  if (!effectMode) throw new Error('TARGET_SELECTION_EFFECT_MODE_REQUIRED');
  const pendingEffectMode = String(target.effectMode || '').trim().toUpperCase();
  if (pendingEffectMode && pendingEffectMode !== effectMode) {
    throw new Error(`TARGET_SELECTION_EFFECT_MISMATCH:${pendingEffectMode}/${effectMode}`);
  }
  if (!['AVAILABLE', 'PENDING'].includes(String(target.status || '').toUpperCase())) {
    throw new Error(`TARGET_SELECTION_NOT_PENDING:${target.status || 'NONE'}`);
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'EFFECT_TARGET_SELECTION_SUBMITTED',
    mode: 'SUBMITTED',
    effectMode,
    cardId: options.cardId || null,
    cardName: options.cardName || null,
    observationId: capturedAt,
    activationKey: effectMode === 'M19_SEARCH' ? 'M19' : null,
    activationName: effectMode === 'M19_SEARCH'
      ? '妖刀竹光检索对象选择'
      : effectMode === 'MONSTER_OPTIONAL'
        ? '零罗/新怪兽效果对象选择'
        : `${effectMode}对象选择`,
    source: options.source || 'KNOWN_MANUAL_TARGET_SUBMIT'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_TARGET_SELECTION_SUBMITTED',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: { effectMode, selectedCardId: event.cardId }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}


function reconcileCompositeRouteFromHandResult(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const handResultPath = options.handResultPath || path.join(rootDir, 'debug', 'hand-change-live', 'latest_incremental_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const handResult = readJsonIfExists(handResultPath);
  if (!handResult || handResult.status !== 'PASS') return null;

  const current = previous.current || emptySegment();
  const target = current.targetSelection || {};
  const active = current.activeEffect || {};
  const isPendingM19 = String(target.effectMode || '').toUpperCase() === 'M19_SEARCH' &&
    ['SUBMITTED', 'AVAILABLE', 'PENDING'].includes(String(target.status || '').toUpperCase()) &&
    String(active.mode || '').toUpperCase() === 'M19_SEARCH' &&
    String(active.status || '').toUpperCase() !== 'RESOLVED';
  if (!isPendingM19) return null;

  const inserted = Array.isArray(handResult.insertedCards) ? handResult.insertedCards : [];
  const bambooRows = inserted.filter(item => {
    const id = String(item && item.card && item.card.id || '');
    return isLegalBambooSearchTarget(id);
  });
  if (bambooRows.length !== 1) return null;

  const bamboo = bambooRows[0].card;
  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'POST_EFFECT',
    mode: 'M19_SEARCH',
    status: 'RESOLVED',
    activationKey: 'M19',
    activationName: '妖刀竹光',
    cardId: bamboo.id,
    cardName: bamboo.name,
    signature: `HAND_RECONCILED_M19_SEARCH|${bamboo.id}`,
    observationId: capturedAt,
    source: 'PHYSICAL_HAND_RECONCILIATION'
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_HAND_RECONCILED_EFFECT_RESULT',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: {
      handResultPath,
      insertedCards: inserted.map(item => ({
        slot: item.slot,
        id: item.card && item.card.id || null,
        name: item.card && item.card.name || null
      })),
      resolvedEffect: 'M19_SEARCH',
      resolvedCardId: bamboo.id
    }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function resolveCompositeOptionalEffect(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const resolution = String(options.resolution || '').trim().toUpperCase();
  const scope = String(options.scope || 'ONE_SELECTED').trim().toUpperCase();
  if (!['SKIPPED', 'ACTIVATED'].includes(resolution)) {
    throw new Error(`UNSUPPORTED_OPTIONAL_EFFECT_RESOLUTION:${resolution || 'EMPTY'}`);
  }
  if (!['ONE_SELECTED', 'ALL_VISIBLE_CANDIDATES'].includes(scope)) {
    throw new Error(`UNSUPPORTED_OPTIONAL_EFFECT_SCOPE:${scope || 'EMPTY'}`);
  }

  const current = previous.current || emptySegment();
  const optional = current.optionalEffect || {};
  const candidateCount = Number(optional.candidateCount || 0);
  if (optional.available !== true || candidateCount < 1) {
    throw new Error(`OPTIONAL_EFFECT_NOT_AVAILABLE:${optional.status || 'NONE'};candidateCount=${candidateCount}`);
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    kind: 'OPTIONAL_EFFECT_RESOLUTION',
    mode: resolution,
    observationId: capturedAt,
    resolvedAt: capturedAt,
    activationKey: current.summon && current.summon.cardId || null,
    activationName: current.summon && current.summon.cardName || '召唤后可选效果',
    source: options.source || 'KNOWN_ACTION_RESOLUTION',
    scope,
    effectMode: options.effectMode ? String(options.effectMode).trim().toUpperCase() : null
  };
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_OPTIONAL_EFFECT_RESOLUTION',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: {
      resolutionSource: event.source,
      resolutionScope: scope,
      effectMode: event.effectMode || null
    }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function recordCompositeKnownEvent(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const debugDir = options.debugDir || path.join(rootDir, 'debug', 'composite-route-live');
  const statePath = path.join(debugDir, 'session_state.json');
  const resultPath = path.join(debugDir, 'latest_result.json');
  const previous = normalizeState(readJsonIfExists(statePath));
  const capturedAt = options.capturedAt || new Date().toISOString();
  const event = {
    ...(options.event || {}),
    observationId: capturedAt,
    source: options.source || options.event && options.event.source || 'KNOWN_MANUAL_FLOW_STATE'
  };
  if (!event.kind) throw new Error('KNOWN_COMPOSITE_EVENT_KIND_REQUIRED');
  const updated = updateCompositeRouteState(previous, [event], capturedAt);
  const summary = summarizeCompositeRouteState(updated.state);
  const result = {
    status: 'PASS',
    mode: 'FLOW_STATE_KNOWN_MANUAL_EVENT',
    appliedEvents: updated.applied,
    events: [event],
    summary,
    state: updated.state,
    sourceLogCapturedAt: null,
    semanticInput: { knownManualEvent: event.kind, mode: event.mode || null }
  };
  writeJson(statePath, updated.state);
  writeJson(resultPath, result);
  return { ...result, statePath, resultPath };
}

function seedCompositeExistingFieldMonster(options = {}) {
  return recordCompositeKnownEvent({
    ...options,
    event: {
      kind: 'MATERIAL_SOURCE',
      mode: 'PREEXISTING_LINK',
      producerId: null,
      producerName: null,
      cardId: options.cardId || 'PREEXISTING_LINK',
      cardName: options.cardName || '当前已有Link怪兽',
      source: 'KNOWN_PREEXISTING_FIELD_LINK',
      inferred: false
    },
    source: options.source || 'MANUAL_ROUTE_ENTRY_PREEXISTING_LINK'
  });
}

function recordCompositeKnownEquip(options = {}) {
  const mode = String(options.mode || '').trim().toUpperCase();
  if (!['M19_FROM_HAND', 'M20_FROM_HAND', 'M20_FIELD_TO_M19'].includes(mode)) {
    throw new Error(`KNOWN_EQUIP_MODE_UNSUPPORTED:${mode || 'NONE'}`);
  }
  const swordId = mode === 'M20_FROM_HAND' ? 'M20' : 'M19';
  const swordName = swordId === 'M20' ? '真刀竹光' : '妖刀竹光';
  return recordCompositeKnownEvent({
    ...options,
    event: {
      kind: 'EQUIP',
      mode,
      swordId,
      swordName,
      source: options.equipSource || 'KNOWN_MANUAL_EQUIP'
    },
    source: options.source || 'MANUAL_ROUTE_KNOWN_EQUIP'
  });
}

module.exports = {
  extractCompositeRouteEvents,
  updateCompositeRouteState,
  summarizeCompositeRouteState,
  observeCompositeRoute,
  resolveCompositeOptionalEffect,
  selectCompositeOptionalEffect,
  enterCompositeResolutionSelection,
  enterCompositeChainActivationTargetSelection,
  submitCompositeChainActivationTargetSelection,
  submitCompositeTargetSelection,
  reconcileCompositeRouteFromHandResult,
  seedCompositeExistingFieldMonster,
  recordCompositeKnownEquip,
  recordCompositeKnownEvent,
  emptySegment,
  initialState
};
