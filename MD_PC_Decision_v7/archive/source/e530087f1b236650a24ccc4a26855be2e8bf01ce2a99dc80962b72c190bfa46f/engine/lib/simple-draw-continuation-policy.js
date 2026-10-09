'use strict';

const { isExodiaComponentCard } = require('./exodia-policy');

const KNOWN_HAND_IDS = new Set(Array.from({ length: 22 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
const SIMPLE_ACTION_IDS = new Set(['M09', 'M12', 'M13', 'M14', 'M15', 'M16', 'M18', 'M21']);

function classifySimpleDrawContinuation(state, suggestion) {
  const cards = state && state.cards;
  const selected = suggestion && suggestion.selected;
  const runtime = suggestion && suggestion.runtime || {};
  const manual = reason => ({ automatic: false, reason });
  if (!Array.isArray(cards) || !cards.length || cards.length !== Number(state.handCount) ||
      cards.some((card, i) => !card ||
        (!KNOWN_HAND_IDS.has(card.id) && !isExodiaComponentCard(card)) ||
        Number(card.index) !== i + 1)) {
    return manual('HAND_UNKNOWN_OR_INCONSISTENT');
  }
  // Complexity belongs to the selected action. Inert equipment, Engage or
  // Hornet in hand, and a settled carrier on the field, do not change draw1.
  // Unfinished transactions still take precedence over every new action.
  const branch = runtime.v5Branch || {};
  if (branch.active === true) return manual('FIELD_HAS_PENDING_BRANCH');
  if (!selected || suggestion.strategicDeadlock?.terminal === true || suggestion.deadEnd) {
    return manual('NO_SIMPLE_ACTION');
  }
  if (selected.specialAction) {
    return selected.specialAction === 'M21_FIELD_DRAW' && runtime.chickenGameDrawPending === true
      ? { automatic: true, reason: 'KNOWN_FIELD_DRAW1' } : manual('SPECIAL_BRANCH');
  }
  if (!SIMPLE_ACTION_IDS.has(selected.id) ||
      cards[Number(selected.slot) - 1]?.id !== selected.id) return manual('ACTION_HAS_BRANCH');
  const details = selected.details || {};
  if (details.phase || details.v5AtomicBranchPreference || details.bambooFollowUp ||
      details.allureLastResort || selected.v5Fallback) return manual('ACTION_HAS_BRANCH');
  if (selected.id === 'M14' && runtime.bambooSwordEquipped !== true) return manual('GOLDEN_DRAW_NOT_PROVEN');
  if (selected.id === 'M12' && (!['M07', 'M08'].includes(details.discardTarget?.id) ||
      !cards.some(card => card.id === details.discardTarget.id) || details.protectedToonDragonCost)) {
    return manual('TRADE_IN_COST_NOT_SIMPLE');
  }
  if (selected.id === 'M13' && (!['M06', 'M08'].includes(details.banishTarget?.id) ||
      !cards.some(card => card.id === details.banishTarget.id))) return manual('ALLURE_COST_NOT_PROVEN');
  // M18 uses the existing fixed Garura route, including its prompt and observer.
  return { automatic: true, reason: 'SIMPLE_DRAW_ACTION' };
}

function createSimpleDrawAutoController({ maxActions = 40 } = {}) {
  let actions = 0;
  let blocked = null;
  const inspect = (state, suggestion) => blocked
    ? { automatic: false, reason: blocked }
    : actions >= maxActions ? { automatic: false, reason: 'AUTO_ACTION_LIMIT' }
      : classifySimpleDrawContinuation(state, suggestion);
  return {
    inspect,
    choose(state, suggestion) {
      const result = inspect(state, suggestion);
      if (result.automatic) actions++;
      return result;
    },
    completed(before, after) {
      if (!after || Number(after.revision) <= Number(before.revision) ||
          !Array.isArray(after.cards) || after.cards.length !== Number(after.handCount)) {
        blocked = 'OBSERVER_DID_NOT_ADVANCE';
        return false;
      }
      return true;
    },
    stop(reason = 'ACTION_FAILED_REQUIRE_CONFIRMATION') { blocked = reason; }
  };
}

function assertAutomaticExecutionResult(result, actionLabel = 'UNKNOWN') {
  // Observer-only successful recovery is real progress even with zero GUI
  // inputs. Conversely, "not executed" is not an invitation to auto-Enter
  // the same unsupported pending stage or missing executor forever.
  if (result && (result.executed === true || result.quit === true)) return result;
  throw new Error(`AUTOTEST_NO_EXECUTION_PROGRESS:${actionLabel};保留阶段，不重复自动回车或重放动作。`);
}

module.exports = { classifySimpleDrawContinuation, createSimpleDrawAutoController,
  assertAutomaticExecutionResult };
