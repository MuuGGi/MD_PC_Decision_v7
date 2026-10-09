'use strict';
// V7 owns lifecycle/dispatch; mature functions retain their sole business-write ownership.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const ENGINE = path.join(ROOT, 'engine');
const { readOwnedJson, atomicWriteJson } = require('../core/json-store');
const { loadSnapshot, known } = require('../core/snapshot');
const { proveForeground } = require('../core/input-guard');
const { ContractError, UnknownFactError } = require('../core/errors');
const { KEY, makeBindings } = require('../integration/production-bindings');
const { readContract } = require('../integration/v6-observer-adapter');
const { createRuntimeSourceFreshnessGuard } = require('../../engine/lib/runtime-source-freshness');

async function run() {
  if (process.versions.node !== '20.11.1') throw new ContractError('V7_NODE_MUST_BE_20_11_1');
  if (process.env.MD_V7_RUN !== '1' || !process.env.MD_AUTOTEST_GUARD)
    throw new ContractError('V7_USE_RUN_V7_AUTOTEST_FROM_PROVEN_STARTER');
  const session = readOwnedJson(path.join(ENGINE, 'debug/v7/session.json'));
  if (!session || session.startProven !== true || session.duelId !== process.env.MD_V7_DUEL_ID)
    throw new ContractError('V7_DUEL_START_NOT_CURRENT_AND_PROVEN');
  const mature = require('../../engine/runtime/mature-driver');
  mature.assertEnvironment();
  const { MdFastBridge, clientReport } = require('../../engine/lib/win-fast');
  const bridge = new MdFastBridge();
  let expectedHwnd;
  const guard = async () => {
    await bridge.command({ cmd: 'guardCheck' });
    const info = await bridge.info(), report = clientReport(info);
    if (expectedHwnd == null) expectedHwnd = info.hwnd;
    return proveForeground(async () => ({ ...info, ...report, foregroundVerified: true }), { hwnd: expectedHwnd });
  };
  const manifest = readOwnedJson(path.join(ROOT, 'config/v6-ownership.json'));
  const resumeTicket = process.env.MD_V7_RESUME_TICKET ? readOwnedJson(process.env.MD_V7_RESUME_TICKET) : null;
  if (resumeTicket) {
    require('../../autotest/resume-unit').validateResumeTicket(resumeTicket, ENGINE);
    expectedHwnd = resumeTicket.expectedHwnd;
  }
  const units = makeBindings({ root: ENGINE, mature, finalGuard: guard, manifest,
    recoverSubmitted: resumeTicket ? async tx => {
      if (tx.id !== resumeTicket.transactionId || tx.duelId !== session.duelId) throw new ContractError('AUTOTEST_RESUME_TRANSACTION_CHANGED');
      return require('../integration/submitted-equipment-recovery').recoverSubmittedEquipment({ root: ENGINE,
        tx, ticket: resumeTicket, mature, finalGuard: guard });
    } : null });
  const sourceGuard = createRuntimeSourceFreshnessGuard({ rootDir: ROOT });
  const policy = require('../../autotest/policy');
  const auto = mature.createSimpleDrawAutoController();
  const rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  let state;
  console.log('V7规范化主循环：成熟识别/策略 + 持久事务边界；不开启新的策略路线。');
  try {
    await bridge.start();
    const foreground = await guard();
    if (foreground.status !== 'READY') throw new UnknownFactError('V7_FOREGROUND_NOT_PROVEN', undefined, foreground);
    if (resumeTicket) {
      state = mature.loadObserverSessionState();
      const recovered = await units.dispatch(resumeTicket.actionType, resumeTicket.intent,
        async () => { throw new ContractError('AUTOTEST_RESUME_UNIT_REPLAY_FORBIDDEN'); });
      state = recovered.state;
      console.log('AUTOTEST_V7_RESUME_COMPLETE: 已提交装备只完成验收/缺失记账，零重复发动。');
    } else {
      mature.resetDecisionStateForNewDuel();
      state = await mature.establishOpeningState();
    }
    // Opening observer normally initializes ledger. Keep that initialization explicit.
    require('../../engine/lib/main-deck-ledger').initializeSharedDeckState(
      require('../../engine/lib/recognizer').loadLibrary(ENGINE), state.cards, mature.loadDecisionState());
    let lastProgress = null, repeated = 0;
    for (let iteration = 0; iteration < 150; iteration++) {
      sourceGuard.assertFresh();
      require('../../autotest/auto-hook').check();
      mature.assertFreshRuntimeBeforeGameAction();
      const runtime = mature.loadDecisionState();
      // These locks require an explicit, separately proven recovery. No fresh-action replay.
      const pending = mature.loadPendingM18Route() || mature.loadPendingM21Transaction() ||
        mature.loadPendingMalletCheckpoint(state) || mature.loadPendingIncrementalObservation(state);
      if (pending) throw new ContractError('V7_LEGACY_RECOVERY_REQUIRED', undefined, { status: pending.status || pending.stage });
      const snapshotBefore = loadSnapshot(ENGINE);
      const active = require('../core/transaction-journal').createJournal(ENGINE).listActive(session.duelId);
      const decisionGate = require('../core/decision-gate').canStartNewDecision(snapshotBefore,
        require('../core/state-commit').createCommitCoordinator(ENGINE), active[0] || null);
      if (decisionGate.status !== 'READY') throw new UnknownFactError('V7_DECISION_BASELINE_NOT_PROVEN', undefined, decisionGate);
      mature.normalizeEquippedYotoGoldenDrawPriority(state);
      const node = mature.currentAtomicNode();
      const progress = JSON.stringify({ revision: state.revision, node, used: runtime.usedCounts });
      repeated = progress === lastProgress ? repeated + 1 : 0; lastProgress = progress;
      if (repeated > 1) throw new ContractError('V7_NO_BUSINESS_PROGRESS_NO_REPLAY');
      let result;
      try {
        if (mature.isTransactionPendingNode(node)) {
          console.log('V7继续已知交互：' + node);
          result = await units.dispatch(KEY.FIELD, { node }, () => mature.executeAtomicResponseInterval({ state, rl, automatic: true }));
        } else {
          const suggestion = mature.printDecisionPoint(state, 'V7决策点', auto);
          const command = policy.chooseDecision(suggestion);
          if (command === 'x') {
            const proof = await mature.runConfirmedDeadlockSurrender({ source: 'V7_PROVEN_STRATEGIC_DEADLOCK' });
            console.log('状态: ' + proof.status); break;
          }
          if (command === 'f') {
            result = await units.dispatch(KEY.FIELD, { node }, () => mature.executeAtomicResponseInterval({ state, rl, automatic: true }));
          } else if (suggestion.selected && suggestion.selected.specialAction === 'KAGARI_LINK_BEFORE_TRUE') {
            result = await units.dispatch(KEY.GAIN, { kind: 'KAGARI_LINK_BEFORE_TRUE' }, () => mature.executeKagariLinkBeforeTrue({ state }));
          } else if (suggestion.selected && suggestion.selected.specialAction === 'M21_FIELD_DRAW') {
            result = await units.dispatch(KEY.DRAW, { kind: 'M21_FIELD_DRAW' }, async () => ({ executed: true, state: mature.runPendingM21DrawExecutor(), quit: false }));
          } else {
            const selected = suggestion.selected;
            if (!selected || !Number.isInteger(Number(selected.slot))) throw new UnknownFactError('V7_NO_PROVEN_SELECTION');
            result = await units.dispatch(KEY.HAND, { cardId: selected.id, slot: Number(selected.slot) },
              () => mature.executeSelected({ state, slot: Number(selected.slot), rl }));
          }
        }
      } catch (error) {
        auto.stop();
        if (error.terminalVictory) {
          await mature.confirmDetectedVictoryResult('V7_CONFIRMED_VICTORY_VOID_ORDINARY_SETTLEMENT', rl);
          break;
        }
        throw error;
      }
      if (!result || result.executed !== true || !result.state) throw new ContractError('V7_EXECUTION_PROGRESS_NOT_PROVEN');
      const before = state; state = result.state;
      if (Number(state.revision) > Number(before.revision)) auto.completed(before, state);
      const snapshot = loadSnapshot(ENGINE);
      if (snapshot.consistency.length) throw new ContractError('V7_POST_UNIT_STATE_INCONSISTENT');
      const contract = readContract(ENGINE, { duelId: session.duelId,
        previousContract: readOwnedJson(path.join(ENGINE, 'debug/v7/observer-contract.json')) });
      if (contract.status === 'KNOWN') atomicWriteJson(path.join(ENGINE, 'debug/v7/observer-contract.json'), contract.contract);
      if (result.quit) break;
      if (iteration === 149) throw new ContractError('V7_DUEL_ACTION_LIMIT_NO_REPLAY');
    }
  } finally {
    rl.close(); await bridge.stop().catch(() => {});
  }
  console.log('V7本局执行退出，监督器负责已证明的终局与返回Starter。');
}
module.exports = { run, ROOT, ENGINE };
