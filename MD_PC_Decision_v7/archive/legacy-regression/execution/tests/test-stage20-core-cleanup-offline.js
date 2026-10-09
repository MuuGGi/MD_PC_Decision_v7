'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'execution', 'core');
const LIVE = path.join(ROOT, 'execution', 'live');
const TESTS = path.join(ROOT, 'execution', 'tests');

for (const name of [
  'atomic-route-executor.js',
  'branch-adjacent-observer.js',
  'executor-preload.js'
]) {
  assert.ok(fs.existsSync(path.join(CORE, name)), `missing canonical core: ${name}`);
}

const main = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
assert.ok(main.includes("'atomic-route-executor'"));
assert.ok(main.includes("'executor-preload.js'"));
assert.ok(!main.includes("'v5-hornet-route-executor'"));
assert.ok(!main.includes("'v5-executor-preload.js'"));

const atomic = fs.readFileSync(path.join(CORE, 'atomic-route-executor.js'), 'utf8');
assert.ok(atomic.includes("'branch-adjacent-observer'"));
assert.ok(!atomic.includes("'v5-branch-adjacent-observer'"));

const liveFiles = fs.readdirSync(LIVE, { withFileTypes: true })
  .filter(ent => ent.isFile() && ent.name.endsWith('.js'))
  .map(ent => ent.name);

const badWritebacks = [];
for (const name of liveFiles) {
  const source = fs.readFileSync(path.join(LIVE, name), 'utf8');
  if (
    source.includes('execution/tests/') ||
    source.includes('execution\\\\tests\\\\')
  ) {
    badWritebacks.push(name);
  }
}
assert.deepStrictEqual(
  badWritebacks,
  [],
  `live executor still contains legacy execution/tests path: ${badWritebacks.join(',')}`
);

const nonOfflineTests = fs.readdirSync(TESTS, { withFileTypes: true })
  .filter(ent => ent.isFile() && !ent.name.startsWith('test-'))
  .map(ent => ent.name);
assert.deepStrictEqual(
  nonOfflineTests,
  [],
  `execution/tests must be offline-only: ${nonOfflineTests.join(',')}`
);


console.log('STAGE20_CORE_CLEANUP_OFFLINE PASS');
