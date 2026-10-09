'use strict';
const fs = require('fs'), path = require('path');
const { readOwnedJson, atomicWriteJson, insidePath } = require('../../../src/core/json-store');
const ROOT = path.resolve(__dirname, '../../..');
// Terminal receipts can prove a newer hand count without committing an ordinary
// observer revision. Keep that evidence separate; never fabricate identities or
// apply it to the gameplay ledger. Unsupported/incomplete receipts stay unknown.
function describeTerminalHandObservation(game, hand) {
  const receipt = game && game.resultProof;
  const proof = receipt && receipt.failureProof;
  const info = proof && proof.info;
  const at = Date.parse(info && info.capturedAt);
  const start = Date.parse(game && game.startedAt), end = Date.parse(game && game.endedAt);
  const baselineAt = Date.parse(receipt && receipt.baseline && receipt.baseline.capturedAt);
  if (game?.outcome !== 'SURRENDER' || receipt?.stage !== 'COMPLETE_SURRENDER' ||
      typeof receipt.executionId !== 'string' || !receipt.executionId.trim() ||
      receipt.result?.status !== 'TERMINAL_SURRENDER' ||
      proof?.status !== 'NO_DARK_ENTIRE_HAND_SENT_TO_GY' ||
      receipt.result.failureProof?.status !== proof.status ||
      info?.status !== 'OK' || info.sideValidation !== 'OK' ||
      info.own?.status !== 'OK' || info.own.handCount !== 0 || info.expected?.own !== 0 ||
      !(info.stableReads >= 2) || info.failSafeTriggered !== false ||
      ![at, start, end, baselineAt].every(Number.isFinite) || at < start || at < baselineAt || at > end) return null;
  return { count: 0, cards: [], capturedAt: info.capturedAt,
    source: 'TERMINAL_RECEIPT_OWN_HAND_COUNT', executionId: receipt.executionId,
    disposition: proof.status, ordinaryObserverCommitted: false,
    lastCommittedRevision: hand && hand.revision,
    note: 'The entire remaining hand was disposed of after the final attempt. The two drawn identities were not observed; the older committed hand is not the surrender hand.' };
}
function report(runDir = null) {
  const latest = readOwnedJson(path.join(ROOT, 'debug/autotest/latest-run.json'));
  const runs = path.join(ROOT, 'archive/autotest/runs');
  const directory = insidePath(runs, path.resolve(runDir || latest && latest.runDir || 'MISSING'));
  const summary = readOwnedJson(path.join(directory, 'summary.json'));
  if (!summary || !Array.isArray(summary.games)) throw new Error('V7_REPORT_SUMMARY_INVALID');
  const games = summary.games.map(game => {
    const gameDir = path.join(directory, 'game-' + String(game.id).padStart(5, '0'));
    const labels = ['completed', 'finish-stopped', 'fatal-stop', 'recovery-stopped', 'before-recovery', 'interrupted'];
    const archiveEvents = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
      .filter(event => event.type === 'ARCHIVE_SAVED' && event.gameId === game.id).reverse();
    const saved = archiveEvents.map(event => ({ label: event.label, path: insidePath(directory, event.path) })).find(row =>
      fs.existsSync(path.join(row.path, 'debug/hand-change-live/session_state.json'))) || labels.map(label => ({ label, path: path.join(gameDir, label) })).find(row =>
      fs.existsSync(path.join(row.path, 'debug/hand-change-live/session_state.json')));
    const hand = saved && readOwnedJson(path.join(saved.path, 'debug/hand-change-live/session_state.json'));
    const runtime = saved && readOwnedJson(path.join(saved.path, 'decision-state.json'));
    const ledger = saved && readOwnedJson(path.join(saved.path, 'debug/main-deck-ledger/state.json'));
    const counts = {};
    for (const card of hand && hand.cards || []) counts[card.id] = (counts[card.id] || 0) + 1;
    const terminalHandObservation = describeTerminalHandObservation(game, hand);
    return { id: game.id, duelId: game.duelId, outcome: game.outcome, errorSurrender: game.errorSurrender === true,
      error: game.error || null, finishError: game.finishError || null, returnedToStarter: game.returnedToStarter === true,
      gems: game.gems, evidence: saved && saved.path,
      lastCommittedHand: hand ? { count: hand.handCount, revision: hand.revision, cards: hand.cards.map(c => ({ id: c.id, name: c.name })), counts } : null,
      terminalHandObservation,
      handNote: game.outcome === 'WIN' ? 'Victory is independently proven; final ordinary draw settlement was voided. This is the last committed hand, not a fabricated final scan.' : terminalHandObservation ? 'A later terminal receipt proves an empty hand. lastCommittedHand is the older pre-attempt baseline, not the surrender hand; drawn identities remain unknown.' : 'Committed hand preserved in final archive; EXODIA_UNKNOWN intentionally stores component class/count only.',
      resources: runtime ? { normalSummonUsed: runtime.normalSummonUsed, fieldSpell: runtime.fieldSpell,
        chickenGameDrawPending: runtime.chickenGameDrawPending, bambooSwordEquipped: runtime.bambooSwordEquipped,
        branch: runtime.v5Branch || null, usedCounts: runtime.usedCounts,
        outsideDeckCounts: ledger && ledger.outsideDeckCounts, unknownExodiaOutsideCount: ledger && ledger.unknownExodiaOutsideCount } : null,
      durationMs: Number.isFinite(Date.parse(game.endedAt)) ? Date.parse(game.endedAt) - Date.parse(game.startedAt) : null };
  });
  return { version: 1, createdAt: new Date().toISOString(), runDir: directory, status: summary.status, totals: summary.totals, games };
}
if (require.main === module) {
  try {
    const result = report(process.argv.slice(2).find(arg => !arg.startsWith('--')));
    if (process.argv.includes('--write')) atomicWriteJson(path.join(result.runDir, 'analysis-report.json'), result);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { console.error(e.stack || e); process.exitCode = 1; }
}
module.exports = { report, describeTerminalHandObservation };
