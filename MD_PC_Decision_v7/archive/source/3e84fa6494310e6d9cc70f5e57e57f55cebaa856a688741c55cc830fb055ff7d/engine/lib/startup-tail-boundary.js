'use strict';
function rows(events) {
  const list=(events||[]).filter(e=>e && e.box && Number.isFinite(e.box.y) && e.card && e.card.id && e.card.id!=='UNKNOWN')
    .slice().sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
  const out=[];
  for(const e of list){let row=out[out.length-1];if(!row||Math.abs(e.box.y-row.y)>12){row={y:e.box.y,events:[]};out.push(row);}row.events.push(e);}
  return out.map(r=>({y:r.y,bottom:Math.max(...r.events.map(e=>e.box.y+e.box.height)),
    tokens:r.events.sort((a,b)=>a.box.x-b.box.x).map(e=>[e.type,e.side||'',e.card.id].join(':'))}));
}
function buildStartupTail(events) {
  const tail=rows(events).at(-1);
  if(!tail)throw new Error('STARTUP_TAIL_NOT_VISIBLE:末尾没有可靠卡牌结果，未建立基线');
  return {version:1,tokens:tail.tokens};
}
function buildMalletStartupTail(events) {
  // Called only after the user explicitly chose M11 at startup. Do not infer
  // the previous activation from a visible or clipped history header.
  const tail=rows(events).at(-1);
  if(!tail || !tail.tokens.length || !tail.tokens.every(t=>t.startsWith('HAND_GAIN:SELF:'))) {
    throw new Error('STARTUP_M11_FINAL_DRAW_NOT_PROVEN:末尾抽卡结果未读清');
  }
  return {version:1,sourceActivation:'M11',source:'USER_CONFIRMED',kind:'FINAL_DRAW_ROW',tokens:tail.tokens};
}
function matchStartupTail(saved,events,blocks) {
  const matches=rows(events).filter(r=>JSON.stringify(r.tokens)===JSON.stringify(saved.tokens));
  if(matches.length!==1)throw new Error('STARTUP_TAIL_NOT_UNIQUE:只核验当前末尾，不上滑追旧发动记录');
  const tail=matches[0];
  const newer=(blocks||[]).filter(b=>b.activation && b.activation.box && b.activation.box.y>=tail.bottom);
  if(!newer.length)throw new Error('STARTUP_TAIL_NO_NEW_ACTIVATION:末尾已确认，但尚无新增发动');
  return {newBlocks:newer,tokens:saved.tokens};
}
module.exports={buildStartupTail,buildMalletStartupTail,matchStartupTail};
