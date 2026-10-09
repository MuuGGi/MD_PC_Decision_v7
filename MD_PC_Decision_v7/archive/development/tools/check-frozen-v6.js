'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../../..');
const { atomicWriteJson } = require('../../../src/core/json-store');
const file = path.join(ROOT, 'archive/verification/frozen-v6-state.json');
const digest = target => fs.existsSync(target) ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : 'MISSING';
function capture() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'archive/development/import-manifest.json'), 'utf8'));
  const formal = path.resolve(manifest.sourceRoot, '../..');
  const targets = [...new Set(manifest.files.map(r => r.source).concat([
    path.join(manifest.sourceRoot, 'decision-state.json'), path.join(manifest.sourceRoot, 'debug/hand-change-live/session_state.json'),
    path.join(manifest.sourceRoot, 'debug/main-deck-ledger/state.json'), path.join(formal, 'decision-state.json'),
    path.join(formal, 'autotest/latest-run.json'), path.join(formal, 'autotest/statistics.json')]))];
  const files = Object.fromEntries(targets.map(target => [target, digest(target)]));
  for (const row of manifest.files) if (files[row.source] !== row.sha256) throw new Error('FROZEN_V6_IMPORT_SOURCE_CHANGED:' + row.source);
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (before) {
    for (const [target, hash] of Object.entries(before.files)) {
      if (files[target] !== hash) throw new Error('FROZEN_V6_STATE_CHANGED:' + target);
    }
  } else { atomicWriteJson(file, { createdAt: new Date().toISOString(), files }); }
  const result = { status: 'FROZEN_V6_UNCHANGED', verifiedFiles: targets.length, evidence: file };
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { capture(); } catch (e) { console.error(e.stack); process.exitCode = 1; } }
module.exports = { capture };
