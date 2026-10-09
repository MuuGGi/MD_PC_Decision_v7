'use strict';

const fs = require('fs');
const path = require('path');
const { MdFastBridge } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { runLiveScan } = require('./test-scan-state-live');
const { runDuelLogLive } = require('./test-duel-log-live');

const ROOT = path.resolve(__dirname, '..', '..');
const PERF_PATH = path.join(ROOT, 'debug', 'performance', 'latest-opening-shared.json');
const verbose = process.argv.includes('--verbose');

function elapsedMs(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1e6;
}

async function main() {
  const wholeStarted = process.hrtime.bigint();
  const bridge = new MdFastBridge();
  let bridgeStartMs = 0;
  let activationMs = 0;
  let scanMs = 0;
  let logMs = 0;

  let started = process.hrtime.bigint();
  await bridge.start();
  bridgeStartMs = elapsedMs(started);
  try {
    started = process.hrtime.bigint();
    await activateAndVerifyMasterDuel(bridge);
    activationMs = elapsedMs(started);

    console.log('\n===== test-scan-state-live.js =====');
    started = process.hrtime.bigint();
    await runLiveScan({
      bridge,
      skipActivation: true,
      expected: 5,
      fastOpening: true,
      observerFast: true,
      verbose
    });
    scanMs = elapsedMs(started);

    console.log('\n===== test-duel-log-live.js =====');
    started = process.hrtime.bigint();
    await runDuelLogLive({
      bridge,
      skipActivation: true,
      skipForegroundReactivate: true,
      observerFast: true,
      verbose
    });
    logMs = elapsedMs(started);
  } finally {
    await bridge.stop();
  }

  const result = {
    capturedAt: new Date().toISOString(),
    totalMs: elapsedMs(wholeStarted),
    bridgeStartMs,
    activationMs,
    scanMs,
    logMs
  };
  fs.mkdirSync(path.dirname(PERF_PATH), { recursive: true });
  fs.writeFileSync(PERF_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(
    `TIMING opening-shared: total=${result.totalMs.toFixed(1)}ms; ` +
    `bridge_start=${bridgeStartMs.toFixed(1)}ms; activation=${activationMs.toFixed(1)}ms; ` +
    `scan=${scanMs.toFixed(1)}ms; log=${logMs.toFixed(1)}ms`
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { main };
