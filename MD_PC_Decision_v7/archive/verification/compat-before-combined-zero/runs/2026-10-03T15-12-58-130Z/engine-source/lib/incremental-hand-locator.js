'use strict';
const { isTradeInCostId } = require('./trade-in-policy');
const {
  EXODIA_UNKNOWN_ID,
  isExodiaComponentId,
  isExactExodiaComponentId,
  normalizeExodiaComponentCard,
  buildExodiaComponentSet
} = require('./exodia-policy');
const { bambooSearchTargetIds, isLegalBambooSearchTarget } = require('./bamboo-search-policy');


function deckRank(library) {
  const rank = new Map((library.cards || []).map((card, index) => [card.id, index]));
  const componentRanks = [...rank].filter(([id]) => isExactExodiaComponentId(id)).map(([, value]) => value);
  if (componentRanks.length) {
    // Components occupy one ordering band. Their individual identity is not
    // known or needed; EXODIA_UNKNOWN must never fall behind ordinary spells.
    const band = Math.min(...componentRanks);
    for (const [id] of rank) if (isExactExodiaComponentId(id)) rank.set(id, band);
    rank.set(EXODIA_UNKNOWN_ID, band);
  }
  return rank;
}

function activationConsumesKnownHand(beforeCards, activationBlock) {
  if (!activationBlock || !activationBlock.activationKey) return false;
  const key = activationBlock.activationKey;
  if (!(beforeCards || []).some(card => card.id === key)) return false;
  const relationship = activationBlock.relationship && activationBlock.relationship.type;
  if (relationship === 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD' ||
      relationship === 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD' ||
      relationship === 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING') return false;
  // Yoto Bamboo Sword's later graveyard effect adds a Bamboo Sword. Even if
  // another copy is still in hand, this block must not consume that copy.
  const isYotoGraveRecovery = key === 'M19' && (activationBlock.details || []).some(detail =>
    detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  ) && !(activationBlock.details || []).some(detail => detail.role === 'TARGET');
  return !isYotoGraveRecovery;
}


function tradeInSemanticProfile(beforeCards, activationBlock) {
  if (!activationBlock || activationBlock.activationKey !== 'M12') return null;
  const cards = Array.isArray(beforeCards) ? beforeCards : [];
  const consumesSpell = activationConsumesKnownHand(cards, activationBlock);
  const levelEightInHand = cards.filter(card => card && isTradeInCostId(card.id));
  if (!consumesSpell || !levelEightInHand.length) return null;

  const details = Array.isArray(activationBlock.details) ? activationBlock.details : [];
  const levelEightRows = details.filter(detail => {
    const id = String(detail && detail.card && detail.card.id || '');
    return isTradeInCostId(id);
  });
  const gainRows = details.filter(detail =>
    detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  );
  const hasResolutionEvidence = gainRows.length > 0 || details.some(detail =>
    detail && (detail.rawType === 'DRAW' || detail.rawType === 'HAND_GAIN')
  );

  return {
    consumesSpell,
    levelEightInHand,
    levelEightRows,
    gainRows,
    hasResolutionEvidence,
    resolvedExpectedCount: cards.length - 1 - 1 + 2
  };
}

// Normalize Trade-In locally as well as in duel-log-state. This makes the
// hand reconciler robust even when the visual reader labels a freshly drawn
// M07/M08 thumbnail as COST_TO_GRAVEYARD. Trade-In has exactly one Level 8
// discard cost; every later Level 8 result row belongs to the two-card draw.
function normalizedTradeInDetails(activationBlock) {
  const source = Array.isArray(activationBlock && activationBlock.details)
    ? activationBlock.details
    : [];
  if (!activationBlock || activationBlock.activationKey !== 'M12') return source;

  // At the hand-reconciliation layer, preserve already semantic HAND_GAIN
  // rows. Only repair rows that the visual log parser explicitly labeled as
  // COST_TO_GRAVEYARD/HAND_COST. If several Level-8 rows carry that cost label,
  // only the earliest can be the real Trade-In cost; later ones are draws.
  const explicitCostIndex = source.findIndex(detail => {
    const id = String(detail && detail.card && detail.card.id || '');
    const isLevelEight = isTradeInCostId(id);
    return isLevelEight && (detail.rawType === 'COST_TO_GRAVEYARD' || detail.role === 'HAND_COST');
  });

  return source.map((detail, index) => {
    const copy = { ...detail };
    const id = String(copy && copy.card && copy.card.id || '');
    const isLevelEight = isTradeInCostId(id);
    const explicitlyCostLike = copy.rawType === 'COST_TO_GRAVEYARD' || copy.role === 'HAND_COST';
    if (index === explicitCostIndex) {
      copy.side = 'SELF';
      copy.rawType = 'COST_TO_GRAVEYARD';
      copy.role = 'HAND_COST';
      return copy;
    }
    if (isLevelEight && explicitCostIndex >= 0 && explicitlyCostLike) {
      copy.side = 'SELF';
      copy.rawType = 'HAND_GAIN';
      copy.role = 'HAND_GAIN_CANDIDATE';
      return copy;
    }
    if (copy.role === 'HAND_GAIN_CANDIDATE' || copy.rawType === 'DRAW' || copy.rawType === 'HAND_GAIN') {
      copy.side = 'SELF';
      if (copy.role !== 'HAND_GAIN_CANDIDATE') copy.role = 'HAND_GAIN_CANDIDATE';
    }
    return copy;
  });
}

function handImpactForOperation(beforeCards, activationBlock) {
  const gains = (activationBlock && activationBlock.details || []).filter(detail =>
    detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  );
  const consumes = activationConsumesKnownHand(beforeCards, activationBlock);
  return { consumes, gains, relevant: consumes || gains.length > 0 };
}

// Blue top-level rows are operations, but many are only field history. Select
// by proven hand impact, never by screen position. The current one-operation
// locator deliberately refuses to collapse two real hand transactions into
// one, because doing so could lose an intermediate insertion/removal.
function selectSingleHandOperation(beforeCards, newBlocks, context = {}) {
  const blocks = Array.isArray(newBlocks) ? newBlocks.filter(Boolean) : [];
  const classified = blocks.map(block => ({
    block,
    impact: handImpactForOperation(beforeCards, block)
  }));
  const relevant = classified.filter(item => item.impact.relevant);

  // Persistent cards can create multiple top-level blue blocks for one physical
  // hand transaction: first the card leaves hand, then the same face-up card
  // activates one or more on-field follow-up effects. Merge that lifecycle when
  // the first block is a proven hand consumption and every following same-key
  // block is explicitly annotated as FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD.
  // This is relationship-driven and is not tied to a particular card id.
  for (let start = 0; start < classified.length; start++) {
    const first = classified[start];
    if (!first.impact.consumes) continue;
    const key = first.block && first.block.activationKey;
    if (!key) continue;
    const run = [first];
    for (let cursor = start + 1; cursor < classified.length; cursor++) {
      const item = classified[cursor];
      const relationship = item.block && item.block.relationship && item.block.relationship.type;
      if (item.block.activationKey !== key || relationship !== 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD') break;
      run.push(item);
    }
    if (run.length < 2) continue;
    const runRelevant = run.filter(item => item.impact.relevant);
    const outsideRelevant = relevant.filter(item => !run.includes(item));
    if (outsideRelevant.length) continue;
    const merged = {
      ...first.block,
      details: run.flatMap(item => item.block.details || []),
      signature: run.map(item => item.block.signature || item.block.activationKey).join('=>'),
      compoundOperations: run.map(item => item.block),
      compoundType: 'HAND_ACTIVATION_WITH_SAME_ACTIVE_CARD_FOLLOW_UP'
    };
    return {
      operation: merged,
      relevant,
      ignoredFieldOperations: classified.filter(item => !run.includes(item) && !item.impact.relevant).map(item => item.block),
      reason: null,
      normalization: 'PERSISTENT_CARD_HAND_ACTIVATION_PLUS_FIELD_FOLLOW_UP'
    };
  }

  // Raye route 3 with Yoto equipped can expose three apparent hand-impact
  // blocks at once: M06's self-summon process is rendered as fake gains of
  // M06/E10, while E10 really gains one card and M19 really searches one
  // Bamboo Sword. Sometimes both real gains are visually grouped under E10
  // and M19 is only a header. Normalize this exact, fully evidenced shape into
  // one +2 transaction and keep unrelated multi-operation cases fail-safe.
  {
    const rayeDirect = classified.find(item => item.block.activationKey === 'M06');
    const zeroDirect = classified.find(item => item.block.activationKey === 'E10');
    const yotoDirect = classified.find(item => item.block.activationKey === 'M19');
    const renderedRayeGainIds = rayeDirect ? rayeDirect.impact.gains.map(detail =>
      String(detail && detail.card && detail.card.id || '')
    ) : [];
    const hasRenderedZeroSummon = renderedRayeGainIds.includes('E10');
    const yotoHasTarget = yotoDirect && (yotoDirect.block.details || []).some(detail => detail.role === 'TARGET');
    const realGainDetails = [
      ...(zeroDirect ? zeroDirect.impact.gains : []),
      ...(yotoDirect ? yotoDirect.impact.gains : [])
    ];
    const rayeIndex = rayeDirect ? blocks.indexOf(rayeDirect.block) : -1;
    const yotoIndex = yotoDirect ? blocks.indexOf(yotoDirect.block) : -1;
    const zeroIndex = zeroDirect ? blocks.indexOf(zeroDirect.block) : -1;
    // A second M19 can legitimately remain in hand after the equipped copy
    // reached the GY. In that case activationConsumesKnownHand() cannot tell a
    // header-only graveyard activation from a fresh hand activation by card id
    // alone, so it may conservatively mark the M19 header as consuming hand.
    // In the exact route-3 settled shape below, however, ordering plus M06's
    // rendered E10 summon evidence proves this header belongs to the equipped
    // copy's graveyard follow-up. Treat that header as non-consuming only in
    // this narrow compound context.
    const yotoHeaderOnlyGraveFollowUp = Boolean(
      yotoDirect && yotoDirect.impact.gains.length === 0 && !yotoHasTarget &&
      rayeIndex >= 0 && yotoIndex > rayeIndex && zeroIndex > yotoIndex
    );
    if (rayeDirect && zeroDirect && yotoDirect &&
        !rayeDirect.impact.consumes && !zeroDirect.impact.consumes &&
        (!yotoDirect.impact.consumes || yotoHeaderOnlyGraveFollowUp) &&
        hasRenderedZeroSummon && !yotoHasTarget &&
        rayeIndex >= 0 && yotoIndex > rayeIndex && zeroIndex > yotoIndex) {
      // In the fully expanded log, E10's real recovery and M19's Bamboo search
      // both expose HAND_GAIN rows. In real chained resolution MD can compress
      // M19 to a header-only block even though the user already completed its
      // Bamboo target dialog. When that exact route shape is present, keep the
      // *count* of the missing M19 +1 and let physical hand recognition decide
      // whether the searched card was M14 or M20. Never guess the identity.
      let mergedGainDetails = realGainDetails;
      let inferredBambooGainCountOnly = false;
      if (realGainDetails.length === 1 && yotoHeaderOnlyGraveFollowUp && zeroDirect.impact.gains.length === 1) {
        inferredBambooGainCountOnly = true;
        const syntheticBambooGain = {
          rawType: 'HAND_GAIN',
          type: 'PROCESSING_CARD',
          role: 'HAND_GAIN_CANDIDATE',
          side: 'SELF',
          inferred: true,
          inference: 'RAYE_YOTO_CHAIN_M19_SEARCH_COUNT_CONFIRMED_BY_SETTLED_CHAIN',
          card: {
            id: 'UNKNOWN_BAMBOO_SEARCH',
            name: '妖刀竹光检索结果（待手牌实际识别）'
          },
          top3: [
            { id: 'M14', name: '金黄色的竹光' },
            { id: 'M20', name: '真刀竹光' }
          ]
        };
        mergedGainDetails = [...realGainDetails, syntheticBambooGain];
      }

      if (mergedGainDetails.length === 2) {
        const ordered = blocks.filter(block => block === yotoDirect.block || block === zeroDirect.block);
        const nonGainYotoDetails = (yotoDirect.block.details || []).filter(detail =>
          !(detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE')
        );
        return {
          operation: {
            ...zeroDirect.block,
            details: [
              ...(zeroDirect.block.details || []),
              ...nonGainYotoDetails,
              ...(inferredBambooGainCountOnly ? mergedGainDetails.slice(-1) : (yotoDirect.block.details || []).filter(detail =>
                detail && detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
              ))
            ],
            signature: `${zeroDirect.block.signature || 'E10'}+${yotoDirect.block.signature || 'M19'}`,
            compoundOperations: ordered,
            compoundType: inferredBambooGainCountOnly
              ? 'ZERO_DIRECT_RECOVERY_WITH_YOTO_SEARCH_INFERRED_BAMBOO_COUNT'
              : 'ZERO_DIRECT_RECOVERY_WITH_YOTO_SEARCH',
            recovery: inferredBambooGainCountOnly ? {
              type: 'RAYE_YOTO_CHAIN_HEADER_ONLY_M19_SEARCH',
              inferredBambooGainCountOnly: true,
              allowedBambooIds: bambooSearchTargetIds()
            } : null
          },
          relevant,
          ignoredFieldOperations: classified
            .filter(item => !item.impact.relevant || item === rayeDirect)
            .map(item => item.block),
          reason: null,
          normalizedFieldOperations: [rayeDirect.block],
          inferredBambooGainCountOnly,
          normalization: inferredBambooGainCountOnly
            ? 'RAYE_ZERO_DIRECT_WITH_YOTO_HEADER_ONLY_SEARCH_COUNT'
            : 'RAYE_ZERO_DIRECT_WITH_YOTO_RENDERED_SUMMON_ROWS'
        };
      }
    }
  }

  // Nadir Servant leaving hand and Garura's mandatory GY draw appear as two
  // independent blue headers, but together form one deterministic hand
  // transaction (-M18, +draw). Merge only this exact ordered card pair; all
  // other multiple hand operations retain the fail-safe below.
  if (relevant.length === 2) {
    const burial = relevant[0];
    const garura = relevant[1];
    const burialIndex = blocks.indexOf(burial.block);
    const garuraIndex = blocks.indexOf(garura.block);
    if (burial.block.activationKey === 'M18' && garura.block.activationKey === 'E01' &&
        burialIndex >= 0 && garuraIndex > burialIndex && burial.impact.consumes &&
        garura.impact.gains.length === 1) {
      return {
        operation: {
          ...burial.block,
          details: [...(burial.block.details || []), ...(garura.block.details || [])],
          signature: `${burial.block.signature || 'M18'}=>${garura.block.signature || 'E01'}`,
          compoundOperations: [burial.block, garura.block]
        },
        relevant,
        ignoredFieldOperations: classified.filter(item => !item.impact.relevant).map(item => item.block),
        reason: null
      };
    }

    // Real Master Duel rendering for Raye's self-effect can expose the M06
    // summon-process rows as apparent HAND_GAIN candidates (M06 and E10).
    // E10 is an Extra Deck monster and cannot actually enter the hand, so when
    // the same settled observation also contains E10's genuine one-card hand
    // gain, treat the M06 block as field/summon history and reconcile only E10.
    // This exact shape is intentionally narrow so unrelated two-operation hand
    // transactions still hit the fail-safe below.
    const rayeDirect = relevant.find(item => item.block.activationKey === 'M06');
    const zeroDirect = relevant.find(item => item.block.activationKey === 'E10');
    // R3 has already proved that the first Raye left hand and became E10.
    // A spare Raye remaining in hand must not turn the rendered field history
    // into a second hand consumption. Keep the exact summon/gain shape below
    // and require the executor-owned stage and expected activation for this case.
    const branch = context.runtime && context.runtime.v5Branch || {};
    const committedRayeFieldContext = context.expectedAtomicActivationKey === 'E10' &&
      context.runtime?.rayeNormalSummoned === true &&
      branch.currentState === 'E10_TARGET_PROMPT' && branch.carrierId === 'E10' &&
      branch.summonMode === 'RAYE_DIRECT' && branch.rayeOnlyMonster === true;
    if (rayeDirect && zeroDirect &&
        (!rayeDirect.impact.consumes || committedRayeFieldContext) && !zeroDirect.impact.consumes &&
        zeroDirect.impact.gains.length === 1) {
      const renderedRayeGainIds = rayeDirect.impact.gains.map(detail =>
        String(detail && detail.card && detail.card.id || '')
      );
      const hasRenderedZeroSummon = renderedRayeGainIds.includes('E10');
      const onlyImpossibleSummonRows = renderedRayeGainIds.length > 0 &&
        renderedRayeGainIds.every(id => id === 'M06' || id === 'E10');
      const rayeIndex = blocks.indexOf(rayeDirect.block);
      const zeroIndex = blocks.indexOf(zeroDirect.block);
      if (hasRenderedZeroSummon && onlyImpossibleSummonRows &&
          (!rayeDirect.impact.consumes ||
            (zeroDirect.block.relationship?.type === 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING' &&
              zeroDirect.block.relationship.parentActivationKey === 'M06')) &&
          rayeIndex >= 0 && zeroIndex > rayeIndex) {
        return {
          operation: zeroDirect.block,
          relevant,
          ignoredFieldOperations: classified
            .filter(item => !item.impact.relevant || item === rayeDirect)
            .map(item => item.block),
          reason: null,
          normalizedFieldOperations: [rayeDirect.block],
          normalization: 'RAYE_ZERO_DIRECT_RENDERED_SUMMON_ROWS'
        };
      }
    }

    // Route 2 with Yoto equipped: two materials Link Summon Zero Dream,
    // then Zero Dream adds one real hand card while Yoto's graveyard effect
    // searches one Bamboo Sword. Merge only when the same observation also
    // contains explicit Link Summon E10 evidence; otherwise keep the normal
    // multi-operation fail-safe.
    const zeroLink = relevant.find(item => item.block.activationKey === 'E10');
    const zeroYoto = relevant.find(item => item.block.activationKey === 'M19');
    const zeroYotoHasTarget = zeroYoto && (zeroYoto.block.details || []).some(detail => detail.role === 'TARGET');
    const hasZeroLinkSummon = blocks.some(block => (block.details || []).some(detail =>
      detail && (detail.rawType === 'LINK_SUMMON' || detail.type === 'LINK_SUMMON') &&
      detail.role === 'SUMMON_RESULT' &&
      String(detail.card && detail.card.id || '') === 'E10'
    ));
    if (zeroLink && zeroYoto && hasZeroLinkSummon &&
        zeroLink.impact.gains.length === 1 && zeroYoto.impact.gains.length === 1 &&
        !zeroLink.impact.consumes && !zeroYoto.impact.consumes && !zeroYotoHasTarget) {
      const ordered = blocks.filter(block => block === zeroLink.block || block === zeroYoto.block);
      return {
        operation: {
          ...zeroLink.block,
          details: [...(zeroLink.block.details || []), ...(zeroYoto.block.details || [])],
          signature: `${zeroLink.block.signature || 'E10'}+${zeroYoto.block.signature || 'M19'}`,
          compoundOperations: ordered,
          compoundType: 'ZERO_LINK_RECOVERY_WITH_YOTO_SEARCH'
        },
        relevant,
        ignoredFieldOperations: classified.filter(item => !item.impact.relevant).map(item => item.block),
        reason: null
      };
    }

    // When any legal monster equipped with Yoto Bamboo Sword is used to Link
    // Summon Kagari, Kagari's recovery and Yoto's graveyard search resolve in the
    // same settled observation. Both are additions to our hand and neither
    // consumes a current hand card. Merge only this exact, fully evidenced
    // pair; unrelated consecutive gains must continue to fail safe.
    const kagari = relevant.find(item => item.block.activationKey === 'E02');
    const yoto = relevant.find(item => item.block.activationKey === 'M19');
    const kagariRelationship = kagari && kagari.block.relationship && kagari.block.relationship.type;
    const yotoHasTarget = yoto && (yoto.block.details || []).some(detail => detail.role === 'TARGET');
    if (kagari && yoto &&
        kagari.impact.gains.length === 1 && yoto.impact.gains.length === 1 &&
        !kagari.impact.consumes && !yoto.impact.consumes && !yotoHasTarget &&
        kagariRelationship === 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD') {
      const ordered = blocks.filter(block => block === kagari.block || block === yoto.block);
      return {
        operation: {
          ...kagari.block,
          details: [...(kagari.block.details || []), ...(yoto.block.details || [])],
          signature: `${kagari.block.signature || 'E02'}+${yoto.block.signature || 'M19'}`,
          compoundOperations: ordered,
          compoundType: 'KAGARI_RECOVERY_WITH_YOTO_SEARCH'
        },
        relevant,
        ignoredFieldOperations: classified.filter(item => !item.impact.relevant).map(item => item.block),
        reason: null
      };
    }
  }
  return {
    operation: relevant.length === 1 ? relevant[0].block : null,
    relevant,
    ignoredFieldOperations: classified.filter(item => !item.impact.relevant).map(item => item.block),
    reason: relevant.length > 1 ? 'MULTIPLE_HAND_OPERATIONS_REQUIRE_SEQUENTIAL_RECONCILIATION' :
      relevant.length === 0 ? 'NO_HAND_AFFECTING_OPERATION' : null
  };
}

function mainDeckCandidates(detail) {
  const primaryId = String(detail && detail.card && detail.card.id || '');
  if (primaryId === EXODIA_UNKNOWN_ID && detail.card.persistentExodia === true) return [detail.card];
  const persistentExodia = buildExodiaComponentSet();
  const primary = detail && detail.card;
  const top3 = Array.isArray(detail && detail.top3) ? detail.top3 : [];
  const top3AreAllExodia = top3.length >= 3 && top3.every(row =>
    persistentExodia.has(String(row && row.id || ''))
  );
  // The sealed components are permanent once drawn and are intentionally not
  // clicked. Their tiny history thumbnails are visually similar, so accept a
  // bounded component-specific Top1 result before passive slot alignment. A
  // very small margin is sufficient only when the whole Top3 stays inside the
  // five singleton Exodia components; ordinary cards retain the stricter gate.
  if (
    persistentExodia.has(primaryId) &&
    (
      top3AreAllExodia && Number(detail && detail.confidenceMargin || 0) >= 0.005
    ) &&
    Number(primary && primary.rawMad) <= 0.30 &&
    Number(primary && primary.hsvDistance) <= 0.90
  ) {
    return [primary];
  }
  // A clearly separated right-log thumbnail is strong enough to collapse the
  // candidate set. Low-margin thumbnails still retain Top3 and are resolved
  // from the passive before/after hand images instead.
  if (/^M\d+$/.test(primaryId) && Number(detail.confidenceMargin || 0) >= 0.02) {
    return [detail.card];
  }
  const rows = [];
  if (detail && detail.card) rows.push(detail.card);
  for (const row of detail && detail.top3 || []) rows.push(row);
  const seen = new Set();
  return rows.filter(card => {
    const id = String(card && card.id || '');
    if ((!/^M\d+$/.test(id) && !isExodiaComponentId(id)) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function cartesian(rows, index = 0, prefix = [], output = []) {
  if (index >= rows.length) {
    output.push(prefix.slice());
    return output;
  }
  for (const value of rows[index]) {
    prefix.push(value);
    cartesian(rows, index + 1, prefix, output);
    prefix.pop();
  }
  return output;
}

function slotCombinations(total, count, start = 1, prefix = [], output = []) {
  if (prefix.length === count) {
    output.push(prefix.slice());
    return output;
  }
  for (let slot = start; slot <= total; slot++) {
    prefix.push(slot);
    slotCombinations(total, count, slot + 1, prefix, output);
    prefix.pop();
  }
  return output;
}

// Build every monotonic old-card alignment without assuming the new card's
// identity. This is the authoritative fallback when a tiny duel-log thumbnail
// does not contain the real card in Top3. Old hand order is stable; only the
// insertion slots are unknown.
function buildPositionOnlyScenarios(remaining, afterCount) {
  const addedCount = afterCount - remaining.length;
  if (addedCount < 0 || addedCount > 2) return [];
  return slotCombinations(afterCount, addedCount).map((newSlots, scenarioIndex) => {
    const newSet = new Set(newSlots);
    const oldAfterSlots = [];
    for (let slot = 1; slot <= afterCount; slot++) {
      if (!newSet.has(slot)) oldAfterSlots.push(slot);
    }
    return {
      scenarioIndex,
      chosen: [],
      newSlots,
      oldMappings: remaining.map((card, index) => ({
        beforeSlot: Number(card.index || index + 1),
        afterSlot: oldAfterSlots[index],
        cardId: card.id
      }))
    };
  });
}

function buildOrderedInsertionScenarios(remaining, chosen, library) {
  const rank = deckRank(library);
  const value = card => rank.get(card.id) ?? Number.MAX_SAFE_INTEGER;
  const sortedNew = [...chosen].sort((left, right) => value(left) - value(right));
  return buildPositionOnlyScenarios(remaining, remaining.length + chosen.length)
    .map(scenario => {
      const newSet = new Set(scenario.newSlots);
      let oldIndex = 0;
      let newIndex = 0;
      const entries = Array.from({ length: remaining.length + chosen.length }, (_, index) =>
        newSet.has(index + 1)
          ? { kind: 'NEW', card: sortedNew[newIndex++] }
          : { kind: 'OLD', card: remaining[oldIndex++] }
      );
      // A draw inserts cards; it cannot permute the observed old hand. Inside
      // the component band retain every insertion possibility. Equivalent
      // class/count layouts need no further probe; genuinely different
      // ordinary-card layouts need passive alignment, never head/arm/leg ID.
      const ordered = entries.every((entry, index) => {
        if (!index) return true;
        const previous = entries[index - 1];
        const delta = value(entry.card) - value(previous.card);
        if (delta < 0) return false;
        return delta !== 0 || isExodiaComponentId(entry.card.id) ||
          !(previous.kind === 'NEW' && entry.kind === 'OLD');
      });
      return ordered ? {
        ...scenario,
        chosen,
        newMappings: scenario.newSlots.map((slot, index) => ({ slot, card: sortedNew[index] }))
      } : null;
    }).filter(Boolean);
}

function equivalentComponentLayout(remaining, scenarios) {
  if (!scenarios.length) return false;
  const layouts = new Set(scenarios.map(scenario =>
    commitInsertionsAtSlots(remaining, scenario.newMappings, remaining.length + scenario.newSlots.length)
      .map(card => isExodiaComponentId(card.id) ? EXODIA_UNKNOWN_ID : card.id).join('|')
  ));
  return layouts.size === 1 && scenarios.some(scenario =>
    scenario.chosen.some(card => isExodiaComponentId(card.id))
  );
}

function inferIncrementalSlots(beforeCards, activationBlock, afterCount, library) {
  if (!activationBlock || !activationBlock.activationKey) {
    return { success: false, reason: 'ACTIVATION_BLOCK_UNAVAILABLE' };
  }
  const activationKey = activationBlock.activationKey;
  const effectiveActivationBlock = activationKey === 'M12'
    ? { ...activationBlock, details: normalizedTradeInDetails(activationBlock) }
    : activationBlock;
  const consumeIndex = activationConsumesKnownHand(beforeCards, effectiveActivationBlock)
    ? beforeCards.findIndex(card => card.id === activationKey)
    : -1;
  const consumed = consumeIndex >= 0 ? beforeCards[consumeIndex] : null;
  const consumedIndexes = new Set(consumeIndex >= 0 ? [consumeIndex] : []);
  const costConsumed = [];

  // Trade-In changes two physical hand cards even though the final hand count
  // is unchanged: the spell itself and one known Level 8 cost leave, then two
  // draws enter. The deck strategy always prefers Toon Dragon over H.A.M.P.;
  // mirror that known selection so passive before/after alignment can locate
  // both newly drawn slots instead of treating this as a one-card insertion.
  if (activationKey === 'M12') {
    const loggedCostId = (effectiveActivationBlock.details || [])
      .filter(detail => detail.side === 'SELF' && detail.role === 'HAND_COST')
      .map(detail => String(detail.card && detail.card.id || ''))
      .find(id => isTradeInCostId(id));
    const costIndex = beforeCards.findIndex((card, index) =>
      index !== consumeIndex && (
        loggedCostId ? card.id === loggedCostId : isTradeInCostId(card.id)
      )
    );
    if (costIndex < 0) {
      return {
        success: false,
        reason: 'TRADE_IN_COST_NOT_IN_KNOWN_HAND',
        activationKey,
        consumed
      };
    }
    consumedIndexes.add(costIndex);
    costConsumed.push(beforeCards[costIndex]);
  }

  let effectiveHandGainDetails = (effectiveActivationBlock.details || []).filter(detail =>
    detail.role === 'HAND_GAIN_CANDIDATE' && detail.side === 'SELF'
  );
  if (activationKey === 'M13') {
    const banishDetails = (effectiveActivationBlock.details || []).filter(detail =>
      detail.role === 'HAND_BANISH_COST' && detail.side === 'SELF'
    );
    const isNegatedOrUnresolvedActivation = effectiveHandGainDetails.length === 0 && banishDetails.length === 0;
    if (!isNegatedOrUnresolvedActivation &&
        (effectiveHandGainDetails.length !== 2 || banishDetails.length !== 1)) {
      return {
        success: false,
        reason: `ALLURE_RESOLUTION_EVIDENCE_INCOMPLETE:${effectiveHandGainDetails.length}_DRAWS/${banishDetails.length}_BANISH`,
        activationKey,
        consumed,
        costConsumed
      };
    }
    if (banishDetails.length === 1) {
      const banishedId = String(banishDetails[0].card && banishDetails[0].card.id || '');
      if (banishedId !== 'M06' && banishedId !== 'M08') {
        return {
          success: false,
          reason: `ALLURE_INVALID_BANISH_TARGET:${banishedId || 'UNKNOWN'}`,
          activationKey,
          consumed,
          costConsumed
        };
      }
      const oldBanishIndex = beforeCards.findIndex((card, index) =>
        index !== consumeIndex && card.id === banishedId
      );
      if (oldBanishIndex >= 0) {
        consumedIndexes.add(oldBanishIndex);
        costConsumed.push(beforeCards[oldBanishIndex]);
      } else {
        // The banished monster can itself be one of the two freshly drawn
        // cards. Remove one matching draw result so only cards still in the
        // final hand are located and committed.
        const drawnBanishIndex = effectiveHandGainDetails.findIndex(detail =>
          String(detail.card && detail.card.id || '') === banishedId
        );
        if (drawnBanishIndex < 0) {
          return {
            success: false,
            reason: `ALLURE_BANISHED_CARD_NOT_ACCOUNTED_FOR:${banishedId || 'UNKNOWN'}`,
            activationKey,
            consumed,
            costConsumed
          };
        }
        effectiveHandGainDetails = effectiveHandGainDetails.filter((_, index) => index !== drawnBanishIndex);
      }
    }
  }

  const remaining = beforeCards.filter((_, index) => !consumedIndexes.has(index));
  const addedCount = afterCount - remaining.length;
  if (addedCount < 0 || addedCount > 2) {
    return { success: false, reason: `UNSUPPORTED_INCREMENTAL_ADD_COUNT:${addedCount}`, consumed, costConsumed };
  }

  // Hard safety boundary: an opponent row can never create or locate one of
  // our hand cards, even if its tiny card-back pixels were misclassified.
  const handGainDetails = effectiveHandGainDetails;
  if (handGainDetails.length < addedCount) {
    // Some draw/search effects are semantically deterministic about how many
    // cards enter our hand, while Master Duel may compress or partially hide
    // the individual HAND_GAIN rows in the right log. The authoritative INFO
    // hand count has already told us the physical post-resolution count, so
    // for these known effects keep the *count* from the resolved card effect
    // and use passive slot alignment + card clicks to discover any identities
    // that the log did not expose. Never invent the missing card identity.
    const knownGainShape = (
      (activationKey === 'M12' && addedCount === 2) || // Trade-In: draw 2
      (activationKey === 'M14' && addedCount === 2) || // Golden Bamboo Sword: draw 2
      (activationKey === 'M17' && (addedCount === 1 || addedCount === 2)) // Engage: search, optional extra draw
    );
    if (knownGainShape) {
      const incompleteReason = activationKey === 'M12'
        ? `TRADE_IN_DRAW_IDENTITIES_INCOMPLETE:${handGainDetails.length}/2`
        : `KNOWN_EFFECT_GAIN_IDENTITIES_INCOMPLETE:${activationKey}:${handGainDetails.length}/${addedCount}`;
      return {
        success: false,
        reason: incompleteReason,
        activationKey,
        consumed,
        costConsumed,
        remaining,
        addedCount,
        candidateRows: handGainDetails.map(mainDeckCandidates),
        scenarios: [],
        knownEffectGainCount: true
      };
    }
    return { success: false, reason: `HAND_GAIN_EVIDENCE_MISSING:${handGainDetails.length}/${addedCount}`, consumed };
  }
  // Array#slice(-0) is slice(0), not an empty slice. Without this explicit
  // branch a zero-gain action reuses every old hand-gain row and can create a
  // phantom click target.
  const selectedDetails = addedCount === 0 ? [] : handGainDetails.slice(-addedCount);
  const candidateRows = selectedDetails.map(mainDeckCandidates);
  if (candidateRows.some(row => row.length === 0)) {
    return {
      success: false,
      reason: 'HAND_GAIN_CANDIDATES_EMPTY',
      activationKey,
      consumed,
      costConsumed,
      remaining,
      addedCount,
      candidateRows,
      scenarios: []
    };
  }

  const scenarios = cartesian(candidateRows)
    .flatMap(chosen => buildOrderedInsertionScenarios(remaining, chosen, library))
    .map((scenario, scenarioIndex) => ({ ...scenario, scenarioIndex }));
  const componentEquivalentLayout = equivalentComponentLayout(remaining, scenarios);
  if (componentEquivalentLayout) {
    // The new component's position among other components does not matter:
    // every candidate produces exactly the same class/count hand and the same
    // actionable ordinary-card slots. Canonically append within the band.
    // This is NOT proof of a particular head/arm/leg's physical position.
    scenarios.sort((left, right) => {
      for (let index = 0; index < left.newSlots.length; index++) {
        const delta = right.newSlots[index] - left.newSlots[index];
        if (delta) return delta;
      }
      return 0;
    });
  }
  const signatures = new Set(scenarios.map(scenario => scenario.newSlots.join(',')));
  if (signatures.size !== 1 && !componentEquivalentLayout) {
    return {
      success: false,
      reason: 'NEW_SLOT_NOT_UNIQUE_ACROSS_LOG_CANDIDATES',
      activationKey,
      consumed,
      costConsumed,
      remaining,
      addedCount,
      candidateRows,
      scenarios
    };
  }
  const certainNewCardsBySlot = scenarios[0].newSlots.map(slot => {
    const canonical = scenarios[0].newMappings.find(item => item.slot === slot);
    if (componentEquivalentLayout && canonical && isExodiaComponentId(canonical.card.id)) {
      return { slot, card: normalizeExodiaComponentCard(canonical.card) };
    }
    const candidates = scenarios.map(scenario => {
      const mapping = (scenario.newMappings || []).find(item => item.slot === slot);
      return mapping && mapping.card;
    }).filter(Boolean);
    const ids = new Set(candidates.map(card => card.id));
    return {
      slot,
      card: candidates.length === scenarios.length && ids.size === 1 ? candidates[0] : null
    };
  });
  return {
    success: true,
    componentEquivalentLayout,
    activationKey,
    consumed,
    costConsumed,
    remaining,
    addedCount,
    predictedSlots: scenarios[0].newSlots,
    certainNewCardsBySlot,
    candidateRows,
    scenarios
  };
}


function recoverTrueBambooDeckYotoKagariCompound(beforeCards, allBlocks, currentBlock, observedHandCount) {
  // Separate observer branch:
  //   M20 on-field effect -> M19 moved from Deck to the field/equipped
  //   equipped carrier -> Link E02
  //   M19 GY search + E02 recovery resolve together
  //
  // This is intentionally NOT the normal "M19 activated from hand" route.
  // When the compact right log clips Yoto's final Bamboo gain row, the
  // combination of the persisted M20->M19 field lifecycle, the two M19
  // processing headers, E02 recovery, and authoritative INFO +2 proves the
  // missing *count* only. The exact Bamboo identity is still discovered from
  // the physical hand click; it is never guessed here.
  if (!currentBlock || currentBlock.activationKey !== 'E02') return null;
  if (!Array.isArray(allBlocks) || !Number.isInteger(observedHandCount)) return null;
  if (observedHandCount !== (beforeCards || []).length + 2) return null;

  const recoveryGains = (currentBlock.details || []).filter(detail => {
    const id = String(detail && detail.card && detail.card.id || '');
    return detail && detail.side === 'SELF' &&
      detail.role === 'HAND_GAIN_CANDIDATE' &&
      (id === 'M17' || id === 'M22');
  });
  if (recoveryGains.length !== 1) return null;

  let e02Index = -1;
  for (let index = allBlocks.length - 1; index >= 0; index--) {
    const block = allBlocks[index];
    if (!block || block.activationKey !== 'E02') continue;
    if (currentBlock.signature && block.signature === currentBlock.signature) {
      e02Index = index;
      break;
    }
    if (e02Index < 0) e02Index = index;
  }
  if (e02Index < 0) return null;

  let m20Index = -1;
  for (let index = e02Index - 1; index >= 0; index--) {
    const block = allBlocks[index];
    if (!block || block.activationKey !== 'M20') continue;
    const hasM20Cost = (block.details || []).some(detail =>
      detail && detail.rawType === 'COST_TO_GRAVEYARD' &&
      String(detail.card && detail.card.id || '') === 'M20'
    );
    const hasDeckYotoMove = (block.details || []).some(detail =>
      detail && detail.rawType === 'MOVE_TO_FIELD' &&
      String(detail.card && detail.card.id || '') === 'M19'
    );
    if (hasM20Cost && hasDeckYotoMove) {
      m20Index = index;
      break;
    }
  }
  if (m20Index < 0) return null;

  let yotoLinkIndex = -1;
  let yotoSearchIndex = -1;
  for (let index = m20Index + 1; index < e02Index; index++) {
    const block = allBlocks[index];
    if (!block || block.activationKey !== 'M19') continue;
    const hasTarget = (block.details || []).some(detail => detail && detail.role === 'TARGET');
    const linksE02 = (block.details || []).some(detail =>
      detail && (detail.rawType === 'LINK_SUMMON' || detail.type === 'LINK_SUMMON') &&
      String(detail.card && detail.card.id || '') === 'E02'
    );
    if (linksE02 && yotoLinkIndex < 0) {
      yotoLinkIndex = index;
      continue;
    }
    if (!hasTarget && yotoLinkIndex >= 0 && index > yotoLinkIndex) {
      yotoSearchIndex = index;
      break;
    }
  }
  if (yotoLinkIndex < 0 || yotoSearchIndex < 0) return null;

  const yotoSearch = allBlocks[yotoSearchIndex];
  const explicitBambooGains = (yotoSearch.details || []).filter(detail => {
    const id = String(detail && detail.card && detail.card.id || '');
    return detail && detail.side === 'SELF' &&
      detail.role === 'HAND_GAIN_CANDIDATE' &&
      isLegalBambooSearchTarget(id);
  });
  if (explicitBambooGains.length > 1) return null;

  const yotoGain = explicitBambooGains[0] || {
    rawType: 'HAND_GAIN',
    type: 'PROCESSING_CARD',
    role: 'HAND_GAIN_CANDIDATE',
    side: 'SELF',
    inferred: true,
    inference: 'TRUE_BAMBOO_DECK_EQUIP_YOTO_GY_SEARCH_COUNT_CONFIRMED_BY_INFO',
    card: {
      id: 'UNKNOWN_BAMBOO_SEARCH',
      name: '妖刀竹光检索结果（待手牌实际识别）'
    },
    top3: []
  };

  const merged = {
    ...currentBlock,
    details: [...(currentBlock.details || []), yotoGain],
    signature: [
      allBlocks[m20Index].signature || 'M20',
      allBlocks[yotoLinkIndex].signature || 'M19_LINK_E02',
      yotoSearch.signature || 'M19_GY_SEARCH',
      currentBlock.signature || 'E02_RECOVERY'
    ].join('=>'),
    compoundOperations: [
      allBlocks[m20Index],
      allBlocks[yotoLinkIndex],
      yotoSearch,
      currentBlock
    ],
    compoundType: 'TRUE_BAMBOO_DECK_EQUIP_YOTO_KAGARI_COMPOUND',
    recovery: {
      type: 'TRUE_BAMBOO_DECK_EQUIP_YOTO_KAGARI_COMPOUND',
      m20Index,
      yotoLinkIndex,
      yotoSearchIndex,
      e02Index,
      inferredBambooGainCountOnly: !explicitBambooGains.length
    }
  };
  const expected = expectedHandCountFromOperation(beforeCards, merged);
  if (expected !== observedHandCount) return null;
  return {
    operation: merged,
    expectedHandCount: expected,
    inferredBambooGainCountOnly: !explicitBambooGains.length
  };
}

function recoverPersistentLifecycleAcrossCheckpoint(beforeCards, allBlocks, currentBlock, observedHandCount) {
  if (!currentBlock || !currentBlock.activationKey || !Array.isArray(allBlocks)) return null;
  const key = String(currentBlock.activationKey);
  const relationship = currentBlock.relationship && currentBlock.relationship.type;
  if (relationship !== 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD') return null;
  if (!(beforeCards || []).some(card => String(card && card.id || '') === key)) return null;
  if (!Number.isInteger(observedHandCount)) return null;

  let currentIndex = -1;
  for (let index = allBlocks.length - 1; index >= 0; index--) {
    const block = allBlocks[index];
    if (!block || String(block.activationKey || '') !== key) continue;
    if (currentBlock.signature && block.signature === currentBlock.signature) {
      currentIndex = index;
      break;
    }
    if (currentIndex < 0) currentIndex = index;
  }
  if (currentIndex <= 0) return null;

  let startIndex = currentIndex;
  while (startIndex > 0) {
    const previous = allBlocks[startIndex - 1];
    if (!previous || String(previous.activationKey || '') !== key) break;
    startIndex--;
  }
  if (startIndex === currentIndex) return null;

  const run = allBlocks.slice(startIndex, currentIndex + 1);
  const first = run[0];
  const firstRelationship = first.relationship && first.relationship.type;
  if (firstRelationship === 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD' ||
      firstRelationship === 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD' ||
      firstRelationship === 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING') return null;
  for (let index = 1; index < run.length; index++) {
    const type = run[index].relationship && run[index].relationship.type;
    if (type !== 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD') return null;
  }

  const merged = {
    ...first,
    details: run.flatMap(block => block.details || []),
    signature: run.map(block => block.signature || block.activationKey).join('=>'),
    compoundOperations: run,
    compoundType: 'RECOVERED_PERSISTENT_CARD_LIFECYCLE_ACROSS_CHECKPOINT',
    recovery: {
      type: 'PERSISTENT_CARD_LIFECYCLE_ACROSS_CHECKPOINT',
      activationKey: key,
      startIndex,
      currentIndex
    }
  };
  const expected = expectedHandCountFromOperation(beforeCards, merged);
  if (!Number.isInteger(expected) || expected !== observedHandCount) return null;
  return { operation: merged, expectedHandCount: expected, run };
}


function reconcileKnownEffectExpectedCount(beforeCards, activationBlock, observedHandCount) {
  if (!activationBlock || !Number.isInteger(observedHandCount)) return null;
  if (activationBlock.activationKey === 'M12') {
    const normalized = { ...activationBlock, details: normalizedTradeInDetails(activationBlock) };
    const profile = tradeInSemanticProfile(beforeCards, normalized);
    if (!profile || !profile.hasResolutionEvidence) return null;
    if (observedHandCount !== profile.resolvedExpectedCount) return null;
    return {
      activationKey: 'M12',
      expectedHandCount: profile.resolvedExpectedCount,
      operation: normalized,
      reason: 'TRADE_IN_RESOLVED_SEMANTICS',
      equation: `${beforeCards.length}-1(spell)-1(level8)+2(draw)=${profile.resolvedExpectedCount}`
    };
  }
  return null;
}

function expectedHandCountFromOperation(beforeCards, activationBlock) {
  if (!activationBlock || !activationBlock.activationKey) return null;
  const activationKey = activationBlock.activationKey;
  const consumed = activationConsumesKnownHand(beforeCards, activationBlock) ? 1 : 0;
  let extraCost = 0;
  if (activationKey === 'M12') {
    const normalized = { ...activationBlock, details: normalizedTradeInDetails(activationBlock) };
    const profile = tradeInSemanticProfile(beforeCards, normalized);
    if (!profile) return null;
    extraCost = 1;
    if (profile.hasResolutionEvidence) return profile.resolvedExpectedCount;
  }
  if (activationKey === 'M13') {
    const banishes = (activationBlock.details || []).filter(detail =>
      detail.side === 'SELF' && detail.role === 'HAND_BANISH_COST'
    ).length;
    const gains = (activationBlock.details || []).filter(detail =>
      detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
    ).length;
    if (!((gains === 0 && banishes === 0) || (gains === 2 && banishes === 1))) return null;
    extraCost = banishes;
  }
  const selfGains = (activationBlock.details || []).filter(detail =>
    detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
  ).length;
  if (selfGains > 2) return null;
  return beforeCards.length - consumed - extraCost + selfGains;
}

function patchHistogram(image, component) {
  const bins = new Float64Array(64);
  const centerX = component.centerX;
  const left = Math.max(0, Math.round(centerX - 42));
  const right = Math.min(image.width, Math.round(centerX + 42));
  let samples = 0;
  for (let y = 2; y < image.height; y += 2) {
    for (let x = left; x < right; x += 2) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Ignore the dark duel-log/board background and very neutral stone.
      // The exposed card title/art pixels carry substantially more colour.
      if (max < 45 || max - min < 10) continue;
      const bin = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
      bins[bin]++;
      samples++;
    }
  }
  if (samples) for (let index = 0; index < bins.length; index++) bins[index] /= samples;
  return bins;
}

function histogramDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index++) distance += Math.abs(left[index] - right[index]);
  return distance;
}

function resolveAmbiguousSlotsFromPassiveImages(
  ambiguousInference,
  beforeImage,
  beforeComponents,
  afterImage,
  afterComponents
) {
  const scenarios = ambiguousInference && ambiguousInference.scenarios || [];
  if (!scenarios.length || !beforeImage || !afterImage ||
      !beforeComponents || !afterComponents) {
    return { success: false, reason: 'PASSIVE_IMAGE_INPUT_MISSING' };
  }
  const beforeHistograms = beforeComponents.map(component => patchHistogram(beforeImage, component));
  const afterHistograms = afterComponents.map(component => patchHistogram(afterImage, component));
  const scored = scenarios.map(scenario => {
    const distances = scenario.oldMappings.map(mapping => histogramDistance(
      beforeHistograms[mapping.beforeSlot - 1],
      afterHistograms[mapping.afterSlot - 1]
    ));
    return {
      ...scenario,
      passiveScore: distances.reduce((sum, value) => sum + value, 0) / Math.max(1, distances.length),
      passiveDistances: distances
    };
  }).sort((a, b) => a.passiveScore - b.passiveScore);

  // Compare slot groups, not individual card-name candidates: several log
  // candidates can correctly predict the same insertion position.
  const groups = new Map();
  for (const scenario of scored) {
    const key = scenario.newSlots.join(',');
    const current = groups.get(key);
    if (!current || scenario.passiveScore < current.passiveScore) groups.set(key, scenario);
  }
  const rankedGroups = [...groups.values()].sort((a, b) => a.passiveScore - b.passiveScore);
  const best = rankedGroups[0];
  const second = rankedGroups[1];
  const margin = second ? second.passiveScore - best.passiveScore : Infinity;
  const ratio = second && second.passiveScore > 0 ? best.passiveScore / second.passiveScore : 0;
  if (!best || (second && margin < 0.025 && ratio > 0.82)) {
    return { success: false, reason: 'PASSIVE_SLOT_SCORE_AMBIGUOUS', rankedGroups, margin, ratio };
  }
  return {
    success: true,
    predictedSlots: best.newSlots,
    selectedScenario: best,
    rankedGroups,
    margin,
    ratio
  };
}

function commitRecognizedInsertions(remaining, recognizedCards, library) {
  const scenarios = buildOrderedInsertionScenarios(remaining, recognizedCards, library);
  if (scenarios.length !== 1 && !equivalentComponentLayout(remaining, scenarios)) {
    throw new Error('INSERTION_ORDER_REQUIRES_PASSIVE_SLOT_EVIDENCE');
  }
  return commitInsertionsAtSlots(remaining, scenarios[0].newMappings, remaining.length + recognizedCards.length);
}

function possibleMainDeckCardsAtSlot(remaining, predictedSlots, slot, library) {
  const rank = deckRank(library);
  const newSet = new Set(predictedSlots || []);
  const afterCount = (remaining || []).length + newSet.size;
  const layout = [];
  let oldIndex = 0;
  for (let current = 1; current <= afterCount; current++) {
    layout.push(newSet.has(current)
      ? { kind: 'NEW', slot: current }
      : { kind: 'OLD', slot: current, card: remaining[oldIndex++] });
  }
  const targetIndex = layout.findIndex(item => item.kind === 'NEW' && item.slot === slot);
  if (targetIndex < 0) return [];
  const previous = [...layout.slice(0, targetIndex)].reverse().find(item => item.kind === 'OLD');
  const next = layout.slice(targetIndex + 1).find(item => item.kind === 'OLD');
  const ranksFor = card => {
    const ids = card && card.candidateIds && card.candidateIds.length
      ? card.candidateIds
      : [card && card.id];
    return ids.filter(id => rank.has(id)).map(id => rank.get(id));
  };
  const previousRanks = previous ? ranksFor(previous.card) : [];
  const nextRanks = next ? ranksFor(next.card) : [];
  const lower = previousRanks.length ? Math.min(...previousRanks) : 0;
  const upper = nextRanks.length ? Math.max(...nextRanks) : Number.MAX_SAFE_INTEGER;
  const exactCounts = new Map();
  for (const card of remaining || []) {
    if (card && /^M\d+$/.test(String(card.id || ''))) {
      exactCounts.set(card.id, (exactCounts.get(card.id) || 0) + 1);
    }
  }
  return (library.cards || []).filter(card => {
    if (!/^M\d+$/.test(String(card.id || ''))) return false;
    const cardRank = rank.get(card.id);
    if (cardRank < lower || cardRank > upper) return false;
    // The five sealed components are singletons and never leave hand. Once an
    // exact component is already present, it cannot be this new draw.
    if (/^M0[1-5]$/.test(card.id) && (exactCounts.get(card.id) || 0) >= Number(card.count || 1)) {
      return false;
    }
    return true;
  });
}

function inferPersistentExodiaAtSlot(remaining, predictedSlots, slot, library, evidenceRows = []) {
  const possible = possibleMainDeckCardsAtSlot(remaining, predictedSlots, slot, library);
  const possibleExodia = possible.filter(card => isExactExodiaComponentId(card.id));
  const rows = (evidenceRows || []).flat().filter(Boolean);
  const evidenceIds = rows.map(card => String(card.id || ''));
  const evidenceSaysComponentClass = Boolean(
    (evidenceIds[0] === EXODIA_UNKNOWN_ID && rows[0].persistentExodia === true) ||
    (isExactExodiaComponentId(evidenceIds[0]) &&
      evidenceIds.filter(isExactExodiaComponentId).length >= 2)
  );
  const orderingSaysOnlyComponents = Boolean(
    possible.length && possible.length === possibleExodia.length
  );
  if (!possibleExodia.length || (!orderingSaysOnlyComponents && !evidenceSaysComponentClass)) return null;

  // Never force head/arm/leg identity from a tiny history thumbnail.  Once the
  // insertion slot and component class are proven, quantity is sufficient.
  return {
    id: EXODIA_UNKNOWN_ID,
    name: '被封印组件（身份无需区分）',
    persistentExodia: true,
    candidateIds: possibleExodia.map(card => card.id)
  };
}

function commitInsertionsAtSlots(remaining, insertedCards, afterCount) {
  const bySlot = new Map((insertedCards || []).map(item => [item.slot, item.card]));
  if (bySlot.size !== (insertedCards || []).length) throw new Error('DUPLICATE_INSERTION_SLOT');
  const output = [];
  let oldIndex = 0;
  for (let slot = 1; slot <= afterCount; slot++) {
    const card = bySlot.get(slot) || remaining[oldIndex++];
    if (!card) throw new Error(`INSERTION_COMMIT_SLOT_MISSING:${slot}`);
    output.push({ ...card, index: slot });
  }
  if (oldIndex !== remaining.length || output.length !== afterCount) {
    throw new Error('INSERTION_COMMIT_COUNT_MISMATCH');
  }
  return output;
}

module.exports = {
  activationConsumesKnownHand,
  handImpactForOperation,
  selectSingleHandOperation,
  deckRank,
  mainDeckCandidates,
  recoverTrueBambooDeckYotoKagariCompound,
  recoverPersistentLifecycleAcrossCheckpoint,
  reconcileKnownEffectExpectedCount,
  expectedHandCountFromOperation,
  inferIncrementalSlots,
  buildPositionOnlyScenarios,
  resolveAmbiguousSlotsFromPassiveImages,
  commitRecognizedInsertions,
  possibleMainDeckCardsAtSlot,
  inferPersistentExodiaAtSlot,
  commitInsertionsAtSlots
};
