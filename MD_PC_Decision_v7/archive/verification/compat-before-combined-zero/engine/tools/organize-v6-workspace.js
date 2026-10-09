'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_ROOT = path.join(ROOT, 'debug');
const MATERIAL_ROOT = path.join(ROOT, 'material');
const MATERIALS_ROOT = path.join(ROOT, 'materials');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');
const VERIFIED_PATH = path.join(MATERIAL_ROOT, 'verified', 'verified-cards.json');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DEDUPE = args.has('--dedupe-immutable-images');

const OLD_ROOT_RUNTIME = [
  'capture-hand-scroll-segments-live.js',
  'observe-hand-change-incremental-live.js',
  'run-duel-observer.js',
  'run-live-incremental.js',
  'run-opening-observer-fast.js',
  'run-prepared-baseline-flex.js',
  'scan-state.js',
  'test-duel-log-live.js',
  'test-hand-info-live.js',
  'test-scan-state-live.js',
  'reset-duel-state.js'
];

const PROTECTED_DEBUG_TOP = new Set([
  'scan-state-live',
  'hand-change-live',
  'duel-log-live',
  'composite-route-live',
  'performance',
  'duel-outcome-live',
  'duel-observer',
  'hand-layout-live',
  'main-deck-ledger'
]);

const RESEARCH_DIRS = new Set([
  'mallet-baseline-study',
  'spell-material-capture'
]);

const MATERIALS_RESEARCH_DIRS = new Set([
  'legacy-hand-calibration'
]);

const CURRENT_STATE_FILES = [
  'decision-state.json',
  'debug/hand-change-live/session_state.json',
  'debug/hand-change-live/latest_incremental_result.json',
  'debug/duel-log-live/observer_state.json',
  'debug/duel-log-live/latest_result.json',
  'debug/main-deck-ledger/state.json',
  'debug/composite-route-live/session_state.json',
  'debug/composite-route-live/latest_result.json',
  'debug/duel-observer/session.json',
  'debug/duel-observer/latest_step.json',
  'debug/duel-outcome-live/latest_result.json',
  'debug/scan-state-live/prepared/result.json',
  'debug/hand-layout-live/dense_segment_latest.json'
];

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.bmp','.webp']);
const TEXT_EXTS = new Set(['.json','.jsonl','.txt','.log','.csv','.md']);
const RUN_DIR_RX = /^(?:\d{4}-\d{2}-\d{2}T|\d{8}[_-]\d{6})/i;
const LIVE_PASS_RX = /\b(?:LIVE_PASS|PASS_LIVE|PASS_TERMINAL_VICTORY|PASS_LIVE_TERMINAL)\b/i;
const GENERIC_PASS_RX = /(?:["']?(?:status|result|verdict|outcome)["']?\s*[:=]\s*["']?(?:PASS|SUCCESS|LIVE_PASS)["']?)/i;

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function exists(p) {
  return fs.existsSync(p);
}
function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function walkFiles(dir, out = []) {
  if (!exists(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}
function dirStats(dir) {
  let files = 0, bytes = 0, images = 0, imageBytes = 0;
  for (const p of walkFiles(dir, [])) {
    const st = statSafe(p);
    if (!st) continue;
    files += 1; bytes += st.size;
    if (IMAGE_EXTS.has(path.extname(p).toLowerCase())) {
      images += 1; imageBytes += st.size;
    }
  }
  return { files, bytes, images, imageBytes };
}
function human(n) {
  const u = ['B','KB','MB','GB','TB'];
  let x = Number(n || 0), i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(i ? 2 : 0)} ${u[i]}`;
}
function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function moveDirSafe(src, dst) {
  if (!exists(src)) return null;
  ensureDir(path.dirname(dst));
  let finalDst = dst;
  if (exists(finalDst)) finalDst = `${dst}__${timestampId()}`;
  fs.renameSync(src, finalDst);
  return finalDst;
}
function removeEmptyDirs(dir) {
  if (!exists(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const child = path.join(dir, ent.name);
    removeEmptyDirs(child);
    try {
      if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
    } catch {}
  }
}
function rootZipCandidates() {
  if (!exists(ROOT)) return [];
  const rx = /^V6_(?:active_code(?:_full)?|Storage_|Test_|Code_|State_|Strategy_|Batch_|Verified_|Mega_).*\.zip$/i;
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(ent => ent.isFile() && rx.test(ent.name))
    .map(ent => path.join(ROOT, ent.name));
}
function readSmallText(file, max = 2 * 1024 * 1024) {
  const st = statSafe(file);
  if (!st || st.size > max) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function successEvidence(dir) {
  let strictLivePass = false;
  let genericPass = false;
  const examples = [];

  for (const file of walkFiles(dir, [])) {
    if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) continue;
    const text = readSmallText(file);
    if (!text) continue;

    if (LIVE_PASS_RX.test(text)) {
      strictLivePass = true;
      if (examples.length < 4) examples.push(rel(file));
      continue;
    }

    const base = path.basename(file).toLowerCase();
    if (
      (base === 'result.json' ||
       base === 'summary.json' ||
       base === 'latest_result.json' ||
       base.endsWith('_result.json')) &&
      GENERIC_PASS_RX.test(text)
    ) {
      genericPass = true;
      if (examples.length < 4) examples.push(rel(file));
    }
  }

  return {
    pass: strictLivePass || genericPass,
    strictLivePass,
    genericPass,
    examples
  };
}
function readVerifiedRefs() {
  const refs = new Set();
  if (!exists(VERIFIED_PATH)) return refs;
  let data;
  try { data = JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8')); } catch { return refs; }
  for (const bucket of [data.cards || {}, data.branches || {}]) {
    for (const row of Object.values(bucket)) {
      if (!row || !row.evidenceDir) continue;
      refs.add(path.resolve(ROOT, String(row.evidenceDir).replace(/[\\/]+/g, path.sep)));
    }
  }
  return refs;
}
function isWithin(parent, child) {
  const r = path.relative(path.resolve(parent), path.resolve(child));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
function currentReferenceCorpus() {
  const chunks = [];
  for (const relPath of CURRENT_STATE_FILES) {
    const p = path.join(ROOT, ...relPath.split('/'));
    const txt = readSmallText(p, 8 * 1024 * 1024);
    if (txt) chunks.push(txt);
  }

  const executionRoot = path.join(DEBUG_ROOT, 'execution');
  if (exists(executionRoot)) {
    for (const group of fs.readdirSync(executionRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(executionRoot, group.name);
      for (const ent of fs.readdirSync(groupDir, { withFileTypes: true })) {
        const p = path.join(groupDir, ent.name);
        if (ent.isFile() && TEXT_EXTS.has(path.extname(p).toLowerCase())) {
          const txt = readSmallText(p);
          if (txt) chunks.push(txt);
        } else if (ent.isDirectory() && /^_(?:resume|state|current)$/i.test(ent.name)) {
          for (const f of walkFiles(p, [])) {
            if (!TEXT_EXTS.has(path.extname(f).toLowerCase())) continue;
            const txt = readSmallText(f);
            if (txt) chunks.push(txt);
          }
        }
      }
    }
  }
  return chunks.join('\n');
}
function externallyReferenced(candidate, corpus, verifiedRefs) {
  const r = rel(candidate);
  const normalized = r.replace(/\//g, '\\');
  if (corpus.includes(r) || corpus.includes(normalized) || corpus.includes(path.basename(candidate))) {
    return true;
  }
  for (const ref of verifiedRefs) {
    if (isWithin(candidate, ref) || isWithin(ref, candidate)) return true;
  }
  return false;
}
function executionRunPlan() {
  const root = path.join(DEBUG_ROOT, 'execution');
  const verifiedRefs = readVerifiedRefs();
  const corpus = currentReferenceCorpus();
  const rows = [];
  if (!exists(root)) return rows;

  const PASS_REPRESENTATIVES_PER_GROUP = 1;
  const RECENT_NONPASS_PER_GROUP = 2;

  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(root, group.name);

    const runDirs = fs.readdirSync(groupDir, { withFileTypes: true })
      .filter(ent => ent.isDirectory() && RUN_DIR_RX.test(ent.name))
      .map(ent => path.join(groupDir, ent.name))
      .sort((a,b) => (statSafe(b)?.mtimeMs || 0) - (statSafe(a)?.mtimeMs || 0));

    const staged = [];
    for (const runDir of runDirs) {
      const stats = dirStats(runDir);

      if (externallyReferenced(runDir, corpus, verifiedRefs)) {
        staged.push({
          kind: 'KEEP_CURRENT_REF',
          group: group.name,
          runDir,
          stats,
          evidence: { pass: false, examples: [] }
        });
        continue;
      }

      const evidence = successEvidence(runDir);
      staged.push({
        kind: evidence.pass ? 'PASS_UNCLASSIFIED' : 'NONPASS_UNCLASSIFIED',
        group: group.name,
        runDir,
        stats,
        evidence
      });
    }

    let passKept = 0;
    let nonPassKept = 0;

    for (const row of staged) {
      if (row.kind === 'KEEP_CURRENT_REF') {
        rows.push(row);
        continue;
      }

      if (row.kind === 'PASS_UNCLASSIFIED') {
        if (passKept < PASS_REPRESENTATIVES_PER_GROUP) {
          rows.push({ ...row, kind: 'PROMOTE_PASS_REP' });
          passKept += 1;
        } else {
          rows.push({ ...row, kind: 'ARCHIVE_PASS_HISTORY' });
        }
        continue;
      }

      if (nonPassKept < RECENT_NONPASS_PER_GROUP) {
        rows.push({ ...row, kind: 'KEEP_RECENT_NONPASS' });
        nonPassKept += 1;
      } else {
        rows.push({ ...row, kind: 'ARCHIVE_HISTORY' });
      }
    }
  }

  return rows;
}
function buildExternalTextCorpusForDense() {
  const chunks = [];
  const roots = [DEBUG_ROOT, MATERIAL_ROOT];
  for (const base of roots) {
    if (!exists(base)) continue;
    for (const file of walkFiles(base, [])) {
      if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) continue;
      const txt = readSmallText(file, 4 * 1024 * 1024);
      if (txt) chunks.push(txt);
    }
  }
  for (const name of ['decision-state.json']) {
    const txt = readSmallText(path.join(ROOT, name));
    if (txt) chunks.push(txt);
  }
  return chunks.join('\n');
}
function denseCapturePlan() {
  const root = path.join(MATERIALS_ROOT, 'hand-layout', 'dense_segment');
  if (!exists(root)) return [];
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(ent => ent.isDirectory())
    .map(ent => path.join(root, ent.name))
    .sort((a,b) => (statSafe(b)?.mtimeMs || 0) - (statSafe(a)?.mtimeMs || 0));

  const corpus = buildExternalTextCorpusForDense();
  const keepNewest = new Set(dirs.slice(0, 3).map(dir => path.resolve(dir)));
  return dirs.map(dir => {
    const stats = dirStats(dir);
    const name = path.basename(dir);
    const relPath = rel(dir);
    const referenced =
      corpus.includes(relPath) ||
      corpus.includes(relPath.replace(/\//g, '\\')) ||
      corpus.includes(name);
    if (referenced || keepNewest.has(path.resolve(dir))) {
      return { kind: referenced ? 'KEEP_REFERENCED' : 'KEEP_NEWEST', dir, stats };
    }
    return { kind: 'ARCHIVE_ORPHAN_CAPTURE', dir, stats };
  });
}
function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
function immutableRoots() {
  return [
    path.join(MATERIAL_ROOT, 'verified', 'evidence'),
    path.join(MATERIAL_ROOT, 'verified', 'candidates'),
    path.join(MATERIAL_ROOT, 'research'),
    path.join(ARCHIVE_ROOT, 'debug-execution-history'),
    path.join(ARCHIVE_ROOT, 'debug-execution-pass-history'),
    path.join(ARCHIVE_ROOT, 'legacy-debug'),
    path.join(ARCHIVE_ROOT, 'runtime-captures'),
    path.join(ARCHIVE_ROOT, 'materials-legacy')
  ].filter(exists);
}
function duplicateGroups() {
  const files = [];
  for (const base of immutableRoots()) {
    for (const f of walkFiles(base, [])) {
      if (!IMAGE_EXTS.has(path.extname(f).toLowerCase())) continue;
      const st = statSafe(f);
      if (st) files.push({ file: f, size: st.size });
    }
  }
  const bySize = new Map();
  for (const row of files) {
    if (!bySize.has(row.size)) bySize.set(row.size, []);
    bySize.get(row.size).push(row.file);
  }
  const groups = [];
  for (const sameSize of bySize.values()) {
    if (sameSize.length < 2) continue;
    const byHash = new Map();
    for (const file of sameSize) {
      const h = sha256(file);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(file);
    }
    for (const same of byHash.values()) if (same.length > 1) groups.push(same);
  }
  return groups;
}
function hardlinkDuplicates(groups) {
  let bytes = 0, linked = 0;
  for (const group of groups) {
    const canonical = group[0];
    for (const duplicate of group.slice(1)) {
      const st = statSafe(duplicate);
      if (!st) continue;
      const cst = statSafe(canonical);
      if (cst && st.ino && cst.ino && st.ino === cst.ino) continue;
      const backup = `${duplicate}.dedupe-backup-${process.pid}`;
      try {
        fs.renameSync(duplicate, backup);
        fs.linkSync(canonical, duplicate);
        fs.unlinkSync(backup);
        bytes += st.size;
        linked += 1;
      } catch (err) {
        try {
          if (!exists(duplicate) && exists(backup)) fs.renameSync(backup, duplicate);
        } catch {}
        console.log(`  DEDUPE SKIP ${rel(duplicate)}: ${err.code || err.message}`);
      }
    }
  }
  return { bytes, linked };
}

function activeSourceCorpus() {
  const chunks = [];
  const roots = [
    ROOT,
    path.join(ROOT, 'lib'),
    path.join(ROOT, 'execution'),
    path.join(ROOT, 'runtime'),
    path.join(ROOT, 'tools'),
    path.join(ROOT, 'scripts')
  ];
  const seen = new Set();

  for (const base of roots) {
    if (!exists(base)) continue;
    const candidates = statSafe(base)?.isFile() ? [base] : walkFiles(base, []);
    for (const file of candidates) {
      const abs = path.resolve(file);
      if (seen.has(abs)) continue;
      seen.add(abs);

      const r = rel(file);
      const baseName = path.basename(file).toLowerCase();
      if (
        r === 'tools/organize-v6-workspace.js' ||
        r === 'tools/audit-v6-storage-assets.js' ||
        /(?:^|\/)test-.*-offline\.js$/i.test(r) ||
        r === 'execution/tests/test-stage16-safe-layout-offline.js' ||
        r.startsWith('debug/') ||
        r.startsWith('material/') ||
        r.startsWith('materials/') ||
        r.startsWith('archive/') ||
        r.startsWith('node_modules/') ||
        r.startsWith('templates/')
      ) continue;

      if (!['.js','.cmd','.ps1','.json'].includes(path.extname(file).toLowerCase())) continue;
      const t = readSmallText(file, 4 * 1024 * 1024);
      if (t) chunks.push(t);
    }
  }
  return chunks.join('\n');
}

function legacyMaterialsPlan() {
  const corpus = activeSourceCorpus();
  const candidates = ['cases', 'ui-semantic'];
  const rows = [];

  for (const name of candidates) {
    const dir = path.join(MATERIALS_ROOT, name);
    if (!exists(dir)) continue;

    const stats = dirStats(dir);
    const slashRef = `materials/${name}`;
    const backslashRef = `materials\\${name}`;
    const activelyReferenced =
      corpus.includes(slashRef) ||
      corpus.includes(backslashRef);

    rows.push({
      name,
      dir,
      stats,
      activelyReferenced,
      kind: activelyReferenced ? 'KEEP_ACTIVE_REF' : 'ARCHIVE_UNREFERENCED'
    });
  }
  return rows;
}


function handLayoutLegacyPlan() {
  const corpus = activeSourceCorpus();
  const root = path.join(MATERIALS_ROOT, 'hand-layout');
  const rows = [];
  if (!exists(root)) return rows;

  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'dense_segment') continue;

    const dir = path.join(root, ent.name);
    const stats = dirStats(dir);
    const slashRef = `materials/hand-layout/${ent.name}`;
    const backslashRef = `materials\\hand-layout\\${ent.name}`;
    const activelyReferenced =
      corpus.includes(slashRef) ||
      corpus.includes(backslashRef);

    rows.push({
      name: ent.name,
      dir,
      stats,
      activelyReferenced,
      kind: activelyReferenced ? 'KEEP_ACTIVE_REF' : 'ARCHIVE_UNREFERENCED'
    });
  }

  return rows;
}

function handLayoutSubdirSummary() {
  const root = path.join(MATERIALS_ROOT, 'hand-layout');
  const rows = [];
  if (!exists(root)) return rows;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    rows.push({
      name: ent.name,
      stats: dirStats(path.join(root, ent.name))
    });
  }
  rows.sort((a,b) => b.stats.bytes - a.stats.bytes);
  return rows;
}

function materialsSummary() {
  const rows = [];
  if (!exists(MATERIALS_ROOT)) return rows;
  for (const ent of fs.readdirSync(MATERIALS_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    rows.push({ name: ent.name, stats: dirStats(path.join(MATERIALS_ROOT, ent.name)) });
  }
  rows.sort((a,b) => b.stats.bytes - a.stats.bytes);
  return rows;
}

function main() {
  const required = [
    'runtime/observer/run-duel-observer.js',
    'runtime/observer/run-live-incremental.js',
    'runtime/observer/test-duel-log-live.js',
    'tools/reset-duel-state.js'
  ];
  for (const req of required) {
    if (!exists(path.join(ROOT, ...req.split('/')))) {
      throw new Error(`STAGE16_RUNTIME_LAYOUT_MISSING:${req}`);
    }
  }

  console.log('============================================================');
  console.log(`V6 SAFE MEGA ORGANIZER — ${APPLY ? 'APPLY' : 'PLAN ONLY'}`);
  console.log('不会清空 active debug；不会移动 templates；不会移动 materials/ui/outcomes。');
  console.log('============================================================');

  const oldRoot = OLD_ROOT_RUNTIME
    .map(name => path.join(ROOT, name))
    .filter(exists);
  console.log(`\n[ROOT] legacy runtime files -> archive: ${oldRoot.length}`);
  oldRoot.forEach(p => console.log(`  ${rel(p)}`));

  const zips = rootZipCandidates();
  const zipBytes = zips.reduce((n,p) => n + (statSafe(p)?.size || 0), 0);
  console.log(`[ROOT] generated V6 ZIPs -> delete: ${zips.length} (${human(zipBytes)})`);
  zips.forEach(p => console.log(`  ${rel(p)}`));

  console.log('\n[DEBUG] fixed classifications');
  for (const name of PROTECTED_DEBUG_TOP) {
    const p = path.join(DEBUG_ROOT, name);
    if (exists(p)) console.log(`  KEEP active runtime: debug/${name}/ (${human(dirStats(p).bytes)})`);
  }
  const legacyV5 = path.join(DEBUG_ROOT, 'v5');
  if (exists(legacyV5)) console.log(`  ARCHIVE legacy: debug/v5/ (${human(dirStats(legacyV5).bytes)})`);
  for (const name of RESEARCH_DIRS) {
    const p = path.join(DEBUG_ROOT, name);
    if (exists(p)) console.log(`  PROMOTE research: debug/${name}/ -> material/research/${name}/ (${human(dirStats(p).bytes)})`);
  }

  const runs = executionRunPlan();
  const counts = {};
  const bytes = {};
  for (const row of runs) {
    counts[row.kind] = (counts[row.kind] || 0) + 1;
    bytes[row.kind] = (bytes[row.kind] || 0) + row.stats.bytes;
  }
  console.log('\n[DEBUG/execution] timestamp-run triage');
  for (const kind of [
    'KEEP_CURRENT_REF',
    'PROMOTE_PASS_REP',
    'ARCHIVE_PASS_HISTORY',
    'KEEP_RECENT_NONPASS',
    'ARCHIVE_HISTORY'
  ]) {
    console.log(`  ${kind}: ${counts[kind] || 0} runs (${human(bytes[kind] || 0)})`);
  }

  console.log('\n[MATERIALS] top-level usage summary');
  for (const row of materialsSummary()) {
    let tag = 'KEEP/REVIEW';
    if (row.name === 'ui') tag = 'KEEP ACTIVE';
    if (row.name === 'legacy-hand-calibration') tag = 'KEEP CALIBRATION';
    if (row.name === 'hand-layout') tag = 'GENERATED CAPTURES + CURRENT WITNESS';
    console.log(`  ${tag.padEnd(30)} ${human(row.stats.bytes).padStart(10)}  materials/${row.name}/`);
  }

  const legacyMaterials = legacyMaterialsPlan();
  console.log('\n[MATERIALS] inactive-library triage from active-code references');
  for (const row of legacyMaterials) {
    console.log(
      `  ${row.kind.padEnd(24)} ${human(row.stats.bytes).padStart(10)}  materials/${row.name}/`
    );
  }

  console.log('\n[MATERIALS] research promotion');
  for (const name of MATERIALS_RESEARCH_DIRS) {
    const dir = path.join(MATERIALS_ROOT, name);
    if (exists(dir)) {
      console.log(
        `  PROMOTE_RESEARCH          ${human(dirStats(dir).bytes).padStart(10)}  ` +
        `materials/${name}/ -> material/research/${name}/`
      );
    }
  }

  const handLegacy = handLayoutLegacyPlan();
  if (handLegacy.length) {
    console.log('\n[MATERIALS/hand-layout] non-dense capture triage');
    for (const row of handLegacy) {
      console.log(
        `  ${row.kind.padEnd(24)} ${human(row.stats.bytes).padStart(10)}  ${row.name}/`
      );
    }
  }

  const handSubdirs = handLayoutSubdirSummary();
  if (handSubdirs.length) {
    console.log('\n[MATERIALS/hand-layout] subdirectories');
    for (const row of handSubdirs) {
      console.log(`  ${human(row.stats.bytes).padStart(10)}  ${row.name}/`);
    }
  }

  const dense = denseCapturePlan();
  const denseCounts = {};
  const denseBytes = {};
  for (const row of dense) {
    denseCounts[row.kind] = (denseCounts[row.kind] || 0) + 1;
    denseBytes[row.kind] = (denseBytes[row.kind] || 0) + row.stats.bytes;
  }
  if (dense.length) {
    console.log('\n[MATERIALS/hand-layout/dense_segment] capture triage');
    for (const kind of ['KEEP_REFERENCED','KEEP_NEWEST','ARCHIVE_ORPHAN_CAPTURE']) {
      console.log(`  ${kind}: ${denseCounts[kind] || 0} dirs (${human(denseBytes[kind] || 0)})`);
    }
  }

  if (!APPLY) {
    console.log('\nPLAN ONLY: no files changed.');
    console.log('Apply with: .\\tools\\launchers\\organize-v6-workspace.cmd --apply');
    console.log('Optional exact duplicate compaction after archival: add --dedupe-immutable-images');
    return;
  }

  const legacyRootDest = path.join(ARCHIVE_ROOT, 'legacy-root-runtime', 'stage16-layout');
  ensureDir(legacyRootDest);
  for (const src of oldRoot) {
    const dst = path.join(legacyRootDest, path.basename(src));
    if (exists(dst)) fs.rmSync(dst, { force: true });
    fs.renameSync(src, dst);
  }
  for (const zip of zips) fs.rmSync(zip, { force: true });

  if (exists(legacyV5)) {
    moveDirSafe(legacyV5, path.join(ARCHIVE_ROOT, 'legacy-debug', 'v5'));
  }
  for (const name of RESEARCH_DIRS) {
    const src = path.join(DEBUG_ROOT, name);
    if (exists(src)) moveDirSafe(src, path.join(MATERIAL_ROOT, 'research', name));
  }

  for (const row of runs) {
    if (row.kind === 'KEEP_CURRENT_REF' || row.kind === 'KEEP_RECENT_NONPASS') continue;

    if (row.kind === 'PROMOTE_PASS_REP') {
      moveDirSafe(
        row.runDir,
        path.join(MATERIAL_ROOT, 'verified', 'candidates', row.group, path.basename(row.runDir))
      );
    } else if (row.kind === 'ARCHIVE_PASS_HISTORY') {
      moveDirSafe(
        row.runDir,
        path.join(ARCHIVE_ROOT, 'debug-execution-pass-history', row.group, path.basename(row.runDir))
      );
    } else if (row.kind === 'ARCHIVE_HISTORY') {
      moveDirSafe(
        row.runDir,
        path.join(ARCHIVE_ROOT, 'debug-execution-history', row.group, path.basename(row.runDir))
      );
    }
  }

  for (const row of legacyMaterials) {
    if (row.kind !== 'ARCHIVE_UNREFERENCED') continue;
    moveDirSafe(
      row.dir,
      path.join(ARCHIVE_ROOT, 'materials-legacy', row.name)
    );
  }

  for (const name of MATERIALS_RESEARCH_DIRS) {
    const src = path.join(MATERIALS_ROOT, name);
    if (!exists(src)) continue;
    moveDirSafe(
      src,
      path.join(MATERIAL_ROOT, 'research', name)
    );
  }

  for (const row of handLegacy) {
    if (row.kind !== 'ARCHIVE_UNREFERENCED') continue;
    moveDirSafe(
      row.dir,
      path.join(ARCHIVE_ROOT, 'runtime-captures', 'hand-layout', row.name)
    );
  }

  for (const row of dense) {
    if (row.kind !== 'ARCHIVE_ORPHAN_CAPTURE') continue;
    moveDirSafe(
      row.dir,
      path.join(ARCHIVE_ROOT, 'runtime-captures', 'hand-layout', 'dense_segment', path.basename(row.dir))
    );
  }

  removeEmptyDirs(DEBUG_ROOT);
  removeEmptyDirs(path.join(MATERIALS_ROOT, 'hand-layout', 'dense_segment'));

  if (DEDUPE) {
    console.log('\n[DEDUPE] hashing immutable image stores...');
    const groups = duplicateGroups();
    const theoretical = groups.reduce((sum,g) => sum + (statSafe(g[0])?.size || 0) * (g.length - 1), 0);
    console.log(`  exact duplicate groups=${groups.length}; theoretical duplicate bytes=${human(theoretical)}`);
    const result = hardlinkDuplicates(groups);
    console.log(`  hardlinked=${result.linked}; physical bytes reclaimed≈${human(result.bytes)}`);
  }

  console.log('\nSAFE ORGANIZER APPLY PASS');
  console.log('Active runtime debug was preserved. One representative successful run per execution group was promoted, older successful runs were archived, two recent non-pass runs per group were retained, inactive legacy material libraries/captures were archived, research calibration was promoted, generated root ZIPs removed.');
}

try { main(); }
catch (err) {
  console.error(`V6 SAFE ORGANIZER FAIL: ${err && err.stack || err}`);
  process.exitCode = 1;
}
