const fs = require('fs');
const { PNG } = require('pngjs');

function readPng(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('error', reject)
      .pipe(new PNG())
      .on('parsed', function () {
        resolve({
          width: this.width,
          height: this.height,
          data: Buffer.from(this.data)
        });
      })
      .on('error', reject);
  });
}

function cropImage(image, roi) {
  const { x, y, width, height } = roi;
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    throw new Error(`ROI越界: image=${image.width}x${image.height}, roi=${JSON.stringify(roi)}`);
  }
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * image.width + x) * 4;
    const srcEnd = srcStart + width * 4;
    const dstStart = row * width * 4;
    image.data.copy(out, dstStart, srcStart, srcEnd);
  }
  return { width, height, data: out };
}

function savePng(image, filePath) {
  return new Promise((resolve, reject) => {
    const png = new PNG({ width: image.width, height: image.height });
    image.data.copy(png.data);
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    png.pack().pipe(stream);
  });
}

module.exports = { readPng, cropImage, savePng };
