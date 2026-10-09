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

module.exports = { absoluteComponentEstimate, componentCenters };
