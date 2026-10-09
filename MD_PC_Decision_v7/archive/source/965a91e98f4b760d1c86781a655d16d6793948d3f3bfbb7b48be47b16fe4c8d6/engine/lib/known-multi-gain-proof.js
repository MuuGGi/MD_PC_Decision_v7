'use strict';

// A chain's results are printed after its last activation header. Only the
// already-selected M19(CL1)/E10 or E02(CL2) pair may use this tail proof.
function proveKnownMultiGainBlocks(blocks, gains) {
  const rows = Array.isArray(gains) ? gains : [];
  const all = Array.isArray(blocks) ? blocks : [];
  const handRows = block => (block.details || []).filter(d =>
    d && String(d.role || d.rawType || '').includes('HAND_GAIN'));
  const kagari = rows.find(row => row.activationKey === 'E02');
  if (kagari && rows.length === 3) {
    if (kagari.id !== 'M17' || kagari.fromDeck !== false || rows[0] !== kagari ||
        rows[1].activationKey !== 'M19' || rows[1].id !== 'M20' || rows[1].fromDeck !== true ||
        rows[2].activationKey !== 'M19' || rows[2].id !== 'M14' || rows[2].fromDeck !== true) return { pass: false };
    const tail = all.slice(-3);
    if (tail.length !== 3 || tail[0].activationKey !== 'M19' || tail[1].activationKey !== 'M19' ||
        tail[2].activationKey !== 'E02') return { pass: false };
    const actual = handRows(tail[2]).slice().sort((a, b) => a.box?.y - b.box?.y);
    if (handRows(tail[0]).length === 0 && handRows(tail[1]).length === 0 && actual.length === 3 &&
        actual.every((d, i) => d.side === 'SELF' && d.card?.id === rows[i].id &&
          (i === 0 || actual[i - 1].box?.y < d.box?.y))) {
      return { pass: true, mode: 'PROVEN_TWO_M19_KAGARI_CL3_RESOLUTION_TAIL' };
    }
    // Separate resolution rows must each be unique in the current three
    // activation blocks, with no extra/opponent gain smuggled into them.
    const printed = tail.flatMap(handRows);
    if (printed.length === 3 && rows.every(row => tail.filter(block =>
      block.activationKey === row.activationKey && handRows(block).some(d =>
        d.side === 'SELF' && d.card?.id === row.id)).length === 1)) {
      return { pass: true, mode: 'EXACT_TWO_M19_KAGARI_GAINS' };
    }
    return { pass: false };
  }
  if (kagari && (rows.length !== 2 || kagari.id !== 'M17' || kagari.fromDeck !== false ||
      !rows.some(row => row.activationKey === 'M19' && ['M14', 'M20'].includes(row.id) && row.fromDeck === true))) {
    return { pass: false };
  }
  if (rows.length >= 2 && rows.every(row => all.filter(block =>
    block.activationKey === row.activationKey && handRows(block).some(d =>
      d.card && d.card.id === row.id && (!kagari || d.side === 'SELF'))).length === 1)) {
    return { pass: true, mode: 'EXACT_ACTIVATION_GAINS' };
  }
  const zero = rows.find(row => row.activationKey === 'E10' || row.activationKey === 'E02');
  const bamboo = rows.find(row => row.activationKey === 'M19');
  if (rows.length !== 2 || !zero || !bamboo ||
      !['M17', 'M22'].includes(zero.id) || !['M14', 'M20'].includes(bamboo.id) ||
      (zero.activationKey === 'E02' && (zero.id !== 'M17' || zero.fromDeck !== false))) return { pass: false };
  const tail = all.slice(-2);
  if (tail.length !== 2 || tail[0].activationKey !== 'M19' || tail[1].activationKey !== zero.activationKey ||
      handRows(tail[0]).length !== 0) return { pass: false };
  const actual = handRows(tail[1]);
  if (actual.length !== 2 || actual.some(d => d.side !== 'SELF') ||
      actual[0].card?.id !== zero.id || actual[1].card?.id !== bamboo.id ||
      !(actual[0].box?.y < actual[1].box?.y)) return { pass: false };
  return { pass: true, mode: `PROVEN_M19_CL1_${zero.activationKey}_CL2_RESOLUTION_TAIL` };
}

module.exports = { proveKnownMultiGainBlocks };
