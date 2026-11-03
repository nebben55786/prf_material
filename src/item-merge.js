import {getIssuedIdentRequests} from './item-ident.js';
const fail=message=>Object.assign(new Error(message),{statusCode:400});
const code=value=>String(value||'').trim().toLowerCase();
const version=item=>JSON.stringify([item.item_code,item.description,item.uom,item.size_1,item.size_2,item.thk_1,item.thk_2,item.updated_at]);
const sum=(rows,key)=>Math.round(rows.reduce((n,r)=>n+Number(r[key]||0),0)*10000)/10000;
export function mergeStockSnapshot(rows,idents) {
  const keys=new Set(idents.map(code));
  return rows.filter(r=>keys.has(code(r.item_code))).map(r=>[r.item_code,r.size_1||'',r.size_2||'',r.thk_1||'',r.thk_2||'',r.warehouse,r.location,Number(r.qty_on_hand),Number(r.qty_osd)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function validateMerge(db,jobId,source,target) {
  if(!source||!target||Number(source.id)===Number(target.id))throw fail('Choose two different items in the current job.');
  if(code(source.uom)!==code(target.uom))throw fail('The units of measure must match before these items can be merged.');
  for(const item of [source,target]) {
    const requests=await getIssuedIdentRequests(db,jobId,item.item_code);
    if(requests.length)throw fail(item.item_code+' cannot be merged because it is used on issued requests: '+requests.map(r=>r.requisition_no).join(', ')+'.');
  }
  const issued=(await db.query('select bl.id from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=$1 and lower(btrim(bl.item_code))=any($2::text[]) and bl.qty_issued>0 limit 1',[jobId,[code(source.item_code),code(target.item_code)]])).rows;
  if(issued.length)throw fail('These items have issued BOM quantities and cannot be merged.');
  const duplicates=(await db.query('select id from material_items where job_id=$1 and lower(btrim(item_code))=any($2::text[]) and id<>all($3::bigint[]) limit 1',[jobId,[code(source.item_code),code(target.item_code)],[source.id,target.id]])).rows;
  if(duplicates.length)throw fail('Another master item uses one of these idents. Resolve that duplicate first.');
}
export async function mergeItems(db,{jobId,sourceId,targetId,sourceVersion,targetVersion,stockSnapshot,userId,getCurrentOnHandRows,auditLog,recomputeBomIssuedSummaries}) {
  await db.query('select id from jobs where id=$1 for update',[jobId]);
  const items=(await db.query('select * from material_items where job_id=$1 and id=any($2::bigint[]) order by id for update',[jobId,[sourceId,targetId]])).rows;
  const source=items.find(r=>Number(r.id)===Number(sourceId)),target=items.find(r=>Number(r.id)===Number(targetId));
  await validateMerge(db,jobId,source,target);
  if(version(source)!==sourceVersion||version(target)!==targetVersion)throw fail('An item changed after review. Review the merge again.');
  const codes=[code(source.item_code),code(target.item_code)];
  const stock=mergeStockSnapshot(await getCurrentOnHandRows(db,{jobId}),[source.item_code,target.item_code]);
  if(JSON.stringify(stock)!==JSON.stringify(stockSnapshot))throw fail('Inventory changed after review. Review the merge again.');
  const canonical=[target.item_code,target.description,target.size_1||'',target.size_2||'',target.thk_1||'',target.thk_2||''];
  // Repoint BOM links before combining colliding BOM line numbers. Request/load line IDs stay intact.
  const bomRows=(await db.query('select bl.* from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=$1 and lower(btrim(bl.item_code))=any($2::text[]) order by bl.id for update of bl',[jobId,codes])).rows;
  const groups=new Map();
  for(const row of bomRows){const key=JSON.stringify([row.bom_id,row.line_no]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const quantityFields=['qty_required','qty_quoted','qty_awarded','qty_ordered','qty_received','qty_issued'];
  for(const rows of groups.values()) {
    const keep=rows.find(r=>code(r.item_code)===code(target.item_code))||rows[0];
    const removed=rows.filter(r=>r.id!==keep.id).map(r=>r.id);
    if(removed.length) {
      await db.query('update material_requisition_lines set bom_line_id=$1 where bom_line_id=any($2::bigint[])',[keep.id,removed]);
      await db.query('update material_issue_transactions set source_bom_line_id=$1 where source_bom_line_id=any($2::bigint[])',[keep.id,removed]);
      await db.query('delete from bom_lines where id=any($1::bigint[])',[removed]);
    }
    await db.query(`update bom_lines set item_code=$2,description=$3,size_1=$4,size_2=$5,thk_1=$6,thk_2=$7,uom=$8,material_type=$9,${quantityFields.map((f,i)=>f+'=$'+(10+i)).join(',')},updated_at=now() where id=$1`,[keep.id,...canonical,target.uom,target.material_type,...quantityFields.map(f=>sum(rows,f))]);
  }
  for(const table of ['rfq_items','po_lines'])await db.query(`update ${table} set material_item_id=$3,item_code_snapshot=$4,description_snapshot=$5,size_1=$6,size_2=$7,thk_1=$8,thk_2=$9,material_type_snapshot=$10,uom_snapshot=$11 where job_id=$1 and (material_item_id=any($2::bigint[]) or lower(btrim(item_code_snapshot))=any($12::text[]))`,[jobId,[source.id,target.id],target.id,...canonical,target.material_type,target.uom,codes]);
  // Count rows have a uniqueness constraint. Combine them before normalizing ident and dimensions.
  const counts=(await db.query('select warehouse,location,array_agg(id order by id) as ids,sum(actual_qty) as actual_qty from inventory_audit_counts where job_id=$1 and lower(btrim(item_code))=any($2::text[]) group by warehouse,location',[jobId,codes])).rows;
  for(const row of counts){const [keep,...remove]=row.ids;if(remove.length)await db.query('delete from inventory_audit_counts where id=any($1::bigint[])',[remove]);await db.query('update inventory_audit_counts set item_code=$2,description=$3,size_1=$4,size_2=$5,thk_1=$6,thk_2=$7,actual_qty=$8,updated_by=$9,updated_at=now() where id=$1',[keep,...canonical,row.actual_qty,userId]);}
  for(const table of ['inventory_adjustment_lines','inventory_audit_report_lines','inventory_location_moves'])await db.query(`update ${table} set item_code=$3,description=$4,size_1=$5,size_2=$6,thk_1=$7,thk_2=$8 where job_id=$1 and lower(btrim(item_code))=any($2::text[])`,[jobId,codes,...canonical]);
  await db.query('update osd_logs set item_code=$3,description=$4 where job_id=$1 and lower(btrim(item_code))=any($2::text[])',[jobId,codes,target.item_code,target.description]);
  await db.query(`update material_receiving_logs set item_code=case when lower(btrim(item_code))=any($2::text[]) then $3 else item_code end,ident_code=case when lower(btrim(ident_code))=any($2::text[]) then $3 else ident_code end,fluor_item_code=case when lower(btrim(fluor_item_code))=any($2::text[]) then $3 else fluor_item_code end,description=$4,size_1=$5,size_2=$6,thk_1=$7,thk_2=$8 where job_id=$1 and (lower(btrim(item_code))=any($2::text[]) or lower(btrim(ident_code))=any($2::text[]) or lower(btrim(fluor_item_code))=any($2::text[]))`,[jobId,codes,...canonical]);
  const fmrRows=(await db.query('select * from vendor_fmr_request_lines where job_id=$1 and lower(btrim(item_code))=any($2::text[]) order by id for update',[jobId,codes])).rows;
  const fmrGroups=new Map();for(const row of fmrRows){if(!fmrGroups.has(row.po_number))fmrGroups.set(row.po_number,[]);fmrGroups.get(row.po_number).push(row);}
  const textFields=['vendor_name','po_line','sub_line','mrr_number','issued_date','received_date','srn_number','crate_number','source_filename'];
  for(const rows of fmrGroups.values()) {
    const keep=rows[0],remove=rows.slice(1).map(r=>r.id);
    if(remove.length)await db.query('delete from vendor_fmr_request_lines where id=any($1::bigint[])',[remove]);
    await db.query(`update vendor_fmr_request_lines set item_code=$2,abbrev_description=$3,qty_ordered=$4,qty_received=$5,selected_for_request=$6,${textFields.map((f,i)=>f+'=$'+(7+i)).join(',')},updated_at=now() where id=$1`,[keep.id,target.item_code,target.description,sum(rows,'qty_ordered'),sum(rows,'qty_received'),rows.some(r=>r.selected_for_request),...textFields.map(f=>[...new Set(rows.map(r=>r[f]).filter(Boolean))].join(' | '))]);
  }
  await db.query('insert into material_item_specs(job_id,material_item_id,spec_id) select job_id,$3,spec_id from material_item_specs where job_id=$1 and material_item_id=$2 on conflict do nothing',[jobId,source.id,target.id]);
  await db.query('update material_photos set material_item_id=$3 where job_id=$1 and material_item_id=$2',[jobId,source.id,target.id]);
  await db.query('update inventory_audit_reports set ident_filter=$3 where job_id=$1 and lower(btrim(ident_filter))=any($2::text[])',[jobId,codes,target.item_code]);
  const notes=[...new Set([target.notes,source.notes].filter(Boolean))].join('\n');
  await db.query('update material_items set notes=$3,updated_at=now() where id=$1 and job_id=$2',[target.id,jobId,notes]);
  await db.query('delete from material_items where id=$1 and job_id=$2',[source.id,jobId]);
  if(recomputeBomIssuedSummaries)await recomputeBomIssuedSummaries(db,jobId);
  const after=await getCurrentOnHandRows(db,{jobId});
  const beforeTotals=new Map();for(const row of stock){const key=JSON.stringify([row[5],row[6]]);const prior=beforeTotals.get(key)||[0,0];beforeTotals.set(key,[prior[0]+row[7],prior[1]+row[8]]);}
  const afterTotals=new Map();for(const row of after.filter(r=>code(r.item_code)===code(target.item_code))){const key=JSON.stringify([row.warehouse,row.location]);const prior=afterTotals.get(key)||[0,0];afterTotals.set(key,[prior[0]+Number(row.qty_on_hand),prior[1]+Number(row.qty_osd)]);}
  for(const key of new Set([...beforeTotals.keys(),...afterTotals.keys()])){const before=beforeTotals.get(key)||[0,0],afterQty=afterTotals.get(key)||[0,0];if(before.some((n,i)=>Math.abs(n-afterQty[i])>0.00001))throw fail('The merge would change a location stock balance. Nothing was saved.');}
  await auditLog(db,userId,'merge_items','material_item',target.id,JSON.stringify({removed_item:source,kept_item:target,bom_rows_before:bomRows,vendor_fmr_rows_before:fmrRows,stock_before:stock}));
  return target;
}
export function registerItemMergeRoutes(app,d) {
  const {query,withTransaction,requireAuth,requireJobContext,requirePermission,asyncHandler,currentJobId,layout,esc,signSession,readSession,getCurrentOnHandRows,auditLog,recomputeBomIssuedSummaries}=d;
  const middleware=[requireAuth,requireJobContext,requirePermission('inventory','edit')];
  const read=(req,stage)=>{const token=readSession(String(req.body.token||''));if(!token||token.scope!=='merge_items'||token.stage!==stage||token.job_id!==currentJobId(req)||token.user_id!==req.user.id||token.source_id!==Number(req.params.id)||token.expires<Date.now())throw fail('This merge form expired. Open Merge Item again.');return token;};
  const sign=(req,data)=>signSession({scope:'merge_items',job_id:currentJobId(req),user_id:req.user.id,expires:Date.now()+3600000,...data});
  app.get('/items/:id/merge',...middleware,asyncHandler(async(req,res)=>{
    const jobId=currentJobId(req),source=(await query('select * from material_items where job_id=$1 and id=$2',[jobId,req.params.id])).rows[0];if(!source)throw fail('Item not found in the current job.');
    const q=String(req.query.q||'').trim();
    const items=(await query("select * from material_items where job_id=$1 and id<>$2 and (item_code ilike $3 or description ilike $3) order by item_code limit 200",[jobId,source.id,'%'+q+'%'])).rows;
    const token=sign(req,{stage:'select',source_id:Number(source.id),source_version:version(source)});
    res.send(layout('Merge Item',`<h1>Merge Item</h1><div class="card"><p>Item to remove: <strong>${esc(source.item_code)}</strong> | ${esc(source.description)}</p><p>Choose the item to keep. Its ident, description, sizes and unit will be used throughout this job. Stock quantities are combined by location. Issued requests block merging.</p><form method="get" class="stack"><label>Find Item to Keep</label><input name="q" value="${esc(q)}" placeholder="Ident or description"><button>Find Items</button></form><form method="post" action="/items/${source.id}/merge/review" class="stack"><input type="hidden" name="token" value="${esc(token)}"><label>Item to Keep</label><select name="target_id" required><option value="">Choose the item to keep</option>${items.map(r=>`<option value="${r.id}">${esc(r.item_code)} | ${esc(r.description)} | ${esc([r.size_1,r.size_2,r.thk_1,r.thk_2].filter(Boolean).join(' / '))} | ${esc(r.uom)}</option>`).join('')}</select><p class="muted">Up to 200 matching items shown. Search to narrow the list.</p><div class="actions"><button>Review Merge</button><a class="btn btn-secondary" href="/items/${source.id}/edit">Cancel</a></div></form></div>`,req.user));
  }));
  app.post('/items/:id/merge/review',...middleware,asyncHandler(async(req,res)=>{
    const data=read(req,'select'),jobId=currentJobId(req);
    const items=(await query('select * from material_items where job_id=$1 and id=any($2::bigint[])',[jobId,[data.source_id,Number(req.body.target_id)||0]])).rows;
    const source=items.find(r=>Number(r.id)===data.source_id),target=items.find(r=>Number(r.id)===Number(req.body.target_id));await validateMerge({query},jobId,source,target);
    if(version(source)!==data.source_version)throw fail('The source item changed. Open Merge Item again.');
    const stock=mergeStockSnapshot(await getCurrentOnHandRows({query},{jobId}),[source.item_code,target.item_code]);
    const grouped=new Map();for(const r of stock){const key=JSON.stringify([r[5],r[6]]),g=grouped.get(key)||{warehouse:r[5],location:r[6],source:0,target:0,osd:0};g[code(r[0])===code(source.item_code)?'source':'target']+=r[7];g.osd+=r[8];grouped.set(key,g);}
    const token=sign(req,{stage:'review',source_id:data.source_id,target_id:Number(target.id),source_version:version(source),target_version:version(target),stock});
    res.send(layout('Review Item Merge',`<h1>Review Item Merge</h1><div class="card"><p>Remove: <strong>${esc(source.item_code)}</strong> | ${esc(source.description)}</p><p>Keep: <strong>${esc(target.item_code)}</strong> | ${esc(target.description)}</p><p>All matching idents and descriptions will use the kept item. Its sizes and unit become the standard. Linked requests, purchasing lines, receiving records, photos, and specs are preserved.</p><table data-phone-request-table><tr><th>Warehouse</th><th>Location</th><th>Item to Remove Qty</th><th>Item to Keep Qty</th><th>Combined Qty</th><th>Combined OS&amp;D</th></tr>${[...grouped.values()].map(r=>`<tr><td>${esc(r.warehouse)}</td><td>${esc(r.location)}</td><td>${esc(r.source)}</td><td>${esc(r.target)}</td><td>${esc(r.source+r.target)}</td><td>${esc(r.osd)}</td></tr>`).join('')||'<tr><td colspan="6">Neither item has inventory.</td></tr>'}</table><form method="post" action="/items/${source.id}/merge/save"><input type="hidden" name="token" value="${esc(token)}"><div class="actions"><button>Merge Items</button><a class="btn btn-secondary" href="/items/${source.id}/merge">Back</a></div></form></div>`,req.user));
  }));
  app.post('/items/:id/merge/save',...middleware,asyncHandler(async(req,res)=>{
    const data=read(req,'review');const target=await withTransaction(db=>mergeItems(db,{jobId:data.job_id,sourceId:data.source_id,targetId:data.target_id,sourceVersion:data.source_version,targetVersion:data.target_version,stockSnapshot:data.stock,userId:req.user.id,getCurrentOnHandRows,auditLog,recomputeBomIssuedSummaries}));
    res.redirect('/items/'+target.id+'/edit?merged=1');
  }));
}
