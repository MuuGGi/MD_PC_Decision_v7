'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const moved = [
  'capture-hand-scroll-segments-live.js',
  'observe-hand-change-incremental-live.js',
  'run-duel-observer.js',
  'run-live-incremental.js',
  'run-opening-observer-fast.js',
  'run-prepared-baseline-flex.js',
  'scan-state.js',
  'test-duel-log-live.js',
  'test-hand-info-live.js',
  'test-scan-state-live.js'
];

for (const name of moved) {
  const p = path.join(ROOT, 'runtime', 'observer', name);
  assert.ok(fs.existsSync(p), `missing runtime observer: ${name}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(
    !src.includes("require('./lib/") && !src.includes('require("./lib/'),
    `${name} still has old root-relative lib require`
  );
}

assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'reset-duel-state.js')));
assert.ok(fs.existsSync(path.join(ROOT, 'runtime', 'observer-entrypoints.js')));
assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'organize-v6-workspace.js')));
assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'launchers', 'organize-v6-workspace.cmd')));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.strictEqual(pkg.scripts.observer, 'node runtime/observer/run-duel-observer.js');
assert.strictEqual(pkg.scripts['observer:new'], 'node runtime/observer/run-duel-observer.js --new');

const cmd = fs.readFileSync(path.join(ROOT, 'tools', 'launchers', 'run-duel-observer.cmd'), 'utf8');
assert.ok(cmd.includes('runtime\\observer\\run-duel-observer.js'));

const runV5 = fs.readFileSync(path.join(ROOT, 'runtime', 'main-v6.js'), 'utf8');
assert.ok(runV5.includes('runtime/observer/run-live-incremental.js'));
assert.ok(runV5.includes('runtime/observer/test-duel-log-live.js'));


const organizerSource = fs.readFileSync(
  path.join(ROOT, 'tools', 'organize-v6-workspace.js'),
  'utf8'
);
assert.ok(
  !organizerSource.includes('.map(path.resolve)'),
  'organizer must not pass path.resolve directly to Array.map'
);
assert.ok(
  organizerSource.includes('.map(dir => path.resolve(dir))'),
  'organizer dense capture resolver must use a unary callback'
);


assert.ok(
  organizerSource.includes("const candidates = ['cases', 'ui-semantic'];"),
  'organizer must triage materials/cases and materials/ui-semantic'
);
assert.ok(
  organizerSource.includes("kind: 'KEEP_RECENT_NONPASS'"),
  'organizer must retain the two most recent non-pass execution runs per group'
);
assert.ok(
  organizerSource.includes('GENERIC_PASS_RX'),
  'organizer must detect structured PASS/SUCCESS result evidence'
);
assert.ok(
  organizerSource.includes("path.join(ARCHIVE_ROOT, 'materials-legacy', row.name)"),
  'unreferenced legacy materials must go to archive, never be deleted'
);


assert.ok(
  organizerSource.includes("PASS_REPRESENTATIVES_PER_GROUP = 1"),
  'organizer must promote only one representative successful run per execution group'
);
assert.ok(
  organizerSource.includes("RECENT_NONPASS_PER_GROUP = 2"),
  'organizer must retain two recent non-pass runs per execution group'
);
assert.ok(
  organizerSource.includes("kind: 'ARCHIVE_PASS_HISTORY'"),
  'older successful runs must be archived rather than promoted en masse'
);
assert.ok(
  organizerSource.includes("const MATERIALS_RESEARCH_DIRS = new Set"),
  'legacy hand calibration must be promoted to durable research'
);
assert.ok(
  organizerSource.includes("function handLayoutLegacyPlan()"),
  'non-dense hand-layout captures must be independently triaged'
);

console.log('STAGE16_SAFE_LAYOUT_OFFLINE PASS');
