'use strict';
// Only archived asset PNG copies; no canonical images or debug evidence.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { sourceSnapshotFilter } = require('../../../store');
const engine = fs.realpathSync(path.resolve(__dirname, '../..'));
const runs = fs.realpathSync(path.resolve(engine, '../runs'));
const ids = ['2026-10-04T15-47-29-509Z', '2026-10-05T02-11-41-105Z',
  '2026-10-05T03-52-44-028Z', '2026-10-05T05-32-24-567Z'];
const apply = process.argv.includes('--apply'), hashes = new Map();
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function contained(base, file) {
  const rel = path.relative(base, fs.realpathSync(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('UNSAFE_TARGET:' + file);
}
let count = 0, bytes = 0, retained = 0;
for (const id of ids) {
  const archive = path.join(runs, id, 'engine-source');
  contained(runs, archive);
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('LINK_REJECTED:' + file);
      contained(archive, file);
      if (item.isDirectory()) { walk(file); continue; }
      if (!item.isFile() || path.extname(file).toLowerCase() !== '.png') continue;
      const original = path.join(engine, path.relative(archive, file));
      if (sourceSnapshotFilter(engine, original) || !fs.existsSync(original)) { retained++; continue; }
      contained(engine, original);
      const size = fs.statSync(file).size;
      if (size !== fs.statSync(original).size) { retained++; continue; }
      if (!hashes.has(original)) hashes.set(original, digest(original));
      const sha256 = digest(file);
      if (sha256 !== hashes.get(original)) { retained++; continue; }
      if (apply) {
        fs.appendFileSync(path.join(runs, 'image-prune-ledger.jsonl'), JSON.stringify({
          relativePath: path.relative(runs, file).replace(/\\/g, '/'), sha256, bytes: size,
          reason: 'duplicate-source-asset-image', canonicalPath: original,
          removedAt: new Date().toISOString() }) + '\n');
        fs.unlinkSync(file);
      }
      count++; bytes += size;
    }
  }
  for (const name of ['material', 'materials', 'templates']) {
    const dir = path.join(archive, name);
    if (fs.existsSync(dir)) walk(dir);
  }
  console.log(JSON.stringify({ id, mode: apply ? 'APPLY' : 'DRY_RUN', cumulativeCount: count, cumulativeBytes: bytes, retained }));
}
console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', count, bytes, gib: bytes / 1073741824, retained,
  canonicalImagesDeleted: 0, debugImagesDeleted: 0 }));
