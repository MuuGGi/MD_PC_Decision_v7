'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomicWriteJson, insidePath } = require('../core/json-store');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const rows = [];
  function walk(relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative + '/' + e.name;
      if (e.isSymbolicLink()) throw new Error('V7_SOURCE_ARCHIVE_LINK_FORBIDDEN');
      if (e.isDirectory()) { if (!['debug', 'archive', 'node_modules', 'fixtures'].includes(e.name)) walk(rel); }
      else if (/\.(js|ps1|json)$/.test(e.name)) { const bytes = fs.readFileSync(path.join(root, rel)); rows.push({ path: rel, sha256: digest(bytes), bytes: bytes.length }); }
    }
  }
  for (const rel of ['src', 'autotest', 'engine/lib', 'engine/runtime', 'engine/execution', 'engine/scripts']) walk(rel);
  for (const rel of ['config/v6-ownership.json', 'engine/card-library.json', 'engine/live-config.js']) {
    const bytes = fs.readFileSync(path.join(root, rel)); rows.push({ path: rel, sha256: digest(bytes), bytes: bytes.length });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function archiveRuntimeSource(root, runDir) {
  try {
    const rows = inventory(root), sourceId = digest(Buffer.from(JSON.stringify(rows)));
    const destination = insidePath(root, path.join(root, 'archive/source', sourceId));
    const marker = path.join(destination, 'manifest.json');
    if (fs.existsSync(marker)) {
      const saved = JSON.parse(fs.readFileSync(marker));
      if (saved.sourceId !== sourceId) throw new Error('V7_SOURCE_ARCHIVE_ID_CONFLICT');
      for (const row of rows) {
        const file = insidePath(root, path.join(destination, row.path));
        if (!fs.existsSync(file) || digest(fs.readFileSync(file)) !== row.sha256)
          throw new Error('V7_SOURCE_ARCHIVE_CORRUPT:' + row.path);
      }
    } else {
      for (const row of rows) {
        const file = insidePath(root, path.join(destination, row.path)); fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = fs.readFileSync(path.join(root, row.path));
        if (digest(bytes) !== row.sha256) throw new Error('V7_SOURCE_CHANGED_DURING_ARCHIVE');
        fs.writeFileSync(file, bytes);
      }
      atomicWriteJson(marker, { sourceId, createdAt: new Date().toISOString(), files: rows });
    }
    atomicWriteJson(path.join(runDir, 'source-ref.json'), { version: 1, sourceId, path: destination, sourceFiles: rows.length });
    return { ok: true, sourceId, path: destination };
  } catch (error) { return { ok: false, error }; }
}
module.exports = { archiveRuntimeSource, inventory };
