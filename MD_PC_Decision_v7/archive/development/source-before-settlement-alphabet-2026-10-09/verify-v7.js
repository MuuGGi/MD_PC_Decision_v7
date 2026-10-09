'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { atomicWriteJson } = require('../../../src/core/json-store');
const { doctor, jsFiles, ROOT } = require('../../../tools/doctor-v7');
function verify({ legacy = process.argv.includes('--legacy') } = {}) {
  const report = { checkedAt: new Date().toISOString(), node: process.version, stages: [] };
  const output = path.join(ROOT, 'archive/verification/quick-latest.json');
  const stage = (name, result) => { report.stages.push({ name, ...result }); atomicWriteJson(output, report); };
  try {
    stage('doctor', doctor());
    const files = ['src', 'engine', 'autotest', 'tools', 'archive/development/tools', 'archive/development/test'].flatMap(rel => jsFiles(path.join(ROOT, rel)));
    for (const file of files) {
      const result = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error('V7_SYNTAX_FAIL:' + file + ':' + result.stderr);
    }
    stage('syntax', { status: 'PASS', files: files.length });
    console.log('V7_SYNTAX_PASS; files=' + files.length);
    for (const name of ['run', 'robustness', 'integration', 'field-gain-regression', 'strategy-shadow', 'unified-strategy', 'endgame-draw-source', 'link-selection-contract', 'observer-baseline-commit', 'field-identity-contract', 'info-overlay-read-contract', 'submitted-recovery', 'field-continuity', 'evidence-retention', 'evidence-copy-namespace', 'terminal-registration', 'terminal-transaction-close', 'terminal-hand-report']) {
      const result = cp.spawnSync(process.execPath, [path.join(ROOT, 'archive/development/test', name + '.js')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
      stage(name, { status: result.status === 0 ? 'PASS' : 'FAIL', output: String(result.stdout || '') + String(result.stderr || '') });
      if (result.status !== 0) throw new Error('V7_TEST_FAIL:' + name);
    }
    stage('runtime-isolation', require('./check-runtime-isolation').verify());
    if (legacy) {
      const result = require('./verify-legacy-regressions').run();
      stage('legacy', { status: result.failed.length ? 'FAIL' : 'PASS', total: result.results.length, failed: result.failed.length });
      if (result.failed.length) throw new Error('V7_LEGACY_TESTS_INCOMPLETE');
    }
    report.status = 'V7_OFFLINE_VERIFY_PASS'; atomicWriteJson(output, report);
    console.log(report.status);
    return report;
  } catch (e) {
    report.status = 'V7_OFFLINE_VERIFY_FAIL'; report.error = String(e.stack || e); atomicWriteJson(output, report); throw e;
  }
}
if (require.main === module) { try { verify(); } catch (e) { console.error(e.stack || e); process.exitCode = 1; } }
module.exports = { verify };
