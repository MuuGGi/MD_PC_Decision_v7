'use strict';

const fs = require('fs');
const path = require('path');

const COMPOSITE_SESSION_FILES = Object.freeze([
  path.join('debug', 'composite-route-live', 'session_state.json'),
  path.join('debug', 'composite-route-live', 'latest_result.json')
]);

function resetCompositeRouteSession(rootDir = path.resolve(__dirname, '..')) {
  const root = path.resolve(rootDir);
  const removed = [];

  for (const relativePath of COMPOSITE_SESSION_FILES) {
    const filePath = path.resolve(root, relativePath);
    const expectedParent = path.resolve(root, 'debug', 'composite-route-live');
    if (path.dirname(filePath) !== expectedParent) {
      throw new Error(`COMPOSITE_RESET_PATH_OUTSIDE_EXPECTED_DIR:${filePath}`);
    }
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }

  return { root, removed };
}

module.exports = {
  COMPOSITE_SESSION_FILES,
  resetCompositeRouteSession
};
