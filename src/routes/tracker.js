import fs from 'node:fs';
import {createTrackerService,trackerDocument,trackerError,lockTrackerJob,nextTrackerNumber,seedTrackerCounter} from '../tracker.js';
import {renderTrackerPage,renderTrackerContacts} from '../tracker-view.js';
import {buildTrackerPdf} from '../tracker-pdf.js';
const reference=JSON.parse(fs.readFileSync(new URL('../tracker-reference.json',import.meta.url),'utf8'));

export function registerTrackerRoutes(app,d) {
  const {query,withTransaction,requireAuth,requireJobContext,requirePermission,asyncHandler,currentJobId,layout,canAccess,signSession,readSession,auditLog}=d;
  const service=createTrackerService(d),base='/tracker';
  const auth=[requireAuth,requireJobContext];
  const kind=req=>req.params.kind;
  const section=k=>k==='receiving'?'receiving':'requisitions';
  const access=action=>(req,res,next)=>{
    if(!['receiving','issuing'].includes(kind(req)))return next(trackerError('Unknown tracker page.',404));
    requirePermission(section(kind(req)),action==='create'&&kind(req)==='receiving'?'edit':action)(req,res,next);
  };
  const token=req=>signSession({scope:'tracker',job_id:currentJobId(req),user_id:req.user.id,expires:Date.now()+12*3600000});
  function mutation(req,_res,next) {
    const t=readSession(String(req.get('X-Tracker-Token')||req.body?.token||''));
    if(!t||t.scope!=='tracker'||t.job_id!==currentJobId(req)||t.user_id!==req.user.id||t.expires<Date.now())return next(trackerError('This tracker session expired. Reload the page.',403));
    next();
  }
  const json=handler=>asyncHandler(async(req,res)=>{
    try{res.set('Cache-Control','private, no-store');res.json(await handler(req));}
    catch(e){res.status(e.statusCode||(e.code==='23505'?409:400)).json({error:e.code==='23505'?'That number or contact already exists in this job.':e.message});}
  });
  async function lists(jobId,user) {
    const [items,vendors,locations,contacts,lookups,destinations]=await Promise.all([
      query('select id,item_code,description,size_1,size_2,thk_1,thk_2,uom,material_type from material_items where job_id=$1 order by item_code',[jobId]),
      canAccess(user,'receiving','view')?query('select id,name from vendors order by name'):Promise.resolve({rows:[]}),
      query('select w.name as warehouse,l.name as location from warehouse_locations l join warehouses w on w.id=l.warehouse_id where l.job_id=$1 and w.job_id=$1 and w.is_active and l.is_active order by w.name,l.name',[jobId]),
      query('select * from tracker_contacts where job_id=$1 order by day_contact',[jobId]),
      query('select kind,value from material_log_lookup_values where job_id=$1 order by kind,value',[jobId]),
      query('select name from delivery_locations where job_id=$1 and is_active order by name',[jobId])
    ]);
    return {items:items.rows,vendors:vendors.rows,locations:locations.rows,contacts:contacts.rows,lookups:lookups.rows,destinations:destinations.rows};
  }
  app.get(base,...auth,(req,res)=>res.redirect(base+(canAccess(req.user,'receiving','view')?'/receiving':'/issuing')));
  app.get(base+'/:kind',...auth,access('view'),asyncHandler(async(req,res)=>{
    const jobId=currentJobId(req),k=kind(req);
    const documents=(await query(`select * from tracker_documents where job_id=$1 and kind=$2 order by id desc`,[jobId,k])).rows;
    const selected=req.query.document?documents.find(x=>Number(x.id)===Number(req.query.document)):null;
    if(req.query.document&&!selected)throw trackerError('Document not found in this job.',404);
    const rows=await service.rows({query},jobId,selected?.id||null,k);
    const setup=(await query('select * from tracker_setup where job_id=$1',[jobId])).rows[0];
    const job=(await query('select * from jobs where id=$1',[jobId])).rows[0];
    const state={kind:k,job,documents,selected,rows,lists:await lists(jobId,req.user),token:token(req),setup:!!setup,referenceJob:reference.job_number,
      edit:canAccess(req.user,section(k),'edit'),create:canAccess(req.user,section(k),k==='receiving'?'edit':'create'),issue:canAccess(req.user,'requisitions','issue'),contactsEdit:canAccess(req.user,'settings','edit'),canReceive:canAccess(req.user,'receiving','view'),canIssue:canAccess(req.user,'requisitions','view')};
    res.set('Cache-Control','private, no-store');res.send(layout('Job Material Tracker',renderTrackerPage(state),req.user));
  }));
  app.get(base+'/:kind/lookups',...auth,access('view'),json(req=>lists(currentJobId(req),req.user)));
  app.post(base+'/:kind/documents',...auth,access('create'),mutation,json(req=>withTransaction(async db=>{
    const jobId=currentJobId(req),k=kind(req);await lockTrackerJob(db,jobId);
    const job=(await db.query('select job_number from jobs where id=$1',[jobId])).rows[0];
    if(job.job_number===reference.job_number && !(await db.query('select job_id from tracker_setup where job_id=$1',[jobId])).rows.length)throw trackerError('Import the reference contacts and number floors before creating this job’s first tracker document.');
    await seedTrackerCounter(db,jobId,k);
    const number=await nextTrackerNumber(db,jobId,k),data={};
    const doc=(await db.query('insert into tracker_documents(job_id,kind,number,data,created_by) values($1,$2,$3,$4,$5) returning *',[jobId,k,number,JSON.stringify(data),req.user.id])).rows[0];
    await db.query('insert into tracker_rows(job_id,document_id) values($1,$2)',[jobId,doc.id]);
    await auditLog(db,req.user.id,'create','tracker_document',doc.id,number);return doc;
  })));
  app.post(base+'/:kind/documents/:id',...auth,access('edit'),mutation,json(req=>withTransaction(db=>service.saveDocument(db,{jobId:currentJobId(req),id:req.params.id,kind:kind(req),version:req.body.version,patch:req.body.patch||{},userId:req.user.id}))));
  app.post(base+'/:kind/documents/:id/rows',...auth,access('edit'),mutation,json(req=>withTransaction(async db=>{
    const jobId=currentJobId(req);await lockTrackerJob(db,jobId);const doc=await trackerDocument(db,jobId,req.params.id,kind(req));
    if(doc.cancelled)throw trackerError('This document is cancelled.');
    await db.query('update tracker_documents set version=version+1 where job_id=$1 and id=$2',[jobId,doc.id]);
    const row=(await db.query('insert into tracker_rows(job_id,document_id) values($1,$2) returning *',[jobId,doc.id])).rows[0];
    return (await service.rows(db,jobId,doc.id)).find(r=>r.id===row.id);
  })));
  app.post(base+'/:kind/documents/:id/rows/:rowId',...auth,access('edit'),mutation,json(req=>withTransaction(db=>service.saveRow(db,{jobId:currentJobId(req),documentId:req.params.id,kind:kind(req),id:req.params.rowId,version:req.body.version,patch:req.body.patch||{},userId:req.user.id}))));
  app.post(base+'/:kind/documents/:id/cancel',...auth,access('edit'),mutation,json(req=>withTransaction(async db=>{await service.cancel(db,{jobId:currentJobId(req),documentId:req.params.id,kind:kind(req),userId:req.user.id});return {ok:true};})));
  app.get(base+'/issuing/documents/:id/allocations',...auth,requirePermission('requisitions','issue'),json(async req=>{
    const jobId=currentJobId(req),doc=await trackerDocument({query},jobId,req.params.id,'issuing');
    const rows=await service.rows({query},jobId,doc.id),result=[];
    for(const row of rows)result.push({...row,sources:await service.sources({query},jobId,row.id)});
    return {document:doc,rows:result,postings:(await query('select * from tracker_postings where job_id=$1 and document_id=$2 order by id desc',[jobId,doc.id])).rows};
  }));
  app.post(base+'/issuing/documents/:id/reserve',...auth,requirePermission('requisitions','issue'),mutation,json(req=>withTransaction(async db=>{
    const jobId=currentJobId(req);await lockTrackerJob(db,jobId);await trackerDocument(db,jobId,req.params.id,'issuing');await service.reserve(db,jobId);return {ok:true};
  })));
  app.post(base+'/issuing/documents/:id/issue',...auth,requirePermission('requisitions','issue'),mutation,json(req=>withTransaction(db=>service.postIssue(db,{jobId:currentJobId(req),documentId:req.params.id,userId:req.user.id,requestKey:req.body.request_key,version:req.body.version,allocations:req.body.allocations,issuedDate:req.body.issued_date}))));
  app.post(base+'/issuing/documents/:id/reverse/:postingId',...auth,requirePermission('requisitions','issue'),mutation,json(req=>withTransaction(async db=>{await service.reverse(db,{jobId:currentJobId(req),documentId:req.params.id,postingId:req.params.postingId,userId:req.user.id});return {ok:true};})));
  app.get(base+'/issuing/documents/:id/pick-ticket.pdf',...auth,requirePermission('requisitions','view'),asyncHandler(async(req,res)=>{
    const jobId=currentJobId(req),doc=await trackerDocument({query},jobId,req.params.id,'issuing');
    const rows=await service.rows({query},jobId,doc.id),job=(await query('select * from jobs where id=$1',[jobId])).rows[0];
    res.set('Content-Type','application/pdf');res.set('Cache-Control','private, no-store');
    res.set('Content-Disposition',`inline; filename="${doc.number.replace(/[^\w-]/g,'_')}.pdf"`);
    res.send(buildTrackerPdf(doc,rows,job,d));
  }));
  app.get(base+'/contacts/list',...auth,requirePermission('requisitions','view'),asyncHandler(async(req,res)=>{
    res.send(layout('Tracker Contacts',renderTrackerContacts((await lists(currentJobId(req),req.user)).contacts,token(req),canAccess(req.user,'settings','edit')),req.user));
  }));
  app.post(base+'/contacts/save',...auth,requirePermission('settings','edit'),mutation,json(req=>withTransaction(async db=>{
    const jobId=currentJobId(req),b=req.body;await lockTrackerJob(db,jobId);
    const values=['day_contact','night_contact_1','night_contact_2'].map(k=>String(b[k]||'').trim());
    if(!values[0]||values.some(v=>v.length>300))throw trackerError('Enter a day contact; each contact must be at most 300 characters.');
    let row;
    if(b.id)row=(await db.query('update tracker_contacts set day_contact=$4,night_contact_1=$5,night_contact_2=$6,active=$7,version=version+1 where job_id=$1 and id=$2 and version=$3 returning *',[jobId,b.id,b.version,...values,b.active!==false])).rows[0];
    else row=(await db.query('insert into tracker_contacts(job_id,day_contact,night_contact_1,night_contact_2) values($1,$2,$3,$4) returning *',[jobId,...values])).rows[0];
    if(!row)throw trackerError('Contact changed. Reload before editing.',409);
    await auditLog(db,req.user.id,'update','tracker_contact',row.id,JSON.stringify(values));return row;
  })));
  app.post(base+'/reference/import',...auth,requirePermission('settings','edit'),mutation,json(req=>withTransaction(async db=>{
    const jobId=currentJobId(req);await lockTrackerJob(db,jobId);
    const job=(await db.query('select job_number from jobs where id=$1',[jobId])).rows[0];
    if(job.job_number!==reference.job_number)throw trackerError('This reference is for job '+reference.job_number+'. Select that job before importing.');
    if(!(await db.query('select job_id from tracker_setup where job_id=$1',[jobId])).rows.length) {
      for(const c of reference.contacts)await db.query('insert into tracker_contacts(job_id,day_contact,night_contact_1,night_contact_2) values($1,$2,$3,$4) on conflict do nothing',[jobId,c.day_contact,c.night_contact_1,c.night_contact_2]);
      for(const k of ['receiving','issuing'])await seedTrackerCounter(db,jobId,k,reference.floors[k]);
      await db.query('insert into tracker_setup(job_id,source) values($1,$2)',[jobId,reference.source]);
      await auditLog(db,req.user.id,'import','tracker_setup',jobId,'Day/night contacts and numbering floors only');
    }
    return {ok:true};
  })));
}
