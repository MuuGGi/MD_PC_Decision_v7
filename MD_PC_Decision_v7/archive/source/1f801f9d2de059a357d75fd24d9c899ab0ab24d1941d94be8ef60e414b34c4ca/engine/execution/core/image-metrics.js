'use strict';

function imageDarkRatio(image, threshold) {
  if (!image || !image.data || !image.width || !image.height) return 0;
  let dark = 0;
  let total = 0;
  for (let i = 0; i + 3 < image.data.length; i += 4) {
    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    if (Math.max(r, g, b) < threshold) dark += 1;
    total += 1;
  }
  return total ? dark / total : 0;
}

function sampledMad(a, b, step = 8) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const offset = (y * a.width + x) * 4;
      sum += Math.abs(a.data[offset] - b.data[offset]);
      sum += Math.abs(a.data[offset + 1] - b.data[offset + 1]);
      sum += Math.abs(a.data[offset + 2] - b.data[offset + 2]);
      count += 3;
    }
  }
  return count ? sum / count / 255 : Infinity;
}

module.exports = {
  imageDarkRatio,
  sampledMad
};
