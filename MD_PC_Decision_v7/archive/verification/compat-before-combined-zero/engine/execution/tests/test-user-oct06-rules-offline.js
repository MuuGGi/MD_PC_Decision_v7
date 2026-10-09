'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { describeE10EngageSources, selectE10EngageCandidate } = require('../../lib/e10-engage-source-policy');
const { describeDoubleLinkSwordReadiness, chooseEquippedRayeLink } = require('../../lib/double-link-policy');
const { describeRayeCloseout } = require('../../lib/raye-closeout-policy');
const { playOne } = require('../../../session');
const { summarize, classifyFailure } = require('../../../policy');
const { isCurrentStrictVictory } = require('../../../runner');
const root = path.resolve(__dirname, '../..');
const cards = ids => ids.map(id => ({ id, index: 1 }));
const deck = { deckRemaining: { M06: 1, M17: 1, M14: 1, M20: 1, M09: 2 } };
const runtime = { usedCounts: { M17: 2 }, graveSpellCount: 4,
  effectUsage: {}, rayeNormalSummoned: true, bambooSwordEquipped: true, equippedBambooId: 'M19',
  v5Branch: { currentState: 'M19_EQUIPPED', carrierId: 'E02' } };
for (const count of [0, 1, 2, 3, 4]) {
  const held = cards(Array(Math.max(0, count - 1)).fill('M08'));
  const d = { deckRemaining: { M06: count ? 1 : 0, M17: 1 } };
  const policy = describeE10EngageSources(d, held, runtime);
  assert.strictEqual(policy.handPlusDeckStrikerCount, count);
  assert.strictEqual(policy.preferredSource, count <= 2 ? 'GRAVE' : 'DECK');
  assert.strictEqual(policy.deckEngagePreferred, count > 2);
}
const scarce = describeE10EngageSources(deck, cards(['M08']), runtime);
assert.strictEqual(scarce.preferredSource, 'GRAVE', 'one Deck + one hand target');
assert.strictEqual(scarce.searchableComponentRemaining, 1, 'hand holdings never fake a legal Deck target');
assert.strictEqual(describeE10EngageSources(deck, [], {}).deckEngagePreferred, false);
assert.strictEqual(describeE10EngageSources(deck, [], {}).preferredSource, 'DECK', 'no GY: fallback only');
const candidates = [1200, 800, 1000].map(x => ({ reference: { x, y: 950 }, recognized: { accepted: true, id: 'M17' } }));
assert.strictEqual(selectE10EngageCandidate(candidates, scarce).reference.x, 800, 'GY first, independent of scan order');
assert.strictEqual(selectE10EngageCandidate(candidates, { ...scarce, preferredSource: 'DECK' }).reference.x, 1200, 'skip TWO GY copies');
assert.throws(() => selectE10EngageCandidate(candidates.slice(1), scarce), /SOURCE_COUNT_MISMATCH/);
assert.throws(() => selectE10EngageCandidate(candidates, { ...scarce, engageInGrave: 0 }), /SOURCE_COUNT_MISMATCH/);
assert.strictEqual(describeDoubleLinkSwordReadiness([], { ...runtime, usedCounts: { M19: 1 } }, deck).ready, false,
  'equipping M19 is not a GY receipt');
assert.strictEqual(chooseEquippedRayeLink([], runtime, deck, { shouldLink: true }).answer, '1');
for (const receipt of [{ equipSentToGraveCount: 1 }, { effectUsage: { M19_SEARCH: 1 } },
  { v5Branch: { ...runtime.v5Branch, source: 'FORMAL_V5_T20_3_REPEATABLE_M19' } }]) {
  assert.strictEqual(chooseEquippedRayeLink([], { ...runtime, ...receipt }, deck, { shouldLink: true }).answer, '2');
}
assert.strictEqual(chooseEquippedRayeLink([], { ...runtime, usedCounts: { M17: 2, M20: 1 } }, deck,
  { shouldLink: true }).answer, '1', 'usedCounts alone cannot prove True was sent to GY either');
const ready = { ...runtime, equipSentToGraveCount: 1 };
for (const mutation of [{ effectUsage: { E10_SUMMON: 1 } }, { rayeNormalSummoned: false },
  { v5Branch: { carrierId: 'E10' } }, { v5Branch: { carrierId: 'E02', kagariSwordLink: true } }]) {
  assert.strictEqual(chooseEquippedRayeLink([], { ...ready, ...mutation }, deck, { shouldLink: true }).answer, '1');
}
assert.strictEqual(chooseEquippedRayeLink([], ready, deck, { shouldLink: false }).answer, '1', 'last-equip gate remains');
assert.strictEqual(chooseEquippedRayeLink([], ready, { deckRemaining: { M06: 1, M17: 1 } }, { shouldLink: true }).answer, '1', 'no capacity for both searches/draw');
const clean = { ...runtime, bambooSwordEquipped: false, normalSummonUsed: false, rayeNormalSummoned: false,
  v5Branch: { active: false, currentState: 'YOTO_SEARCH_DONE', carrierId: 'E02' } };
const result = { deck, engageTargets: [{ id: 'M06', remaining: 1 }] };
assert.strictEqual(describeRayeCloseout(cards(['M06', 'M19']), clean, result).ready, false, 'finish productive sword plan first');
assert.strictEqual(describeRayeCloseout(cards(['M06', 'M19']), { ...clean, equipSentToGraveCount: 1 }, result).ready, false,
  'historical departure cannot erase a current productive sword plan');
assert.strictEqual(describeRayeCloseout(cards(['M06']), clean, result).source, 'GRAVE', '2 targets -> GY in recommender too');

async function test() {
  // Production selection flow (not just the helper); all GUI operations mocked.
  const source = fs.readFileSync(path.join(root, 'execution/core/atomic-route-executor.js'), 'utf8');
  const segment = source.slice(source.indexOf('async function selectPreferredSkyStrikerTarget('), source.indexOf('function currentE10EngageSourcePolicy('));
  for (const preferredSource of ['GRAVE', 'DECK']) {
    let selected, submits = 0;
    const points = [800, 1000, 1200].map(x => ({ x, y: 950 }));
    const context = vm.createContext({ console: { log() {} }, config: {}, selectE10EngageCandidate,
      waitSkyTargetPrompt: async () => ({ candidateCount: 3 }), waitForStableSkyTargetPoints: async () => points,
      recognizeSelectedAt: async ({ reference }) => { selected = reference; return { accepted: true, id: 'M17', name: '交闪' }; },
      mapReferencePoint: (_, point) => point, sleep: async () => {}, normalizeRecognized: x => x,
      recognizeCurrentCard: async () => ({ accepted: true, id: 'M17' }), waitBeforePromptSubmit: async () => {},
      confirmGenericSearch: async () => { submits++; } });
    vm.runInContext(segment, context);
    const proof = await context.selectPreferredSkyStrikerTarget({ info: {},
      bridge: { click: async (x, y) => { selected = { x, y }; } }, engageSourcePolicy: { ...scarce, preferredSource } });
    assert.strictEqual(proof.selectedSource, preferredSource);
    assert.strictEqual(selected.x, preferredSource === 'GRAVE' ? 800 : 1200);
    assert.strictEqual(submits, 1);
  }
  function harness(options = {}) {
    const calls = [], game = { id: 1 }; let stopped = false;
    const store = { begin: () => game, save() {}, finish: (_, outcome, details = {}) => Object.assign(game, details, { outcome }) };
    const adapters = { stopped: () => stopped, start: async () => { if (options.startFails) throw new Error('START_UNKNOWN'); },
      waitMain1: async () => {}, play: async () => { throw new Error('FIRST_UNKNOWN'); },
      archive: async (_, label) => { calls.push(label); if (options.stopArchive) stopped = true; },
      observeEnd: async () => { if (options.observeFails) throw new Error('FOREGROUND_LOST'); return options.end || null; },
      surrender: async () => { calls.push('surrender'); if (options.cleanupFails) throw new Error(options.cleanupFails);
        return { outcome: options.lateEnd || 'SURRENDER', proven: !options.unproven }; },
      finishBoard: async () => { calls.push('Starter'); if (options.returnFails) throw new Error('RETURN_UNKNOWN'); return { gems: 0 }; } };
    return { calls, game, store, adapters };
  }
  const normal = harness();
  assert.strictEqual((await playOne(normal.store, normal.adapters)).stop, false);
  assert.deepStrictEqual(normal.calls, ['before-recovery', 'surrender', 'Starter', 'completed']);
  assert.strictEqual(summarize([normal.game]).errorSurrenders, 1);
  for (const options of [{ stopArchive: true }, { observeFails: true }, { startFails: true }]) {
    const h = harness(options); assert.strictEqual((await playOne(h.store, h.adapters)).stop, true);
    assert.ok(!h.calls.includes('surrender'));
  }
  for (const options of [{ cleanupFails: 'GEAR_NOT_PROVEN' }, { cleanupFails: 'MOUSE_INTERFERENCE' }, { unproven: true }]) {
    const h = harness(options); assert.strictEqual((await playOne(h.store, h.adapters)).stop, true);
    assert.strictEqual(h.calls.filter(x => x === 'surrender').length, 1);
    assert.ok(h.game.error.includes('FIRST_UNKNOWN')); assert.ok(h.game.recoveryError);
    assert.strictEqual(h.game.errorSurrender, undefined);
  }
  const failedReturn = harness({ returnFails: true });
  assert.strictEqual((await playOne(failedReturn.store, failedReturn.adapters)).stop, true);
  assert.strictEqual(failedReturn.game.outcome, 'SURRENDER'); assert.strictEqual(failedReturn.game.returnedToStarter, undefined);
  for (const outcome of ['WIN', 'LOSS']) {
    const h = harness({ end: { outcome, proven: true } });
    assert.strictEqual((await playOne(h.store, h.adapters)).stop, false); assert.ok(!h.calls.includes('surrender'));
    const late = harness({ lateEnd: outcome });
    assert.strictEqual((await playOne(late.store, late.adapters)).stop, false);
    assert.strictEqual(late.game.outcome, outcome); assert.strictEqual(late.game.errorSurrender, undefined);
  }
  assert.strictEqual(classifyFailure(new Error('V6_RUNTIME_SOURCE_CHANGED_RESTART_REQUIRED')), 'STOP_TEST');
  assert.strictEqual(classifyFailure(new Error('NODE_VERSION_MISMATCH')), 'STOP_TEST');
  const game = { startedAt: '2026-10-06T01:00:00Z' }, win = { terminal: true, type: 'VICTORY',
    checkedAt: game.startedAt, strictEvidence: { reasonText: { matched: true }, exodiaLastFive: { matched: true } } };
  assert.strictEqual(isCurrentStrictVictory(game, win), true);
  assert.strictEqual(isCurrentStrictVictory(game, { ...win, checkedAt: '2026-10-05T01:00:00Z' }), false);
  assert.strictEqual(isCurrentStrictVictory(game, { ...win, checkedAt: undefined }), false);
  // Run the actual supervisor cleanup adapter, including passive recheck and
  // exclusion of Starter/settlement. Native surrender is replaced, not run.
  const runner = fs.readFileSync(path.resolve(root, '../runner.js'), 'utf8');
  const adapterSource = runner.slice(runner.indexOf('      surrender: async game => {'), runner.indexOf('      start: async game => {'));
  for (const options of [{ page: 'UNKNOWN' }, { page: 'MAIN1' }, { page: 'STARTER' },
    { page: 'SETTLEMENT' }, { page: 'UNKNOWN', status: 'FAILED' }, { end: { outcome: 'WIN', proven: true } },
    { safety: true }]) {
    const calls = [], context = vm.createContext({ path, currentDir: 'mock', bridge: {},
      safe: async () => { if (options.safety) throw new Error('FOREGROUND_LOST'); },
      observeEnd: async () => options.end || null, lastFrame: { image: {} },
      ui: { classifyPage: () => ({ page: options.page || 'UNKNOWN' }) },
      store: { event: type => calls.push(type) }, surrender: { runConfirmedDeadlockSurrender: async () => {
        calls.push('native-adapter'); return { status: options.status || 'SURRENDER_COMPLETE' }; } } });
    const adapter = vm.runInContext(`({ ${adapterSource} })`, context);
    if (options.safety || ['STARTER', 'SETTLEMENT'].includes(options.page) || options.status === 'FAILED') {
      await assert.rejects(() => adapter.surrender({ id: 1, error: 'FIRST_UNKNOWN' }));
    } else {
      const result = await adapter.surrender({ id: 1, error: 'FIRST_UNKNOWN' });
      assert.strictEqual(result.outcome, options.end ? 'WIN' : 'SURRENDER');
    }
    const shouldSurrender = !options.safety && !options.end && !['STARTER', 'SETTLEMENT'].includes(options.page);
    assert.strictEqual(calls.includes('native-adapter'), shouldSurrender);
  }
  const main = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
  assert.match(main, /chooseEquippedRayeLink\(state.cards, runtime,/);
  assert.match(main, /equipSentToGraveCount = Number\(after.equipSentToGraveCount/);
  assert.match(main, /equipSentToGraveCount = Number\(runtime.equipSentToGraveCount/);
  // A proven policy-only transition is progress, not an unknown executor:
  // canceling Y1 to preserve the last equip must not cause error surrender.
  const block = main.slice(main.indexOf('    if (!linkPlan.shouldContinue) {'), main.indexOf('    if (branch.kagariSwordLink === true) {', main.indexOf('    if (!linkPlan.shouldContinue) {')));
  const h = vm.createContext({ runtime: {}, branch: {}, state: { cards: [{ id: 'M14' }] },
    linkPlan: { shouldContinue: false, fieldId: 'M19', equipResources: {} }, saveDecisionState() {}, console: { log() {} } });
  const noLink = vm.runInContext(`(function() { ${block} })()`, h);
  assert.strictEqual(noLink.executed, true); assert.strictEqual(noLink.savedObservationOnly, true);
  console.log('USER_OCT06_RULES_OFFLINE_PASS; hand+Deck targets1/2/3; GY-first exact source selection; equip activation not departure; shared double Link; archive/error surrender/Starter; no blind retry; nativeInputs0/liveStateWrites0');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
