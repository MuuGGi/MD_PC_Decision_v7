'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildBambooSearchPriority,
  bambooSearchTargetIds,
  isLegalBambooSearchTarget
} = require('../../lib/bamboo-search-policy');

assert.deepStrictEqual(
  buildBambooSearchPriority().map(item => item.id),
  ['M20', 'M14']
);
assert.deepStrictEqual(
  bambooSearchTargetIds(),
  ['M20', 'M14']
);
assert.strictEqual(isLegalBambooSearchTarget('M20'), true);
assert.strictEqual(isLegalBambooSearchTarget('M14'), true);
assert.strictEqual(isLegalBambooSearchTarget('M19'), false);
assert.strictEqual(isLegalBambooSearchTarget('M17'), false);

// Integration guard without loading Win32/png dependencies.
const root = path.resolve(__dirname, '..', '..');
const searchSource = fs.readFileSync(
  path.join(root, 'execution', 'core', 'm19-search-execution.js'),
  'utf8'
);
const promptSource = fs.readFileSync(
  path.join(root, 'execution', 'core', 'bamboo-search-target-prompt-observer.js'),
  'utf8'
);

assert.ok(
  searchSource.includes("require(path.join(ROOT, 'lib', 'bamboo-search-policy'))"),
  'M19 executor must consume shared Bamboo policy'
);
assert.ok(
  searchSource.includes('const BAMBOO_PRIORITY = buildBambooSearchPriority();'),
  'M19 executor must derive priority from shared policy'
);
assert.ok(
  promptSource.includes("require(path.join(ROOT, 'lib', 'bamboo-search-policy'))"),
  'Bamboo prompt observer must consume shared Bamboo policy'
);
assert.ok(
  promptSource.includes('const allowed = new Set(bambooSearchTargetIds());'),
  'Bamboo prompt observer must derive legal IDs from shared policy'
);

console.log('BAMBOO_SEARCH_POLICY_OFFLINE PASS');
