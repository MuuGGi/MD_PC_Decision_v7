'use strict';

const assert = require('assert');
const {
  EXTRA_LINK_ANCHORS,
  CENTRAL_MAIN,
  resolveExtraTargetCoordinates
} = require('../core/preferred-equip-carrier');

const left = resolveExtraTargetCoordinates(
  { referenceCenter: { x: 835, y: 415 } },
  EXTRA_LINK_ANCHORS[0]
);
assert.deepStrictEqual(left.evidenceReference, { x: 835, y: 415 });
assert.deepStrictEqual(left.clickReference, { x: 835, y: 515 });
assert.notStrictEqual(left.evidenceReference, left.clickReference);

const right = resolveExtraTargetCoordinates(
  { referenceCenter: { x: 1213, y: 445 } },
  EXTRA_LINK_ANCHORS[1]
);
assert.deepStrictEqual(right.evidenceReference, { x: 1213, y: 445 });
assert.deepStrictEqual(right.clickReference, { x: 1213, y: 515 });

const exact = resolveExtraTargetCoordinates(
  { referenceCenter: { x: 835, y: 515 } },
  EXTRA_LINK_ANCHORS[0]
);
assert.deepStrictEqual(exact.clickReference, { x: 835, y: 515 });
assert.deepStrictEqual(CENTRAL_MAIN, { name: '中央主怪兽区', x: 1024, y: 700 });

assert.throws(
  () => resolveExtraTargetCoordinates(
    { referenceCenter: { x: 835, y: 415 } },
    { name: '未知区域', x: 1, y: 2 }
  ),
  /UNKNOWN_EXTRA_ZONE_ANCHOR/
);

console.log('PASS preferred-equip canonical click: fuzzy evidence never becomes action coordinate.');
