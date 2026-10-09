'use strict';

// Reference geometry is valid only under the existing verified 2048x1152
// client mapping. Sliding colour windows establish a zone, not a click point.
const EXTRA_LINK_ANCHORS = Object.freeze([
  Object.freeze({ name: '左额外怪兽区', x: 835, y: 515 }),
  Object.freeze({ name: '右额外怪兽区', x: 1213, y: 515 })
]);
const EXTRA_ANCHOR_MAX_DRIFT = 180;

function resolveObservedExtraZone(reference, anchorHint = null) {
  if (!reference || !Number.isFinite(reference.x) || !Number.isFinite(reference.y)) {
    throw new Error('EXTRA_LINK_EVIDENCE_REFERENCE_REQUIRED');
  }
  const nearest = point => EXTRA_LINK_ANCHORS.map(anchor => ({ anchor,
    drift: Math.hypot(point.x - anchor.x, point.y - anchor.y) }))
    .sort((a, b) => a.drift - b.drift)[0];
  const matched = nearest(reference);
  if (matched.drift > EXTRA_ANCHOR_MAX_DRIFT) throw new Error('LINK_FRAME_NOT_IN_EXTRA_MONSTER_ZONE');
  if (anchorHint) {
    const expected = nearest(anchorHint);
    if (expected.drift > EXTRA_ANCHOR_MAX_DRIFT || expected.anchor.name !== matched.anchor.name) {
      throw new Error('LINK_FRAME_EXTRA_ZONE_ANCHOR_MISMATCH');
    }
  }
  return { evidenceReference: { ...reference }, anchorDrift: matched.drift,
    clickReference: { x: matched.anchor.x, y: matched.anchor.y }, zoneName: matched.anchor.name };
}

module.exports = { EXTRA_LINK_ANCHORS, EXTRA_ANCHOR_MAX_DRIFT, resolveObservedExtraZone };
