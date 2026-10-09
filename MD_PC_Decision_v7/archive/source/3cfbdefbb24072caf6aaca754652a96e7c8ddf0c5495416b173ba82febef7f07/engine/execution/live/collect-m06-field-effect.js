'use strict';

// Material collection only. Never invokes game input or changes observer state.
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const ROOT = path.resolve(__dirname, '..', '..');
const { MdFastBridge, captureReferenceRoi, sleep } = require('../../lib/win-fast');
const { validateMasterDuelClient } = require('../../lib/live-client-guard');
const { cropImage } = require('../../lib/png-utils');
const { saveRgbaPng } = require('../../runtime/observer/scan-state');
const { detectCandidateCenters } = require('../core/prompt-candidate-centers');

const STAGES = [
  ['01_field_ready', '保持刚通招成功的零衣在场，不装刀，正常场面。'],
  ['02_raye_action_buttons', '手动点击场上零衣，显示动作按钮；先不要点发动。'],
  ['03_extra_candidates', '手动点零衣的发动效果，等额外怪兽候选窗口稳定；先不要选卡。'],
  ['04_extra_selected', '选择本次要召唤的怪兽（优先本路线的零梦，游戏未提供则选可用目标）；先不要确认。'],
  ['05_summon_result', '手动确认并等待召唤完成；如另有位置/表示形式窗口，先停住，使用 X 补拍。出现后续效果询问时不要处理。']
];
const ROIS = {
  field: { x: 570, y: 350, width: 950, height: 530 },
  candidates: { x: 630, y: 810, width: 790, height: 230 },
  submit: { x: 850, y: 1045, width: 520, height: 100 },
  detail: { x: 0, y: 100, width: 370, height: 850 }
};

async function main() {
  if (process.versions.node !== '20.11.1') throw new Error(`NODE_VERSION_MISMATCH:${process.versions.node}`);
  const dir = path.join(ROOT, 'debug', 'execution', 'M06_field_effect_materials', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { mode: 'MANUAL_MATERIAL_COLLECTION', status: 'IN_PROGRESS', nodes: [] };
  const persist = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const bridge = new MdFastBridge();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let serial = 0;
  async function capture(label) {
    console.log('5秒后截一张图：请切回游戏，保留当前窗口。');
    await sleep(5000);
    const info = await bridge.info();
    validateMasterDuelClient(info, { requireTitle: true });
    const image = await captureReferenceRoi(bridge, info, { x: 0, y: 0, width: 2048, height: 1152 });
    const stem = `${String(++serial).padStart(3, '0')}_${label}`;
    saveRgbaPng(image, path.join(dir, `${stem}_full.png`));
    const crops = {};
    for (const [name, roi] of Object.entries(ROIS)) {
      crops[name] = cropImage(image, roi);
      saveRgbaPng(crops[name], path.join(dir, `${stem}_${name}.png`));
    }
    const points = detectCandidateCenters(crops.candidates, ROIS.candidates, 925, { mode: 'components' });
    manifest.nodes.push({ label, stem, capturedAt: new Date().toISOString(), candidateProposals: points, note: 'Candidate proposals only; no card identity or route PASS asserted.' });
    persist();
    console.log(`已保存 ${stem}。切回终端继续。`);
  }
  try {
    await bridge.start();
    console.log('零衣场上效果：分步素材采集。游戏动作由你完成，脚本不点击、不按键、不读INFO、不运行observer。');
    console.log(`素材目录：${dir}`);
    persist();
    for (const [label, instruction] of STAGES) {
      console.log(`\n${label}: ${instruction}`);
      let captured = false;
      while (true) {
        const answer = (await rl.question('Enter=5秒后采当前节点；X=补拍中间窗口；N=下一节点；Q=结束：')).trim().toUpperCase();
        if (answer === 'Q') { manifest.status = 'PARTIAL'; return; }
        if (answer === 'N') {
          if (!captured) { console.log('当前节点尚未采集，请先按Enter。'); continue; }
          break;
        }
        if (answer !== '' && answer !== 'X') continue;
        try {
          await capture(answer === 'X' ? `${label}_intermediate` : label);
          if (answer === '') captured = true;
        } catch (error) {
          console.log(`本次未完成：${error.message}。保持游戏现场，重新采集即可。`);
        }
      }
    }
    manifest.status = 'COLLECTED_NOT_EXECUTION_PASS';
    console.log('采集结束。保留后续效果窗口，将上面的素材目录压缩发回；本轮不标记操作PASS。');
  } finally {
    persist();
    rl.close();
    await bridge.stop().catch(() => {});
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { STAGES, ROIS };
