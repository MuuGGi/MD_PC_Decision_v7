'use strict';

// Normalized foreground stencil of Master Duel's Activate star/tray glyph.
// Source: existing issue-141 ROI, icon bounds (110,78,84,46). No new image
// asset, live capture, OCR, or screenshot-dependent runtime file is needed.
const ACTIVATE_GLYPH = Object.freeze([
  '000000000010000000000',
  '000000000110000000000',
  '000000000110000000000',
  '000110000111000011000',
  '000111111111011110000',
  '000011111111111110000',
  '000011111111111110000',
  '000011111111111100000',
  '000011111111111110000',
  '111111111111111111111',
  '001110000000000111100',
  '000010111111111010000'
]);

function isGlyphYellow(r, g, b) {
  return r >= 145 && g >= 135 && b <= 145 && g - b >= 60 && r - b >= 60;
}

function verifyActivateGlyph(image, component) {
  return verifyActionGlyph(image, component, ACTIVATE_GLYPH, 'ACTIVATE_STAR_TRAY_STENCIL_V1');
}

const SPECIAL_SUMMON_GLYPH = Object.freeze([
  '11101101111110111', '11101101111110110', '01101101111110110', '01101111111111110',
  '00111111111111100', '00111111111111100', '00111111010111100', '00011111010111000',
  '00011111011111000', '00011111011100000', '00001111111110000', '00011000000010000',
  '00010000000011000', '00111111111111000', '00111111111111100', '00111111111111100'
]);

function verifySpecialSummonGlyph(image, component) {
  return verifyActionGlyph(image, component, SPECIAL_SUMMON_GLYPH, 'SPECIAL_SUMMON_TRAY_STENCIL_V1');
}

function verifyActionGlyph(image, component, stencil, detector) {
  if (!image || !image.data || !component || component.x < 0 || component.y < 0 ||
      component.x + component.width > image.width || component.y + component.height > image.height) {
    return { pass: false, reason: 'IMAGE_OR_GLYPH_BOUNDS_MISSING' };
  }
  let best = null;
  // One reference-pixel tolerance covers sample-step and render antialiasing;
  // this never searches outside the already bounded local icon candidate.
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      let intersection = 0, union = 0, background = 0, dark = 0;
      for (let y = 0; y < stencil.length; y++) {
        for (let x = 0; x < stencil[y].length; x++) {
          const px = Math.max(0, Math.min(image.width - 1,
            Math.floor(component.x + (x + 0.5) * component.width / stencil[y].length) + ox));
          const py = Math.max(0, Math.min(image.height - 1,
            Math.floor(component.y + (y + 0.5) * component.height / stencil.length) + oy));
          const i = (py * image.width + px) * 4;
          const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
          const expected = stencil[y][x] === '1';
          const actual = isGlyphYellow(r, g, b);
          if (actual && expected) intersection++;
          if (actual || expected) union++;
          if (!expected) { background++; if (Math.max(r, g, b) < 145) dark++; }
        }
      }
      const iou = intersection / Math.max(1, union);
      const darkBackgroundRatio = dark / Math.max(1, background);
      if (!best || iou > best.iou) best = { iou, darkBackgroundRatio, offsetX: ox, offsetY: oy };
    }
  }
  return { ...best, pass: best.iou >= 0.84 && best.darkBackgroundRatio >= 0.80,
    detector };
}

// Locations are relative to the *current measured hand click*, not desktop
// constants. The 70px paired tolerance includes the fan's horizontal shift
// after selection; the icon stencil, rather than yellow area, establishes role.
const HAND_MENU_LOCATIONS = Object.freeze([
  Object.freeze({ mode: 'ACTIVATE_LEFT_OF_SET', dx: -85, dy: -160, maxDx: 70, maxDy: 25 }),
  Object.freeze({ mode: 'ACTIVATE_ONLY_CENTERED', dx: 0, dy: -160, maxDx: 60, maxDy: 25 })
]);

function observePairedSetIcon(image, activate) {
  // Set's cyan swirl is about 175 reference pixels to Activate's right. The
  // legacy ROI clips the outer circle, so check only its observed icon core.
  const cx = activate.centerX + 175, cy = activate.centerY;
  let cyan = 0, dark = 0, total = 0;
  for (let y = Math.max(0, Math.round(cy - 35)); y < Math.min(image.height, cy + 35); y += 2) {
    for (let x = Math.max(0, Math.round(cx - 30)); x < Math.min(image.width, cx + 30); x += 2) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (b >= 130 && g >= 75 && b >= r + 45 && g >= r + 25) cyan++;
      if (Math.max(r, g, b) < 145) dark++;
      total++;
    }
  }
  return { visible: total >= 100 && cyan >= 35 && cyan / total >= 0.10 && dark / total >= 0.15,
    cyanPixels: cyan, samples: total, darkRatio: dark / Math.max(1, total),
    expectedLocal: { x: cx, y: cy } };
}

function locateHandActivateIcon(stats, roi, hand, image) {
  if (!hand || !Number.isFinite(hand.x) || !Number.isFinite(hand.y)) {
    throw new Error('EXEC_ACTIVATION_HAND_ANCHOR_MISSING');
  }
  const candidates = [];
  for (const component of stats.components || []) {
    if (!(component.x > 0 && component.y > 0 &&
        component.x + component.width < roi.width && component.y + component.height < roi.height &&
        component.estimatedPixels >= roi.minComponentPixels &&
        component.width >= 70 && component.width <= 105 &&
        component.height >= 34 && component.height <= 60 &&
        component.aspect >= 1.3 && component.aspect <= 2.5 && component.fillRatio >= 0.2)) continue;
    const reference = { x: roi.x + component.centerX, y: roi.y + component.centerY };
    const nearby = HAND_MENU_LOCATIONS.map(location => ({ ...location,
      expected: { x: hand.x + location.dx, y: hand.y + location.dy },
      dx: reference.x - (hand.x + location.dx), dy: reference.y - (hand.y + location.dy)
    })).filter(location => Math.abs(location.dx) <= location.maxDx && Math.abs(location.dy) <= location.maxDy)
      .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    if (!nearby.length) continue;
    const glyph = verifyActivateGlyph(image, component);
    if (!glyph.pass) continue;
    const pairedSet = observePairedSetIcon(image, component);
    const location = pairedSet.visible
      ? nearby.find(row => row.mode === 'ACTIVATE_LEFT_OF_SET')
      : nearby.find(row => row.mode === 'ACTIVATE_ONLY_CENTERED');
    if (!location) continue;
    candidates.push({ ...component, reference, expectedReference: location.expected,
      menuMode: location.mode, drift: Math.hypot(location.dx, location.dy), glyph, pairedSet });
  }
  // Multiple distinct verified action glyphs are an ambiguous scene, not a
  // contest in which the larger yellow component gets permission to click.
  candidates.sort((a, b) => a.drift - b.drift || b.glyph.iou - a.glyph.iou ||
    b.estimatedPixels - a.estimatedPixels);
  return { visible: candidates.length === 1, chosen: candidates.length === 1 ? candidates[0] : null,
    candidates, rejectionReason: candidates.length > 1 ? 'AMBIGUOUS_ACTIVATE_ICONS' :
      candidates.length === 0 ? 'EXPECTED_LOCAL_ACTIVATE_GLYPH_NOT_PROVEN' : null,
    detector: 'HAND_EXPECTED_LOCAL_ACTIVATE_GLYPH_V3' };
}

function locateFieldActivateIcon(image, stats, roi, expected) {
  // Field glyphs are yellow-green rather than the hand menu's yellow. The
  // legacy HSV mask misses them; isolate the local glyph colour and normalize
  // only the analysis mask. Original evidence and stencil pixels stay intact.
  const mask = { width: image.width, height: image.height, data: Buffer.alloc(image.data.length) };
  const ex = expected.x - roi.x, ey = expected.y - roi.y;
  for (let y = Math.max(0, Math.floor(ey - 75)); y < Math.min(image.height, ey + 75); y++) {
    for (let x = Math.max(0, Math.floor(ex - 70)); x < Math.min(image.width, ex + 70); x++) {
      const i = (y * image.width + x) * 4;
      if (isGlyphYellow(image.data[i], image.data[i + 1], image.data[i + 2])) {
        mask.data[i] = 235; mask.data[i + 1] = 230; mask.data[i + 2] = 50;
      }
    }
  }
  const localStats = require('../../lib/hand-state').yellowUsableStats(mask);
  const candidates = (localStats.components || []).filter(c =>
    c.x > 0 && c.y > 0 && c.x + c.width < image.width && c.y + c.height < image.height &&
    c.estimatedPixels >= 500 && c.width >= 70 && c.width <= 105 &&
    c.height >= 34 && c.height <= 60 && c.aspect >= 1.3 && c.aspect <= 2.5 &&
    Math.abs(roi.x + c.centerX - expected.x) <= 35 &&
    Math.abs(roi.y + c.centerY - expected.y) <= 50
  ).map(c => ({ ...c, glyph: verifyActivateGlyph(image, c),
    drift: Math.hypot(roi.x + c.centerX - expected.x, roi.y + c.centerY - expected.y) }))
    .filter(c => c.glyph.pass).sort((a, b) => a.drift - b.drift || b.glyph.iou - a.glyph.iou);
  return { chosen: candidates.length === 1 ? candidates[0] : null, candidates,
    expectedReference: expected, detector: 'FIELD_EXPECTED_LOCAL_ACTIVATE_GLYPH_V1' };
}

module.exports = { ACTIVATE_GLYPH, HAND_MENU_LOCATIONS, verifyActivateGlyph,
  verifySpecialSummonGlyph, observePairedSetIcon, locateHandActivateIcon, locateFieldActivateIcon };
