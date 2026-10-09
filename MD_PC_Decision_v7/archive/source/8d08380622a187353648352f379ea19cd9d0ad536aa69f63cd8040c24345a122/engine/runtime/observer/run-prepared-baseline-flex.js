'use strict';

const path = require('path');
const { writeJsonAtomic } = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const config = require('../../live-config');
const { MdFastBridge } = require('../../lib/win-fast');
const { activateAndVerifyMasterDuel } = require('../../lib/md-foreground');
const { loadInfoDigitTemplates } = require('../../lib/hand-info-overlay');
const { readOwnHandCount, runDenseHandScan } = require('./capture-hand-scroll-segments-live');

const ROOT = path.resolve(__dirname, '..', '..');
const PREPARED_DIR = path.join(ROOT, 'debug', 'scan-state-live', 'prepared');
const PREPARED_RESULT = path.join(PREPARED_DIR, 'result.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');
const OBSERVER_STATE_PATH = path.join(ROOT, 'debug', 'duel-log-live', 'observer_state.json');
const verbose = process.argv.includes('--verbose');

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value, { trailingNewline: true });
}

function run(script, args = []) {
  console.log(`\n===== ${script} =====`);
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 运行失败，exit=${result.status || 1}`);
}

function denseToPreparedResult(denseOut, handCount) {
  const scan = denseOut && denseOut.scan;
  if (!scan || scan.status !== 'PASS' || scan.handCount !== handCount ||
      !Array.isArray(scan.cards) || scan.cards.length !== handCount) {
    throw new Error(
      `PREPARED_DENSE_SCAN_INVALID:${scan && scan.status}/${scan && scan.handCount}/${scan && scan.cards && scan.cards.length}`
    );
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

function persistDenseBaseline(result, denseOut) {
  const now = new Date().toISOString();
  writeJson(PREPARED_RESULT, result);
  writeJson(HAND_STATE_PATH, {
    version: 1,
    capturedAt: now,
    revision: 0,
    handCount: result.handCount,
    cards: result.cards,
    handImagePath: denseOut.baselineHandImagePath || null,
    denseHandBaseline: true,
    source: PREPARED_RESULT
  });
  writeJson(OBSERVER_STATE_PATH, {
    version: 1,
    capturedAt: now,
    baseline: 'EMPTY_MAIN1',
    checkpoint: null,
    initialHand: result.cards.map(card => card.id)
  });
}

async function readConfirmedOwnHandCount(bridge, digitTemplates, countProbeDir) {
  const samples = [];
  const votes = new Map();

  const isLegalInfoCount = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 12 && value !== 1;

  const readOne = async (index) => {
    let value = null;
    try {
      value = await readOwnHandCount(
        bridge,
        digitTemplates,
        path.join(countProbeDir, `sample_${index}`),
        null
      );
    } catch (error) {
      samples.push({ index, value: null, error: error && (error.code || error.message) || String(error) });
      console.log(
        `调配基线 INFO 手牌数采样${index}=INVALID(${error && (error.code || error.message) || error})；` +
        '本次不投票。'
      );
      return null;
    }

    samples.push({ index, value, error: null });

    // Mature production rule: INFO=1 is not a candidate at all.  Do not vote,
    // do not promote it with hand-fan geometry, and never pass --expected 1 to
    // the low-hand scanner.  This prevents the known 11 -> 1 missing-tens
    // regression from re-entering the execution path.
    if (!isLegalInfoCount(value)) {
      console.log(
        `调配基线 INFO 手牌数采样${index}=${value} -> INVALID；` +
        'INFO数量候选不包含1，本次不投票。'
      );
      return null;
    }

    votes.set(value, Number(votes.get(value) || 0) + 1);
    console.log(`调配基线 INFO 手牌数采样${index}=${value}`);
    return value;
  };

  const currentConsensus = () => {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const best = ranked[0];
    const secondVotes = ranked[1] ? ranked[1][1] : 0;
    if (best[1] >= 2 && best[1] > secondVotes) {
      return {
        handCount: Number(best[0]),
        voteCount: best[1]
      };
    }
    return null;
  };

  for (let index = 1; index <= 5; index++) {
    await readOne(index);
    const confirmed = currentConsensus();
    if (confirmed) {
      const raw = samples.map(sample => sample.value == null ? 'INVALID' : String(sample.value));
      const consensus = `${confirmed.voteCount}_VALID_OF_${samples.length}`;
      if (samples.length > 2 || raw.includes('1') || raw.includes('INVALID')) {
        console.log(
          `INFO有效候选确认: 手牌=${confirmed.handCount}; consensus=${consensus}; ` +
          `raw=${raw.join('/')}`
        );
      }
      return {
        handCount: confirmed.handCount,
        samples: raw,
        consensus
      };
    }
  }

  const raw = samples.map(sample => sample.value == null ? 'INVALID' : String(sample.value));
  throw new Error(
    `PREPARED_FLEX_HAND_COUNT_NO_VALID_CONSENSUS:${raw.join('/')};` +
    'INFO=1不是合法候选，已拒绝进入expected=1扫描。'
  );
}

async function main() {
  console.log('============================================================');
  console.log('调配基线：自动识别当前实际手牌数（INFO有效候选不包含1；本流程使用2~12）');
  console.log('2~7张沿用普通完整扫描；8~12张自动切换分段拖拽完整扫描。');
  console.log('本阶段发生在目标卡发动前，可以安全读取 i 和逐张识别手牌。');
  console.log('============================================================');

  run('tools/reset-duel-state.js');

  const bridge = new MdFastBridge();
  let bridgeStopped = false;
  try {
    await bridge.start();
    const activation = await activateAndVerifyMasterDuel(bridge);
    const info = activation.info;
    const digitTemplates = loadInfoDigitTemplates(ROOT);
    const countProbeDir = path.join(PREPARED_DIR, 'count_probe');
    const confirmedCount = await readConfirmedOwnHandCount(bridge, digitTemplates, countProbeDir);
    const handCount = confirmedCount.handCount;

    if (!Number.isInteger(handCount) || handCount === 1 || handCount < 0 || handCount > 12) {
      throw new Error(`PREPARED_FLEX_HAND_COUNT_UNSUPPORTED:${handCount}`);
    }
    console.log(`调配基线 INFO 权威手牌数=${handCount}; consensus=${confirmedCount.consensus}; samples=${confirmedCount.samples.join('/')}`);

    if (handCount <= 7) {
      await bridge.stop();
      bridgeStopped = true;
      run('runtime/observer/test-scan-state-live.js', [
        '--expected', String(handCount),
        '--prepared-baseline',
        ...(verbose ? ['--verbose'] : [])
      ]);
    } else {
      const denseOut = await runDenseHandScan({
        expectedCount: handCount,
        authoritativeCount: handCount,
        repeats: 1,
        bridge,
        info,
        skipActivation: true,
        verifyOwnTurn: true,
        outputDir: path.join(PREPARED_DIR, 'dense_scan'),
        writeLatest: true,
        mode: 'PREPARED_BASELINE_DENSE_HAND'
      });
      const preparedResult = denseToPreparedResult(denseOut, handCount);
      persistDenseBaseline(preparedResult, denseOut);
      console.log(`调配后初始扫描成功: 手牌=${handCount}`);
      console.log(`初始手牌: ${preparedResult.cards.map(card => `${card.name}[${card.id}]`).join(' | ')}`);
      console.log('已重建增量手牌基线；接下来将打开右侧信息栏并建立日志检查点。');
      console.log(`完整详情: ${PREPARED_RESULT}`);
    }
  } finally {
    if (!bridgeStopped) await bridge.stop().catch(() => {});
  }

  run('runtime/observer/test-duel-log-live.js', verbose ? ['--verbose'] : []);
}

main().catch(error => {
  console.error(`\n调配基线失败: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
