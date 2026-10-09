'use strict';
// One-time mechanical import; V6 is read-only. No source overlay on later runs.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../../..');
const V6 = path.resolve(ROOT, '../../MD_PC_Decision_v6');
const SOURCE = path.join(V6, 'autotest/engine');
const DRIVER = path.join(ROOT, 'engine');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifests = [];
function copy(source, relative, bucket = 'DRIVER') {
  const target = path.join(ROOT, relative);
  if (fs.existsSync(target)) throw new Error('V7_IMPORT_REFUSES_OVERWRITE:' + relative);
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('V7_IMPORT_LINK_FORBIDDEN:' + source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const bytes = fs.readFileSync(source);
  if (hash(fs.readFileSync(target)) !== hash(bytes)) throw new Error('V7_IMPORT_HASH_MISMATCH');
  manifests.push({ source, target: relative.replace(/\\/g, '/'), bucket, bytes: bytes.length, sha256: hash(bytes) });
}
function tree(source, relative, filter = () => true, bucket) {
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    const file = path.join(source, e.name), target = path.join(relative, e.name);
    if (!filter(target, e)) continue;
    if (e.isSymbolicLink()) throw new Error('V7_IMPORT_LINK_FORBIDDEN');
    if (e.isDirectory()) tree(file, target, filter, bucket);
    else if (e.isFile()) copy(file, target, bucket);
  }
}
function main() {
  if (process.versions.node !== '20.11.1') throw new Error('V7_NODE20_REQUIRED');
  if (fs.existsSync(DRIVER)) throw new Error('V7_DRIVER_ALREADY_IMPORTED');
  for (const rel of ['lib', 'scripts', 'templates', 'execution/core', 'execution/cards', 'execution/live', 'runtime/observer'])
    tree(path.join(SOURCE, rel), path.join('engine', rel));
  for (const rel of ['card-library.json', 'live-config.js', 'execution/production-entrypoints.js', 'runtime/observer-entrypoints.js', 'material/verified/verified-cards.json'])
    copy(path.join(SOURCE, rel), path.join('engine', rel));
  copy(path.join(SOURCE, 'runtime/main-v6.js'), 'engine/runtime/main-v7.js');
  tree(path.join(SOURCE, 'materials/ui/outcomes'), 'engine/materials/ui/outcomes');
  for (const file of fs.readdirSync(path.join(SOURCE, 'material/verified')).filter(n => /^duel-settlement-0\d-gems-.*\.png$/.test(n)))
    copy(path.join(SOURCE, 'material/verified', file), path.join('engine/material/verified', file));
  tree(path.join(V6, 'node_modules/pngjs'), 'node_modules/pngjs', () => true, 'DEPENDENCY');
  const controller = ['runner.js', 'store.js', 'session.js', 'policy.js', 'auto-hook.js', 'diagnostics.js', 'ui.js', 'replay.js', 'resume-m17.js'];
  for (const file of controller) copy(path.join(V6, 'autotest', file), path.join('autotest', file), 'CONTROLLER');
  for (const name of ['starter-title', 'start-button', 'main1-text'])
    copy(path.join(V6, 'autotest/fixtures', name + '.png'), path.join('autotest/fixtures', name + '.png'), 'CALIBRATION');
  tree(path.join(SOURCE, 'execution/tests'), 'archive/legacy-regression/execution/tests', () => true, 'ARCHIVED_TEST');
  for (const file of fs.readdirSync(path.join(V6, 'autotest')).filter(n => /^tests.*\.js$/.test(n) || n === 'verify-guard.ps1'))
    copy(path.join(V6, 'autotest', file), path.join('archive/legacy-regression/controller', file), 'ARCHIVED_TEST');
  copy(path.join(SOURCE, 'runtime/main-v6.js'), 'archive/migration/frozen-driver/runtime/main-v6.js', 'FROZEN_REFERENCE');
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'archive/development/import-manifest.json'), JSON.stringify({ version: 1,
    importedAt: new Date().toISOString(), sourceRoot: SOURCE, files: manifests }, null, 2));
  console.log(JSON.stringify({ status: 'V7_DRIVER_IMPORT_PASS', files: manifests.length,
    bytes: manifests.reduce((n, row) => n + row.bytes, 0), driverRoot: DRIVER, originalsModified: false }));
}
if (require.main === module) main();
module.exports = { ROOT, V6, SOURCE, DRIVER };
