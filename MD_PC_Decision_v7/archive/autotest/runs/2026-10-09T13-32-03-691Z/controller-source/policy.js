'use strict';
const STOP_PATTERN = /AUTOTEST_RESUME|USER_STOP|AUTOTEST_STOP|AUTOTEST_GUARD_WRITE_FAILED|GUARD_(?:MUTEX_TIMEOUT|STATE_MISSING|STATE_UNREADABLE)|MOUSE_INTERFERENCE|FOREGROUND_(?:LOST|IDENTITY_UNPROVEN)|MASTER_DUEL_WINDOW_CHANGED|Foreground window|ACTIVATION_FAILED|CLIENT_UNSAFE|CopyFromScreen|DESKTOP_(?:CAPTURE_FAILED|UNAVAILABLE|LOCKED|ACCESS_DENIED|UNSAFE)|desktop\s+(?:capture|access|geometry)?\s*(?:failed|unavailable|locked|denied)|bridge[^\r\n]*(?:exited|不可用)|WINDOW_NOT_FOUND|NODE_(?:VERSION|MUST_BE)|RUNTIME_SOURCE_CHANGED|AUTOTEST_PATH_OUTSIDE/i;
// Reviewed prompt roles, not "any uppercase-looking name". A new transaction
// must be explicitly reviewed before the controller can auto-confirm it.
const KNOWN_STAGE_PROMPTS = new Set([
  '万宝槌后续', '增量验收后续', 'M21后续', '诱惑后续', 'M18', '胜利后续', '结算确认',
  'HORNET_TOKEN_READY', 'POST_E10_HORNET_TOKEN_READY', 'M20_EQUIP_TARGET_PENDING',
  'HORNET_KAGARI_LINK_IN_FLIGHT',
  'M20_EXTRA_EQUIP_TARGET_PENDING', 'M19_EQUIP_TARGET_PENDING', 'HAND_MENU_DISMISS_PENDING',
  'Y1_LINK_RESOLVED_RECOVERY_PENDING', 'M20_EQUIPPED', 'KAGARI_EFFECT_PENDING',
  'KAGARI_LINK_BEFORE_TRUE_IN_FLIGHT', 'KAGARI_SWORD_EQUIP_IN_FLIGHT',
  'KAGARI_SECOND_YOTO_EQUIP_IN_FLIGHT', 'TRIPLE_M19_CL2_SELECTED', 'TRIPLE_SECOND_BAMBOO_PROMPT',
  'KAGARI_SWORD_LINK_IN_FLIGHT', 'KAGARI_DUAL_RECOVERY_SUBMITTED_IN_FLIGHT',
  'KAGARI_RECOVERY_PROMPT', 'M20_FIELD_EFFECT_ACTIVATED', 'M19_SELECTED_FROM_DECK',
  'M19_EQUIPPED', 'YOTO_LINK_RESOLVED', 'YOTO_SEARCH_PROMPT', 'DUAL_OPTIONAL_PENDING',
  'DUAL_M19_CL1_SELECTED', 'DUAL_E10_TARGET_PROMPT', 'DUAL_M19_BAMBOO_PROMPT',
  'RAYE_SECOND_MATERIAL_READY', 'E10_OPTIONAL_PENDING', 'E10_TARGET_PROMPT', 'RAYE_E10_SELECTED_PENDING'
]);
function classifyFailure(error, stopped = false) {
  if (/V7_(INPUT_GUARD_NOT_PROVEN|FOREGROUND_NOT_PROVEN)/.test(String(error && error.code || error))) return 'STOP_TEST';
  // Function names/paths in nested executor stacks are not stop signals.
  // In particular, captureDesktop in a failed resync must not turn an ordinary
  // observer error into a human interruption. Preserve actual codes/causes.
  const messages = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code) messages.push(String(current.code));
    messages.push(String(current.stack || current).split(/\r?\n/)
      .filter(line => !/^\s*at\s/.test(line)).join('\n'));
  }
  const message = messages.join('\n');
  // User-authorized error cleanup is NOT proof of strategic deadlock. Preserve
  // the first failure before a guarded surrender; safety always overrides it.
  return stopped || STOP_PATTERN.test(message) ? 'STOP_TEST' : 'ARCHIVE_AND_SURRENDER';
}
function chooseDecision(suggestion) {
  if (suggestion && suggestion.selected) return '';
  if (suggestion && suggestion.strategicDeadlock && suggestion.strategicDeadlock.terminal === true) return 'x';
  // A descriptive field label is not a published strategic action. Existing
  // pending transactions are continued by the loop before this new-decision gate.
  throw new Error('AUTOTEST_NO_PROVEN_DECISION');
}
function choosePrompt(prompt) {
  if (prompt === '开局前最后是否用了已结算的万宝槌？[y=是，只记最后抽卡 / n=否，普通基线]：') return 'n';
  if (['Enter=自动执行；R=自动重拍；Q=退出：', 'Enter=自动切回游戏并执行下一步；R=自动切回重拍；Q=退出：'].includes(prompt)) return '';
  const stage = /V[567]\[([^\]]+)\]>\s*$/.exec(prompt);
  if (stage && KNOWN_STAGE_PROMPTS.has(stage[1])) return '';
  throw new Error(`AUTOTEST_UNKNOWN_PROMPT:${prompt}`);
}
function classifyEnd({ victoryProven = false, defeatProven = false, surrenderProven = false, error = null, stopped = false }) {
  if (stopped || (error && classifyFailure(error) === 'STOP_TEST')) return 'INTERRUPTED';
  if (victoryProven) return 'WIN';
  if (surrenderProven) return 'SURRENDER';
  if (defeatProven) return 'LOSS';
  return 'UNRESOLVED';
}
function summarize(games) {
  const wins = games.filter(game => game.outcome === 'WIN').length;
  const surrenders = games.filter(game => game.outcome === 'SURRENDER').length;
  const losses = games.filter(game => ['LOSS', 'SURRENDER'].includes(game.outcome)).length;
  return { started: games.filter(game => game.duelStarted !== false).length, completed: wins + losses, wins, losses, surrenders,
    interrupted: games.filter(game => game.outcome === 'INTERRUPTED').length,
    unresolved: games.filter(game => !game.outcome || game.outcome === 'UNRESOLVED').length,
    errorGames: games.filter(game => game.error || game.finishError).length,
    errorSurrenders: games.filter(game => game.outcome === 'SURRENDER' && game.errorSurrender === true).length,
    gems: games.reduce((sum, game) => sum + (Number.isInteger(game.gems) && game.gems >= 0 ? game.gems : 0), 0),
    unknownGemGames: games.filter(game => ['WIN', 'LOSS', 'SURRENDER'].includes(game.outcome) && game.gems == null).length };
}
module.exports = { classifyFailure, chooseDecision, choosePrompt, classifyEnd, summarize };
