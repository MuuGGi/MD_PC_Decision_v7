'use strict';
const path=require('path');
function paths(root){return{root,main:path.join(root,'runtime','main-v6.js'),atomic:path.join(root,'execution','core','atomic-route-executor.js'),composite:path.join(root,'lib','composite-route-observer.js'),ledger:path.join(root,'lib','main-deck-ledger.js'),duelLog:path.join(root,'debug','duel-log-live','latest_result.json'),observerState:path.join(root,'debug','duel-log-live','observer_state.json'),hand:path.join(root,'debug','hand-change-live','session_state.json'),decision:path.join(root,'decision-state.json'),library:path.join(root,'card-library.json')};}
module.exports={paths};
