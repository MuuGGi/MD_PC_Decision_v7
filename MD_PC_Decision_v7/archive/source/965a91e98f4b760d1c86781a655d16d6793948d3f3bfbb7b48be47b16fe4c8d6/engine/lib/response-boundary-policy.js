'use strict';

// ISSUE-079: a boundary is a point after which the opponent may receive
// priority.  Steps between two boundaries are one uninterrupted local prompt
// transaction and must not be split by history reconstruction or extra hand
// clicks.  The runtime gate proves SELF_PRIORITY_BLUE before it performs the
// next recognition/control step.  SELF_PRIORITY_BLUE is now proven specifically
// by the distributed bottom-field glow/grid, not by a compact blue card.
// Deterministic atomic edges inside one
// interval are enumerated separately in atomic-response-continuation-policy;
// strategy selection is never auto-continued.  Red/opponent-priority classification remains
// deliberately unimplemented until a verified red material is supplied.
const RESPONSE_BOUNDARIES = Object.freeze({
  SKY_STRIKER: Object.freeze([
    'HORNET_ACTIVATED',
    'HORNET_TOKEN_RESOLVED',
    'KAGARI_EFFECT_ACTIVATED',
    'KAGARI_RECOVERY_RESOLVED',
    'SEARCH_OR_DRAW_FULLY_RESOLVED',
    'RAYE_NORMAL_SUMMONED',
    'RAYE_EFFECT_ACTIVATED',
    'ZEKE_LANDED_AND_EFFECT_ACTIVATED',
    'ENGAGE_ACTIVATED',
    'ENGAGE_SEARCH_AND_BONUS_DRAW_FULLY_RESOLVED'
  ]),
  EQUIPMENT: Object.freeze([
    'EQUIP_SPELL_ACTIVATED',
    'EQUIPPED_CARD_SENT_AND_GY_EFFECT_ACTIVATED',
    'EQUIP_SEARCH_TARGET_TAKEN',
    'FIELD_EQUIP_SELF_SEND_EFFECT_ACTIVATED',
    'DECK_EQUIP_FULLY_RESOLVED'
  ]),
  GENERIC_SPELLS: Object.freeze({
    M09_UPSTART: ['ACTIVATED', 'FULLY_RESOLVED'],
    M10_TOON_TABLE: ['ACTIVATED', 'FULLY_RESOLVED'],
    M11_MAGICAL_MALLET: ['ACTIVATED', 'RETURN_AND_DRAW_FULLY_RESOLVED'],
    M12_TRADE_IN: ['ACTIVATED', 'COST_AND_DRAW_FULLY_RESOLVED'],
    M13_ALLURE: ['ACTIVATED', 'DRAW_AND_BANISH_FULLY_RESOLVED'],
    M20_TRUE_BAMBOO: ['ACTIVATED', 'FULLY_RESOLVED'],
    M15_INTO_THE_VOID: ['ACTIVATED', 'FULLY_RESOLVED'],
    M16_ONE_DAY_OF_PEACE: ['ACTIVATED', 'FULLY_RESOLVED'],
    M18_FOOLISH_BURIAL_GOODS: [
      'ACTIVATED',
      'GARURA_OPTIONAL_EFFECT_ACTIVATED',
      'FULLY_RESOLVED'
    ],
    M21_CHICKEN_GAME: [
      'ACTIVATED',
      'PLACEMENT_RESOLVED',
      'FIELD_EFFECT_ACTIVATED',
      'OPTION_SELECTED_AND_DRAW_FULLY_RESOLVED'
    ]
  })
});

module.exports = { RESPONSE_BOUNDARIES };
