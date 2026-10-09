'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const movedTargets = {
  'scan-state': 'runtime/observer/scan-state.js',
  'capture-hand-scroll-segments-live': 'runtime/observer/capture-hand-scroll-segments-live.js',
  'test-duel-log-live': 'runtime/observer/test-duel-log-live.js',
  'test-scan-state-live': 'runtime/observer/test-scan-state-live.js',
  'test-hand-info-live': 'runtime/observer/test-hand-info-live.js',
  'run-live-incremental': 'runtime/observer/run-live-incremental.js',
  'run-opening-observer-fast': 'runtime/observer/run-opening-observer-fast.js',
  'run-prepared-baseline-flex': 'runtime/observer/run-prepared-baseline-flex.js',
  'observe-hand-change-incremental-live': 'runtime/observer/observe-hand-change-incremental-live.js',
  'reset-duel-state': 'tools/reset-duel-state.js'
};

for (const rel of Object.values(movedTargets)) {
  assert.ok(
    fs.existsSync(path.join(ROOT, ...rel.split('/'))),
    `missing migrated runtime target: ${rel}`
  );
}

const forbidden = [
  /path\.join\(ROOT,\s*['"]scan-state(?:\.js)?['"]\)/,
  /path\.join\(ROOT,\s*['"]capture-hand-scroll-segments-live(?:\.js)?['"]\)/,
  /path\.join\(ROOT,\s*['"]test-duel-log-live(?:\.js)?['"]\)/,
  /path\.join\(ROOT,\s*['"]test-scan-state-live(?:\.js)?['"]\)/,
  /require\(\s*['"]\.\.\/\.\.\/scan-state(?:\.js)?['"]\s*\)/
];

const scanRoots = [
  path.join(ROOT, 'execution'),
  path.join(ROOT, 'lib')
];

const bad = [];
for (const base of scanRoots) {
  const stack = [base];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!ent.isFile() || path.extname(ent.name).toLowerCase() !== '.js') continue;
      if (p === __filename) continue;

      const text = fs.readFileSync(p, 'utf8');
      for (const rx of forbidden) {
        if (rx.test(text)) {
          bad.push(`${path.relative(ROOT, p)} :: ${rx}`);
        }
      }
    }
  }
}

assert.deepStrictEqual(
  bad,
  [],
  `stale root runtime imports remain:\n${bad.join('\n')}`
);

console.log('STAGE17_RUNTIME_PATH_MIGRATION_OFFLINE PASS');
