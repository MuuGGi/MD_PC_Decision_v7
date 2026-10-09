'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { insidePath, readOwnedJson, atomicWriteJson } = require('../../../src/core/json-store');
const ROOT = path.resolve(__dirname, '../../..'), RUNS = path.join(ROOT, 'archive/autotest/runs');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function repair(runDirectory) {
  if (fs.existsSync(path.join(ROOT, 'debug/autotest/active.lock'))) throw new Error('ARCHIVE_REPAIR_DURING_LIVE_TEST_FORBIDDEN');
  const run = insidePath(RUNS, path.resolve(runDirectory)), summary = readOwnedJson(path.join(run, 'summary.json'));
  if (!summary || summary.status === 'RUNNING' || summary.games.some(game => !game.outcome)) throw new Error('ARCHIVE_REPAIR_REQUIRES_CLOSED_BATCH');
  const rows = [];
  for (const game of summary.games) {
    const directory = insidePath(run, path.join(run, 'game-' + String(game.id).padStart(5, '0')));
    const source = path.join(directory, 'runtime-debug'), destination = path.join(directory, 'completed');
    if (!fs.existsSync(source) || !fs.existsSync(path.join(destination, 'manifest.json'))) continue;
    const manifest = readOwnedJson(path.join(destination, 'manifest.json')), restored = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = insidePath(source, path.join(dir, entry.name));
        if (entry.isSymbolicLink()) throw new Error('ARCHIVE_REPAIR_LINK_FORBIDDEN');
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.png$/i.test(entry.name)) {
          const relative = 'debug/' + path.relative(source, file).replace(/\\/g, '/');
          const target = insidePath(destination, path.join(destination, relative)), hash = digest(file);
          if (fs.existsSync(target)) { if (digest(target) !== hash) throw new Error('ARCHIVE_REPAIR_EXISTING_IMAGE_CONFLICT'); continue; }
          if (manifest.files[relative] && manifest.files[relative] !== hash) throw new Error('ARCHIVE_REPAIR_MANIFEST_CONFLICT');
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target);
          if (digest(target) !== hash) throw new Error('ARCHIVE_REPAIR_COPY_HASH_MISMATCH');
          manifest.files[relative] = hash; restored.push({ relative, sha256: hash });
        }
      }
    }
    walk(source);
    if (restored.length) {
      manifest.keyImageRepair = { at: new Date().toISOString(), reason: 'WINDOWS_NAMESPACE_FILTER_NORMALIZATION', source: 'runtime-debug', restored };
      atomicWriteJson(path.join(destination, 'manifest.json'), manifest);
    }
    rows.push({ gameId: game.id, restored });
  }
  const result = { at: new Date().toISOString(), status: 'KEY_IMAGE_ARCHIVES_RECONCILED', rows };
  atomicWriteJson(path.join(run, 'key-image-repair.json'), result); console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { repair(process.argv[2]); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }
module.exports = { repair };
