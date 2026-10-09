'use strict';

// One-shot, evidence-locked recovery for the 2026-09-27 live duel where M13
// fully resolved (draw M15 + M21, banish M06) but the old bottom-only observer
// rolled every state file back to revision 8. This script never connects to or
// clicks Master Duel. It refuses any state other than the recorded incident.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../lib/runtime-files');
const { checkpointFrom } = require('../../lib/duel-log-state');
const { compactTailBlocks } = require('../../lib/duel-log-tail-continuity');
const { applyIncrementalResultToMainDeckLedger } = require('../../lib/main-deck-ledger');

const ROOT = path.resolve(__dirname, '..', '..');
const HAND = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const INCREMENTAL = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const LEDGER = path.join(ROOT, 'debug', 'main-deck-ledger', 'state.json');
const OBSERVER = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const LOG = path.join(ROOT, 'debug', 'duel-log-live', 'latest_result.json');
const DECISION = path.join(ROOT, 'decision-state.json');
const ATTEMPT = path.join(
  ROOT,
  'debug',
  'execution',
  'M13_allure_of_darkness',
  '2026-09-27T08-41-40-624Z',
  'issue-078-state-repair'
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ids(cards) {
  return (cards || []).map(card => String(card && card.id || ''));
}

function exact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}:${JSON.stringify(actual)};expected=${JSON.stringify(expected)}`);
  }
}

function card(id, name, index) {
  return { id, name, rightLogCertain: true, candidateIds: [id], index };
}

function detail(id, name, rawType, role) {
  return {
    type: 'PROCESSING_CARD',
    side: 'SELF',
    card: { id, name },
    rawType,
    role
  };
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  fs.copyFileSync(file, path.join(ATTEMPT, path.basename(file)));
}

function main() {
  if (!process.argv.includes('--apply')) {
    throw new Error('ISSUE_078_REPAIR_REQUIRES_EXPLICIT_APPLY');
  }
  if (process.versions.node !== '20.11.1') {
    throw new Error(`NODE_RUNTIME_MISMATCH:${process.versions.node};expected=20.11.1`);
  }

  const before = readJson(HAND);
  const ledgerBefore = readJson(LEDGER);
  const decisionBefore = readJson(DECISION);
  exact(Number(before.revision), 8, 'ISSUE_078_HAND_REVISION_MISMATCH');
  exact(Number(ledgerBefore.lastHandRevision), 8, 'ISSUE_078_LEDGER_REVISION_MISMATCH');
  exact(
    ids(before.cards),
    ['M03', 'M06', 'M07', 'M08', 'M08', 'M13'],
    'ISSUE_078_PRE_HAND_MISMATCH'
  );
  if (Number(decisionBefore.usedCounts && decisionBefore.usedCounts.M13 || 0) !== 0) {
    throw new Error('ISSUE_078_M13_ALREADY_ACCOUNTED');
  }

  fs.mkdirSync(ATTEMPT, { recursive: true });
  for (const file of [HAND, INCREMENTAL, LEDGER, OBSERVER, LOG, DECISION]) backup(file);

  const m13 = card('M13', '暗之诱惑', 6);
  const m06 = card('M06', '闪刀姬－零衣', 2);
  const m15 = card('M15', '无之炼狱', 5);
  const m21 = card('M21', '试胆竞速', 6);
  const finalCards = [
    card('M03', '被封印的右腕', 1),
    card('M07', '青眼卡通龙', 2),
    card('M08', '闪术兵器－H.A.M.P.', 3),
    card('M08', '闪术兵器－H.A.M.P.', 4),
    m15,
    m21
  ];
  const block = {
    activation: { type: 'ACTIVATE', side: 'SELF', card: { id: 'M13', name: '暗之诱惑' } },
    activationKey: 'M13',
    details: [
      detail('M21', '试胆竞速', 'HAND_GAIN', 'HAND_GAIN_CANDIDATE'),
      detail('M15', '无之炼狱', 'HAND_GAIN', 'HAND_GAIN_CANDIDATE'),
      detail('M06', '闪刀姬－零衣', 'BANISH_SELECTION', 'FIELD_PROCESSING'),
      detail('M06', '闪刀姬－零衣', 'BANISH_FROM_HAND', 'HAND_BANISH_COST')
    ],
    signature: 'M13|PROCESSING_CARD:M21,PROCESSING_CARD:M15,PROCESSING_CARD:M06,PROCESSING_CARD:M06',
    relationship: { type: 'INDEPENDENT_OR_ORIGIN_NOT_VISIBLE', parentActivationKey: null, evidenceCard: null }
  };
  const capturedAt = new Date().toISOString();
  const after = {
    version: 2,
    capturedAt,
    revision: 9,
    handCount: 6,
    cards: finalCards,
    handImagePath: path.join(ROOT, 'debug', 'duel-log-live', 'latest_client.png'),
    lastOperation: {
      activationKey: 'M13',
      signature: block.signature,
      activationOccurrence: 1
    },
    lastIncremental: {
      consumed: m13,
      costConsumed: [m06],
      predictedSlots: [5, 6],
      recognized: [m15, m21].map(({ index, ...item }) => item),
      finalClicks: [
        { slot: 5, id: 'M15', name: '无之炼狱', source: 'RIGHT_LOG_EXACT_NO_CLICK', physicalClicksIssued: 0 },
        { slot: 6, id: 'M21', name: '试胆竞速', source: 'RIGHT_LOG_EXACT_NO_CLICK', physicalClicksIssued: 0 }
      ]
    }
  };
  const incremental = {
    status: 'PASS',
    recovery: 'ISSUE_078_OFFLINE_CURRENT_FRAME_AND_RIGHT_LOG_PROOF',
    before,
    after,
    inference: {
      activationKey: 'M13',
      consumed: m13,
      costConsumed: [m06],
      addedCount: 2,
      predictedSlots: [5, 6]
    },
    insertedCards: [
      { slot: 5, card: { id: 'M15', name: '无之炼狱', rightLogCertain: true, candidateIds: ['M15'] } },
      { slot: 6, card: { id: 'M21', name: '试胆竞速', rightLogCertain: true, candidateIds: ['M21'] } }
    ],
    finalClicks: after.lastIncremental.finalClicks,
    evidence: {
      screenshot: path.join(ROOT, 'debug', 'duel-log-live', 'latest_client.png'),
      recognizedBlockSignature: block.signature,
      physicalHandIds: ids(finalCards),
      gameInputIssued: 0
    }
  };
  const log = {
    status: 'OK_MAIN1_SCROLLED_OUT',
    recovery: 'ISSUE_078_OFFLINE_CURRENT_FRAME_RECOGNITION',
    operationBlocks: [block],
    activationBlocks: [block],
    newActivationBlocks: [block],
    newOperationBlocks: [block],
    extendedOperationBlocks: [],
    continuity: 'CONTINUOUS_EXPLICIT_ATOMIC_BOTTOM_NEW_BLOCKS',
    previousCheckpointFound: true,
    matchedContinuityAnchor: {
      kind: 'EXPLICIT_ATOMIC_ACTIVATION',
      cardKey: 'M13',
      source: 'EXPLICIT_ATOMIC_BOTTOM',
      matchType: 'UNIQUE_EXPECTED_ACTIVATION',
      previousCheckpoint: 'M17'
    },
    scrollBacktracking: { performed: false, upwardSteps: 0, totalUpwardWheelEvents: 0 },
    screenshot: path.join(ROOT, 'debug', 'duel-log-live', 'latest_client.png')
  };
  const observer = {
    version: 1,
    capturedAt,
    checkpoint: checkpointFrom([block]),
    tailBlocks: compactTailBlocks([block], 6),
    recovery: 'ISSUE_078_CURRENT_M13_RESOLUTION'
  };

  writeJsonAtomic(INCREMENTAL, incremental, { trailingNewline: true });
  applyIncrementalResultToMainDeckLedger({ incrementalResult: incremental, log });
  writeJsonAtomic(HAND, after, { trailingNewline: true });
  writeJsonAtomic(LOG, log, { trailingNewline: true });
  writeJsonAtomic(OBSERVER, observer, { trailingNewline: true });

  const decision = readJson(DECISION);
  decision.usedCounts = { ...(decision.usedCounts || {}) };
  decision.usedCounts.M13 = Number(decision.usedCounts.M13 || 0) + 1;
  decision.usedCounts.M06 = Number(decision.usedCounts.M06 || 0) + 1;
  decision.graveSpellCount = Number(decision.graveSpellCount || 0) + 1;
  decision.lastRecovery = {
    issue: 'ISSUE-078',
    activationKey: 'M13',
    drawn: ['M15', 'M21'],
    banished: 'M06',
    repairedAt: capturedAt,
    gameInputIssued: 0
  };
  writeJsonAtomic(DECISION, decision, { trailingNewline: true });

  const ledgerAfter = readJson(LEDGER);
  exact(Number(ledgerAfter.lastHandRevision), 9, 'ISSUE_078_LEDGER_COMMIT_FAILED');
  exact(ids(readJson(HAND).cards), ids(finalCards), 'ISSUE_078_POST_HAND_MISMATCH');
  console.log('ISSUE_078_CURRENT_DUEL_REPAIR_PASS');
  console.log(`hand revision=9; cards=${ids(finalCards).join(',')}`);
  console.log('M13 resolved; M06 banished; M15+M21 drawn; game input=0');
  console.log(`backup=${ATTEMPT}`);
}

main();
