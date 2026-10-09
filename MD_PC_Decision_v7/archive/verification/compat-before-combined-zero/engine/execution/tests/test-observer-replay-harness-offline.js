'use strict';
// Read-only source/fixture loader. All runtime writes and bridge commands stay
// in memory. Exercise the complete production observer + ledger transaction,
// not a replacement implementation of its acceptance rule.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../..');
const library = require('../../card-library.json');
const config = require('../../live-config');

function observerReplay({ archive, passivePath, handCount, sourceRoot = ROOT, failWrite,
  mutateLog, mutateHand, passiveImage, detector, bridgeError }) {
  const files = new Map(), modules = new Map(), handles = new Map();
  const commands = [], messages = [], writes = [];
  let nextFd = 1, failedWrite = false;
  const key = p => path.resolve(p);
  const put = (p, value) => files.set(key(p), Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value));
  for (const rel of ['decision-state.json', 'debug/hand-change-live/session_state.json',
    'debug/hand-change-live/latest_incremental_result.json', 'debug/main-deck-ledger/state.json',
    'debug/duel-log-live/latest_result.json', 'debug/composite-route-live/session_state.json',
    'debug/composite-route-live/latest_result.json']) {
    const file = path.join(archive, rel);
    if (fs.existsSync(file)) put(path.join(sourceRoot, rel), fs.readFileSync(file));
  }
  put(path.join(sourceRoot, 'card-library.json'), JSON.stringify(library));
  const json = p => JSON.parse(files.get(key(p)).toString());
  const handPath = path.join(sourceRoot, 'debug/hand-change-live/session_state.json');
  const ledgerPath = path.join(sourceRoot, 'debug/main-deck-ledger/state.json');
  const resultPath = path.join(sourceRoot, 'debug/hand-change-live/latest_incremental_result.json');
  const state = json(handPath);
  if (mutateHand) { mutateHand(state); put(handPath, JSON.stringify(state)); }
  if (state.handImagePath) {
    // Portable test fixture: archived JSON contains its original absolute root.
    // Keep the exact image/revision; only relocate the historical root.
    const portable = state.handImagePath.replace(/\\/g, '/');
    const suffix = portable.indexOf('/debug/');
    const rel = suffix >= 0 ? portable.slice(suffix + 1) : path.relative(ROOT, state.handImagePath);
    const previous = path.join(archive, rel);
    if (fs.existsSync(previous)) put(path.join(sourceRoot, rel), fs.readFileSync(previous));
    state.handImagePath = path.join(sourceRoot, rel);
    put(handPath, JSON.stringify(state));
  }
  const logPath = path.join(sourceRoot, 'debug/duel-log-live/latest_result.json');
  if (mutateLog) { const log = json(logPath); mutateLog(log); put(logPath, JSON.stringify(log)); }
  const before = [handPath, ledgerPath, resultPath].map(p => [p, files.get(key(p)) && Buffer.from(files.get(key(p)))]);
  const passive = passiveImage || PNG.sync.read(fs.readFileSync(passivePath));
  function writable(p) {
    const rel = path.relative(sourceRoot, key(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('REPLAY_WRITE_OUTSIDE_VIRTUAL_ROOT:' + p);
  }
  const memoryFs = {
    existsSync: p => files.has(key(p)),
    mkdirSync: p => writable(p),
    readFileSync: (p, encoding) => {
      const value = files.get(key(p));
      if (!value) { const error = new Error('REPLAY_FILE_NOT_FOUND:' + p); error.code = 'ENOENT'; throw error; }
      return encoding ? value.toString(encoding) : Buffer.from(value);
    },
    writeFileSync: (p, value) => {
      const target = typeof p === 'number' ? handles.get(p) : p;
      writable(target);
      if (failWrite && !failedWrite && key(target).includes(failWrite)) {
        failedWrite = true; throw new Error('SIMULATED_OBSERVER_WRITE_FAILURE');
      }
      put(target, value); writes.push(key(target));
    },
    openSync: p => { writable(p); const fd = nextFd++; handles.set(fd, p); return fd; },
    fsyncSync() {}, closeSync: fd => handles.delete(fd),
    renameSync: (a,b) => { writable(a); writable(b); put(b, memoryFs.readFileSync(a)); files.delete(key(a)); },
    unlinkSync: p => { writable(p); files.delete(key(p)); }
  };
  const bridge = {
    info: async()=>({title:'masterduel'}),
    click: async(x,y)=> {
      if (bridgeError) throw new Error(bridgeError);
      const safe = config.handFan.slotResetMousePoint;
      if (x !== safe.x || y !== safe.y) throw new Error('REPLAY_UNEXPECTED_CARD_CLICK');
      commands.push({cmd:'NEUTRAL_CLICK',x,y});
    },
    key: async key => {
      if(key !== 'ESC') throw new Error('REPLAY_UNEXPECTED_KEY:' + key);
      commands.push({cmd:'ESC'});
    }
  };
  const win = { MdFastBridge: class { constructor(){throw new Error('REAL_BRIDGE_FORBIDDEN');} },
    captureReferenceRoi: async()=>passive, mapReferencePoint: (_,p)=>p, sleep: async()=>{} };
  const reject = () => { throw new Error('REPLAY_UNEXPECTED_RECOGNITION_OR_NATIVE_OPERATION'); };
  const mocks = {
    'lib/win-fast.js': win,
    'lib/md-foreground.js': {activateAndVerifyMasterDuel: reject},
    'lib/live-client-guard.js': {validateMasterDuelClient:()=>({clientFullyVisible:true,aspectError:0})},
    'lib/recognizer.js': {loadLibrary:()=>library,loadTemplates:async()=>[]},
    'lib/hand-info-overlay.js': {loadInfoDigitTemplates:()=>[]},
    'runtime/observer/test-hand-info-live.js': {runFastOwnAutoHold:async()=> {
      commands.push({cmd:'MOCK_INFO'});
      return {result:{mouseReleased:true,failSafeTriggered:false,samples:2,own:{status:'OK',handCount}}};
    },runAutoHold:reject},
    'runtime/observer/scan-state.js': {recognizeCurrentCard:reject},
    'runtime/observer/capture-hand-scroll-segments-live.js': {recognizeDenseTargetSlots:reject}
  };
  const nativePng = require('../../lib/png-utils');
  mocks['lib/png-utils.js'] = {...nativePng,
    readPng:async p=>PNG.sync.read(memoryFs.readFileSync(p)),
    savePng:async(image,p)=>memoryFs.writeFileSync(p,PNG.sync.write(image))};
  const sourceFile = (file, rel) => {
    // Archived production sources require paths relative to their own root.
    if (!file.endsWith('.js') && !file.endsWith('.json')) file += '.js';
    if (modules.has(file)) return modules.get(file).exports;
    const name = path.relative(sourceRoot,file).replace(/\\/g,'/');
    if (mocks[name]) return mocks[name];
    if (detector && name === 'lib/hand-state.js') return detector;
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file));
    const mod = {exports:{}}; modules.set(file,mod);
    const context = vm.createContext({module:mod,exports:mod.exports,__dirname:path.dirname(file),__filename:file,
      Buffer,process:{pid:process.pid,argv:[],env:{MD_V5_EXPECTED_ATOMIC_ACTIVATION:json(logPath).newOperationBlocks?.[0]?.activationKey||''},hrtime:process.hrtime},
      console:{log:(...a)=>messages.push(a.join(' ')),error:(...a)=>messages.push(a.join(' '))},
      require: id => {
        if(id==='fs')return memoryFs;
        if(id==='child_process')return {spawnSync:reject,execSync:reject};
        if(id.startsWith('.') || path.isAbsolute(id)) return sourceFile(path.resolve(path.dirname(file),id));
        return require(id);
      }});
    vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
    return mod.exports;
  };
  const observer = sourceFile(path.join(sourceRoot,'runtime/observer/observe-hand-change-incremental-live.js'));
  return { files, before, commands, messages, writes, json, handPath, ledgerPath, resultPath,
    run:()=>observer.runIncrementalHandChange({bridge,skipActivation:true}),
    transaction:()=>sourceFile(path.join(sourceRoot,'lib/incremental-observer-transaction.js')),
    log:()=>json(logPath) };
}
module.exports={observerReplay};
