'use strict';

const { writeEvidenceJson: writeJson } = require('../../lib/runtime-files');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug', 'composite-route-live', 'preexisting-link-probe');
const RESULT_PATH = path.join(DEBUG_DIR, 'latest_result.json');

const { MdFastBridge, captureReferenceRoi, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { savePng } = require(path.join(ROOT, 'lib', 'png-utils'));

// Reference coordinates are the same 2048x1152 coordinate system used by the
// mature live observer.  This area covers our two Extra Monster Zones and our
// main Monster Zones, while excluding the spell/trap row, hand, phase button,
// and right-side UI.
const FIELD_ROI = { x: 280, y: 280, width: 1220, height: 460 };
const WINDOW = { width: 110, height: 150, stepX: 20, stepY: 20 };
const BLUE_RATIO_PASS = 0.10;
const TEXTURE_PASS = 14.0;

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function evaluateWindow(image, x0, y0, width, height) {
  let blue = 0;
  let total = 0;
  let textureSum = 0;
  let textureCount = 0;

  // step=2 is enough here; this is only an entry guard, not card identity.
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

function probeOwnLinkMonster(image) {
  const xStart = FIELD_ROI.x;
  const yStart = FIELD_ROI.y;
  const xEnd = Math.min(image.width, FIELD_ROI.x + FIELD_ROI.width);
  const yEnd = Math.min(image.height, FIELD_ROI.y + FIELD_ROI.height);
  let best = null;

  for (let y = yStart; y + WINDOW.height <= yEnd; y += WINDOW.stepY) {
    for (let x = xStart; x + WINDOW.width <= xEnd; x += WINDOW.stepX) {
      const row = evaluateWindow(image, x, y, WINDOW.width, WINDOW.height);
      if (!best || row.blueRatio > best.blueRatio ||
          (row.blueRatio === best.blueRatio && row.texture > best.texture)) {
        best = row;
      }
    }
  }

  const visible = Boolean(best && best.blueRatio >= BLUE_RATIO_PASS && best.texture >= TEXTURE_PASS);
  return {
    visible,
    detector: 'OWN_FIELD_LINK_BLUE_FRAME_V1',
    fieldRoi: FIELD_ROI,
    thresholds: { blueRatio: BLUE_RATIO_PASS, texture: TEXTURE_PASS },
    best
  };
}

async function main() {
  console.log('\n===== PREEXISTING OWN LINK MONSTER PASSIVE PROBE =====');
  console.log('只看我方额外怪兽区/怪兽区是否存在明显的Link蓝框怪兽；不点击、不读INFO、不滚轮、不改游戏状态。');
  console.log('这个检查只负责确认“第一步已经有场上Link怪兽”，不识别具体是哪张卡，也不会把后续Link素材卡图写死。');

  const bridge = new MdFastBridge();
  await bridge.start();
  try {
    await bridge.activateMasterDuel();
    await sleep(300);
    const info = await bridge.info();
    const title = String(info && info.title || '').toLowerCase();
    if (!title.includes('masterduel') && !title.includes('master duel')) {
      throw new Error(`MASTER_DUEL_WINDOW_NOT_FOUND_AFTER_ACTIVATE:${info && info.title || 'UNKNOWN'}`);
    }

    const screenshot = await captureReferenceRoi(bridge, info, {
      x: 0,
      y: 0,
      width: 2048,
      height: 1152
    });
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const screenshotPath = path.join(DEBUG_DIR, 'latest_client.png');
    await savePng(screenshot, screenshotPath);

    const probe = probeOwnLinkMonster(screenshot);
    const best = probe.best || {};
    console.log(
      `已有Link怪兽视觉守卫: ${probe.visible ? 'PASS' : 'NOT_CONFIRMED'}; ` +
      `blueRatio=${Number(best.blueRatio || 0).toFixed(3)}; texture=${Number(best.texture || 0).toFixed(2)}; ` +
      `bestCenter=(${Math.round(best.centerX || 0)},${Math.round(best.centerY || 0)})`
    );

    const result = {
      status: probe.visible ? 'PASS' : 'NOT_CONFIRMED',
      mode: 'PREEXISTING_OWN_LINK_MONSTER_PASSIVE',
      probe,
      screenshot: screenshotPath,
      capturedAt: new Date().toISOString()
    };
    writeJson(RESULT_PATH, result);
    process.exitCode = probe.visible ? 0 : 2;
  } finally {
    await bridge.stop().catch(() => {});
  }
}

main().catch(error => {
  console.error(`已有Link怪兽视觉守卫失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
