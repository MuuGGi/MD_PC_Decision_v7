'use strict';

const { clientReport } = require('./win-fast');

function validateMasterDuelClient(info, options = {}) {
  const report = clientReport(info);
  const title = String(info && info.title || '').toLowerCase();
  const requireTitle = options.requireTitle === true;
  const titleOk = !requireTitle || title.includes('masterduel') || title.includes('master duel');
  if (!titleOk || !report.clientFullyVisible || report.aspectError > (options.maxAspectError || 0.03)) {
    throw new Error(options.errorMessage || 'MASTER_DUEL_CLIENT_NOT_SAFE');
  }
  return report;
}

module.exports = { validateMasterDuelClient };
