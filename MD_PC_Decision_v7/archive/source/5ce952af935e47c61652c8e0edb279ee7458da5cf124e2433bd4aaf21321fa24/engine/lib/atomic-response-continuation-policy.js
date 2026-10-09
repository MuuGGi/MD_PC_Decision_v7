'use strict';

// A user-supplied "1" is a possible opponent-response boundary.  The main
// loop may automatically execute only these proven deterministic edges inside
// one response interval.  Card/route strategy still belongs to the normal
// decision layer, and any error stops the interval immediately.
const AUTO_CONTINUE_EDGES = Object.freeze(new Map([
  ['HORNET_TOKEN_READY>KAGARI_EFFECT_PENDING', 'Link Kagari -> activate Kagari effect'],
  ['Y1_LINK_RESOLVED_RECOVERY_PENDING>YOTO_LINK_RESOLVED', 'passive Link recovery -> activate Yoto effect'],
  ['M19_EQUIPPED>YOTO_LINK_RESOLVED', 'Yoto carrier Link -> activate Yoto grave effect'],
  ['M19_EQUIPPED>DUAL_OPTIONAL_PENDING', 'Yoto carrier Link -> build simultaneous optional chain'],
  ['M20_FIELD_EFFECT_ACTIVATED>M19_SELECTED_FROM_DECK', 'select deck Yoto -> finish its equip target'],
  ['RAYE_NORMAL_SUMMONED>E10_OPTIONAL_PENDING', 'Raye effect resolution -> activate landed Zeke effect'],
  ['RAYE_SECOND_MATERIAL_READY>E10_OPTIONAL_PENDING', 'existing Link + Raye double-Link -> activate landed Zeke effect'],
  ['RAYE_NORMAL_SUMMONED>DUAL_OPTIONAL_PENDING', 'Raye effect resolution -> build landed dual optional chain'],
  ['RAYE_E10_SELECTED_PENDING>E10_OPTIONAL_PENDING', 'submit recovered Zeke selection -> activate its effect'],
  ['RAYE_E10_SELECTED_PENDING>DUAL_OPTIONAL_PENDING', 'submit recovered Zeke selection -> build dual optional chain'],
  ['E10_OPTIONAL_PENDING>E10_TARGET_PROMPT', 'activate Zeke effect -> submit its activation target'],
  ['DUAL_OPTIONAL_PENDING>DUAL_M19_CL1_SELECTED', 'select Yoto CL1 -> continue building the same optional chain'],
  ['DUAL_M19_CL1_SELECTED>TRIPLE_M19_CL2_SELECTED', 'select the second Yoto -> continue the same three-effect chain'],
  ['TRIPLE_M19_CL2_SELECTED>DUAL_E10_TARGET_PROMPT', 'select Kagari CL3 -> submit its recovery target'],
  ['DUAL_M19_BAMBOO_PROMPT>TRIPLE_SECOND_BAMBOO_PROMPT', 'first Yoto resolution -> finish the second mandatory search'],
  ['DUAL_M19_CL1_SELECTED>DUAL_E10_TARGET_PROMPT', 'select the committed Zeke/Kagari CL2 -> submit its activation target'],
  ['DUAL_E10_TARGET_PROMPT>DUAL_M19_BAMBOO_PROMPT', 'finish optional-chain activation -> wait through response and reach Yoto resolution prompt']
]));

function atomicContinuationDecision(executedNode, nextNode) {
  const edge = `${String(executedNode || '')}>${String(nextNode || '')}`;
  const reason = AUTO_CONTINUE_EDGES.get(edge) || null;
  return {
    edge,
    autoContinue: Boolean(reason),
    reason,
    nextBoundaryReached: !reason
  };
}

module.exports = {
  AUTO_CONTINUE_EDGES,
  atomicContinuationDecision
};
