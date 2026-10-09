'use strict';
// Same blue-diamond geometry as the proven M11 recovery detector. Coordinates
// are card centres, NOT click centres (the latter are 22 px higher for M17).
function selectedCardBadge(image, ref, roi) {
  const cx = Math.round(ref.x + 38 - roi.x), cy = Math.round(ref.y - 58 - roi.y);
  if (cx < 30 || cy < 30 || cx + 30 >= image.width || cy + 30 >= image.height) return { pass: false };
  let blue = 0, white = 0, dark = 0, inner = 0;
  const quadrants = [0, 0, 0, 0];
  for (let dy = -30; dy <= 30; dy++) for (let dx = -30; dx <= 30; dx++) {
    const distance = Math.abs(dx) + Math.abs(dy), i = ((cy + dy) * image.width + cx + dx) * 4;
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
    if (distance >= 20 && distance <= 29 && b > 120 && b > r + 50 && g > 60) {
      blue++; quadrants[(dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0)]++;
    }
    if (distance <= 19) { inner++; if (Math.min(r, g, b) > 180) white++; if (Math.max(r, g, b) < 86) dark++; }
  }
  const darkRatio = inner ? dark / inner : 0;
  return { pass: blue >= 200 && quadrants.every(n => n >= 30) && white >= 30 && darkRatio >= 0.5,
    blue, white, darkRatio, quadrants };
}
// Selecting a search card dims every other candidate. Prove the archived
// pre-selection card artwork at each physical centre under a brightness gain;
// never interpret dimmed candidates as removed from the Deck.
function provePreservedCandidateLayout(current, previous, points, roi) {
  if (current.width !== previous.width || current.height !== previous.height || !points.length) return { pass: false };
  const rows = points.map(point => {
    const cx = Math.round(point.x - roi.x), cy = Math.round(point.y - roi.y);
    if (cx < 48 || cx + 48 >= current.width || cy < 60 || cy + 70 >= current.height) return { pass: false };
    let product = 0, squares = 0, samples = 0;
    for (let y = cy - 60; y < cy + 70; y += 2) for (let x = cx - 46; x < cx + 46; x += 2) {
      const i = (y * current.width + x) * 4;
      for (let c = 0; c < 3; c++) { product += previous.data[i + c] * current.data[i + c]; squares += previous.data[i + c] ** 2; samples++; }
    }
    const gain = squares ? product / squares : 0;
    let error = 0;
    for (let y = cy - 60; y < cy + 70; y += 2) for (let x = cx - 46; x < cx + 46; x += 2) {
      const i = (y * current.width + x) * 4;
      for (let c = 0; c < 3; c++) error += Math.abs(previous.data[i + c] * gain - current.data[i + c]);
    }
    const mad = error / Math.max(1, samples) / 255;
    return { pass: gain >= 0.32 && gain <= 1.15 && mad <= 0.065, x: point.x, gain, mad };
  });
  return { pass: rows.every(row => row.pass), rows };
}
module.exports = { selectedCardBadge, provePreservedCandidateLayout };
