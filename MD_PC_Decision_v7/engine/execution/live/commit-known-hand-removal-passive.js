'use strict';

const fs = require('fs');
const path = require('path');
const {readJson, writeJsonAtomic, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const config = require('../../live-config');
const { MdFastBridge, captureReferenceRoi } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { savePng } = require('../../lib/png-utils');
const { commitKnownNonDeckHandRemoval } = require('../../lib/main-deck-ledger');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'hand-change-live');
const STATE_PATH = path.join(DEBUG_DIR, 'session_state.json');
const RESULT_PATH = path.join(DEBUG_DIR, 'latest_incremental_result.json');

function argValue(prefix) {
  const raw = process.argv.find(arg => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : '';
}


async function main() {
  const cardId = String(argValue('--card-id=') || '').trim();
  const cardName = String(argValue('--card-name=') || cardId).trim();
  if (!cardId) throw new Error('KNOWN_HAND_REMOVAL_CARD_ID_REQUIRED');
  if (!fs.existsSync(STATE_PATH)) throw new Error(`HAND_STATE_NOT_FOUND:${STATE_PATH}`);

  const before = readJson(STATE_PATH);
  if (!Array.isArray(before.cards) || !Number.isInteger(before.handCount)) {
    throw new Error('HAND_STATE_INVALID');
  }
  if (before.cards.length !== before.handCount) {
    throw new Error(`HAND_STATE_COUNT_MISMATCH:${before.cards.length}/${before.handCount}`);
  }

  const removeIndex = before.cards.findIndex(card => String(card && card.id || '') === cardId);
  if (removeIndex < 0) throw new Error(`KNOWN_HAND_REMOVAL_CARD_NOT_FOUND:${cardId}`);
  const afterCards = before.cards
    .filter((_, index) => index !== removeIndex)
    .map((card, index) => ({ ...card, index: index + 1 }));
  const afterCount = afterCards.length;
  if (afterCount !== before.handCount - 1) throw new Error('KNOWN_HAND_REMOVAL_COUNT_INVALID');

  console.log('\n===== KNOWN MANUAL HAND REMOVAL PASSIVE SYNC =====');
  console.log(`已知动作: ${cardName}[${cardId}] 已从手牌发动/离手。`);
  console.log('这里只同步已验证的手牌-1事实并被动保存当前手牌画面；不读INFO、不点击手牌、不发送ESC。');

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    const verified = await activateAndVerifyMasterDuel(bridge);
    const image = await captureReferenceRoi(bridge, verified.info, config.handFan.detectRoi);
    const revision = Number(before.revision || 0) + 1;
    const imagePath = path.join(DEBUG_DIR, `revision_${revision}`, 'known_manual_removal_passive.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    await savePng(image, imagePath);

    const now = new Date().toISOString();
    const after = {
      ...before,
      capturedAt: now,
      revision,
      handCount: afterCount,
      cards: afterCards,
      handImagePath: imagePath,
      source: `KNOWN_MANUAL_HAND_REMOVAL:${cardId}`
    };
    writeJsonAtomic(STATE_PATH, after, { trailingNewline: true });
    try {
      commitKnownNonDeckHandRemoval({
        beforeState: before,
        afterState: after,
        removeId: cardId,
        evidenceKey: `KNOWN_MANUAL_HAND_REMOVAL:${cardId}:${before.revision}->${after.revision}`
      });
    } catch (error) {
      // Keep hand/ledger revisions aligned if this local-only sync cannot
      // commit the corresponding ledger revision. No game input is replayed.
      writeJsonAtomic(STATE_PATH, before, { trailingNewline: true });
      throw error;
    }
    writeJson(RESULT_PATH, {
      status: 'PASS',
      mode: 'KNOWN_MANUAL_HAND_REMOVAL_PASSIVE_SYNC',
      capturedAt: now,
      before: { handCount: before.handCount, cards: before.cards },
      after,
      inference: {
        activationKey: cardId,
        consumed: before.cards[removeIndex],
        costConsumed: [],
        addedCount: 0,
        predictedSlots: []
      },
      insertedCards: [],
      finalClicks: [],
      recognitionTimings: []
    });
    console.log(`手牌基线同步 PASS: ${before.handCount} -> ${afterCount}; 移出=${cardName}[${cardId}]`);
    console.log(`被动手牌图已刷新: ${imagePath}`);
  } finally {
    await bridge.stop();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
