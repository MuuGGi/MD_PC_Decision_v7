'use strict';
const { STATUS, ready, blocked, unknown } = require('./capability');
async function proveForeground(probe, expected = {}) {
  let info;
  try { info = await probe(); } catch (error) { return unknown('FOREGROUND_PROBE_FAILED', { error: String(error.message || error) }); }
  if (!info || expected.hwnd == null || info.hwnd == null || !info.title || info.foregroundVerified !== true)
    return unknown('FOREGROUND_IDENTITY_NOT_PROVEN');
  if (String(expected.hwnd) !== String(info.hwnd)) return blocked('TARGET_HWND_CHANGED');
  if (!/master\s*duel/i.test(String(info.title)) || (expected.titleIncludes &&
      !String(info.title).toLowerCase().includes(String(expected.titleIncludes).toLowerCase()))) return blocked('TARGET_WINDOW_NOT_FOREGROUND');
  const client = info.client;
  if (!client || !(Number(client.width) > 0) || !(Number(client.height) > 0) ||
      info.clientFullyVisible !== true || !Number.isFinite(info.aspectError)) return unknown('CLIENT_GEOMETRY_NOT_PROVEN');
  if (info.aspectError > Number(expected.maxAspectError ?? 0.03)) return blocked('CLIENT_ASPECT_UNSAFE');
  return ready('FOREGROUND_PROVEN', { hwnd: info.hwnd, title: info.title, client });
}
function maySendInput(foreground, role, capability) {
  return Boolean(foreground && foreground.status === STATUS.READY && role &&
    ['PROVEN', 'READY'].includes(role.status) && capability && capability.status === STATUS.READY);
}
module.exports = { proveForeground, maySendInput };
