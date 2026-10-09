'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_ROOT = path.join(ROOT, 'debug');
const DEBUG_EXECUTION_ROOT = path.join(DEBUG_ROOT, 'execution');
const MATERIAL_ROOT = path.join(ROOT, 'material');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');

const ISSUE_LOG_PATH = path.join(MATERIAL_ROOT, 'issues', 'V5_issue_log.txt');
const LEGACY_ISSUE_LOG_PATH = path.join(DEBUG_ROOT, 'issues', 'V5_issue_log.txt');

const VERIFIED_STATUS_PATH = path.join(MATERIAL_ROOT, 'verified', 'verified-cards.json');
const LEGACY_VERIFIED_STATUS_PATH = path.join(ROOT, 'execution', 'verified-cards.json');
const VERIFIED_EVIDENCE_ROOT = path.resolve(ROOT, '../archive/verified-evidence');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveStoredPath(filePath) {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const normalized = String(filePath).replace(/[\\/]+/g, path.sep);
  return path.resolve(ROOT, normalized);
}

function projectRelative(filePath) {
  if (!filePath) return null;
  const absolute = path.resolve(filePath);
  const rel = path.relative(ROOT, absolute);
  return rel && isInside(path.resolve(ROOT, '..'), absolute) ? rel.replace(/\//g, '\\') : String(filePath);
}

function resolveIssueLogPath() {
  if (fs.existsSync(ISSUE_LOG_PATH)) return ISSUE_LOG_PATH;
  if (fs.existsSync(LEGACY_ISSUE_LOG_PATH)) return LEGACY_ISSUE_LOG_PATH;
  return ISSUE_LOG_PATH;
}

function resolveVerifiedStatusPath() {
  if (fs.existsSync(VERIFIED_STATUS_PATH)) return VERIFIED_STATUS_PATH;
  if (fs.existsSync(LEGACY_VERIFIED_STATUS_PATH)) return LEGACY_VERIFIED_STATUS_PATH;
  return VERIFIED_STATUS_PATH;
}

function sanitizeSegment(value) {
  return String(value || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function durableEvidenceDestination(absolute, key) {
  if (isInside(DEBUG_EXECUTION_ROOT, absolute)) {
    const tail = path.relative(DEBUG_EXECUTION_ROOT, absolute);
    return path.join(VERIFIED_EVIDENCE_ROOT, tail);
  }

  const bucket = sanitizeSegment(key);
  const leaf = sanitizeSegment(path.basename(absolute));
  return path.join(VERIFIED_EVIDENCE_ROOT, bucket, leaf);
}

function promoteVerifiedEvidence(evidenceDir, key) {
  if (!evidenceDir) return null;
  const absolute = resolveStoredPath(evidenceDir);

  if (!fs.existsSync(absolute)) return projectRelative(absolute);
  if (!isInside(ROOT, absolute) && !isInside(VERIFIED_EVIDENCE_ROOT, absolute))
    throw new Error('V7_EVIDENCE_SOURCE_OUTSIDE_PROJECT');
  if (isInside(MATERIAL_ROOT, absolute)) return projectRelative(absolute);
  if (isInside(VERIFIED_EVIDENCE_ROOT, absolute)) return projectRelative(absolute);

  const destination = durableEvidenceDestination(absolute, key);
  if (!fs.existsSync(destination)) {
    ensureDir(path.dirname(destination));
    // Successful evidence: keep receipts, not a second copy of all screenshots.
    // The supervisor owns failure/terminal image retention in archive/autotest.
    fs.cpSync(absolute, destination, { recursive: true, force: false,
      filter: file => !/\.(png|jpg|jpeg|bmp|webp)$/i.test(String(file)) });
  }
  return projectRelative(destination);
}

module.exports = {
  ROOT,
  DEBUG_ROOT,
  DEBUG_EXECUTION_ROOT,
  MATERIAL_ROOT,
  ARCHIVE_ROOT,
  ISSUE_LOG_PATH,
  LEGACY_ISSUE_LOG_PATH,
  VERIFIED_STATUS_PATH,
  LEGACY_VERIFIED_STATUS_PATH,
  VERIFIED_EVIDENCE_ROOT,
  ensureDir,
  projectRelative,
  resolveStoredPath,
  resolveIssueLogPath,
  resolveVerifiedStatusPath,
  isInside,
  promoteVerifiedEvidence
};
