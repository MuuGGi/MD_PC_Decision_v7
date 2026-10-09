'use strict';
const { ContractError, NotReadyError } = require('./errors');
function createChain(chainId) { if (!chainId) throw new ContractError('CHAIN_ID_REQUIRED'); return { chainId, links: [], status: 'BUILDING' }; }
function addLink(chain, link) {
  if (!chain || chain.status !== 'BUILDING') throw new ContractError('CHAIN_NOT_BUILDING');
  const index = link && link.index;
  if (!Number.isInteger(index) || index < 1 || chain.links.some(row => row.index === index)) throw new ContractError('CHAIN_LINK_INDEX_INVALID_OR_DUPLICATE');
  if (!['SELF', 'OPPONENT', 'UNKNOWN'].includes(link.actor || 'UNKNOWN')) throw new ContractError('CHAIN_ACTOR_INVALID');
  chain.links.push({ index, actor: link.actor || 'UNKNOWN', actionType: link.actionType || null,
    eventInstanceKey: link.eventInstanceKey || null, status: 'PENDING', result: null });
  chain.links.sort((a, b) => a.index - b.index);
  return chain;
}
function sealChain(chain, evidence) {
  if (!evidence || evidence.proven !== true || !chain.links.length ||
      chain.links.some((row, i) => row.index !== i + 1)) throw new NotReadyError('CHAIN_BUILD_COMPLETION_NOT_PROVEN');
  chain.status = 'RESOLVING'; chain.buildEvidence = evidence; return chain;
}
function resolveLink(chain, index, result) {
  if (chain.status !== 'RESOLVING') throw new ContractError('CHAIN_NOT_RESOLVING');
  const next = [...chain.links].reverse().find(row => row.status === 'PENDING');
  if (!next || next.index !== index) throw new ContractError('CHAIN_RESOLUTION_ORDER_UNPROVEN');
  if (!result || !['RESOLVED', 'NEGATED', 'NO_GAIN'].includes(result.status) || result.proven !== true)
    throw new NotReadyError('CHAIN_LINK_RESULT_NOT_PROVEN');
  next.status = 'RESOLVED'; next.result = result;
  if (chain.links.every(row => row.status === 'RESOLVED')) chain.status = 'RESOLVED';
  return chain;
}
module.exports = { createChain, addLink, sealChain, resolveLink };
