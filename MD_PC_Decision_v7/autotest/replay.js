'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { sha } = require('./store');
function replay(directory) {
  const archive = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json')));
  const runs = path.join(__dirname, 'runs'), pruneLog = path.join(runs, 'image-prune-ledger.jsonl');
  const removed = new Map(); let prunedImageCount = 0;
  if (fs.existsSync(pruneLog)) {
    for (const line of fs.readFileSync(pruneLog, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line); removed.set(row.relativePath, row.sha256);
    }
  }
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(archive, rel), outside = path.relative(archive, file);
    if (outside.startsWith('..') || path.isAbsolute(outside)) throw new Error(`REPLAY_HASH_INVALID:${rel}`);
    const runRelative = path.relative(runs, file);
    if (!fs.existsSync(file) && path.extname(file).toLowerCase() === '.png' &&
        !runRelative.startsWith('..') && !path.isAbsolute(runRelative) && removed.get(runRelative.replace(/\\/g, '/')) === expected) {
      prunedImageCount++; continue; // audited image cleanup only; original manifests remain unchanged
    }
    if (sha(file) !== expected) throw new Error(`REPLAY_HASH_INVALID:${rel}`);
  }
  const load = rel => JSON.parse(fs.readFileSync(path.join(archive, rel)));
  const runtime = load('decision-state.json');
  const handPath = path.join(archive, 'debug/hand-change-live/session_state.json');
  if (!fs.existsSync(handPath)) return { status: 'PRE_BASELINE_ARCHIVE', runtime, manifest, prunedImageCount };
  const hand = load('debug/hand-change-live/session_state.json');
  const ledger = load('debug/main-deck-ledger/state.json');
  const library = load('card-library.json');
  const decisionFile = path.join(archive, 'lib/decision-engine.js');
  const nativeRequire = createRequire(decisionFile);
  const deckRemaining = Object.fromEntries(library.cards.filter(card => /^M\d+$/.test(card.id))
    .map(card => [card.id, Math.max(0, card.count - Number(ledger.outsideDeckCounts[card.id] || 0))]));
  // Never invoke the original ledger bootstrap/persist routines or executors.
  const ctx = vm.createContext({ module: { exports: {} }, console,
    require: id => id === './main-deck-ledger' ? { getSharedDeckState: () => ({
      deckRemaining, outsideDeckCounts: ledger.outsideDeckCounts,
      unknownExodiaOutsideCount: ledger.unknownExodiaOutsideCount, ledger }) } : nativeRequire(id) });
  vm.runInContext(fs.readFileSync(decisionFile, 'utf8'), ctx);
  const cards = hand.cards.map(card => ({ ...card, usable: card.id === 'M14' ? runtime.bambooSwordEquipped === true :
    card.id === 'M06' ? runtime.normalSummonUsed !== true : true }));
  const result = ctx.module.exports.collectActions(cards, library, runtime);
  return { status: 'OFFLINE_REPLAY', note: '固定手牌策略候选复盘，不重放物理点击或启动游戏；原子/故障细节查看actions.jsonl及console.log。',
    handRevision: hand.revision, ledgerRevision: ledger.lastHandRevision, prunedImageCount,
    branch: runtime.v5Branch, selected: result.selected, actions: result.actions, holds: result.holds,
    deckRemaining, unknownExodiaOutsideCount: ledger.unknownExodiaOutsideCount, error: manifest.error };
}
if (require.main === module) {
  try { console.log(JSON.stringify(replay(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { replay };
