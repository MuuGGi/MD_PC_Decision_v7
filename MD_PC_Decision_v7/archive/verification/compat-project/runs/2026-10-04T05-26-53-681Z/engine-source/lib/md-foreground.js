const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { clientReport, sleep } = require('./win-fast');
const { locateTemplate } = require('./taskbar-locator');
const { waitForSelfPriorityBlue } = require('./self-priority-gate');

const ROOT = path.join(__dirname, '..');

async function activateViaTaskbar(bridge) {
  const desktop = await bridge.captureDesktop();
  const templatePath = path.join(ROOT, 'templates', 'ui', 'md_taskbar_icon.png');
  if (!fs.existsSync(templatePath)) throw new Error('MD_TASKBAR_TEMPLATE_MISSING');
  const template = PNG.sync.read(fs.readFileSync(templatePath));
  const match = locateTemplate(desktop, template, {
    x: Math.max(0, desktop.width - 900),
    y: Math.max(0, desktop.height - 120),
    width: Math.min(900, desktop.width),
    height: Math.min(120, desktop.height)
  });
  if (!match || match.mad > 0.12) {
    throw new Error(`MD_TASKBAR_ICON_NOT_FOUND: mad=${match ? match.mad.toFixed(4) : 'NONE'}`);
  }
  await bridge.clickScreen(match.centerX, match.centerY);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      const info = await bridge.info();
      if (info.client && info.client.width > 0 && info.client.height > 0) return info;
    } catch (_) {}
  }
  throw new Error('MD_TASKBAR_ACTIVATION_TIMEOUT');
}

function visibilityOverflowPx(report) {
  const d = report.desktop || {};
  const c = report.client || {};
  return {
    left: Math.max(0, -(c.x || 0)),
    top: Math.max(0, -(c.y || 0)),
    right: Math.max(0, ((c.x || 0) + (c.width || 0)) - (d.width || 0)),
    bottom: Math.max(0, ((c.y || 0) + (c.height || 0)) - (d.height || 0))
  };
}

function visibleFraction(report) {
  const d = report.desktop || {};
  const c = report.client || {};
  const left = Math.max(0, c.x || 0);
  const top = Math.max(0, c.y || 0);
  const right = Math.min(d.width || 0, (c.x || 0) + (c.width || 0));
  const bottom = Math.min(d.height || 0, (c.y || 0) + (c.height || 0));
  const visibleW = Math.max(0, right - left);
  const visibleH = Math.max(0, bottom - top);
  const total = Math.max(1, (c.width || 0) * (c.height || 0));
  return (visibleW * visibleH) / total;
}

function practicallyVisible(report, options = {}) {
  if (report.clientFullyVisible) return true;
  const tolerancePx = Number.isFinite(options.maxEdgeOverflowPx) ? options.maxEdgeOverflowPx : 12;
  const minVisibleFraction = Number.isFinite(options.minVisibleFraction) ? options.minVisibleFraction : 0.995;
  const o = visibilityOverflowPx(report);
  const maxOverflow = Math.max(o.left, o.top, o.right, o.bottom);
  return maxOverflow <= tolerancePx && visibleFraction(report) >= minVisibleFraction;
}

async function activateAndVerifyMasterDuel(bridge, options = {}) {
  let activated;
  try {
    activated = await bridge.activateMasterDuel();
  } catch (directError) {
    activated = await activateViaTaskbar(bridge);
  }

  // Windows/DWM can briefly report a maximized client a few pixels outside the
  // desktop while focus/activation settles.  The old exact boundary check made
  // semantic capture fail even though the same game window was usable by the
  // normal observer.  Re-read a few times, then permit only a tiny <=12 px
  // border overflow; large off-screen windows are still rejected.
  let verified = null;
  let report = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    verified = await bridge.info();
    const title = String(verified.title || '').toLowerCase();
    if (!title.includes('masterduel') && !title.includes('master duel')) {
      if (attempt < 6) {
        await sleep(120);
        continue;
      }
      throw new Error(`MASTER_DUEL_ACTIVATION_FAILED: current title=${verified.title || 'UNKNOWN'}`);
    }

    report = clientReport(verified);
    if (report.aspectError <= 0.03 && practicallyVisible(report, options)) break;
    if (attempt < 6) await sleep(120);
  }

  if (!report || report.aspectError > 0.03 || !practicallyVisible(report, options)) {
    const o = report ? visibilityOverflowPx(report) : null;
    const detail = report
      ? `client=${report.client.x},${report.client.y},${report.client.width}x${report.client.height};desktop=${report.desktop.width}x${report.desktop.height};aspectError=${report.aspectError.toFixed(5)};overflow=${o.left},${o.top},${o.right},${o.bottom};visibleFraction=${visibleFraction(report).toFixed(4)};allowedOverflow=${Number.isFinite(options.maxEdgeOverflowPx) ? options.maxEdgeOverflowPx : 12}`
      : 'report=NONE';
    throw new Error(`MASTER_DUEL_CLIENT_UNSAFE_AFTER_ACTIVATION:${detail}`);
  }

  if (!report.clientFullyVisible) {
    const o = visibilityOverflowPx(report);
    console.log(`Master Duel 客户区并非100%位于桌面内，但满足当前任务安全可见性: overflow=${o.left},${o.top},${o.right},${o.bottom}px; visible=${(visibleFraction(report) * 100).toFixed(2)}%`);
  }

  const priority = options.requireSelfPriorityBlue === false
    ? null
    : await waitForSelfPriorityBlue({
      bridge,
      info: verified,
      label: options.priorityLabel || 'AFTER_MASTER_DUEL_ACTIVATION',
      timeoutMs: Number.isFinite(options.priorityTimeoutMs) ? options.priorityTimeoutMs : 15000
    });

  return {
    info: verified,
    report,
    activationTitle: activated && activated.title,
    priority
  };
}

module.exports = { activateAndVerifyMasterDuel };
