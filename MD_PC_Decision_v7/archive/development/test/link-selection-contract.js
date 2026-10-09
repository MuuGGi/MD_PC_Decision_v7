'use strict';
// Execute the ACTUAL selector and specific-target caller in an inert VM. Only
// bridge/recognition/wait are fakes; no game, runtime state or native input.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(ROOT, 'engine/execution/core/link-carrier-summon.js'), 'utf8');
const callerSource = fs.readFileSync(path.join(ROOT, 'engine/execution/core/atomic-route-executor.js'), 'utf8');
const { normalizeRecognized } = require('../../../engine/execution/core/recognition-result');
const { chooseBambooLinkTarget } = require('../../../engine/lib/yoto-search-value');
const ALL_LINK_IDS = ['E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10'];
const section = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert(a >= 0 && b > a, 'actual production function missing'); return text.slice(a, b).trim();
};
const selectorBody = section(source, 'async function selectNextLegalLink(', 'async function clickBottomSummonSubmit(');
const specificBody = section(callerSource, 'async function selectSpecificLink(', 'function chooseYellowComponent(');
const points = ids => ids.map((_, i) => ({ x: 891 + i * 158, y: 910, frameProven: true,
  frame: { width: 110, height: 150 }, detector: 'LINK_CANDIDATE_REAL_BLUE_FRAME_V1' }));
let cases = 0;
function model(ids, options = {}) {
  const original = points(ids), current = options.current || original.map(p => ({ ...p, frame: { ...p.frame } }));
  let selected = -1, reads = 0, clicks = 0;
  const bridge = { async click(x) { clicks++; selected = original.findIndex(p => p.x === x); } };
  const context = { require: id => id.includes('yoto-search-value') ? { chooseBambooLinkTarget } : require(id),
    config: { mouseSettleMs: 0 }, normalizeRecognized, isKnownLinkMonsterId: id => ALL_LINK_IDS.includes(id),
    mapReferencePoint: (_info, point) => point, sleep: async () => {}, writeJson: () => {}, path,
    recognizeCurrentCard: async () => ({ judged: { accepted: options.accepted !== false,
      best: { id: reads++ >= ids.length && options.finalId ? options.finalId : ids[selected], name: ids[selected] } } }),
    waitForSummonCandidates: async () => ({ points: current }),
    linkCandidateSignature: ps => ps.map(p => `${Math.round(p.x / 8) * 8},${Math.round(p.y / 8) * 8}`).join('|') };
  if (source.includes('function bindCurrentLinkCandidates(')) context.bindCurrentLinkCandidates = vm.runInNewContext(
    '(' + section(source, 'function bindCurrentLinkCandidates(', 'async function selectNextLegalLink(') + ')', { Number, Math });
  const selectNextLegalLink = vm.runInNewContext('(' + selectorBody + ')', context);
  const selectSpecificLink = vm.runInNewContext('(' + specificBody + ')', { ALL_LINK_IDS, selectNextLegalLink });
  const base = { bridge, info: {}, library: {}, templates: {}, carrierId: 'TOKEN_SKY_STRIKER', promptProof: { points: original } };
  return { specific: targetId => selectSpecificLink({ ...base, targetId }),
    generic: extras => selectNextLegalLink({ ...base, ...extras }),
    counts: () => ({ clicks, reads, selected }) };
}
async function run() {
  const check = async (name, fn) => { await fn(); cases++; console.log('V7_LINK_SELECTION PASS ' + name); };
  if (process.argv.includes('--reproduce-old')) {
    await assert.rejects(model(['E02', 'E04', 'E05']).specific('E02'), /ONLY_EXCLUDED/);
    await assert.rejects(model(['E03', 'E04', 'E05'], { current: points(['E03', 'E04', 'E05']).map((p, i) => ({ ...p, y: p.y - (i === 2 ? 5 : 0) })) }).generic(), /LAYOUT_CHANGED/);
    console.log('OLD_REAL_SELECTOR_REPRODUCED; explicit E02 rejected; same-frame 5px refinement rejected; nativeInputs=0'); return;
  }
  await check('published Fire survives the actual specific-target caller', async () => {
    const m = model(['E02', 'E04', 'E05']), result = await m.specific('E02');
    assert.equal(result.selected.id, 'E02'); assert.equal(m.counts().reads, 1, 'fixed target does not traverse lower goals');
  });
  await check('published Zero is not rescored as a generic non-Fire departure', async () => {
    assert.equal((await model(['E03', 'E10', 'E05']).specific('E10')).selected.id, 'E10');
  });
  await check('published supported target is not replaced by another higher scored identity', async () => {
    assert.equal((await model(['E03', 'E04', 'E05']).specific('E05')).selected.id, 'E05');
  });
  await check('missing published target refuses substitution', async () => {
    await assert.rejects(model(['E03', 'E04']).specific('E02'), /PUBLISHED_TARGET_NOT_AVAILABLE/);
  });
  await check('conflicting exclusion and target is rejected before candidate clicks', async () => {
    const m = model(['E02']);
    await assert.rejects(m.generic({ requestedTargetId: 'E02', excludedLinkIds: ['E02'] }), /TARGET_CONTRACT_INVALID/);
    assert.equal(m.counts().clicks, 0);
  });
  await check('unrecognized identity is not called a missing strategic target', async () => {
    await assert.rejects(model(['E02'], { accepted: false }).specific('E02'), /IDENTITY_UNKNOWN/);
  });
  await check('real G3 5px refinement stays bound to the same physical card', async () => {
    const ids = ['E03', 'E04', 'E05'], current = points(ids).map((p, i) => ({ ...p, y: p.y - (i === 2 ? 5 : 0) }));
    assert.equal((await model(ids, { current }).generic()).selected.id, 'E03');
  });
  await check('generic result is invariant to legal candidate traversal order', async () => {
    for (const ids of [['E05', 'E03', 'E04'], ['E04', 'E05', 'E03']])
      assert.equal((await model(ids).generic()).selected.id, 'E03');
  });
  await check('refreshed detector order cannot redirect an already observed identity', async () => {
    const ids = ['E05', 'E03', 'E04'];
    assert.equal((await model(ids, { current: points(ids).reverse() }).generic()).selected.id, 'E03');
  });
  await check('invalid physical frame dimensions are not usable binding evidence', async () => {
    const ids = ['E03', 'E04'];
    await assert.rejects(model(ids, { current: points(ids).map(p => ({ ...p, frame: { width: NaN, height: 150 } })) }).generic(), /LAYOUT_CHANGED/);
  });
  await check('ambiguous overlapping frame matches refuse binding', async () => {
    const body = section(source, 'function bindCurrentLinkCandidates(', 'async function selectNextLegalLink(');
    const bind = vm.runInNewContext('(' + body + ')');
    const overlapping = points(['E03', 'E04']).map(p => ({ ...p, frame: { width: 500, height: 150 } }));
    assert.equal(bind(overlapping, overlapping), null);
  });
  await check('a changed count is not bound to stale slot indexes', async () => {
    await assert.rejects(model(['E03', 'E04'], { current: points(['E03']) }).generic(), /LAYOUT_CHANGED/);
  });
  await check('large reflow outside the actual card frames rejects stale binding', async () => {
    await assert.rejects(model(['E03', 'E04'], { current: points(['E03', 'E04']).map(p => ({ ...p, x: p.x + 90 })) }).generic(), /LAYOUT_CHANGED/);
  });
  await check('unproven refreshed frame refuses the identity binding', async () => {
    await assert.rejects(model(['E03', 'E04'], { current: points(['E03', 'E04']).map(p => ({ ...p, frameProven: false })) }).generic(), /LAYOUT_CHANGED/);
  });
  await check('final live identity mismatch rejects an otherwise stable frame', async () => {
    await assert.rejects(model(['E03', 'E04'], { finalId: 'E05' }).generic(), /TARGET_CHANGED/);
  });
  console.log(`V7_LINK_SELECTION_CONTRACT_PASS; cases=${cases}; actual production caller+selector; nativeInputs=0/businessWrites=0`);
}
if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { run };
