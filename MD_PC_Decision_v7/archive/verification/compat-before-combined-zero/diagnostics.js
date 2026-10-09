'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');
const { writeJsonAtomic } = require('./engine/lib/runtime-files');

// Reuse an ALREADY captured, post-guard-verified full client. Small hand ROIs
// never trigger disk writes. One atomic rolling artifact, no image history.
function recordGuardedFullCapture(file, command, result, options = {}) {
  if (!file || command.cmd !== 'captureRoi' || command.x !== 0 || command.y !== 0 ||
      result?.guardedCapture !== true || !result.pngBase64 || !result.client ||
      command.width !== result.client.width || command.height !== result.client.height ||
      !Number.isFinite(Date.parse(result.capturedAt)) || !result.hwnd || !result.pid) return false;
  writeJsonAtomic(file, { version: 1, capturedAt: result.capturedAt, guardedCapture: true,
    producerPid: options.pid ?? process.pid, command: command.cmd, hwnd: result.hwnd, pid: result.pid,
    title: result.title, client: result.client, width: result.width, height: result.height,
    pngBase64: result.pngBase64 });
  return true;
}

function readRollingFrame(file, game, fallback, now = Date.now()) {
  let selected = fallback ? { ...fallback, source: 'SUPERVISOR_LAST_SAFE_FRAME' } : null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Date.parse(value.capturedAt), start = Date.parse(game.startedAt);
    if (value.version === 1 && value.guardedCapture === true && Number.isFinite(start) &&
        Number.isFinite(at) && at >= start && at <= now &&
        (!selected || at > Date.parse(selected.at)) && value.width === value.client?.width &&
        value.height === value.client?.height && value.hwnd && value.pid) {
      const image = PNG.sync.read(Buffer.from(value.pngBase64, 'base64'));
      if (image.width !== value.width || image.height !== value.height) throw new Error('ROLLING_FRAME_SIZE_MISMATCH');
      selected = { image, at: value.capturedAt, source: 'EXECUTOR_LAST_SAFE_FULL_CLIENT',
        hwnd: value.hwnd, pid: value.pid, producerPid: value.producerPid };
    }
  } catch (_) { /* Diagnostic damage must not authorize another GUI capture. */ }
  const ageMs = selected ? Math.max(0, now - Date.parse(selected.at)) : null;
  return { selected, evidence: { source: selected?.source || 'NO_GUARDED_FRAME', capturedAt: selected?.at || null,
    ageMs, freshness: !selected ? 'MISSING' : ageMs <= 10000 ? 'RECENT_LAST_SAFE_FRAME' : 'STALE_LAST_SAFE_FRAME',
    isFailureMomentScreenshot: false, hwnd: selected?.hwnd ?? null, pid: selected?.pid ?? null } };
}
module.exports = { recordGuardedFullCapture, readRollingFrame };
