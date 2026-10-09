'use strict';
const path=require('path');
const {readPng,cropImage}=require('./png-utils');
const {findLabelMatches}=require('./duel-log-label-reader');
const {findFaceUpCardComponents,matchLogCard,reliableFaceUpMatch}=require('./duel-log-reader');
const SPECS=[
  {type:'SEND_TO_GRAVEYARD',label:'send_label',x:144,source:'field_icon',sx:92,sy:37,destination:'grave_icon',dx:200,dy:37},
  {type:'DESTROY',label:'destroy_label',x:144,source:'field_icon',sx:92,sy:37,destination:'grave_icon',dx:200,dy:37},
  {type:'LINK_SUMMON',label:'link_label',x:126,source:'extra_icon',sx:92,sy:39,destination:'summoned_field_icon',dx:200,dy:39}
];
async function loadFieldRowTemplates(root){const out={};for(const name of new Set(SPECS.flatMap(s=>[s.label,s.source,s.destination])))out[name]=await readPng(path.join(root,'templates/ui/field-log',name+'.png'));return out;}
function mad(a,b){let d=0;for(let i=0;i<a.data.length;i+=4)for(let k=0;k<3;k++)d+=Math.abs(a.data[i+k]-b.data[i+k]);return d/(a.width*a.height*3*255);}
function matchIcon(image,template,x,y){let best=Infinity;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const p={x:x+dx,y:y+dy,width:template.width,height:template.height};if(p.x<0||p.y<0||p.x+p.width>image.width||p.y+p.height>image.height)continue;best=Math.min(best,mad(cropImage(image,p),template));}return best;}
function recognizeFieldRows(image,panel,templates,cards){
  const local=cropImage(image,panel),events=[];
  for(const spec of SPECS){
    const hits=findLabelMatches(local,templates[spec.label],{minX:spec.x-6,maxX:spec.x+6,threshold:0.145});
    for(const hit of hits){
      const shift=hit.x-spec.x,y=panel.y+hit.y;
      if(y+78>panel.y+panel.height)continue;
      const sourceMad=matchIcon(image,templates[spec.source],panel.x+spec.sx+shift,y+spec.sy);
      const destinationMad=matchIcon(image,templates[spec.destination],panel.x+spec.dx+shift,y+spec.dy);
      if(sourceMad>0.13||destinationMad>0.13)continue;
      // Isolate the thumbnail within this proven action row. Blue title bars
      // cannot join its component outside this crop. Keep original size gates.
      const roi={x:panel.x+26+shift,y:y-2,width:51,height:74};
      const boxes=findFaceUpCardComponents(image,roi).filter(b=>Math.abs(b.y-y)<=5);
      if(boxes.length!==1)continue;
      const box=boxes[0],m=matchLogCard(image,box,cards);
      if(!reliableFaceUpMatch(m))continue;
      if(spec.type==='LINK_SUMMON'&&!/^E\d+$/.test(m.best.id))continue;
      events.push({type:spec.type,side:'SELF',card:m.best,confidenceMargin:m.second.mad-m.best.mad,top3:m.ranked,box,
        source:'ACTION_LABEL_AND_ZONE_ICONS',actionEvidence:{source:spec.source,destination:spec.destination,labelMad:hit.mad,sourceMad,destinationMad},visibility:'FACE_UP'});
    }
  }
  return events.sort((a,b)=>a.box.y-b.box.y);
}
module.exports={loadFieldRowTemplates,recognizeFieldRows};
