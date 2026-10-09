'use strict';
const fs = require('fs'), path = require('path');
const { insidePath, readOwnedJson, atomicWriteJson } = require('../../../src/core/json-store');
const ROOT = path.resolve(__dirname, '../../..');
function normalize() {
  const lock = readOwnedJson(path.join(ROOT, 'debug/autotest/active.lock'));
  if (lock) {
    try { process.kill(lock.pid, 0); throw new Error('V7_STORAGE_LIVE_RUN_FORBIDDEN'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const source = insidePath(ROOT, path.join(ROOT, 'engine/material/verified/evidence'));
  const destination = insidePath(ROOT, path.join(ROOT, 'archive/verified-evidence'));
  const inventory = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = insidePath(ROOT, path.join(dir, entry.name));
      if (entry.isSymbolicLink()) throw new Error('V7_STORAGE_LINK_FORBIDDEN');
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) inventory.push(file);
    }
  }
  if (fs.existsSync(source)) {
    walk(source); // Resolve/check every source before moving any directory.
    if (fs.existsSync(destination)) throw new Error('V7_STORAGE_DESTINATION_EXISTS_NO_OVERWRITE');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    const file = path.join(ROOT, 'engine/material/verified/verified-cards.json');
    const status = readOwnedJson(file);
    for (const row of [...Object.values(status.cards || {}), ...Object.values(status.branches || {})]) {
      const original = String(row.evidenceDir || '').replace(/\\/g, '/');
      if (original.startsWith('material/verified/evidence/')) {
        const revised = '../archive/verified-evidence/' + original.slice('material/verified/evidence/'.length);
        if (fs.existsSync(path.resolve(ROOT, 'engine', revised))) row.evidenceDir = revised;
      }
    }
    atomicWriteJson(file, status);
  }
  inventory.length = 0;
  if (fs.existsSync(destination)) walk(destination);
  const images = inventory.filter(file => /\.(png|jpg|jpeg|bmp|webp)$/i.test(file));
  let bytes = 0;
  // This is ONLY the success-evidence copy made by verified-registry. Never
  // address runtime calibration, failures, interrupted current duel, or V6.
  for (const image of images) { insidePath(destination, image); bytes += fs.statSync(image).size; fs.unlinkSync(image); }
  const result = { movedTo: destination, removedSuccessImageCopies: images.length, bytes,
    removedCopiesRecoverable: false, originalFailureAndInterruptedEvidencePreserved: true };
  atomicWriteJson(path.join(ROOT, 'archive/verification/storage-normalization.json'), result);
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) normalize();
module.exports = { normalize };
