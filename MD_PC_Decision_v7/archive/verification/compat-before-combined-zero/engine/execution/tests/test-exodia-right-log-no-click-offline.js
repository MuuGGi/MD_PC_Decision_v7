'use strict';

const assert = require('assert');
const { mainDeckCandidates } = require('../../lib/incremental-hand-locator');

// Live M09 evidence: Top1 margin was below the old 0.01 gate, but every Top3
// candidate was a singleton Exodia component and the bounded raw/HSV evidence
// supported M02.  It must collapse to one right-log identity so the observer
// commits it without a hand click.
const liveM02 = mainDeckCandidates({
  card: {
    id: 'M02',
    name: '被封印的左足',
    rawMad: 0.2775580998310866,
    hsvDistance: 0.6357315985669773
  },
  confidenceMargin: 0.00840514960363814,
  top3: [
    { id: 'M02', name: '被封印的左足' },
    { id: 'M05', name: '被封印的艾克佐迪亚' },
    { id: 'M04', name: '被封印的左腕' }
  ]
});
assert.deepStrictEqual(liveM02.map(card => card.id), ['M02']);

// A similarly narrow margin with any ordinary-card alternative must stay
// ambiguous and retain the existing visual-confirmation fallback.
const mixed = mainDeckCandidates({
  card: { id: 'M02', name: '被封印的左足', rawMad: 0.27, hsvDistance: 0.63 },
  confidenceMargin: 0.0085,
  top3: [
    { id: 'M02', name: '被封印的左足' },
    { id: 'M09', name: '暴发户哥布林' },
    { id: 'M04', name: '被封印的左腕' }
  ]
});
assert.deepStrictEqual(mixed.map(card => card.id), ['M02', 'M09', 'M04']);

console.log('EXODIA_RIGHT_LOG_NO_CLICK_OFFLINE_PASS');

// ISSUE-099: actual M09 mixed Top3 (head / Chicken Game / left arm) was
// incorrectly collapsed at margin 0.014284, and poisoned the later M12 hand.
const recordedM09 = require('../../material/issues/issue-099-m09-log.json');
const wrongGain = recordedM09.newOperationBlocks.find(block => block.activationKey === 'M09').details[0];
assert.deepStrictEqual(mainDeckCandidates(wrongGain).map(card => card.id), ['M05', 'M21', 'M04']);
assert.notStrictEqual(mainDeckCandidates(wrongGain).length, 1,
  'mixed weak Exodia evidence must never become an exact no-click head identity');
