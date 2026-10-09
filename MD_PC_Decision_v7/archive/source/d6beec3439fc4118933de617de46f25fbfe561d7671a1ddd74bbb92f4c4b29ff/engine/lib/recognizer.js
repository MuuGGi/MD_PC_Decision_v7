const fs = require('fs');
const path = require('path');
const { readPng, cropImage } = require('./png-utils');
const { rgbMad, rgbRmse, dHashBits, hamming } = require('./metrics');

function loadLibrary(rootDir) {
  const dbPath = path.join(rootDir, 'card-library.json');
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

async function loadTemplates(rootDir, library) {
  const cache = [];
  for (const card of library.cards) {
    const image = await readPng(path.join(rootDir, card.template));
    cache.push({
      card,
      image,
      dhash: dHashBits(image)
    });
  }
  return cache;
}

function extractCardRoi(image, library) {
  const roi = library.template_roi;
  if (image.width === roi.width && image.height === roi.height) {
    return image;
  }
  if (image.width === library.screen.width && image.height === library.screen.height) {
    return cropImage(image, roi);
  }
  throw new Error(
    `不支持的输入尺寸 ${image.width}x${image.height}。` +
    `请使用完整PC截图 ${library.screen.width}x${library.screen.height}，` +
    `或纯卡图ROI ${roi.width}x${roi.height}。`
  );
}

function rankQuery(query, templateCache) {
  const qHash = dHashBits(query);
  const ranked = templateCache.map(t => ({
    id: t.card.id,
    name: t.card.name,
    count: t.card.count,
    mad: rgbMad(query, t.image),
    rmse: rgbRmse(query, t.image),
    dhash: hamming(qHash, t.dhash)
  }));
  ranked.sort((a, b) => a.mad - b.mad || a.rmse - b.rmse || a.dhash - b.dhash);
  return ranked;
}

function classify(ranked, opts = {}) {
  const best = ranked[0];
  const second = ranked[1];
  const maxMad = (opts.maxMad !== undefined && opts.maxMad !== null) ? opts.maxMad : 0.060;
  const minMargin = (opts.minMargin !== undefined && opts.minMargin !== null) ? opts.minMargin : 0.030;
  const margin = second ? second.mad - best.mad : Infinity;
  const accepted = best.mad <= maxMad && margin >= minMargin;
  return { accepted, best, second, margin, maxMad, minMargin };
}

module.exports = { loadLibrary, loadTemplates, extractCardRoi, rankQuery, classify };
