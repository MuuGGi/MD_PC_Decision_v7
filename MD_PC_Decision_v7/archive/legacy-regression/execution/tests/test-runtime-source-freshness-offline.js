'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeSourceFreshnessGuard } = require('../../lib/runtime-source-freshness');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-source-freshness-'));
try {
  const sourcePath = path.join(root, 'loaded-module.js');
  fs.writeFileSync(sourcePath, 'module.exports = 1;\n', 'utf8');
  const guard = createRuntimeSourceFreshnessGuard({ rootDir: root, files: [sourcePath] });
  assert.strictEqual(guard.assertFresh().trackedFiles, 1);

  fs.writeFileSync(sourcePath, 'module.exports = 200;\n', 'utf8');
  assert.throws(
    () => guard.assertFresh(),
    error => error &&
      error.code === 'V6_RUNTIME_SOURCE_CHANGED_RESTART_REQUIRED' &&
      error.changedFiles.includes('loaded-module.js')
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('RUNTIME_SOURCE_FRESHNESS_OFFLINE_PASS');
