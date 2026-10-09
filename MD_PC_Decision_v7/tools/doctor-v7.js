'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '..'), ENGINE = path.join(ROOT, 'engine');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function jsFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const row of fs.readdirSync(root, { withFileTypes: true })) {
    if (row.isSymbolicLink()) throw new Error('V7_RUNTIME_LINK_FORBIDDEN:' + row.name);
    const file = path.join(root, row.name);
    if (row.isDirectory()) { if (!['archive', 'debug', 'node_modules'].includes(row.name)) files.push(...jsFiles(file)); }
    else if (row.name.endsWith('.js')) files.push(file);
  }
  return files;
}
function doctor() {
  if (process.versions.node !== '20.11.1') throw new Error('V7_NODE_MUST_BE_20_11_1');
  const errors = [], requireFile = rel => { if (!fs.existsSync(path.join(ROOT, rel))) errors.push('MISSING:' + rel); };
  for (const rel of ['engine/runtime/main-v7.js', 'engine/runtime/mature-driver.js', 'engine/runtime/observer-entrypoints.js',
    'engine/scripts/md-common.ps1', 'engine/scripts/md-server.ps1', 'autotest/fixtures/starter-title.png',
    'autotest/fixtures/start-button.png', 'autotest/fixtures/main1-text.png', 'node_modules/pngjs/package.json']) requireFile(rel);
  const library = JSON.parse(fs.readFileSync(path.join(ENGINE, 'card-library.json'), 'utf8'));
  for (const card of library.cards) requireFile('engine/' + card.template);
  for (const rel of Object.values(require('../engine/runtime/observer-entrypoints').OBSERVER_ENTRYPOINTS)) requireFile('engine/' + rel);
  const manifest = require('../config/v6-ownership.json');
  for (const key of Object.values(require('../src/integration/production-bindings').KEY)) {
    const row = manifest.entries.find(e => e.capability === key);
    require('../src/core/ownership').assertProductionReady(row);
    if (row.sourceSha256 !== digest(path.join(ROOT, row.path))) errors.push('OWNERSHIP_SOURCE_CHANGED:' + key);
  }
  const files = ['src', 'engine', 'autotest'].flatMap(rel => jsFiles(path.join(ROOT, rel)));
  for (const file of files) {
    const resolve = createRequire(file).resolve, source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      try { resolve(match[1]); } catch (error) { errors.push('DEPENDENCY:' + path.relative(ROOT, file) + ':' + match[1]); }
    }
  }
  const result = { status: errors.length ? 'V7_DOCTOR_FAIL' : 'V7_DOCTOR_PASS', node: process.version,
    root: ROOT, runtimeFiles: files.length, calibratedCards: library.cards.length, standaloneDriver: true, errors };
  if (errors.length) throw new Error(JSON.stringify(result));
  return result;
}
async function preflight() {
  doctor();
  const { MdFastBridge, clientReport, captureReferenceRoi } = require('../engine/lib/win-fast');
  const bridge = new MdFastBridge();
  try {
    await bridge.start();
    // Get-MasterDuelInfo itself verifies foreground identity. No activate/input.
    const info = await bridge.info(), report = clientReport(info);
    const foreground = await require('../src/core/input-guard').proveForeground(async () => ({ ...info, ...report, foregroundVerified: true }), { hwnd: info.hwnd });
    if (foreground.status !== 'READY') throw new Error('V7_PREFLIGHT_UNSAFE:' + foreground.reason);
    const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
    const page = require('../autotest/ui').classifyPage(image);
    console.log(JSON.stringify({ status: 'V7_GUI_READ_ONLY_PROBE', hwnd: info.hwnd, pid: info.pid,
      foreground, page, inputCount: 0 }, null, 2));
    return { info, page };
  } finally { await bridge.stop().catch(() => {}); }
}
if (require.main === module) Promise.resolve(process.argv.includes('--preflight') ? preflight() : doctor())
  .then(result => { if (!process.argv.includes('--preflight')) console.log(JSON.stringify(result, null, 2)); })
  .catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { doctor, preflight, jsFiles, ROOT, ENGINE };
