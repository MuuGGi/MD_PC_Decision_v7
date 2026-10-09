'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resetCompositeRouteSession
} = require('../../lib/duel-session-reset');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-duel-session-reset-'));
try {
  const compositeDir = path.join(testRoot, 'debug', 'composite-route-live');
  fs.mkdirSync(compositeDir, { recursive: true });
  const sessionPath = path.join(compositeDir, 'session_state.json');
  const resultPath = path.join(compositeDir, 'latest_result.json');
  const evidencePath = path.join(compositeDir, 'issue-075-preserved-evidence.json');
  fs.writeFileSync(sessionPath, '{"revision":129}\n', 'utf8');
  fs.writeFileSync(resultPath, '{"status":"STALE"}\n', 'utf8');
  fs.writeFileSync(evidencePath, '{"preserve":true}\n', 'utf8');

  const first = resetCompositeRouteSession(testRoot);
  assert.strictEqual(first.removed.length, 2);
  assert.strictEqual(fs.existsSync(sessionPath), false);
  assert.strictEqual(fs.existsSync(resultPath), false);
  assert.strictEqual(fs.existsSync(evidencePath), true, 'archived evidence must remain untouched');

  const second = resetCompositeRouteSession(testRoot);
  assert.strictEqual(second.removed.length, 0, 'repeated new-duel reset must be idempotent');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log('NEW_DUEL_COMPOSITE_RESET_OFFLINE_PASS');
