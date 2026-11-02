export const identTargets = [
  ['bom_lines','item_code','bom_id in (select id from bom_headers where job_id=$1)'],
  ['rfq_items','item_code_snapshot','job_id=$1'],
  ['po_lines','item_code_snapshot','job_id=$1'],
  ['material_receiving_logs','item_code','job_id=$1'],
  ['material_receiving_logs','ident_code','job_id=$1'],
  ['material_receiving_logs','fluor_item_code','job_id=$1'],
  ['osd_logs','item_code','job_id=$1'],
  ['vendor_fmr_request_lines','item_code','job_id=$1'],
  ['inventory_audit_counts','item_code','job_id=$1'],
  ['inventory_audit_report_lines','item_code','job_id=$1'],
  ['inventory_adjustment_lines','item_code','job_id=$1'],
  ['inventory_location_moves','item_code','job_id=$1']
];
const fail = message => Object.assign(new Error(message), {statusCode:400});
export async function getIssuedIdentRequests(db, jobId, ident) {
  return (await db.query(`
    select distinct mr.id,mr.requisition_no
    from material_requisitions mr
    join material_requisition_lines mrl on mrl.requisition_id=mr.id
    join bom_lines bl on bl.id=mrl.bom_line_id
    join bom_headers bh on bh.id=bl.bom_id
    where mr.job_id=$1 and bh.job_id=$1 and lower(btrim(bl.item_code))=lower(btrim($2))
      and (mr.status='ISSUED' or coalesce(mrl.qty_issued,0)>0
        or exists(select 1 from material_issue_transactions mit where mit.job_id=$1 and mit.requisition_line_id=mrl.id and mit.qty_issued>0)
        or exists(select 1 from material_requisition_load_lines ll join material_requisition_loads l on l.id=ll.load_id where ll.requisition_line_id=mrl.id and l.job_id=$1 and l.status='ISSUED'))
    order by mr.id`,[jobId,ident])).rows;
}
async function assertIdentNotIssued(db,jobId,ident) {
  const requests=await getIssuedIdentRequests(db,jobId,ident);
  if(requests.length)throw fail('This ident cannot be changed because it is used on issued requests: '+requests.map(r=>r.requisition_no).join(', ')+'.');
}
export async function renameItemIdent(db, {jobId,itemId,oldIdent,newIdent,userId,auditLog}) {
  const next=String(newIdent||'').trim();
  if(!next || next.length>200 || /[\x00-\x1f\x7f]/.test(next)) throw fail('Enter a new ident of 1–200 characters without line breaks or control characters.');
  await db.query('select id from jobs where id=$1 for update',[jobId]);
  const item=(await db.query('select * from material_items where id=$1 and job_id=$2 for update',[itemId,jobId])).rows[0];
  if(!item)throw fail('Item not found in the current job.');
  if(item.item_code!==oldIdent)throw fail('This ident changed after you opened the form. Reload Item Master.');
  if(item.item_code===next)throw fail('Enter a different ident.');
  const old=item.item_code;
  await assertIdentNotIssued(db,jobId,old);
  if((await db.query('select id from material_items where job_id=$1 and id<>$2 and (lower(btrim(item_code))=lower($3) or lower(btrim(item_code))=lower($4)) limit 1',[jobId,itemId,old,next])).rows.length)throw fail('Another item already uses the old or new ident in this job. Resolve the duplicate before renaming.');
  if(old.toLowerCase()!==next.toLowerCase()) {
    for(const [table,column,scope] of identTargets) {
      if((await db.query(`select 1 from ${table} where ${scope} and lower(btrim(${column}))=lower($2) limit 1`,[jobId,next])).rows.length)throw fail('The new ident is already used in this job. Choose an unused ident; items cannot be merged by renaming.');
    }
  }
  const affected={};
  for(const [table,column,scope] of identTargets) {
    const linked = ['rfq_items','po_lines'].includes(table) ? ' or material_item_id=$4' : '';
    const params=linked?[jobId,old,next,itemId]:[jobId,old,next];
    const result=await db.query(`update ${table} set ${column}=$3 where ${scope} and (lower(btrim(${column}))=lower(btrim($2))${linked}) returning id`,params);
    affected[table+'.'+column]=result.rows.length;
  }
  await db.query('update inventory_audit_reports set ident_filter=$3 where job_id=$1 and lower(btrim(ident_filter))=lower(btrim($2))',[jobId,old,next]);
  await db.query('update material_items set item_code=$3,updated_at=now() where id=$1 and job_id=$2',[itemId,jobId,next]);
  await auditLog(db,userId,'rename_ident','material_item',itemId,JSON.stringify({old_ident:old,new_ident:next,affected}));
  return next;
}
export function registerItemIdentRoutes(app,d) {
  const {query,withTransaction,requireAuth,requireJobContext,requirePermission,asyncHandler,currentJobId,layout,esc,signSession,readSession,auditLog}=d;
  const middleware=[requireAuth,requireJobContext,requirePermission('inventory','edit')];
  app.get('/items/:id/change-ident',...middleware,asyncHandler(async(req,res)=>{
    const item=(await query('select * from material_items where id=$1 and job_id=$2',[req.params.id,currentJobId(req)])).rows[0];
    if(!item)throw fail('Item not found in the current job.');
    await assertIdentNotIssued({query},currentJobId(req),item.item_code);
    const token=signSession({scope:'change_item_ident',item_id:Number(item.id),job_id:currentJobId(req),user_id:req.user.id,old_ident:item.item_code,expires:Date.now()+3600000});
    res.send(layout('Change Ident',`<h1>Change Ident</h1><div class="card"><p><strong>${esc(item.item_code)}</strong> — ${esc(item.description)}</p><p>This updates this item's ident throughout the current job, including BOMs, RFQs, POs, receiving, inventory, and reports. Quantities, request links, and item photos stay attached.</p><form method="post" action="/items/${item.id}/change-ident" class="stack"><input type="hidden" name="token" value="${esc(token)}"><label>New Ident</label><input name="new_ident" required maxlength="200" autocomplete="off"><div class="actions"><button>Change Ident</button><a class="btn btn-secondary" href="/items/${item.id}/edit">Cancel</a></div></form></div>`,req.user));
  }));
  app.post('/items/:id/change-ident',...middleware,asyncHandler(async(req,res)=>{
    const data=readSession(String(req.body.token||''));
    if(!data||data.scope!=='change_item_ident'||data.item_id!==Number(req.params.id)||data.job_id!==currentJobId(req)||data.user_id!==req.user.id||data.expires<Date.now())throw fail('This rename form expired or is invalid. Reload Item Master.');
    const next=await withTransaction(db=>renameItemIdent(db,{jobId:data.job_id,itemId:data.item_id,oldIdent:data.old_ident,newIdent:req.body.new_ident,userId:req.user.id,auditLog}));
    res.redirect('/items?q='+encodeURIComponent(next)+'&ident_changed=1');
  }));
}
