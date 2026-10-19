import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

test('PO edit shows actual net receipts by line, outstanding quantities, and partial/full actions',async(t)=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const name of fs.readdirSync(new URL('../db/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())
    await db.exec(fs.readFileSync(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await db.exec(`insert into jobs(id,job_number) values(101,'A'),(102,'B');
    insert into vendors(id,name,categories) values(100,'Supplier','pipe');
    insert into material_items(id,job_id,item_code,description,material_type,uom) values(1001,101,'PIPE','Pipe','pipe','EA');
    insert into purchase_orders(id,job_id,po_no,vendor_id) values(1201,101,'PO-A',100);
    insert into po_lines(id,job_id,po_id,material_item_id,po_line,qty_ordered,unit_price) values
      (1301,101,1201,1001,'1',90,10),(1302,101,1201,1001,'2',90,10),
      (1303,101,1201,1001,'3',90,10),(1304,101,1201,1001,'4',90,10);
    insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values
      (101,1301,30,'Yard','A','OK'),(101,1301,-10,'Yard','A','OK'),
      (101,1302,90,'Yard','A','OK'),(101,1304,95,'Yard','A','OVERAGE'),
      (102,1301,700,'Other','B','OK');`);
  const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start=source.indexOf('app.get("/po/:id/edit"'),end=source.indexOf('app.post("/po/:id/edit"',start);
  let handler;
  const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const context=vm.createContext({app:{get(...args){handler=args.at(-1);}},query:(sql,params)=>db.query(sql,params),
    requireAuth(){},requireJobContext(){},requirePermission(){},currentJobId:()=>101,
    esc,escAttr:esc,formatQtyDisplay:String,formatPlainNumberDisplay:String,formatShortDateTime:()=>'',layout:(_title,body)=>body});
  vm.runInContext(source.slice(start,end),context);
  async function render(){let html;await handler({params:{id:1201},user:{}},{send(value){html=value;}});return html;}
  function row(html,line){const match=(html.match(/<tr>[\s\S]*?<\/tr>/g)||[]).find(r=>r.startsWith('<tr>\n    <td>'+line+'</td>'));assert.ok(match);return [...match.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m=>m[1].replace(/<[^>]+>/g,''));}
  let html=await render();
  assert.match(html,/<th>Qty Ordered<\/th><th>Qty Received<\/th><th>Qty Remaining<\/th>/);
  assert.deepEqual(row(html,1).slice(7,10),['90','20','70']);assert.match(row(html,1)[11],/Partially Received/);
  assert.deepEqual(row(html,2).slice(7,10),['90','90','0']);assert.match(row(html,2)[11],/Fully Received/);
  assert.deepEqual(row(html,3).slice(7,10),['90','0','90']);assert.match(row(html,3)[11],/Delete Line/);
  assert.deepEqual(row(html,4).slice(7,10),['90','95','0']);assert.match(row(html,4)[11],/Fully Received/);
  await db.query("insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1302,-10,'Yard','A','OK')");
  html=await render();assert.deepEqual(row(html,2).slice(7,10),['90','80','10']);assert.match(row(html,2)[11],/Partially Received/);
});
