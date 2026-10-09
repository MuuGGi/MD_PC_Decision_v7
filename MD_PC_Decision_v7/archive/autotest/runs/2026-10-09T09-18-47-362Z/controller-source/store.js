'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ordinaryPath } = require('./path-utils');
const { writeJsonAtomic, appendJsonLine } = require('../engine/lib/runtime-files');
const { summarize } = require('./policy');
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceSnapshotFilter(engine, file) {
  // Node 20 async fs.cp supplies Windows namespaced paths (\\?\...), unlike
  // the plain paths in the old unit test. Normalize BOTH before relative():
  // otherwise parts[0] becomes a drive namespace and all asset PNGs pass.
  const ordinary = ordinaryPath;
  const rel = path.relative(ordinary(engine), ordinary(file)), parts = rel.split(path.sep);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const portable = rel.replace(/\\/g, '/');
  const requiredCalibration = /^templates\/ui\/hand_count_info_\d\.png$/.test(portable) ||
    /^material\/verified\/duel-settlement-0[1-4]-gems-[^/]+\.png$/.test(portable);
  return !parts.includes('debug') && path.basename(file) !== 'decision-state.json' &&
    (requiredCalibration || !(['material', 'materials', 'templates'].includes(parts[0]) && path.extname(file).toLowerCase() === '.png'));
}
function debugImageRetention(debug, failed = false, options = {}) {
  if (options.compact === true) return require('./evidence-retention').compactImages(debug, failed);
  const important = new Set();
  const hand = path.join(debug, 'hand-change-live/session_state.json');
  if (fs.existsSync(hand)) {
    const state = JSON.parse(fs.readFileSync(hand, 'utf8'));
    if (state.handImagePath) {
      const image = path.resolve(state.handImagePath), marker = path.sep + 'debug' + path.sep;
      important.add(image);
      const at = image.lastIndexOf(marker);
      if (at >= 0) important.add(path.join(debug, image.slice(at + marker.length)));
    }
  }
  const attempts = [], execution = path.join(debug, 'execution');
  if (failed && fs.existsSync(execution)) {
    for (const entry of fs.readdirSync(execution, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parent = path.join(execution, entry.name);
      for (const item of fs.readdirSync(parent, { withFileTypes: true })) {
        if (item.isDirectory() && /^2026-/.test(item.name)) attempts.push(path.join(parent, item.name));
      }
    }
  }
  attempts.sort((a,b) => path.basename(b).localeCompare(path.basename(a)));
  const recent = attempts.slice(0, 2);
  return file => {
    if (path.extname(file).toLowerCase() !== '.png') return true;
    const ordinary = ordinaryPath(file), rel = path.relative(debug, ordinary);
    return important.has(ordinary) || /reward|settlement|victory|outcome|last-guarded/i.test(rel) ||
      (failed && (/error|failed|uncertain/i.test(path.basename(ordinary)) || recent.some(dir => ordinary.startsWith(dir + path.sep))));
  };
}
function pruneArchivedDebugImages(directory, failed = false, options = {}) {
  const root = path.resolve(directory), runs = path.resolve(__dirname, '../archive/autotest/runs');
  const relative = path.relative(runs, root);
  if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !['runtime-debug', 'previous-isolated-debug'].includes(path.basename(root))) {
    throw new Error('IMAGE_PRUNE_OUTSIDE_ARCHIVED_DEBUG');
  }
  const keep = debugImageRetention(root, failed, options); let files = 0, bytes = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('IMAGE_PRUNE_REPARSE_POINT');
      if (entry.isDirectory()) {
        walk(file);
        if (fs.readdirSync(file).length === 0) fs.rmdirSync(file); // archived, empty, non-recursive only
      }
      else if (entry.isFile() && !keep(file)) {
        bytes += fs.statSync(file).size; fs.unlinkSync(file); files++;
      }
    }
  }
  walk(root); return { files, bytes };
}
function snapshot(engine, destination, metadata = {}) {
  fs.mkdirSync(destination, { recursive: true });
  const manifest = { capturedAt: new Date().toISOString(), ...metadata, files: {} };
  for (const rel of ['decision-state.json', 'debug', 'material/verified/verified-cards.json']) {
    const file = path.join(engine, rel);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(destination, rel), { recursive: true,
      ...(rel === 'debug' ? { filter: debugImageRetention(file, Boolean(metadata.error), { compact: metadata.compactImages === true }) } : {}) });
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else manifest.files[path.relative(destination, file).replace(/\\/g, '/')] = sha(file);
    }
  }
  walk(destination);
  writeJsonAtomic(path.join(destination, 'manifest.json'), manifest);
  return manifest;
}
class TestStore {
  constructor(runDir, options = {}) {
    this.runDir = runDir;
    this.options = options;
    fs.mkdirSync(runDir, { recursive: true });
    if (options.resume) {
      this.state = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
      return; // Opening a recovery store is read-only until GUI preflight passes.
    }
    this.state = { version: 1, timezone: 'Asia/Shanghai', initialGems: 0,
      createdAt: new Date().toISOString(), status: 'READY', games: [] };
    this.save();
  }
  save() {
    this.state.totals = summarize(this.state.games); writeJsonAtomic(path.join(this.runDir, 'summary.json'), this.state);
    if (this.options.statisticsPath) {
      const sessions = [], games = [];
      for (const entry of fs.readdirSync(this.options.aggregateDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(this.options.aggregateDir, entry.name, 'summary.json');
        if (!fs.existsSync(file)) continue;
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Recompute the view under the current definition (including finish
        // errors), without rewriting any historical session summary.
        sessions.push({ id: entry.name, status: state.status, totals: summarize(state.games) });
        games.push(...state.games);
      }
      writeJsonAtomic(this.options.statisticsPath, { version: 1, timezone: 'Asia/Shanghai', initialGems: 0,
        updatedAt: new Date().toISOString(), totals: summarize(games), sessions });
    }
  }
  event(type, details = {}) { appendJsonLine(path.join(this.runDir, 'events.jsonl'), { at: new Date().toISOString(), type, ...details }); }
  begin() {
    const game = { id: this.state.games.length + 1, startedAt: new Date().toISOString(), duelStarted: false, outcome: null, gems: null };
    this.state.games.push(game); this.state.status = 'RUNNING'; this.save(); this.event('GAME_STARTED', { gameId: game.id });
    return game;
  }
  resumeInterruptedGame(id) {
    const game = this.state.games.at(-1);
    if (!game || game.id !== id || game.outcome !== 'INTERRUPTED' || game.duelStarted !== true) {
      throw new Error('AUTOTEST_RESUME_GAME_NOT_INTERRUPTED');
    }
    game.resumeHistory = [...(game.resumeHistory || []), { outcome: game.outcome,
      endedAt: game.endedAt, error: game.error, resumedAt: new Date().toISOString() }];
    if (game.error && require('./policy').classifyFailure(new Error(game.error)) === 'STOP_TEST') delete game.error;
    game.outcome = null; delete game.endedAt; delete game.testInterrupted;
    this.state.status = 'RUNNING'; this.save(); this.event('GAME_RESUMED', { gameId: id });
    return game;
  }
  finish(game, outcome, details = {}) {
    if (game.outcome && game.outcome !== outcome) throw new Error('AUTOTEST_OUTCOME_ALREADY_COMMITTED');
    Object.assign(game, details, { outcome, endedAt: game.endedAt || new Date().toISOString() });
    this.save(); this.event('GAME_FINISHED', { gameId: game.id, outcome, gems: game.gems });
  }
}
module.exports = { TestStore, snapshot, stamp, sha, sourceSnapshotFilter, debugImageRetention, pruneArchivedDebugImages };
