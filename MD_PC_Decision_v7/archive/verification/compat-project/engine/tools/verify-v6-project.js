'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_NODE = '20.11.1';
const args = new Set(process.argv.slice(2));
const WITH_STATE = args.has('--state');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'archive' || ent.name === 'node_modules' ||
            ent.name === 'debug' || ent.name === 'material' ||
            ent.name === 'materials' || ent.name === 'templates') {
          continue;
        }
        stack.push(p);
      } else if (ent.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
}

function runNode(args, label) {
  const out = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  if (out.status !== 0) {
    throw new Error(`${label}: exit=${out.status}`);
  }
}

if (String(process.versions.node || '') !== REQUIRED_NODE) {
  throw new Error(
    `NODE_VERSION_MISMATCH:${process.versions.node || 'UNKNOWN'}; expected ${REQUIRED_NODE}`
  );
}

const required = [
  'run-v6.cmd',
  'runtime/main-v6.js',
  'runtime/observer/run-duel-observer.js',
  'runtime/observer/run-live-incremental.js',
  'lib/decision-engine.js',
  'execution/production-entrypoints.js',
  'material/verified/verified-cards.json'
];

for (const rel of required) {
  const full = path.join(ROOT, ...rel.split('/'));
  if (!fs.existsSync(full)) throw new Error(`REQUIRED_PATH_MISSING:${rel}`);
}

const activeJs = walk(ROOT)
  .filter(p => path.extname(p).toLowerCase() === '.js')
  .sort();

for (const file of activeJs) {
  const out = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (out.status !== 0) {
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    throw new Error(`NODE_CHECK_FAIL:${path.relative(ROOT, file)}`);
  }
}
console.log(`ACTIVE_JS_SYNTAX PASS (${activeJs.length} files)`);

const regressions = [
  'execution/tests/test-stage15-batch-offline.js',
  'execution/tests/test-stage16-safe-layout-offline.js',
  'execution/tests/test-stage17-runtime-path-migration-offline.js',
  'execution/tests/test-stage18-v6-entry-layout-offline.js',
  'execution/tests/test-stage19-production-layout-offline.js',
  'execution/tests/test-stage20-core-cleanup-offline.js',
  'execution/tests/test-stage21-root-cleanup-offline.js',
  'execution/tests/test-toon-table-mallet-restart-offline.js',
  'execution/tests/test-mallet-other-resources-first-offline.js',
  'execution/tests/test-trade-in-cost-policy-offline.js',
  'execution/tests/test-bamboo-search-policy-offline.js',
  'execution/tests/test-mallet-completion-offline.js',
  'execution/tests/test-exodia-right-log-no-click-offline.js',
  'execution/tests/test-m21-stage-and-no-new-click-offline.js',
  'execution/tests/test-incremental-observer-transaction-offline.js',
  'execution/tests/test-hornet-special-summon-label-offline.js',
  'execution/tests/test-last-equipped-yoto-guard-offline.js',
  'execution/tests/test-bamboo-continuation-plan-offline.js',
  'execution/tests/test-first-true-golden-priority-offline.js',
  'execution/tests/test-deferred-golden-current-resume-offline.js',
  'execution/tests/test-yoto-repeat-search-offline.js',
  'execution/tests/test-deferred-yoto-deadlock-offline.js',
  'execution/tests/test-new-duel-composite-reset-offline.js',
  'execution/tests/test-y3-bottom-only-observer-offline.js',
  'execution/tests/test-explicit-atomic-bottom-boundary-offline.js',
  'execution/tests/test-y1-resolution-proof-offline.js',
  'execution/tests/test-runtime-source-freshness-offline.js',
  'execution/tests/test-engage-target-priority-offline.js',
  'execution/tests/test-raye-e10-spare-observer-offline.js',
  'execution/tests/test-raye-double-link-engage-recovery-offline.js',
  'execution/tests/test-exodia-count-only-offline.js',
  'execution/tests/test-mallet-component-protection-offline.js',
  'execution/tests/test-component-identity-boundaries-offline.js',
  'execution/tests/test-shared-component-count-offline.js',
  'execution/tests/test-exodia-incremental-slot-order-offline.js',
  'execution/tests/test-allure-policy-offline.js',
  'execution/tests/test-allure-last-resort-offline.js',
  'execution/tests/test-m13-draw-banish-observer-offline.js',
  'execution/tests/test-strategic-deadlock-offline.js',
  'execution/tests/test-deadlock-one-key-offline.js',
  'execution/tests/test-search-before-allure-offline.js',
  'execution/tests/test-simple-draw-continuation-offline.js',
  'execution/tests/test-simple-action-priority-offline.js',
  'execution/tests/test-issue-079-priority-boundaries-offline.js',
  'execution/tests/test-duel-log-fast-path-offline.js',
  'execution/tests/test-deadlock-surrender-offline.js',
  'execution/tests/test-duel-result-confirm-offline.js',
  'execution/tests/test-duel-settlement-offline.js',
  'execution/tests/test-post-duel-victory-offline.js',
  'execution/tests/test-settlement-animation-offline.js',
  'execution/tests/test-victory-risk-fast-info.js'
];

for (const rel of regressions) {
  const full = path.join(ROOT, ...rel.split('/'));
  if (!fs.existsSync(full)) throw new Error(`REGRESSION_MISSING:${rel}`);
  runNode([full], `REGRESSION_FAIL:${rel}`);
}

if (WITH_STATE) {
  const stateAudit = path.join(ROOT, 'tools', 'audit-v6-state-consistency.js');
  runNode([stateAudit], 'STATE_AUDIT_FAIL');
}

console.log(
  `V6 PROJECT VERIFY PASS; syntax=${activeJs.length}; regressions=${regressions.length}; ` +
  `state=${WITH_STATE ? 'PASS' : 'SKIPPED'}`
);
