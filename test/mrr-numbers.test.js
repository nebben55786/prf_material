import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { reserveMrrNumber } from "../src/mrr-numbers.js";
import { PGlite } from "@electric-sql/pglite";
import {
  normalizeRequestPrefix,
  getDeliveryLocation,
  nextDeliveryRequestNumber,
} from "../src/delivery-locations.js";
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of fs
    .readdirSync(new URL("../db/migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      fs.readFileSync(
        new URL("../db/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  await db.exec(
    "insert into jobs(id,job_number) values(101,'A'),(102,'B'); insert into delivery_locations(id,job_id,name,request_prefix) values(100,101,'Memphis','MH-MR'),(101,101,'Remote','GR-MR'),(102,102,'Other Job','OTHER-MR');",
  );
  return db;
}
test("simultaneous PO and manual MRR forms reserve different numbers and save their displayed numbers",async(t)=>{
  const db = await fixture(t);
  const bcrypt = (await import("bcryptjs")).default;
  await db.query(
    "insert into users(id,username,password_hash,role) values(100,'mrr-number-tester',$1,'admin')",
    [await bcrypt.hash("test-password", 4)],
  );
  await db.exec(
    "insert into vendors(id,name,categories) values(100,'Supplier','pipe');insert into material_items(id,job_id,item_code,description,material_type,uom) values(1001,101,'PIPE','Pipe','pipe','EA');insert into purchase_orders(id,job_id,po_no,vendor_id) values(1201,101,'PO-A',100);insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered) values(1301,101,1201,1001,20);insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,20,'Yard','BIN','OK');insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1501,101,'A','A-BOM','pipe','ACTIVE');insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1601,1501,'1','PIPE','Pipe','EA',10);",
  );
  const root = new URL("../src/", import.meta.url),
    stub = new URL(".mrr-number-test-db-" + process.pid + ".mjs", root),
    serverFile = new URL(".mrr-number-test-server-" + process.pid + ".mjs", root);
  const old = process.env.VERCEL;
  process.env.VERCEL = "1";
  globalThis.__mrrNumberTestDb = db;
  fs.writeFileSync(
    stub,
    `const db=globalThis.__mrrNumberTestDb; export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};export const pool={query};export const initDb=async()=>{};export const withTransaction=fn=>db.transaction(fn);export const auditLog=async(db,u,a,type,id,details)=>db.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",[u,a,type,String(id||''),details]);export let vendorCategories=['pipe'];export let permissionMatrix={};export const setVendorCategories=x=>vendorCategories=x;export const setPermissionMatrix=x=>permissionMatrix=x;`,
  );
  fs.writeFileSync(
    serverFile,
    fs
      .readFileSync(new URL("server.js", root), "utf8")
      .replace('from "./db.js";', "from " + JSON.stringify(stub.href) + ";"),
  );
  let listener;
  t.after(async () => {
    if (listener) { listener.closeAllConnections(); await new Promise((resolve) => listener.close(resolve)); }
    fs.rmSync(stub, { force: true });
    fs.rmSync(serverFile, { force: true });
    if (old === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = old;
    delete globalThis.__mrrNumberTestDb;
  });
  const app = (await import(serverFile.href)).default;
  listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = "http://127.0.0.1:" + listener.address().port;
  let cookie = "";
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
    });
    for (const header of response.headers.getSetCookie())
      if (header.startsWith("session_token=")) cookie = header.split(";")[0];
    return response;
  };
  assert.equal(
    (
      await request("/login", {
        username: "mrr-number-tester",
        password: "test-password",
      })
    ).status,
    302,
  );
  assert.equal((await request("/jobs/select", { job_id: "101" })).status, 302);

  await db.exec("update po_lines set qty_ordered=100 where id=1301;insert into warehouses(id,job_id,name) values(1901,101,'Yard');insert into warehouse_locations(job_id,warehouse_id,name) values(101,1901,'BIN');insert into mrr_logs(job_id,mrr_number) values(101,'MRR-000072');");
  const firstCookie=cookie;
  await db.query("insert into users(id,username,password_hash,role) values(101,'second-receiver',$1,'admin')",[await bcrypt.hash('test-password',4)]);
  await request('/login',{username:'second-receiver',password:'test-password'});
  await request('/jobs/select',{job_id:'101'});
  const secondCookie=cookie;
  async function send(path,body,session){return fetch(base+path,{method:body?'POST':'GET',redirect:'manual',headers:{Cookie:session,...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined});}
  const forms=await Promise.all([send('/po/1201/receive',null,firstCookie),send('/material-logs/mrr/new',null,secondCookie)]);
  const html=await Promise.all(forms.map(r=>r.text()));
  const fields=html.map(h=>({mrr_number:h.match(/name="mrr_number" value="([^"]+)"/)[1],mrr_number_token:h.match(/name="mrr_number_token" value="([^"]+)"/)[1]}));
  assert.equal(new Set(fields.map(f=>f.mrr_number)).size,2);
  assert.deepEqual(fields.map(f=>f.mrr_number).sort(),['MRR-000073','MRR-000074']);
  assert.match(html[0],/name="mrr_number"[^>]*readonly/);
  // Commit in reverse order: manual entry keeps its displayed number, then the PO receipt keeps its own.
  const manual=await send('/material-logs/mrr/add',{...fields[1],vendor_name:'Supplier',received_by:'Receiver B',received_date:'2026-10-21',load_number:'MANUAL'},secondCookie);
  assert.equal(manual.status,302,await manual.text());
  const receipt=await send('/po/1201/receive',{...fields[0],received_by:'Receiver A',received_date:'2026-10-21',load_number:'PO-LOAD',po_line_ids:'1301',qty_received_1301:'2',warehouse_1301:'Yard',location_1301:'BIN',short_action_1301:'not_on_load'},firstCookie);
  assert.equal(receipt.status,302,await receipt.text());
  const saved=(await db.query("select mrr_number,load_number from mrr_logs where load_number in ('MANUAL','PO-LOAD')")).rows;
  assert.equal(saved.find(r=>r.load_number==='MANUAL').mrr_number,fields[1].mrr_number);
  assert.equal(saved.find(r=>r.load_number==='PO-LOAD').mrr_number,fields[0].mrr_number);
  const posted=(await db.query('select m.mrr_number,sum(r.qty_received) as qty from receipts r join mrr_logs m on m.id=r.mrr_log_id where m.mrr_number=$1 group by m.mrr_number',[fields[0].mrr_number])).rows[0];
  assert.equal(Number(posted.qty),2);
  // Two independent receiver sessions can also post against the same PO at once.
  const poForms=await Promise.all([send('/po/1201/receive',null,firstCookie),send('/po/1201/receive',null,secondCookie)]);
  const poHtml=await Promise.all(poForms.map(r=>r.text()));
  const poFields=poHtml.map(h=>({mrr_number:h.match(/name="mrr_number" value="([^"]+)"/)[1],mrr_number_token:h.match(/name="mrr_number_token" value="([^"]+)"/)[1]}));
  assert.notEqual(poFields[0].mrr_number,poFields[1].mrr_number);
  const poPosts=await Promise.all(poFields.map((f,i)=>send('/po/1201/receive',{...f,received_by:'Receiver '+i,received_date:'2026-10-21',load_number:'PARALLEL-'+i,po_line_ids:'1301',qty_received_1301:'1',warehouse_1301:'Yard',location_1301:'BIN',short_action_1301:'not_on_load'},i===0?firstCookie:secondCookie)));
  for(const response of poPosts)assert.equal(response.status,302,await response.text());
  assert.equal(Number((await db.query("select count(*) as n from mrr_logs where load_number like 'PARALLEL-%'")).rows[0].n),2);
  // A repeated submit of a posted reservation must not create a second MRR or duplicate inventory.
  assert.equal((await send('/material-logs/mrr/add',fields[1],secondCookie)).status,409);
  // Stale forms opened before the fix get a fresh number, without rejecting the entered receipt.
  const stale=await send('/po/1201/receive',{mrr_number:'MRR-000072',received_by:'Receiver A',received_date:'2026-10-21',load_number:'STALE-FORM',po_line_ids:'1301',qty_received_1301:'1',warehouse_1301:'Yard',location_1301:'BIN',short_action_1301:'not_on_load'},firstCookie);
  assert.equal(stale.status,302,await stale.text());
  assert.notEqual((await db.query("select mrr_number from mrr_logs where load_number='STALE-FORM'")).rows[0].mrr_number,'MRR-000072');
  // One receiver cannot claim another receiver's reserved number with a copied token.
  const third=await send('/material-logs/mrr/new',null,firstCookie);const thirdHtml=await third.text();
  const reserved=thirdHtml.match(/name="mrr_number" value="([^"]+)"/)[1];const token=thirdHtml.match(/name="mrr_number_token" value="([^"]+)"/)[1];
  const copied=await send('/material-logs/mrr/add',{mrr_number:reserved,mrr_number_token:token,load_number:'COPIED-TOKEN'},secondCookie);assert.equal(copied.status,302);
  assert.notEqual((await db.query("select mrr_number from mrr_logs where load_number='COPIED-TOKEN'")).rows[0].mrr_number,reserved);
});

test('MRR reservations are atomic across sessions, independent by job, and advance beyond imported numbers',async(t)=>{
  const db=await fixture(t);
  await db.query("insert into mrr_logs(job_id,mrr_number) values(101,'MRR-000072')");
  const numbers=await Promise.all(Array.from({length:12},()=>reserveMrrNumber(db,101)));
  assert.equal(new Set(numbers).size,12);
  assert.equal(numbers[0],'MRR-000073');assert.equal(numbers.at(-1),'MRR-000084');
  assert.equal(await reserveMrrNumber(db,102),'MRR-000001');
  // Abandoned form reservations are committed and never reissued.
  assert.equal(await reserveMrrNumber(db,101),'MRR-000085');
  await db.query("insert into mrr_logs(job_id,mrr_number) values(101,'MRR-000200')");
  assert.equal(await reserveMrrNumber(db,101),'MRR-000201');
  assert.equal(await reserveMrrNumber(db,101),'MRR-000202');
});
