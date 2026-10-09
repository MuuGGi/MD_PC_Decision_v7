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
const { resolveObservedExtraZone } = require('./field-zone-geometry');
const {
  captureReferenceRoi,
  mapReferencePoint,
  sleep
} = require(path.join(ROOT, 'lib', 'win-fast'));
const {
  recognizeCurrentCard,
  saveRgbaPng
} = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));

// Execution-only transplant of the already validated R5/R6 passive Link-blue
// entry guard.  The frozen observer is not changed.  The resulting measured
// frame classifies a verified Extra Monster Zone; fuzzy frame centres are not
// click/confirm anchors. Only the confirmed zone's safe centre may be used.
const FIELD_ROI = { x: 280, y: 280, width: 1220, height: 460 };
const WINDOW = { width: 110, height: 150, stepX: 20, stepY: 20 };
const BLUE_RATIO_PASS = 0.10;
const TEXTURE_PASS = 14.0;
const ANCHOR_MAX_DRIFT = 180;


// Equip-target confirmation is not a fixed field coordinate. After a real
// monster card has been selected, Master Duel renders a blue/cyan confirm
// control above that selected physical card. Search only an anchor-relative
// region above the already-proven carrier and click the detected visual
// component itself.
// PATCH_V5_ATOMIC_EQUIP_TIMING_V1
const EQUIP_CONFIRM = {
  halfWidth: 150,
  topOffset: -230,
  bottomOffset: -60,
  minPixels: 250,
  minWidth: 40,
  maxWidth: 150,
  minHeight: 30,
  maxHeight: 140,
  timeoutMs: 6500,
  pollMs: 120
};

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function evaluateWindow(image, x0, y0, width, height) {
  let blue = 0;
  let total = 0;
  let textureSum = 0;
  let textureCount = 0;

  for (let y = y0; y < y0 + height; y += 2) {
    for (let x = x0; x < x0 + width; x += 2) {
      const [r, g, b] = pixelAt(image, x, y);
      if (b >= 90 && b >= r + 25 && b >= g + 12 && b >= r * 1.15) blue++;
      total++;

      if (x + 2 < x0 + width) {
        const [r2, g2, b2] = pixelAt(image, x + 2, y);
        const l1 = (r + g + b) / 3;
        const l2 = (r2 + g2 + b2) / 3;
        textureSum += Math.abs(l1 - l2);
        textureCount++;
      }
      if (y + 2 < y0 + height) {
        const [r2, g2, b2] = pixelAt(image, x, y + 2);
        const l1 = (r + g + b) / 3;
        const l2 = (r2 + g2 + b2) / 3;
        textureSum += Math.abs(l1 - l2);
        textureCount++;
      }
    }
  }

  return {
    x: x0,
    y: y0,
    width,
    height,
    centerX: x0 + width / 2,
    centerY: y0 + height / 2,
    blueRatio: total ? blue / total : 0,
    texture: textureCount ? textureSum / textureCount : 0
  };
}

function scoreWindow(row) {
  return Number(row.blueRatio || 0) * 100 + Number(row.texture || 0) * 0.025;
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function detectOwnLinkFrame(image, anchorReference = null) {
  const xStart = FIELD_ROI.x;
  const yStart = FIELD_ROI.y;
  const xEnd = Math.min(image.width, FIELD_ROI.x + FIELD_ROI.width);
  const yEnd = Math.min(image.height, FIELD_ROI.y + FIELD_ROI.height);
  const passing = [];
  let best = null;

  for (let y = yStart; y + WINDOW.height <= yEnd; y += WINDOW.stepY) {
    for (let x = xStart; x + WINDOW.width <= xEnd; x += WINDOW.stepX) {
      const row = evaluateWindow(image, x, y, WINDOW.width, WINDOW.height);
      if (!best || scoreWindow(row) > scoreWindow(best)) best = row;
      if (row.blueRatio >= BLUE_RATIO_PASS && row.texture >= TEXTURE_PASS) {
        passing.push(row);
      }
    }
  }

  let chosen = best;
  let anchorDrift = null;
  if (anchorReference && passing.length) {
    const ranked = passing
      .map(row => ({
        row,
        drift: distance(
          { x: row.centerX, y: row.centerY },
          anchorReference
        )
      }))
      .sort((a, b) => a.drift - b.drift || scoreWindow(b.row) - scoreWindow(a.row));
    if (ranked[0] && ranked[0].drift <= ANCHOR_MAX_DRIFT) {
      chosen = ranked[0].row;
      anchorDrift = ranked[0].drift;
    }
  }

  const visible = Boolean(
    chosen &&
    chosen.blueRatio >= BLUE_RATIO_PASS &&
    chosen.texture >= TEXTURE_PASS
  );

  return {
    visible,
    detector: 'EXEC_OWN_LINK_PHYSICAL_FRAME_V1',
    fieldRoi: FIELD_ROI,
    thresholds: {
      blueRatio: BLUE_RATIO_PASS,
      texture: TEXTURE_PASS,
      anchorMaxDrift: ANCHOR_MAX_DRIFT
    },
    anchorReference: anchorReference || null,
    anchorDrift,
    passingWindowCount: passing.length,
    best,
    chosen,
    referenceCenter: chosen
      ? { x: chosen.centerX, y: chosen.centerY }
      : null
  };
}


function isCyanConfirmPixel(r, g, b) {
  return (
    b >= 120 &&
    g >= 65 &&
    b >= r + 35 &&
    b >= g + 12
  );
}

function detectEquipConfirmButton(image, anchorReference) {
  if (!image || !anchorReference) {
    return {
      visible: false,
      detector: 'EXEC_EQUIP_CONFIRM_VISUAL_V1',
      reason: 'MISSING_IMAGE_OR_ANCHOR'
    };
  }

  const x0 = Math.max(0, Math.floor(anchorReference.x - EQUIP_CONFIRM.halfWidth));
  const x1 = Math.min(image.width, Math.ceil(anchorReference.x + EQUIP_CONFIRM.halfWidth));
  const y0 = Math.max(0, Math.floor(anchorReference.y + EQUIP_CONFIRM.topOffset));
  const y1 = Math.min(image.height, Math.ceil(anchorReference.y + EQUIP_CONFIRM.bottomOffset));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);

  if (!width || !height) {
    return {
      visible: false,
      detector: 'EXEC_EQUIP_CONFIRM_VISUAL_V1',
      roi: { x: x0, y: y0, width, height },
      reason: 'EMPTY_ROI'
    };
  }

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x0 + x;
      const py = y0 + y;
      const i = (py * image.width + px) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (isCyanConfirmPixel(r, g, b)) mask[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  const components = [];
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const start = sy * width + sx;
      if (!mask[start] || visited[start]) continue;

      let top = 0;
      stackX[top] = sx;
      stackY[top] = sy;
      top++;
      visited[start] = 1;

      let pixels = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let sumX = 0;
      let sumY = 0;

      while (top > 0) {
        top--;
        const x = stackX[top];
        const y = stackY[top];
        pixels++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (!mask[ni] || visited[ni]) continue;
            visited[ni] = 1;
            stackX[top] = nx;
            stackY[top] = ny;
            top++;
          }
        }
      }

      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      components.push({
        pixels,
        width: componentWidth,
        height: componentHeight,
        x: x0 + minX,
        y: y0 + minY,
        centerX: x0 + sumX / pixels,
        centerY: y0 + sumY / pixels
      });
    }
  }

  const passing = components
    .filter(component =>
      component.pixels >= EQUIP_CONFIRM.minPixels &&
      component.width >= EQUIP_CONFIRM.minWidth &&
      component.width <= EQUIP_CONFIRM.maxWidth &&
      component.height >= EQUIP_CONFIRM.minHeight &&
      component.height <= EQUIP_CONFIRM.maxHeight
    )
    .map(component => {
      const expectedY = anchorReference.y - 140;
      const drift = Math.hypot(
        component.centerX - anchorReference.x,
        component.centerY - expectedY
      );
      return {
        ...component,
        drift,
        score: -drift
      };
    })
    .filter(component => Math.abs(component.centerX - anchorReference.x) <= 50 &&
      Math.abs(component.centerY - (anchorReference.y - 140)) <= 50)
    .sort((a, b) => a.drift - b.drift || b.pixels - a.pixels);

  const nearest = passing[0] || null;
  const ambiguous = nearest && passing.some(component =>
    Math.hypot(component.centerX - nearest.centerX, component.centerY - nearest.centerY) > 25);
  const chosen = ambiguous ? null : nearest;
  return {
    visible: Boolean(chosen),
    detector: 'EXEC_EQUIP_CONFIRM_EXPECTED_LOCAL_V2',
    rejectionReason: ambiguous ? 'AMBIGUOUS_LOCAL_CONFIRM_CONTROLS' : chosen ? null : 'EXPECTED_CONFIRM_NOT_PROVEN',
    roi: { x: x0, y: y0, width, height },
    anchorReference,
    thresholds: { ...EQUIP_CONFIRM },
    componentCount: components.length,
    passingCount: passing.length,
    chosen,
    components: components
      .sort((a, b) => b.pixels - a.pixels)
      .slice(0, 12)
  };
}

async function clickObservedEquipConfirm(options) {
  const {
    bridge,
    info,
    anchorReference,
    debugDir,
    label = 'equip_target_confirm'
  } = options;

  if (!anchorReference) throw new Error('M19_EQUIP_CONFIRM_ANCHOR_REQUIRED');

  const startedAt = Date.now();
  let lastProbe = null;
  let attempt = 0;

  while (Date.now() - startedAt < EQUIP_CONFIRM.timeoutMs) {
    attempt++;
    const image = await captureReferenceRoi(bridge, info, {
      x: 0,
      y: 0,
      width: config.screen.width,
      height: config.screen.height
    });

    if (debugDir) {
      ensureDir(debugDir);
      saveRgbaPng(image, path.join(debugDir, `${label}_latest.png`));
    }

    const probe = detectEquipConfirmButton(image, anchorReference);
    lastProbe = probe;
    if (debugDir) {
      writeJson(path.join(debugDir, `${label}_latest.json`), {
        capturedAt: new Date().toISOString(),
        attempt,
        probe
      });
    }

    if (probe.visible && probe.chosen) {
      const reference = {
        x: probe.chosen.centerX,
        y: probe.chosen.centerY
      };
      const physical = mapReferencePoint(info, reference);
      await bridge.click(physical.x, physical.y);
      console.log(
        `妖刀装备确认按钮: PASS; detector=${probe.detector}; ` +
        `pixels=${probe.chosen.pixels}; ` +
        `reference=(${Math.round(reference.x)},${Math.round(reference.y)})`
      );
      return {
        detector: probe.detector,
        clickReference: reference,
        chosen: probe.chosen,
        roi: probe.roi,
        anchorReference,
        attempt
      };
    }

    await sleep(EQUIP_CONFIRM.pollMs);
  }

  throw new Error(
    `M19_EQUIP_CONFIRM_NOT_PROVEN:` +
    `visible=${Boolean(lastProbe && lastProbe.visible)};` +
    `passing=${lastProbe && lastProbe.passingCount || 0};` +
    '装备目标已经选中，只允许继续检测/点击确认按钮，禁止重新点击怪兽。'
  );
}

async function captureObservedOwnLink(options) {
  const {
    bridge,
    info,
    debugDir,
    label = 'own_link',
    anchorReference = null
  } = options;

  const image = await captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: config.screen.width,
    height: config.screen.height
  });

  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, `${label}.png`));
  }

  const probe = detectOwnLinkFrame(image, anchorReference);
  if (debugDir) writeJson(path.join(debugDir, `${label}.json`), probe);

  const chosen = probe.chosen || {};
  console.log(
    `已有Link真实卡框: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
    `center=(${Math.round(chosen.centerX || 0)},${Math.round(chosen.centerY || 0)}); ` +
    `blueRatio=${Number(chosen.blueRatio || 0).toFixed(3)}; ` +
    `texture=${Number(chosen.texture || 0).toFixed(2)}; ` +
    `anchorDrift=${probe.anchorDrift == null ? 'N/A' : probe.anchorDrift.toFixed(1)}`
  );

  return probe;
}


function isKnownLinkMonsterId(id) {
  return /^E(?:0[2-9]|10)$/.test(String(id || ''));
}

async function clickObservedOwnLinkTarget(options) {
  const {
    bridge,
    info,
    library,
    templates,
    anchorReference,
    debugDir,
    afterIdentityMs = 1000
  } = options;

  const promptProbe = await captureObservedOwnLink({
    bridge,
    info,
    debugDir,
    label: 'before_target_click',
    anchorReference
  });

  if (!promptProbe.visible || !promptProbe.referenceCenter) {
    throw new Error('M19_EQUIP_LINK_TARGET_FRAME_NOT_PROVEN');
  }

  const zoneProof = resolveObservedExtraZone(promptProbe.referenceCenter, anchorReference);
  const reference = zoneProof.clickReference;
  const physical = mapReferencePoint(info, reference);

  console.log(
    `妖刀装备目标：真实Link蓝框证明${zoneProof.zoneName}，点击已确认区域中心 ` +
    `reference=(${Math.round(reference.x)},${Math.round(reference.y)})；不点击模糊窗口中心。`
  );
  await bridge.click(physical.x, physical.y);
  await sleep(config.mouseSettleMs || 230);

  const raw = await recognizeCurrentCard(
    bridge,
    info,
    library,
    templates,
    { stableAcceptedSamples: 2 }
  );
  const recognized = normalizeRecognized(raw);

  console.log(
    `装备对象卡名精确认: ${recognized.name}[${recognized.id}] ` +
    `${recognized.accepted && isKnownLinkMonsterId(recognized.id) ? 'PASS' : 'FAIL'}`
  );

  if (!recognized.accepted || !isKnownLinkMonsterId(recognized.id)) {
    throw new Error(
      `M19_EQUIP_TARGET_IDENTITY_NOT_LINK:${recognized.name}[${recognized.id}];` +
      '目标已经点击，禁止改点其它怪兽。'
    );
  }

  // User hard rule: after the selected card identity is confirmed, wait about
  // 600 ms before any select/confirm action. This function stops after the
  // wait; the next D1 checkpoint separately detects the real blue confirm
  // control and is never allowed to re-click the already selected monster.
  await sleep(afterIdentityMs);

  const afterImage = await captureReferenceRoi(bridge, info, {
    x: 0,
    y: 0,
    width: config.screen.width,
    height: config.screen.height
  });
  if (debugDir) {
    saveRgbaPng(afterImage, path.join(debugDir, 'after_target_click_600ms.png'));
  }

  return {
    promptProbe,
    zoneProof,
    clickReference: reference,
    recognized,
    afterIdentityMs,
    policy: 'PROVEN_EXTRA_ZONE_CENTER_CLICK_THEN_IDENTITY_VERIFY_WAIT_THEN_CONFIRM_SEPARATELY'
  };
}

module.exports = {
  FIELD_ROI,
  EQUIP_CONFIRM,
  detectOwnLinkFrame,
  detectEquipConfirmButton,
  captureObservedOwnLink,
  clickObservedOwnLinkTarget,
  clickObservedEquipConfirm,
  isKnownLinkMonsterId
};
