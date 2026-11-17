import fs from 'node:fs';
const logo=fs.readFileSync(new URL('../public/tracker-logo.png',import.meta.url));
const escape=v=>String(v??'').replace(/[^\x20-\x7e\xa0-\xff]/g,' ').replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
const date=v=>/^\d{4}-\d{2}-\d{2}/.test(v||'')?v.slice(5,7)+'/'+v.slice(8,10)+'/'+v.slice(0,4):String(v||'');
function wrap(value,width,size){
  const limit=Math.max(1,Math.floor(width/(size*.56))),lines=[];
  for(const word of String(value??'').split(/\s+/)){
    if(!word)continue;
    if(!lines.length)lines.push('');
    if(lines.at(-1)&&lines.at(-1).length+word.length+1>limit)lines.push('');
    let remaining=word;
    while(remaining.length>limit){if(lines.at(-1))lines.push('');lines[lines.length-1]=remaining.slice(0,limit);remaining=remaining.slice(limit);lines.push('');}
    lines[lines.length-1]+=(lines.at(-1)?' ':'')+remaining;
  }
  return lines.length?lines:[''];
}
export function buildTrackerPdf(doc,rows,job,{buildDrawnPdf}) {
  const data=doc.data||{},issued=rows.some(r=>Number(r.issued_quantity)>0),cols=[18,54,94,125,245,496,540,594],pages=[];
  // REQUEST FORM row heights, scaled uniformly to a portrait letter sheet.
  const scale=756/1192.5;
  const sourceHeights=[15,38.25,25.5,26.25,18.75,13.5,21,26.25,28.5,19.5,14.25,18.75,24];
  const bodyHeights=[31.5,31.5,33.75,32.25,32.25,32.25,26.25,26.25,33.75,...Array(21).fill(26.25)].map(v=>v*scale);
  const bottoms=[];let top=774;
  for(const h of sourceHeights){top-=h*scale;bottoms.push(top);}
  const tableTop=bottoms[11],headerHeight=24*scale,bodyTop=tableTop-headerHeight,capacity=831*scale;
  const prepared=rows.filter(r=>r.material_item_id&&Number(r.quantity)>0).map((r,i)=>{
    const description=r.description+(issued?` | Issued: ${Number(r.issued_quantity||0)} | Remaining: ${Math.max(0,Number(r.quantity)-Number(r.issued_quantity||0))}`:'');
    return {r,i,text:wrap(description,cols[5]-cols[4]-6,7),ident:wrap(r.item_code,cols[4]-cols[3]-6,7)};
  });
  const chunks=[];let chunk=[],height=0;
  for(const item of prepared){
    let h=Math.max(bodyHeights[chunk.length]||bodyHeights[29],Math.max(item.text.length,item.ident.length)*8+5);
    if((height+h>capacity||chunk.length===30)&&chunk.length){chunks.push(chunk);chunk=[];height=0;h=Math.max(bodyHeights[0],Math.max(item.text.length,item.ident.length)*8+5);}
    // Very long cells are continued on subsequent rows/pages without dropping text.
    const maxLines=Math.floor((capacity-5)/8);
    while(item.text.length>maxLines||item.ident.length>maxLines){
      if(chunk.length){chunks.push(chunk);chunk=[];height=0;}
      chunks.push([{...item,text:item.text.splice(0,maxLines),ident:item.ident.splice(0,maxLines),height:capacity}]);
    }
    h=Math.max(bodyHeights[chunk.length]||bodyHeights[29],Math.max(item.text.length,item.ident.length)*8+5);
    chunk.push({...item,height:h});height+=h;
  }
  if(chunk.length||!chunks.length)chunks.push(chunk);
  const notes=wrap(data.notes||'',241,7),noteChunks=[];
  for(let i=0;i<notes.length;i+=3)noteChunks.push(notes.slice(i,i+3));
  while(chunks.length<noteChunks.length)chunks.push([]);
  for(let p=0;p<chunks.length;p++) {
    const content=['0.45 w','0 0 0 RG'];
    const text=(x,y,value,size=7,bold=false)=>content.push(`BT /${bold?'F2':'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escape(value)}) Tj ET`);
    const line=(x,y,x2,y2)=>content.push(`${x} ${y} m ${x2} ${y2} l S`);
    const box=(x,y,w,h)=>content.push(`${x} ${y} ${w} ${h} re S`);
    const fill=(x,y,w,h,color)=>content.push(`q ${color} rg ${x} ${y} ${w} ${h} re f Q`);
    const multi=(x,y,value,w,size=7,max=Infinity)=>wrap(value,w,size).slice(0,max).forEach((s,i)=>text(x,y-i*(size+1),s,size));
    content.push('q 93 0 0 80 22 690 cm /Logo Do Q');
    fill(125,bottoms[1],469,38.25*scale,'0.776 0.878 0.706');
    content.push('1 0 0 rg');text(138,bottoms[1]+11,'DRIVER MUST RETURN COPY OF TICKET TO PERFORMANCE WEAVER RD OFFICE - SIGNED BY RECIPIENT.',6.7,true);content.push('0 0 0 rg');
    text(466,bottoms[2]+6,'REQ NO.',7,true);box(496,bottoms[2],98,25.5*scale);
    content.push('1 0 0 rg');text(508,bottoms[2]+4,doc.number,11,true);content.push('0 0 0 rg');
    multi(353,bottoms[3]+6,data.usage||'',238,6.5,2);
    text(255,bottoms[4]+3,'MATERIAL REQUISITION',10,true);
    text(245,bottoms[5]+2,doc.cancelled?'CANCELLED':issued?'ISSUE COPY - ACTUAL QUANTITIES / BALANCES':'REQUEST COPY',5.5);
    fill(18,bottoms[6],576,21*scale,'1 1 0');box(18,bottoms[6],576,21*scale);
    content.push('1 0 0 rg');text(25,bottoms[6]+4,data.delivery_instructions||'',8,true);content.push('0 0 0 rg');
    box(18,bottoms[7],227,26.25*scale);box(245,bottoms[7],349,26.25*scale);
    text(29,bottoms[7]+6,'FROM: '+(data.requestor||''),7,true);
    text(246,bottoms[7]+6,'DATE REQUISITION: '+date(data.requested_date),6.5,true);
    text(350,bottoms[7]+6,'DATE REQUIRED: '+date(data.date_required),6.5,true);
    fill(245,bottoms[8],349,28.5*scale,'1 0.949 0.8');
    box(18,bottoms[8],107,28.5*scale);box(125,bottoms[8],120,28.5*scale);box(245,bottoms[8],349,28.5*scale);
    text(42,bottoms[8]+7,'TO:',7,true);text(128,bottoms[8]+7,data.issued_to||'',6.5);
    text(246,bottoms[8]+7,'DELIVER TO: '+(data.destination||''),7,true);
    text(408,bottoms[8]+7,data.requestor||'',6.5,true);
    box(18,bottoms[9],107,19.5*scale);box(125,bottoms[9],220,19.5*scale);
    text(19,bottoms[9]+4,'JOB NO:   '+job.job_number,7,true);text(246,bottoms[9]+4,'PO NO. '+(data.external_reference||''),7,true);
    fill(345,bottoms[11],249,bottoms[8]-bottoms[11],'0.867 0.922 0.969');box(345,bottoms[11],249,bottoms[8]-bottoms[11]);
    text(428,bottoms[9]+4,'Night Shift Contact',7,true);
    text(353,bottoms[10]+3,data.night_contact_1||'',7,true);text(353,bottoms[11]+3,data.night_contact_2||'',7,true);
    const headers=['ITEM','QTY','UNIT','IDENT','DESCRIPTION','PRICE','AMOUNT'];
    box(18,bodyTop,576,headerHeight);headers.forEach((h,i)=>text(cols[i]+3,bodyTop+5,h,7,true));
    let y=bodyTop,total=0;
    for(const item of chunks[p]){
      const {r}=item;y-=item.height;box(18,y,576,item.height);
      text(cols[0]+3,y+item.height-11,item.i+1,7);text(cols[1]+3,y+item.height-11,issued?Number(r.issued_quantity||0):Number(r.quantity),7);
      text(cols[2]+3,y+item.height-11,r.uom||'',7);
      item.ident.forEach((s,i)=>text(cols[3]+2,y+item.height-11-i*8,s,7));item.text.forEach((s,i)=>text(cols[4]+2,y+item.height-11-i*8,s,7));total+=item.height;
    }
    let blank=chunks[p].length;
    while(blank<30&&total+bodyHeights[blank]<=capacity+.01){const h=bodyHeights[blank];y-=h;box(18,y,576,h);text(21,y+h-11,blank+(chunks[p][0]?.i||0)+1,7);total+=h;blank++;}
    for(let i=1;i<cols.length-1;i++)line(cols[i],tableTop,cols[i],y);
    const footerHeight=24*scale,footerTop=y;
    for(let i=0;i<3;i++)box(18,footerTop-(i+1)*footerHeight,576,footerHeight);
    line(345,footerTop,345,footerTop-3*footerHeight);
    text(19,footerTop-10,'SUPT. APPROVAL:',7,true);text(19,footerTop-footerHeight-10,'CLIENT APPROVAL:',7,true);text(19,footerTop-2*footerHeight-10,'CHARGE NO.:',7,true);
    text(347,footerTop-10,'SPECIAL INSTRUCTIONS:',7,true);(noteChunks[p]||[]).forEach((s,i)=>text(347,footerTop-19-i*7,s,6));
    text(347,footerTop-2*footerHeight-10,'BUYER APPROVAL:',7,true);
    text(18,7,'Received by (signature): _________________________  Date: ______________',6);
    text(455,7,`${doc.number} | Page ${p+1} of ${chunks.length}`,6);
    pages.push({content:content.join('\n'),images:[{name:'Logo',buffer:logo}]});
  }
  return buildDrawnPdf(pages,{pageWidth:612,pageHeight:792});
}
