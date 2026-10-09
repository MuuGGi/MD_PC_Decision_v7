'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { cropImage } = require('../../lib/png-utils');
const { loadLibrary, loadTemplates } = require('../../lib/recognizer');
const { loadDuelLogLabelTemplates } = require('../../lib/duel-log-label-reader');
const { loadFieldRowTemplates } = require('../../lib/duel-log-field-rows');
const { buildActivationBlocks } = require('../../lib/duel-log-state');
const { recognizeDuelLogScreenshot } = require('../../runtime/observer/test-duel-log-live');
const { verifyM13Observation } = require('../../lib/m13-observer-verification');
const { observerReplay } = require('./test-observer-replay-harness-offline');
const config = require('../../live-config');
const ROOT = path.resolve(__dirname, '../..');
const RUN = path.resolve(ROOT, '../runs/2026-10-04T05-26-53-681Z');
const archive = path.join(RUN, 'game-00005/before-recovery');
const png = file => PNG.sync.read(fs.readFileSync(file));

async function test() {
  const frame = png(path.join(archive, 'last-guarded-frame.png'));
  const loaded = await loadTemplates(ROOT, loadLibrary(ROOT));
  const bundle = { phaseTemplate: png(path.join(ROOT, 'templates/ui/duel_log_main1_phase.png')),
    loaded, cardTemplates: loaded.map(item => ({ ...item.card, image: item.image })),
    labelTemplates: await loadDuelLogLabelTemplates(ROOT), fieldRowTemplates: await loadFieldRowTemplates(ROOT) };
  // Execute the archived production reader to reproduce the original failure.
  const old = require(path.join(RUN, 'engine-source/runtime/observer/test-duel-log-live'));
  const oldLog = old.recognizeDuelLogScreenshot(frame, bundle, { skipMain1Search: true });
  assert.deepStrictEqual(buildActivationBlocks(oldLog.events).blocks.map(b => b.activationKey), ['M13', 'M13']);
  assert.ok(oldLog.events.some(e => e.type === 'ACTIVATE' && e.box.y === 167),
    'the opening card-back row was falsely made into an Allure activation');

  const log = recognizeDuelLogScreenshot(frame, bundle, { skipMain1Search: true });
  assert.strictEqual(log.atomicBottomFastPath, true);
  assert.ok(log.visibleMain1Boundary.startY > 167);
  assert.ok(log.events.every(e => e.box.y >= log.visibleMain1Boundary.startY));
  const grouped = buildActivationBlocks(log.events);
  assert.deepStrictEqual(grouped.blocks.map(b => b.activationKey), ['M13']);
  Object.assign(log, { operationBlocks: grouped.blocks, activationBlocks: grouped.blocks,
    newOperationBlocks: grouped.blocks, newActivationBlocks: grouped.blocks,
    orphanProcessingRows: grouped.orphanDetails, observerFieldTransitions: [] });
  const block = grouped.blocks[0];
  assert.deepStrictEqual(block.details.filter(d => d.role === 'HAND_GAIN_CANDIDATE').map(d => d.card.id), ['M16', 'M01']);
  assert.deepStrictEqual(block.details.filter(d => d.rawType === 'BANISH_FROM_HAND').map(d => d.card.id), ['M06']);

  // Complete actual observer + hand/Deck ledger + final Allure verification.
  // Every write is memory-only, no real bridge or native input exists.
  const setup = extra => observerReplay({ archive, handCount: 5,
    passiveImage: cropImage(frame, config.handFan.detectRoi),
    mutateLog: target => { Object.keys(target).forEach(k => delete target[k]); Object.assign(target, log); }, ...extra });
  const replay = setup();
  const before = replay.json(replay.handPath);
  const ledgerBefore = replay.json(replay.ledgerPath);
  await replay.run();
  const incremental = replay.json(replay.resultPath);
  assert.strictEqual(incremental.status, 'PASS');
  assert.deepStrictEqual(Array.from(incremental.after.cards, c => c.id),
    ['EXODIA_UNKNOWN', 'M06', 'M16', 'M19', 'M20']);
  assert.strictEqual(incremental.after.handCount, 5);
  assert.strictEqual(incremental.after.revision, before.revision + 1);
  const proof = verifyM13Observation({ baseline: before, log, incremental,
    banishProof: { selected: { id: 'M06', accepted: true } } });
  assert.deepStrictEqual(proof.drawn.map(c => c.id).sort(), ['EXODIA_UNKNOWN', 'M16']);
  assert.strictEqual(proof.banished.id, 'M06');
  const ledgerAfter = replay.json(replay.ledgerPath);
  for (const id of ['M19', 'M20', 'M06', 'M13']) {
    assert.strictEqual(ledgerAfter.outsideDeckCounts[id], ledgerBefore.outsideDeckCounts[id],
      `existing cards/banished Raye must not be counted as new Deck exits: ${id}`);
  }
  assert.ok((incremental.finalClicks || []).every(c => !c.physicalClicksIssued));
  assert.ok(replay.commands.every(c => ['MOCK_INFO', 'ESC', 'NEUTRAL_CLICK'].includes(c.cmd)));
  const wrongInfo = setup({ handCount: 6 });
  await assert.rejects(wrongInfo.run());
  for (const [file, buffer] of wrongInfo.before) {
    assert.deepStrictEqual(wrongInfo.files.get(file), buffer, 'failed observation must not commit hand/ledger');
  }
  console.log('OPENING_LOG_BOUNDARY_OFFLINE_PASS; actual G5 five backs -> no false activation; Allure observer+ledger+final proof; nativeInputs=0');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
