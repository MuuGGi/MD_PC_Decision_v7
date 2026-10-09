'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
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
  isInside,
  promoteVerifiedEvidence
} = require('../lib/project-storage');

const REQUIRED_NODE_VERSION = '20.11.1';
const APPLY = process.argv.includes('--apply');
const ORGANIZE_TESTS = process.argv.includes('--organize-tests');
const ORGANIZE_CODE = process.argv.includes('--organize-code');
const MANIFEST_PATH = path.join(MATERIAL_ROOT, 'V6_material_manifest.json');
const TESTS_ROOT = path.join(ROOT, 'execution', 'tests');
const LEGACY_TEST_ARCHIVE_ROOT = path.join(ARCHIVE_ROOT, 'legacy-test-harnesses');
const LEGACY_DEBUG_ARCHIVE_ROOT = path.join(ARCHIVE_ROOT, 'legacy-debug');


const LEGACY_CODE_ARCHIVE_ROOT = path.join(ARCHIVE_ROOT, 'legacy-code');

const LEGACY_CODE_PATHS = [
  'execution/core/v5-bamboo-transition-engine.js',
  'execution/core/v5-link-branch.js',
  'execution/core/v5-issue-log.js'
];


function assertRequiredNodeRuntime() {
  const actual = process.versions && process.versions.node ? process.versions.node : 'unknown';
  if (actual !== REQUIRED_NODE_VERSION) {
    throw new Error(`V6_STORAGE_NODE_VERSION_MISMATCH:expected=${REQUIRED_NODE_VERSION};actual=${actual}`);
  }
  if (typeof fs.cpSync !== 'function' || typeof fs.rmSync !== 'function') {
    throw new Error(`V6_STORAGE_NODE20_FS_API_MISSING:node=${actual}`);
  }
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function ensureProjectRoot() {
  const required = ['runtime/main-v6.js', 'run-v6.cmd', 'card-library.json', 'execution', 'lib', 'templates'];
  const missing = required.filter(rel => !exists(rel));
  if (missing.length) {
    throw new Error(`V6_STORAGE_WRONG_ROOT:missing=${missing.join(',')}`);
  }
}

function ensureParent(filePath) {
  ensureDir(path.dirname(filePath));
}

function sameFile(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (_) {
    return false;
  }
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (_) {
    return false;
  }
}

function moveCanonicalFile(src, dst, actions) {
  if (!fs.existsSync(src)) return false;

  if (fs.existsSync(dst)) {
    if (!sameBytes(src, dst)) {
      actions.push({ type: 'CONFLICT', from: projectRelative(src), to: projectRelative(dst) });
      if (APPLY) {
        throw new Error(`V6_STORAGE_CANONICAL_CONFLICT:${projectRelative(src)}=>${projectRelative(dst)}`);
      }
      return false;
    }
    actions.push({ type: 'REMOVE_DUPLICATE_SOURCE', from: projectRelative(src), to: projectRelative(dst) });
    if (APPLY) fs.unlinkSync(src);
    return true;
  }

  actions.push({ type: 'MOVE', from: projectRelative(src), to: projectRelative(dst) });
  if (APPLY) {
    ensureParent(dst);
    fs.renameSync(src, dst);
  }
  return true;
}

function movePath(src, dst, actions) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dst)) {
    actions.push({ type: 'SKIP_DEST_EXISTS', from: projectRelative(src), to: projectRelative(dst) });
    return false;
  }
  actions.push({ type: 'MOVE', from: projectRelative(src), to: projectRelative(dst) });
  if (APPLY) {
    ensureParent(dst);
    fs.renameSync(src, dst);
  }
  return true;
}

function locateHandoff() {
  const names = fs.readdirSync(ROOT)
    .filter(name => /^MD_PC_Decision_v5_CODEX_HANDOFF_.*\.md$/i.test(name))
    .sort();
  return names.length ? path.join(ROOT, names[names.length - 1]) : null;
}

function rewriteHandoff(sourcePath, destinationPath, actions) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;
  const original = fs.readFileSync(sourcePath, 'utf8');
  const rewritten = original
    .replace(/MD_PC_Decision_v5/g, 'MD_PC_Decision_v6')
    .replace(/debug\\issues\\V5_issue_log\.txt/g, 'material\\issues\\V5_issue_log.txt')
    .replace(/debug\/issues\/V5_issue_log\.txt/g, 'material/issues/V5_issue_log.txt');

  actions.push({ type: 'MOVE_AND_REWRITE_HANDOFF', from: projectRelative(sourcePath), to: projectRelative(destinationPath) });
  if (APPLY) {
    ensureParent(destinationPath);
    fs.writeFileSync(destinationPath, rewritten, 'utf8');
    fs.unlinkSync(sourcePath);
  }
  return true;
}

function pruneEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current !== stop && isInside(stop, current)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length !== 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function migrateVerifiedRegistry(actions, promoted) {
  const source = fs.existsSync(VERIFIED_STATUS_PATH)
    ? VERIFIED_STATUS_PATH
    : (fs.existsSync(LEGACY_VERIFIED_STATUS_PATH) ? LEGACY_VERIFIED_STATUS_PATH : null);
  if (!source) return;

  const state = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!state.cards || typeof state.cards !== 'object') state.cards = {};
  if (!state.branches || typeof state.branches !== 'object') state.branches = {};

  const recordsBySource = new Map();
  const addRecord = (kind, key, record) => {
    if (!record || !record.evidenceDir) return;
    const oldPath = resolveStoredPath(record.evidenceDir);
    const token = process.platform === 'win32' ? oldPath.toLowerCase() : oldPath;
    if (!recordsBySource.has(token)) recordsBySource.set(token, { oldPath, refs: [] });
    recordsBySource.get(token).refs.push({ kind, key, record });
  };

  for (const [key, record] of Object.entries(state.cards)) addRecord('card', key, record);
  for (const [key, record] of Object.entries(state.branches)) addRecord('branch', key, record);

  const promotedSources = [];
  for (const { oldPath, refs } of recordsBySource.values()) {
    if (!fs.existsSync(oldPath)) {
      for (const ref of refs) {
        promoted.push({ key: ref.key, kind: ref.kind, status: 'MISSING_SOURCE', from: projectRelative(oldPath) });
      }
      continue;
    }

    let newRel;
    if (isInside(MATERIAL_ROOT, oldPath)) {
      newRel = projectRelative(oldPath);
    } else if (APPLY) {
      newRel = promoteVerifiedEvidence(oldPath, refs[0].key);
    } else {
      const relFromDebugExecution = isInside(DEBUG_EXECUTION_ROOT, oldPath)
        ? path.relative(DEBUG_EXECUTION_ROOT, oldPath)
        : path.join(String(refs[0].key).replace(/[^A-Za-z0-9_.-]/g, '_'), path.basename(oldPath));
      newRel = projectRelative(path.join(VERIFIED_EVIDENCE_ROOT, relFromDebugExecution));
    }

    for (const ref of refs) {
      promoted.push({
        key: ref.key,
        kind: ref.kind,
        status: APPLY ? 'PROMOTED' : 'WOULD_PROMOTE',
        from: projectRelative(oldPath),
        to: newRel
      });
      if (APPLY) ref.record.evidenceDir = newRel;
    }

    if (APPLY && !isInside(MATERIAL_ROOT, oldPath)) {
      promotedSources.push(oldPath);
    }
  }

  actions.push({ type: 'MIGRATE_VERIFIED_REGISTRY', from: projectRelative(source), to: projectRelative(VERIFIED_STATUS_PATH) });
  if (APPLY) {
    ensureParent(VERIFIED_STATUS_PATH);
    fs.writeFileSync(VERIFIED_STATUS_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (!sameFile(source, VERIFIED_STATUS_PATH) && fs.existsSync(source)) {
      fs.unlinkSync(source);
    }

    // These are historical PASS_LIVE evidence directories.  Once their canonical
    // material copy and registry rewrite are durable, remove the old debug copy so
    // debug remains runtime/current evidence rather than a second archive.
    for (const oldPath of promotedSources) {
      if (!isInside(DEBUG_ROOT, oldPath) || !fs.existsSync(oldPath)) continue;
      fs.rmSync(oldPath, { recursive: true, force: false });
      pruneEmptyParents(path.dirname(oldPath), DEBUG_EXECUTION_ROOT);
    }
  }
}

function archiveKnownDeprecated(actions) {
  const pairs = [
    ['execution/patches', 'archive/deprecated-patches'],
    ['debug/patch-backups', 'archive/patch-history'],
    ['V5_未解决线路.txt', 'archive/legacy-docs/V5_未解决线路.txt'],
    ['人脑决策层.txt', 'archive/legacy-docs/人脑决策层.txt'],
    ['execution/tests/D5_activate_bridge_fix.txt', 'archive/legacy-oneoff/D5_activate_bridge_fix.txt'],
    ['execution/tests/repair-r3b-zero-target-current-state.js', 'archive/legacy-oneoff/repair-r3b-zero-target-current-state.js'],
    ['execution/tests/resume-r3b-zero-target.cmd', 'archive/legacy-oneoff/resume-r3b-zero-target.cmd'],
    ['execution/tests/resume-r7-final-current-state.cmd', 'archive/legacy-oneoff/resume-r7-final-current-state.cmd'],
    ['execution/tests/resume-r7-final-current-state.js', 'archive/legacy-oneoff/resume-r7-final-current-state.js']
  ];
  for (const [fromRel, toRel] of pairs) {
    movePath(path.join(ROOT, fromRel), path.join(ROOT, toRel), actions);
  }
}



const LEGACY_TEST_PATHS = [
  'run-v5-branch-test.cmd',
  'run-v5-dual-optional-e10-test.cmd',
  'run-v5-m06-direct-e10-test.cmd',
  'run-v5-m14-transition.cmd',
  'run-v5-t01-test.cmd',
  'run-v5-t02-test.cmd',
  'run-v5-two-material-e10-test.cmd',

  'execution/tests/run-v5-branch-test-launcher.ps1',
  'execution/tests/run-v5-branch-test.js',
  'execution/tests/run-v5-dual-optional-e10-test-launcher.ps1',
  'execution/tests/run-v5-dual-optional-e10-test.js',
  'execution/tests/run-v5-m06-direct-e10-test-launcher.ps1',
  'execution/tests/run-v5-m06-direct-e10-test.js',
  'execution/tests/run-v5-m14-transition-launcher.ps1',
  'execution/tests/run-v5-m14-transition.js',
  'execution/tests/run-v5-t01-test-launcher.ps1',
  'execution/tests/run-v5-t01-test.js',
  'execution/tests/run-v5-t02-test-launcher.ps1',
  'execution/tests/run-v5-t02-test.js',
  'execution/tests/run-v5-two-material-e10-test-launcher.ps1',
  'execution/tests/run-v5-two-material-e10-test.js',

  'execution/core/v5-branch-transition-test-engine.js',
  'execution/core/v5-m14-draw2-transition.js',
  'execution/core/v5-t01-nodewise-test.js',
  'execution/core/v5-t01-transition-test.js',
  'execution/core/v5-t02-nodewise-test.js'
];

const LEGACY_DEBUG_PATHS = [
  'debug/v5-branch-transition-test',
  'debug/v5-dual-optional-e10',
  'debug/v5-m06-direct-e10',
  'debug/v5-m14-draw2-transition',
  'debug/v5-t01-nodewise',
  'debug/v5-t02-nodewise',
  'debug/v5-two-material-e10'
];

const TEST_SUPPORT_FILES = new Set([
  'bamboo-first-batch-common.js',
  'collect-m06-field-effect.js',
  'commit-known-hand-removal-passive.js',
  'seal-adjacent-terminal-boundary-passive.js'
]);

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function listFilesFlat(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readVerifiedRegistryIfPresent() {
  if (!fs.existsSync(VERIFIED_STATUS_PATH)) return { cards: {}, branches: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(VERIFIED_STATUS_PATH, 'utf8'));
    return {
      cards: parsed && parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {},
      branches: parsed && parsed.branches && typeof parsed.branches === 'object' ? parsed.branches : {}
    };
  } catch (err) {
    throw new Error(`V6_TEST_CATALOG_VERIFIED_REGISTRY_INVALID:${err && err.message ? err.message : err}`);
  }
}

function buildVerifiedTestFileSet() {
  const registry = readVerifiedRegistryIfPresent();
  const out = new Set();
  const addRecord = record => {
    if (!record || !record.testEntry) return;
    const rel = normalizeRel(record.testEntry);
    if (!rel.startsWith('execution/tests/')) return;
    const name = path.basename(rel);
    out.add(name);
    if (/\.cmd$/i.test(name)) {
      const jsName = name.replace(/\.cmd$/i, '.js');
      if (fs.existsSync(path.join(TESTS_ROOT, jsName))) out.add(jsName);
    }
  };
  Object.values(registry.cards).forEach(addRecord);
  Object.values(registry.branches).forEach(addRecord);
  return out;
}

function classifyRemainingTests() {
  const verified = buildVerifiedTestFileSet();
  const inventory = {
    verifiedLive: [],
    recoveryEntrypoints: [],
    offlineRegression: [],
    supportUtilities: [],
    routeAndLiveHarnesses: [],
    unclassified: []
  };

  for (const name of listFilesFlat(TESTS_ROOT)) {
    if (verified.has(name)) {
      inventory.verifiedLive.push(name);
      continue;
    }
    if (/^run-.*resume.*\.cmd$/i.test(name) || /^run-m20-resume-.*\.(?:cmd|js)$/i.test(name)) {
      inventory.recoveryEntrypoints.push(name);
      continue;
    }
    if (/^test-.*\.js$/i.test(name)) {
      inventory.offlineRegression.push(name);
      continue;
    }
    if (/^probe-.*\.js$/i.test(name) || TEST_SUPPORT_FILES.has(name)) {
      inventory.supportUtilities.push(name);
      continue;
    }
    if (/^run-.*\.(?:cmd|js)$/i.test(name)) {
      inventory.routeAndLiveHarnesses.push(name);
      continue;
    }
    inventory.unclassified.push(name);
  }

  return inventory;
}

function isTextSourceFile(filePath) {
  return /\.(?:js|json|cmd|ps1|md|txt)$/i.test(filePath);
}

function walkProjectTextFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['debug', 'archive', 'material', '.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkProjectTextFiles(full, out);
    else if (entry.isFile() && isTextSourceFile(full)) out.push(full);
  }
  return out;
}

function assertLegacyTestPathsAreIsolated() {
  const candidateAbs = new Set(LEGACY_TEST_PATHS.map(rel => path.resolve(ROOT, rel)));
  const files = walkProjectTextFiles(ROOT, []);
  const violations = [];

  for (const rel of LEGACY_TEST_PATHS) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const base = path.basename(rel);
    const normalized = normalizeRel(rel);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (candidateAbs.has(resolved)) continue;
      if (resolved === path.resolve(__filename)) continue;
      let textValue;
      try { textValue = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      if (textValue.includes(base) || textValue.includes(normalized) || textValue.includes(normalized.replace(/\//g, '\\'))) {
        violations.push({ legacy: rel, referencedBy: projectRelative(file) });
      }
    }
  }

  if (violations.length) {
    const detail = violations.map(v => `${v.legacy}<-${v.referencedBy}`).join(';');
    throw new Error(`V6_LEGACY_TEST_STILL_REFERENCED:${detail}`);
  }
}

function organizeLegacyTests(actions) {
  assertLegacyTestPathsAreIsolated();
  for (const rel of LEGACY_TEST_PATHS) {
    const src = path.join(ROOT, rel);
    const dst = path.join(LEGACY_TEST_ARCHIVE_ROOT, rel);
    movePath(src, dst, actions);
  }
  for (const rel of LEGACY_DEBUG_PATHS) {
    const src = path.join(ROOT, rel);
    const debugRel = normalizeRel(rel).replace(/^debug\//, '');
    const dst = path.join(LEGACY_DEBUG_ARCHIVE_ROOT, debugRel);
    movePath(src, dst, actions);
  }
}

function updateManifestWithTestInventory(actions) {
  const inventory = classifyRemainingTests();
  if (inventory.unclassified.length) {
    throw new Error(`V6_TEST_CATALOG_UNCLASSIFIED:${inventory.unclassified.join(',')}`);
  }

  let manifest = {};
  if (fs.existsSync(MANIFEST_PATH)) {
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch (_) { manifest = {}; }
  }
  manifest.version = Math.max(Number(manifest.version || 0), 3);
  manifest.layout = 'V6';
  manifest.generatedAt = new Date().toISOString();
  manifest.testInventory = {
    policy: {
      verifiedLive: 'PASS_LIVE card/branch entrypoints are stored under execution/live; execution/tests is offline regression only.',
      recoveryEntrypoints: 'live modal recovery entrypoints that preserve an already-open transaction',
      offlineRegression: 'no-game-input regression guards retained as active tests',
      supportUtilities: 'shared probes/helpers called by active live/composite harnesses',
      routeAndLiveHarnesses: 'retained live route/atomic harnesses not yet archived',
      archivedLegacy: 'old V5 exploratory/nodewise harnesses isolated from production V6',
      debug: 'debug directories belonging only to archived legacy harnesses are moved out of debug'
    },
    verifiedLive: inventory.verifiedLive,
    recoveryEntrypoints: inventory.recoveryEntrypoints,
    offlineRegression: inventory.offlineRegression,
    supportUtilities: inventory.supportUtilities,
    routeAndLiveHarnesses: inventory.routeAndLiveHarnesses,
    unclassified: inventory.unclassified,
    archivedLegacyPaths: LEGACY_TEST_PATHS.map(normalizeRel),
    archivedLegacyDebugPaths: LEGACY_DEBUG_PATHS.map(normalizeRel)
  };
  if (!Array.isArray(manifest.stageHistory)) manifest.stageHistory = [];
  manifest.stageHistory.push({
    stage: 'V6_TEST_ORGANIZATION',
    appliedAt: new Date().toISOString(),
    actions: actions.map(action => ({ ...action }))
  });

  if (APPLY) {
    ensureParent(MANIFEST_PATH);
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return inventory;
}

function runTestOrganization() {
  ensureProjectRoot();
  const actions = [];
  if (APPLY) {
    ensureDir(LEGACY_TEST_ARCHIVE_ROOT);
    ensureDir(LEGACY_DEBUG_ARCHIVE_ROOT);
  }
  organizeLegacyTests(actions);

  // In plan mode the old files still physically exist, so calculate the post-move
  // inventory by ignoring the legacy basenames that are scheduled for archival.
  let inventory;
  if (APPLY) {
    inventory = updateManifestWithTestInventory(actions);
  } else {
    const legacyNames = new Set(
      LEGACY_TEST_PATHS
        .filter(rel => normalizeRel(rel).startsWith('execution/tests/'))
        .map(rel => path.basename(rel))
    );
    const originalRead = fs.readdirSync;
    fs.readdirSync = function patchedRead(dir, options) {
      const result = originalRead.call(fs, dir, options);
      if (path.resolve(dir) !== path.resolve(TESTS_ROOT)) return result;
      if (options && options.withFileTypes) return result.filter(entry => !legacyNames.has(entry.name));
      return result.filter(name => !legacyNames.has(name));
    };
    try {
      inventory = classifyRemainingTests();
    } finally {
      fs.readdirSync = originalRead;
    }
    if (inventory.unclassified.length) {
      throw new Error(`V6_TEST_CATALOG_UNCLASSIFIED:${inventory.unclassified.join(',')}`);
    }
  }

  console.log(`V6 TEST ORGANIZATION ${APPLY ? 'APPLY' : 'PLAN'}:`);
  for (const action of actions) {
    console.log(`- ${action.type}: ${action.from || ''}${action.to ? ` -> ${action.to}` : ''}`);
  }
  console.log(`- verified live files: ${inventory.verifiedLive.length}`);
  console.log(`- recovery entry files: ${inventory.recoveryEntrypoints.length}`);
  console.log(`- offline regression files: ${inventory.offlineRegression.length}`);
  console.log(`- support utility files: ${inventory.supportUtilities.length}`);
  console.log(`- retained route/live harness files: ${inventory.routeAndLiveHarnesses.length}`);
  console.log(`- unclassified files: ${inventory.unclassified.length}`);
  if (APPLY) console.log(`PASS: updated ${projectRelative(MANIFEST_PATH)}`);
  else console.log('No files changed. Re-run with --organize-tests --apply after checking this plan.');
}


function assertLegacyCodePathsAreIsolated() {
  const candidateAbs = new Set(LEGACY_CODE_PATHS.map(rel => path.resolve(ROOT, rel)));
  const files = walkProjectTextFiles(ROOT, []);
  const violations = [];

  for (const rel of LEGACY_CODE_PATHS) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const base = path.basename(rel);
    const normalized = normalizeRel(rel);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (candidateAbs.has(resolved)) continue;
      if (resolved === path.resolve(__filename)) continue;
      let textValue;
      try { textValue = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      if (
        textValue.includes(base) ||
        textValue.includes(normalized) ||
        textValue.includes(normalized.replace(/\//g, '\\'))
      ) {
        violations.push({ legacy: rel, referencedBy: projectRelative(file) });
      }
    }
  }

  if (violations.length) {
    const detail = violations.map(v => `${v.legacy}<-${v.referencedBy}`).join(';');
    throw new Error(`V6_LEGACY_CODE_STILL_REFERENCED:${detail}`);
  }
}

function lineCount(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length;
}

function organizeLegacyCode(actions) {
  assertLegacyCodePathsAreIsolated();
  for (const rel of LEGACY_CODE_PATHS) {
    const src = path.join(ROOT, rel);
    const dst = path.join(LEGACY_CODE_ARCHIVE_ROOT, rel);
    movePath(src, dst, actions);
  }
}

function updateManifestWithCodeInventory(actions) {
  let manifest = {};
  if (fs.existsSync(MANIFEST_PATH)) {
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch (_) { manifest = {}; }
  }

  manifest.version = Math.max(Number(manifest.version || 0), 4);
  manifest.layout = 'V6';
  manifest.generatedAt = new Date().toISOString();
  manifest.codeInventory = {
    policy: {
      semanticSafety: 'Stage 3 removes only exact duplicate helpers or zero-reference legacy modules; mature LIVE_PASS atoms are not behavior-refactored.',
      productionTests: 'Stage 19 moves live executors/launchers/probes to execution/live; execution/tests is reserved for offline regression. Legacy verified testEntry paths are migrated with a runtime compatibility fallback.',
      monoliths: 'runtime/main-v6.js and atomic-route-executor.js remain intact because they own many live atomic checkpoints; split only with dedicated regressions.'
    },
    sharedHelpers: [
      'execution/core/recognition-result.js',
      'execution/core/verified-registry.js'
    ],
    compatibilityFacades: [
      'execution/core/verified-status.js',
      'execution/core/verified-branch-status.js'
    ],
    archivedLegacyCodePaths: LEGACY_CODE_PATHS.map(normalizeRel),
    preservedLargeRuntimeFiles: [
      {
        path: 'runtime/main-v6.js',
        lines: lineCount(path.join(ROOT, 'runtime', 'main-v6.js'))
      },
      {
        path: 'execution/core/atomic-route-executor.js',
        lines: lineCount(path.join(ROOT, 'execution', 'core', 'atomic-route-executor.js'))
      }
    ]
  };

  if (!Array.isArray(manifest.stageHistory)) manifest.stageHistory = [];
  manifest.stageHistory.push({
    stage: 'V6_CODE_DEDUP_STAGE3',
    appliedAt: new Date().toISOString(),
    actions: actions.map(action => ({ ...action }))
  });

  if (APPLY) {
    ensureParent(MANIFEST_PATH);
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return manifest.codeInventory;
}

function runCodeOrganization() {
  ensureProjectRoot();
  const actions = [];
  if (APPLY) ensureDir(LEGACY_CODE_ARCHIVE_ROOT);

  organizeLegacyCode(actions);
  const inventory = updateManifestWithCodeInventory(actions);

  console.log(`V6 CODE ORGANIZATION ${APPLY ? 'APPLY' : 'PLAN'}:`);
  for (const action of actions) {
    console.log(`- ${action.type}: ${action.from || ''}${action.to ? ` -> ${action.to}` : ''}`);
  }
  console.log(`- shared helper modules: ${inventory.sharedHelpers.length}`);
  console.log(`- compatibility facades: ${inventory.compatibilityFacades.length}`);
  console.log(`- zero-reference legacy modules: ${LEGACY_CODE_PATHS.length}`);
  console.log('- mature LIVE_PASS execution semantics changed: 0');
  if (APPLY) console.log(`PASS: updated ${projectRelative(MANIFEST_PATH)}`);
  else console.log('No files changed. Re-run with --organize-code --apply after checking this plan.');
}


function main() {
  assertRequiredNodeRuntime();
  ensureProjectRoot();
  const actions = [];
  const promotedEvidence = [];

  if (APPLY) {
    ensureDir(path.join(MATERIAL_ROOT, 'issues'));
    ensureDir(path.join(MATERIAL_ROOT, 'handoff'));
    ensureDir(path.join(MATERIAL_ROOT, 'verified'));
    ensureDir(VERIFIED_EVIDENCE_ROOT);
    ensureDir(ARCHIVE_ROOT);
  }

  // V6 has one canonical issue log.  Move it out of debug; do not leave a duplicate.
  moveCanonicalFile(LEGACY_ISSUE_LOG_PATH, ISSUE_LOG_PATH, actions);

  const rootIssue = path.join(ROOT, 'V5_issue_log.txt');
  if (!fs.existsSync(ISSUE_LOG_PATH) && !fs.existsSync(LEGACY_ISSUE_LOG_PATH)) {
    moveCanonicalFile(rootIssue, ISSUE_LOG_PATH, actions);
  }

  const handoff = locateHandoff();
  rewriteHandoff(
    handoff,
    path.join(MATERIAL_ROOT, 'handoff', 'MD_PC_Decision_V6_HANDOFF.md'),
    actions
  );

  migrateVerifiedRegistry(actions, promotedEvidence);
  archiveKnownDeprecated(actions);

  const uniqueEvidenceSources = new Set(
    promotedEvidence
      .filter(item => item.from)
      .map(item => String(item.from).toLowerCase())
  ).size;
  const missingEvidence = promotedEvidence.filter(item => item.status === 'MISSING_SOURCE');

  const manifest = {
    version: 2,
    layout: 'V6',
    generatedAt: new Date().toISOString(),
    applied: APPLY,
    policy: {
      debug: 'current/runtime evidence only; historical PASS_LIVE evidence is removed after durable promotion',
      material: 'durable issue log, handoff, verified registry, and promoted LIVE_PASS evidence',
      archive: 'deprecated patches, one-off recovery scripts, stale documents, and patch history; not loaded by production V6'
    },
    canonical: {
      issueLog: projectRelative(ISSUE_LOG_PATH),
      handoff: 'material\\handoff\\MD_PC_Decision_V6_HANDOFF.md',
      verifiedRegistry: projectRelative(VERIFIED_STATUS_PATH),
      verifiedEvidenceRoot: projectRelative(VERIFIED_EVIDENCE_ROOT)
    },
    actions,
    promotedEvidence,
    summary: {
      verifiedRegistryEntries: promotedEvidence.length,
      uniqueEvidenceSources,
      missingEvidenceEntries: missingEvidence.length
    }
  };

  console.log(`V6 STORAGE ${APPLY ? 'APPLY' : 'PLAN'}:`);
  for (const action of actions) {
    console.log(`- ${action.type}: ${action.from || ''}${action.to ? ` -> ${action.to}` : ''}`);
  }
  if (promotedEvidence.length) {
    console.log(`- verified registry entries: ${promotedEvidence.length}`);
    console.log(`- unique verified evidence dirs: ${uniqueEvidenceSources}`);
  }
  if (missingEvidence.length) {
    console.log(`- WARNING missing verified evidence entries: ${missingEvidence.length}`);
    for (const item of missingEvidence) {
      console.log(`  * ${item.kind}:${item.key} -> ${item.from}`);
    }
  }

  if (APPLY) {
    ensureParent(MANIFEST_PATH);
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`PASS: ${projectRelative(MANIFEST_PATH)}`);
  } else {
    console.log('No files changed. Re-run with --apply after checking this plan.');
  }
}

try {
  assertRequiredNodeRuntime();
  if (ORGANIZE_CODE) runCodeOrganization();
  else if (ORGANIZE_TESTS) runTestOrganization();
  else main();
} catch (err) {
  console.error(`V6 STORAGE FAIL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}
