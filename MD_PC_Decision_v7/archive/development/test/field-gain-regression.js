'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const { createRequire } = require('module');
const { verifyOwnedFieldGain } = require('../../../src/core/effect-receipt');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const ROOT = path.resolve(__dirname, '../../..'), FIXTURE = path.join(ROOT, 'archive/regression-fixtures/deferred-field-gain');
const read = name => JSON.parse(fs.readFileSync(path.join(FIXTURE, name), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
async function run() {
  const log = read('log.json'), incremental = read('incremental.json'), tx = read('transaction.json');
  const trace = fs.readFileSync(path.join(FIXTURE, 'field-proof-trace.txt'), 'utf8');
  assert.match(trace, /场地固定位置卡名确认: 试胆竞速\[M21\] PASS/);
  assert.match(trace, /试胆竞速抽1: 已点击 OK/);
  // Forensic fixture was recorded before receipt persistence existed. Reconstruct
  // only the accepted field-card fact recorded in that exact attempt's trace.
  const sourceProof = { proven: true, actor: 'SELF', cardId: 'M21', transactionId: tx.id };
  const context = { cardId: 'M21', transactionId: tx.id, sourceProof, baseline: tx.beforeDraw, log, incremental };
  let tests = 0;
  const filename = path.join(ROOT, 'engine/execution/core/m21-chicken-game-route.js');
  const nativeRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, __dirname: path.dirname(filename), console,
    require: id => id.endsWith('runtime-files') ? { readJson: file => file.includes('duel-log-live') ? log : incremental } : nativeRequire(id) }, { filename });
  await withStrictReadOnly(async () => {
    const native = module.exports.validateFinalDraw;
    assert.throws(() => native({ card: { id: 'M21' }, baselineHandCount: 6 }), /FINAL_RELATIONSHIP_INVALID/); tests++;
    const proof = native({ card: { id: 'M21' }, baselineHandCount: 6,
      effectContext: { transactionId: tx.id, sourceProof, baseline: tx.beforeDraw } });
    assert.equal(proof.effectReceipt.proven, true); assert.equal(proof.drawn.id, 'M15'); assert.equal(proof.afterCount, 6); tests++;
    const variants = [
      ['SOURCE_NOT_PROVEN', value => { value.sourceProof.proven = false; }],
      ['ACTOR_OR_INSTANCE_AMBIGUOUS', value => { value.log.newOperationBlocks[0].activation.side = 'OPPONENT'; }],
      ['GAINS_NOT_PROVEN', value => { value.log.newOperationBlocks[0].details[0].side = 'OPPONENT'; }],
      ['ACTOR_OR_INSTANCE_AMBIGUOUS', value => { value.log.newOperationBlocks.push(clone(value.log.newOperationBlocks[0])); }],
      ['CONTINUITY_UNKNOWN', value => { value.log.continuity = 'UNKNOWN'; }],
      ['STALE_BASELINE', value => { value.incremental.before.revision++; }],
      ['NOT_OWNED_FIELD_OUTCOME', value => { value.incremental.inference.consumed = { id: 'M21' }; }],
      ['GAIN_IDENTITY_MISMATCH', value => { value.incremental.after.cards.at(-1).id = 'M09'; }],
      ['DELTA_INVALID', value => { value.incremental.after.handCount++; }]
    ];
    for (const [code, mutate] of variants) {
      const value = clone(context); mutate(value);
      assert.throws(() => verifyOwnedFieldGain(value), e => e.code === 'EFFECT_RECEIPT_' + code); tests++;
    }
    const unrelatedPlacement = clone(context);
    unrelatedPlacement.log.newOperationBlocks.unshift({ activationKey: 'M21', activation: { side: 'SELF', card: { id: 'M21' } }, details: [] });
    assert.equal(verifyOwnedFieldGain(unrelatedPlacement).proven, true); tests++;
  });
  // Test the real success-promotion helper in a disposable project, not the
  // interrupted game. Calibration and failure images are outside its scope.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv7-storage-')), engine = path.join(root, 'engine');
  const dir = path.join(engine, 'debug/execution/DRAW/attempt'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"PASS"}'); fs.writeFileSync(path.join(dir, 'full-frame.png'), 'unneeded-copy');
  const storage = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'engine/lib/project-storage.js'), 'utf8'), { module: storage,
    __dirname: path.join(engine, 'lib'), require }, { filename: 'project-storage.js' });
  const relative = storage.exports.promoteVerifiedEvidence(dir, 'DRAW');
  const saved = path.resolve(engine, relative);
  assert(saved.startsWith(path.join(root, 'archive/verified-evidence')));
  assert(fs.existsSync(path.join(saved, 'result.json'))); assert(!fs.existsSync(path.join(saved, 'full-frame.png')));
  assert(fs.existsSync(path.join(dir, 'full-frame.png')), 'live/failure evidence untouched'); tests++;
  console.log('V7_FIELD_GAIN_AND_STORAGE_REGRESSION_PASS; cases=' + tests + '; nativeInputs=0/businessWrites=0');
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
