'use strict';
const fs = require('fs'), path = require('path');
const { ordinaryPath, pathKey } = require('./path-utils');
// One bounded policy for NEW game archives; historical V6 material is never addressed.
function compactImages(debug, failed) {
  const root = ordinaryPath(debug), rows = [], selected = new Set();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('EVIDENCE_RETENTION_LINK_FORBIDDEN');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) rows.push({ file, relative: path.relative(root, file).replace(/\\/g, '/'), at: fs.statSync(file).mtimeMs });
    }
  }
  if (fs.existsSync(root)) walk(root);
  const hand = path.join(root, 'hand-change-live/session_state.json');
  if (fs.existsSync(hand)) {
    const state = JSON.parse(fs.readFileSync(hand, 'utf8'));
    if (state.handImagePath) {
      const original = ordinaryPath(state.handImagePath), marker = path.sep + 'debug' + path.sep, at = original.lastIndexOf(marker);
      const relocated = at >= 0 ? path.join(root, original.slice(at + marker.length)) : original;
      const candidate = rows.find(row => pathKey(row.file) === pathKey(relocated) || pathKey(row.file) === pathKey(original));
      if (candidate) selected.add(pathKey(candidate.file));
    }
  }
  const newest = (test, count = 1) => rows.filter(row => test(row.relative)).sort((a, b) => b.at - a.at || a.relative.localeCompare(b.relative))
    .slice(0, count).forEach(row => selected.add(pathKey(row.file)));
  newest(relative => /^duel-outcome-live\//.test(relative) && /victory_matched\.png$/.test(relative));
  newest(relative => /settlement_reward_panel\.png$/.test(relative));
  if (failed) {
    newest(relative => /(?:error|failed|uncertain|last-guarded)/i.test(path.basename(relative)) && !/mask|overlay/i.test(relative));
    newest(relative => /^duel-log-live\//.test(relative) && !/mask|roi|title|overlay/i.test(relative));
    const attempts = [...new Set(rows.map(row => row.relative.match(/^execution\/[^/]+\/(2026-[^/]+)\//)).filter(Boolean).map(match => match[0]))]
      .sort((a, b) => b.split('/')[2].localeCompare(a.split('/')[2])).slice(0, 2);
    for (const attempt of attempts) {
      const candidates = rows.filter(row => row.relative.startsWith(attempt) && !/mask|roi|title|overlay|glyph|crop/i.test(row.relative));
      const priority = row => /selected|target|candidate|confirm|current|client|frame|activation/i.test(row.relative) ? 1 : 0;
      candidates.sort((a, b) => priority(b) - priority(a) || b.at - a.at || a.relative.localeCompare(b.relative))
        .slice(0, 2).forEach(row => selected.add(pathKey(row.file)));
    }
  }
  // At most 3 PNGs normally, at most 9 for a failure, plus supervisor's single guarded frame.
  return file => path.extname(String(file)).toLowerCase() !== '.png' || selected.has(pathKey(file));
}
module.exports = { compactImages };
