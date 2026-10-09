function assertSameSize(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`图像尺寸不同: A=${a.width}x${a.height}, B=${b.width}x${b.height}`);
  }
}

function rgbMad(a, b) {
  assertSameSize(a, b);
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (pixels * 3 * 255);
}

function rgbRmse(a, b) {
  assertSameSize(a, b);
  let sumSq = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i + 1] - b.data[i + 1];
    const db = a.data[i + 2] - b.data[i + 2];
    sumSq += dr * dr + dg * dg + db * db;
  }
  return Math.sqrt(sumSq / (pixels * 3)) / 255;
}

function grayAt(image, x, y) {
  const idx = (y * image.width + x) * 4;
  const r = image.data[idx];
  const g = image.data[idx + 1];
  const b = image.data[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function dHashBits(image) {
  const bits = [];
  for (let gy = 0; gy < 8; gy++) {
    const y = Math.min(image.height - 1, Math.floor((gy + 0.5) * image.height / 8));
    for (let gx = 0; gx < 8; gx++) {
      const x1 = Math.min(image.width - 1, Math.floor((gx + 0.5) * image.width / 9));
      const x2 = Math.min(image.width - 1, Math.floor((gx + 1.5) * image.width / 9));
      bits.push(grayAt(image, x1, y) < grayAt(image, x2, y) ? 1 : 0);
    }
  }
  return bits;
}

function hamming(a, b) {
  if (a.length !== b.length) throw new Error('hash长度不同');
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] !== b[i] ? 1 : 0;
  return d;
}

module.exports = { rgbMad, rgbRmse, dHashBits, hamming };
