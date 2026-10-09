'use strict';

const config = require('../live-config');

function absoluteComponentEstimate(detected, options = {}) {
  if (!detected || !detected.componentEstimate) return null;
  const roi = options.roi || config.handFan.detectRoi;
  const includeY = options.includeY === true || detected.componentEstimate.purpose === 'CLICK_TARGET';
  return {
    ...detected.componentEstimate,
    components: detected.componentEstimate.components.map(component => ({
      ...component,
      x: component.x + roi.x,
      centerX: component.centerX + roi.x,
      ...(includeY && Number.isFinite(component.y) ? { y: component.y + roi.y } : {}),
      ...(includeY && Number.isFinite(component.centerY) ? { centerY: component.centerY + roi.y } : {})
    }))
  };
}

function componentCenters(detected, options = {}) {
  const estimate = absoluteComponentEstimate(detected, options);
  return estimate ? estimate.components.map(component => component.centerX) : [];
}

// One geometry/eligibility contract for public, exact-ordinal and Link/equip
// selection. Pure: the caller owns its existing reset/capture/identity check.
// detector injection keeps archived-production regressions honest.
function resolveMeasuredHandTarget(image, count, ordinal, options = {}) {
  const detector = options.detector || require('./hand-state');
  const layout = detector.getHandLayout(count);
  const detected = detector.detectHandCountFromImage(image, count, { purpose: 'CLICK_TARGET' });
  const estimate = absoluteComponentEstimate(detected);
  const exposed = detector.resolveExposedFanSlots(layout, estimate, { baselineCards: options.baselineCards });
  const slots = exposed.slots || [], target = slots[ordinal - 1];
  const measuredCenters = (estimate?.components || []).filter(c => c.title2D === true && Number.isFinite(c.centerY))
    .map(c => c.centerX).filter(Number.isFinite);
  const targetIsActuallyMeasured = Number.isFinite(target?.x) && measuredCenters.some(x => Math.abs(x - target.x) <= 4);
  const clickable = Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= count &&
    slots.length === count && String(exposed.source || '').startsWith('TITLE_COMPONENTS') &&
    targetIsActuallyMeasured && target?.measuredTitle2D === true && Number.isFinite(target.titleY);
  return { detected, estimate, exposed, target, clickable, source: exposed.source,
    titleCount: estimate?.count, measuredCenters, targetIsActuallyMeasured,
    resolvedCenters: slots.map(s => Math.round(s.x)).filter(Number.isFinite) };
}

module.exports = { absoluteComponentEstimate, componentCenters, resolveMeasuredHandTarget };
