'use strict';
const fs = require('fs'), path = require('path');
function verify() {
  const entry = path.resolve(__dirname, '../archive/development/tools/verify-v7.js');
  if (!fs.existsSync(entry)) throw new Error('V7_DEVELOPMENT_ARCHIVE_NOT_INCLUDED: offline verification requires archive/development; game runtime does not.');
  return require(entry).verify();
}
module.exports = { verify };
if (require.main === module) { try { verify(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
