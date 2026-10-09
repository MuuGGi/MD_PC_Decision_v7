'use strict';
const assert = require('assert');
const { describeTerminalHandObservation } = require('../tools/report-v7-run');
const game = { outcome: 'SURRENDER', startedAt: '2026-10-07T11:22:00Z', endedAt: '2026-10-07T11:25:00Z',
  resultProof: { stage: 'COMPLETE_SURRENDER', executionId: 'test-execution',
    baseline: { capturedAt: '2026-10-07T11:24:00Z' },
    failureProof: { status: 'NO_DARK_ENTIRE_HAND_SENT_TO_GY', info: {
      capturedAt: '2026-10-07T11:24:25Z', status: 'OK', sideValidation: 'OK',
      own: { status: 'OK', handCount: 0 }, expected: { own: 0 }, stableReads: 2, failSafeTriggered: false } },
    result: { status: 'TERMINAL_SURRENDER', failureProof: { status: 'NO_DARK_ENTIRE_HAND_SENT_TO_GY' } } } };
const hand = { revision: 9, handCount: 5, cards: [{ id: 'M13' }] };
const original = JSON.stringify({ game, hand });
const result = describeTerminalHandObservation(game, hand);
assert.strictEqual(result.count, 0);
assert.deepStrictEqual(result.cards, []);
assert.strictEqual(result.ordinaryObserverCommitted, false);
assert.strictEqual(result.lastCommittedRevision, 9);
assert.strictEqual(JSON.stringify({ game, hand }), original);
let cases = 1;
for (const mutate of [
  g => { g.outcome = 'WIN'; },
  g => { g.resultProof.stage = 'IN_PROGRESS'; },
  g => { g.resultProof.executionId = ''; },
  g => { g.resultProof.result.status = 'PASS'; },
  g => { g.resultProof.failureProof.status = 'UNKNOWN'; },
  g => { g.resultProof.result.failureProof.status = 'UNKNOWN'; },
  g => { g.resultProof.failureProof.info.status = 'UNKNOWN'; },
  g => { g.resultProof.failureProof.info.sideValidation = 'UNKNOWN'; },
  g => { g.resultProof.failureProof.info.own.handCount = 1; },
  g => { g.resultProof.failureProof.info.expected.own = 1; },
  g => { g.resultProof.failureProof.info.stableReads = 1; },
  g => { g.resultProof.failureProof.info.failSafeTriggered = true; },
  g => { g.resultProof.failureProof.info.capturedAt = '2026-10-07T11:23:00Z'; },
  g => { g.resultProof.failureProof.info.capturedAt = '2026-10-07T11:26:00Z'; },
  g => { g.resultProof.failureProof.info.capturedAt = 'invalid'; }
]) {
  const candidate = JSON.parse(JSON.stringify(game)); mutate(candidate);
  assert.strictEqual(describeTerminalHandObservation(candidate, hand), null); cases++;
}
assert.strictEqual(describeTerminalHandObservation({}, null), null); cases++;
console.log('V7_TERMINAL_HAND_REPORT_PASS; cases=' + cases);
