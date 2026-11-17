export const trackerError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const receiptFields = ['vendor_id','po_number','received_date','received_by','area','comments'];
export const ticketFields = ['external_reference','requestor','usage','requested_date','date_required','issued_to','notes','shift','destination','delivery_instructions'];
export const rowFields = ['material_item_id','quantity','warehouse','location','osd','length','category','subcategory','area','priority','notes','usage','external_reference'];
export const trackerReservationSql = (job = 'null') => `select r.item_code,r.size_1,r.size_2,r.thk_1,r.thk_2,r.reserved_quantity as qty_allocated_total
  from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id
  where d.kind='issuing' and not d.cancelled and r.reserved_quantity>0 and (${job}::bigint is null or r.job_id=${job})`;
export const trackerInventorySql = `
  select r.job_id,r.item_code,r.description,r.size_1,r.size_2,r.thk_1,r.thk_2,r.warehouse,r.location,
    case when r.osd then 0 else r.posted_quantity end as qty_adjustment,
    case when r.osd then r.posted_quantity else 0 end as qty_osd_adjustment
  from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id where d.kind='receiving' and not d.cancelled
  union all
  select r.job_id,r.item_code,r.description,a.size_1,a.size_2,a.thk_1,a.thk_2,a.warehouse,a.location,-a.quantity,0::numeric
  from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id
  join tracker_rows r on r.id=a.row_id and r.job_id=a.job_id where not p.reversed`;

export function trackerQuantity(value) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(String(value))) throw trackerError('Enter a quantity of zero or greater with at most four decimals.');
  const n = Number(String(value).replaceAll(',',''));
  if (!Number.isFinite(n) || n >= 1e14) throw trackerError('Quantity is too large.');
  return n;
}
export async function lockTrackerJob(db, jobId) {
  if (!(await db.query('select id from jobs where id=$1 for update',[jobId])).rows.length) throw trackerError('Select a valid job.');
}
const text = value => String(value ?? '').trim();
const same = (a,b) => text(a).toLowerCase() === text(b).toLowerCase();
const round = n => Math.round(n*10000)/10000;
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const receiptUsedSql=`coalesce((select sum(a.quantity) from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id where a.job_id=r.job_id and a.receipt_row_id=r.id and not p.reversed),0)+coalesce((select sum(la.quantity) from tracker_legacy_allocations la where la.job_id=r.job_id and la.receipt_row_id=r.id),0)`;
export async function allocateLegacyTrackerReceipt(db,{jobId,transactionId,item,warehouse,location,quantity,getCurrentOnHandRows}) {
  const receipts=(await db.query(`select r.*,d.data->>'received_date' as received_date,r.posted_quantity-(${receiptUsedSql}) as remaining
    from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id
    where r.job_id=$1 and r.item_code=$2 and lower(r.warehouse)=lower($3) and lower(r.location)=lower($4) and d.kind='receiving' and not d.cancelled and not r.osd and r.posted_quantity>0 order by d.data->>'received_date',r.id`,[jobId,item,warehouse,location])).rows.filter(r=>Number(r.remaining)>0);
  if(!receipts.length)return;
  const stock=(await getCurrentOnHandRows(db,{jobId})).filter(r=>same(r.item_code,item)&&same(r.warehouse,warehouse)&&same(r.location,location));
  const before=stock.reduce((n,r)=>n+Number(r.qty_on_hand),0)+Number(quantity);
  let existing=Math.max(0,before-receipts.reduce((n,r)=>n+Number(r.remaining),0)),left=Number(quantity);
  const date=(await db.query(`select min(r.received_at)::text as date from receipts r join po_lines pl on pl.id=r.po_line_id join material_items mi on mi.id=pl.material_item_id where r.job_id=$1 and coalesce(nullif(pl.item_code_snapshot,''),mi.item_code)=$2 and lower(r.warehouse)=lower($3) and lower(r.location)=lower($4)`,[jobId,item,warehouse,location])).rows[0]?.date||'0000';
  for(const r of receipts) {
    if(date<=r.received_date){const used=Math.min(existing,left);existing-=used;left-=used;}
    const qty=Math.min(left,Number(r.remaining));
    if(qty>0)await db.query('insert into tracker_legacy_allocations(job_id,receipt_row_id,issue_transaction_id,quantity) values($1,$2,$3,$4)',[jobId,r.id,transactionId,qty]);
    left-=qty;if(left<=0)break;
  }
}
export async function trackerDocument(db, jobId, id, kind) {
  const d = (await db.query('select * from tracker_documents where job_id=$1 and id=$2 and kind=$3',[jobId,id,kind])).rows[0];
  if (!d) throw trackerError('Tracker document not found in this job.',404);
  return d;
}
export async function nextTrackerNumber(db,jobId,kind) {
  const prefix = kind==='receiving'?'GRR-':'GRPT-';
  const row = (await db.query(`insert into tracker_counters as c(job_id,kind,last_number)
    values($1,$2,1) on conflict(job_id,kind) do update set last_number=c.last_number+1 returning last_number`,[jobId,kind])).rows[0];
  const number=prefix+String(row.last_number).padStart(5,'0');
  const tables=kind==='receiving'?"select mrr_number as number from mrr_logs where job_id=$1":"select requisition_no as number from material_requisitions where job_id=$1";
  if ((await db.query(`select 1 from (${tables} union all select number from tracker_documents where job_id=$1) n where number=$2`,[jobId,number])).rows.length) return nextTrackerNumber(db,jobId,kind);
  return number;
}
export async function seedTrackerCounter(db,jobId,kind,floor=0) {
  const pattern=kind==='receiving'?'^GRR-([0-9]+)$':'^GRPT-([0-9]+)$';
  const legacy=kind==='receiving'?'select mrr_number as number from mrr_logs where job_id=$1':'select requisition_no as number from material_requisitions where job_id=$1';
  await db.query(`insert into tracker_counters as c(job_id,kind,last_number)
    select $1,$2,greatest($3::bigint,coalesce(max(substring(number from $4)::bigint),0)) from
    (${legacy} union all select number from tracker_documents where job_id=$1 and kind=$2) n
    on conflict(job_id,kind) do update set last_number=greatest(c.last_number,excluded.last_number)`,[jobId,kind,floor,pattern]);
}

export function createTrackerService(d) {
  const {getCurrentOnHandRows,getAvailableInventoryByItemMap,buildInventoryItemKey,getVerifiedAllocatedInventoryTotalsByItem,assertValidWarehouseLocation,auditLog}=d;
  async function issued(db,jobId,rowId) {
    return Number((await db.query(`select coalesce(sum(a.quantity),0) as qty from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id where a.job_id=$1 and a.row_id=$2 and not p.reversed`,[jobId,rowId])).rows[0].qty);
  }
  async function rows(db,jobId,documentId,kind=null) {
    return (await db.query(`select r.*,d.number,d.data as document_data,d.version as document_version,d.cancelled,
      coalesce((select sum(a.quantity) from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id where a.job_id=r.job_id and a.row_id=r.id and not p.reversed),0) as issued_quantity,
      (${receiptUsedSql}) as receipt_issued,
      coalesce((select jsonb_agg(distinct jsonb_build_object('number',td.number,'url','/tracker/issuing/documents/'||td.id||'/pick-ticket.pdf')) from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id join tracker_documents td on td.id=p.document_id and td.job_id=p.job_id where a.job_id=r.job_id and a.receipt_row_id=r.id and not p.reversed),'[]'::jsonb)||
      coalesce((select jsonb_agg(distinct jsonb_build_object('number',coalesce(l.load_no,mr.requisition_no),'url',case when l.id is null then '/requisitions/'||mr.id||'/pick-ticket.pdf' else '/requisitions/'||mr.id||'/loads/'||l.id||'/pick-ticket.pdf' end)) from tracker_legacy_allocations la join material_issue_transactions mit on mit.id=la.issue_transaction_id join material_requisitions mr on mr.id=mit.requisition_id left join material_requisition_loads l on l.id=mit.load_id where la.job_id=r.job_id and la.receipt_row_id=r.id),'[]'::jsonb) as ticket_links,
      coalesce((select string_agg(distinct td.number,', ') from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id join tracker_documents td on td.id=p.document_id and td.job_id=p.job_id where a.job_id=r.job_id and a.receipt_row_id=r.id and not p.reversed),'') as tickets
      from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id where r.job_id=$1 and ($2::bigint is null or r.document_id=$2) and ($3::text is null or d.kind=$3) order by d.id desc,r.id`,[jobId,documentId,kind])).rows;
  }
  async function reserve(db,jobId) {
    // Keep already allocated holds first; fill unreserved demand in creation order.
    const all=(await db.query(`select * from (
      select r.*,coalesce((select sum(a.quantity) from tracker_allocations a join tracker_postings p on p.id=a.posting_id and p.job_id=a.job_id where a.job_id=r.job_id and a.row_id=r.id and not p.reversed),0) as issued_quantity
      from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id where r.job_id=$1 and d.kind='issuing' and not d.cancelled
      ) demands where quantity>issued_quantity or reserved_quantity>0 order by id`,[jobId])).rows;
    for(const r of all) {
      const remaining=Math.max(0,Number(r.quantity)-Number(r.issued_quantity));
      if(Number(r.reserved_quantity)>remaining){await db.query('update tracker_rows set reserved_quantity=$3 where job_id=$1 and id=$2',[jobId,r.id,remaining]);r.reserved_quantity=remaining;}
    }
    const available=await getAvailableInventoryByItemMap(db,jobId);
    for(const r of all) {
      const key=buildInventoryItemKey(r), remaining=Math.max(0,Number(r.quantity)-Number(r.issued_quantity));
      const current=Math.min(Number(r.reserved_quantity),remaining), extra=Math.min(Math.max(0,remaining-current),available.get(key)||0);
      if(extra>0)await db.query('update tracker_rows set reserved_quantity=$3 where job_id=$1 and id=$2',[jobId,r.id,round(current+extra)]);
      available.set(key,round((available.get(key)||0)-extra));
    }
  }
  async function validateReceipt(db,jobId,r,doc) {
    const complete=r.material_item_id && Number(r.quantity)>0 && doc.data.vendor_id && doc.data.received_date && r.warehouse && r.location;
    if(complete) {
      const vendor=(await db.query('select id from vendors where id=$1',[doc.data.vendor_id])).rows[0];
      if(!vendor) throw trackerError('Select an existing vendor.');
      await assertValidWarehouseLocation(db,r.warehouse,r.location,jobId);
    }
    const next=complete?Number(r.quantity):0;
    const used=Number((await db.query(`select (${receiptUsedSql}) as qty from tracker_rows r where r.job_id=$1 and r.id=$2`,[jobId,r.id])).rows[0].qty);
    if(next<used || (used>0 && r.osd)) throw trackerError('This receipt has issued stock. Reverse the issue before changing its stock identity or removing it.');
    await db.query('update tracker_rows set posted_quantity=$3 where job_id=$1 and id=$2',[jobId,r.id,next]);
    return next;
  }
  async function stockSnapshot(db,jobId) {
    return {rows:await getCurrentOnHandRows(db,{jobId}),holds:await getVerifiedAllocatedInventoryTotalsByItem(db,jobId)};
  }
  async function assertStock(db,jobId,before={rows:[],holds:[]}) {
    const stock=await getCurrentOnHandRows(db,{jobId});
    const key=r=>JSON.stringify([r.item_code,r.size_1||'',r.size_2||'',r.thk_1||'',r.thk_2||'',text(r.warehouse).toLowerCase(),text(r.location).toLowerCase()]);
    const oldRows=new Map(before.rows.map(r=>[key(r),r]));
    if(stock.some(r=>Number(r.qty_on_hand)<Math.min(0,Number(oldRows.get(key(r))?.qty_on_hand||0))-.00001 || Number(r.qty_osd)<Math.min(0,Number(oldRows.get(key(r))?.qty_osd||0))-.00001)) throw trackerError('This edit would remove stock already issued or moved.');
    const totals=new Map();
    for(const r of stock){const key=buildInventoryItemKey(r);totals.set(key,(totals.get(key)||0)+Number(r.qty_on_hand));}
    const oldTotals=new Map(),oldHolds=new Map(before.holds.map(r=>[buildInventoryItemKey(r),Number(r.qty_allocated_total)]));
    for(const r of before.rows){const key=buildInventoryItemKey(r);oldTotals.set(key,(oldTotals.get(key)||0)+Number(r.qty_on_hand));}
    for(const r of await getVerifiedAllocatedInventoryTotalsByItem(db,jobId)) {const key=buildInventoryItemKey(r),priorDeficit=Math.max(0,(oldHolds.get(key)||0)-(oldTotals.get(key)||0));if(Number(r.qty_allocated_total)-(totals.get(key)||0)>priorDeficit+.00001) throw trackerError('This stock is reserved by an active request. Reduce or cancel that request before removing stock.');}
  }
  async function saveRow(db,{jobId,documentId,kind,id,version,patch,userId}) {
    await lockTrackerJob(db,jobId);
    const doc=await trackerDocument(db,jobId,documentId,kind);
    const before=await stockSnapshot(db,jobId);
    if(doc.cancelled) throw trackerError('This document is cancelled.');
    let old=(await db.query('select * from tracker_rows where job_id=$1 and document_id=$2 and id=$3',[jobId,documentId,id])).rows[0];
    if(!old) throw trackerError('Row not found.',404);
    if(Number(old.version)!==Number(version)) throw trackerError('Another user changed this row. Reload before editing again.',409);
    for(const k of Object.keys(patch)) if(!rowFields.includes(k)) throw trackerError('Unknown row field: '+k);
    const r={...old,data:{...old.data}};
    for(const [k,v] of Object.entries(patch)) {
      if(k==='quantity')r.quantity=trackerQuantity(v);
      else if(k==='osd'){if(typeof v!=='boolean')throw trackerError('OS&D must be yes or no.');r.osd=v;}
      else if(k==='material_item_id') {
        const item=(await db.query('select * from material_items where id=$1 and job_id=$2',[v,jobId])).rows[0];
        if(!item)throw trackerError('Choose an item from this job’s Item Master.');
        for(const f of ['item_code','description','size_1','size_2','thk_1','thk_2','uom','material_type'])r[f]=item[f]||'';
        r.material_item_id=item.id;
      } else if(['warehouse','location'].includes(k))r[k]=text(v);
      else {if(text(v).length>2000)throw trackerError('Cell text is too long.');r.data[k]=text(v);}
    }
    const used=kind==='issuing'?await issued(db,jobId,id):Number((await db.query(`select (${receiptUsedSql}) as qty from tracker_rows r where r.job_id=$1 and r.id=$2`,[jobId,id])).rows[0].qty);
    if(used>0 && (r.material_item_id!==old.material_item_id || r.warehouse!==old.warehouse || r.location!==old.location || r.osd!==old.osd)) throw trackerError('Reverse posted issues before changing the item or stock location.');
    if(kind==='issuing' && used>0)throw trackerError('Reverse posted issues before editing this line.');
    await db.query(`update tracker_rows set material_item_id=$4,item_code=$5,description=$6,size_1=$7,size_2=$8,thk_1=$9,thk_2=$10,uom=$11,material_type=$12,quantity=$13,warehouse=$14,location=$15,osd=$16,data=$17,version=version+1,reserved_quantity=case when material_item_id is distinct from $4 then 0 else least(reserved_quantity,$13) end where job_id=$1 and document_id=$2 and id=$3`,[jobId,documentId,id,r.material_item_id,r.item_code,r.description,r.size_1,r.size_2,r.thk_1,r.thk_2,r.uom,r.material_type,r.quantity,r.warehouse,r.location,r.osd,JSON.stringify(r.data)]);
    if(kind==='receiving')await validateReceipt(db,jobId,r,doc);
    await db.query('update tracker_documents set version=version+1 where job_id=$1 and id=$2',[jobId,documentId]);
    await assertStock(db,jobId,before);
    await reserve(db,jobId);
    await auditLog(db,userId,'update','tracker_row',id,JSON.stringify({before:old,patch}));
    return (await rows(db,jobId,documentId)).find(r=>Number(r.id)===Number(id));
  }
  async function saveDocument(db,{jobId,id,kind,version,patch,userId}) {
    await lockTrackerJob(db,jobId);
    const doc=await trackerDocument(db,jobId,id,kind);
    const before=await stockSnapshot(db,jobId);
    if(doc.cancelled || Number(version)!==Number(doc.version))throw trackerError('Document changed or was cancelled. Reload before editing.',409);
    if(kind==='issuing'&&(await db.query('select id from tracker_postings where job_id=$1 and document_id=$2 and not reversed limit 1',[jobId,id])).rows.length)throw trackerError('Reverse posted issues before correcting ticket details.');
    const fields=kind==='receiving'?receiptFields:ticketFields;
    let number=doc.number;
    for(const [k,v] of Object.entries(patch)) {
      if(k==='number' && kind==='receiving') {
        number=text(v);
        if(!number || number.length>100 || /[\x00-\x1f]/.test(number))throw trackerError('Enter a valid GRR number.');
        if((await db.query('select id from mrr_logs where job_id=$1 and mrr_number=$2',[jobId,number])).rows.length)throw trackerError('That number is already used by an MRR.');
      } else {
        if(!fields.includes(k))throw trackerError('Unknown document field: '+k);
        if(text(v).length>2000)throw trackerError('Cell text is too long.');
        if(k.endsWith('date') || k==='date_required') if(text(v) && !validDate(text(v)))throw trackerError('Enter a valid date.');
        doc.data[k]=text(v);
      }
    }
    if(doc.data.issued_to && ('issued_to' in patch||'requestor' in patch)) {
      const contacts=(await db.query('select * from tracker_contacts where job_id=$1',[jobId])).rows;
      if('issued_to' in patch&&!contacts.some(c=>c.active&&[c.day_contact,c.night_contact_1,c.night_contact_2].includes(doc.data.issued_to)))throw trackerError('Choose Issued To from the job’s day/night contacts.');
      const c=contacts.find(c=>c.day_contact===doc.data.requestor)||contacts.find(c=>[c.day_contact,c.night_contact_1,c.night_contact_2].includes(doc.data.issued_to));
      if(c){doc.data.night_contact_1=c.night_contact_1;doc.data.night_contact_2=c.night_contact_2;}
    }
    await db.query('update tracker_documents set data=$4,number=$5,version=version+1 where job_id=$1 and id=$2 and kind=$3',[jobId,id,kind,JSON.stringify(doc.data),number]);
    if(kind==='receiving')for(const r of await rows(db,jobId,id))await validateReceipt(db,jobId,r,doc);
    await assertStock(db,jobId,before);await reserve(db,jobId);await seedTrackerCounter(db,jobId,kind);
    await auditLog(db,userId,'update','tracker_document',id,JSON.stringify(patch));
    return trackerDocument(db,jobId,id,kind);
  }
  async function addParts(db,{jobId,documentId,kind,version,parts,userId}) {
    await lockTrackerJob(db,jobId);
    const doc=await trackerDocument(db,jobId,documentId,kind);
    if(doc.cancelled)throw trackerError('This document is cancelled.');
    if(Number(version)!==Number(doc.version))throw trackerError('The document changed. Reload before adding parts.',409);
    if(!Array.isArray(parts)||!parts.length||parts.length>200)throw trackerError('Select between 1 and 200 parts to add.');
    const selected=parts.map(p=>({id:Number(p.material_item_id),quantity:trackerQuantity(String(p.quantity??'').trim()||'0')}));
    if(selected.some(p=>!Number.isSafeInteger(p.id)||p.id<1)||new Set(selected.map(p=>p.id)).size!==selected.length)throw trackerError('Select each part only once per batch.');
    const items=(await db.query('select * from material_items where job_id=$1 and id=any($2::bigint[])',[jobId,selected.map(p=>p.id)])).rows;
    if(items.length!==selected.length)throw trackerError('One or more selected parts are no longer in this job’s Item Master. Refresh the search.');
    const blank=(await db.query("select id from tracker_rows where job_id=$1 and document_id=$2 and material_item_id is null and quantity=0 and posted_quantity=0 and warehouse='' and location='' and data='{}'::jsonb order by id limit 1",[jobId,documentId])).rows[0];
    for(let index=0;index<selected.length;index++){
      const part=selected[index],item=items.find(i=>Number(i.id)===part.id);
      const values=[jobId,documentId,item.id,...['item_code','description','size_1','size_2','thk_1','thk_2','uom','material_type'].map(f=>item[f]||''),part.quantity];
      if(index===0&&blank)await db.query('update tracker_rows set material_item_id=$3,item_code=$4,description=$5,size_1=$6,size_2=$7,thk_1=$8,thk_2=$9,uom=$10,material_type=$11,quantity=$12,version=version+1 where job_id=$1 and document_id=$2 and id=$13',[...values,blank.id]);
      else await db.query('insert into tracker_rows(job_id,document_id,material_item_id,item_code,description,size_1,size_2,thk_1,thk_2,uom,material_type,quantity) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',values);
    }
    await db.query('update tracker_documents set version=version+1 where job_id=$1 and id=$2',[jobId,documentId]);
    await reserve(db,jobId);
    await auditLog(db,userId,'add_parts','tracker_document',documentId,JSON.stringify(selected));
    return {document:await trackerDocument(db,jobId,documentId,kind),rows:await rows(db,jobId,documentId)};
  }
  async function sources(db,jobId,rowId) {
    const r=(await db.query('select * from tracker_rows where job_id=$1 and id=$2',[jobId,rowId])).rows[0];
    if(!r)throw trackerError('Row not found.',404);
    const stock=(await getCurrentOnHandRows(db,{jobId})).filter(s=>same(s.item_code,r.item_code)&&Number(s.qty_on_hand)>0);
    const receipts=(await db.query(`select r.*,d.number,d.data->>'received_date' as received_date,
      r.posted_quantity-(${receiptUsedSql}) as remaining
      from tracker_rows r join tracker_documents d on d.id=r.document_id and d.job_id=r.job_id where r.job_id=$1 and r.item_code=$2 and d.kind='receiving' and not d.cancelled and not r.osd and r.posted_quantity>0
      order by d.data->>'received_date',r.id`,[jobId,r.item_code])).rows;
    const result=[];
    for(const s of stock) {
      let free=Number(s.qty_on_hand);
      const matching=receipts.filter(a=>same(a.warehouse,s.warehouse)&&same(a.location,s.location)&&['size_1','size_2','thk_1','thk_2'].every(f=>same(a[f],s[f]))&&Number(a.remaining)>0);
      const dimensions=Object.fromEntries(['size_1','size_2','thk_1','thk_2'].map(f=>[f,s[f]||'']));
      const source_key=JSON.stringify(Object.values(dimensions));
      const tracked=matching.reduce((n,a)=>n+Number(a.remaining),0);
      // Existing stock can include PO receipts, opening counts and moved material.
      const legacy=Math.max(0,free-tracked);
      if(legacy>0) {
        const date=(await db.query(`select min(r.received_at)::text as date from receipts r join po_lines pl on pl.id=r.po_line_id join material_items mi on mi.id=pl.material_item_id where r.job_id=$1 and coalesce(nullif(pl.item_code_snapshot,''),mi.item_code)=$2 and lower(r.warehouse)=lower($3) and lower(r.location)=lower($4)`,[jobId,r.item_code,s.warehouse,s.location])).rows[0]?.date||'0000';
        result.push({receipt_row_id:null,warehouse:s.warehouse,location:s.location,quantity:legacy,label:'Existing stock',date,...dimensions,source_key});free-=legacy;
      }
      for(const a of matching){const q=Math.min(free,Number(a.remaining));if(q>0)result.push({receipt_row_id:a.id,warehouse:s.warehouse,location:s.location,quantity:q,label:a.number,date:a.received_date,...dimensions,source_key});free-=q;}
    }
    return result.sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.label).localeCompare(String(b.label)));
  }
  async function postIssue(db,{jobId,documentId,userId,requestKey,version,allocations,issuedDate}) {
    await lockTrackerJob(db,jobId);
    const doc=await trackerDocument(db,jobId,documentId,'issuing');
    const before=await stockSnapshot(db,jobId);
    if(!/^[\w-]{8,100}$/.test(text(requestKey)))throw trackerError('Invalid posting key. Reload the issue form.');
    const prior=(await db.query('select * from tracker_postings where job_id=$1 and request_key=$2',[jobId,requestKey])).rows[0];
    if(prior){if(Number(prior.document_id)!==Number(documentId))throw trackerError('Posting key already used.');return prior;}
    if(doc.cancelled || Number(doc.version)!==Number(version))throw trackerError('Ticket changed. Reload the issue form.',409);
    if(!doc.data.issued_to)throw trackerError('Select Issued To before posting.');
    if(!validDate(issuedDate))throw trackerError('Enter a valid issue date.');
    if(!Array.isArray(allocations)||!allocations.length||allocations.length>1000)throw trackerError('Enter quantities to issue.');
    const lines=await rows(db,jobId,documentId),byRow=new Map(),byReceipt=new Map(),selected=[];
    const available=await getAvailableInventoryByItemMap(db,jobId);
    for(const a of allocations) {
      const q=trackerQuantity(a.quantity);if(q<=0)throw trackerError('Issue quantities must be greater than zero.');
      const r=lines.find(r=>Number(r.id)===Number(a.row_id));if(!r?.material_item_id)throw trackerError('Invalid ticket line.');
      const choices=await sources(db,jobId,r.id);
      const s=choices.find(s=>same(s.warehouse,a.warehouse)&&same(s.location,a.location)&&Number(s.receipt_row_id||0)===Number(a.receipt_row_id||0)&&(!a.source_key||a.source_key===s.source_key));
      if(!s)throw trackerError('Selected stock is no longer available. Reload allocations.');
      const sourceKey=JSON.stringify([r.item_code,s.warehouse,s.location,s.receipt_row_id||0,s.source_key]);
      byReceipt.set(sourceKey,(byReceipt.get(sourceKey)||0)+q);
      if(byReceipt.get(sourceKey)>Number(s.quantity)+0.00001)throw trackerError('Selected receipt does not have enough stock.');
      selected.push({...s,row_id:r.id,quantity:q});
      byRow.set(r.id,(byRow.get(r.id)||0)+q);
    }
    const itemDemand=new Map(),itemOwn=new Map();
    for(const r of lines) {
      const q=byRow.get(r.id)||0;
      if(q>Number(r.quantity)-Number(r.issued_quantity)+0.00001)throw trackerError('Issue quantity exceeds the unissued request balance.');
      const key=buildInventoryItemKey(r);itemDemand.set(key,(itemDemand.get(key)||0)+q);itemOwn.set(key,(itemOwn.get(key)||0)+Number(r.reserved_quantity));
    }
    for(const [key,q] of itemDemand)if(q>(available.get(key)||0)+(itemOwn.get(key)||0)+0.00001)throw trackerError('Stock is held by another request.');
    const posting=(await db.query('insert into tracker_postings(job_id,document_id,request_key,created_by,issued_date) values($1,$2,$3,$4,$5) returning *',[jobId,documentId,requestKey,userId,issuedDate])).rows[0];
    for(const a of selected)await db.query('insert into tracker_allocations(job_id,posting_id,row_id,receipt_row_id,warehouse,location,quantity,size_1,size_2,thk_1,thk_2) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[jobId,posting.id,a.row_id,a.receipt_row_id||null,a.warehouse,a.location,a.quantity,a.size_1,a.size_2,a.thk_1,a.thk_2]);
    const released=new Map();
    for(const r of lines){const key=buildInventoryItemKey(r),amount=Math.min(Number(r.reserved_quantity),byRow.get(r.id)||0);released.set(key,(released.get(key)||0)+amount);r.reserved_quantity=Number(r.reserved_quantity)-amount;}
    const extraRelease=new Map([...itemDemand].map(([key,q])=>[key,Math.max(0,q-(available.get(key)||0)-(released.get(key)||0))]));
    for(const r of lines){const key=buildInventoryItemKey(r),extra=Math.min(Number(r.reserved_quantity),extraRelease.get(key)||0);extraRelease.set(key,(extraRelease.get(key)||0)-extra);await db.query('update tracker_rows set reserved_quantity=$3,version=version+1 where job_id=$1 and id=$2',[jobId,r.id,Number(r.reserved_quantity)-extra]);}
    await db.query(`update tracker_documents set data=data||jsonb_build_object('issued_date',$3::text),version=version+1 where job_id=$1 and id=$2`,[jobId,documentId,issuedDate]);
    await assertStock(db,jobId,before);await reserve(db,jobId);
    await auditLog(db,userId,'issue','tracker_document',documentId,JSON.stringify({posting:posting.id,allocations}));
    return posting;
  }
  async function reverse(db,{jobId,documentId,postingId,userId}) {
    await lockTrackerJob(db,jobId);await trackerDocument(db,jobId,documentId,'issuing');
    const posting=(await db.query('update tracker_postings set reversed=true where job_id=$1 and document_id=$2 and id=$3 and not reversed returning *',[jobId,documentId,postingId])).rows[0];
    if(!posting)throw trackerError('Posting not found or already reversed.');
    await db.query(`update tracker_documents set version=version+1,data=case when exists(select 1 from tracker_postings where job_id=$1 and document_id=$2 and not reversed) then data||jsonb_build_object('issued_date',(select issued_date::text from tracker_postings where job_id=$1 and document_id=$2 and not reversed order by id desc limit 1)) else data-'issued_date' end where job_id=$1 and id=$2`,[jobId,documentId]);
    await db.query('update tracker_rows set version=version+1 where job_id=$1 and document_id=$2',[jobId,documentId]);
    await reserve(db,jobId);await auditLog(db,userId,'reverse','tracker_posting',postingId,'Issue reversal');
  }
  async function cancel(db,{jobId,documentId,kind,userId}) {
    await lockTrackerJob(db,jobId);await trackerDocument(db,jobId,documentId,kind);
    const before=await stockSnapshot(db,jobId);
    if(kind==='issuing' && (await db.query('select id from tracker_postings where job_id=$1 and document_id=$2 and not reversed',[jobId,documentId])).rows.length)throw trackerError('Reverse all issues before cancelling this ticket.');
    if(kind==='receiving' && (await db.query('select a.id from tracker_allocations a join tracker_postings p on p.id=a.posting_id join tracker_rows r on r.id=a.receipt_row_id where a.job_id=$1 and r.document_id=$2 and not p.reversed limit 1',[jobId,documentId])).rows.length)throw trackerError('Reverse the issues allocated from this GRR before cancelling it.');
    if(kind==='receiving' && (await db.query('select a.id from tracker_legacy_allocations a join tracker_rows r on r.id=a.receipt_row_id where a.job_id=$1 and r.document_id=$2 limit 1',[jobId,documentId])).rows.length)throw trackerError('This GRR has stock issued through an existing request. Reverse that issue before cancelling the receipt.');
    await db.query('update tracker_documents set cancelled=true,version=version+1 where job_id=$1 and id=$2',[jobId,documentId]);
    await db.query('update tracker_rows set reserved_quantity=0,version=version+1 where job_id=$1 and document_id=$2',[jobId,documentId]);
    await assertStock(db,jobId,before);await reserve(db,jobId);await auditLog(db,userId,'cancel','tracker_document',documentId,kind);
  }
  return {rows,reserve,saveRow,saveDocument,addParts,sources,postIssue,reverse,cancel};
}
