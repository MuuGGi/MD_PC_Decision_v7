'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const REQUIRED_NODE = '20.11.1';
const REQUIRED_LAUNCHERS = [
  'tools/launchers/audit-v6-state.cmd',
  'tools/launchers/audit-v6-storage-assets.cmd',
  'tools/launchers/organize-v6-workspace.cmd',
  'tools/launchers/prepare-v6-storage.cmd',
  'tools/launchers/run-duel-observer.cmd'
];
const DELETE_ROOT_FILES = [
  'audit-v6-state.cmd','audit-v6-storage-assets.cmd','organize-v6-workspace.cmd',
  'prepare-v6-storage.cmd','run-duel-observer.cmd','run-v5.cmd','run-v5.js',
  'migrate-v6-core-layout.cmd'
];
const DELETE_INTERNAL_FILES = ['tools/migrate-v6-core-layout.js'];
const EXPECTED_ROOT_FILES = new Set([
  'card-library.json','decision-state.json','live-config.js','package.json',
  'package-lock.json','run-v6.cmd','verify-v6.cmd'
]);
function abs(rel) { return path.join(ROOT, ...rel.split('/')); }
function removeKnown(rel) { const p=abs(rel); if(!fs.existsSync(p)) return false; fs.rmSync(p,{force:true}); return true; }
function main() {
  const actual=String(process.versions.node||'');
  if(actual!==REQUIRED_NODE) throw new Error(`NODE_VERSION_MISMATCH:${actual||'UNKNOWN'}; expected ${REQUIRED_NODE}`);
  for(const rel of REQUIRED_LAUNCHERS) if(!fs.existsSync(abs(rel))) throw new Error(`REQUIRED_CLASSIFIED_LAUNCHER_MISSING:${rel}`);
  let deletedRoot=0, deletedInternal=0;
  for(const rel of DELETE_ROOT_FILES) if(removeKnown(rel)) deletedRoot++;
  for(const rel of DELETE_INTERNAL_FILES) if(removeKnown(rel)) deletedInternal++;
  const rootFiles=fs.readdirSync(ROOT,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.name).sort();
  const unexpected=rootFiles.filter(n=>!EXPECTED_ROOT_FILES.has(n));
  console.log('============================================================');
  console.log('V6 ROOT CLEANUP PASS');
  console.log(`known root files removed/moved out: ${deletedRoot}`);
  console.log(`retired internal migration files removed: ${deletedInternal}`);
  console.log(''); console.log('Root files kept:');
  for(const n of rootFiles.filter(n=>EXPECTED_ROOT_FILES.has(n))) console.log(`  KEEP  ${n}`);
  if(unexpected.length){ console.log(''); console.log('Unknown/unclassified root files were intentionally left untouched:'); for(const n of unexpected) console.log(`  LEAVE ${n}`); }
  else { console.log(''); console.log('No unclassified root files remain.'); }
}
try { main(); } catch(err) { console.error(`V6 ROOT CLEANUP FAIL: ${err&&err.stack||err}`); process.exitCode=1; }
