import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {outstandingReservationSql} from '../src/requisition-loads.js';

test('reservation drilldown matches outstanding active demand and isolates jobs/items', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create table material_requisitions(id int primary key,job_id int,bom_id int,requisition_no text,status text,requested_by_name text,issued_to text);
    create table bom_headers(id int primary key,bom_name text,bom_no text);
    create table bom_lines(id int primary key,item_code text,uom text);
    create table material_requisition_lines(id int primary key,requisition_id int,bom_line_id int,qty_requested numeric);
    create table material_issue_transactions(requisition_line_id int,qty_issued numeric);
    insert into bom_headers values(1,'Supports','BOM-1');
    insert into bom_lines values(1,'204P2','EA'),(2,'OTHER','EA');
    insert into material_requisitions values
      (1,10,1,'GR-PT-0001','ACCEPTED','A','Crew'),
      (2,10,1,'GR-PT-0002','LOADED','B','Crew'),
      (3,10,1,'CANCELLED','CANCELLED','C','Crew'),
      (4,20,1,'OTHER JOB','ACCEPTED','D','Crew'),
      (5,10,1,'FULLY ISSUED','ACCEPTED','E','Crew'),
      (6,10,1,'DRAFT','DRAFT','F','Crew');
    insert into material_requisition_lines values
      (1,1,1,30),(2,1,1,6),(3,2,1,10),(4,3,1,100),
      (5,4,1,200),(6,5,1,5),(7,6,1,100),(8,1,2,500);
    insert into material_issue_transactions values(1,4),(3,6),(6,5);
  `);
  const source = fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start = source.indexOf('app.get("/requisitions/reservations",');
  const end = source.indexOf('app.get("/requisitions/new",',start);
  let handler, html;
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  vm.runInNewContext(source.slice(start,end), {
    app:{get(...args){handler=args.at(-1);}}, requireAuth(){},requireJobContext(){},requirePermission(){},
    asyncHandler:fn=>fn,currentJobId:()=>10,query:(sql,params)=>db.query(sql,params),
    outstandingReservationSql,esc,formatQtyDisplay:String,layout:(_title,body)=>body
  });
  const res={set(){},send(value){html=value;}};
  await handler({query:{item_code:'204P2'},user:{}},res);
  assert.match(html,/href="\/requisitions\/1"/);
  assert.match(html,/<td>32<\/td>/);
  assert.match(html,/<td>4<\/td>/);
  for(const excluded of ['CANCELLED','OTHER JOB','FULLY ISSUED','DRAFT']) assert.ok(!html.includes(excluded));
  await handler({query:{item_code:"204P2' OR 1=1 --"},user:{}},res);
  assert.match(html,/No active requests are reserving this item/);
  await handler({query:{item_code:'<script>'},user:{}},res);
  assert.ok(!html.includes('<script>'));
  assert.match(html,/&lt;script>/);
  await db.exec("alter table bom_lines add column description text; update bom_lines set description='Plate support' where id=1");
  await db.exec(`
    alter table bom_headers add column job_id int;
    alter table bom_headers add column description text;
    alter table bom_headers add column status text;
    update bom_headers set job_id=10,status='ACTIVE';
    alter table bom_lines add column bom_id int;
    alter table bom_lines add column line_no text;
    alter table bom_lines add column size_1 text;
    alter table bom_lines add column size_2 text;
    alter table bom_lines add column qty_required numeric default 0;
    alter table bom_lines add column qty_issued numeric default 0;
    update bom_lines set bom_id=1;
    insert into bom_headers(id,bom_name,bom_no,job_id,status) values
      (2,'Pipe Rack','BOM-2',10,'DRAFT'),(3,'Hidden BOM','OTHER-BOM',20,'ACTIVE');
    insert into bom_lines(id,item_code,uom,description,bom_id,line_no,qty_required,qty_issued) values
      (3,'250B1','EA','Beam no receipt',2,'PAX-520',8,0),
      (4,'250B1','EA','Beam no receipt',1,'PAX-525',3,0),
      (5,'250B1','EA','Beam no receipt',3,'OTHER',99,0);
  `);
  const historyStart = source.indexOf('app.get("/yard/item-history",');
  const historyEnd = source.indexOf('app.get("/yard/locations",', historyStart);
  vm.runInNewContext(source.slice(historyStart,historyEnd), {
    app:{get(...args){handler=args.at(-1);}},requireAuth(){},requireJobContext(){},requireRole(){},adminEquivalentRoles:[],requirePermission(){},
    asyncHandler:fn=>fn,currentJobId:()=>10,
    query:(sql,params)=>sql.includes(') item_history') ? Promise.resolve({rows:[]}) : db.query(sql,params),
    getCurrentOnHandRows:async()=>[],receiptAffectsInventorySql:()=> 'true',
    formatCombinedSize:(a,b)=>[a,b].filter(Boolean).join(" x "),
    outstandingReservationSql,esc,formatQtyDisplay:String,layout:(_title,body)=>body
  });
  await handler({query:{item:'204p2'},user:{}},res);
  assert.match(html,/Reserved Quantities/);
  assert.match(html,/reservations\?item_code=204P2[^>]*>36<\/a>/);
  assert.match(html,/href="\/requisitions\/1"/);
  assert.match(html,/<td>32<\/td>/);
  assert.match(html,/<td>4<\/td>/);
  assert.ok(!html.includes('OTHER JOB'));
  await handler({query:{item:'Plate support'},user:{}},res);
  assert.match(html,/reservations\?item_code=204P2[^>]*>36<\/a>/);
  await handler({query:{item:'unknown'},user:{}},res);
  assert.match(html,/No active reservations match that filter/);
  await handler({query:{item:'250b1'},user:{}},res);
  assert.match(html,/Matching BOM Lines/);
  assert.match(html,/href="\/bom\/2">Pipe Rack/);
  assert.match(html,/href="\/bom\/1">Supports/);
  assert.match(html,/<td>8<\/td>/);
  assert.ok(!html.includes('Hidden BOM'));
  assert.match(html,/No current inventory rows match/);
  await handler({query:{item:'Beam no receipt'},user:{}},res);
  assert.match(html,/Pipe Rack/);
  await handler({query:{item:'unknown'},user:{}},res);
  assert.match(html,/No BOM lines match that filter/);


});
