'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const { atomicWriteJson } = require('../../../src/core/json-store');
function run() {
  const work = path.join(ROOT, 'archive/verification/compat-project');
  const engine = path.join(work, 'engine');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(ROOT, 'engine'), engine, { recursive: true, filter: file => {
    const ordinary = String(file).startsWith('\\\\?\\') ? String(file).slice(4) : String(file);
    const relative = path.relative(path.join(ROOT, 'engine'), ordinary);
    return !relative.split(path.sep).some(p => ['debug', 'archive', 'evidence'].includes(p)) &&
      path.basename(ordinary) !== 'decision-state.json';
  } });
  fs.cpSync(path.join(ROOT, 'src'), path.join(work, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'autotest'), path.join(work, 'autotest'), { recursive: true });
  for (const name of ['policy', 'store', 'ui', 'session', 'replay', 'resume-m17'])
    fs.writeFileSync(path.join(work, name + '.js'), "module.exports = require('./autotest/" + name + "');\n");
  // The diagnostics tests evaluate source inside a VM, not through require().
  fs.writeFileSync(path.join(work, 'diagnostics.js'), fs.readFileSync(path.join(ROOT, 'autotest/diagnostics.js'), 'utf8')
    .replace(/\.\.\/engine\//g, './engine/'));
  fs.copyFileSync(path.join(ROOT, 'autotest/auto-hook.js'), path.join(work, 'auto-hook.js'));
  fs.writeFileSync(path.join(work, 'runner.js'), fs.readFileSync(path.join(ROOT, 'autotest/runner.js'), 'utf8')
    .replace(/require\('\.\/([^']+)'\)/g, "require('./autotest/$1')")
    .replace(/require\('\.\.\/engine\//g, "require('./engine/")
    .replace(/require\('\.\.\/src\//g, "require('./src/"));
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'archive/development/import-manifest.json'))).sourceRoot;
  // Old layout-only checks run against frozen layout references in archive, never production.
  fs.cpSync(path.join(source, 'tools'), path.join(engine, 'tools'), { recursive: true });
  for (const rel of ['run-v6.cmd', 'verify-v6.cmd', 'package.json'])
    fs.copyFileSync(path.join(source, rel), path.join(engine, rel));
  for (const file of fs.readdirSync(path.join(ROOT, 'archive/legacy-regression/controller')).filter(n => /^tests.*\.js$/.test(n)))
    fs.copyFileSync(path.join(ROOT, 'archive/legacy-regression/controller', file), path.join(work, file));
  fs.cpSync(path.join(ROOT, 'archive/legacy-regression/execution/tests'), path.join(engine, 'execution/tests'), { recursive: true });
  // Existing source-level fixtures inspect legacy scheduling. This is a frozen
  // reference, not the production V7 entry; V7 dispatch has its own tests.
  fs.copyFileSync(path.join(ROOT, 'archive/migration/frozen-driver/runtime/main-v6.js'), path.join(engine, 'runtime/main-v6.js'));
  atomicWriteJson(path.join(engine, 'decision-state.json'), { usedCounts: {}, graveSpellCount: 0, v5Branch: { currentState: 'IDLE' } });
  const tests = fs.readdirSync(path.join(engine, 'execution/tests')).filter(n => /^test-.*-offline\.js$/.test(n) && !n.endsWith('-harness-offline.js')).sort();
  const results = [];
  for (const name of tests) {
    const child = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'legacy-offline-preload.js'), path.join(engine, 'execution/tests', name)],
      { cwd: engine, encoding: 'utf8', windowsHide: true, timeout: 360000,
        env: { ...process.env, MD_V7_LEGACY_WORK: work } });
    const output = String(child.stdout || '') + String(child.stderr || '');
    const entry = { name, status: child.status === 0 ? 'PASS' : 'FAIL', exitCode: child.status,
      error: child.error ? String(child.error.message) : null, output };
    results.push(entry);
    console.log('V7_COMPAT_REGRESSION ' + entry.status + ' ' + name);
    if (entry.status !== 'PASS') console.log(output.slice(-2000));
    atomicWriteJson(path.join(ROOT, 'archive/verification/legacy-latest.json'), { createdAt: new Date().toISOString(), tests: results });
  }
  const failed = results.filter(row => row.status !== 'PASS');
  console.log(JSON.stringify({ status: failed.length ? 'V7_COMPAT_INCOMPLETE' : 'V7_COMPAT_PASS', total: results.length, failed: failed.length }));
  return { results, failed };
}
if (require.main === module) { const result = run(); process.exitCode = result.failed.length ? 1 : 0; }
module.exports = { run };
