'use strict';
// Development-only proof: omit every historical/development directory, never control the game.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '../../..');
const DIRECTORIES = ['src', 'engine', 'autotest', 'config', 'tools', 'node_modules'];
const FILES = ['README.md', 'package.json', 'run-v7-autotest.cmd', 'verify-v7.cmd', 'run-v7-audit.cmd', 'run-v7-shadow.cmd'];
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
async function probe(root) {
  const { withStrictReadOnly } = require(path.join(root, 'src/runtime/shadow'));
  const originalResolve = Module._resolveFilename;
  const originals = {};
  const checkRead = file => {
    if (typeof file === 'number') return;
    if (Buffer.isBuffer(file)) file = file.toString();
    if (file instanceof URL) file = require('url').fileURLToPath(file);
    if (typeof file !== 'string' || !inside(root, file)) throw new Error('RUNTIME_READ_OUTSIDE_PACKAGE:' + String(file));
    const relative = path.relative(root, path.resolve(file)).split(path.sep);
    if (relative[0] === 'archive') throw new Error('RUNTIME_READ_FROM_DEVELOPMENT_ARCHIVE:' + file);
  };
  Module._resolveFilename = function(request, parent, ...args) {
    const resolved = originalResolve.call(this, request, parent, ...args);
    if (!Module.isBuiltin(resolved)) checkRead(resolved);
    return resolved;
  };
  for (const name of ['readFileSync', 'readFile', 'createReadStream']) {
    originals[name] = fs[name];
    fs[name] = (file, ...args) => { checkRead(file); return originals[name](file, ...args); };
  }
  originals.promiseRead = fs.promises.readFile;
  fs.promises.readFile = (file, ...args) => { checkRead(file); return originals.promiseRead.call(fs.promises, file, ...args); };
  try {
    return await withStrictReadOnly(async () => {
      if (fs.existsSync(path.join(root, 'archive'))) throw new Error('PROBE_MUST_OMIT_ARCHIVE');
      const doctor = require(path.join(root, 'tools/doctor-v7')).doctor();
      const recognizer = require(path.join(root, 'engine/lib/recognizer'));
      const templates = await recognizer.loadTemplates(path.join(root, 'engine'), recognizer.loadLibrary(path.join(root, 'engine')));
      require(path.join(root, 'engine/runtime/mature-driver'));
      require(path.join(root, 'src/runtime/duel-loop'));
      let developmentMissing = false;
      try { require(path.join(root, 'autotest/verify')).verify(); }
      catch (error) { if (!error.message.startsWith('V7_DEVELOPMENT_ARCHIVE_NOT_INCLUDED:')) throw error; developmentMissing = true; }
      if (!developmentMissing) throw new Error('OFFLINE_VERIFY_MUST_REPORT_MISSING_DEVELOPMENT');
      return { status: 'V7_RUNTIME_WITHOUT_ARCHIVE_PASS', doctor: doctor.status, runtimeFiles: doctor.runtimeFiles,
        decodedCardTemplates: templates.length, developmentMissingExplicit: true, inputCount: 0, businessWrites: 0,
        readsOutsidePackage: 0, scope: 'Static runtime closure, actual PNG decoding and driver loading; not a live game or mobile-platform test.' };
    });
  } finally {
    Module._resolveFilename = originalResolve;
    for (const name of ['readFileSync', 'readFile', 'createReadStream']) fs[name] = originals[name];
    fs.promises.readFile = originals.promiseRead;
  }
}
function verify() {
  const tempBase = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'md-v7-runtime-isolation-'));
  let result;
  try {
    for (const directory of DIRECTORIES) fs.cpSync(path.join(ROOT, directory), path.join(root, directory), {
      recursive: true,
      filter: file => {
        const ordinary = String(file).startsWith('\\\\?\\') ? String(file).slice(4) : String(file);
        if (fs.lstatSync(ordinary).isSymbolicLink()) throw new Error('RUNTIME_PACKAGE_LINK_FORBIDDEN:' + ordinary);
        return !path.relative(ROOT, ordinary).split(path.sep).some(part => ['debug', 'archive'].includes(part)) && path.basename(ordinary) !== 'decision-state.json';
      }
    });
    for (const file of FILES) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    const child = cp.spawnSync(process.execPath, [__filename, '--probe', root], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (child.status !== 0) throw new Error('V7_RUNTIME_ISOLATION_FAILED:' + (child.stderr || child.stdout || child.error));
    result = JSON.parse(child.stdout.trim());
  } finally {
    // Exact generated test checkout, checked before recursive removal; never a user project.
    if (path.dirname(root) !== tempBase || !/^md-v7-runtime-isolation-/.test(path.basename(root)) ||
        fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('UNSAFE_TEST_CHECKOUT_CLEANUP');
    fs.rmSync(root, { recursive: true });
  }
  require('../../../src/core/json-store').atomicWriteJson(path.join(ROOT, 'archive/verification/runtime-isolation-latest.json'),
    { checkedAt: new Date().toISOString(), ...result, temporaryCopyRemoved: true });
  console.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  if (process.argv.includes('--probe')) probe(path.resolve(process.argv.at(-1))).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
  else { try { verify(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }
}
module.exports = { verify, probe };
