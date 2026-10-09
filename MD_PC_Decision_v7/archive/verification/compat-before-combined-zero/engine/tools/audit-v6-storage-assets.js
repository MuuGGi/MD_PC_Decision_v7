'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_ROOT = path.join(ROOT, 'debug');
const MATERIAL_ROOT = path.join(ROOT, 'material');
const MATERIALS_ROOT = path.join(ROOT, 'materials');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');

const args = new Set(process.argv.slice(2));
const HASH_IMAGES = args.has('--hash-images');
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const CODE_EXTS = new Set(['.js', '.cmd', '.ps1', '.json']);

const PROTECTED_STATE_PATHS = [
  'debug/hand-change-live/session_state.json',
  'debug/hand-change-live/latest_incremental_result.json',
  'debug/duel-log-live/observer_state.json',
  'debug/duel-log-live/latest_result.json',
  'debug/main-deck-ledger/state.json',
  'debug/composite-route-live/session_state.json',
  'debug/composite-route-live/latest_result.json',
  'debug/duel-observer/session.json',
  'debug/duel-observer/latest_step.json',
  'debug/duel-observer/performance.jsonl',
  'debug/duel-outcome-live/latest_result.json',
  'debug/scan-state-live/prepared/result.json',
  'debug/hand-layout-live/dense_segment_latest.json',
  'debug/execution/M18_foolish_burial/route_state.json',
  'debug/execution/M11_mallet_keep_weapon/_resume/resume_state.json',
  'debug/execution/V5_hornet_link_current/true_route_state.json'
];

const MATERIAL_CANDIDATE_DIR_NAMES = new Set([
  'mallet-baseline-study',
  'spell-material-capture'
]);

const ROOT_KEEP = new Set([
  'run-v6.cmd',
  'verify-v6.cmd',
  'card-library.json',
  'live-config.js',
  'decision-state.json',
  'package.json',
  'package-lock.json'
]);

function normRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
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
  const files = walk(dir, []);
  let bytes = 0, images = 0, imageBytes = 0, textFiles = 0;
  let newestMs = 0;
  for (const p of files) {
    const st = statSafe(p);
    if (!st) continue;
    bytes += st.size;
    newestMs = Math.max(newestMs, st.mtimeMs || 0);
    const ext = path.extname(p).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      images += 1;
      imageBytes += st.size;
    } else if (['.json','.jsonl','.txt','.csv','.md'].includes(ext)) {
      textFiles += 1;
    }
  }
  return { files: files.length, bytes, images, imageBytes, textFiles, newestMs };
}

function human(bytes) {
  const units = ['B','KB','MB','GB','TB'];
  let n = Number(bytes || 0), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function collectActiveSourceFiles() {
  const roots = [
    ROOT,
    path.join(ROOT, 'lib'),
    path.join(ROOT, 'execution'),
    path.join(ROOT, 'tools'),
    path.join(ROOT, 'scripts')
  ];
  const seen = new Set();
  const files = [];
  for (const base of roots) {
    if (!fs.existsSync(base)) continue;
    const candidates = fs.statSync(base).isFile() ? [base] : walk(base, []);
    for (const p of candidates) {
      const rel = normRel(p);
      if (
        rel.startsWith('debug/') ||
        rel.startsWith('material/') ||
        rel.startsWith('archive/') ||
        rel.startsWith('node_modules/') ||
        rel.startsWith('templates/') ||
        rel.startsWith('materials/')
      ) continue;
      if (!CODE_EXTS.has(path.extname(p).toLowerCase())) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      files.push(p);
    }
  }
  return files;
}

function activeDebugTopLevelRefs() {
  const refs = new Map();
  const files = collectActiveSourceFiles();
  const rx = /debug[\\\/]+([A-Za-z0-9_.-]+)/g;
  for (const p of files) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let m;
    while ((m = rx.exec(text))) {
      const top = m[1];
      if (!refs.has(top)) refs.set(top, new Set());
      refs.get(top).add(normRel(p));
    }
  }
  return refs;
}

function scanPassMarkers(dir) {
  const markers = [];
  const rx = /\b(PASS_LIVE|LIVE_PASS|PASS_TERMINAL_VICTORY|PASS_LIVE_TERMINAL|PASS_LIVE)\b/i;
  for (const p of walk(dir, [])) {
    const st = statSafe(p);
    if (!st || st.size > MAX_TEXT_BYTES) continue;
    const ext = path.extname(p).toLowerCase();
    if (!['.json','.jsonl','.txt','.log','.md','.csv'].includes(ext)) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (rx.test(text)) markers.push(normRel(p));
    if (markers.length >= 12) break;
  }
  return markers;
}

function classifyDebugDir(name, refs, stats, passMarkers) {
  const refCount = refs.has(name) ? refs.get(name).size : 0;

  if (['hand-change-live','duel-log-live','main-deck-ledger','composite-route-live',
       'duel-observer','scan-state-live','hand-layout-live','duel-outcome-live'].includes(name)) {
    return {
      className: 'ACTIVE_RUNTIME_STATE',
      action: 'KEEP_IN_DEBUG',
      reason: `正式代码会跨步骤读取/写入该目录；不是纯临时截图。activeRefs=${refCount}`
    };
  }

  if (name === 'execution') {
    return {
      className: 'MIXED_EXECUTION_EVIDENCE',
      action: 'TRIAGE_BEFORE_CLEAN',
      reason: '包含当前原子 checkpoint、失败现场、LIVE_PASS 真人证据候选；不能按图片类型整目录删除。'
    };
  }

  if (MATERIAL_CANDIDATE_DIR_NAMES.has(name)) {
    return {
      className: 'HISTORICAL_MATERIAL_CANDIDATE',
      action: 'REVIEW_FOR_MATERIAL_OR_ARCHIVE',
      reason: '名称与旧素材采集/基线研究一致，当前正式代码未直接依赖；应先固化或归档，而不是删除。'
    };
  }

  if (name === 'performance') {
    return {
      className: 'RUNTIME_DIAGNOSTICS',
      action: 'ROTATE_LATER',
      reason: '正式代码持续写性能统计；可做保留最新N次/历史归档，但不应无条件清空。'
    };
  }

  if (passMarkers.length) {
    return {
      className: 'EVIDENCE_WITH_PASS_MARKERS',
      action: 'PROMOTE_OR_ARCHIVE_AFTER_REVIEW',
      reason: `发现PASS/LIVE_PASS文本证据(${passMarkers.length})；先判断是否应进入material。`
    };
  }

  if (refCount > 0) {
    return {
      className: 'ACTIVE_RUNTIME_OUTPUT',
      action: 'KEEP_OR_ROTATE',
      reason: `正式代码仍引用该debug目录；activeRefs=${refCount}`
    };
  }

  return {
    className: 'UNREFERENCED_DEBUG',
    action: 'ARCHIVE_CANDIDATE',
    reason: '当前活跃代码未直接引用；仍需结合日期/内容确认后再归档，不自动删除。'
  };
}

function exactImageDuplicates(dirs) {
  const files = [];
  for (const dir of dirs) {
    for (const p of walk(dir, [])) {
      if (!IMAGE_EXTS.has(path.extname(p).toLowerCase())) continue;
      const st = statSafe(p);
      if (!st) continue;
      files.push({ p, size: st.size });
    }
  }
  const bySize = new Map();
  for (const row of files) {
    if (!bySize.has(row.size)) bySize.set(row.size, []);
    bySize.get(row.size).push(row.p);
  }
  let hashedFiles = 0, duplicateGroups = 0, duplicateBytes = 0;
  const examples = [];
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    const byHash = new Map();
    for (const p of group) {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(p));
      const hex = h.digest('hex');
      hashedFiles += 1;
      if (!byHash.has(hex)) byHash.set(hex, []);
      byHash.get(hex).push(p);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      duplicateGroups += 1;
      duplicateBytes += size * (same.length - 1);
      if (examples.length < 10) examples.push(same.map(normRel));
    }
  }
  return { hashedFiles, duplicateGroups, duplicateBytes, examples };
}

function auditRoot() {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  const rows = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const p = path.join(ROOT, ent.name);
    const st = statSafe(p);
    if (!st) continue;
    let category = 'REVIEW';
    if (ROOT_KEEP.has(ent.name)) category = 'KEEP_RUNTIME_ROOT';
    else if (/^V6_.*\.zip$/i.test(ent.name) || /active_code.*\.zip$/i.test(ent.name)) category = 'GENERATED_ZIP_CANDIDATE';
    else if (['.js','.cmd','.ps1','.json'].includes(path.extname(ent.name).toLowerCase())) category = 'ROOT_CODE_OR_CONFIG_REVIEW';
    rows.push({ name: ent.name, bytes: st.size, category });
  }
  return rows.sort((a,b) => b.bytes - a.bytes);
}

function main() {
  console.log('============================================================');
  console.log('V6 STORAGE / MATERIAL AUDIT — READ ONLY');
  console.log('不会移动、删除、重命名或覆盖任何文件。');
  console.log('特别规则: materials/ 是正式运行素材目录；material/ 是V6固化资料目录，二者不能合并。');
  console.log('============================================================');

  console.log('\n[1] 根目录文件');
  const rootRows = auditRoot();
  for (const row of rootRows) {
    console.log(`- ${row.category.padEnd(28)} ${human(row.bytes).padStart(10)}  ${row.name}`);
  }

  console.log('\n[2] 顶层目录角色');
  for (const name of ['materials','material','templates','debug','archive','execution','lib','tools','scripts','node_modules']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const st = dirStats(p);
    let role = 'PROJECT_DIR';
    if (name === 'materials') role = 'ACTIVE_RUNTIME_MATERIALS_DO_NOT_MOVE';
    if (name === 'material') role = 'DURABLE_V6_RECORDS';
    if (name === 'templates') role = 'ACTIVE_RECOGNITION_TEMPLATES_DO_NOT_CLEAN';
    if (name === 'debug') role = 'MIXED_RUNTIME_STATE_AND_EVIDENCE';
    if (name === 'archive') role = 'INACTIVE_HISTORY';
    console.log(`- ${role.padEnd(40)} ${human(st.bytes).padStart(10)}  ${name}/ (${st.files} files)`);
  }

  console.log('\n[3] debug 顶层分类');
  const refs = activeDebugTopLevelRefs();
  const debugRows = [];
  if (fs.existsSync(DEBUG_ROOT)) {
    for (const ent of fs.readdirSync(DEBUG_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(DEBUG_ROOT, ent.name);
      const stats = dirStats(dir);
      const passMarkers = scanPassMarkers(dir);
      const cls = classifyDebugDir(ent.name, refs, stats, passMarkers);
      debugRows.push({ name: ent.name, stats, passMarkers, ...cls });
    }
  }
  debugRows.sort((a,b) => b.stats.bytes - a.stats.bytes);
  for (const row of debugRows) {
    console.log(
      `- ${row.className.padEnd(30)} ${human(row.stats.bytes).padStart(10)} ` +
      `img=${String(row.stats.images).padStart(6)} ${row.name}/`
    );
    console.log(`    action=${row.action}; ${row.reason}`);
    if (row.passMarkers.length) {
      console.log(`    PASS evidence examples: ${row.passMarkers.slice(0,3).join(' | ')}`);
    }
  }

  console.log('\n[4] 必须保护的当前状态文件');
  for (const rel of PROTECTED_STATE_PATHS) {
    const p = path.join(ROOT, ...rel.split('/'));
    const st = statSafe(p);
    console.log(`- ${st ? 'PRESENT' : 'missing'} ${rel}${st ? ` (${human(st.size)})` : ''}`);
  }

  console.log('\n[5] debug/execution 证据分组（只读）');
  const executionRoot = path.join(DEBUG_ROOT, 'execution');
  if (fs.existsSync(executionRoot)) {
    const rows = [];
    for (const ent of fs.readdirSync(executionRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(executionRoot, ent.name);
      const stats = dirStats(dir);
      const markers = scanPassMarkers(dir);
      rows.push({ name: ent.name, stats, markers });
    }
    rows.sort((a,b) => b.stats.bytes - a.stats.bytes);
    for (const row of rows.slice(0, 40)) {
      const flag = row.markers.length ? 'PASS_EVIDENCE_CANDIDATE' : 'REVIEW';
      console.log(`- ${flag.padEnd(24)} ${human(row.stats.bytes).padStart(10)} img=${String(row.stats.images).padStart(5)} ${row.name}/`);
    }
    if (rows.length > 40) console.log(`  ... ${rows.length - 40} more execution groups`);
  } else {
    console.log('- debug/execution 不存在');
  }

  if (HASH_IMAGES) {
    console.log('\n[6] 精确重复图片 SHA-256 审计（只读，可能较慢）');
    const dirs = [DEBUG_ROOT, MATERIAL_ROOT].filter(fs.existsSync);
    const dup = exactImageDuplicates(dirs);
    console.log(`- hashed candidate files: ${dup.hashedFiles}`);
    console.log(`- exact duplicate groups: ${dup.duplicateGroups}`);
    console.log(`- exact duplicate reclaimable bytes (theoretical): ${human(dup.duplicateBytes)}`);
    for (const group of dup.examples) console.log(`  DUP: ${group.join(' | ')}`);
  } else {
    console.log('\n[6] 重复图片审计');
    console.log('- 默认未做SHA-256，避免一次扫描近8GB图片。');
    console.log('- 需要精确重复统计时运行: .\\audit-v6-storage-assets.cmd --hash-images');
  }

  console.log('\n结论规则:');
  console.log('1. 不允许“debug图片=可删除”这种规则。debug里同时有运行状态、恢复checkpoint、失败现场和真人证据候选。');
  console.log('2. material/ 是固化记录；materials/ 是正式程序素材，后者被胜负识别/校准代码直接使用。');
  console.log('3. 下一步应当先 PROMOTE/ARCHIVE，再 CLEAN；任何自动清理脚本都必须以本审计结果为输入。');
}

try {
  main();
} catch (err) {
  console.error('V6 STORAGE AUDIT FAIL:', err && err.stack || err);
  process.exitCode = 1;
}
