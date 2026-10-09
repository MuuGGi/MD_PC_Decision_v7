'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = path.resolve(__dirname, '..', '..', '..');
const CURRENT = path.join(WORKSPACE, 'MD_PC_Decision_v6');
const BASELINE = path.join(WORKSPACE, 'MD_PC_Decision_v6 - 副本');
// Omit --output-name to preserve the historical default. A named export
// creates a separate snapshot; without --refresh it never replaces one.
const outputNameIndex = process.argv.indexOf('--output-name');
const OUTPUT_NAME = outputNameIndex < 0 ? 'V6相对副本可移植增量_2026-09-28'
  : process.argv[outputNameIndex + 1];
if (typeof OUTPUT_NAME !== 'string' || OUTPUT_NAME.length > 120 ||
    !/^V6相对副本可移植增量_\d{4}-\d{2}-\d{2}(?:_[a-zA-Z0-9_\u4e00-\u9fff-]+)?$/.test(OUTPUT_NAME)) {
  throw new Error('V6_DELTA_OUTPUT_NAME_INVALID');
}
const OUTPUT = path.join(WORKSPACE, OUTPUT_NAME);
if (path.dirname(path.resolve(OUTPUT)) !== path.resolve(WORKSPACE)) {
  throw new Error('V6_DELTA_OUTPUT_OUTSIDE_WORKSPACE');
}
const PAYLOAD = path.join(OUTPUT, '可直接覆盖到工程根目录');
const META = path.join(OUTPUT, '对比清单');

const EXCLUDED_TOP_LEVEL_DIRS = new Set(['node_modules', 'debug', 'archive']);
const EXCLUDED_ROOT_FILES = new Set(['decision-state.json']);
const REFRESH = process.argv.includes('--refresh');

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      const top = rel.split(path.sep)[0];
      if (entry.isDirectory()) {
        if (!EXCLUDED_TOP_LEVEL_DIRS.has(top)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXCLUDED_ROOT_FILES.has(rel)) continue;
      files.push({ rel, full });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mapFiles(root) {
  return new Map(walk(root).map(item => [item.rel, item]));
}

function copyPreservingPath(source, relativePath) {
  const target = path.join(PAYLOAD, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function main() {
  if (!fs.existsSync(CURRENT) || !fs.existsSync(BASELINE)) {
    throw new Error('V6_DELTA_SOURCE_OR_BASELINE_MISSING');
  }
  if (fs.existsSync(OUTPUT)) {
    if (!REFRESH) throw new Error(`V6_DELTA_OUTPUT_ALREADY_EXISTS:${OUTPUT}`);
    const resolvedOutput = path.resolve(OUTPUT);
    if (
      path.dirname(resolvedOutput) !== path.resolve(WORKSPACE) ||
      path.basename(resolvedOutput) !== OUTPUT_NAME
    ) {
      throw new Error(`V6_DELTA_REFRESH_TARGET_UNSAFE:${resolvedOutput}`);
    }
    fs.rmSync(resolvedOutput, { recursive: true, force: false });
  }

  const current = mapFiles(CURRENT);
  const baseline = mapFiles(BASELINE);
  const entries = [];
  for (const [rel, item] of current) {
    const old = baseline.get(rel);
    const currentHash = sha256(item.full);
    if (!old) {
      entries.push({ type: 'ADDED', path: rel, size: fs.statSync(item.full).size, sha256: currentHash });
      continue;
    }
    const oldStat = fs.statSync(old.full);
    const currentStat = fs.statSync(item.full);
    const baselineHash = oldStat.size === currentStat.size ? sha256(old.full) : sha256(old.full);
    if (baselineHash !== currentHash) {
      entries.push({
        type: 'CHANGED',
        path: rel,
        size: currentStat.size,
        sha256: currentHash,
        baselineSize: oldStat.size,
        baselineSha256: baselineHash
      });
    }
  }

  const baselineOnly = [];
  for (const [rel, item] of baseline) {
    if (!current.has(rel)) baselineOnly.push({ path: rel, size: fs.statSync(item.full).size, sha256: sha256(item.full) });
  }

  fs.mkdirSync(PAYLOAD, { recursive: true });
  fs.mkdirSync(META, { recursive: true });
  for (const entry of entries) copyPreservingPath(path.join(CURRENT, entry.path), entry.path);

  const byTopLevel = {};
  for (const entry of entries) {
    const top = entry.path.split(path.sep)[0];
    byTopLevel[top] = Number(byTopLevel[top] || 0) + 1;
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    current: CURRENT,
    baseline: BASELINE,
    payload: PAYLOAD,
    policy: {
      included: '当前v6中相对副本新增或内容变化的可移植文件',
      excludedTopLevelDirectories: [...EXCLUDED_TOP_LEVEL_DIRS],
      excludedRootFiles: [...EXCLUDED_ROOT_FILES],
      reason: '排除依赖、当前局调试/存档、历史归档，避免粘贴到其它工程时污染运行状态'
    },
    summary: {
      added: entries.filter(entry => entry.type === 'ADDED').length,
      changed: entries.filter(entry => entry.type === 'CHANGED').length,
      totalPayloadFiles: entries.length,
      baselineOnlyNotCopied: baselineOnly.length,
      byTopLevel
    },
    files: entries,
    baselineOnlyNotCopied: baselineOnly
  };
  writeText(path.join(META, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeText(
    path.join(META, '使用说明.txt'),
    [
      'V6相对副本可移植增量包',
      '',
      '使用方法：',
      '1. 备份目标工程。',
      '2. 把“可直接覆盖到工程根目录”里的内容复制到目标工程根目录。',
      '3. 保持原有相对路径并允许覆盖同名文件。',
      '4. 复制后运行 .\\verify-v6.cmd --state；如果目标工程不应继承当前局，请使用它自己的decision/debug状态。',
      '',
      '本包未包含：node_modules、debug、archive、decision-state.json。',
      '本包不表示删除操作；副本中存在而当前v6中不存在的文件只记在manifest，不会删除目标文件。',
      '',
      `文件数：${entries.length}（新增${manifest.summary.added}，修改${manifest.summary.changed}）`
    ].join('\r\n') + '\r\n'
  );

  console.log('V6_PORTABLE_DELTA_EXPORT_PASS');
  console.log(`output=${OUTPUT}`);
  console.log(`payloadFiles=${entries.length}; added=${manifest.summary.added}; changed=${manifest.summary.changed}`);
  console.log(`baselineOnlyNotCopied=${baselineOnly.length}`);
  console.log(`byTopLevel=${JSON.stringify(byTopLevel)}`);
}

main();
