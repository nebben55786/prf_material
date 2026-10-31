const fail = message => Object.assign(new Error(message), {statusCode:400});
const qty = value => {
  const raw=String(value??'').trim(), n=Number(raw.replace(/,/g,''));
  if(!raw || !Number.isFinite(n) || n<0 || Math.abs(n*1e4-Math.round(n*1e4))>1e-5) throw fail('Enter an actual quantity of zero or greater, with at most four decimals.');
  return n;
};
export function registerLocationInventoryRoutes(app,d) {
  const {query,withTransaction,requireAuth,requireJobContext,requireInventoryAuditEdit,asyncHandler,currentJobId,layout,esc,signSession,readSession,getWarehouseOptions,getWarehouseLocationMap,normalizeWarehouseLocationValues,assertValidWarehouseLocation,getCurrentOnHandRows,buildInventoryEntryKey,saveInventoryAuditReport,upsertMaterialMasterItem,getVerifiedAllocatedInventoryTotalsByItem,auditLog}=d;
  const base='/yard/location-inventory', middleware=[requireAuth,requireJobContext,requireInventoryAuditEdit];
  const url=(storage,extra='')=>base+'?warehouse='+encodeURIComponent(storage.warehouse)+'&location='+encodeURIComponent(storage.location)+extra;
  function token(req,data) { return signSession({scope:'location_inventory',user_id:req.user.id,job_id:currentJobId(req),expires:Date.now()+4*60*60*1000,...data}); }
  function decode(req,value,stage) {
    const data=readSession(String(value||''));
    if(!data || data.scope!=='location_inventory' || data.user_id!==req.user.id || data.job_id!==currentJobId(req) || data.expires<Date.now() || data.stage!==stage) throw fail('This inventory form expired or is invalid. Reload the location.');
    return data;
  }
  async function rows(db,jobId,storage) {
    return getCurrentOnHandRows(db,{jobId,whereSql:"where lower(inventory_by_location.warehouse)=lower($1) and lower(inventory_by_location.location)=lower($2)",params:[storage.warehouse,storage.location]});
  }
  async function ensureItem(db,jobId,input,userId) {
    const existing=(await db.query('select * from material_items where job_id=$1 and lower(item_code)=lower($2)',[jobId,input.item_code])).rows[0];
    if(existing) return existing;
    const result=await upsertMaterialMasterItem(db,{...input,material_type:input.material_type||'misc',uom:input.uom||'EA'},jobId);
    if(result.status==='skipped') throw fail(result.message);
    await auditLog(db,userId,'create','material_item',result.id,input.item_code);
    return {...input,id:result.id};
  }
  app.get(base,...middleware,asyncHandler(async(req,res)=>{
    const jobId=currentJobId(req),storage=normalizeWarehouseLocationValues(req.query.warehouse,req.query.location);
    const [warehouses,locations]=await Promise.all([getWarehouseOptions(jobId),getWarehouseLocationMap(jobId)]);
    const selected=!!(storage.warehouse && storage.location);
    if(selected) await assertValidWarehouseLocation({query},storage.warehouse,storage.location,jobId);
    const current=selected?await rows({query},jobId,storage):[];
    const items=selected?(await query('select * from material_items where job_id=$1 order by lower(item_code),id',[jobId])).rows:[];
    const reserved=selected?await getVerifiedAllocatedInventoryTotalsByItem({query},jobId):[];
    const reservedMap=new Map(reserved.map(r=>[String(r.item_code).toLowerCase(),Number(r.qty_allocated_total)]));
    const formToken=token(req,{stage:'count',storage,rows:current});
    const photoId=Number(req.query.photo_item||0),photoItem=items.find(i=>Number(i.id)===photoId);
    const photos=photoItem?await req.app.locals.renderPhotoSectionForTarget(req,{scope:'item',targetId:photoId,namePrefix:photoItem.item_code,title:'Item Photos: '+photoItem.item_code,subtitle:'These photos stay attached to the item throughout this job.'}):'';
    res.send(layout('Location Inventory',`<h1>Location Inventory</h1>
      <div class="card"><form method="get" class="stack"><div class="grid">
      <div><label>Warehouse</label><select id="location-inventory-warehouse" name="warehouse" required onchange='syncLocationOptions("location-inventory-warehouse","location-inventory-location",${esc(JSON.stringify(locations))},"")'><option value="">Select warehouse</option>${warehouses.map(w=>`<option value="${esc(w.name)}" ${w.name===storage.warehouse?'selected':''}>${esc(w.name)}</option>`).join('')}</select></div>
      <div><label>Location</label><select id="location-inventory-location" name="location" required><option value="">Select location</option></select></div></div><div class="actions"><button>Load Inventory</button><a class="btn btn-secondary" href="/yard">Back To Yard</a></div></form></div>
      <script>syncLocationOptions("location-inventory-warehouse","location-inventory-location",${JSON.stringify(locations).replace(/</g,'\\u003c')},${JSON.stringify(storage.location).replace(/</g,'\\u003c')});</script>
      ${req.query.saved?'<div class="card">Inventory saved. Changes are recorded in Item History and Inventory Audit.</div>':''}
      ${selected?`<div class="card"><h3>${esc(storage.warehouse)} / ${esc(storage.location)}</h3>
      <p>Enter the actual final count. Blank leaves a row unchanged; 0 sets its count to zero. Reservations shown are totals across the job.</p>
      <form method="post" action="${base}/review" class="stack" data-location-inventory-draft="${esc(JSON.stringify([req.user.id,jobId,storage.warehouse,storage.location]))}" data-draft-version="${esc(JSON.stringify(current.map(r=>[buildInventoryEntryKey(r),r.qty_on_hand])))}" data-draft-saved="${req.query.saved ? "1":"0"}"><input type="hidden" name="token" value="${esc(formToken)}">
      <div class="scroll"><table><tr><th>Item</th><th>Description</th><th>Size / Thickness</th><th>UOM</th><th>Current Qty</th><th>Reserved Qty (Job)</th><th>Actual Qty</th><th>Photos</th></tr>
      ${current.map((r,i)=>{const item=items.find(m=>String(m.item_code).toLowerCase()===String(r.item_code).toLowerCase());return `<tr><td>${esc(r.item_code)}</td><td>${esc(r.description)}</td><td>${esc([r.size_1,r.size_2,r.thk_1,r.thk_2].filter(Boolean).join(' / '))}</td><td>${esc(item?.uom||r.uom||'')}</td><td>${esc(r.qty_on_hand)}</td><td>${esc(reservedMap.get(String(r.item_code).toLowerCase())||0)}</td><td><input name="actual_${i}" inputmode="decimal" placeholder="Unchanged" aria-label="Actual quantity for ${esc(r.item_code)}"></td><td>${item?`<a class="btn btn-secondary" href="${url(storage,'&photo_item='+item.id)}#item-photos">Photos</a>`:`<button class="btn btn-secondary" type="submit" formaction="${base}/photo-item" name="photo_row" value="${i}">Photos</button>`}</td></tr>`;}).join('')||'<tr><td colspan="8">No inventory is recorded at this location.</td></tr>'}</table></div>
      <div class="card"><h3>Add Item to This Location</h3><p>Choose an existing item, or enter a new item below. Enter its final quantity at this location, including any quantity already there.</p>
      <div class="grid" data-existing-item-filters>
      <div><label>Filter Item Number</label><input name="existing_filter_code" data-item-filter="code" placeholder="Item number"></div>
      <div><label>Filter Description</label><input name="existing_filter_description" data-item-filter="description" placeholder="Description"></div>
      <div><label>Filter Size</label><input name="existing_filter_size" data-item-filter="size" placeholder="Size or thickness"></div></div>
      <div class="actions"><button type="button" class="btn btn-secondary" data-clear-item-filters>Clear Item Filters</button><span class="muted" data-item-match-count aria-live="polite"></span></div>
      <label>Existing Item</label><select name="item_id" data-existing-item-picker><option value="">Create new item</option>${items.map(i=>`<option value="${i.id}" data-code="${esc(i.item_code)}" data-description="${esc(i.description)}" data-size="${esc([i.size_1,i.size_2,i.thk_1,i.thk_2].filter(Boolean).join(' / '))}">${esc(i.item_code)} | ${esc(i.description)}${[i.size_1,i.size_2,i.thk_1,i.thk_2].some(Boolean)?' | '+esc([i.size_1,i.size_2,i.thk_1,i.thk_2].filter(Boolean).join(' / ')):''}</option>`).join('')}</select>
      <div class="grid"><div><label>New Item Code</label><input name="item_code"></div><div><label>Description</label><input name="description"></div><div><label>UOM</label><input name="uom" value="EA"></div><div><label>Type</label><select name="material_type"><option>misc</option><option>pipe</option><option>steel</option><option>equipment</option></select></div>${['size_1','size_2','thk_1','thk_2'].map(k=>`<div><label>${k.replace('_',' ')}</label><input name="${k}"></div>`).join('')}<div><label>Actual Quantity at Location</label><input name="add_qty" inputmode="decimal"></div></div></div>
      <button>Review Inventory Changes</button></form></div>`:''}
      <div id="item-photos">${photos}</div><script src="/public/location-inventory.js" defer></script><script src="/public/location-item-filter.js" defer></script>`,req.user));
  }));
  app.post(base+'/review',...middleware,asyncHandler(async(req,res)=>{
    const data=decode(req,req.body.token,'count'),jobId=currentJobId(req),changes=new Map();
    await assertValidWarehouseLocation({query},data.storage.warehouse,data.storage.location,jobId);
    data.rows.forEach((r,i)=>{if(String(req.body['actual_'+i]??'').trim()!=='') changes.set(buildInventoryEntryKey(r),{...r,actual_qty:qty(req.body['actual_'+i]),expected:Number(r.qty_on_hand)});});
    let added=null;
    if(String(req.body.add_qty??'').trim()!=='') {
      const actual=qty(req.body.add_qty),id=Number(req.body.item_id||0);
      if(id) {
        added=(await query('select * from material_items where id=$1 and job_id=$2',[id,jobId])).rows[0];
        if(!added) throw fail('Item not found for this job.');
      } else {
        added=Object.fromEntries(['item_code','description','uom','material_type','size_1','size_2','thk_1','thk_2'].map(k=>[k,String(req.body[k]||'').trim()]));
        if(!added.item_code || !added.description || !added.uom) throw fail('Enter a new item code, description, and UOM.');
        if((await query('select id from material_items where job_id=$1 and lower(item_code)=lower($2)',[jobId,added.item_code])).rows.length) throw fail('That item already exists. Select it from Existing Item.');
        added.is_new=true;
      }
      const row={...added,...data.storage},key=buildInventoryEntryKey(row),existing=data.rows.find(r=>buildInventoryEntryKey(r)===key);
      if(changes.has(key)) throw fail('This item is already being adjusted in the table. Enter its final count there.');
      changes.set(key,{...row,actual_qty:actual,expected:Number(existing?.qty_on_hand||0)});
    }
    const desired=[...changes.values()].filter(r=>r.actual_qty!==r.expected || r.is_new);
    if(!desired.length) throw fail('Enter at least one changed actual quantity or add an item.');
    const allStock=await getCurrentOnHandRows({query},{jobId}),reservationRows=await getVerifiedAllocatedInventoryTotalsByItem({query},jobId);
    const warnings=[];
    for(const reserve of reservationRows) {
      const code=String(reserve.item_code).toLowerCase();
      const deltas=desired.filter(r=>String(r.item_code).toLowerCase()===code).reduce((n,r)=>n+r.actual_qty-r.expected,0);
      if(!desired.some(r=>String(r.item_code).toLowerCase()===code)) continue;
      const total=allStock.filter(r=>String(r.item_code).toLowerCase()===code).reduce((n,r)=>n+Number(r.qty_on_hand),0)+deltas;
      if(total<Number(reserve.qty_allocated_total)) warnings.push(reserve.item_code+': resulting stock '+total+' is below reserved quantity '+reserve.qty_allocated_total+'. Review affected requests.');
    }
    const reviewToken=token(req,{stage:'review',storage:data.storage,rows:desired});
    res.send(layout('Review Inventory Changes',`<h1>Review Inventory Changes</h1><div class="card"><p>${esc(data.storage.warehouse)} / ${esc(data.storage.location)}</p><p>These changes adjust stock directly without receipts, POs, or MRRs.</p>${warnings.map(w=>`<p class="error">${esc(w)}</p>`).join('')}<div class="scroll"><table><tr><th>Item</th><th>Current</th><th>Actual</th><th>Adjustment</th></tr>${desired.map(r=>`<tr><td>${esc(r.item_code)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual_qty)}</td><td>${esc(r.actual_qty-r.expected)}</td></tr>`).join('')}</table></div><form method="post" action="${base}/save"><input type="hidden" name="token" value="${esc(reviewToken)}"><div class="actions"><button>Save Inventory Changes</button><a class="btn btn-secondary" href="${url(data.storage)}">Back Without Saving</a></div></form></div>`,req.user));
  }));
  app.post(base+'/save',...middleware,asyncHandler(async(req,res)=>{
    const data=decode(req,req.body.token,'review'),jobId=currentJobId(req);
    let photoId;
    await withTransaction(async db=>{
      await db.query('select id from jobs where id=$1 for update',[jobId]);
      await assertValidWarehouseLocation(db,data.storage.warehouse,data.storage.location,jobId);
      const current=await rows(db,jobId,data.storage),map=new Map(current.map(r=>[buildInventoryEntryKey(r),Number(r.qty_on_hand)]));
      for(const r of data.rows) {
        if(Math.abs((map.get(buildInventoryEntryKey(r))||0)-r.expected)>0.00001) throw fail('Inventory changed since you loaded this location. Reload and review the current counts before saving.');
        if(r.is_new && (await db.query('select id from material_items where job_id=$1 and lower(item_code)=lower($2)',[jobId,r.item_code])).rows.length) throw fail('This item was created by another user. Reload and select the existing item.');
        const item=await ensureItem(db,jobId,r,req.user.id);photoId=item.id;
      }
      await saveInventoryAuditReport(db,{jobId,userId:req.user.id,warehouseFilter:data.storage.warehouse,locationFilter:data.storage.location,desiredRows:data.rows});
    });
    res.redirect(url(data.storage,'&saved=1&photo_item='+photoId)+'#item-photos');
  }));
  app.post(base+'/photo-item',...middleware,asyncHandler(async(req,res)=>{
    const data=decode(req,req.body.token,'count'),r=data.rows[Number(req.body.photo_row)];
    if(!r) throw fail('Inventory row not found.');
    const item=await withTransaction(async db=>{
      await db.query('select id from jobs where id=$1 for update',[currentJobId(req)]);
      return ensureItem(db,currentJobId(req),r,req.user.id);
    });
    res.redirect(url(data.storage,'&photo_item='+item.id)+'#item-photos');
  }));
}
