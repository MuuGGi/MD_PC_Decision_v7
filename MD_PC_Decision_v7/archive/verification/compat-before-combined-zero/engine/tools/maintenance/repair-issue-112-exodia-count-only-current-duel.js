'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  readJson,
  writeJsonAtomic,
  readBufferIfExists,
  restoreBuffer
} = require('../../lib/runtime-files');
const {
  commitIncrementalObserverResult,
  PENDING_OBSERVER_PATH
} = require('../../lib/incremental-observer-transaction');
const { normalizeExodiaComponentCard } = require('../../lib/exodia-policy');
const { checkpointFrom } = require('../../lib/duel-log-state');
const { compactTailBlocks } = require('../../lib/duel-log-tail-continuity');

const ROOT = path.resolve(__dirname, '../..');
const HAND_PATH = path.join(ROOT, 'debug/hand-change-live/session_state.json');
const LEDGER_PATH = path.join(ROOT, 'debug/main-deck-ledger/state.json');
const RESULT_PATH = path.join(ROOT, 'debug/hand-change-live/latest_incremental_result.json');
const DECISION_PATH = path.join(ROOT, 'decision-state.json');
const LOG_STATE_PATH = path.join(ROOT, 'debug/duel-log-live/observer_state.json');
const REPORT_PATH = path.join(ROOT, 'debug/issue-112-exodia-count-only/repair-report.json');
const FIXTURE_DIR = path.join(ROOT, 'material/issues');

const managedPaths = [
  HAND_PATH,
  LEDGER_PATH,
  RESULT_PATH,
  DECISION_PATH,
  LOG_STATE_PATH,
  PENDING_OBSERVER_PATH,
  REPORT_PATH
];

function fixture(name) {
  return readJson(path.join(FIXTURE_DIR, name));
}

function same(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, `${label}_CHANGED_SINCE_ISSUE_112_CAPTURE`);
}

function main() {
  const snapshots = new Map(managedPaths.map(file => [file, readBufferIfExists(file)]));
  try {
    const hand = readJson(HAND_PATH);
    const ledger = readJson(LEDGER_PATH);
    const decision = readJson(DECISION_PATH);
    const pending = readJson(PENDING_OBSERVER_PATH);
    const log = fixture('issue-112-m09-log.json');

    same(hand, fixture('issue-112-hand-before.json'), 'HAND');
    same(ledger, fixture('issue-112-ledger-before.json'), 'LEDGER');
    same(decision, fixture('issue-112-decision-before.json'), 'DECISION');
    same(pending, fixture('issue-112-pending-before.json'), 'PENDING');
    same(pending.log, log, 'PENDING_LOG');

    assert.strictEqual(pending.status, 'OBSERVATION_FAILED');
    assert.strictEqual(pending.activationKey, 'M09');
    assert.strictEqual(pending.slot, 2);
    assert.strictEqual(pending.error, 'NEW_HAND_IDENTITY_UNRESOLVED_NO_CLICK:1');
    assert.deepStrictEqual(hand.cards.map(card => card.id), ['M06', 'M09', 'M11', 'M14', 'M21']);
    assert.strictEqual(hand.revision, 4);
    assert.strictEqual(ledger.lastHandRevision, 4);
    assert.strictEqual(ledger.unknownExodiaOutsideCount, undefined);
    assert.strictEqual(decision.usedCounts.M09, undefined);

    const block = (log.newOperationBlocks || []).find(item => item.activationKey === 'M09');
    assert.ok(block, 'ISSUE_112_M09_BLOCK_REQUIRED');
    const gain = (block.details || []).find(item => item.role === 'HAND_GAIN_CANDIDATE');
    assert.ok(gain, 'ISSUE_112_M09_GAIN_REQUIRED');
    const componentCandidates = (gain.top3 || []).map(item => item.id)
      .filter(id => ['M01', 'M02', 'M03', 'M04', 'M05'].includes(id));
    assert.ok(componentCandidates.length >= 2, 'ISSUE_112_COMPONENT_CLASS_EVIDENCE_REQUIRED');

    const component = normalizeExodiaComponentCard(
      { id: componentCandidates[0], name: gain.card && gain.card.name },
      ['M01', 'M02', 'M03', 'M04', 'M05']
    );
    const now = new Date().toISOString();
    const remaining = hand.cards.filter(card => card.id !== 'M09');
    assert.strictEqual(remaining.length, 4);
    const cards = [component, ...remaining].map((card, index) => ({ ...card, index: index + 1 }));
    const after = {
      ...hand,
      capturedAt: now,
      revision: 5,
      handCount: 5,
      cards,
      handImagePath: path.join(ROOT, 'material/issues/issue-112-exodia-count-only.png'),
      source: 'ISSUE_112_SAVED_SCREENSHOT_AND_RIGHT_LOG_CLASS_EVIDENCE',
      lastOperation: {
        activationKey: 'M09',
        signature: block.signature,
        activationOccurrence: 1
      },
      lastIncremental: {
        consumed: hand.cards.find(card => card.id === 'M09'),
        costConsumed: [],
        predictedSlots: [1],
        recognized: [component],
        finalClicks: [{
          slot: 1,
          id: component.id,
          name: component.name,
          source: 'EXODIA_COMPONENT_CLASS_NO_CLICK',
          physicalClicksIssued: 0
        }]
      }
    };
    const incremental = {
      status: 'PASS',
      mode: 'HAND_INCREMENTAL_SAVED_EVIDENCE_REPAIR',
      reason: 'ISSUE_112_EXODIA_COMPONENT_COUNT_ONLY',
      before: hand,
      after,
      inference: {
        activationKey: 'M09',
        consumed: hand.cards.find(card => card.id === 'M09'),
        costConsumed: [],
        remaining,
        predictedSlots: [1],
        candidateRows: [gain],
        identityPolicy: 'EXODIA_COMPONENT_CLASS_ONLY'
      },
      insertedCards: [{ slot: 1, card: component }],
      finalClicks: after.lastIncremental.finalClicks,
      recognitionTimings: [],
      savedEvidenceOnly: true,
      gameInputsIssued: 0,
      repairedAt: now
    };

    commitIncrementalObserverResult({
      incrementalResult: incremental,
      log,
      statePath: HAND_PATH,
      resultPath: RESULT_PATH
    });

    const decisionAfter = {
      ...decision,
      graveSpellCount: Number(decision.graveSpellCount || 0) + 1,
      usedCounts: {
        ...(decision.usedCounts || {}),
        M09: Number(decision.usedCounts && decision.usedCounts.M09 || 0) + 1
      },
      lastIssue112Accounting: {
        repairedAt: now,
        activationKey: 'M09',
        beforeRevision: 4,
        afterRevision: 5,
        componentCountAdded: 1,
        exactComponentIdentityUsed: false
      }
    };
    writeJsonAtomic(DECISION_PATH, decisionAfter, { trailingNewline: true });

    const blocks = log.operationBlocks || [];
    assert.ok(blocks.length && blocks[blocks.length - 1].activationKey === 'M09');
    writeJsonAtomic(LOG_STATE_PATH, {
      version: 1,
      capturedAt: now,
      checkpoint: checkpointFrom(blocks),
      tailBlocks: compactTailBlocks(blocks, 6)
    }, { trailingNewline: true });

    fs.unlinkSync(PENDING_OBSERVER_PATH);

    const ledgerAfter = readJson(LEDGER_PATH);
    assert.strictEqual(ledgerAfter.lastHandRevision, 5);
    assert.strictEqual(ledgerAfter.unknownExodiaOutsideCount, 1);
    assert.deepStrictEqual(
      ['M01', 'M02', 'M03', 'M04', 'M05'].map(id => ledgerAfter.outsideDeckCounts[id]),
      [0, 0, 0, 0, 0]
    );
    assert.deepStrictEqual(readJson(HAND_PATH).cards.map(card => card.id),
      ['EXODIA_UNKNOWN', 'M06', 'M11', 'M14', 'M21']);

    const report = {
      status: 'PASS',
      issue: 'ISSUE-112',
      repairedAt: now,
      beforeRevision: 4,
      afterRevision: 5,
      handIds: readJson(HAND_PATH).cards.map(card => card.id),
      unknownExodiaOutsideCount: ledgerAfter.unknownExodiaOutsideCount,
      exactComponentIdentityUsed: false,
      physicalGameInputsIssued: 0,
      pendingObserverTransactionRemoved: !fs.existsSync(PENDING_OBSERVER_PATH),
      observerCheckpoint: readJson(LOG_STATE_PATH).checkpoint
    };
    writeJsonAtomic(REPORT_PATH, report, { trailingNewline: true });
    console.log('ISSUE_112_CURRENT_DUEL_REPAIR_PASS; revision4->5; EXODIA_UNKNOWN=1; M09 used; clicks0');
  } catch (error) {
    for (const file of managedPaths) restoreBuffer(file, snapshots.get(file));
    throw error;
  }
}

main();
