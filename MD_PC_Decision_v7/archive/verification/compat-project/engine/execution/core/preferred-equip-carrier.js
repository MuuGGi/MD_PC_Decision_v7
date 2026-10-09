'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const config = require(path.join(ROOT, 'live-config'));
const { captureReferenceRoi, mapReferencePoint, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { yellowUsableStats } = require(path.join(ROOT, 'lib', 'hand-state'));
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { captureObservedOwnLink } = require(path.join(ROOT, 'execution', 'core', 'field-link-target'));

// Final route preference requested by the user:
// 1) Prefer an actual Link monster in either Extra Monster Zone.
// 2) If no Extra-Monster-Zone Link is present, inspect the center Main Monster Zone.
// This helper is deliberately an EQUIP-target chooser. It does not decide Link material legality.
const { EXTRA_LINK_ANCHORS, EXTRA_ANCHOR_MAX_DRIFT } = require('./field-zone-geometry');
const CENTRAL_MAIN = { name: '中央主怪兽区', x: 1024, y: 700 };
const CENTRAL_YELLOW_MIN = 450;
const TARGET_SELECTABLE_YELLOW_MIN = 450;
const TARGET_PROMPT_TIMEOUT_MS = 5000;
const TARGET_PROMPT_POLL_MS = 140;
const TARGET_PROMPT_STABLE_FRAMES = 2;

function canonicalExtraClickReference(anchor) {
  const matched = EXTRA_LINK_ANCHORS.find(candidate =>
    candidate && anchor && candidate.name === anchor.name
  );
  if (!matched) throw new Error('UNKNOWN_EXTRA_ZONE_ANCHOR');
  return { x: matched.x, y: matched.y };
}

function resolveExtraTargetCoordinates(probe, matchedAnchor) {
  if (!probe || !probe.referenceCenter) {
    throw new Error('EXTRA_LINK_EVIDENCE_REFERENCE_REQUIRED');
  }
  return {
    evidenceReference: {
      x: Number(probe.referenceCenter.x),
      y: Number(probe.referenceCenter.y)
    },
    clickReference: canonicalExtraClickReference(matchedAnchor)
  };
}

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

async function recognizeCurrent({ bridge, info, library, templates }) {
  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  return normalizeRecognized(raw);
}

async function probeExtraLinkAtAnchor({ bridge, info, anchor, debugDir, label }) {
  const probe = await captureObservedOwnLink({
    bridge,
    info,
    anchorReference: anchor,
    debugDir,
    label
  });

  // captureObservedOwnLink can still report the globally best Link frame when no
  // passing frame is close to the supplied anchor. Therefore an Extra Zone hit
  // is accepted only when anchorDrift is explicitly proven and stays bounded.
  const nearestExtra = probe.referenceCenter
    ? EXTRA_LINK_ANCHORS
      .map(candidate => ({
        anchor: candidate,
        drift: Math.hypot(
          Number(probe.referenceCenter.x) - Number(candidate.x),
          Number(probe.referenceCenter.y) - Number(candidate.y)
        )
      }))
      .sort((a, b) => a.drift - b.drift)[0]
    : { anchor, drift: Number.POSITIVE_INFINITY };
  const computedAnchorDrift = nearestExtra.drift;
  const anchorDrift = Number.isFinite(probe.anchorDrift)
    ? Number(probe.anchorDrift)
    : computedAnchorDrift;
  const accepted = Boolean(
    probe.visible &&
    probe.referenceCenter &&
    Number.isFinite(anchorDrift) &&
    anchorDrift <= EXTRA_ANCHOR_MAX_DRIFT
  );

  return {
    anchor,
    matchedAnchor: Number.isFinite(probe.anchorDrift) ? anchor : nearestExtra.anchor,
    probe,
    anchorDrift,
    accepted
  };
}

async function probeCentralSelectable({ bridge, info, debugDir }) {
  const roi = {
    x: CENTRAL_MAIN.x - 115,
    y: CENTRAL_MAIN.y - 120,
    width: 230,
    height: 240
  };
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, 'central_main_selectable.png'));
  }
  const yellow = yellowUsableStats(image);
  const accepted = yellow.estimatedYellowPixels >= CENTRAL_YELLOW_MIN;
  return { reference: { x: CENTRAL_MAIN.x, y: CENTRAL_MAIN.y }, roi, yellow, accepted };
}

async function choosePreferredEquipCarrier({ bridge, info, debugDir, requiredKind = null }) {
  if (requiredKind === 'CENTRAL_MAIN') {
    const centralProbe = await probeCentralSelectable({ bridge, info, debugDir });
    console.log(
      `装备对象中央主怪兽区几何锁定: ` +
      `initialYellow=${centralProbe.yellow.estimatedYellowPixels}(仅诊断); ` +
      `随后由稳定可选等待验收`
    );
    // The activation click can still be transitioning into the target prompt.
    // A single early yellow sample is therefore not proof that the central
    // carrier is absent.  Lock only the known zone geometry here; the shared
    // waitForEquipTargetSelectable gate below must still prove two stable
    // prompt-specific yellow frames before any target click is allowed.
    return {
      kind: 'CENTRAL_MAIN',
      zoneName: CENTRAL_MAIN.name,
      reference: centralProbe.reference,
      evidenceReference: centralProbe.reference,
      extraProbes: [],
      centralProbe,
      source: 'REQUIRED_CENTRAL_MAIN_GEOMETRY_PENDING_STABLE_SELECTABLE_PROOF',
      clickPolicy: 'CANONICAL_KNOWN_ZONE_CENTER'
    };
  }

  const extraProbes = [];
  for (let i = 0; i < EXTRA_LINK_ANCHORS.length; i++) {
    const anchor = EXTRA_LINK_ANCHORS[i];
    const row = await probeExtraLinkAtAnchor({
      bridge,
      info,
      anchor,
      debugDir,
      label: `equip_extra_link_${i + 1}`
    });
    extraProbes.push(row);
    if (row.accepted) {
      const matchedAnchor = row.matchedAnchor || anchor;
      // The sliding Link-frame window is deliberately fuzzy: it proves that a
      // Link exists near a known Extra Monster Zone, but its center is not an
      // action coordinate.  Once the evidence is classified into a board zone,
      // every click and subsequent confirm search must use that zone's canonical
      // safe center.
      const resolved = resolveExtraTargetCoordinates(row.probe, matchedAnchor);
      const evidenceReference = resolved.evidenceReference;
      const reference = resolved.clickReference;
      console.log(
        `装备对象优先级命中: ${matchedAnchor.name} Link PASS; ` +
        `模糊证据=(${Math.round(evidenceReference.x)},${Math.round(evidenceReference.y)}); ` +
        `固定点击=(${reference.x},${reference.y}); ` +
        `anchorDrift=${row.anchorDrift.toFixed(1)}`
      );
      return {
        kind: 'EXTRA_LINK',
        zoneName: matchedAnchor.name,
        reference,
        evidenceReference,
        extraProbes,
        centralProbe: null,
        source: 'REAL_LINK_FRAME_NEAR_EXTRA_ZONE_ANCHOR',
        clickPolicy: 'CANONICAL_KNOWN_ZONE_CENTER_AFTER_FUZZY_CLASSIFICATION'
      };
    }
  }

  if (requiredKind === 'EXTRA_LINK') {
    throw new Error('REQUIRED_EXTRA_LINK_EQUIP_CARRIER_NOT_FOUND');
  }

  const centralProbe = await probeCentralSelectable({ bridge, info, debugDir });
  console.log(
    `额外Link未命中；中央主怪兽区可装备检查: ` +
    `${centralProbe.accepted ? 'PASS' : 'NOT_CONFIRMED'}; ` +
    `yellowPixels=${centralProbe.yellow.estimatedYellowPixels}`
  );
  if (centralProbe.accepted) {
    return {
      kind: 'CENTRAL_MAIN',
      zoneName: CENTRAL_MAIN.name,
      reference: centralProbe.reference,
      evidenceReference: centralProbe.reference,
      extraProbes,
      centralProbe,
      source: 'CENTRAL_MAIN_SELECTABLE_YELLOW',
      clickPolicy: 'CANONICAL_KNOWN_ZONE_CENTER'
    };
  }

  throw new Error(
    `PREFERRED_EQUIP_CARRIER_NOT_FOUND:` +
    `extraLink=0;centralYellow=${centralProbe.yellow.estimatedYellowPixels};` +
    '规则=额外怪兽区Link优先，没有时只检查中央主怪兽区，不猜其它位置。'
  );
}

async function waitForEquipTargetSelectable({ bridge, info, chosen, debugDir }) {
  const reference = chosen && chosen.reference;
  if (!reference) throw new Error('EQUIP_TARGET_REFERENCE_REQUIRED');

  const roi = {
    x: Math.max(0, Math.round(reference.x - 115)),
    y: Math.max(0, Math.round(reference.y - 145)),
    width: 230,
    height: 290
  };
  const startedAt = Date.now();
  let stableFrames = 0;
  let lastYellow = 0;

  while (Date.now() - startedAt < TARGET_PROMPT_TIMEOUT_MS) {
    const image = await captureReferenceRoi(bridge, info, roi);
    const yellow = yellowUsableStats(image);
    lastYellow = Number(yellow && yellow.estimatedYellowPixels || 0);
    const selectable = lastYellow >= TARGET_SELECTABLE_YELLOW_MIN;
    stableFrames = selectable ? stableFrames + 1 : 0;

    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, 'equip_target_selectable_latest.png'));
      writeJson(path.join(debugDir, 'equip_target_selectable_latest.json'), {
        capturedAt: new Date().toISOString(),
        reference,
        roi,
        lastYellow,
        stableFrames,
        requiredStableFrames: TARGET_PROMPT_STABLE_FRAMES,
        threshold: TARGET_SELECTABLE_YELLOW_MIN
      });
    }

    if (stableFrames >= TARGET_PROMPT_STABLE_FRAMES) {
      console.log(
        `装备对象窗口稳定: PASS; zone=${chosen.zoneName}; yellow=${lastYellow}; ` +
        `stable=${stableFrames}/${TARGET_PROMPT_STABLE_FRAMES}`
      );
      return { roi, yellow, lastYellow, stableFrames };
    }
    await sleep(TARGET_PROMPT_POLL_MS);
  }

  throw new Error(
    `EQUIP_TARGET_PROMPT_NOT_STABLE:zone=${chosen.zoneName};yellow=${lastYellow};` +
    '未证明装备对象黄框稳定，禁止提前点击场上怪兽。'
  );
}

// PATCH_V5_ATOMIC_EQUIP_TIMING_V1
async function clickPreferredEquipCarrier({
  bridge,
  info,
  library,
  templates,
  debugDir,
  afterIdentityMs = 1000,
  requiredKind = null,
  label = '装备'
}) {
  const chosen = await choosePreferredEquipCarrier({ bridge, info, debugDir, requiredKind });
  // A Link blue frame exists before the equip prompt opens, so it is not proof
  // that the target is clickable.  Require the prompt-specific yellow target
  // highlight in two consecutive frames before sending the target click.
  const selectableProof = await waitForEquipTargetSelectable({
    bridge,
    info,
    chosen,
    debugDir
  });
  const physical = mapReferencePoint(info, chosen.reference);
  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 230);

  const recognized = await recognizeCurrent({ bridge, info, library, templates });
  const identityText = recognized.accepted
    ? `${recognized.name}[${recognized.id}] PASS`
    : `${chosen.zoneName}怪兽[IDENTITY_UNAVAILABLE]；保留真实区域+可选证据`;
  console.log(`${label}对象: ${chosen.zoneName}; ${identityText}`);

  // Selection is already made here. Keep the established discipline: after
  // identity/evidence is settled, pure wait before the separate blue-confirm step.
  await sleep(afterIdentityMs);

  const result = {
    ...chosen,
    clickReference: chosen.reference,
    recognized: recognized.accepted
      ? recognized
      : {
          accepted: false,
          id: chosen.kind === 'EXTRA_LINK' ? 'EXTRA_LINK' : 'CENTRAL_MONSTER',
          name: chosen.zoneName === '中央主怪兽区' ? '中央主怪兽区怪兽' : '额外怪兽区Link怪兽',
          mad: recognized.mad,
          margin: recognized.margin
        },
    rawRecognized: recognized,
    afterIdentityMs,
    selectableProof
  };

  if (debugDir) writeJson(path.join(debugDir, 'preferred_equip_carrier.json'), result);
  return result;
}

module.exports = {
  EXTRA_LINK_ANCHORS,
  CENTRAL_MAIN,
  canonicalExtraClickReference,
  resolveExtraTargetCoordinates,
  choosePreferredEquipCarrier,
  clickPreferredEquipCarrier
};
