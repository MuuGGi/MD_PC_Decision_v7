'use strict';

// This is the mature candidate-center detector previously used by the
// dedicated execution/material dialog code.  Keep it execution-local in V2;
// the frozen observer is not modified.
function cardTextureScore(image, centerX) {
  let edgeSum = 0;
  let samples = 0;
  const left = Math.max(0, Math.round(centerX - 50));
  const right = Math.min(image.width - 2, Math.round(centerX + 50));
  const top = Math.max(0, 20);
  const bottom = Math.min(image.height - 1, 185);

  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x <= right; x += 2) {
      const offset = (y * image.width + x) * 4;
      const next = offset + 4;
      edgeSum += Math.abs(image.data[offset] - image.data[next]);
      edgeSum += Math.abs(image.data[offset + 1] - image.data[next + 1]);
      edgeSum += Math.abs(image.data[offset + 2] - image.data[next + 2]);
      samples++;
    }
  }
  return samples ? edgeSum / samples : 0;
}

function detectCenteredGrid(image, referenceRoi, candidateY) {
  const spacing = 158;
  const center = 1024 - referenceRoi.x;
  for (let count = 5; count >= 1; count--) {
    const first = center - ((count - 1) * spacing) / 2;
    const centers = Array.from({ length: count }, (_, index) => first + index * spacing);
    if (centers.every(x => cardTextureScore(image, x) >= 18)) {
      return centers.map(x => ({
        x: referenceRoi.x + Math.round(x),
        y: candidateY,
        width: 126
      }));
    }
  }
  return [];
}

function detectCandidateCenters(image, referenceRoi, candidateY, options = {}) {
  if (referenceRoi.width >= 700 && options.mode !== 'components') {
    return detectCenteredGrid(image, referenceRoi, candidateY);
  }

  const activeColumns = [];
  for (let x = 0; x < image.width; x++) {
    let brightSamples = 0;
    for (let y = 10; y < image.height - 10; y += 2) {
      const offset = (y * image.width + x) * 4;
      const brightness = (
        image.data[offset] +
        image.data[offset + 1] +
        image.data[offset + 2]
      ) / 3;
      if (brightness > 85) brightSamples++;
    }
    if (brightSamples >= 30) activeColumns.push(x);
  }

  const groups = [];
  for (const x of activeColumns) {
    const current = groups[groups.length - 1];
    if (!current || x > current.end + 2) groups.push({ start: x, end: x });
    else current.end = x;
  }

  const merged = [];
  for (const group of groups) {
    const current = merged[merged.length - 1];
    if (current && group.start - current.end <= 18) current.end = group.end;
    else merged.push({ start: group.start, end: group.end });
  }

  return merged
    .filter(group => group.end - group.start + 1 >= 60)
    .map(group => ({
      x: referenceRoi.x + Math.round((group.start + group.end) / 2),
      y: candidateY,
      width: group.end - group.start + 1
    }));
}

module.exports = { detectCandidateCenters };
