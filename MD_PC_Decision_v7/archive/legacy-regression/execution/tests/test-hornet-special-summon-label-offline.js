'use strict';

const assert = require('assert');
const path = require('path');
const { readPng } = require('../../lib/png-utils');
const {
  LABEL_SPECS,
  findLabelMatches
} = require('../../lib/duel-log-label-reader');

async function main() {
  const spec = LABEL_SPECS.SPECIAL_SUMMON;
  assert.strictEqual(spec.threshold, 0.12);

  const template = await readPng(path.join(
    __dirname,
    '..', '..', 'templates', 'ui', spec.file
  ));
  const panel = {
    width: 348,
    height: 110,
    data: Buffer.alloc(348 * 110 * 4, 255)
  };
  const origin = { x: 128, y: 30 };

  for (let y = 0; y < template.height; y++) {
    for (let x = 0; x < template.width; x++) {
      const src = (y * template.width + x) * 4;
      const dst = ((origin.y + y) * panel.width + origin.x + x) * 4;
      panel.data[dst] = Math.max(0, template.data[src] - 29);
      panel.data[dst + 1] = Math.max(0, template.data[src + 1] - 29);
      panel.data[dst + 2] = Math.max(0, template.data[src + 2] - 29);
      panel.data[dst + 3] = 255;
    }
  }

  const oldGate = findLabelMatches(panel, template, spec, { threshold: 0.075 });
  assert.strictEqual(oldGate.length, 0, 'old generic threshold must reproduce the missed live label');

  const currentGate = findLabelMatches(panel, template, spec);
  assert.ok(
    currentGate.some(match => match.x === origin.x && match.y === origin.y),
    'live-proven 0.12 threshold must retain the dimmer Special Summon label'
  );

  console.log('HORNET_SPECIAL_SUMMON_LABEL_OFFLINE_PASS');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
