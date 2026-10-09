'use strict';
// Retain the historical entry point, but exercise the current count-validated
// routing and actual right-log boundary implementation (included in verify).
const { main } = require('./test-terminal-observation-boundary-offline');
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
