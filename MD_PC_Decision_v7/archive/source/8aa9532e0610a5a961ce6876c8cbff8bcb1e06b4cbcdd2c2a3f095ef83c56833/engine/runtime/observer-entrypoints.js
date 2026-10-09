'use strict';

const OBSERVER_ENTRYPOINTS = Object.freeze({
  DUEL: 'runtime/observer/run-duel-observer.js',
  INCREMENTAL: 'runtime/observer/run-live-incremental.js',
  OPENING_FAST: 'runtime/observer/run-opening-observer-fast.js',
  PREPARED_BASELINE: 'runtime/observer/run-prepared-baseline-flex.js',
  HAND_CHANGE: 'runtime/observer/observe-hand-change-incremental-live.js',
  HAND_SCROLL: 'runtime/observer/capture-hand-scroll-segments-live.js',
  DUEL_LOG: 'runtime/observer/test-duel-log-live.js',
  HAND_SCAN: 'runtime/observer/test-scan-state-live.js',
  HAND_INFO: 'runtime/observer/test-hand-info-live.js',
  SCAN_STATE: 'runtime/observer/scan-state.js'
});

module.exports = { OBSERVER_ENTRYPOINTS };
