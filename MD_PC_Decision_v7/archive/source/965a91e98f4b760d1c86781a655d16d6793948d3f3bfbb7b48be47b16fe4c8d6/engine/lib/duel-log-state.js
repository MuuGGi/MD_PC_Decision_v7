'use strict';
const { isTradeInCostId } = require('./trade-in-policy');
const { buildAllureBanishPriority } = require('./allure-policy');
const { isLegalBambooSearchTarget } = require('./bamboo-search-policy');


// Cards in this set remain active on the field and may create a second
// top-level blue log entry when their on-field effect is used. That second
// entry is not another copy leaving the hand. Keep this explicit instead of
// treating every pair of identical activations alike: repeated normal spells
// such as M09 can genuinely be two copies activated from the hand.
const SAME_ACTIVE_CARD_FOLLOW_UP_IDS = new Set([
  'M20', // 真刀竹光：装备后再次发动场上效果
  'M21'  // 试胆竞速
]);

// Both Bamboo Swords used by this deck are Equip Spells. Their target row
// shares the same visual card column as HAND_GAIN. In this deck the legal
// monster targets can be Main Deck monsters, Extra Deck monsters, or the
// Sky Striker Token, so normalize any of those identities to TARGET.
const EQUIP_SPELL_IDS = new Set([
  'M19', // 妖刀竹光
  'M20'  // 真刀竹光
]);
const EQUIP_TARGET_MONSTER_IDS = new Set([
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08',
  'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10',
  'TOKEN_SKY_STRIKER'
]);
const ALLURE_BANISH_IDS = new Set(buildAllureBanishPriority().map(item => item.id));


function hasHandGainActionIcon(detail) {
  return Boolean(detail && (detail.actionEvidence === 'HAND_GAIN_ACTION_ICON' || detail.actionEvidence === 'HAND_GAIN_ACTION_ICON_AUX'));
}

function activationKey(event) {
  const card = event && event.card;
  return card && (card.id || card.name) ? String(card.id || card.name) : 'UNKNOWN_ACTIVATION';
}

function detailToken(event) {
  const card = event && event.card;
  return `${event && event.type || 'UNKNOWN'}:${card && (card.id || card.name) || 'UNKNOWN'}`;
}

function processingRole(eventType) {
  switch (eventType) {
    case 'HAND_GAIN':
    case 'RETURN_TO_HAND':
      return 'HAND_GAIN_CANDIDATE';
    case 'TARGET':
      return 'TARGET';
    case 'SPECIAL_SUMMON':
    case 'LINK_SUMMON':
      return 'SUMMON_RESULT';
    case 'DESTROY':
    case 'SEND_TO_GRAVEYARD':
      return 'REMOVAL_RESULT';
    case 'EFFECT_PROCESSING':
      return 'EFFECT_PROCESSING';
    default:
      return 'UNRESOLVED_PROCESSING';
  }
}

function buildActivationBlocks(events) {
  const ordered = [...(events || [])].sort((a, b) => a.box.y - b.box.y);
  const blocks = [];
  const orphanDetails = [];
  let current = null;

  // Proven field departures followed by a Link summon form a field operation,
  // not an extension of the preceding hand activation (often a normal summon).
  const fieldStarts = new Map();
  for (let i=0;i<ordered.length;i++) {
    const link=ordered[i];
    if(link.type!=='LINK_SUMMON'||link.source!=='ACTION_LABEL_AND_ZONE_ICONS')continue;
    let first=i;
    while(first>0&&['SEND_TO_GRAVEYARD','DESTROY'].includes(ordered[first-1].type)&&
      ordered[first-1].source==='ACTION_LABEL_AND_ZONE_ICONS')first--;
    if(first<i&&ordered.slice(first,i).some(e=>e.type==='SEND_TO_GRAVEYARD'))fieldStarts.set(ordered[first],link);
  }
  for (const event of ordered) {
    if(fieldStarts.has(event)) {
      const link=fieldStarts.get(event);
      current={activation:{...link,type:'LINK_OPERATION'},activationKey:activationKey(link),details:[],
        startY:event.box.y,endY:link.box.y+link.box.height,source:'PROVEN_FIELD_LINK_OPERATION'};
      blocks.push(current);
    }
    if (event.type === 'ACTIVATE' && event.side === 'SELF') {
      current = {
        activation: event,
        activationKey: activationKey(event),
        details: [],
        startY: event.box.y,
        endY: event.box.y + event.box.height
      };
      blocks.push(current);
      continue;
    }

    const detail = {
      ...event,
      rawType: event.type,
      type: 'PROCESSING_CARD',
      // A face-up or face-down thumbnail below a blue activation header is
      // part of that activation's processing. Its exact role (cost, discard,
      // draw, add, reveal) must be resolved from the surrounding block; it is
      // never an independent opponent action merely because it is face-down.
      role: processingRole(event.type)
    };
    // Equip-spell target rows share the same visual card column as hand gains.
    // Normalize every monster identity that this deck can legally put on the
    // field, rather than only Extra Deck monsters. This is required for cases
    // such as M19 equipped to M06 Raye, where the live reader otherwise sees
    // the target thumbnail as HAND_GAIN:M06.
    const detailCardKey = detail.card && String(detail.card.id || detail.card.name || '');
    if(detail.rawType==='DESTROY' && detail.source==='ACTION_LABEL_AND_ZONE_ICONS' &&
       EQUIP_SPELL_IDS.has(detailCardKey)) detail.role='FIELD_PROCESSING'; // equipment loss is not another Link material
    if (current && EQUIP_SPELL_IDS.has(current.activationKey) &&
        detail.role === 'HAND_GAIN_CANDIDATE' && EQUIP_TARGET_MONSTER_IDS.has(detailCardKey)) {
      detail.rawType = 'TARGET';
      detail.role = 'TARGET';
    }
    if (!current) {
      orphanDetails.push(detail);
      continue;
    }
    current.details.push(detail);
    current.endY = Math.max(current.endY, event.box.y + event.box.height);
  }

  for (const block of blocks) {
    // Nadir Servant sends Garura from the Extra Deck to the GY. The E01 row
    // occupies the same visual result column as a hand gain, but Extra Deck
    // cards cannot enter the main-deck hand.
    if (block.activationKey === 'M18') {
      for (const detail of block.details) {
        const key = detail.card && String(detail.card.id || detail.card.name || '');
        if (detail.role === 'HAND_GAIN_CANDIDATE' && key === 'E01') {
          detail.rawType = 'SEND_EXTRA_DECK_TO_GRAVEYARD';
          detail.role = 'FIELD_PROCESSING';
        }
      }
    }
    // Allure of Darkness: preserve the original card-specific correction as
    // the primary rule. The compact log can put draw and banish results in the
    // same right-side column, so use the known resolution order: first two
    // result rows are draws; the final certain M06/M08 result is the banish.
    // The hand-gain icon is retained only as auxiliary evidence and never
    // reorders or overrides these rows.
    if (block.activationKey === 'M13') {
      const resultRows = block.details.filter(detail =>
        detail.role === 'HAND_GAIN_CANDIDATE' || detail.rawType === 'DRAW'
      );
      const banished = resultRows.length >= 3 ? resultRows[resultRows.length - 1] : null;
      const banishedKey = banished && banished.card && String(banished.card.id || '');
      const hasCertainBanish = Boolean(banished && ALLURE_BANISH_IDS.has(banishedKey));
      if (hasCertainBanish) {
        resultRows.slice(0, 2).forEach(detail => {
          detail.side = 'SELF';
          detail.rawType = 'HAND_GAIN';
          detail.role = 'HAND_GAIN_CANDIDATE';
        });
        resultRows.slice(2, -1).forEach(detail => {
          detail.side = 'SELF';
          detail.rawType = 'BANISH_SELECTION';
          detail.role = 'FIELD_PROCESSING';
        });
        banished.side = 'SELF';
        banished.rawType = 'BANISH_FROM_HAND';
        banished.role = 'HAND_BANISH_COST';
      } else {
        resultRows.slice(0, 2).forEach(detail => {
          detail.side = 'SELF';
          detail.role = 'HAND_GAIN_CANDIDATE';
        });
      }
    }
    // Trade-In: preserve the original/corrected card-specific grammar as the
    // primary rule. There is exactly one Level-8 discard cost, followed by two
    // draws. Choose the earliest eligible Level-8 processing row as the cost;
    // later Level-8 rows are gains. This handles drawing M07/M08 without
    // letting the auxiliary hand icon redefine top-level/block geometry.
    if (block.activationKey === 'M12') {
      const levelEightRows = block.details.filter(detail => {
        const key = detail.card && String(detail.card.id || detail.card.name || '');
        return isTradeInCostId(key) && detail.rawType !== 'DRAW';
      });
      const chosenCost = levelEightRows[0] || null;
      for (const detail of block.details) {
        const key = detail.card && String(detail.card.id || detail.card.name || '');
        const isLevelEight = isTradeInCostId(key);
        if (detail === chosenCost && isLevelEight) {
          detail.side = 'SELF';
          detail.rawType = 'COST_TO_GRAVEYARD';
          detail.role = 'HAND_COST';
        } else if (chosenCost && isLevelEight && detail !== chosenCost &&
                   (detail.rawType === 'COST_TO_GRAVEYARD' ||
                    detail.role === 'HAND_COST' ||
                    detail.role === 'UNRESOLVED_PROCESSING' ||
                    detail.role === 'HAND_GAIN_CANDIDATE')) {
          detail.side = 'SELF';
          detail.rawType = 'HAND_GAIN';
          detail.role = 'HAND_GAIN_CANDIDATE';
        } else if (detail.rawType === 'DRAW' && key === 'UNKNOWN') {
          detail.side = 'SELF';
          detail.role = 'HAND_GAIN_CANDIDATE';
        } else if (detail.role === 'HAND_GAIN_CANDIDATE') {
          detail.side = 'SELF';
        }
      }
    }
    // True Bamboo Sword's on-field effect sends itself to the GY as cost and
    // moves Yoto Bamboo Sword from the Deck onto the field. Both cards use the
    // same right-side result column as a hand gain, but neither enters hand.
    // The initial equip activation is separately identified by its E-card
    // TARGET row, so M20/M19 result rows unambiguously belong to field work.
    if (block.activationKey === 'M20') {
      for (const detail of block.details) {
        const key = detail.card && String(detail.card.id || detail.card.name || '');
        if (detail.role === 'HAND_GAIN_CANDIDATE' && (key === 'M20' || key === 'M19')) {
          detail.rawType = key === 'M20' ? 'COST_TO_GRAVEYARD' : 'MOVE_TO_FIELD';
          detail.role = 'FIELD_PROCESSING';
        }
      }
    }
    block.signature = `${block.activationKey}|${block.details.map(detailToken).join(',')}`;
  }
  annotateBlockRelationships(blocks);
  return { blocks, orphanDetails };
}

function annotateBlockRelationships(blocks) {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const previous = index > 0 ? blocks[index - 1] : null;
    const previousPutSameCardInHand = Boolean(
      previous && (previous.details || []).some(detail => {
        const card = detail && detail.card;
        return detail && detail.side === 'SELF' &&
          detail.role === 'HAND_GAIN_CANDIDATE' && card &&
          String(card.id || card.name || '') === block.activationKey;
      })
    );
    const isSameActiveCardFollowUp = Boolean(
      previous &&
      previous.activationKey === block.activationKey &&
      SAME_ACTIVE_CARD_FOLLOW_UP_IDS.has(block.activationKey) &&
      !previousPutSameCardInHand
    );
    let linkedParent = previous;
    let linkedDetail = null;
    if (previous) {
      const matchingDetails = (previous.details || []).filter(detail => {
        const card = detail && detail.card;
        return card && String(card.id || card.name) === block.activationKey;
      });

      // The same card can appear more than once in the previous block. A
      // common live shape is Kagari/E02: TARGET:M17 followed by
      // RETURN_TO_HAND:M17, then the returned Engage is immediately activated.
      // The old first-match rule picked TARGET and mislabeled that fresh hand
      // activation as FOLLOW_UP_FROM_PREVIOUS_PROCESSING. Prefer the evidence
      // that proves where the card actually ended up.
      if (/^M\d+$/.test(block.activationKey)) {
        linkedDetail = matchingDetails.find(detail =>
          detail.side === 'SELF' && detail.role === 'HAND_GAIN_CANDIDATE'
        ) || matchingDetails[0] || null;
      } else if (/^E\d+$/.test(block.activationKey)) {
        linkedDetail = matchingDetails.find(detail =>
          detail.role === 'SUMMON_RESULT'
        ) || matchingDetails[0] || null;
      } else {
        linkedDetail = matchingDetails[0] || null;
      }
    }
    // A chain can place another activation between a Link Summon and the
    // summoned monster's own effect (for example M19 CL1 / Kagari CL2).
    // If the immediately previous block does not carry the summoned card,
    // search backward for the nearest proven SUMMON_RESULT of this Extra Deck
    // monster. This is run again after multi-viewport stitching.
    if (!linkedDetail && /^E\d+$/.test(block.activationKey)) {
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        const candidate = blocks[cursor];
        const summon = (candidate.details || []).find(detail => {
          const card = detail && detail.card;
          return detail && detail.role === 'SUMMON_RESULT' && card &&
            String(card.id || card.name) === block.activationKey;
        });
        if (summon) {
          linkedParent = candidate;
          linkedDetail = summon;
          break;
        }
        // Do not attach an effect to an older copy past another activation of
        // the same Extra Deck monster.
        if (candidate.activationKey === block.activationKey) break;
      }
    }
    const linkedCardKey = linkedDetail && String(linkedDetail.card.id || linkedDetail.card.name);
    const isExtraDeckFollowUp = linkedCardKey && linkedCardKey.startsWith('E');
    const isSummonedCardFollowUp = linkedDetail && linkedDetail.role === 'SUMMON_RESULT';
    if (isSameActiveCardFollowUp) {
      block.relationship = {
        type: 'FOLLOW_UP_EFFECT_OF_SAME_ACTIVE_CARD',
        parentActivationKey: previous.activationKey,
        evidenceCard: previous.activation.card
      };
    } else if (isSummonedCardFollowUp) {
      block.relationship = {
        type: 'FOLLOW_UP_EFFECT_OF_SUMMONED_CARD',
        parentActivationKey: linkedParent && linkedParent.activationKey || null,
        evidenceCard: linkedDetail.card
      };
    } else if (linkedDetail && linkedDetail.role === 'HAND_GAIN_CANDIDATE' && !isExtraDeckFollowUp) {
      block.relationship = {
        type: 'INDEPENDENT_ACTIVATION_AFTER_HAND_GAIN',
        parentActivationKey: null,
        evidenceCard: linkedDetail.card
      };
    } else if (linkedDetail) {
      block.relationship = {
        type: 'FOLLOW_UP_FROM_PREVIOUS_PROCESSING',
        parentActivationKey: linkedParent && linkedParent.activationKey || null,
        evidenceCard: linkedDetail.card
      };
    } else block.relationship = {
      type: 'INDEPENDENT_OR_ORIGIN_NOT_VISIBLE',
      parentActivationKey: null,
      evidenceCard: null
    };
  }
  return blocks;
}

function checkpointFrom(blocks) {
  if (!blocks.length) return null;
  const last = blocks[blocks.length - 1];
  const previous = blocks.length >= 2 ? blocks[blocks.length - 2] : null;
  return {
    activationKey: last.activationKey,
    signature: last.signature,
    signatureOccurrence: blocks.filter(block => block.signature === last.signature).length,
    activationOccurrence: blocks.filter(block => block.activationKey === last.activationKey).length,
    previousActivationKey: previous ? previous.activationKey : null,
    evidenceCards: last.details
      .filter(detail => detail && detail.card && (detail.card.id || detail.card.name))
      .map(detail => ({
        kind: detail.role === 'HAND_GAIN_CANDIDATE' ? 'HAND_GAIN' : 'PROCESSING_CARD',
        cardKey: String(detail.card.id || detail.card.name),
        cardName: detail.card.name || detail.card.id
      }))
  };
}

function findProcessingEvidenceAnchor(orphanDetails, checkpoint) {
  const evidence = checkpoint && checkpoint.evidenceCards || [];
  if (!evidence.length) return null;
  for (const detail of orphanDetails || []) {
    const card = detail && detail.card;
    if (!card) continue;
    const cardKey = String(card.id || card.name || '');
    const matched = evidence.find(item => item.cardKey === cardKey);
    if (matched) {
      return {
        kind: matched.kind,
        cardKey,
        cardName: matched.cardName,
        source: 'ORPHAN_PROCESSING_ROW_ABOVE_VISIBLE_OPERATIONS'
      };
    }
  }
  return null;
}

function findCheckpointMatch(blocks, checkpoint) {
  if (!checkpoint) return { index: -1, contextMatched: false, reason: 'NO_CHECKPOINT' };
  const exactCandidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(item => item.block.signature === checkpoint.signature);
  const activationCandidates = () => blocks
      .map((block, index) => ({ block, index }))
      .filter(item => item.block.activationKey === checkpoint.activationKey);

  if (checkpoint.previousActivationKey) {
    const withSavedPredecessor = candidates => candidates.filter(item =>
      item.index > 0 && blocks[item.index - 1].activationKey === checkpoint.previousActivationKey
    );
    const contextualExact = withSavedPredecessor(exactCandidates);
    if (contextualExact.length) {
      return {
        index: contextualExact[0].index,
        contextMatched: true,
        matchType: 'EXACT_SIGNATURE_WITH_PREDECESSOR'
      };
    }

    // The old block can acquire a TARGET/result row after its checkpoint was
    // saved, while a newer activation happens to retain the old empty
    // signature (M19|). Exact-signature candidates with the wrong predecessor
    // must not prevent this contextual activation fallback.
    const contextualActivation = withSavedPredecessor(activationCandidates());
    if (contextualActivation.length) {
      // Only allow activation-key fallback when the saved checkpoint had no
      // detail evidence yet. If the checkpoint already contained a TARGET,
      // gain, summon result, etc., a later activation of the same card with the
      // same predecessor is not enough to prove identity. This matters for
      // Raye+Yoto sequences where the old equipped M19 and the new graveyard
      // M19 activation can both appear after M06. Keep scrolling upward until
      // the old detailed checkpoint itself becomes visible.
      const hasSavedDetailEvidence = Array.isArray(checkpoint.evidenceCards) &&
        checkpoint.evidenceCards.length > 0;
      if (!hasSavedDetailEvidence) {
        return {
          index: contextualActivation[0].index,
          contextMatched: true,
          matchType: 'ACTIVATION_KEY_WITH_PREDECESSOR'
        };
      }
      return {
        index: -1,
        contextMatched: false,
        reason: 'CHECKPOINT_DETAIL_EVIDENCE_NOT_VISIBLE'
      };
    }
    // Predecessor context is a hard part of the checkpoint identity. A row at
    // the top of the current viewport has unknown context, not matching
    // context. This deliberately asks the live reader to keep scrolling up.
    return {
      index: -1,
      contextMatched: false,
      reason: (exactCandidates.length || activationCandidates().length)
        ? 'PREVIOUS_ACTIVATION_NOT_VISIBLE_OR_MISMATCHED'
        : 'CHECKPOINT_CARD_NOT_VISIBLE'
    };
  }

  let candidates = exactCandidates;
  let matchType = 'EXACT_SIGNATURE';
  if (!candidates.length) {
    candidates = activationCandidates();
    matchType = 'ACTIVATION_KEY_FALLBACK';
  }
  if (candidates.length && Number.isInteger(checkpoint.signatureOccurrence)) {
    const ordinal = checkpoint.signatureOccurrence - 1;
    if (ordinal >= 0 && ordinal < candidates.length) {
      const selected = candidates[ordinal];
      return { index: selected.index, contextMatched: null, matchType };
    }
    return { index: -1, contextMatched: null, reason: 'SAVED_OCCURRENCE_NOT_VISIBLE' };
  }
  // Prefer the earliest surviving occurrence. If an identical activation was
  // appended after the checkpoint, choosing the later one would hide it.
  return candidates.length
    ? {
        index: candidates[0].index,
        contextMatched: null,
        matchType
      }
    : { index: -1, contextMatched: false, reason: 'CHECKPOINT_NOT_VISIBLE' };
}

function findCheckpointIndex(blocks, checkpoint) {
  return findCheckpointMatch(blocks, checkpoint).index;
}

function normalizeInterposedKagariBambooResults(blocks) {
  // When Kagari is CL2 and Yoto Bamboo Sword is CL1, the bottom viewport can
  // omit Yoto's blue heading. Both resolved gains are then visually grouped
  // under Kagari. Reassign only the Bamboo search result, and only when the
  // paired Kagari recovery result proves this exact compound chain.
  for (let kagariIndex = 0; kagariIndex < blocks.length; kagariIndex++) {
    const kagari = blocks[kagariIndex];
    if (kagari.activationKey !== 'E02') continue;
    const recoveryDetails = (kagari.details || []).filter(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return detail.role === 'HAND_GAIN_CANDIDATE' && (key === 'M17' || key === 'M22');
    });
    const bambooDetails = (kagari.details || []).filter(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return detail.role === 'HAND_GAIN_CANDIDATE' && isLegalBambooSearchTarget(key);
    });
    const recoveryIds = [...new Set(recoveryDetails.map(detail =>
      String(detail.card.id || detail.card.name || '')
    ))];
    const bambooIds = [...new Set(bambooDetails.map(detail =>
      String(detail.card.id || detail.card.name || '')
    ))];
    if (recoveryIds.length !== 1) continue;

    // RETURN_TO_HAND and HAND_GAIN can be two recognizer descriptions of the
    // same visible result across overlapping viewports. Keep one semantic
    // gain, preferring the explicit return row.
    const recoveryId = recoveryIds[0];
    const canonicalRecovery = recoveryDetails.find(detail => detail.rawType === 'RETURN_TO_HAND') ||
      recoveryDetails[0];
    kagari.details = (kagari.details || []).filter(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return !(detail.role === 'HAND_GAIN_CANDIDATE' && key === recoveryId);
    });
    kagari.details.push(canonicalRecovery);

    let yotoIndex = -1;
    for (let cursor = kagariIndex - 1; cursor >= 0; cursor--) {
      if (blocks[cursor].activationKey === 'M19') {
        yotoIndex = cursor;
        break;
      }
      // This normalization is intentionally local to one compound chain.
      if (blocks[cursor].activationKey === 'E02') break;
    }
    if (yotoIndex < 0) continue;
    const yoto = blocks[yotoIndex];
    // Viewport overlap can align two visually identical M19 headings. A
    // Kagari recovery row may consequently be duplicated onto the Yoto block.
    // Yoto can only search a Bamboo Sword; remove recovery-card rows from it
    // when the same compound E02 block is present.
    yoto.details = (yoto.details || []).filter(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return key !== 'M17' && key !== 'M22';
    });
    yoto.signature = `${yoto.activationKey}|${yoto.details.map(detailToken).join(',')}`;
    if (bambooIds.length !== 1) {
      kagari.signature = `${kagari.activationKey}|${kagari.details.map(detailToken).join(',')}`;
      continue;
    }
    const bambooId = bambooIds[0];
    const existingBambooGain = (yoto.details || []).some(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return detail.role === 'HAND_GAIN_CANDIDATE' && key === bambooId;
    });
    const moved = bambooDetails[0];
    kagari.details = kagari.details.filter(detail => {
      const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
      return !(detail.role === 'HAND_GAIN_CANDIDATE' && key === bambooId);
    });
    if (!existingBambooGain) yoto.details.push(moved);

    const hasVisibleKagariLink = blocks.slice(0, kagariIndex).some(block =>
      (block.details || []).some(detail => {
        const key = detail && detail.card && String(detail.card.id || detail.card.name || '');
        return detail.rawType === 'LINK_SUMMON' && key === 'E02';
      })
    );
    if (!hasVisibleKagariLink) {
      // LINK_SUMMON can be clipped at the top edge of every stitched viewport.
      // Infer it only from the complete compound signature: an earlier carrier
      // removal, a distinct M19 graveyard search, and E02 recovering one known
      // Sky Striker spell while M19 yields one Bamboo Sword.
      for (let cursor = yotoIndex - 1; cursor >= 0; cursor--) {
        const parent = blocks[cursor];
        const hasCarrierRemoval = (parent.details || []).some(detail =>
          detail && detail.role === 'REMOVAL_RESULT'
        );
        if (!hasCarrierRemoval) continue;
        parent.details.push({
          rawType: 'LINK_SUMMON',
          type: 'PROCESSING_CARD',
          role: 'SUMMON_RESULT',
          side: 'SELF',
          inferred: true,
          inference: 'KAGARI_RECOVERY_WITH_YOTO_SEARCH_COMPOUND_SEQUENCE',
          card: { id: 'E02', name: '闪刀姬－篝' }
        });
        parent.signature = `${parent.activationKey}|${parent.details.map(detailToken).join(',')}`;
        break;
      }
    }
    yoto.signature = `${yoto.activationKey}|${yoto.details.map(detailToken).join(',')}`;
    kagari.signature = `${kagari.activationKey}|${kagari.details.map(detailToken).join(',')}`;
  }
  return blocks;
}

function reconcileActivationBlocks(
  previousState,
  blocks,
  capturedAt = new Date().toISOString(),
  orphanDetails = []
) {
  if (previousState && previousState.baseline === 'EMPTY_MAIN1' && !previousState.checkpoint) {
    const hasNew = blocks.length > 0;
    return {
      continuity: hasNew
        ? 'CONTINUOUS_FROM_EMPTY_MAIN1_NEW_BLOCKS'
        : 'CONTINUOUS_FROM_EMPTY_MAIN1_NO_NEW_BLOCK',
      checkpointFound: true,
      matchedAnchor: {
        kind: 'EMPTY_MAIN1_BASELINE',
        cardKey: null,
        source: 'VERIFIED_NEW_DUEL_MAIN1'
      },
      newBlocks: blocks,
      state: hasNew ? {
        version: 1,
        capturedAt,
        checkpoint: checkpointFrom(blocks),
        initialHand: previousState.initialHand || null
      } : previousState
    };
  }
  if (previousState && previousState.baseline === 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM' && !previousState.checkpoint) {
    const hasNew = blocks.length > 0;
    return {
      continuity: hasNew
        ? 'CONTINUOUS_FROM_M11_POST_RESYNC_EMPTY_BOTTOM_NEW_BLOCKS'
        : 'CONTINUOUS_FROM_M11_POST_RESYNC_EMPTY_BOTTOM_NO_NEW_BLOCK',
      checkpointFound: true,
      matchedAnchor: {
        kind: 'M11_POST_FULL_RESYNC_EMPTY_BOTTOM_BASELINE',
        cardKey: null,
        source: 'VERIFIED_M11_POST_FULL_RESYNC_CURRENT_BOTTOM'
      },
      // The M11 full-resync pass already proved that there were no activation
      // blocks at the CURRENT bottom.  Therefore every activation block now
      // visible after that verified empty-bottom baseline is new.
      newBlocks: blocks,
      state: hasNew ? {
        version: 1,
        capturedAt,
        checkpoint: checkpointFrom(blocks)
      } : previousState
    };
  }
  if (!previousState || !previousState.checkpoint) {
    return {
      continuity: 'BASELINE_ESTABLISHED',
      checkpointFound: null,
      matchedAnchor: null,
      newBlocks: [],
      state: { version: 1, capturedAt, checkpoint: checkpointFrom(blocks) }
    };
  }

  const checkpointMatch = findCheckpointMatch(blocks, previousState.checkpoint);
  const index = checkpointMatch.index;
  if (index < 0) {
    const evidenceAnchor = findProcessingEvidenceAnchor(orphanDetails, previousState.checkpoint);
    if (evidenceAnchor) {
      return {
        continuity: blocks.length
          ? 'CONTINUOUS_VIA_PROCESSING_ANCHOR_NEW_BLOCKS'
          : 'CONTINUOUS_VIA_PROCESSING_ANCHOR_NO_NEW_BLOCK',
        checkpointFound: true,
        matchedAnchor: evidenceAnchor,
        newBlocks: blocks,
        state: {
          version: 1,
          capturedAt,
          checkpoint: checkpointFrom(blocks) || previousState.checkpoint
        }
      };
    }
    return {
      continuity: 'GAP_POSSIBLE_PREVIOUS_CHECKPOINT_NOT_VISIBLE',
      checkpointFound: false,
      matchedAnchor: null,
      newBlocks: [],
      // Do not silently advance across an unverified gap.
      state: previousState
    };
  }

  const newBlocks = blocks.slice(index + 1);
  return {
    continuity: newBlocks.length ? 'CONTINUOUS_NEW_BLOCKS' : 'CONTINUOUS_NO_NEW_BLOCK',
    checkpointFound: true,
    matchedAnchor: {
      kind: 'SELF_ACTIVATION',
      cardKey: previousState.checkpoint.activationKey,
      source: 'VISIBLE_OPERATION_BLOCK',
      matchType: checkpointMatch.matchType,
      contextMatched: checkpointMatch.contextMatched
    },
    newBlocks,
    state: {
      version: 1,
      capturedAt,
      checkpoint: checkpointFrom(blocks)
    }
  };
}

// An atomic executor has stronger knowledge than the generic cross-run
// observer: it knows which activation it has just physically completed.  If
// the old checkpoint has already scrolled above the CURRENT bottom viewport,
// one unique occurrence of that explicitly declared activation is a safe new
// transaction boundary.  Never use this with an inferred/arbitrary visible
// key; the caller must supply the executor-owned expected activation.
function reconcileExpectedAtomicBottom(
  previousState,
  blocks,
  expectedActivationKey,
  capturedAt = new Date().toISOString()
) {
  const expected = String(expectedActivationKey || '').trim().toUpperCase();
  if (!expected || !Array.isArray(blocks) || !blocks.length) return null;
  const matching = blocks
    .map((block, index) => ({ block, index }))
    .filter(item => String(item.block && item.block.activationKey || '').toUpperCase() === expected);
  if (matching.length !== 1) return null;

  const index = matching[0].index;
  return {
    continuity: 'CONTINUOUS_EXPLICIT_ATOMIC_BOTTOM_NEW_BLOCKS',
    checkpointFound: true,
    matchedAnchor: {
      kind: 'EXPLICIT_ATOMIC_ACTIVATION',
      cardKey: expected,
      source: 'EXPLICIT_ATOMIC_BOTTOM',
      matchType: 'UNIQUE_EXPECTED_ACTIVATION',
      previousCheckpoint: previousState && previousState.checkpoint
        ? previousState.checkpoint.activationKey || null
        : null
    },
    // Keep the expected activation itself: it is the first operation of the
    // newly completed atom, not the old checkpoint.
    newBlocks: blocks.slice(index),
    state: {
      version: 1,
      capturedAt,
      checkpoint: checkpointFrom(blocks) ||
        (previousState && previousState.checkpoint) || null
    }
  };
}

module.exports = {
  SAME_ACTIVE_CARD_FOLLOW_UP_IDS,
  EQUIP_SPELL_IDS,
  ALLURE_BANISH_IDS,
  activationKey,
  processingRole,
  buildActivationBlocks,
  annotateBlockRelationships,
  checkpointFrom,
  findProcessingEvidenceAnchor,
  findCheckpointMatch,
  findCheckpointIndex,
  normalizeInterposedKagariBambooResults,
  reconcileActivationBlocks,
  reconcileExpectedAtomicBottom
};
