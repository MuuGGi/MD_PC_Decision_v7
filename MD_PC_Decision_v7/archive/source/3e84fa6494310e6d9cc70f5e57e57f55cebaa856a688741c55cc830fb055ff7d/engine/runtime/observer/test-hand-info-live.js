const fs = require('fs');
const path = require('path');
const { validateMasterDuelClient } = require('../../lib/live-client-guard');
const { PNG } = require('pngjs');
const config = require('../../live-config');
const {
  MdFastBridge,
  sleep,
  mapReferencePoint,
  captureReferenceRoi
} = require('../../lib/win-fast');
const {
  getInfoHandCountRoi,
  loadInfoDigitTemplates,
  recognizeInfoHandCount,
  readOwnHandCountFromInfoOverlay,
  readOpponentHandCountFromInfoOverlay,
  validateInfoHandCountSides,
  writePngSync
} = require('../../lib/hand-info-overlay');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');

const ROOT = path.resolve(__dirname, '..', '..');
const MANUAL_DEBUG_DIR = path.join(ROOT, 'debug', 'hand-info-live');
const AUTO_DEBUG_DIR = path.join(ROOT, 'debug', 'hand-info-auto-hold');

function readOptions(argv) {
  const readValue = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? Number(argv[index + 1]) : null;
  };
  return {
    autoHoldI: argv.includes('--auto-hold-i'),
    expected: { own: readValue('--own'), opponent: readValue('--opponent') }
  };
}

function toPng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return png;
}

function cropImage(image, rect) {
  const out = new PNG({ width: rect.width, height: rect.height });
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const src = ((rect.y + y) * image.width + rect.x + x) * 4;
      const dst = (y * rect.width + x) * 4;
      image.data.copy(out.data, dst, src, src + 4);
    }
  }
  return out;
}

function localRoi(roi) {
  return { x: 0, y: 0, width: roi.width, height: roi.height };
}

function recognitionSummary(result) {
  return {
    handCount: result.status === 'OK' ? result.handCount : null,
    status: result.status,
    confidence: result.handCountConfidence || 0,
    sourceBoxes: result.sourceBoxes || []
  };
}

function validateClient(info) {
  return validateMasterDuelClient(info, {
    errorMessage: 'MD client size, aspect ratio, or visibility is invalid.'
  });
}

async function countdown() {
  for (let seconds = 5; seconds >= 1; seconds--) {
    console.log(`${seconds} seconds until capture; switch to Master Duel now.`);
    await sleep(1000);
  }
}

async function captureFullClient(bridge, info) {
  return captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: config.screen.width,
    height: config.screen.height
  });
}

async function readOverlayRois(bridge, info, templates) {
  const ownRoi = getInfoHandCountRoi('OWN');
  const opponentRoi = getInfoHandCountRoi('OPPONENT');
  const ownImage = await captureReferenceRoi(bridge, info, ownRoi);
  const opponentImage = await captureReferenceRoi(bridge, info, opponentRoi);
  return {
    ownImage,
    opponentImage,
    own: recognizeInfoHandCount(ownImage, {
      side: 'OWN',
      roi: localRoi(ownRoi),
      templates
    }),
    opponent: recognizeInfoHandCount(opponentImage, {
      side: 'OPPONENT',
      roi: localRoi(opponentRoi),
      templates
    })
  };
}

async function waitForOverlay(bridge, info, templates) {
  const overlayConfig = config.handFan.infoOverlay;
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < overlayConfig.infoOverlayAppearTimeoutMs) {
    last = await readOverlayRois(bridge, info, templates);
    if (last.own.status === 'OK' || last.opponent.status === 'OK') {
      return { ...last, overlayAppearMs: Date.now() - startedAt };
    }
    await sleep(overlayConfig.infoOverlayPollMs);
  }
  const error = new Error('INFO_OVERLAY_APPEAR_TIMEOUT');
  error.code = 'INFO_OVERLAY_APPEAR_TIMEOUT';
  error.lastOverlayRead = last;
  throw error;
}

async function runFastOwnAutoHold(bridge, expected, templates, options = {}) {
  const overlayConfig = config.handFan.infoOverlay;
  const debugDir = options.debugDir || path.join(AUTO_DEBUG_DIR, 'fast-own');
  const verbose = Boolean(options.verbose);
  const ownRoi = getInfoHandCountRoi('OWN');
  const stableReadsRequired = Math.max(1, Number(overlayConfig.fastOwnStableReads || 2));
  const timeoutMs = Math.max(200, Number(overlayConfig.fastOwnTimeoutMs || 950));
  const pollMs = Math.max(15, Number(overlayConfig.fastOwnPollMs || 35));
  const initialDelayMs = Math.max(0, Number(overlayConfig.fastOwnInitialDelayMs || 70));
  const releaseSettleMs = Math.max(0, Number(overlayConfig.fastOwnReleaseSettleMs || 60));

  let mouseDownSent = false;
  let mouseReleased = true;
  let failSafeTimer = null;
  let failSafeTriggered = false;
  let releasePromise = null;
  let info = null;
  let holdStartedAt = null;
  let lastOwn = null;
  let lastOwnImage = null;
  let stableValue = null;
  let stableReads = 0;
  let samples = 0;
  const expectedOwn = Number(expected && expected.own);

  fs.mkdirSync(debugDir, { recursive: true });
  console.log('FAST OWN INFO: hold i and read only our hand-count ROI; opponent hand is ignored.');

  const releaseMouse = async reason => {
    if (!mouseDownSent || mouseReleased) return;
    if (releasePromise) return releasePromise;
    releasePromise = bridge.mouseUp()
      .then(() => { mouseReleased = true; })
      .catch(error => { throw new Error(`mouseUp failed (${reason}): ${error.message}`); })
      .finally(() => { releasePromise = null; });
    return releasePromise;
  };

  try {
    info = await bridge.info();
    validateClient(info);
    const point = mapReferencePoint(info, overlayConfig.infoButton);
    await bridge.move(point.x, point.y);
    await sleep(overlayConfig.infoButtonMoveSettleMs);

    // Recheck immediately before the guarded hold.
    info = await bridge.info();
    validateClient(info);
    const confirmedPoint = mapReferencePoint(info, overlayConfig.infoButton);
    await bridge.mouseDown(confirmedPoint.x, confirmedPoint.y);
    mouseDownSent = true;
    mouseReleased = false;
    holdStartedAt = Date.now();

    failSafeTimer = setTimeout(() => {
      failSafeTriggered = true;
      releaseMouse('fast-own absolute hold timeout').catch(() => {});
    }, overlayConfig.infoAutoHoldMaxMs);

    if (initialDelayMs) await sleep(initialDelayMs);
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < timeoutMs) {
      if (failSafeTriggered) {
        const error = new Error('INFO_AUTO_HOLD_MAX_TIMEOUT');
        error.code = 'INFO_AUTO_HOLD_MAX_TIMEOUT';
        throw error;
      }

      lastOwnImage = await captureReferenceRoi(bridge, info, ownRoi);
      samples++;
      lastOwn = recognizeInfoHandCount(lastOwnImage, {
        side: 'OWN',
        roi: localRoi(ownRoi),
        templates
      });

      if (lastOwn.status === 'OK' && Number.isInteger(lastOwn.handCount)) {
        // For an explicitly known 10/11/12 count, the INFO overlay can briefly
        // expose only the first glyph while it animates in.  Do not accept a
        // stable singleton such as 1 when the caller already knows the expected
        // two-digit count; keep polling until the complete integer is visible.
        if (Number.isInteger(expectedOwn) && lastOwn.handCount !== expectedOwn) {
          stableValue = null;
          stableReads = 0;
        } else {
          if (lastOwn.handCount === stableValue) stableReads++;
          else {
            stableValue = lastOwn.handCount;
            stableReads = 1;
          }
          if (stableReads >= stableReadsRequired) break;
        }
      } else {
        stableValue = null;
        stableReads = 0;
      }
      await sleep(pollMs);
    }

    if (stableReads < stableReadsRequired || !lastOwn || lastOwn.status !== 'OK') {
      const error = new Error('INFO_FAST_OWN_TIMEOUT');
      error.code = 'INFO_FAST_OWN_TIMEOUT';
      throw error;
    }

    // The only authority needed by the observer is our actual final hand count.
    // Release immediately; do not capture the opponent ROI or encode full-screen PNGs.
    await releaseMouse('fast-own count confirmed');
    if (failSafeTimer) clearTimeout(failSafeTimer);
    failSafeTimer = null;
    const holdDurationMs = Date.now() - holdStartedAt;
    if (releaseSettleMs) await sleep(releaseSettleMs);

    const sideValidation = Number.isInteger(expectedOwn) && lastOwn.handCount !== expectedOwn
      ? 'HAND_COUNT_MISMATCH'
      : 'OK';
    const result = {
      autoHoldI: true,
      fastOwnOnly: true,
      capturedAt: new Date().toISOString(),
      windowTitle: info.title,
      status: 'OK',
      own: recognitionSummary(lastOwn),
      opponent: null,
      expected,
      sideValidation,
      samples,
      stableReads,
      holdDurationMs,
      mouseReleased,
      failSafeTriggered,
      overlayReleaseCheck: 'MOUSE_UP_CONFIRMED'
    };
    fs.writeFileSync(path.join(debugDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    if ((verbose || options.saveOwnRoi === true) && lastOwnImage) {
      writePngSync(toPng(lastOwnImage), path.join(debugDir, 'own_roi_confirmed.png'));
    }
    return { result, debugDir };
  } catch (error) {
    try { await releaseMouse('fast-own error handler'); } catch (_) {}
    if (failSafeTimer) clearTimeout(failSafeTimer);
    failSafeTimer = null;
    try {
      if (lastOwnImage) {
        writePngSync(toPng(lastOwnImage), path.join(debugDir, 'own_roi_last.png'));
      }
    } catch (_) {}
    const errorResult = {
      autoHoldI: true,
      fastOwnOnly: true,
      capturedAt: new Date().toISOString(),
      windowTitle: info ? info.title : null,
      expected,
      status: error.code || error.message || 'INFO_FAST_OWN_FAILED',
      own: lastOwn ? recognitionSummary(lastOwn) : null,
      opponent: null,
      samples,
      stableReads,
      holdDurationMs: holdStartedAt ? Date.now() - holdStartedAt : 0,
      mouseReleased,
      failSafeTriggered
    };
    fs.writeFileSync(path.join(debugDir, 'result.json'), JSON.stringify(errorResult, null, 2), 'utf8');
    throw error;
  } finally {
    if (failSafeTimer) clearTimeout(failSafeTimer);
    await releaseMouse('fast-own finally');
  }
}

async function runManual(bridge, expected, templates) {
  console.log('Manual INFO hand-count validation. Hold i before the countdown ends.');
  console.log('This mode only captures and recognizes; it sends no mouse or keyboard input.');
  await countdown();
  const info = await bridge.info();
  validateClient(info);
  const image = await captureFullClient(bridge, info);
  const own = readOwnHandCountFromInfoOverlay(image, { templates });
  const opponent = readOpponentHandCountFromInfoOverlay(image, { templates });
  const sideValidation = validateInfoHandCountSides(own, opponent, expected);

  fs.mkdirSync(MANUAL_DEBUG_DIR, { recursive: true });
  writePngSync(toPng(image), path.join(MANUAL_DEBUG_DIR, 'screen.png'));
  writePngSync(cropImage(image, getInfoHandCountRoi('OWN')), path.join(MANUAL_DEBUG_DIR, 'own-roi.png'));
  writePngSync(cropImage(image, getInfoHandCountRoi('OPPONENT')), path.join(MANUAL_DEBUG_DIR, 'opponent-roi.png'));

  const result = {
    autoHoldI: false,
    capturedAt: new Date().toISOString(),
    windowTitle: info.title,
    own: recognitionSummary(own),
    opponent: recognitionSummary(opponent),
    expected,
    sideValidation: sideValidation.status
  };
  fs.writeFileSync(path.join(MANUAL_DEBUG_DIR, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return { result, debugDir: MANUAL_DEBUG_DIR };
}

async function runAutoHold(bridge, expected, templates, options = {}) {
  const overlayConfig = config.handFan.infoOverlay;
  const debugDir = options.debugDir || AUTO_DEBUG_DIR;
  let mouseDownSent = false;
  let mouseReleased = true;
  let failSafeTimer = null;
  let failSafeTriggered = false;
  let info = null;
  let holdStartedAt = null;
  let releasePromise = null;

  fs.mkdirSync(debugDir, { recursive: true });
  console.log('Automatic INFO hold test: one guarded left-button hold on the blue i button only.');
  console.log('No hand cards, card actions, or drag operations are used.');
  if (!options.skipCountdown) await countdown();

  const releaseMouse = async reason => {
    if (!mouseDownSent || mouseReleased) return;
    if (releasePromise) return releasePromise;
    releasePromise = bridge.mouseUp()
      .then(() => {
        mouseReleased = true;
      })
      .catch(error => {
        throw new Error(`mouseUp failed (${reason}): ${error.message}`);
      })
      .finally(() => {
        releasePromise = null;
      });
    return releasePromise;
  };

  try {
    info = await bridge.info();
    validateClient(info);
    const before = await captureFullClient(bridge, info);
    writePngSync(toPng(before), path.join(debugDir, 'before_hold.png'));

    const point = mapReferencePoint(info, overlayConfig.infoButton);
    await bridge.move(point.x, point.y);
    await sleep(overlayConfig.infoButtonMoveSettleMs);

    // Recheck immediately before pressing. bridge.info() rejects unless the
    // current foreground title is Master Duel.
    info = await bridge.info();
    validateClient(info);
    const confirmedPoint = mapReferencePoint(info, overlayConfig.infoButton);
    await bridge.mouseDown(confirmedPoint.x, confirmedPoint.y);
    mouseDownSent = true;
    mouseReleased = false;
    holdStartedAt = Date.now();

    failSafeTimer = setTimeout(() => {
      failSafeTriggered = true;
      releaseMouse('absolute hold timeout').catch(() => {});
    }, overlayConfig.infoAutoHoldMaxMs);

    const overlayRead = await waitForOverlay(bridge, info, templates);
    if (failSafeTriggered) throw new Error('INFO_AUTO_HOLD_MAX_TIMEOUT');
    // waitForOverlay already owns the actual count ROI pixels/recognition.
    // Never keep INFO held for another full-client capture or evidence write.
    await releaseMouse('overlay captured');
    clearTimeout(failSafeTimer);
    failSafeTimer = null;
    const holdDurationMs = Date.now() - holdStartedAt;
    if (failSafeTriggered || holdDurationMs > overlayConfig.infoAutoHoldMaxMs) {
      const timeoutError = new Error('INFO_AUTO_HOLD_MAX_TIMEOUT');
      timeoutError.code = 'INFO_AUTO_HOLD_MAX_TIMEOUT';
      throw timeoutError;
    }
    const own = overlayRead.own;
    const opponent = overlayRead.opponent;
    const sideValidation = validateInfoHandCountSides(own, opponent, expected);
    writePngSync(toPng(overlayRead.ownImage), path.join(debugDir, 'own_roi.png'));
    writePngSync(toPng(overlayRead.opponentImage), path.join(debugDir, 'opponent_roi.png'));

    await sleep(overlayConfig.infoOverlayReleaseWaitMs);
    const afterRelease = await captureFullClient(bridge, info);
    writePngSync(toPng(afterRelease), path.join(debugDir, 'after_release.png'));
    const releasedOwn = readOwnHandCountFromInfoOverlay(afterRelease, { templates });
    const releasedOpponent = readOpponentHandCountFromInfoOverlay(afterRelease, { templates });
    const overlayReleaseCheck = releasedOwn.status !== 'OK' && releasedOpponent.status !== 'OK'
      ? 'PASS'
      : 'UNKNOWN';

    const result = {
      autoHoldI: true,
      capturedAt: new Date().toISOString(),
      windowTitle: info.title,
      own: recognitionSummary(own),
      opponent: recognitionSummary(opponent),
      expected,
      sideValidation: sideValidation.status,
      overlayAppearMs: overlayRead.overlayAppearMs,
      status: own.status === 'OK' ? 'OK' : own.status,
      holdDurationMs,
      mouseReleased,
      failSafeTriggered,
      overlayReleaseCheck
    };
    fs.writeFileSync(path.join(debugDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    return { result, debugDir };
  } catch (error) {
    try { await releaseMouse('error handler'); } catch (_) {}
    try {
      if (info) {
        const errorState = await captureFullClient(bridge, info);
        writePngSync(toPng(errorState), path.join(debugDir, 'error_state.png'));
      }
    } catch (_) {}
    const errorResult = {
      autoHoldI: true,
      capturedAt: new Date().toISOString(),
      windowTitle: info ? info.title : null,
      expected,
      status: error.code || error.message || 'AUTO_HOLD_FAILED',
      holdDurationMs: holdStartedAt ? Date.now() - holdStartedAt : 0,
      mouseReleased,
      failSafeTriggered
    };
    fs.writeFileSync(path.join(debugDir, 'result.json'), JSON.stringify(errorResult, null, 2), 'utf8');
    throw error;
  } finally {
    if (failSafeTimer) clearTimeout(failSafeTimer);
    await releaseMouse('finally');
  }
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  const bridge = new MdFastBridge();
  const templates = loadInfoDigitTemplates(ROOT);
  await bridge.start();
  try {
    if (options.autoHoldI) await activateAndVerifyMasterDuel(bridge);
    const output = options.autoHoldI
      ? await runAutoHold(bridge, options.expected, templates, { skipCountdown: true })
      : await runManual(bridge, options.expected, templates);
    console.log(JSON.stringify(output.result, null, 2));
    console.log(`debug: ${output.debugDir}`);
  } finally {
    await bridge.stop();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  readOptions,
  recognitionSummary,
  validateClient,
  waitForOverlay,
  runFastOwnAutoHold,
  runAutoHold
};
