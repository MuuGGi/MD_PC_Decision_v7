'use strict';

const { buildAllureBanishPriority } = require('../../lib/allure-policy');

module.exports = {
  id: 'M13',
  name: '暗之诱惑',
  minHandCountBeforeActivation: 2,
  settleAfterBanishMs: 1800,
  safeBanishPriority: buildAllureBanishPriority()
};
