import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {registerMaterialPhotoRoutes} from '../src/routes/material-photos.js';

test('photo saves persist item, receiving and request targets and failures return JSON',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of fs.readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  await db.exec(`insert into jobs(id,job_number) values(101,'A'),(102,'B');
    insert into users(id,username,password_hash,role) values(1,'photos','unused','warehouse');
    insert into material_items(id,job_id,item_code,description,material_type,uom) values(1,101,'BOLT','Bolt','steel','EA'),(2,102,'OTHER','Other','steel','EA');
    insert into bom_headers(id,job_id,job_number,bom_no,bom_type) values(1,101,'A','A-BOM','steel');
    insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_name) values(1,101,'A-PT-0001',1,'Crew');
    insert into mrr_logs(id,job_id,mrr_number) values(1,101,'MRR-1');`);
  const app=express();let deny=false;
  registerMaterialPhotoRoutes(app,{
    asyncHandler:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),
    requireAuth:(req,_res,next)=>{req.user={id:1,job_id:101,role:'warehouse'};next();},requireJobContext:(_req,_res,next)=>next(),
    currentJobId:()=>101,canAccess:()=>!deny,canEditInventoryAudit:()=>!deny,
    query:(sql,params)=>db.query(sql,params),withTransaction:fn=>db.transaction(fn),auditLog:async()=>{},
    get:async()=>({stream:{},blob:{contentType:'image/jpeg',size:100},url:'https://blob.example/photo.jpg',downloadUrl:'https://blob.example/download'}),
    esc:String,escAttr:String,formatShortDateTime:String
  });
  app.use((_err,_req,res,_next)=>res.status(500).send('<!doctype html>fallback'));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(scope,id=1)=>fetch(base+'/photos/'+scope+'/'+id+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pathname:'material-photos/job-101/'+scope+'/'+id+'/12345678-1234-4123-8123-123456789abc/photo.jpg',material_item_id:'1',caption:'Phone photo'})});
  for(const scope of ['item','mrr','requisition']) {const r=await post(scope);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).ok,true);}
  const saved=(await db.query('select * from material_photos order by id')).rows;
  assert.equal(saved.length,3);assert.equal(Number(saved[0].material_item_id),1);assert.equal(saved[0].process_type,'item');assert.equal(saved[0].caption,'Phone photo');assert.equal(Number(saved[1].mrr_log_id),1);assert.equal(Number(saved[2].requisition_id),1);
  let duplicate=await post('item');assert.equal(duplicate.status,400);assert.match((await duplicate.json()).error,/Unable to save photo/);
  let r=await post('item',2);assert.equal(r.status,400);assert.match(r.headers.get('content-type'),/json/);assert.match((await r.json()).error,/not found/);
  deny=true;r=await post('item');assert.equal(r.status,400);assert.match((await r.json()).error,/permission/);
});

test('HTML upload failures show actionable messages instead of JSON syntax errors',async()=>{
  const source=fs.readFileSync(new URL('../public/material-photos.js',import.meta.url),'utf8');
  const context=vm.createContext({});vm.runInContext(source.slice(source.indexOf('async function readPhotoSaveResponse'),source.indexOf('document.querySelectorAll')),context);
  await assert.rejects(context.readPhotoSaveResponse({status:500,ok:false,text:async()=> '<!doctype html>error'}),/Unable to save photo.*500/);
  await assert.rejects(context.readPhotoSaveResponse({status:403,ok:false,text:async()=> '<html>Forbidden</html>'}),/permission/);
  await assert.rejects(context.readPhotoSaveResponse({status:200,redirected:true}),/Sign in/);
  await assert.rejects(context.readPhotoSaveResponse({status:400,ok:false,text:async()=>JSON.stringify({error:'Photo target missing'})}),/Photo target missing/);
  assert.equal((await context.readPhotoSaveResponse({status:200,ok:true,text:async()=>'{"ok":true}'})).ok,true);
});
