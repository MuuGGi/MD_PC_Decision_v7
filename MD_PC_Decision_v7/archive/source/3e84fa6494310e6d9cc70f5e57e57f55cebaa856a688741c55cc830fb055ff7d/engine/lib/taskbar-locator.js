'use strict';

function locateTemplate(image, template, searchRoi) {
  let best = null;
  const maxX = Math.min(image.width - template.width, searchRoi.x + searchRoi.width - template.width);
  const maxY = Math.min(image.height - template.height, searchRoi.y + searchRoi.height - template.height);

  for (let y = searchRoi.y; y <= maxY; y++) {
    for (let x = searchRoi.x; x <= maxX; x++) {
      let sum = 0;
      let count = 0;
      for (let ty = 0; ty < template.height; ty += 2) {
        for (let tx = 0; tx < template.width; tx += 2) {
          const sourceOffset = ((y + ty) * image.width + x + tx) * 4;
          const templateOffset = (ty * template.width + tx) * 4;
          sum += Math.abs(image.data[sourceOffset] - template.data[templateOffset]);
          sum += Math.abs(image.data[sourceOffset + 1] - template.data[templateOffset + 1]);
          sum += Math.abs(image.data[sourceOffset + 2] - template.data[templateOffset + 2]);
          count += 3;
        }
      }
      const mad = sum / count / 255;
      if (!best || mad < best.mad) {
        best = {
          x,
          y,
          centerX: x + Math.round(template.width / 2),
          centerY: y + Math.round(template.height / 2),
          mad
        };
      }
    }
  }
  return best;
}

module.exports = { locateTemplate };
