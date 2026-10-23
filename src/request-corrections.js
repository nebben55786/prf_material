function error(message) { return Object.assign(new Error(message), {statusCode:400}); }
function snapshot(lines) { return JSON.stringify(lines.map(r=>[String(r.id),String(r.qty_requested),String(r.qty_issued)])); }
export function registerRequestCorrectionRoutes(app,d) {
  const {query,withTransaction,requireAuth,requireJobContext,requirePermission,asyncHandler,currentJobId,isAdminRole,layout,esc,auditLog,assertNoRequisitionLoads,issueRequisitionToField}=d;
  const route='/requisitions/:id/correct-quantities';
  async function context(db,req,lock=false) {
    if(!isAdminRole(req.user)) throw error('Only admins and material controllers can correct issued quantities.');
    const h=(await db.query(`select * from material_requisitions where id=$1 and job_id=$2 ${lock?'for update':''}`,[req.params.id,currentJobId(req)])).rows[0];
    if(!h || h.status!=='ISSUED') throw error('Only issued requests can be corrected here.');
    await assertNoRequisitionLoads(db,h.id,currentJobId(req));
    if(h.signed_at || h.signed_copy_data || h.signed_signature_data) throw error('This request has a sign-off. Signed quantities cannot be changed through this editor.');
    const lines=(await db.query(`select mrl.*,bl.item_code,bl.description,bl.uom from material_requisition_lines mrl join bom_lines bl on bl.id=mrl.bom_line_id where mrl.requisition_id=$1 and mrl.job_id=$2 order by mrl.id`,[h.id,currentJobId(req)])).rows;
    return {h,lines};
  }
  const middleware=[requireAuth,requireJobContext,requirePermission('requisitions','issue')];
  app.get(route,...middleware,asyncHandler(async(req,res)=>{
    const {h,lines}=await context({query},req);
    res.send(layout('Correct Quantities',`<h1>Correct Quantities: ${esc(h.requisition_no)}</h1><div class="card">
      <p>Enter the corrected requested quantities and the quantities actually issued. Saving adjusts inventory and records the correction. This request stays Issued; any unissued balance is not reserved.</p>
      <form method="post" class="stack"><input type="hidden" name="snapshot" value="${esc(snapshot(lines))}">
      <div class="scroll"><table><tr><th>Item</th><th>Description</th><th>Requested Qty</th><th>Issued Qty</th><th>UOM</th></tr>
      ${lines.map(r=>`<tr><td>${esc(r.item_code)}</td><td>${esc(r.description)}</td><td><input type="number" min="0" step="0.0001" name="requested_${r.id}" value="${esc(r.qty_requested)}" required></td><td><input type="number" min="0" step="0.0001" name="issued_${r.id}" value="${esc(r.qty_issued)}" required></td><td>${esc(r.uom)}</td></tr>`).join('')}</table></div>
      <div><label>Correction Reason</label><textarea name="reason" maxlength="2000" required></textarea></div>
      <div class="actions"><button>Save Correction</button><a class="btn btn-secondary" href="/requisitions/${h.id}">Back</a></div></form></div>`,req.user));
  }));
  app.post(route,...middleware,asyncHandler(async(req,res)=>{
    await withTransaction(async db=>{
      const {h,lines}=await context(db,req,true),jobId=currentJobId(req);
      await db.query('select id from jobs where id=$1 for update',[jobId]);
      if(req.body.snapshot!==snapshot(lines)) throw error('Quantities changed since this page opened. Reload before correcting.');
      const reason=String(req.body.reason||'').trim();
      if(!reason || reason.length>2000) throw error('Enter a correction reason (maximum 2000 characters).');
      const next=lines.map(r=>{
        const read=key=>{const raw=String(req.body[key]??'').trim(),n=Number(raw);if(!raw || !Number.isFinite(n)||n<0||Math.abs(n*1e4-Math.round(n*1e4))>1e-5) throw error('Enter nonnegative quantities with at most four decimals.');return n;};
        const requested=read('requested_'+r.id),issued=read('issued_'+r.id);
        if(issued>requested) throw error('Issued quantity cannot exceed requested quantity for '+r.item_code);
        return {id:r.id,item_code:r.item_code,requested,issued};
      });
      const oldIssues=(await db.query('select * from material_issue_transactions where requisition_id=$1 and job_id=$2 order by id',[h.id,jobId])).rows;
      // Release the old posting inside this transaction before validating and posting its replacement.
      await db.query('delete from material_issue_transactions where requisition_id=$1 and job_id=$2',[h.id,jobId]);
      await db.query("update material_requisitions set status='ACCEPTED' where id=$1",[h.id]);
      for(const r of next) await db.query('update material_requisition_lines set qty_requested=$2,qty_issued=$3 where id=$1',[r.id,r.requested,r.issued]);
      await issueRequisitionToField(db,h.id,jobId,req.user.id);
      await db.query('update material_requisitions set issued_at=$2,issued_by_user_id=$3 where id=$1',[h.id,h.issued_at,h.issued_by_user_id]);
      await auditLog(db,req.user.id,'correct_quantities','material_requisition',h.id,JSON.stringify({request:h.requisition_no,reason,before:lines.map(r=>({id:r.id,item_code:r.item_code,requested:r.qty_requested,issued:r.qty_issued})),oldIssues,after:next}));
    });
    res.redirect('/requisitions/'+req.params.id);
  }));
}
