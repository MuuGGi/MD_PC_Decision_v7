'use strict';
// Test-only adapter. Borrow/capture historical DATA, never write to V6 or live V7.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), Module = require('module'), cp = require('child_process');
const V7 = path.resolve(__dirname, '../../..');
const WORK = process.env.MD_V7_LEGACY_WORK;
if (!WORK) throw new Error('V7_LEGACY_TEST_WORKSPACE_REQUIRED');
const source = JSON.parse(fs.readFileSync(path.join(V7, 'archive/development/import-manifest.json'), 'utf8')).sourceRoot;
const original = Object.fromEntries(['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'statSync', 'readdirSync', 'mkdtempSync'].map(k => [k, fs[k].bind(fs)]));
const cache = path.join(V7, 'archive/legacy-fixtures');
original.mkdirSync(cache, { recursive: true });
const indexFile = path.join(cache, 'index.json');
const index = original.existsSync(indexFile) ? JSON.parse(original.readFileSync(indexFile, 'utf8')) : {};
const temporaryRoots = [];
function ordinary(file) {
  const s = String(file);
  return path.resolve(s.startsWith('\\\\?\\UNC\\') ? '\\\\' + s.slice(8) : s.startsWith('\\\\?\\') ? s.slice(4) : s);
}
function inside(root, file) { const rel = path.relative(ordinary(root), ordinary(file)); return !rel.startsWith('..') && !path.isAbsolute(rel); }
function reference(file) {
  if (typeof file !== 'string') return null;
  const absolute = ordinary(file), relative = path.relative(path.join(WORK, 'engine'), absolute);
  const portable = absolute.replace(/\\/g, '/');
  if (inside(path.join(WORK, 'engine'), absolute) && /^(material|materials)[/\\]/.test(relative)) return path.join(source, relative);
  if (inside(path.join(WORK, 'fixtures'), absolute)) return path.join(path.dirname(source), 'fixtures', path.relative(path.join(WORK, 'fixtures'), absolute));
  const formalDebug = path.join(path.dirname(WORK), 'debug');
  if (inside(formalDebug, absolute)) return path.join(path.resolve(source, '../..'), 'debug', path.relative(formalDebug, absolute));
  const runAt = portable.indexOf('/runs/');
  if (runAt >= 0 && inside(WORK, absolute)) return path.join(path.dirname(source), portable.slice(runAt + 1));
  if (inside(source, absolute) || inside(path.join(path.dirname(source), 'runs'), absolute)) return absolute;
  return null;
}
function dataFile(file) {
  const ref = reference(file);
  if (!ref) return file;
  if (!/\.(png|json|txt|log|jsonl|csv|js)$/i.test(ref)) return file;
  const key = path.resolve(ref);
  if (index[key] && original.existsSync(path.join(cache, index[key]))) return path.join(cache, index[key]);
  if (!original.existsSync(ref) || !original.statSync(ref).isFile()) return file;
  const bytes = original.readFileSync(ref), name = crypto.createHash('sha256').update(bytes).digest('hex') + path.extname(ref);
  const destination = path.join(cache, name);
  if (!original.existsSync(destination)) original.writeFileSync(destination, bytes);
  index[key] = name; original.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return destination;
}
function mapped(file) {
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string') return file;
  // Native require/read of cached historical state must still go through the adapter.
  if (original.existsSync(file) && (inside(WORK, file) || !reference(file))) return file;
  const ref = reference(file);
  if (ref && original.existsSync(ref) && original.statSync(ref).isDirectory()) return ref;
  const cached = dataFile(file);
  if (ref && /\.js$/i.test(ref) && inside(WORK, file) && cached !== file) {
    // Historical JS must keep its relative module layout, unlike inert JSON/PNG.
    original.mkdirSync(path.dirname(file), { recursive: true });
    original.writeFileSync(file, original.readFileSync(cached));
    return file;
  }
  return cached;
}
fs.existsSync = file => original.existsSync(mapped(file));
fs.readFileSync = (file, ...args) => original.readFileSync(mapped(file), ...args);
const nativeAsyncRead = fs.readFile.bind(fs), nativePromiseRead = fs.promises.readFile.bind(fs.promises);
fs.readFile = (file, ...args) => nativeAsyncRead(mapped(file), ...args);
fs.promises.readFile = (file, ...args) => nativePromiseRead(mapped(file), ...args);
const nativeReadStream = fs.createReadStream.bind(fs);
fs.createReadStream = (file, ...args) => nativeReadStream(mapped(file), ...args);
for (const name of ['statSync', 'readdirSync']) fs[name] = (file, ...args) => original[name](mapped(file), ...args);
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
  try { return resolve.call(this, request, parent, ...args); }
  catch (error) {
    if (!parent || (!request.startsWith('.') && !path.isAbsolute(request))) throw error;
    const candidate = path.isAbsolute(request) ? request : path.resolve(path.dirname(parent.filename), request);
    for (const file of [candidate, candidate + '.js', candidate + '.json']) {
      const fallback = mapped(file);
      if (original.existsSync(fallback)) return fallback;
    }
    throw error;
  }
};
function writable(file) {
  if (typeof file === 'number') return;
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string' || (!inside(WORK, file) && !temporaryRoots.some(dir => inside(dir, file))))
    throw new Error('V7_OFFLINE_WRITE_OUTSIDE_TEST_WORKSPACE:' + String(file));
}
for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'truncateSync']) {
  const native = fs[name]; fs[name] = (file, ...args) => { writable(file); return native(file, ...args); };
}
for (const name of ['renameSync', 'copyFileSync', 'cpSync']) {
  const native = fs[name]; fs[name] = (from, to, ...args) => { writable(to); if (name === 'renameSync') writable(from); return native(from, to, ...args); };
}
fs.mkdtempSync = (...args) => { const dir = original.mkdtempSync(...args); temporaryRoots.push(dir); return dir; };
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const native = cp[name];
  cp[name] = (command, args, options = {}) => {
    if (path.resolve(command).toLowerCase() !== process.execPath.toLowerCase()) throw new Error('V7_OFFLINE_NATIVE_PROCESS_FORBIDDEN:' + command);
    return native(command, args, { ...options, env: { ...process.env, ...options.env }, windowsHide: true });
  };
}
for (const name of ['exec', 'execSync']) cp[name] = () => { throw new Error('V7_OFFLINE_SHELL_FORBIDDEN'); };
module.exports = { reference, mapped, ordinary };
