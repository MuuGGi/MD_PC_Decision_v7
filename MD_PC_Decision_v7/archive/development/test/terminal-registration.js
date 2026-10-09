'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../../..'), file = path.join(ROOT, 'engine/execution/core/verified-registry.js');
const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'md-v7-terminal-registry-'));
const status = path.join(root, 'status.json'), evidenceDir = path.join(root, 'attempt');
fs.mkdirSync(evidenceDir); let writes = 0, promotions = 0, cases = 0;
const moduleContext = { exports: {} }, native = createRequire(file);
vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: moduleContext, console: { log() {} },
  require: id => id === '../../lib/project-storage' ? { VERIFIED_STATUS_PATH: status,
    ensureDir: dir => fs.mkdirSync(dir, { recursive: true }), resolveStoredPath: value => path.resolve(value),
    promoteVerifiedEvidence: value => { promotions++; return value; } } :
    id === '../../lib/runtime-files' ? { writeJsonAtomic: (target, value) => { writes++; fs.writeFileSync(target, JSON.stringify(value)); } } : native(id) });
const api = moduleContext.exports;
const options = { id: 'M17', name: 'test', evidenceDir, branch: 'BONUS_DRAW', requiredBranches: ['NO_BONUS_DRAW', 'BONUS_DRAW'] };
function seed(receipt) {
  fs.writeFileSync(status, JSON.stringify({ version: 1, cards: { M17: { status: 'PASS_LIVE', scope: 'previous real pass' } },
    branches: { 'M17:NO_BONUS_DRAW': { status: 'PASS_LIVE' }, 'M17:BONUS_DRAW': { status: 'PASS_LIVE' } } }));
  fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(receipt)); writes = 0; promotions = 0;
}
try {
  const actual = [
    'archive/autotest/runs/2026-10-07T09-00-27-676Z/game-00001/completed/debug/execution/M12_trade_in/2026-10-07T09-10-05-934Z/result.json',
    'archive/autotest/runs/2026-10-07T09-00-27-676Z/game-00002/completed/debug/execution/M21_chicken_game/2026-10-07T09-20-01-528Z/result.json'
  ].map(relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative))));
  for (const receipt of [...actual, { status: 'PASS', completion: { kind: 'TERMINAL_VICTORY' } },
    { status: 'PASS', outcome: { terminal: true, type: 'VICTORY' } }, { status: 'VOID_AFTER_CONFIRMED_VICTORY' }]) {
    seed(receipt); const before = fs.readFileSync(status, 'utf8');
    for (const method of ['markExecutionPass', 'markExecutionBranchPass', 'markExecutionCardSealed']) assert.equal(api[method](options), null);
    assert.equal(fs.readFileSync(status, 'utf8'), before); assert.equal(writes, 0); assert.equal(promotions, 0); cases++;
  }
  for (const receiptStatus of ['PASS', 'PASS_DRAW_ONLY', 'COMPLETE']) {
    seed({ status: receiptStatus }); assert.equal(api.markExecutionPass(options).status, 'PASS_LIVE');
    assert.equal(api.markExecutionBranchPass(options).status, 'PASS_LIVE'); assert.equal(api.markExecutionCardSealed(options).sealed, true);
    assert.equal(writes, 3); assert.equal(promotions, 3); cases++;
  }
  for (const receipt of [{}, { status: 'FAIL' }, { status: 'UNKNOWN' }]) {
    seed(receipt); const before = fs.readFileSync(status, 'utf8');
    assert.throws(() => api.markExecutionPass(options), /RECEIPT/); assert.equal(writes, 0); assert.equal(promotions, 0);
    assert.equal(fs.readFileSync(status, 'utf8'), before); cases++;
  }
  seed({ status: 'PASS' }); fs.unlinkSync(path.join(evidenceDir, 'result.json'));
  assert.throws(() => api.markExecutionPass(options), /RECEIPT_MISSING/); assert.equal(writes, 0); cases++;
  fs.writeFileSync(path.join(evidenceDir, 'result.json'), '{broken'); assert.throws(() => api.markExecutionPass(options)); assert.equal(writes, 0); cases++;
  console.log('V7_TERMINAL_REGISTRATION_PASS; cases=' + cases + '; real M12/M21 terminal receipts; card/branch/seal cannot promote terminal; prior real PASS unchanged; ordinary valid; missing/corrupt rejected; inputs=0');
} finally {
  if (path.dirname(root) !== base || !path.basename(root).startsWith('md-v7-terminal-registry-') || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_GENERATED_TEST_CLEANUP');
  fs.rmSync(root, { recursive: true });
}
