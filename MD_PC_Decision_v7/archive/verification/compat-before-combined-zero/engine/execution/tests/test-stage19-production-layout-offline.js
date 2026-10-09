'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LIVE = path.join(ROOT, 'execution', 'live');

const production = require('../production-entrypoints');
for (const [key, rel] of Object.entries(production.PRODUCTION_ENTRYPOINTS)) {
  const normalized = rel.replace(/\\/g, '/');
  assert.ok(
    normalized.startsWith('execution/live/'),
    `production entry ${key} must use execution/live: ${rel}`
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, rel)),
    `missing production entry: ${rel}`
  );
}

const liveFiles = fs.readdirSync(LIVE, { withFileTypes: true })
  .filter(ent => ent.isFile())
  .map(ent => ent.name);

assert.ok(
  liveFiles.length >= 60,
  `unexpectedly small execution/live set: ${liveFiles.length}`
);

for (const name of liveFiles) {
  if (!/\.(?:js|cmd)$/i.test(name)) continue;
  const text = fs.readFileSync(path.join(LIVE, name), 'utf8');
  assert.ok(
    !text.includes('execution/tests/') &&
    !text.includes('execution\\\\tests\\\\') &&
    !text.includes('execution\\tests\\'),
    `live file still references old production layout: ${name}`
  );
}

const main = fs.readFileSync(
  path.join(ROOT, 'runtime', 'main-v6.js'),
  'utf8'
);
assert.ok(
  main.includes(
    "const legacyPrefix = path.join('execution', 'tests') + path.sep;"
  ),
  'main-v6 must support pre-migration verified-registry paths'
);
assert.ok(
  main.includes(
    "const candidate = path.join('execution', 'live', path.basename(relative));"
  ),
  'main-v6 must remap legacy registry paths to execution/live'
);

// The Stage19 migration launcher is intentionally one-time infrastructure.
// Stage20 archives it after the production layout has been migrated, so this
// regression verifies the resulting layout rather than requiring the retired tool.

console.log('STAGE19_PRODUCTION_LAYOUT_OFFLINE PASS');
