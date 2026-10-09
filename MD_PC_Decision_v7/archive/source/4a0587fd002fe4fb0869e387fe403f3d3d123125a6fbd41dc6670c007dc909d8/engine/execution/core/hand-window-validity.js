'use strict';
// Existing DENSE bridge marker; clearing it forces mature edge verification.
function invalidateHandWindow(bridge) {
  if (bridge) bridge.__mdDenseHandWindow = null;
}
module.exports = { invalidateHandWindow };
