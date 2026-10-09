'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { sourceSnapshotFilter, debugImageRetention } = require('./store');
const root = path.join(__dirname, 'engine');
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'material/verified/card.png')), false);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'material/verified/cards.json')), true);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'material/verified/duel-settlement-04-gems-108-plus-10.png')), true);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'templates/ui/hand_count_info_2.png')), true);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'runtime/main-v6.js')), true);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'debug/state.json')), false);
assert.strictEqual(sourceSnapshotFilter(root, path.join(root,'decision-state.json')), false);

// Exercise the production policy with an in-memory, timestamped debug tree.
const storeFile = path.join(__dirname,'store.js'), native = createRequire(storeFile);
const debug = path.join(__dirname,'runs','2099-synthetic','game-00001','runtime-debug');
const old = path.join(root,'debug/scan-state-live/prepared/hand_detect.png');
const execution = path.join(debug,'execution');
const entry = (name,isDir=true) => ({name,isDirectory:()=>isDir});
const fakeFs = { existsSync:p=>p===execution||p===path.join(debug,'hand-change-live/session_state.json'),
  readFileSync:()=>JSON.stringify({handImagePath:old}),
  readdirSync:p=>p===execution?[entry('M11'),entry('M14')]:p.endsWith('M11')?[entry('2026-10-04T13-38-00-000Z'),entry('2026-10-04T12-00-00-000Z')]:[entry('2026-10-04T13-39-00-000Z')] };
const context = {module:{exports:{}},__dirname,require:id=>id==='fs'?fakeFs:native(id)};
vm.runInNewContext(fs.readFileSync(storeFile,'utf8'),context);
const keep=context.module.exports.debugImageRetention(debug,true);
assert.strictEqual(keep(path.join(debug,'scan-state-live/prepared/hand_detect.png')),true);
assert.strictEqual(keep(path.join(execution,'M14/2026-10-04T13-39-00-000Z/target.png')),true);
assert.strictEqual(keep(path.join(execution,'M11/2026-10-04T13-38-00-000Z/selected.png')),true);
assert.strictEqual(keep(path.join(execution,'M11/2026-10-04T12-00-00-000Z/selected.png')),false);
assert.strictEqual(keep(path.join(debug,'scan-state-live/error_state.png')),true);
assert.strictEqual(keep(path.join(debug,'post-duel-victory/reward.png')),true);
assert.strictEqual(keep(path.join(debug,'duel-log-live/ordinary.png')),false);
assert.strictEqual(keep(path.join(debug,'main-deck-ledger/state.json')),true);
const normal=context.module.exports.debugImageRetention(debug,false);
assert.strictEqual(normal(path.join(execution,'M14/2026-10-04T13-39-00-000Z/target.png')),false);
assert.throws(()=>context.module.exports.pruneArchivedDebugImages(path.join(root,'debug')),/OUTSIDE_ARCHIVED_DEBUG/);

// Missing-image exceptions require an audited matching digest, never missing
// code, an unlisted image, a changed image, or a path outside the archive.
const replayFile=path.join(__dirname,'replay.js'),archive=path.join(__dirname,'runs','2099-synthetic','game-00001','completed');
let manifest={files:{'debug/ordinary.png':'abc'}},ledger=[{relativePath:'2099-synthetic/game-00001/completed/debug/ordinary.png',sha256:'abc'}];
let imageExists=false;
const replayFs={existsSync:p=>p.endsWith('image-prune-ledger.jsonl')||(imageExists&&p.endsWith('ordinary.png')),
  readFileSync:p=>p.endsWith('manifest.json')?JSON.stringify(manifest):p.endsWith('image-prune-ledger.jsonl')?ledger.map(x=>JSON.stringify(x)).join('\n'):p.endsWith('decision-state.json')?'{}':(()=>{throw new Error('MISSING_UNAPPROVED_FILE')})()};
const replayCtx={module:{exports:{}},__dirname,require:id=>id==='fs'?replayFs:id==='./store'?{sha:()=> 'changed'}:native(id)};
vm.runInNewContext(fs.readFileSync(replayFile,'utf8'),replayCtx);
assert.strictEqual(replayCtx.module.exports.replay(archive).prunedImageCount,1);
ledger[0].sha256='wrong';assert.throws(()=>replayCtx.module.exports.replay(archive));
ledger[0].sha256='abc';imageExists=true;assert.throws(()=>replayCtx.module.exports.replay(archive),/HASH_INVALID/);
imageExists=false;manifest={files:{'lib/required.js':'abc'}};assert.throws(()=>replayCtx.module.exports.replay(archive));
manifest={files:{'../outside.png':'abc'}};assert.throws(()=>replayCtx.module.exports.replay(archive),/HASH_INVALID/);
// Match runner.js: actual asynchronous fs.cp on Node 20 / Windows, not just
// hand-written ordinary paths. Windows internally supplies namespaced paths.
async function testAsyncSourceCopy() {
  const os = require('os'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-source-filter-'));
  const source = path.join(temp, 'source'), dest = path.join(temp, 'dest');
  const samples = ['material/issues/unused.png', 'materials/unused.png', 'templates/cards/unused.png',
    'material/issues/evidence.json', 'templates/ui/hand_count_info_2.png',
    'material/verified/duel-settlement-04-gems-108-plus-10.png', 'runtime/main-v6.js',
    'debug/unused.png', 'decision-state.json'];
  try {
    for (const rel of samples) {
      const file = path.join(source, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'tiny-fixture');
      assert.strictEqual(sourceSnapshotFilter(source, path.toNamespacedPath(file)), sourceSnapshotFilter(source, file));
    }
    assert.strictEqual(sourceSnapshotFilter(source, path.join(temp, 'outside.png')), false);
    let namespaceSeen = false;
    await new Promise((resolve, reject) => fs.cp(source, dest, { recursive: true, filter: file => {
      namespaceSeen ||= file.startsWith('\\\\?\\'); return sourceSnapshotFilter(source, file);
    } }, error => error ? reject(error) : resolve()));
    if (process.platform === 'win32') assert.ok(namespaceSeen, 'exercise actual Windows async namespace');
    for (const rel of samples) assert.strictEqual(fs.existsSync(path.join(dest, rel)), sourceSnapshotFilter(source, path.join(source, rel)), rel);
  } finally {
    const resolved = fs.realpathSync(temp), rel = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    assert.ok(rel.startsWith('md-source-filter-') && !rel.includes(path.sep));
    fs.rmSync(resolved, { recursive: true });
  }
  console.log('IMAGE_RETENTION_OFFLINE_PASS; actual async fs.cp namespace regression; asset PNG copies excluded; calibration/code/JSON retained; audited replay guards; nativeInputs=0');
}
testAsyncSourceCopy().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
