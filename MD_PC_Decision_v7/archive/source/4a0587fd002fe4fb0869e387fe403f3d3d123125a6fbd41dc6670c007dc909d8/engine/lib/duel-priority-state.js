'use strict';

// Reference-sized (2048x1152) field strips.  They avoid the hand, phase orb,
// right log and the central monster zones as much as possible, so one covered
// area does not erase the other votes.
const SELF_BLUE_ROIS = Object.freeze([
  { id: 'OWN_LEFT', x: 450, y: 650, width: 270, height: 250 },
  { id: 'OWN_MID_LEFT', x: 720, y: 650, width: 250, height: 250 },
  { id: 'OWN_MID_RIGHT', x: 1090, y: 650, width: 270, height: 250 },
  { id: 'OWN_RIGHT', x: 1360, y: 650, width: 190, height: 250 }
]);
const SELF_BLUE_CAPTURE_ROI = Object.freeze({ x: 450, y: 650, width: 1100, height: 250 });
// The actionable cue is the pale-blue floor wash/grid along the bottom of our
// field, not a blue monster/card frame.  Split that narrow floor strip into
// many horizontal cells and require the signal to be spatially distributed on
// both sides.  A compact blue card can therefore increase a local blue ratio
// without ever proving that we own priority.
const SELF_BLUE_GLOW_STRIP = Object.freeze({
  x: 450,
  y: 820,
  width: 1100,
  height: 80,
  columns: 12
});

function scaleRoiIntoCapture(roi, image, referenceCaptureRoi) {
  const capture = referenceCaptureRoi || { x: 0, y: 0, width: 2048, height: 1152 };
  const sx = image.width / capture.width;
  const sy = image.height / capture.height;
  return {
    ...roi,
    x: Math.max(0, Math.round((roi.x - capture.x) * sx)),
    y: Math.max(0, Math.round((roi.y - capture.y) * sy)),
    width: Math.max(1, Math.round(roi.width * sx)),
    height: Math.max(1, Math.round(roi.height * sy))
  };
}

function blueRatio(image, roi, stride = 2) {
  let hits = 0;
  let total = 0;
  const maxX = Math.min(image.width, roi.x + roi.width);
  const maxY = Math.min(image.height, roi.y + roi.height);
  for (let y = roi.y; y < maxY; y += stride) {
    for (let x = roi.x; x < maxX; x += stride) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      if (b >= 80 && b - r >= 18 && b - g >= 4) hits++;
      total++;
    }
  }
  return total > 0 ? hits / total : 0;
}

function distributedGlowEvidence(image, options = {}) {
  const source = SELF_BLUE_GLOW_STRIP;
  const strip = scaleRoiIntoCapture(source, image, options.referenceCaptureRoi);
  const columns = Number.isInteger(options.glowColumns) ? options.glowColumns : source.columns;
  const minColumnRatio = Number.isFinite(options.minGlowColumnRatio)
    ? options.minGlowColumnRatio
    : 0.025;
  const minPassingColumns = Number.isInteger(options.minGlowPassingColumns)
    ? options.minGlowPassingColumns
    : 6;
  const minEdgeColumns = Number.isInteger(options.minGlowEdgeColumns)
    ? options.minGlowEdgeColumns
    : 2;
  const stride = options.stride || 2;
  const columnSamples = [];
  for (let index = 0; index < columns; index++) {
    const startX = strip.x + Math.floor(strip.width * index / columns);
    const endX = strip.x + Math.floor(strip.width * (index + 1) / columns);
    const roi = {
      x: startX,
      y: strip.y,
      width: Math.max(1, endX - startX),
      height: strip.height
    };
    const ratio = blueRatio(image, roi, stride);
    columnSamples.push({ index, ratio, pass: ratio >= minColumnRatio, roi });
  }
  const passingColumns = columnSamples.filter(sample => sample.pass).length;
  const edgeWidth = Math.min(3, Math.floor(columns / 2));
  const leftEdgePassing = columnSamples.slice(0, edgeWidth).filter(sample => sample.pass).length;
  const rightEdgePassing = columnSamples.slice(-edgeWidth).filter(sample => sample.pass).length;
  const bilateral = leftEdgePassing >= minEdgeColumns && rightEdgePassing >= minEdgeColumns;
  return {
    pass: passingColumns >= minPassingColumns && bilateral,
    passingColumns,
    requiredPassingColumns: minPassingColumns,
    leftEdgePassing,
    rightEdgePassing,
    requiredEdgeColumns: minEdgeColumns,
    minColumnRatio,
    columnSamples,
    roi: strip
  };
}

function glowBackedOuterAgreement(leftRatio, rightRatio, bottomGlow, options = {}) {
  const minRatio = Number.isFinite(options.minGlowBackedOuterRatio)
    ? options.minGlowBackedOuterRatio
    : 0.03;
  return Boolean(
    bottomGlow && bottomGlow.pass &&
    Number(leftRatio || 0) >= minRatio &&
    Number(rightRatio || 0) >= minRatio
  );
}

function classifyDuelPriorityState(image, options = {}) {
  if (!image || !image.data || !image.width || !image.height) {
    throw new Error('DUEL_PRIORITY_IMAGE_INVALID');
  }
  const minRoiRatio = Number.isFinite(options.minRoiRatio) ? options.minRoiRatio : 0.035;
  const minVotes = Number.isInteger(options.minVotes) ? options.minVotes : 3;
  const samples = SELF_BLUE_ROIS.map(source => {
    const roi = scaleRoiIntoCapture(source, image, options.referenceCaptureRoi);
    const ratio = blueRatio(image, roi, options.stride || 2);
    return { id: source.id, ratio, pass: ratio >= minRoiRatio, roi };
  });
  const votes = samples.filter(sample => sample.pass).length;
  const ordered = samples.map(sample => sample.ratio).sort((a, b) => a - b);
  const median = (ordered[1] + ordered[2]) / 2;
  const left = samples.find(sample => sample.id === 'OWN_LEFT');
  const right = samples.find(sample => sample.id === 'OWN_RIGHT');
  const bottomGlow = distributedGlowEvidence(image, options);
  // A centered selection/effect modal can cover both middle strips while the
  // blue priority wash remains clearly visible on the two outer field edges.
  // Accept that exact bilateral pattern; a one-sided blue animation is still
  // insufficient.  Outside modal coverage we retain the stricter 3-of-4 vote.
  const outerEdgeAgreement = Boolean(left && left.pass && right && right.pass);
  // A large centered optional-effect modal can also shave a tiny amount from
  // one broad outer ROI even though the dedicated floor strip still proves a
  // bilateral, horizontally distributed blue wash.  Permit a narrowly relaxed
  // 0.03 outer ratio only after that strict bottom-glow proof has passed.  The
  // compact-blue-card regression still fails because it has no distributed
  // floor glow, and one-sided blue remains insufficient.
  const glowBackedOuterEdgeAgreement = glowBackedOuterAgreement(
    left && left.ratio,
    right && right.ratio,
    bottomGlow,
    options
  );
  const broadBlueAgreement =
    (votes >= minVotes && median >= minRoiRatio) ||
    outerEdgeAgreement ||
    glowBackedOuterEdgeAgreement;
  // broadBlueAgreement remains useful against animation/noise, but it is no
  // longer sufficient: the bottom floor glow must also be horizontally
  // distributed.  This explicitly rejects blue monsters and compact cards.
  const selfPriority = broadBlueAgreement && bottomGlow.pass;
  return {
    // Keep the established state value for compatibility with saved evidence
    // and callers; detector identifies the stricter proof now used.
    state: selfPriority ? 'SELF_PRIORITY_BLUE' : 'UNKNOWN_NOT_PROVEN',
    detector: 'BOTTOM_BLUE_GLOW_DISTRIBUTED_V2',
    safeForRecognitionAndControl: selfPriority,
    votes,
    requiredVotes: minVotes,
    medianBlueRatio: median,
    outerEdgeAgreement,
    glowBackedOuterEdgeAgreement,
    broadBlueAgreement,
    bottomGlow,
    samples,
    redOpponentPriority: 'UNCALIBRATED_NO_MATERIAL'
  };
}

module.exports = {
  SELF_BLUE_ROIS,
  SELF_BLUE_CAPTURE_ROI,
  SELF_BLUE_GLOW_STRIP,
  distributedGlowEvidence,
  glowBackedOuterAgreement,
  classifyDuelPriorityState
};
