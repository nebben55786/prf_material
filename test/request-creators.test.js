import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('request creator migration preserves requester names and backfills the linked creator',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 for(const file of fs.readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<'057').sort()) await db.exec(fs.readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
 await db.exec(`insert into jobs(id,job_number) values(101,'A');
 insert into users(id,username,password_hash,role,first_name,last_name) values(100,'creator','unused','admin','Ben','Pete');
 insert into bom_headers(id,job_id,job_number,bom_no,bom_type) values(1,101,'A','A-BOM','steel');
 insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_user_id,requested_by_name) values(1,101,'REQ-1',1,100,'Historical Requester'),(2,101,'REQ-2',1,null,'Legacy Name');`);
 const migration=fs.readFileSync(new URL('../db/migrations/057_request_creator.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
 const rows=(await db.query('select * from material_requisitions order by id')).rows;
 assert.equal(rows[0].requested_by_name,'Historical Requester');assert.equal(rows[0].created_by_name,'Ben Pete');assert.equal(Number(rows[0].created_by_user_id),100);
 assert.equal(rows[1].requested_by_name,'Legacy Name');assert.equal(rows[1].created_by_name,'');
});
