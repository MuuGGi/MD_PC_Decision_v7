'use strict';

const fs = require('fs');
const path = require('path');
const {readJsonIfExistsSafe: readJsonIfExists, writeEvidenceJson: writeJson} = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeRecognized } = require(path.join(
  ROOT,
  'execution',
  'core',
  'recognition-result'
));

const { captureReferenceRoi, mapReferencePoint, sleep } = require(path.join(ROOT, 'lib', 'win-fast'));
const { activateAndVerifyMasterDuel } = require(path.join(ROOT, 'lib', 'md-foreground'));
const { recognizeCurrentCard, saveRgbaPng } = require(path.join(ROOT, 'runtime', 'observer', 'scan-state'));
const { choosePreferredEquipCarrier, CENTRAL_MAIN } = require(path.join(
  ROOT,
  'execution',
  'core',
  'preferred-equip-carrier'
));
const config = require(path.join(ROOT, 'live-config'));

function assertSupportedNode() {
  const actual = String(process.versions.node || '');
  if (actual !== '20.11.1') {
    throw new Error(`NODE_VERSION_MISMATCH:${actual || 'UNKNOWN'};本测试固定要求 Node v20.11.1。`);
  }
  console.log('Node运行时: v20.11.1 PASS');
}

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createCheckpointReader() {
  return readline.createInterface({ input, output });
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function activateGameAndGetInfo(bridge) {
  const activation = await activateAndVerifyMasterDuel(bridge);
  return activation.info;
}

async function saveNode(bridge, info, attemptDir, label, extra = null) {
  const dir = path.join(attemptDir, 'nodes');
  ensureDir(dir);
  const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
  saveRgbaPng(image, path.join(dir, `${label}.png`));
  writeJson(path.join(dir, `${label}.json`), {
    capturedAt: new Date().toISOString(),
    label,
    extra
  });
  console.log(`节点已保存: ${label}`);
}

async function checkpoint(rl, { prompt, bridge, attemptDir, label, extra = null }) {
  let retry = 0;
  while (true) {
    const answer = String(await ask(rl, prompt)).trim().toUpperCase();
    if (answer === 'Q') return 'QUIT';
    if (answer === 'R') {
      retry++;
      const info = await activateGameAndGetInfo(bridge);
      await saveNode(bridge, info, attemptDir, `${label}_R${retry}`, extra);
      console.log('R只重拍当前节点，不向游戏发送其它输入。');
      continue;
    }
    if (!answer) return 'ENTER';
    console.log('只接受 Enter / R / Q。');
  }
}

function runNodeFromRoot(script, args = []) {
  console.log(`\n===== ${script}${args.length ? ` ${args.join(' ')}` : ''} =====`);
  const out = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`${script} 运行失败，exit=${out.status || 1}`);
}


async function clickRequiredCentralEquipTarget({
  bridge,
  info,
  library,
  templates,
  debugDir,
  label = '装备',
  afterIdentityMs = 600
}) {
  // choosePreferredEquipCarrier 本身先检查两个额外怪兽区 Link，再检查中央主怪兽区。
  // 本测试要求明确命中 CENTRAL_MAIN；如果额外区 Link 存在，会在任何目标点击之前直接失败。
  const chosen = await choosePreferredEquipCarrier({ bridge, info, debugDir });
  if (!chosen || chosen.kind !== 'CENTRAL_MAIN') {
    throw new Error(
      `FIRST_BATCH_CENTRAL_TARGET_NOT_SELECTED:${chosen && chosen.kind || 'NONE'};` +
      '本分支只验证“没有额外区Link时回退中央主怪兽区”，因此不允许继续点击其它目标。'
    );
  }

  const physical = mapReferencePoint(info, chosen.reference);
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
    `${label}中央装备对象: ${recognized.accepted ? `${recognized.name}[${recognized.id}] PASS` : '卡名未精确认'}; ` +
    `reference=(${Math.round(chosen.reference.x)},${Math.round(chosen.reference.y)})`
  );

  await sleep(afterIdentityMs);
  const result = {
    ...chosen,
    clickReference: chosen.reference,
    recognized: recognized.accepted
      ? recognized
      : {
          accepted: false,
          id: 'CENTRAL_MONSTER',
          name: '中央主怪兽区怪兽',
          mad: recognized.mad,
          margin: recognized.margin
        },
    rawRecognized: recognized,
    afterIdentityMs
  };
  if (debugDir) writeJson(path.join(debugDir, 'required_central_equip_target.json'), result);
  return result;
}

function latestPass(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const rows = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(rootDir, entry.name);
      const resultPath = path.join(dir, 'result.json');
      const result = readJsonIfExists(resultPath);
      if (!result || result.status !== 'PASS_CANDIDATE') return null;
      const stat = fs.statSync(resultPath);
      return { dir, resultPath, result, mtimeMs: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows[0] || null;
}

function flattenLogBlocks(log) {
  const lists = [
    log && log.newOperationBlocks,
    log && log.extendedOperationBlocks,
    log && log.operationBlocks,
    log && log.newActivationBlocks,
    log && log.activationBlocks
  ];
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const block of list) {
      const fp = `${block && block.activationKey || ''}|${block && block.signature || ''}|${block && block.index || ''}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(block);
    }
  }
  return out;
}

function yellowPixel(r, g, b) {
  // 与 live-config.usableMagic 同一套 HSV 门限，但这里直接做局部像素探针，
  // 目标是得到“真实黄色可选高亮”的物理质心，而不是固定怪兽区坐标。
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * (((b - r) / d) + 2);
    else h = 60 * (((r - g) / d) + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = (max / 255) * 100;
  const u = config.usableMagic;
  return h >= u.yellowHueMin && h <= u.yellowHueMax && s >= u.yellowSatMin && v >= u.yellowValMin;
}

async function probeCentralSelectableMaterial({ bridge, info, debugDir, label = 'central_second_material' }) {
  const roi = {
    x: CENTRAL_MAIN.x - 115,
    y: CENTRAL_MAIN.y - 120,
    width: 230,
    height: 240
  };
  const image = await captureReferenceRoi(bridge, info, roi);
  if (debugDir) {
    ensureDir(debugDir);
    saveRgbaPng(image, path.join(debugDir, `${label}.png`));
  }

  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4;
      if (!yellowPixel(image.data[i], image.data[i + 1], image.data[i + 2])) continue;
      count += 4;
      sumX += x * 4;
      sumY += y * 4;
    }
  }

  const accepted = count >= 450;
  const reference = accepted
    ? { x: roi.x + sumX / count, y: roi.y + sumY / count }
    : null;
  const proof = { accepted, estimatedYellowPixels: count, roi, reference };
  if (debugDir) writeJson(path.join(debugDir, `${label}.json`), proof);
  return proof;
}

async function clickCentralSelectableMaterial({ bridge, info, debugDir, label = 'central_second_material' }) {
  const proof = await probeCentralSelectableMaterial({ bridge, info, debugDir, label });
  if (!proof.accepted || !proof.reference) {
    throw new Error(
      `DOUBLE_LINK_CENTRAL_SECOND_MATERIAL_NOT_PROVEN:yellow=${proof.estimatedYellowPixels};` +
      '第二素材必须由当前素材窗口真实黄色高亮证明，不使用理论slot。'
    );
  }
  const physical = mapReferencePoint(info, proof.reference);
  await bridge.click(physical.x, physical.y);
  await sleep(600);
  console.log(
    `双素材第二素材: 中央主怪兽区真实黄色高亮 PASS; yellow=${proof.estimatedYellowPixels}; ` +
    `reference=(${Math.round(proof.reference.x)},${Math.round(proof.reference.y)})`
  );
  return { ...proof, clickReference: proof.reference, afterClickWaitMs: 600 };
}

module.exports = {
  ROOT,
  assertSupportedNode,
  ensureDir,
  writeJson,
  readJsonIfExists,
  copyIfExists,
  timestampId,
  createCheckpointReader,
  activateGameAndGetInfo,
  saveNode,
  checkpoint,
  runNodeFromRoot,
  clickRequiredCentralEquipTarget,
  latestPass,
  flattenLogBlocks,
  probeCentralSelectableMaterial,
  clickCentralSelectableMaterial,
  sleep
};
