'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { alignCommittedObserverBaseline } = require('../../../engine/execution/core/observer-current-baseline');
const { createDecisionContext } = require('../../../src/strategy/decision-context');
const { loadSnapshot } = require('../../../src/core/snapshot');
const { hashValue } = require('../../../src/core/json-store');
const library = require('../../../engine/card-library.json');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const ROOT = path.resolve(__dirname, '../../..');
const runDir = path.join(ROOT, 'archive/autotest/runs/2026-10-08T09-34-55-750Z');
let cases = 0;
async function run() {
  await withStrictReadOnly(async () => {
    for (let n = 1; n <= 5; n++) {
      const saved = path.join(runDir, 'game-' + String(n).padStart(5, '0'), 'completed');
      const scan = JSON.parse(fs.readFileSync(path.join(saved, 'debug/scan-state-live/prepared/result.json')));
      const committed = JSON.parse(fs.readFileSync(path.join(saved, 'debug/hand-change-live/session_state.json')));
      const snapshot = loadSnapshot(saved), start = Date.parse(scan.info.capturedAt);
      snapshot.library = { status: 'KNOWN', data: library, hash: hashValue(library) };
      assert.equal(scan.revision, undefined, 'reproduce original unversioned scanner response');
      assert.throws(() => createDecisionContext(snapshot, scan), /HAND_NOT_SNAPSHOT_HAND/); cases++;
      const aligned = alignCommittedObserverBaseline(scan, committed, start);
      assert.equal(aligned.revision, 0); assert.equal(aligned.observerBaselineCommitted, true);
      assert.deepEqual(aligned.cards, committed.cards);
      assert.equal(createDecisionContext(snapshot, aligned).hand.revision, committed.revision); cases++;
      for (const mutate of [s => { delete s.revision; }, s => { s.revision = -1; },
        s => { s.cards[0].id = 'UNKNOWN'; }, s => { s.cards.reverse(); },
        s => { s.handCount--; }, s => { s.capturedAt = new Date(start - 1).toISOString(); },
        s => { s.source = path.join(ROOT, 'unrelated-result.json'); }]) {
        const value = structuredClone(committed); mutate(value);
        assert.throws(() => alignCommittedObserverBaseline(scan, value, start), /COMMITTED_BASELINE_NOT_ALIGNED/); cases++;
      }
      assert.throws(() => createDecisionContext(snapshot, { ...aligned, revision: 1 }), /HAND_NOT_SNAPSHOT/); cases++;
    }
  });
  console.log('V7_OBSERVER_BASELINE_COMMIT_PASS; cases=' + cases + '; five real initial failures; guard retained; inputs=0/businessWrites=0');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
