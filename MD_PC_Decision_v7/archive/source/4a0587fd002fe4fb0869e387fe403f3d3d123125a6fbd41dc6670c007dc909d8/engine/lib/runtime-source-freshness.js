'use strict';

const fs = require('fs');
const path = require('path');

function fileSignature(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
}

function isInsideRoot(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function createRuntimeSourceFreshnessGuard({
  rootDir,
  files = null,
  getLoadedFiles = () => Object.keys(require.cache)
}) {
  const root = path.resolve(rootDir);
  const fixedFiles = Array.isArray(files) ? files.map(file => path.resolve(file)) : null;
  const baseline = new Map();

  function currentFiles() {
    const candidates = fixedFiles || getLoadedFiles();
    return [...new Set(candidates
      .map(file => path.resolve(file))
      .filter(file => file.endsWith('.js') && isInsideRoot(file, root) && fs.existsSync(file)))];
  }

  function rememberNewlyLoadedFiles() {
    for (const filePath of currentFiles()) {
      if (!baseline.has(filePath)) baseline.set(filePath, fileSignature(filePath));
    }
  }

  rememberNewlyLoadedFiles();

  return {
    assertFresh() {
      const changed = [];
      for (const [filePath, originalSignature] of baseline) {
        let currentSignature = 'MISSING';
        try { currentSignature = fileSignature(filePath); } catch (_) {}
        if (currentSignature !== originalSignature) {
          changed.push(path.relative(root, filePath).replace(/\\/g, '/'));
        }
      }
      if (changed.length) {
        const error = new Error(`V6_RUNTIME_SOURCE_CHANGED_RESTART_REQUIRED:${changed.join(',')}`);
        error.code = 'V6_RUNTIME_SOURCE_CHANGED_RESTART_REQUIRED';
        error.changedFiles = changed;
        throw error;
      }
      rememberNewlyLoadedFiles();
      return { trackedFiles: baseline.size };
    }
  };
}

module.exports = { createRuntimeSourceFreshnessGuard };
