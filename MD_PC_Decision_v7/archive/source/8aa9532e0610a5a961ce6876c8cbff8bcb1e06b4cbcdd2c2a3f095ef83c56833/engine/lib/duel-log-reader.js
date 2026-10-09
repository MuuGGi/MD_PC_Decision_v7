'use strict';

const { cropImage } = require('./png-utils');
const { detectHandGainActionIcon } = require('./duel-log-action-icon');

function pixelMad(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    // Luminance comparison is tolerant of tiny colour shifts in the panel.
    const ay = (a.data[i] * 3 + a.data[i + 1] * 6 + a.data[i + 2]) / 10;
    const by = (b.data[i] * 3 + b.data[i + 1] * 6 + b.data[i + 2]) / 10;
    sum += Math.abs(ay - by);
  }
  return sum / (pixels * 255);
}

function findTemplate(image, template, searchRoi, options = {}) {
  const stepX = options.stepX || 1;
  const stepY = options.stepY || 1;
  let best = null;
  const maxX = searchRoi.x + searchRoi.width - template.width;
  const maxY = searchRoi.y + searchRoi.height - template.height;
  for (let y = searchRoi.y; y <= maxY; y += stepY) {
    for (let x = searchRoi.x; x <= maxX; x += stepX) {
      const sample = cropImage(image, { x, y, width: template.width, height: template.height });
      const mad = pixelMad(sample, template);
      if (!best || mad < best.mad) best = { x, y, mad };
    }
  }
  return best;
}

function activityStats(image, roi) {
  const crop = cropImage(image, roi);
  let activity = 0;
  let strongColour = 0;
  const total = crop.width * crop.height;
  for (let i = 0; i < crop.data.length; i += 4) {
    const r = crop.data[i];
    const g = crop.data[i + 1];
    const b = crop.data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const colour = max - min;
    if (max >= 100 && (colour >= 35 || (r + g + b) / 3 >= 145)) activity++;
    if (max >= 110 && colour >= 55) strongColour++;
  }
  return {
    activityPixels: activity,
    activityRatio: activity / total,
    strongColourPixels: strongColour,
    strongColourRatio: strongColour / total
  };
}

function framePixelRgb(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function isSpellFramePixel(image, x, y) {
  const [r, g, b] = framePixelRgb(image, x, y);
  return g > 75 && g - r > 28 && g - b > 8;
}

function isPurpleFramePixel(image, x, y) {
  const [r, g, b] = framePixelRgb(image, x, y);
  // Fusion/trap frames in the history use a muted purple border. Recognizing
  // them is required for graveyard follow-up effects such as Garura.
  return r > 95 && b > 105 && r - g > 28 && b - g > 35;
}

function isMonsterFramePixel(image, x, y) {
  const [r, g, b] = framePixelRgb(image, x, y);
  // Keep monster/link support bounded to strongly coloured frame pixels; the
  // final 47x60..75 geometry filter rejects ordinary panel text and icons.
  return r > 105 && g > 55 && r - g > 35 && g - b > 12;
}

function isLinkFramePixel(image, x, y) {
  const [r, g, b] = framePixelRgb(image, x, y);
  return b > 85 && b - r > 28 && b - g > 12;
}

function findFrameComponents(image, roi, isFramePixel) {
  const seen = new Uint8Array(image.width * image.height);
  const found = [];
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const start = y * image.width + x;
      if (seen[start] || !isFramePixel(image, x, y)) continue;
      let area = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const cy = Math.floor(p / image.width);
        const cx = p - cy * image.width;
        area++;
        minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < roi.x || nx >= roi.x + roi.width || ny < roi.y || ny >= roi.y + roi.height) continue;
            const np = ny * image.width + nx;
            if (!seen[np] && isFramePixel(image, nx, ny)) {
              seen[np] = 1;
              stack.push(np);
            }
          }
        }
      }
      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      if (area >= 300 && width >= 42 && width <= 54 && height >= 60 && height <= 75) {
        found.push({ x: minX, y: minY, width, height, area });
      }
    }
  }
  return found.sort((a, b) => a.y - b.y);
}

function findFaceUpCardComponents(image, roi) {
  const all = [
    isSpellFramePixel,
    isPurpleFramePixel,
    isMonsterFramePixel,
    isLinkFramePixel
  ].flatMap(predicate => findFrameComponents(image, roi, predicate));
  const unique = [];
  for (const component of all.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const cx = component.x + component.width / 2;
    const cy = component.y + component.height / 2;
    const duplicate = unique.some(other =>
      Math.abs(cx - (other.x + other.width / 2)) <= 4 &&
      Math.abs(cy - (other.y + other.height / 2)) <= 4
    );
    if (!duplicate) unique.push(component);
  }
  return unique;
}

function findCardBackComponents(image, roi) {
  const seen = new Uint8Array(image.width * image.height);
  const found = [];
  const isBack = (x, y) => {
    const i = (y * image.width + x) * 4;
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
    return r > 65 && r - g > 20 && r - b > 18;
  };
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const start = y * image.width + x;
      if (seen[start] || !isBack(x, y)) continue;
      let area = 0, minX = x, maxX = x, minY = y, maxY = y;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const cy = Math.floor(p / image.width), cx = p - cy * image.width;
        area++; minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < roi.x || nx >= roi.x + roi.width || ny < roi.y || ny >= roi.y + roi.height) continue;
          const np = ny * image.width + nx;
          if (!seen[np] && isBack(nx, ny)) { seen[np] = 1; stack.push(np); }
        }
      }
      const width = maxX - minX + 1, height = maxY - minY + 1;
      if (area >= 1000 && width >= 47 && width <= 56 && height >= 65 && height <= 80) {
        found.push({ x: minX, y: minY, width, height, area });
      }
    }
  }
  return found.sort((a, b) => a.y - b.y);
}

function ownerIconSide(image, component) {
  const centerX = Math.round(component.x + 84);
  const centerY = Math.round(component.y + component.height - 2);
  let red = 0;
  let blue = 0;
  for (let y = Math.max(0, centerY - 14); y <= Math.min(image.height - 1, centerY + 14); y++) {
    for (let x = Math.max(0, centerX - 14); x <= Math.min(image.width - 1, centerX + 14); x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i], b = image.data[i + 2];
      if (r > b + 25 && r > 80) red++;
      if (b > r + 25 && b > 80) blue++;
    }
  }
  if (red >= 20 && red > blue * 1.5) return 'OPPONENT';
  if (blue >= 20 && blue > red * 1.5) return 'SELF';
  return 'UNKNOWN';
}

function componentsOverlap(left, right) {
  return Math.abs((left.x + left.width / 2) - (right.x + right.width / 2)) <= 5 &&
    Math.abs((left.y + left.height / 2) - (right.y + right.height / 2)) <= 5;
}

function resizeNearest(image, width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
      const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
      const source = (sy * image.width + sx) * 4;
      const target = (y * width + x) * 4;
      image.data.copy(data, target, source, source + 4);
    }
  }
  return { width, height, data };
}

function colourMad(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
  }
  return sum / (pixels * 255);
}

function hsvHistogram(image) {
  const bins = new Float64Array(48);
  let samples = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i] / 255;
    const g = image.data[i + 1] / 255;
    const b = image.data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const saturation = max ? delta / max : 0;
    if (saturation < 0.15 || max < 0.12) continue;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    const hueBin = Math.min(11, Math.floor(hue / 30));
    const saturationBand = Math.min(1, Math.floor(saturation * 2));
    bins[saturationBand * 12 + hueBin]++;
    bins[24 + Math.min(23, Math.floor(max * 24))]++;
    samples++;
  }
  if (samples) for (let i = 0; i < bins.length; i++) bins[i] /= samples;
  return bins;
}

function histogramL1(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum;
}

function matchLogCardAtComponent(image, component, cardTemplates) {
  // The connected component describes the 47x67 green frame. Its artwork is
  // consistently inset by 4 px horizontally and 14 px from the top.
  const art = cropImage(image, {
    x: component.x + 4,
    y: component.y + 14,
    width: component.width - 8,
    height: Math.min(33, component.height - 18)
  });
  const query = resizeNearest(art, 126, 103);
  const queryHsv = hsvHistogram(art);
  const ranked = cardTemplates
    .map(card => {
      const rawMad = colourMad(query, card.image);
      const hsvDistance = histogramL1(queryHsv, hsvHistogram(card.image));
      return {
        id: card.id,
        name: card.name,
        mad: rawMad + hsvDistance * 0.12,
        rawMad,
        hsvDistance
      };
    })
    .sort((a, b) => a.mad - b.mad);
  return { best: ranked[0], second: ranked[1], ranked: ranked.slice(0, 3) };
}

function matchLogCard(image, component, cardTemplates, options = {}) {
  const original = matchLogCardAtComponent(image, component, cardTemplates);
  // A normal face-up score is NOT enough to counter a back-mask candidate.
  // The old early return prevented the canonical crop from being tried even
  // when the caller subsequently rejected that same score under the stricter gate.
  const proven = options.backCandidate ? reliableFaceUpMatchFromBackCandidate(original) : reliableFaceUpMatch(original);
  if (proven || component.width < 42 || component.width > 54 ||
      component.height < 60 || component.height > 75) return original;
  // A monster's artwork can itself form a coloured component (M04's sleeve
  // starts 14px below its real frame). Never treat that component as a frame.
  // Only a much stronger canonical-frame match in this SAME local card area
  // may replace the uncertain result; this does not relax identity thresholds.
  let best = null;
  for (let dy = -18; dy <= 2; dy += 2) for (const dx of [0, 2, -2]) {
    const box = { x: component.x + dx, y: component.y + dy, width: 47, height: 67 };
    if (box.x < 0 || box.y < 0 || box.x + 47 > image.width || box.y + 67 > image.height) continue;
    const match = matchLogCardAtComponent(image, box, cardTemplates);
    if (match.best.mad > 0.25 || match.second.mad - match.best.mad < 0.08 ||
        original.best.mad - match.best.mad < 0.10) continue;
    if (!best || match.best.mad < best.best.mad) best = { ...match, correctedBox: box };
  }
  return best || original;
}

function reliableFaceUpMatch(match) {
  if (!match || !match.best || !match.second) return false;
  return match.best.mad <= 0.48 && (match.second.mad - match.best.mad) >= 0.02;
}

function reliableFaceUpMatchFromBackCandidate(match) {
  // A pale/brown monster frame (notably the five Exodia pieces) can satisfy
  // the coarse red/brown card-back mask even though the log reveals its face.
  // Requiring a substantially stronger template score than the ordinary
  // face-up path keeps a genuine spiral card back unknown.  The opponent-draw
  // regression fixture scores about 0.43, while the misclassified face-up
  // Exodia piece scores about 0.27.
  return reliableFaceUpMatch(match) &&
    match.best.mad <= 0.32 &&
    match.best.hsvDistance <= 0.9;
}


function classifyFaceUpEventType(relativeX) {
  return relativeX < 52 ? 'ACTIVATE' : 'HAND_GAIN';
}

function recognizeVisibleCardEvents(image, rightPanel, startY, cardTemplates, actionIcons = null) {
  const roi = {
    x: rightPanel.x + 4,
    y: startY,
    width: rightPanel.width - 12,
    height: rightPanel.y + rightPanel.height - startY
  };
  const backComponents = findCardBackComponents(image, roi);
  const components = findFaceUpCardComponents(image, roi).filter(component => {
    const relativeX = component.x - rightPanel.x;
    // Full event cards occupy only the activation and hand-gain columns.
    // Small effect-processing thumbnails live at the far right and must not
    // be interpreted as new hand events even if their connected size grows.
    // A two-card draw (Trade-In/Allure) displays adjacent face-up results at
    // roughly panel x+70 and x+123. Keep both, while still excluding the tiny
    // far-right processing thumbnail around x+300.
    if (relativeX < 20 || relativeX > 150) return false;
    const overlappingBack = backComponents.find(back => componentsOverlap(component, back));
    return !(overlappingBack && ownerIconSide(image, overlappingBack) === 'OPPONENT');
  });
  const cards = components.map(component => ({
    component,
    match: matchLogCard(image, component, cardTemplates, {
      backCandidate: backComponents.some(back => componentsOverlap(component, back))
    }),
    overlappingBack: backComponents.some(back => componentsOverlap(component, back)),
    ownerSide: ownerIconSide(image, component),
    handGainIcon: detectHandGainActionIcon(image, component, actionIcons)
  })).filter(card => !card.overlappingBack || reliableFaceUpMatchFromBackCandidate(card.match));
  // The orange spiral can satisfy BOTH the monster-frame and card-back masks.
  // It must meet the same stronger face-up counterproof on either path; a
  // coarse face-up hit must not bypass the existing card-back identity guard.
  // Event order is chronological from top to bottom. The first full card after
  // Main1 is the activation source. In this labelled sample, the next full
  // card after its effect-processing row is the draw result.
  const events = cards.map(card => {
    const relativeX = card.component.x - rightPanel.x;
    const activationColumn = relativeX < 52;
    const iconConfirmedGain = Boolean(card.handGainIcon && card.handGainIcon.matched);
    return {
      // Keep the original proven geometry rule as the primary event grammar:
      // the left/top-level card column is always an ACTIVATE block. The blue
      // hand-gain icon is auxiliary evidence only and must never turn a
      // top-level activation card into a processing/gain row.
      type: classifyFaceUpEventType(relativeX),
      side: activationColumn
        ? 'SELF'
        : reliableFaceUpMatch(card.match)
          ? 'SELF'
          : iconConfirmedGain
            ? 'SELF'
            : card.ownerSide,
      card: reliableFaceUpMatch(card.match) ? card.match.best : { id: 'UNKNOWN', name: '卡图身份未确认', mad: null },
      confidenceMargin: card.match.second.mad - card.match.best.mad,
      top3: card.match.ranked,
      visibility: 'FACE_UP',
      sideEvidence: activationColumn
        ? 'SELF_ACTIVATION_COLUMN'
        : reliableFaceUpMatch(card.match)
          ? 'FACE_UP_RECOGNIZED'
          : iconConfirmedGain
            ? 'HAND_GAIN_ACTION_ICON_AUX'
            : 'OWNER_ICON_FALLBACK',
      actionEvidence: iconConfirmedGain ? 'HAND_GAIN_ACTION_ICON_AUX' : null,
      handGainIconMad: card.handGainIcon && Number.isFinite(card.handGainIcon.mad)
        ? card.handGainIcon.mad
        : null,
      box: card.match.correctedBox || card.component
    };
  });
  for (const component of backComponents) {
    const overlapsFaceUp = cards.some(faceUp => componentsOverlap(faceUp.component, component));
    if (overlapsFaceUp) continue;
    const handGainIcon = detectHandGainActionIcon(image, component, actionIcons);
    const faceUpCounterEvidence = matchLogCard(image, component, cardTemplates, { backCandidate: true });
    if (reliableFaceUpMatchFromBackCandidate(faceUpCounterEvidence)) {
      const activationColumn = component.x - rightPanel.x < 52;
      const iconConfirmedGain = Boolean(handGainIcon && handGainIcon.matched);
      events.push({
        type: classifyFaceUpEventType(component.x - rightPanel.x),
        side: 'SELF',
        card: faceUpCounterEvidence.best,
        confidenceMargin: faceUpCounterEvidence.second.mad - faceUpCounterEvidence.best.mad,
        top3: faceUpCounterEvidence.ranked,
        visibility: 'FACE_UP',
        sideEvidence: activationColumn
          ? 'SELF_ACTIVATION_COLUMN'
          : iconConfirmedGain
            ? 'HAND_GAIN_ACTION_ICON_AUX'
            : 'FACE_UP_TEMPLATE_OVERRIDES_BACK_MASK',
        actionEvidence: iconConfirmedGain ? 'HAND_GAIN_ACTION_ICON_AUX' : null,
        handGainIconMad: Number.isFinite(handGainIcon.mad) ? handGainIcon.mad : null,
        box: faceUpCounterEvidence.correctedBox || component
      });
      continue;
    }
    events.push({
      type: 'DRAW',
      side: handGainIcon.matched
        ? 'SELF'
        : ownerIconSide(image, component) === 'SELF' ? 'SELF' : 'OPPONENT',
      card: { id: 'UNKNOWN', name: '背面牌', mad: null },
      confidenceMargin: null,
      top3: [],
      visibility: 'CARD_BACK',
      sideEvidence: handGainIcon.matched ? 'HAND_GAIN_ACTION_ICON_AUX' : 'CARD_BACK_OWNER_ICON',
      actionEvidence: handGainIcon.matched ? 'HAND_GAIN_ACTION_ICON_AUX' : null,
      handGainIconMad: Number.isFinite(handGainIcon.mad) ? handGainIcon.mad : null,
      box: component
    });
  }
  return events.sort((a, b) => a.box.y - b.box.y);
}

function semanticEventsFromLabels(image, rightPanel, labels, cardTemplates) {
  const offsets = {
    ACTIVATE: { x: 28, y: 7 },
    LINK_SUMMON: { x: 28, y: 5 },
    TARGET: { x: 70, y: 70 },
    RETURN_TO_HAND: { x: 70, y: 11 }
  };
  return (labels || []).map(label => {
    if (label.type === 'SPECIAL_SUMMON' || label.type === 'DESTROY') {
      return {
        type: label.type,
        side: 'SELF',
        card: { id: 'TOKEN_SKY_STRIKER', name: '闪刀姬衍生物', mad: 0 },
        confidenceMargin: null,
        top3: [],
        source: 'SEMANTIC_LABEL',
        box: {
          x: rightPanel.x + label.x,
          y: rightPanel.y + label.y,
          width: label.width,
          height: label.height
        }
      };
    }
    const offset = offsets[label.type];
    if (!offset) return null;
    const component = {
      x: rightPanel.x + offset.x,
      y: rightPanel.y + label.y + offset.y,
      width: 47,
      height: 67,
      area: null
    };
    const match = matchLogCard(image, component, cardTemplates);
    return {
      type: label.type,
      side: 'SELF',
      card: match.best,
      confidenceMargin: match.second.mad - match.best.mad,
      top3: match.ranked,
      source: 'SEMANTIC_LABEL',
      label: { x: label.x, y: label.y, mad: label.mad },
      box: component
    };
  }).filter(Boolean).sort((a, b) => a.box.y - b.box.y);
}

function mergeSemanticEvents(visualEvents, semanticEvents) {
  const merged = [...(visualEvents || [])];
  for (const semantic of semanticEvents || []) {
    const index = merged.findIndex(event =>
      event.side === semantic.side &&
      Math.abs(event.box.y - semantic.box.y) <= 12 &&
      event.card && semantic.card &&
      String(event.card.id || event.card.name) === String(semantic.card.id || semantic.card.name)
    );
    if (index >= 0) merged[index] = semantic;
    else merged.push(semantic);
  }
  return merged.sort((a, b) => a.box.y - b.box.y);
}

function recognizeCardEventsAfterMain1(image, baseline, cardTemplates, actionIcons = null) {
  if (!baseline || baseline.status !== 'OK') return [];
  return recognizeVisibleCardEvents(
    image,
    baseline.rightPanel,
    baseline.match.y + 24,
    cardTemplates,
    actionIcons
  );
}

function recognizeMain1Baseline(image, main1Template) {
  if (image.width !== 2048 || image.height !== 1152) {
    throw new Error(`UNSUPPORTED_REFERENCE_SIZE: ${image.width}x${image.height}`);
  }
  const rightPanel = { x: 1674, y: 150, width: 348, height: 886 };
  const match = findTemplate(image, main1Template, {
    x: rightPanel.x,
    y: rightPanel.y,
    width: 190,
    height: rightPanel.height
  });
  const threshold = 0.08;
  const found = Boolean(match && match.mad <= threshold);
  if (!found) return { status: 'MAIN1_NOT_FOUND', match, rightPanel };

  const below = {
    x: rightPanel.x + 6,
    y: match.y + main1Template.height + 2,
    width: rightPanel.width - 24,
    height: Math.max(1, rightPanel.y + rightPanel.height - (match.y + main1Template.height + 8))
  };
  const activity = activityStats(image, below);
  // Blank log background contains faint scanlines, but essentially no strong
  // coloured/card pixels. Keep the threshold conservative for this first test.
  const emptyAfterMain1 = activity.activityRatio < 0.008 && activity.strongColourRatio < 0.003;
  return {
    status: 'OK',
    phase: 'MAIN1',
    match,
    rightPanel,
    below,
    activity,
    emptyAfterMain1
  };
}

module.exports = {
  pixelMad,
  findTemplate,
  activityStats,
  recognizeMain1Baseline,
  findFaceUpCardComponents,
  // Backward-compatible export for older local experiments.
  findSpellCardComponents: findFaceUpCardComponents,
  findCardBackComponents,
  reliableFaceUpMatch,
  reliableFaceUpMatchFromBackCandidate,
  ownerIconSide,
  componentsOverlap,
  resizeNearest,
  colourMad,
  matchLogCard,
  semanticEventsFromLabels,
  mergeSemanticEvents,
  classifyFaceUpEventType,
  recognizeVisibleCardEvents,
  recognizeCardEventsAfterMain1
};
