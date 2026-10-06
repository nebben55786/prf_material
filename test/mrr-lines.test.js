import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
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
test("MRR lines can be deleted and added individually with PO and job isolation", async (t) => {
  const db = await fixture(t);
  const bcrypt = (await import("bcryptjs")).default;
  await db.query(
    "insert into users(id,username,password_hash,role) values(100,'delivery-tester',$1,'admin')",
    [await bcrypt.hash("test-password", 4)],
  );
  await db.exec(
    "insert into vendors(id,name,categories) values(100,'Supplier','pipe');insert into material_items(id,job_id,item_code,description,material_type,uom) values(1001,101,'PIPE','Pipe','pipe','EA');insert into purchase_orders(id,job_id,po_no,vendor_id) values(1201,101,'PO-A',100);insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered) values(1301,101,1201,1001,20);insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,20,'Yard','BIN','OK');insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1501,101,'A','A-BOM','pipe','ACTIVE');insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1601,1501,'1','PIPE','Pipe','EA',10);",
  );
  const root = new URL("../src/", import.meta.url),
    stub = new URL(".mrr-lines-test-db-" + process.pid + ".mjs", root),
    serverFile = new URL(".mrr-lines-test-server-" + process.pid + ".mjs", root);
  const old = process.env.VERCEL;
  process.env.VERCEL = "1";
  globalThis.__mrrLinesTestDb = db;
  fs.writeFileSync(
    stub,
    `const db=globalThis.__mrrLinesTestDb; export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};export const pool={query};export const initDb=async()=>{};export const withTransaction=fn=>db.transaction(fn);export const auditLog=async(db,u,a,type,id,details)=>db.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",[u,a,type,String(id||''),details]);export let vendorCategories=['pipe'];export let permissionMatrix={};export const setVendorCategories=x=>vendorCategories=x;export const setPermissionMatrix=x=>permissionMatrix=x;`,
  );
  fs.writeFileSync(
    serverFile,
    fs
      .readFileSync(new URL("server.js", root), "utf8")
      .replace('from "./db.js";', "from " + JSON.stringify(stub.href) + ";"),
  );
  let listener;
  t.after(async () => {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(stub, { force: true });
    fs.rmSync(serverFile, { force: true });
    if (old === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = old;
    delete globalThis.__mrrLinesTestDb;
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
        username: "delivery-tester",
        password: "test-password",
      })
    ).status,
    302,
  );
  assert.equal((await request("/jobs/select", { job_id: "101" })).status, 302);
  await db.exec(`
    insert into warehouses(id,job_id,name) values(1901,101,'Yard');
    insert into warehouse_locations(job_id,warehouse_id,name) values(101,1901,'BIN');
    insert into material_items(id,job_id,item_code,description,material_type,uom) values(1002,101,'VALVE','Valve','pipe','EA');
    insert into purchase_orders(id,job_id,po_no,vendor_id) values(1202,101,'OTHER-PO',100),(1203,102,'OTHER-JOB',100);
    insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered) values(1302,101,1201,1002,10),(1303,101,1202,1002,10),(1304,102,1203,1002,10);
    insert into mrr_logs(id,job_id,mrr_number,app_po_id,po_number) values(1801,101,'MRR-TEST',1201,'PO-A'),(1802,102,'MRR-OTHER',1203,'OTHER-JOB');
    update receipts set mrr_log_id=1801 where po_line_id=1301;
    insert into osd_logs(job_id,mrr_log_id,receipt_id,po_id,po_line_id) select 101,1801,id,1201,1301 from receipts where mrr_log_id=1801;
  `);
  const headerBody = {mrr_number:'MRR-TEST',app_po_id:'1201',received_date:'2026-10-06',received_by:'Nancy Bird',material_description:'Valves',notes:'Initial header note'};
  for (const notes of ['Initial header note','Updated header note','']) {
    const saved = await request('/material-logs/mrr/1801/edit',{...headerBody,notes});
    assert.equal(saved.status,302,await saved.text());
    assert.equal((await db.query('select notes from mrr_logs where id=1801')).rows[0].notes,notes);
    assert.equal(saved.headers.get('location'),'/material-logs/mrr/1801/edit?saved=1');
    const pdfResponse = await request('/material-logs/mrr/1801/form.pdf');
    assert.equal(pdfResponse.status,200);
    const pdf=Buffer.from(await pdfResponse.arrayBuffer()).toString('latin1');
    if (notes) assert.ok(pdf.includes(notes));
    else assert.ok(!pdf.includes('Updated header note'));
    const reloaded = await request('/material-logs/mrr/1801/edit');
    assert.match(await reloaded.text(),new RegExp('<textarea name="notes">'+notes+'</textarea>'));
  }
  const receiptId = (await db.query("select id from receipts where mrr_log_id=1801")).rows[0].id;
  const edit = await request('/material-logs/mrr/1801/edit');
  assert.equal(edit.status,200,await edit.clone().text());
  const html = await edit.text();
  assert.match(html,/Add MRR Line/);
  assert.match(html,/lines\/receipt\/.*\/delete/);
  const addPage = await request('/receive/1801');
  assert.equal(addPage.status,200);
  assert.doesNotMatch(await addPage.text(),/Use Receive By PO/);
  assert.notEqual((await request(`/material-logs/mrr/1802/lines/receipt/${receiptId}/delete`,{})).status,302);
  assert.equal((await db.query('select count(*)::int as n from receipts where id=$1',[receiptId])).rows[0].n,1);
  await db.exec(`
    insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_name,status) values(2001,101,'REQ-TEST',1501,'Crew','ISSUED');
    insert into material_requisition_lines(id,job_id,requisition_id,bom_line_id,qty_requested,qty_issued) values(2101,101,2001,1601,1,1);
    insert into material_issue_transactions(job_id,requisition_id,requisition_line_id,warehouse,location,qty_issued) values(101,2001,2101,'Yard','BIN',1);
  `);
  const blocked=await request(`/material-logs/mrr/1801/lines/receipt/${receiptId}/delete`,{});
  assert.notEqual(blocked.status,302);
  assert.match(await blocked.text(),/Return or unissue/);
  await db.exec('delete from material_issue_transactions where requisition_id=2001; delete from material_requisitions where id=2001');
  const deleted = await request(`/material-logs/mrr/1801/lines/receipt/${receiptId}/delete`,{});
  assert.equal(deleted.status,302,await deleted.text());
  assert.equal((await db.query('select count(*)::int as n from receipts where mrr_log_id=1801')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from osd_logs where receipt_id=$1',[receiptId])).rows[0].n,0);
  const body={mode:'po',po_line_id:'1302',qty_received:'3',warehouse:'Yard',location:'BIN',short_action:'not_on_load',return_to:'/receive/1801'};
  for (const id of ['1303','1304']) {
    const bad = await request('/receive/1801',{...body,po_line_id:id});
    assert.notEqual(bad.status,302);
  }
  for (const qty of ['3','2']) {
    const added=await request('/receive/1801',{...body,qty_received:qty});
    assert.equal(added.status,302,await added.text());
    assert.equal(added.headers.get('location'),'/receive/1801');
  }
  assert.equal(Number((await db.query('select sum(qty_received) as qty from receipts where mrr_log_id=1801 and po_line_id=1302')).rows[0].qty),5);
  assert.equal((await db.query("select count(*)::int as n from audit_log where action='delete' and entity_type='receipt'")).rows[0].n,1);
  await db.query("update mrr_logs set status='REVERSED' where id=1801");
  assert.notEqual((await request('/receive/1801',body)).status,302);
});
