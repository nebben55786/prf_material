import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { outstandingReservationSql } from "../src/requisition-loads.js";
import { PGlite } from "@electric-sql/pglite";
import {
  normalizeRequestPrefix,
  getDeliveryLocation,
  nextDeliveryRequestNumber
} from "../src/delivery-locations.js";
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of fs.readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort())
    await db.exec(
      fs.readFileSync(
        new URL("../db/migrations/" + file, import.meta.url),
        "utf8"
      )
    );
  await db.exec(
    "insert into jobs(id,job_number) values(101,'A'),(102,'B'); insert into delivery_locations(id,job_id,name,request_prefix) values(100,101,'Memphis','MH-MR'),(101,101,'Remote','GR-MR'),(102,102,'Other Job','OTHER-MR');"
  );
  return db;
}
test("split loads keep reservations, issue independently, and retain separate tickets and signatures", async (t) => {
  const db = await fixture(t);
  const bcrypt = (await import("bcryptjs")).default;
  await db.query(
    "insert into users(id,username,password_hash,role) values(100,'loads-tester',$1,'admin')",
    [await bcrypt.hash("test-password", 4)]
  );
  await db.exec(
    "insert into vendors(id,name,categories) values(100,'Supplier','pipe');insert into material_items(id,job_id,item_code,description,material_type,uom) values(1001,101,'PIPE','Pipe','pipe','EA');insert into purchase_orders(id,job_id,po_no,vendor_id) values(1201,101,'PO-A',100);insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered) values(1301,101,1201,1001,20);insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,20,'Yard','BIN','OK');insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1501,101,'A','A-BOM','pipe','ACTIVE');insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1601,1501,'1','PIPE','Pipe','EA',10);"
  );
  const root = new URL("../src/", import.meta.url), stub = new URL(".loads-test-db-" + process.pid + ".mjs", root), serverFile = new URL(".loads-test-server-" + process.pid + ".mjs", root);
  const old = process.env.VERCEL;
  process.env.VERCEL = "1";
  globalThis.__loadsTestDb = db;
  fs.writeFileSync(
    stub,
    `const db=globalThis.__loadsTestDb; export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};export const pool={query};export const initDb=async()=>{};export const withTransaction=fn=>db.transaction(fn);export const auditLog=async(db,u,a,type,id,details)=>db.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",[u,a,type,String(id||''),details]);export let vendorCategories=['pipe'];export let permissionMatrix={};export const setVendorCategories=x=>vendorCategories=x;export const setPermissionMatrix=x=>permissionMatrix=x;`
  );
  fs.writeFileSync(
    serverFile,
    fs.readFileSync(new URL("server.js", root), "utf8").replace('from "./db.js";', "from " + JSON.stringify(stub.href) + ";")
  );
  let listener;
  t.after(async () => {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(stub, { force: true });
    fs.rmSync(serverFile, { force: true });
    if (old === void 0) delete process.env.VERCEL;
    else process.env.VERCEL = old;
    delete globalThis.__loadsTestDb;
  });
  const app = (await import(serverFile.href)).default;
  listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = "http://127.0.0.1:" + listener.address().port;
  let cookie = "";
  const request = async (path2, body) => {
    const response = await fetch(base + path2, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...cookie ? { Cookie: cookie } : {},
        ...body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}
      },
      body: body ? new URLSearchParams(body) : void 0
    });
    for (const header of response.headers.getSetCookie())
      if (header.startsWith("session_token=")) cookie = header.split(";")[0];
    return response;
  };
  assert.equal(
    (await request("/login", {
      username: "loads-tester",
      password: "test-password"
    })).status,
    302
  );
  assert.equal((await request("/jobs/select", { job_id: "101" })).status, 302);
  const create = await request("/bom/1501/requisitions", { delivery_location_id: "100", issued_to: "Crew", selected_line_ids: "1601", request_qty_1601: "10" });
  assert.equal(create.status, 302, await create.text());
  const id = (await db.query("select id from material_requisitions where requisition_no='MH-MR-00001'")).rows[0].id;
  const path = "/requisitions/" + id;
  assert.equal((await request(path + "/verify", {})).status, 302);
  assert.equal((await request(path + "/load", {trailer_number:"ORIGINAL"})).status,302);
  const line = (await db.query("select id from material_requisition_lines where requisition_id=$1", [id])).rows[0].id;
  const add = async (qty, trailer = "T1") => request(path + "/loads", { trailer_number: trailer, ["qty_" + line]: String(qty) });
  assert.equal((await add(11)).status, 400);
  assert.equal((await add(-1)).status, 400);
  assert.equal((await add("NaN")).status, 400);
  assert.equal((await add(1e-5)).status, 400);
  assert.equal((await add(4, "")).status, 400);
  for (const [qty, trailer] of [[4, "T1"], [3, "T2"], [3, "T3"]]) {
    const r = await add(qty, trailer);
    assert.equal(r.status, 302, await r.text());
  }
  let loads = (await db.query("select * from material_requisition_loads where requisition_id=$1 order by load_sequence", [id])).rows;
  assert.deepEqual(loads.map((l) => l.load_no), ["MH-MR-00001-01", "MH-MR-00001-02", "MH-MR-00001-03"]);
  assert.equal((await db.query("select trailer_number from material_requisitions where id=$1",[id])).rows[0].trailer_number,null);
  assert.match(await (await request("/requisitions?description=MH-MR-00001-02")).text(),/MH-MR-00001/);
  assert.equal((await add(1)).status, 400);
  for (const action of ["issue", "unverify", "load", "issued-qty", "sign"]) assert.equal((await request(path + "/" + action, { trailer_number: "OTHER", signed_by_name: "Crew", signature_data: "data:image/png;base64,aGVsbG8=" })).status, 400, action);
  assert.equal((await request(path + "/pick-ticket.pdf")).status, 400);
  assert.match(await (await request(path)).text(), /Create Load/);
  assert.match(await (await request("/requisitions")).text(), /View Loads/);
  const p1 = path + "/loads/" + loads[0].id, p2 = path + "/loads/" + loads[1].id, p3 = path + "/loads/" + loads[2].id;
  function cells(html, marker) {
    const row=(html.match(/<tr>[\s\S]*?<\/tr>/g)||[]).find(row=>row.includes(marker));
    assert.ok(row,marker);
    return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match=>match[1].replace(/<[^>]+>/g,'').trim());
  }
  let quantities=await (await request(path)).text();
  assert.match(quantities,/<button[^>]*aria-controls="create-load-panel"[^>]*>Create Load<\/button>/);
  assert.match(quantities,/<div id="create-load-panel" hidden>/);
  assert.doesNotMatch(quantities,/<summary>Create Load/);
  assert.deepEqual(cells(quantities,'MH-MR-00001-01').slice(4,9),['4','0','0','4','EA']);
  assert.deepEqual(cells(quantities.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['10','0','10','0','0','10','EA']);
  const ticket = await request(p1 + "/pick-ticket.pdf");
  assert.equal(ticket.status, 200);
  const pdf = Buffer.from(await ticket.arrayBuffer()).toString("latin1");
  assert.match(pdf, /MH-MR-00001-01/);
  assert.match(pdf, /Trailer: T1/);
  assert.match(pdf, /\(4\) Tj/);
  const signPage = await request(p1 + "/sign");
  assert.equal(signPage.status, 200);
  assert.match(await signPage.text(), new RegExp(p1 + "/sign"));
  assert.equal((await request(p1 + "/load", { trailer_number: "TRAILER-A" })).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-MR-00001-01').slice(4,9),['4','4','0','4','EA']);
  assert.deepEqual(cells(quantities.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['10','0','6','4','0','10','EA']);
  const loadPage=await (await request(p1)).text();
  assert.match(loadPage,/<th>Loaded<\/th><th>Issued<\/th><th>Remaining to Issue<\/th>/);
  const signature = { signed_by_name: "First Crew", signature_data: "data:image/png;base64,aGVsbG8=" };
  assert.equal((await request(p1 + "/sign", signature)).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-MR-00001-01').slice(4,9),['4','0','4','0','EA']);
  assert.deepEqual(cells(quantities.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['10','0','6','0','4','6','EA']);

  async function totals() {
    return (await db.query(`select mrl.qty_issued,${outstandingReservationSql} as reserved,mr.status from material_requisition_lines mrl join material_requisitions mr on mr.id=mrl.requisition_id where mrl.id=$1`, [line])).rows[0];
  }
  assert.deepEqual(await totals(), { qty_issued: "4.0000", reserved: "6.0000", status: "ACCEPTED" });
  assert.equal((await request(p1 + "/sign", signature)).status, 302);
  assert.equal((await request(p1 + "/issue", {})).status, 302);
  assert.equal(Number((await db.query("select sum(qty_issued) as n from material_issue_transactions where requisition_id=$1", [id])).rows[0].n), 4);
  assert.equal((await request(p1 + "/cancel", {})).status, 400);
  assert.equal((await request(path + "/cancel", {})).status, 400);
  assert.match(await (await request(path)).text(), /Partially Issued/);
  assert.equal((await request(p2 + "/cancel", {})).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-MR-00001-02').slice(4,9),['3','0','0','0','EA']);
  assert.deepEqual(cells(quantities.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['10','3','3','0','4','6','EA']);

  assert.equal((await request(p2 + "/issue", {})).status, 400);
  assert.equal((await request(p2 + "/sign", signature)).status, 400);
  assert.equal((await add(3, "T4")).status, 302);
  const fourth = (await db.query("select * from material_requisition_loads where requisition_id=$1 and load_sequence=4", [id])).rows[0];
  assert.equal(fourth.load_no, "MH-MR-00001-04");
  assert.equal(Number((await totals()).reserved), 6);
  await db.exec("insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1502,101,'A','SECOND','pipe','ACTIVE');insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1602,1502,'1','PIPE','Pipe','EA',20)");
  const competing = await request("/bom/1502/requisitions", { delivery_location_id: "100", issued_to: "Other", selected_line_ids: "1602", request_qty_1602: "11" });
  assert.equal(competing.status, 400, await competing.text());
  assert.equal((await request("/jobs/select", { job_id: "102" })).status, 302);
  assert.equal((await request(p3 + "/issue", {})).status, 400);
  assert.equal((await request(p3)).status, 400);
  await request("/jobs/select", { job_id: "101" });
  await db.query("update receipts set qty_received=4 where job_id=101");
  assert.equal((await request(p3 + "/sign", signature)).status, 400);
  assert.equal((await db.query("select signed_at from material_requisition_loads where id=$1", [loads[2].id])).rows[0].signed_at, null);
  assert.equal(Number((await totals()).qty_issued), 4);
  await db.query("update receipts set qty_received=20 where job_id=101");
  const issued = await request(p3 + "/sign", { ...signature, signed_by_name: "Third Crew" });
  assert.equal(issued.status, 302, await issued.text());
  assert.equal((await request(path + "/loads/" + fourth.id + "/issue", {})).status, 302);
  assert.deepEqual(await totals(), { qty_issued: "10.0000", reserved: "0.0000", status: "ISSUED" });
  loads = (await db.query("select * from material_requisition_loads where requisition_id=$1 order by load_sequence", [id])).rows;
  assert.equal(loads[0].signed_by_name, "First Crew");
  assert.equal(loads[2].signed_by_name, "Third Crew");
  assert.equal(loads[0].trailer_number, "TRAILER-A");
  assert.equal(loads[2].trailer_number, "T3");
  assert.equal((await request(p1 + "/pick-ticket.pdf")).status, 200);
  const form = new FormData();
  form.set("signed_by_name", "Paper Crew");
  form.set("signed_copy", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), "signed.pdf");
  const upload = await fetch(base + path + "/loads/" + fourth.id + "/signed-copy", { method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual" });
  assert.equal(upload.status, 302, await upload.text());
  const copy = await request(path + "/loads/" + fourth.id + "/signed-copy");
  assert.equal(copy.status, 200);
  assert.equal(await copy.text(), "%PDF-1.4 test");
  assert.equal((await request(p1 + "/signed-copy")).status, 400);
  assert.equal(Number((await totals()).qty_issued), 10);
  // Requests without split loads retain the original accept, ticket and sign workflow.
  const legacy=await request("/bom/1502/requisitions",{delivery_location_id:"100",issued_to:"Legacy Crew",selected_line_ids:"1602",request_qty_1602:"10"});
  assert.equal(legacy.status,302,await legacy.text());
  const legacyPath=legacy.headers.get("location");
  assert.equal((await request(legacyPath+"/verify",{})).status,302);
  assert.equal((await request(legacyPath+"/pick-ticket.pdf")).status,200);
  assert.equal((await request(legacyPath+"/sign",signature)).status,302);
  assert.equal((await db.query("select status from material_requisitions where requisition_no='MH-MR-00002'")).rows[0].status,"ISSUED");
  await db.query("insert into users(id,username,password_hash,role) values(101,'load-field',$1,'field')", [await bcrypt.hash("test-password", 4)]);
  await db.query("insert into user_jobs(user_id,job_id) values(101,101)");
  await request("/login", { username: "load-field", password: "test-password" });
  await request("/jobs/select", { job_id: "101" });
  assert.equal((await request(p1)).status, 200);
  assert.equal((await request(p1 + "/issue", {})).status, 403);
  assert.equal((await request(p1 + "/sign", signature)).status, 403);
});
