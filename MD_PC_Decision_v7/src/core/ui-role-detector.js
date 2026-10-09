'use strict';
const { NotReadyError, ContractError } = require('./errors');
function chooseRole(candidates, policy = {}) {
  if (typeof policy.roleTest !== 'function') throw new ContractError('UI_SEMANTIC_ROLE_TEST_REQUIRED');
  const threshold = policy.minScore ?? 0.5, margin = policy.minMargin ?? 0.05;
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(margin) || margin < 0)
    throw new ContractError('UI_ROLE_POLICY_INVALID');
  const region = policy.expectedRegion;
  if (region && !['x', 'y', 'width', 'height'].every(k => Number.isFinite(region[k])))
    throw new ContractError('UI_ROLE_REGION_INVALID');
  const rows = (candidates || []).filter(c => c && Number.isFinite(c.score) && policy.roleTest(c))
    .filter(c => c.score >= threshold)
    .filter(c => !region || (Number.isFinite(c.x) && Number.isFinite(c.y) &&
      c.x >= region.x && c.x <= region.x + region.width &&
      c.y >= region.y && c.y <= region.y + region.height))
    .sort((a, b) => b.score - a.score);
  if (!rows.length) throw new NotReadyError(policy.notReadyCode || 'UI_ROLE_NOT_PROVEN');
  if (rows.length > 1 && rows[0].score - rows[1].score <= margin)
    throw new ContractError(policy.ambiguousCode || 'UI_ROLE_AMBIGUOUS', undefined, { first: rows[0], second: rows[1] });
  return rows[0];
}
function roleFact(fn) {
  try { return { status: 'PROVEN', candidate: fn() }; }
  catch (e) {
    if (e instanceof NotReadyError || e instanceof ContractError)
      return { status: 'UNKNOWN', reason: e.code, details: e.details || {} };
    throw e;
  }
}
module.exports = { chooseRole, roleFact };
