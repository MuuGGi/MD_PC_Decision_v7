'use strict';

const path = require('path');
const { readJsonIfExistsSafe } = require('../lib/runtime-files');
const { EXODIA_UNKNOWN_ID, isExodiaComponentCard } = require('../lib/exodia-policy');

const ROOT = path.resolve(__dirname, '..');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const LEDGER_STATE_PATH = path.join(ROOT, 'debug', 'main-deck-ledger', 'state.json');
const INCREMENTAL_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const DECISION_STATE_PATH = path.join(ROOT, 'decision-state.json');
const M18_ROUTE_STATE_PATH = path.join(ROOT, 'debug', 'execution', 'M18_foolish_burial', 'route_state.json');
const M11_RESUME_STATE_PATH = path.join(
  ROOT, 'debug', 'execution', 'M11_mallet_keep_weapon', '_resume', 'resume_state.json'
);
const TRUE_ROUTE_STATE_PATH = path.join(
  ROOT, 'debug', 'execution', 'V5_hornet_link_current', 'true_route_state.json'
);

function ids(cards) {
  return (cards || []).map(card => String(card && card.id || '')).filter(Boolean);
}

function sameSequence(a, b) {
  const aa = ids(a);
  const bb = ids(b);
  return aa.length === bb.length && aa.every((id, index) => id === bb[index]);
}

function countById(cards) {
  const out = {};
  for (const card of cards || []) {
    const id = String(card && card.id || '');
    if (!/^M\d+$/.test(id)) continue;
    out[id] = Number(out[id] || 0) + 1;
  }
  return out;
}

function printOptionalState(label, filePath, selector) {
  const value = readJsonIfExistsSafe(filePath);
  if (!value) {
    console.log(`${label}: none`);
    return;
  }
  console.log(`${label}: ${selector(value)}`);
}

function main() {
  if (process.versions.node !== '20.11.1') {
    throw new Error(`NODE_RUNTIME_MISMATCH:${process.versions.node};expected=20.11.1`);
  }

  console.log('============================================================');
  console.log('V6 STATE CONSISTENCY AUDIT');
  console.log('只读取本地状态文件；不连接/点击 Master Duel，不修改任何状态。');
  console.log('============================================================');

  const hand = readJsonIfExistsSafe(HAND_STATE_PATH);
  const ledger = readJsonIfExistsSafe(LEDGER_STATE_PATH);

  if (!hand && !ledger) {
    console.log('STATE AUDIT: NO_RUNTIME_STATE');
    console.log('当前没有可核对的 hand session / Main-Deck ledger。');
    return;
  }
  if (!hand) throw new Error('STATE_AUDIT_HAND_SESSION_MISSING');
  if (!ledger) throw new Error('STATE_AUDIT_MAIN_DECK_LEDGER_MISSING');

  const handRevision = Number(hand.revision || 0);
  const ledgerRevision = Number(ledger.lastHandRevision || 0);
  const handCards = Array.isArray(hand.cards) ? hand.cards : [];
  const handCount = Number(hand.handCount);

  if (!Number.isInteger(handCount) || handCount !== handCards.length) {
    throw new Error(`STATE_AUDIT_HAND_COUNT_INVALID:${handCount}/${handCards.length}`);
  }

  console.log(`hand session: revision=${handRevision}; handCount=${handCount}`);
  console.log(`main-deck ledger: revision=${ledgerRevision}`);

  if (handRevision !== ledgerRevision) {
    const incremental = readJsonIfExistsSafe(INCREMENTAL_PATH);
    const after = incremental && incremental.after;
    const recoverable = Boolean(
      handRevision === ledgerRevision + 1 &&
      incremental &&
      incremental.status === 'PASS' &&
      after &&
      Number(after.revision || 0) === handRevision &&
      sameSequence(after.cards, handCards)
    );
    if (recoverable) {
      console.log('STATE AUDIT: RECOVERABLE_REVISION_MISMATCH');
      console.log(
        `hand=${handRevision}; ledger=${ledgerRevision}; ` +
        'latest_incremental_result 与当前手牌完整一致。'
      );
      console.log('建议恢复命令: .\\run-v6.cmd --repair-latest-ledger');
      process.exitCode = 2;
      return;
    }
    throw new Error(
      `STATE_AUDIT_REVISION_MISMATCH:hand=${handRevision};ledger=${ledgerRevision}`
    );
  }

  const handCounts = countById(handCards);
  for (const [id, count] of Object.entries(handCounts)) {
    const outside = Number(ledger.outsideDeckCounts && ledger.outsideDeckCounts[id] || 0);
    if (count > outside) {
      throw new Error(
        `STATE_AUDIT_HAND_EXCEEDS_OUTSIDE:${id};hand=${count};outside=${outside}`
      );
    }
  }
  const unknownComponents = handCards.filter(card =>
    card && card.id === EXODIA_UNKNOWN_ID && isExodiaComponentCard(card)
  ).length;
  if (unknownComponents > Number(ledger.unknownExodiaOutsideCount || 0)) {
    throw new Error(
      `STATE_AUDIT_UNKNOWN_EXODIA_EXCEEDS_OUTSIDE:` +
      `hand=${unknownComponents};outside=${ledger.unknownExodiaOutsideCount || 0}`
    );
  }

  const decision = readJsonIfExistsSafe(DECISION_STATE_PATH) || {};
  const branch = decision.v5Branch || {};
  console.log(
    `decision branch: ${String(branch.currentState || 'NONE')}; ` +
    `active=${branch.active === true ? 'true' : 'false'}`
  );

  printOptionalState('M11 checkpoint', M11_RESUME_STATE_PATH, value =>
    String(value.status || value.stage || 'present')
  );
  printOptionalState('M18 route', M18_ROUTE_STATE_PATH, value =>
    String(value.status || 'present')
  );
  printOptionalState('True-Bamboo route', TRUE_ROUTE_STATE_PATH, value =>
    String(value.stage || value.status || 'present')
  );

  console.log('STATE AUDIT PASS');
  console.log(
    `revision=${handRevision}; hand identities are covered by outsideDeckCounts; ` +
    'no cross-file revision mismatch detected.'
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`STATE AUDIT FAIL: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}
