'use strict';
// Decision-only fixtures declare their own hand and used counts. Never read the
// current duel's on-disk ledger while evaluating a different hypothetical hand.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const filename = path.resolve(__dirname, '../../lib/decision-engine.js');
const nativeRequire = createRequire(filename);
const context = vm.createContext({ module: { exports: {} }, console,
  require: id => id === './main-deck-ledger' ? {
    getSharedDeckState(library, cards, runtime) {
      const outsideDeckCounts = { ...(runtime.usedCounts || {}) };
      for (const card of cards) if (card.id) outsideDeckCounts[card.id] = (outsideDeckCounts[card.id] || 0) + 1;
      const deckRemaining = Object.fromEntries(library.cards.filter(c => /^M\d+$/.test(c.id))
        .map(c => [c.id, Math.max(0, c.count - (outsideDeckCounts[c.id] || 0))]));
      return { deckRemaining, outsideDeckCounts, ledger: { outsideDeckCounts },
        unknownExodiaOutsideCount: outsideDeckCounts.EXODIA_UNKNOWN || 0 };
    }
  } : nativeRequire(id) });
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
module.exports = { collectActions: (...args) => structuredClone(context.module.exports.collectActions(...args)) };
