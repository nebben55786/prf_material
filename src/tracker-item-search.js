// Search the selected job's entire Item Master, not a browser-limited option list.
export async function searchTrackerItems(db,jobId,filters={}) {
  const params=[jobId],where=['job_id=$1'];
  const literal=value=>String(value??'').trim().slice(0,200).replace(/[\\%_]/g,'\\$&');
  const clauses=[
    ['q',"concat_ws(' ',item_code,description,size_1,size_2,thk_1,thk_2,material_type,uom)"],
    ['ident','item_code'],['description','description'],
    ['size',"concat_ws(' ',size_1,size_2,thk_1,thk_2)"]
  ];
  for(const [name,column] of clauses)for(const token of literal(filters[name]).split(/\s+/).filter(Boolean)){
    params.push('%'+token+'%');where.push(`${column} ilike $${params.length} escape E'\\\\'`);
  }
  if(String(filters.type||'').trim()){params.push(String(filters.type).trim().slice(0,200));where.push(`material_type=$${params.length}`);}
  const count=Number((await db.query('select count(*) as total from material_items where '+where.join(' and '),params)).rows[0].total);
  const limit=50,pages=Math.max(1,Math.ceil(count/limit));
  const requested=Number(filters.page),page=Number.isSafeInteger(requested)&&requested>0?Math.min(requested,pages):1;
  const rows=(await db.query(`select id,item_code,description,size_1,size_2,thk_1,thk_2,uom,material_type from material_items where ${where.join(' and ')} order by lower(item_code),id limit $${params.length+1} offset $${params.length+2}`,[...params,limit,(page-1)*limit])).rows;
  const types=(await db.query("select distinct material_type from material_items where job_id=$1 and coalesce(material_type,'')<>'' order by material_type",[jobId])).rows.map(r=>r.material_type);
  return {items:rows,total:count,page,pages,limit,types};
}

export function withTrackerItemStock(items,stockRows,available,keyForItem) {
  const locations=new Map();
  for(const row of stockRows){
    const key=keyForItem(row),warehouse=String(row.warehouse||'').trim(),location=String(row.location||'').trim();
    if(!locations.has(key))locations.set(key,new Map());
    const storageKey=JSON.stringify([warehouse.toLowerCase(),location.toLowerCase()]);
    const storage=locations.get(key).get(storageKey)||{warehouse,location,qty_on_hand:0};
    storage.qty_on_hand+=Number(row.qty_on_hand||0);locations.get(key).set(storageKey,storage);
  }
  const qty=value=>Math.round(Math.max(0,Number(value)||0)*10000)/10000;
  return items.map(item=>{
    const key=keyForItem(item);
    const stock_locations=[...(locations.get(key)?.values()||[])].map(s=>({...s,qty_on_hand:qty(s.qty_on_hand)})).filter(s=>s.qty_on_hand>0)
      .sort((a,b)=>a.warehouse.localeCompare(b.warehouse)||a.location.localeCompare(b.location));
    return {...item,qty_available:qty(available.get(key)),stock_locations};
  });
}
