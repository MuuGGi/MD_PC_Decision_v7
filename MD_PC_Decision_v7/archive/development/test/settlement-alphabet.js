'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');
const settlement = require('../../../engine/execution/core/duel-settlement');
const { cropImage } = require('../../../engine/lib/png-utils');
const { withStrictReadOnly } = require('../../../src/runtime/shadow');
const ROOT = path.resolve(__dirname, '../../..');
const bankFile = path.join(ROOT, 'engine/templates/ui/settlement-glyph-bank.json');
const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
const panelFile = path.join(ROOT, bank.entries[0].proof.imagePath);
const sha = file => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let cases = 0;
function check(name, fn) { fn(); cases++; console.log('V7_SETTLEMENT_ALPHABET PASS ' + name); }
function render(text, templates) {
  const out = new PNG({ width: 70, height: 40 });
  for (let n = 0; n < text.length; n++) {
    const row = templates.find(t => t.digit === Number(text[n]));
    assert(row, 'test must have an actual same-font template');
    for (let y = 0; y < 18; y++) for (let x = 0; x < 13; x++) {
      const sx = Math.min(27, Math.ceil(x * 28 / 13)), sy = y * 2;
      if (!row.data[sy * 28 + sx]) continue;
      const i = ((y + 11) * out.width + 10 + n * 17 + x) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 255; out.data[i + 3] = 255;
    }
  }
  return out;
}
async function run() {
  await withStrictReadOnly(async () => {
    const templates = settlement.loadSettlementDigitTemplates();
    const panel = PNG.sync.read(fs.readFileSync(panelFile));
    const evidenceBefore = sha(panelFile);
    check('actual saved reward 82 is read only from verified settlement font', () => {
      assert.equal(evidenceBefore, bank.entries[0].proof.imageSha256);
      const result = settlement.recognizeSettlementGemRewards(panel);
      assert.equal(result.pass, true); assert.equal(result.total, 82);
      assert(result.rewards[0].count.digits.every(d => d.source === 'SETTLEMENT_VERIFIED' && !d.legacyFallback));
      assert.equal(result.rewards[0].count.digits[1].confidence, 1);
    });
    check('without the missing same-font class, actual 82 stays unknown rather than INFO fallback', () => {
      const count = cropImage(panel, bank.entries[0].proof.countRoi);
      const old = settlement.recognizeGemCount(count, templates.filter(t => t.digit !== 2));
      assert.equal(old.pass, false); assert(old.digits.some(d => d.unsupportedCompetitor?.digit === 2));
      assert(old.digits.every(d => d.legacyFallback === null));
    });
    check('alphabet reports actual supported classes and leaves 3 explicitly unsupported', () => {
      const coverage = settlement.describeSettlementDigitCoverage(templates);
      assert.deepEqual(coverage.supportedDigits, [0, 1, 2, 4, 5, 6, 7, 8, 9]);
      assert.deepEqual(coverage.missingDigits, [3]);
    });
    for (const [file, roi, value] of [
      ['duel-settlement-01-gems-79.png', { x: 1004, y: 364, width: 70, height: 40 }, 79],
      ['duel-settlement-02-gems-94.png', { x: 1004, y: 364, width: 70, height: 40 }, 94],
      ['duel-settlement-03-gems-106-plus-10.png', { x: 84, y: 124, width: 70, height: 40 }, 106],
      ['duel-settlement-03-gems-106-plus-10.png', { x: 192, y: 124, width: 70, height: 40 }, 10],
      ['duel-settlement-04-gems-108-plus-10.png', { x: 84, y: 124, width: 70, height: 40 }, 108],
      ['duel-settlement-05-gems-115-plus-15.png', { x: 84, y: 124, width: 70, height: 40 }, 115],
      ['duel-settlement-05-gems-115-plus-15.png', { x: 192, y: 124, width: 70, height: 40 }, 15]
    ]) check('existing calibrated same-font value unchanged: ' + value, () => {
      const full = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'engine/material/verified', file)));
      const result = settlement.recognizeGemCount(cropImage(full, roi), templates);
      assert.equal(result.pass, true); assert.equal(result.value, value);
    });
    for (const text of ['12', '24', '52', '82', '92', '222']) check('shared classifier uses digit 2 outside its source number: ' + text, () => {
      const result = settlement.recognizeGemCount(render(text, templates), templates);
      assert.equal(result.pass, true, JSON.stringify(result)); assert.equal(result.value, Number(text));
    });
    check('nearby unsupported INFO glyph cannot authorize reward identity', () => {
      const infoFile = path.join(ROOT, 'engine/templates/ui/hand_count_info_3.png');
      const png = PNG.sync.read(fs.readFileSync(infoFile));
      const data = Uint8Array.from({ length: png.width * png.height }, (_, i) => png.data[i * 4] > 127 ? 1 : 0);
      assert.equal(settlement.recognizeGemCount(render('3', [{ digit: 3, data }]), templates).pass, false);
    });
    check('unverified provenance, wrong font and corrupt feature data fail closed', () => {
      for (const alter of [
        b => { b.font = 'HAND_COUNT'; }, b => { b.entries[0].verified = false; },
        b => { b.entries[0].proof.kind = 'GUESS'; }, b => { b.entries[0].proof.text = '89'; },
        b => { b.entries[0].data = b.entries[0].data.slice(1); },
        b => { b.entries[0].data = (b.entries[0].data[0] === '0' ? '1' : '0') + b.entries[0].data.slice(1); },
        b => { b.entries[0].proof.imageSha256 = ''; }
      ]) { const copy = JSON.parse(JSON.stringify(bank)); alter(copy); assert.throws(() =>
        settlement.parseVerifiedSettlementGlyphBank(copy), /SETTLEMENT_GLYPH_BANK_/); }
    });
    check('no slot or count evidence remains unknown; historical evidence is unchanged', () => {
      const blank = new PNG({ width: 530, height: 710 });
      assert.equal(settlement.recognizeSettlementGemRewards(blank).pass, false);
      assert.equal(sha(panelFile), evidenceBefore);
    });
  });
  console.log('V7_SETTLEMENT_ALPHABET_PASS; cases=' + cases + '; inputs=0; businessWrites=0; evidenceUnchanged=true');
}
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { run };
