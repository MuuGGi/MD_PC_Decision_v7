'use strict';
const fs = require('fs');
const cp = require('child_process');
const { ShadowViolationError } = require('../core/errors');
const WRITES = ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'copyFile',
  'cp', 'truncate', 'chmod', 'chown', 'utimes', 'symlink', 'link', 'mkdtemp', 'write', 'writev', 'ftruncate'];
const CHILD = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
let running = false;
async function withStrictReadOnly(fn) {
  if (running) throw new ShadowViolationError('SHADOW_ALREADY_RUNNING');
  running = true;
  const restores = [];
  const patch = (object, key, label, wrap) => {
    if (typeof object[key] !== 'function') return;
    const original = object[key];
    restores.push(() => { object[key] = original; });
    object[key] = wrap ? wrap(original) : () => { throw new ShadowViolationError('SHADOW_MUTATION_FORBIDDEN', label); };
  };
  try {
    for (const name of WRITES) { patch(fs, name, 'fs.' + name); patch(fs, name + 'Sync', 'fs.' + name + 'Sync'); patch(fs.promises, name, 'fs.promises.' + name); }
    patch(fs, 'createWriteStream', 'fs.createWriteStream');
    const readOpen = original => function(file, flags, ...args) {
      if (flags !== 'r' && flags !== fs.constants.O_RDONLY) throw new ShadowViolationError('SHADOW_WRITABLE_OPEN_FORBIDDEN');
      return original.call(this, file, flags, ...args);
    };
    for (const name of ['open', 'openSync']) patch(fs, name, 'fs.' + name, readOpen);
    patch(fs.promises, 'open', 'fs.promises.open', readOpen);
    for (const name of CHILD) patch(cp, name, 'child_process.' + name);
    return await fn();
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    running = false;
  }
}
module.exports = { withStrictReadOnly };
