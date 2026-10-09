'use strict';

const path = require('path');

const PRODUCTION_ENTRYPOINTS = Object.freeze({
  M11: path.join('execution', 'live', 'run-m11-mallet-keep-weapon.js'),
  M12: path.join('execution', 'live', 'run-m12-trade-in.js'),
  M17_NO_BONUS: path.join('execution', 'live', 'run-m17-engage-no-bonus-draw.js'),
  M17_BONUS: path.join('execution', 'live', 'run-m17-engage-bonus-draw.js'),
  M18: path.join('execution', 'live', 'run-m18-foolish-burial.js'),
  M21: path.join('execution', 'live', 'run-m21-chicken-game.js')
});

function getProductionEntrypoint(key) {
  const entry = PRODUCTION_ENTRYPOINTS[String(key || '')];
  if (!entry) throw new Error(`UNKNOWN_PRODUCTION_ENTRYPOINT:${key}`);
  return entry;
}

module.exports = {
  PRODUCTION_ENTRYPOINTS,
  getProductionEntrypoint
};
