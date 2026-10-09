'use strict';
const path = require('path');
// fs.cp/fs.cpSync on Windows may supply extended drive/UNC paths to filters.
function ordinaryPath(value) {
  const text = String(value);
  return path.resolve(text.startsWith('\\\\?\\UNC\\') ? '\\\\' + text.slice(8) :
    text.startsWith('\\\\?\\') ? text.slice(4) : text);
}
function pathKey(value) {
  const resolved = ordinaryPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
module.exports = { ordinaryPath, pathKey };
