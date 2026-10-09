'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..'), run = path.resolve(root, '../runs/2026-10-06T08-01-55-531Z');
const library = require('../../card-library.json');
const { planGoldenBambooSetup } = require('../../lib/golden-bamboo-setup-policy');
const { planEquippedBambooContinuation } = require('../../lib/yoto-search-value');
const { chooseEngageTarget } = require('../../lib/engage-policy');
const { analyzeReachableResourceDeadlock } = require('../../lib/deadlock-detector');
const names = Object.fromEntries(library.cards.map(c => [c.id, c.name]));
const cards = ids => ids.map((id, i) => ({ id, index: i + 1, name: names[id] || id, usable: true }));
let remaining;
function collector(file) {
  const native = createRequire(file), ctx = vm.createContext({ module: { exports: {} }, console,
    require: id => id === './main-deck-ledger' ? { getSharedDeckState: () => ({ deckRemaining: remaining,
      outsideDeckCounts: {}, unknownExodiaOutsideCount: 3, ledger: {} }) } : native(id) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx); return ctx.module.exports.collectActions;
}
const current = collector(path.join(root, 'lib/decision-engine.js'));
const old = collector(path.join(run, 'engine-source/lib/decision-engine.js'));
const final = path.join(run, 'game-00004/completed');
const runtime = JSON.parse(fs.readFileSync(path.join(final, 'decision-state.json')));
const hand = JSON.parse(fs.readFileSync(path.join(final, 'debug/hand-change-live/session_state.json')));
const ledger = JSON.parse(fs.readFileSync(path.join(final, 'debug/main-deck-ledger/state.json')));
remaining = Object.fromEntries(library.cards.map(c => [c.id, Math.max(0, c.count - Number(ledger.outsideDeckCounts[c.id] || 0))]));
const held = cards(hand.cards.map(c => c.id));
assert.strictEqual(old(held, library, runtime).selected, null, 'reproduce G4 no decision despite M19+2 Golden+E02');
assert.strictEqual(current(held, library, runtime).selected.id, 'M19');
const malletDir = path.join(final, 'debug/execution/M11_mallet_keep_weapon/2026-10-06T08-27-39-159Z');
const receipt = JSON.parse(fs.readFileSync(path.join(malletDir, 'result.json')));
const returned = receipt.selectionProof.rows.map(row => row.card);
const usedSlots = new Set(returned.map(c => c.originalSlot));
returned.push({ id: 'M11', originalSlot: Array.from({ length: receipt.beforeHandCount }, (_, i) => i + 1).find(i => !usedSlots.has(i)) });
const beforeMallet = cards(returned.sort((a, b) => a.originalSlot - b.originalSlot).map(c => c.id));
assert.strictEqual(old(beforeMallet, library, runtime).selected.id, 'M11', 'actual G4 first Mallet hand: both Goldens and last Yoto shuffled');
const fixed = current(beforeMallet, library, runtime);
assert.strictEqual(fixed.selected.id, 'M19');
assert.strictEqual(fixed.actions.find(a => a.id === 'M11').tier, 100);
assert.strictEqual(analyzeReachableResourceDeadlock({ cards: held, runtime, decisionResult: current(held, library, runtime) }).terminal, false);
for (const node of ['KAGARI_RECOVERY_DONE', 'YOTO_SEARCH_DONE', 'IDLE', 'E10_EFFECT_RESOLVED', 'BRANCH_COMPLETE']) {
  for (const carrierId of ['E02', 'E04', 'E10']) for (const id of ['M19', 'M20']) {
    const state = { ...runtime, v5Branch: { active: false, currentState: node, carrierId } };
    const plan = planGoldenBambooSetup(cards([id, 'M14']), state, { deckRemaining: remaining });
    assert.strictEqual(plan.sword.id, id);
    const choice = current(cards(['M11', id, 'M14']), library, state);
    assert.strictEqual(choice.selected.id, id, 'planning independent of completion label');
  }
}
for (const [ids, state, deck] of [
  [['M19','M14'], { ...runtime, v5Branch: {} }, remaining],
  [['M19'], runtime, remaining], [['M14'], runtime, remaining],
  [['M19','M14'], { ...runtime, bambooSwordEquipped: true }, remaining],
  [['M19','M14'], { ...runtime, v5Branch: { active: true, carrierId: 'E02' } }, remaining],
  [['M19','M14'], { ...runtime, v5Branch: { active: false, currentState: 'DUAL_E10_TARGET_PROMPT', carrierId: 'E02' } }, remaining],
  [['M19','M14'], runtime, { M14: 1 }]
]) assert.strictEqual(planGoldenBambooSetup(cards(ids), state, { deckRemaining: deck }), null);
const occupied = { v5Branch: { carrierId: 'E02' } };
for (const cost of [{}, { M12: 1 }, { M13: 1 }, { M12: 1, M08: 1 }]) {
  const deck = { handCounts: cost, deckRemaining: { M06: 2, M08: 2, M22: 1 } };
  assert.strictEqual(chooseEngageTarget(deck, occupied).id, cost.M12 && !cost.M08 ? 'M08' : 'M06');
  assert.strictEqual(chooseEngageTarget({ ...deck, handCounts: { ...cost, M06: 1 } }, occupied).id, 'M08');
  assert.strictEqual(chooseEngageTarget(deck).id, cost.M12 && !cost.M08 ? 'M08' : 'M06',
    'Oct07: empty without sword uses current draw-fee demand or general Raye');
  assert.strictEqual(chooseEngageTarget({ ...deck, handCounts: { ...cost, M19: 1 } }).id, 'M22',
    'empty-field held sword still demands Hornet carrier');
}
const protectedRaye = planEquippedBambooContinuation({ M14: 1 }, cards(['M14']), {
  runtime: { bambooSwordEquipped: true, equippedBambooId: 'M19', rayeNormalSummoned: true,
    v5Branch: { carrierId: 'M06' } } });
assert.strictEqual(protectedRaye.shouldContinue, false, 'draw held Golden before sacrificing Raye last equip');

async function test() {
  // Actual equip dispatch + accounting + next decision, not planner-only.
  const main = fs.readFileSync(path.join(root, 'runtime/main-v6.js'), 'utf8');
  const slice = (a, b) => main.slice(main.indexOf(a), main.indexOf(b, main.indexOf(a)));
  let saved = structuredClone(runtime), equipped = 0;
  const ctx = vm.createContext({ ROOT: root, path, console: { log() {} },
    planGoldenBambooSetup, planEquippedBambooContinuation,
    ...require('../../lib/true-bamboo-gain-policy'),
    loadDecisionState: () => saved, saveDecisionState: value => { saved = value; },
    cardAtUserSlot: (state, slot) => state.cards[slot - 1], hornetTrueYotoWindPlan: () => null,
    incrementUsedCount: (state, id) => { state.usedCounts[id] = Number(state.usedCounts[id] || 0) + 1; },
    require: id => id.endsWith('recognizer') ? { loadLibrary: () => library } :
      { buildDeckState: () => ({ deckRemaining: remaining, byId: Object.fromEntries(library.cards.map(c => [c.id, c])) }) },
    equipSwordFromHand: async ({ state, cardId }) => {
      equipped++; assert.strictEqual(cardId, 'M19');
      const next = state.cards.filter(c => c.id !== cardId);
      return { state: { ...state, handCount: next.length, cards: cards(next.map(c => c.id)) }, carrier: { id: 'E02' } };
    } });
  vm.runInContext(slice('function commitSwordEquipped(', 'function commitRayeNormalSummonAtomic(') +
    slice('function buildEquippedBambooContinuationPlan(', 'const TRANSACTION_PENDING_NODES') +
    slice('async function executeSelected(', 'function parseCommand('), ctx);
  const next = await ctx.executeSelected({ state: { ...hand, cards: held }, slot: 7 });
  assert.strictEqual(equipped, 1); assert.strictEqual(saved.equippedBambooId, 'M19');
  ctx.normalizeEquippedYotoGoldenDrawPriority(next.state);
  assert.strictEqual(saved.v5Branch.currentState, 'GOLDEN_BAMBOO_DRAW_READY');
  assert.strictEqual(saved.v5Branch.active, false, 'last equipped Yoto is not dispatched as Link material');
  assert.strictEqual(current(next.state.cards, library, saved).selected.id, 'M14');
  const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
  const reader = require('../../lib/duel-log-reader');
  const { buildActivationBlocks } = require('../../lib/duel-log-state');
  const { inspectAtomicDrawResolution } = require('../../lib/atomic-draw-resolution');
  const templates = (await loadTemplates(root, loadLibrary(root))).map(row => ({ ...row.card, image: row.image }));
  const frame = PNG.sync.read(fs.readFileSync(path.join(run, 'game-00001/before-recovery/last-guarded-frame.png')));
  const normal = reader.matchLogCard(frame, { x: 1743, y: 864, width: 51, height: 73 }, templates);
  assert.strictEqual(reader.reliableFaceUpMatch(normal), true);
  assert.strictEqual(reader.reliableFaceUpMatchFromBackCandidate(normal), false, 'old normal early return fails strict back gate');
  const strict = reader.matchLogCard(frame, { x: 1743, y: 864, width: 51, height: 73 }, templates, { backCandidate: true });
  assert.strictEqual(strict.best.id, 'M07'); assert.ok(strict.best.mad < .25);
  assert.ok(normal.best.mad - strict.best.mad >= .10, 'original strong improvement threshold preserved');
  assert.strictEqual(reader.reliableFaceUpMatchFromBackCandidate(strict), true);
  const events = reader.recognizeVisibleCardEvents(frame, { x: 1674, y: 150, width: 348, height: 886 }, 697, templates);
  const { blocks } = buildActivationBlocks(events);
  assert.strictEqual(inspectAtomicDrawResolution({ newOperationBlocks: blocks }, 'M09').ready, true);
  assert.ok(events.some(e => e.type === 'HAND_GAIN' && e.card.id === 'M07'));
  assert.strictEqual(reader.reliableFaceUpMatchFromBackCandidate({ best: { mad: .43, hsvDistance: .8 }, second: { mad: .6 } }), false,
    'genuine card-back threshold not relaxed');
  console.log('OCT06_RESOURCE_PLANNING_OFFLINE_PASS; actual G4 no-decision/Mallet root reproduced; last Yoto+Golden before shuffle across nodes/carriers; held Raye target policy; actual G1 visible Toon strict canonical proof; unchanged card thresholds; no game/state writes');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
