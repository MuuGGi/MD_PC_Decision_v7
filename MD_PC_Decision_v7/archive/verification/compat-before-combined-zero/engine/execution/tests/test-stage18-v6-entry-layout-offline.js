'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const canonical = path.join(ROOT, 'runtime', 'main-v6.js');
assert.ok(fs.existsSync(canonical), 'canonical runtime/main-v6.js missing');

const main = fs.readFileSync(canonical, 'utf8');
assert.ok(main.includes("const ROOT = path.resolve(__dirname, '..');"));
assert.ok(main.includes('MD_PC_Decision_v6：正式原子主循环'));
assert.ok(main.includes("rl.question('\\nV6> ')"));
assert.ok(!main.includes("const ROOT = __dirname;"));


const v6cmd = fs.readFileSync(path.join(ROOT, 'run-v6.cmd'), 'utf8');
assert.ok(v6cmd.includes('runtime\\main-v6.js'));
assert.ok(v6cmd.includes('v20.11.1') || v6cmd.includes('20.11.1'));


const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, 'md-pc-decision-v6');
assert.strictEqual(pkg.main, 'runtime/main-v6.js');

assert.ok(fs.existsSync(path.join(ROOT, 'verify-v6.cmd')));
assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'verify-v6-project.js')));

console.log('STAGE18_V6_ENTRY_LAYOUT_OFFLINE PASS');
