'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function readJsonIfExistsSafe(filePath) {
  try {
    return fs.existsSync(filePath) ? readJson(filePath) : null;
  } catch (_) {
    return null;
  }
}

function writeJson(filePath, value, options = {}) {
  ensureDir(path.dirname(filePath));
  const suffix = options.trailingNewline ? '\n' : '';
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
}



function writeEvidenceJson(filePath, value) {
  writeJson(filePath, value, { trailingNewline: true });
}

function writeBufferAtomic(filePath, buffer) {
  ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.tmp`
  );
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value, options = {}) {
  const suffix = options.trailingNewline ? '\n' : '';
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
  writeBufferAtomic(filePath, payload);
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readBufferIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreBuffer(filePath, buffer) {
  if (buffer == null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  writeBufferAtomic(filePath, buffer);
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = {
  ensureDir,
  readJson,
  readJsonIfExists,
  readJsonIfExistsSafe,
  writeJson,
  writeEvidenceJson,
  writeJsonAtomic,
  writeBufferAtomic,
  appendJsonLine,
  readBufferIfExists,
  restoreBuffer,
  removeIfExists
};
