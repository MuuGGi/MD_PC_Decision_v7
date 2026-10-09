'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, 'engine');
const RUN = path.join(__dirname, 'runs/2026-10-03T09-11-09-557Z');
const readJson = file => JSON.parse(fs.readFileSync(file));
const copy = value => JSON.parse(JSON.stringify(value));
const snapshot = n => path.join(RUN, `game-${String(n).padStart(5, '0')}`, n === 2 ? 'completed' : 'before-recovery');
const { proveKnownMultiGainBlocks } = require('./engine/lib/known-multi-gain-proof');
const modal = require('./engine/execution/core/m13-banish-selection');
const { cropImage } = require('./engine/lib/png-utils');
const reader = require('./engine/lib/duel-log-reader');
const recognizer = require('./engine/lib/recognizer');

async function test() {
  const protectedFiles = [1, 2, 3, 4, 5].flatMap(n => [
    'decision-state.json', 'debug/hand-change-live/session_state.json', 'debug/main-deck-ledger/state.json'
  ].map(rel => path.join(snapshot(n), rel)));
  const before = protectedFiles.map(file => [file, fs.readFileSync(file, 'utf8')]);
  const pair = [{ activationKey: 'E10', id: 'M17' }, { activationKey: 'M19', id: 'M14' }];
  const log = readJson(path.join(snapshot(1), 'debug/duel-log-live/latest_result.json'));
  assert.strictEqual(proveKnownMultiGainBlocks(log.operationBlocks, pair).mode,
    'PROVEN_M19_CL1_E10_CL2_RESOLUTION_TAIL');
  for (const mutate of [
    b => b.shift(), b => b.reverse(), b => b[1].details.reverse(),
    b => b[1].details.push(copy(b[1].details[1])),
    b => { b[1].details[1].card.id = 'M15'; },
    b => { b[1].details[1].side = 'OPPONENT'; },
    b => b.push({ activationKey: 'M09', details: [] })
  ]) { const bad = copy(log.operationBlocks); mutate(bad); assert.strictEqual(proveKnownMultiGainBlocks(bad, pair).pass, false); }

  const full = n => PNG.sync.read(fs.readFileSync(path.join(snapshot(n), 'last-guarded-frame.png')));
  const strip = cropImage(full(3), modal.M13_BANISH_PROMPT.candidateRoi);
  assert.strictEqual(modal.detectM13DialogBounds(strip).width, 1010);
  const points = modal.detectM13BanishCandidateCenters(strip);
  assert.deepStrictEqual(points.map(p => p.x), [596, 754, 912, 1070, 1228, 1386]);
  for (const n of [1, 4, 5]) assert.strictEqual(modal.detectM13BanishCandidateCenters(
    cropImage(full(n), modal.M13_BANISH_PROMPT.candidateRoi)).length, 0, 'ordinary hand/field is not a modal');
  const history = path.join(ROOT, 'material/verified/evidence/M13_allure_of_darkness');
  let historicalCases = 0;
  for (const item of fs.readdirSync(history)) {
    const file = path.join(history, item, 'm13_banish_candidates_stable.png');
    if (!fs.existsSync(file)) continue;
    assert.ok(modal.detectM13BanishCandidateCenters(PNG.sync.read(fs.readFileSync(file))).length > 0);
    historicalCases++;
  }
  assert.ok(historicalCases >= 10);

  const library = recognizer.loadLibrary(ROOT);
  const templates = (await recognizer.loadTemplates(ROOT, library)).map(t => ({ ...t.card, image: t.image }));
  const badBox = { x: 1743, y: 875, width: 51, height: 61 };
  const repaired = reader.matchLogCard(full(5), badBox, templates);
  assert.strictEqual(repaired.best.id, 'M04');
  assert.ok(repaired.best.mad < 0.25 && repaired.second.mad - repaired.best.mad >= 0.08);
  assert.deepStrictEqual(repaired.correctedBox, { x: 1745, y: 861, width: 47, height: 67 });
  const events = reader.recognizeVisibleCardEvents(full(5), { x: 1674, y: 150, width: 348, height: 886 }, 150, templates);
  assert.ok(events.some(e => e.card.id === 'M04'));
  assert.ok(!events.some(e => e.type === 'HAND_GAIN' && e.card.id === 'E02'));

  let saved = readJson(path.join(snapshot(4), 'decision-state.json'));
  let hand = readJson(path.join(snapshot(4), 'debug/hand-change-live/session_state.json'));
  let remaining = {};
  const ledger = readJson(path.join(snapshot(4), 'debug/main-deck-ledger/state.json'));
  for (const c of library.cards.filter(c => /^M\d+$/.test(c.id))) remaining[c.id] = c.count - (ledger.outsideDeckCounts[c.id] || 0);
  const engineFile = path.join(ROOT, 'lib/decision-engine.js');
  const native = createRequire(engineFile);
  const engineContext = vm.createContext({ module: { exports: {} }, console, require: id => id === './main-deck-ledger'
    ? { getSharedDeckState: () => ({ deckRemaining: remaining, outsideDeckCounts: {}, ledger: {} }) } : native(id) });
  vm.runInContext(fs.readFileSync(engineFile, 'utf8'), engineContext);
  const decision = engineContext.module.exports;
  const mainFile = path.join(ROOT, 'runtime/main-v6.js'), source = fs.readFileSync(mainFile, 'utf8');
  const main = vm.createContext({ ROOT, path, console,
    loadDecisionState: () => saved, isStrategicallyUsable: () => true,
    buildLastResortAllureAction: () => null,
    knownNonRayeMonsterPresent: () => /^E/.test(saved.v5Branch?.carrierId || ''),
    adjustedMainDeckRemainingCount: require('./engine/lib/exodia-policy').adjustedMainDeckRemainingCount,
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library }
      : id.endsWith('decision-engine') ? decision : require(id)
  });
  vm.runInContext(source.slice(source.indexOf('function buildDecisionSuggestion('), source.indexOf('function shortExtraForDecision(')), main);
  const decide = () => main.buildDecisionSuggestion(hand);
  assert.strictEqual(decide().selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
  const original = copy(saved);
  for (const mutation of [
    s => { s.normalSummonUsed = true; }, s => { s.bambooSwordEquipped = true; },
    s => { s.v5Branch.active = true; }, s => { s.v5Branch.carrierId = 'E10'; },
    s => { s.v5Branch.currentState = 'M20_FIELD_EFFECT_ACTIVATED'; },
    s => { s.effectUsage.E10_SUMMON = 1; }, s => { s.graveSpellCount = 2; }
  ]) { saved = copy(original); mutation(saved); assert.notStrictEqual(decide().selected?.details?.phase,
    'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY', 'unsafe/in-flight/used Zero route stays unavailable'); }
  saved = copy(original);
  saved.usedCounts.M17 = 0;
  assert.strictEqual(decide().selected.details.e10EngageSource, 'DECK', 'real Deck Engage is also a valid proven closeout');
  const savedDeckEngage = remaining.M17;
  remaining.M17 = 0;
  assert.notStrictEqual(decide().selected?.details?.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
  remaining.M17 = savedDeckEngage;
  saved = copy(original);
  hand = { ...hand, cards: [...hand.cards, { id: 'M11', name: '万宝槌', index: 7, usable: true }], handCount: 7 };
  saved.usedCounts.M11 = 1;
  assert.strictEqual(decide().selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY',
    'latest rule: productive double Zero precedes shuffle when no sword departure remains');
  // Golden stock no longer hard-gates this productive double-material route.
  hand.cards = hand.cards.filter(c => c.id !== 'M14').concat([{ id: 'M14', name: '金黄色的竹光', index: 4 }]);
  hand.cards.forEach((c, i) => { c.index = i + 1; }); hand.handCount = hand.cards.length;
  remaining.M14 = 1;
  assert.strictEqual(decide().selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
  remaining.M14 = 2;
  assert.strictEqual(decide().selected.details.phase, 'RAYE_DOUBLE_LINK_E10_ENGAGE_RECOVERY');
  for (const [file, content] of before) assert.strictEqual(fs.readFileSync(file, 'utf8'), content,
    'read-only archived states are unchanged');
  console.log(`FAILURE_REGRESSIONS_PASS; actual dual gains, wide Allure+${historicalCases} historical layouts, M04 same-frame recrop, G4 production suggestion, Mallet/last-equip/pending/used-Zero guards; GUI_INPUTS=0`);
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { test };
