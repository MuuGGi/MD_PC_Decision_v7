'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../lib/runtime-files');

const ROOT = path.resolve(__dirname, '..', '..');
const { loadInfoDigitTemplates } = require(path.join(ROOT, 'lib', 'hand-info-overlay'));
const { runLiveScan } = require(path.join(ROOT, 'runtime', 'observer', 'test-scan-state-live'));
const {
  readOwnHandCount,
  runDenseHandScan
} = require(path.join(ROOT, 'runtime', 'observer', 'capture-hand-scroll-segments-live'));
const { runDuelLogLive } = require(path.join(ROOT, 'runtime', 'observer', 'test-duel-log-live'));

const PREPARED_DIR = path.join(ROOT, 'debug', 'scan-state-live', 'prepared');
const PREPARED_RESULT = path.join(PREPARED_DIR, 'result.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const LOG_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Directly mirrors the verified DENSE -> prepared-baseline adapter used by the
// mature observer/prepared-baseline path.  Execution does not invent another
// hand representation.
function denseToObserverBaseline(denseOut, handCount) {
  const scan = denseOut && denseOut.scan;
  if (!scan || scan.status !== 'PASS' || scan.handCount !== handCount ||
      !Array.isArray(scan.cards) || scan.cards.length !== handCount) {
    throw new Error(
      `EXEC_OBSERVER_DENSE_BASELINE_INVALID:${scan && scan.status}/${scan && scan.handCount}/` +
      `${scan && scan.cards && scan.cards.length}`
    );
  }

  const confidence = scan.confidence || null;
  const confidenceAccepted = handCount <= 10
    ? confidence === 'HIGH'
    : confidence === 'HIGH' || confidence === 'MEDIUM';
  if (!confidenceAccepted) {
    throw new Error(`EXEC_OBSERVER_DENSE_CONFIDENCE_NOT_SAFE:${confidence}`);
  }

  return {
    status: 'PASS',
    expectedOwn: handCount,
    handCount,
    layoutMode: scan.layoutMode || 'DENSE_HAND_SEGMENTED_SCROLL',
    slotsScanned: scan.cards.length,
    cards: scan.cards.map((card, index) => ({
      ...card,
      index: index + 1,
      accepted: card.accepted !== false
    })),
    denseHandBaseline: true,
    denseConfidence: scan.confidence || null,
    source: scan.source || denseOut.resultPath || null
  };
}

function persistDenseObserverBaseline(result, denseOut) {
  const now = new Date().toISOString();
  writeJson(PREPARED_RESULT, result);
  writeJsonAtomic(HAND_STATE_PATH, {
    version: 1,
    capturedAt: now,
    revision: 0,
    handCount: result.handCount,
    cards: result.cards,
    handImagePath: denseOut.baselineHandImagePath || null,
    denseHandBaseline: true,
    source: PREPARED_RESULT
  }, { trailingNewline: true });

  // Placeholder only.  runDuelLogLive(rebaselineCurrentBottom=true) directly
  // below replaces this with the actual current right-log tail.
  writeJsonAtomic(LOG_STATE_PATH, {
    version: 1,
    capturedAt: now,
    baseline: 'EMPTY_MAIN1',
    checkpoint: null,
    initialHand: result.cards.map(card => card.id),
    preparedCurrentState: true
  }, { trailingNewline: true });
}

// The scan result is evidence; the committed session is the hand authority.
// Never return an unversioned scan as if it were that committed authority.
function alignCommittedObserverBaseline(baseline, committed, startedAt) {
  const cards = committed && committed.cards;
  const capturedAt = Date.parse(committed && committed.capturedAt);
  if (!baseline || baseline.status !== 'PASS' || !Array.isArray(baseline.cards) ||
      !committed || !Number.isInteger(committed.revision) || committed.revision < 0 ||
      !Array.isArray(cards) || cards.length !== committed.handCount ||
      committed.handCount !== baseline.handCount || cards.length !== baseline.cards.length ||
      cards.some((card, n) => !card?.id || card.id === 'UNKNOWN' || card.id !== baseline.cards[n]?.id) ||
      !Number.isFinite(capturedAt) || !Number.isFinite(startedAt) || capturedAt < startedAt ||
      typeof committed.source !== 'string' || path.resolve(committed.source) !== path.resolve(PREPARED_RESULT))
    throw new Error('EXEC_OBSERVER_COMMITTED_BASELINE_NOT_ALIGNED');
  return { ...baseline, ...committed, status: 'PASS', observerBaselineCommitted: true };
}

async function establishCurrentObserverBaseline(options) {
  const startedAt = Date.now();
  const {
    bridge,
    info,
    outputDir
  } = options;

  console.log('\n============================================================');
  console.log('执行前当前局面基线：完全复用 V1 已验证 observer 手牌读取');
  console.log('1~7张 = TITLE_COMPONENTS 完整扫描；8~12张 = DENSE 分段完整扫描。');
  console.log('这里只建立当前状态，不执行任何卡牌操作。');
  console.log('============================================================');

  const digitTemplates = loadInfoDigitTemplates(ROOT);
  const countDir = path.join(outputDir || PREPARED_DIR, 'observer_hand_count');
  const countRead = await readOwnHandCount(bridge, digitTemplates, countDir, null, { returnEvidence: true });
  const handCount = countRead.handCount;
  if (!Number.isInteger(handCount) || handCount < 1 || handCount > 12) {
    throw new Error(`EXEC_OBSERVER_HAND_COUNT_UNSUPPORTED:${handCount}`);
  }
  console.log(`当前我方 INFO 权威手牌数=${handCount}`);

  let baseline;
  if (handCount <= 7) {
    baseline = await runLiveScan({
      expected: handCount,
      handCountProof: countRead.proof,
      preparedBaseline: true,
      verbose: false,
      observerFast: false,
      persistObserverBaseline: true,
      bridge,
      skipActivation: true
    });

    if (!baseline || baseline.status !== 'PASS' || baseline.handCount !== handCount ||
        !Array.isArray(baseline.cards) || baseline.cards.length !== handCount) {
      throw new Error(
        `EXEC_OBSERVER_LOW_BASELINE_INVALID:${baseline && baseline.status}/${baseline && baseline.handCount}`
      );
    }
  } else {
    let denseOut = null;
    let lastDenseError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptDir = path.join(
        outputDir || PREPARED_DIR,
        'observer_dense_scan',
        `attempt_${attempt}`
      );
      denseOut = await runDenseHandScan({
        expectedCount: handCount,
        authoritativeCount: handCount,
        repeats: 1,
        bridge,
        info,
        skipActivation: true,
        verifyOwnTurn: true,
        outputDir: attemptDir,
        writeLatest: true,
        mode: 'EXECUTION_CURRENT_OBSERVER_BASELINE'
      });
      try {
        baseline = denseToObserverBaseline(denseOut, handCount);
        lastDenseError = null;
        break;
      } catch (error) {
        lastDenseError = error;
        const confidence = denseOut && denseOut.scan && denseOut.scan.confidence;
        console.log(
          `执行基线 DENSE 第${attempt}轮证据不够安全: confidence=${confidence}; ` +
          `${attempt < 2 ? '重新完整扫描，不提交本轮。' : '停止，不允许带LOW证据进入执行。'}`
        );
      }
    }
    if (!baseline) throw lastDenseError || new Error('EXEC_OBSERVER_DENSE_BASELINE_NOT_PROVEN');
    persistDenseObserverBaseline(baseline, denseOut);
    console.log(`当前局面 DENSE 完整扫描成功: 手牌=${handCount}; confidence=${baseline.denseConfidence}`);
    console.log(`当前手牌: ${baseline.cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`);
  }

  // Same mature right-log mechanism; execution only asks it to seal the
  // current bottom as history so the next operation is independently visible.
  await runDuelLogLive({
    bridge,
    skipActivation: true,
    skipForegroundReactivate: true,
    observerFast: true,
    rebaselineCurrentBottom: true,
    allowBacktrack: false,
    startupMalletTail: process.env.MD_STARTUP_MALLET === '1',
    initialInfo: info,
    verbose: false
  });

  const committed = JSON.parse(fs.readFileSync(HAND_STATE_PATH, 'utf8'));
  return alignCommittedObserverBaseline(baseline, committed, startedAt);
}

module.exports = {
  denseToObserverBaseline,
  persistDenseObserverBaseline,
  alignCommittedObserverBaseline,
  establishCurrentObserverBaseline
};
