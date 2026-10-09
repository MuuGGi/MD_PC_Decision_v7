'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { debugImageRetention } = require('../../../autotest/store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-v7-image-policy-')), files = [];
function sample(relative) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'generated retention fixture'); files.push(file); return file; }
const hand = sample('scan-state-live/prepared/hand.png');
fs.mkdirSync(path.join(root, 'hand-change-live'), { recursive: true });
fs.writeFileSync(path.join(root, 'hand-change-live/session_state.json'), JSON.stringify({ handImagePath: hand }));
sample('duel-outcome-live/victory_matched.png'); sample('post-duel-victory/settlement/settlement_reward_panel.png');
for (let i = 0; i < 40; i++) { sample('ordinary/frame-' + i + '.png'); sample('post-duel-victory/sampling-' + i + '.png'); }
for (let attempt = 1; attempt <= 3; attempt++) for (let i = 0; i < 8; i++) sample('execution/M17/2026-10-07T00-0' + attempt + '-00-000Z/target-' + i + '.png');
sample('duel-log-live/current.png'); sample('error_state.png');
const failedOwn = sample('hand-change-live/incremental-info-fast/own_roi_last.png');
const fallbackOwn = sample('hand-change-live/incremental-info/own_roi_last.png');
const normal = debugImageRetention(root, false, { compact: true }), failure = debugImageRetention(root, true, { compact: true });
assert.equal(files.filter(normal).length, 3); assert(normal(hand)); assert(failure(hand));
assert(files.filter(failure).length <= 9);
assert(failure(failedOwn)); assert(failure(fallbackOwn)); assert(!normal(failedOwn));
assert(!files.filter(failure).some(file => file.includes('2026-10-07T00-01')));
assert(normal(path.join(root, 'receipt.json'))); assert(failure(path.join(root, 'receipt.json')));
console.log('V7_COMPACT_EVIDENCE_PASS; all receipts kept; normal PNG <=3; failure PNG <=9; latest two attempts; no game input');
