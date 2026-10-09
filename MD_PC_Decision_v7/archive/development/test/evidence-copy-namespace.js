'use strict';
// Regression for the actual Windows fs.cp callback paths, not just synthetic POSIX-like strings.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { debugImageRetention } = require('../../../autotest/store');
async function run() {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'md-v7-copy-namespace-'));
  const source = path.join(root, 'debug'), image = path.join(source, 'hand-change-live/revision_1/passive_hand.png');
  try {
    fs.mkdirSync(path.dirname(image), { recursive: true }); fs.writeFileSync(image, 'generated retention fixture');
    fs.writeFileSync(path.join(source, 'hand-change-live/session_state.json'), JSON.stringify({ handImagePath: image }));
    const keep = debugImageRetention(source, false, { compact: true });
    assert.equal(keep(image), true);
    if (process.platform === 'win32') assert.equal(keep(path.toNamespacedPath(image)), true, 'namespace and ordinary path must select the same key image');
    let syncNamespace = false, asyncNamespace = false;
    fs.cpSync(source, path.join(root, 'sync'), { recursive: true, filter: file => { syncNamespace ||= String(file).startsWith('\\\\?\\'); return keep(file); } });
    await new Promise((resolve, reject) => fs.cp(source, path.join(root, 'async'), { recursive: true,
      filter: file => { asyncNamespace ||= String(file).startsWith('\\\\?\\'); return keep(file); } }, error => error ? reject(error) : resolve()));
    for (const directory of ['sync', 'async']) assert(fs.existsSync(path.join(root, directory, 'hand-change-live/revision_1/passive_hand.png')), directory + ' lost key image');
    if (process.platform === 'win32') assert(syncNamespace && asyncNamespace, 'exercise real Windows namespaced copy callbacks');
    console.log('V7_EVIDENCE_COPY_NAMESPACE_PASS; ordinary/namespaced equality; actual sync+async copy preserves key images; inputs=0');
  } finally {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('md-v7-copy-namespace-') || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_GENERATED_TEST_CLEANUP');
    fs.rmSync(root, { recursive: true });
  }
}
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { run };
