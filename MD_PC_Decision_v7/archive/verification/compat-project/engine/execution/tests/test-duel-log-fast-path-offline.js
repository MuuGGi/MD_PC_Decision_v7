'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPng, cropImage } = require('../../lib/png-utils');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const {
  loadDuelLogLabelTemplates,
  recognizeDuelLogLabels,
  findLabelMatches
} = require('../../lib/duel-log-label-reader');
const { loadFieldRowTemplates } = require('../../lib/duel-log-field-rows');
const {
  recognizeDuelLogScreenshot
} = require('../../runtime/observer/test-duel-log-live');

const ROOT = path.resolve(__dirname, '..', '..');

function normalizeLabels(labels) {
  return labels.map(label => ({
    type: label.type,
    x: label.x,
    y: label.y,
    width: label.width,
    height: label.height,
    mad: Number(label.mad.toFixed(12))
  }));
}

function normalizeEvents(result) {
  return (result.events || []).map(event => ({
    type: event.type,
    cardId: event.card && event.card.id || null,
    cardName: event.card && event.card.name || null
  }));
}

(async () => {
  const image = await readPng(path.join(
    ROOT,
    'material',
    'verified',
    'issue-080-self-priority-blue-optional-prompt.png'
  ));
  const phaseTemplate = await readPng(path.join(
    ROOT,
    'templates',
    'ui',
    'duel_log_main1_phase.png'
  ));
  const library = loadLibrary(ROOT);
  const loaded = await loadTemplates(ROOT, library);
  const labelTemplates = await loadDuelLogLabelTemplates(ROOT);
  const fieldRowTemplates = await loadFieldRowTemplates(ROOT);
  const bundle = {
    phaseTemplate,
    labelTemplates,
    fieldRowTemplates,
    cardTemplates: loaded.map(item => ({ ...item.card, image: item.image }))
  };

  const panel = cropImage(image, { x: 1674, y: 150, width: 348, height: 886 });
  const legacyLabels = [];
  for (const [type, entry] of Object.entries(labelTemplates)) {
    for (const match of findLabelMatches(panel, entry.image, entry.spec)) {
      legacyLabels.push({
        type,
        ...match,
        width: entry.image.width,
        height: entry.image.height
      });
    }
  }
  legacyLabels.sort((left, right) => left.y - right.y || left.x - right.x);
  assert.deepStrictEqual(
    normalizeLabels(recognizeDuelLogLabels(panel, labelTemplates)),
    normalizeLabels(legacyLabels),
    'weighted luminance cache must preserve every label and score'
  );

  const full = recognizeDuelLogScreenshot(image, bundle, { skipMain1Search: false });
  const atomicFast = recognizeDuelLogScreenshot(image, bundle, { skipMain1Search: true });
  assert.deepStrictEqual(
    normalizeEvents(atomicFast),
    normalizeEvents(full),
    'explicit atomic-bottom fast path must preserve recognized event semantics'
  );
  assert.strictEqual(atomicFast.atomicBottomFastPath, true);

  const incrementalSource = fs.readFileSync(path.join(
    ROOT,
    'runtime',
    'observer',
    'run-live-incremental.js'
  ), 'utf8');
  assert(incrementalSource.includes("productionAtomicPerformanceFast = process.env.MD_V5_ATOMIC_OBSERVER === '1'"));
  assert(incrementalSource.includes('performanceFast: observerFast || productionAtomicPerformanceFast'));

  console.log(
    `DUEL_LOG_FAST_PATH_OFFLINE_PASS labels=${legacyLabels.length}; events=${full.events.length}`
  );
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
