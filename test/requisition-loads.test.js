import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { outstandingReservationSql, createRequisitionLoad } from "../src/requisition-loads.js";
import { identTargets, renameItemIdent } from "../src/item-ident.js";
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
  const create = await request("/bom/1501/requisitions", { requested_by_name: "Field Requester", delivery_location_id: "100", issued_to: "Crew", selected_line_ids: "1601", request_qty_1601: "10" });
  assert.equal(create.status, 302, await create.text());
  const id = (await db.query("select id from material_requisitions where requisition_no='MH-PT-0001'")).rows[0].id;
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
    if (qty === 4) {
      const partial=await (await request(path)).text();
      assert.match(partial,/<h4>Remaining Quantities<\/h4>/);
      assert.deepEqual(cells(partial.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['6','EA']);
      assert.match(partial,/aria-controls="create-load-panel"/);
      assert.match(partial,new RegExp('max="6" name="qty_'+line+'"'));
    }
  }
  let loads = (await db.query("select * from material_requisition_loads where requisition_id=$1 order by load_sequence", [id])).rows;
  assert.deepEqual(loads.map((l) => l.load_no), ["MH-PT-0001-001", "MH-PT-0001-002", "MH-PT-0001-003"]);
  assert.equal((await db.query("select trailer_number from material_requisitions where id=$1",[id])).rows[0].trailer_number,null);
  assert.match(await (await request("/requisitions?description=MH-PT-0001-002")).text(),/MH-PT-0001/);
  assert.equal((await add(1)).status, 400);
  for (const action of ["issue", "unverify", "load", "issued-qty", "sign"]) assert.equal((await request(path + "/" + action, { trailer_number: "OTHER", signed_by_name: "Crew", signature_data: "data:image/png;base64,aGVsbG8=" })).status, 400, action);
  assert.equal((await request(path + "/pick-ticket.pdf")).status, 400);
  assert.doesNotMatch(await (await request(path)).text(), /aria-controls="create-load-panel"/);
  assert.match(await (await request("/requisitions")).text(), /View Loads/);
  const p1 = path + "/loads/" + loads[0].id, p2 = path + "/loads/" + loads[1].id, p3 = path + "/loads/" + loads[2].id;
  function cells(html, marker) {
    const row=(html.match(/<tr>[\s\S]*?<\/tr>/g)||[]).find(row=>row.includes(marker));
    assert.ok(row,marker);
    return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match=>match[1].replace(/<[^>]+>/g,'').trim());
  }
  let quantities=await (await request(path)).text();
  assert.doesNotMatch(quantities,/aria-controls="create-load-panel"/);
  assert.match(quantities,/All requested quantities have been assigned to loads/);
  assert.doesNotMatch(quantities,/<summary>Create Load/);
  assert.deepEqual(cells(quantities,'MH-PT-0001-001').slice(4,9),['4','0','0','4','EA']);
  assert.doesNotMatch(quantities.split('<h4>Quantities by Load</h4>')[0],/<td>PIPE<\/td>/);
  const editLoad = (body) => request(p1 + "/edit", {trailer_number:"T1", ...body});
  assert.match(await (await request(p1)).text(),/Edit Load/);
  assert.equal((await request(p1 + "/edit")).status,200);
  assert.equal((await editLoad({["qty_"+line]:5})).status,400);
  assert.equal((await editLoad({["qty_"+line]:-1})).status,400);
  assert.equal((await editLoad({["qty_"+line]:0})).status,400);
  assert.equal((await editLoad({["qty_"+line]:"NaN"})).status,400);
  assert.equal((await editLoad({["qty_"+line]:0.00001})).status,400);
  await db.query("insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(9602,1501,'2','EXTRA','Extra part','EA',5)");
  const extra=(await db.query("insert into material_requisition_lines(job_id,requisition_id,bom_line_id,qty_requested) values(101,$1,9602,5) returning id",[id])).rows[0].id;
  assert.equal((await editLoad({["qty_"+line]:2,["qty_"+extra]:3})).status,302);
  assert.equal(Number((await db.query("select qty from material_requisition_load_lines where load_id=$1 and requisition_line_id=$2",[loads[0].id,extra])).rows[0].qty),3);
  assert.equal((await request(p1 + "/load",{trailer_number:"T1"})).status,302);
  assert.equal((await editLoad({["qty_"+line]:4,["qty_"+extra]:0})).status,302);
  assert.equal((await db.query("select status from material_requisition_loads where id=$1",[loads[0].id])).rows[0].status,'PLANNED');
  assert.equal((await db.query("select 1 from material_requisition_load_lines where load_id=$1 and requisition_line_id=$2",[loads[0].id,extra])).rows.length,0);
  await db.query("delete from material_requisition_lines where id=$1",[extra]);
  const ticket = await request(p1 + "/pick-ticket.pdf");
  assert.equal(ticket.status, 200);
  const pdf = Buffer.from(await ticket.arrayBuffer()).toString("latin1");
  assert.match(pdf, /MH-PT-0001-001/);
  assert.match(pdf, /Trailer: T1/);
  assert.match(pdf, /\(4\) Tj/);
  const signPage = await request(p1 + "/sign");
  assert.equal(signPage.status, 200);
  assert.match(await signPage.text(), new RegExp(p1 + "/sign"));
  assert.equal((await request(p1 + "/load", { trailer_number: "TRAILER-A" })).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-PT-0001-001').slice(4,9),['4','4','0','4','EA']);
  assert.doesNotMatch(quantities.split('<h4>Quantities by Load</h4>')[0],/<td>PIPE<\/td>/);
  const loadPage=await (await request(p1)).text();
  assert.match(loadPage,/<th>Loaded<\/th><th>Issued<\/th><th>Remaining to Issue<\/th>/);
  const signature = { signed_by_name: "First Crew", signature_data: "data:image/png;base64,aGVsbG8=" };
  assert.equal((await request(p1 + "/sign", signature)).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-PT-0001-001').slice(4,9),['4','0','4','0','EA']);
  assert.doesNotMatch(quantities.split('<h4>Quantities by Load</h4>')[0],/<td>PIPE<\/td>/);

  async function totals() {
    return (await db.query(`select mrl.qty_issued,${outstandingReservationSql} as reserved,mr.status from material_requisition_lines mrl join material_requisitions mr on mr.id=mrl.requisition_id where mrl.id=$1`, [line])).rows[0];
  }
  assert.deepEqual(await totals(), { qty_issued: "4.0000", reserved: "6.0000", status: "ACCEPTED" });
  assert.equal((await request(p1 + "/sign", signature)).status, 302);
  assert.equal((await request(p1 + "/issue", {})).status, 302);
  assert.equal(Number((await db.query("select sum(qty_issued) as n from material_issue_transactions where requisition_id=$1", [id])).rows[0].n), 4);
  assert.equal((await request(p1 + "/cancel", {})).status, 400);
  assert.equal((await editLoad({["qty_"+line]:2})).status,400);
  assert.equal((await request(p1 + "/edit")).status,400);
  assert.equal((await request(path + "/cancel", {})).status, 400);
  assert.match(await (await request(path)).text(), /Partially Issued/);
  assert.equal((await request(p2 + "/cancel", {})).status, 302);
  quantities=await (await request(path)).text();
  assert.deepEqual(cells(quantities,'MH-PT-0001-002').slice(4,9),['3','0','0','0','EA']);
  assert.deepEqual(cells(quantities.split('<h4>Quantities by Load</h4>')[0],'<td>PIPE</td>').slice(2),['3','EA']);

  assert.equal((await request(p2 + "/issue", {})).status, 400);
  assert.equal((await request(p2 + "/sign", signature)).status, 400);
  assert.equal((await add(3, "T4")).status, 302);
  const fourth = (await db.query("select * from material_requisition_loads where requisition_id=$1 and load_sequence=4", [id])).rows[0];
  assert.equal(fourth.load_no, "MH-PT-0001-004");
  assert.equal(Number((await totals()).reserved), 6);
  await db.exec("insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1502,101,'A','SECOND','pipe','ACTIVE');insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1602,1502,'1','PIPE','Pipe','EA',20)");
  const competing = await request("/bom/1502/requisitions", { requested_by_name: "Field Requester", delivery_location_id: "100", issued_to: "Other", selected_line_ids: "1602", request_qty_1602: "11" });
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
  const legacy=await request("/bom/1502/requisitions",{requested_by_name:"Field Requester",delivery_location_id:"100",issued_to:"Legacy Crew",selected_line_ids:"1602",request_qty_1602:"10"});
  assert.equal(legacy.status,302,await legacy.text());
  const legacyPath=legacy.headers.get("location");
  assert.equal((await request(legacyPath+"/verify",{})).status,302);
  assert.equal((await request(legacyPath+"/pick-ticket.pdf")).status,200);
  assert.equal((await request(legacyPath+"/sign",signature)).status,302);
  assert.equal((await db.query("select status from material_requisitions where requisition_no='MH-PT-0002'")).rows[0].status,"ISSUED");
  const correctionPath=legacyPath+'/correct-quantities';
  assert.equal((await request(correctionPath)).status,400); // signed requests are immutable
  assert.equal((await request(legacyPath+'/unissue',{reason:'Reverse signed issue'})).status,400);
  const legacyId=Number(legacyPath.split('/').at(-1));
  await db.query("update material_requisitions set signed_at=null,signed_by_name=null,signed_signature_data=null where id=$1",[legacyId]);
  const correctionLine=(await db.query('select * from material_requisition_lines where requisition_id=$1',[legacyId])).rows[0];
  const correctionBody=async(qty)=>{
    const r=(await db.query('select * from material_requisition_lines where id=$1',[correctionLine.id])).rows[0];
    return {snapshot:JSON.stringify([[String(r.id),String(r.qty_requested),String(r.qty_issued)]]),reason:'Correct field count', ['requested_'+r.id]:String(qty),['issued_'+r.id]:String(qty)};
  };
  assert.match(await (await request(legacyPath)).text(),/Correct Quantities/);
  assert.equal((await request(correctionPath)).status,200);
  const stale=await correctionBody(5);
  assert.equal((await request(correctionPath,stale)).status,302);
  assert.equal((await request(correctionPath,stale)).status,400);
  assert.equal(Number((await db.query('select sum(qty_issued) as n from material_issue_transactions where requisition_id=$1',[legacyId])).rows[0].n),5);
  assert.equal((await request(correctionPath,await correctionBody(11))).status,400); // only ten stock remain
  assert.equal(Number((await db.query('select qty_issued from material_requisition_lines where id=$1',[correctionLine.id])).rows[0].qty_issued),5);
  assert.equal((await request(correctionPath,{...await correctionBody(6),reason:''})).status,400);
  assert.equal((await request(correctionPath,await correctionBody(6))).status,302);
  assert.equal(Number((await db.query('select qty_issued from material_requisition_lines where id=$1',[correctionLine.id])).rows[0].qty_issued),6);
  const log=(await db.query("select details from audit_log where action='correct_quantities' and entity_id=$1 order by id desc",[String(legacyId)])).rows;
  assert.equal(log.length,2);assert.equal(JSON.parse(log[0].details).before[0].issued,'5.0000');
  assert.equal((await request(path+'/correct-quantities')).status,400); // split loads use their own workflow
  await request('/jobs/select',{job_id:'102'});
  assert.equal((await request(correctionPath)).status,400);
  await request('/jobs/select',{job_id:'101'});
  assert.equal((await request(path+'/unissue',{reason:'Reverse split issue'})).status,400);
  await request('/jobs/select',{job_id:'102'});
  assert.equal((await request(legacyPath+'/unissue',{reason:'Wrong job'})).status,400);
  await request('/jobs/select',{job_id:'101'});
  assert.match(await (await request(legacyPath)).text(),/>Un-Issue<\/button>/);
  assert.doesNotMatch(await (await request(legacyPath)).text(),/Un-Issue Reason/);
  assert.equal((await request(legacyPath+'/unissue',{})).status,302);
  const undone=(await db.query('select status,issued_at from material_requisitions where id=$1',[legacyId])).rows[0];
  assert.equal(undone.status,'ACCEPTED');assert.equal(undone.issued_at,null);
  const undoneLine=(await db.query('select qty_requested,qty_issued from material_requisition_lines where id=$1',[correctionLine.id])).rows[0];
  assert.equal(Number(undoneLine.qty_requested),6);assert.equal(Number(undoneLine.qty_issued),0);
  assert.equal((await db.query('select * from material_issue_transactions where requisition_id=$1',[legacyId])).rows.length,0);
  assert.equal(Number((await db.query(`select ${outstandingReservationSql} as qty from material_requisition_lines mrl where id=$1`,[correctionLine.id])).rows[0].qty),6);
  assert.equal((await request(legacyPath+'/unissue',{reason:'Repeat'})).status,400);
  const undoAudit=(await db.query("select details from audit_log where action='unissue' and entity_id=$1",[String(legacyId)])).rows;
  assert.equal(undoAudit.length,1);assert.equal(JSON.parse(undoAudit[0].details).request,'MH-PT-0002');
  assert.equal((await request(legacyPath+'/issued-qty',{['qty_issued_'+correctionLine.id]:'6',next_action:'issue'})).status,302);
  assert.equal(Number((await db.query('select sum(qty_issued) as n from material_issue_transactions where requisition_id=$1',[legacyId])).rows[0].n),6);
  // Location counts post stock adjustments, without fabricating receiving documents.
  await db.exec("insert into warehouses(id,job_id,name,is_active) values(9001,101,'Yard',true); insert into warehouse_locations(job_id,warehouse_id,name,is_active) values(101,9001,'BIN',true),(101,9001,'NEW',true)");
  const li='/yard/location-inventory',loc=li+'?warehouse=Yard&location=BIN';
  const tokenFrom=html=>{const m=html.match(/name="token" value="([^"]+)"/);assert.ok(m);return m[1].replaceAll('&quot;','"').replaceAll('&amp;','&');};
  let page=await (await request(loc)).text();assert.match(page,/Actual Qty/);assert.match(page,/Photos/);
  // Display current master attributes, even when receipt dimensions differ.
  const originalMaster=(await db.query("select * from material_items where job_id=101 and item_code='PIPE'")).rows[0];
  await db.query("update material_items set description='Current master description',size_1='MASTER-SIZE' where id=$1",[originalMaster.id]);
  const masterPage=await (await request(loc)).text();
  assert.match(masterPage,/<td>PIPE<\/td><td>Current master description<\/td><td>MASTER-SIZE/);
  await db.query('update material_items set description=$1,size_1=$2 where id=$3',[originalMaster.description,originalMaster.size_1,originalMaster.id]);
  const countToken=tokenFrom(page);
  const countPayload=JSON.parse(Buffer.from(countToken.split('.')[0],'base64url').toString());
  const pipeIndex=countPayload.rows.findIndex(r=>r.item_code==='PIPE');assert.ok(pipeIndex>=0);
  let response=await request(li+'/review',{token:countToken,['actual_'+pipeIndex]:'7'});assert.equal(response.status,200,await response.clone().text());
  let reviewToken=tokenFrom(await response.text());
  const receiptCount=Number((await db.query('select count(*) as n from receipts')).rows[0].n);
  assert.equal((await request(li+'/save',{token:reviewToken})).status,302);
  assert.equal((await request(li+'/save',{token:reviewToken})).status,400); // stale/repeated save
  assert.equal(Number((await db.query('select count(*) as n from receipts')).rows[0].n),receiptCount);
  assert.equal(Number((await db.query("select actual_qty from inventory_audit_counts where job_id=101 and item_code='PIPE' and warehouse='Yard' and location='BIN'")).rows[0].actual_qty),7);
  page=await (await request(li+'?warehouse=Yard&location=NEW')).text();
  const emptyToken=tokenFrom(page);
  assert.equal((await request(li+'/review',{token:emptyToken,item_code:'FREE-TEXT',description:'Not master',uom:'EA',add_qty:'12'})).status,400);
  const masters=(await db.query("insert into material_items(job_id,item_code,description,material_type,uom,size_1) values(101,'START-NEW','Master starting stock','misc','EA','12'),(101,'BATCH-2','Second master item','steel','EA','20') returning *")).rows;
  const newItem=masters.find(i=>i.item_code==='START-NEW');
  const queue=JSON.stringify(masters.map((m,i)=>({id:m.id,qty:i?5:12,description:'Tampered description'})));
  const adjustmentsBefore=Number((await db.query('select count(*) as n from inventory_adjustment_lines')).rows[0].n);
  response=await request(li+'/review',{token:emptyToken,item_queue:queue});
  assert.equal(response.status,200,await response.clone().text());
  const batchPreview=await response.text();assert.match(batchPreview,/START-NEW/);assert.match(batchPreview,/BATCH-2/);assert.doesNotMatch(batchPreview,/Tampered description/);
  reviewToken=tokenFrom(batchPreview);
  assert.equal(Number((await db.query('select count(*) as n from inventory_adjustment_lines')).rows[0].n),adjustmentsBefore);
  response=await request(li+'/save',{token:reviewToken});assert.equal(response.status,302,await response.clone().text());
  assert.match(response.headers.get('location'),/photo_item=/);
  page=await (await request(response.headers.get('location'))).text();assert.match(page,/Item Photos: BATCH-2/);
  const batchCounts=(await db.query("select item_code,actual_qty,report_id from inventory_audit_report_lines where warehouse='Yard' and location='NEW' and item_code in ('START-NEW','BATCH-2') order by item_code")).rows;
  assert.equal(batchCounts.length,2);assert.equal(Number(batchCounts[0].actual_qty),5);assert.equal(Number(batchCounts[1].actual_qty),12);assert.equal(batchCounts[0].report_id,batchCounts[1].report_id);
  assert.equal((await request(li+'/review',{token:emptyToken,item_queue:JSON.stringify([{id:newItem.id,qty:2},{id:newItem.id,qty:3}])})).status,400);
  assert.equal((await request(li+'/review',{token:emptyToken,item_queue:JSON.stringify([{id:newItem.id,qty:2},{id:9999999,qty:3}])})).status,400);
  assert.equal((await request(li+'/review',{token:emptyToken,item_queue:JSON.stringify([{id:newItem.id,qty:''}])})).status,400);
  assert.equal((await request(li+'/save',{token:reviewToken})).status,400);
  page=await (await request(loc)).text();
  response=await request(li+'/review',{token:tokenFrom(page),item_queue:JSON.stringify([{id:newItem.id,qty:3}])});assert.equal(response.status,200);
  assert.equal((await request(li+'/save',{token:tokenFrom(await response.text())})).status,302);
  assert.equal((await request(li+'/review',{token:countToken,['actual_'+pipeIndex]:'-1'})).status,400);
  page=await (await request(loc)).text();
  let latest=tokenFrom(page);
  const latestRows=JSON.parse(Buffer.from(latest.split('.')[0],'base64url').toString()).rows;
  const at=latestRows.findIndex(r=>r.item_code==='PIPE');
  assert.equal((await request(li+'/review',{token:latest})).status,400); // blanks make no changes
  await db.query("update material_requisitions set status='ACCEPTED' where id=$1",[legacyId]);
  await db.query('update material_requisition_lines set qty_requested=20 where id=$1',[correctionLine.id]);
  response=await request(li+'/review',{token:latest,['actual_'+at]:'0'});
  assert.equal(response.status,200);const warningPage=await response.text();assert.match(warningPage,/below reserved quantity/);
  assert.equal((await request(li+'/save',{token:tokenFrom(warningPage)})).status,302);
  assert.equal(Number((await db.query("select actual_qty from inventory_audit_counts where job_id=101 and item_code='PIPE' and warehouse='Yard' and location='BIN'")).rows[0].actual_qty),0);

  // Warehouse and location selections are exact, not substring matches.
  await db.exec("insert into warehouses(id,job_id,name,is_active) values(9199,101,'Yard Annex',true); insert into warehouse_locations(job_id,warehouse_id,name,is_active) values(101,9199,'BIN',true),(101,9001,'BIN-2',true); insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,2,'Yard Annex','BIN','OK'),(101,1301,1,'Yard','BIN-2','OK')");
  const auditKeys=html=>Array.from(html.matchAll(/name="key_\d+" value="([^"]+)"/g),m=>JSON.parse(Buffer.from(m[1],'base64url').toString()));
  let auditPage=await (await request('/inventory-audit/new?warehouse_filter=Yard')).text();
  let filteredKeys=auditKeys(auditPage);assert.ok(filteredKeys.length>0);assert.ok(filteredKeys.every(r=>r.warehouse==='Yard'));
  auditPage=await (await request('/inventory-audit/new?warehouse_filter=yard&location_filter=bin')).text();
  filteredKeys=auditKeys(auditPage);assert.ok(filteredKeys.length>0);assert.ok(filteredKeys.every(r=>r.warehouse==='Yard'&&r.location==='BIN'));
  assert.match(auditPage,/data-audit-toggle-zero/);assert.match(auditPage,/data-zero-qty="1"/);assert.match(auditPage,/inventory-audit-visibility.js/);
  auditPage=await (await request('/inventory-audit/new?location_filter=BIN')).text();
  filteredKeys=auditKeys(auditPage);assert.ok(filteredKeys.every(r=>r.location==='BIN'));

  // Zeroing legacy stock does not require its old warehouse/location to remain active.
  await db.exec("insert into warehouses(id,job_id,name,is_active) values(9198,101,'Legacy Yard',false); insert into warehouse_locations(job_id,warehouse_id,name,is_active) values(101,9198,'OLD',false); insert into material_items(id,job_id,item_code,description,material_type,uom) values(9198,101,'VALVE-ZERO','Legacy valves','valve','EA'); insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered,size_1) values(9197,101,1201,9198,12,''),(9198,101,1201,9198,40,'42'); insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,9197,12,'Legacy Yard','OLD','OK'),(101,9198,40,'Legacy Yard','OLD','OK')");
  const legacyAuditPage=await (await request('/inventory-audit/new?warehouse_filter=Legacy%20Yard&ident_filter=VALVE-ZERO')).text();
  const legacyKeys=Array.from(legacyAuditPage.matchAll(/name="key_\d+" value="([^"]+)"/g),m=>m[1]);assert.equal(legacyKeys.length,2);
  const clearLegacy={row_count:'2',key_0:legacyKeys[0],actual_qty_0:'0',key_1:legacyKeys[1],actual_qty_1:'0'};
  response=await request('/inventory-audit/commit',{...clearLegacy,actual_qty_0:'1'});assert.equal(response.status,400);assert.match(await response.text(),/Legacy Yard/);
  await request('/jobs/select',{job_id:'102'});
  assert.equal((await request('/inventory-audit/commit',clearLegacy)).status,400);
  await request('/jobs/select',{job_id:'101'});
  response=await request('/inventory-audit/commit',clearLegacy);assert.equal(response.status,302,await response.clone().text());
  const clearedValveRows=(await db.query("select size_1,sum(qty_adjustment) as qty from inventory_adjustment_lines where job_id=101 and item_code='VALVE-ZERO' group by size_1 order by size_1")).rows;
  assert.deepEqual(clearedValveRows.map(r=>[r.size_1,Number(r.qty)]),[['',-12],['42',-40]]);
  assert.equal(Number((await db.query("select sum(qty_received) as qty from receipts where po_line_id in (9197,9198)")).rows[0].qty),52);

  // Occupied storage cannot be disabled. Moves preserve on-hand and OS&D, then allow deactivation.
  await db.exec("insert into warehouses(id,job_id,name,is_active) values(9200,101,'Move Source',true),(9201,101,'Move Target',true),(9202,102,'Other',true); insert into warehouse_locations(id,job_id,warehouse_id,name,is_active) values(9300,101,9200,'SRC',true),(9301,101,9201,'DEST',true),(9302,102,9202,'DEST',true); insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered,description_snapshot) values(1302,101,1201,1001,3,'Alternate historical description'); insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,7,'Move Source','SRC','OK'),(101,1302,3,'Move Source','SRC','OK'),(101,1301,2,'Move Source','SRC','DAMAGED')");
  await db.exec("insert into warehouse_locations(id,job_id,warehouse_id,name,is_active) values(9303,101,9200,'EMPTY',true)");
  const movePath='/yard/move-inventory';
  response=await request('/settings/warehouses/9200/toggle',{});assert.equal(response.status,302);assert.match(response.headers.get('location'),/move-inventory.*blocked=1/);
  response=await request('/settings/warehouse-locations/9300/toggle',{});assert.match(response.headers.get('location'),/location_id=9300.*blocked=1/);
  assert.equal((await db.query('select is_active from warehouses where id=9200')).rows[0].is_active,true);
  assert.ok((await db.query('select is_active from warehouse_locations where warehouse_id=9200')).rows.every(r=>r.is_active)); // blocked parent leaves all children unchanged
  assert.equal((await db.query('select is_active from warehouse_locations where id=9300')).rows[0].is_active,true);
  response=await request('/settings/warehouse-locations/import',{csv_text:'warehouse_id,warehouse_name,is_active\n9200,Move Source,false'});assert.equal(response.status,400);
  page=await (await request(movePath+'?location_id=9300&blocked=1')).text();assert.match(page,/Cannot set this warehouse or location inactive/);
  const moveSelect=tokenFrom(page);
  assert.equal((await request(movePath+'/review',{token:moveSelect,destination_id:'9302',selected_0:'1',qty_0:'1'})).status,400);
  assert.equal((await request(movePath+'/review',{token:moveSelect,destination_id:'9301',selected_0:'1',qty_0:'11'})).status,400);
  response=await request(movePath+'/review',{token:moveSelect,destination_id:'9301',selected_0:'1',qty_0:'4',osd_0:'0'});assert.equal(response.status,200,await response.clone().text());
  const firstMove=tokenFrom(await response.text());
  await db.query('update warehouse_locations set is_active=false where id=9301');
  assert.equal((await request(movePath+'/save',{token:firstMove})).status,400);
  await db.query('update warehouse_locations set is_active=true where id=9301');
  assert.equal((await request(movePath+'/save',{token:firstMove})).status,302);
  assert.equal((await request(movePath+'/save',{token:firstMove})).status,400);
  let sourceInventory=JSON.parse(Buffer.from(tokenFrom(await (await request(li+'?warehouse=Move%20Source&location=SRC')).text()).split('.')[0],'base64url').toString()).rows;
  assert.equal(Number(sourceInventory[0].qty_on_hand),6);assert.equal(Number(sourceInventory[0].qty_osd),2);
  assert.match((await request('/settings/warehouses/9200/toggle',{})).headers.get('location'),/blocked=1/);
  page=await (await request(movePath+'?warehouse_id=9200')).text();
  response=await request(movePath+'/review',{token:tokenFrom(page),destination_id:'9301',selected_0:'1',qty_0:'6',osd_0:'2'});assert.equal(response.status,200,await response.clone().text());
  assert.equal((await request(movePath+'/save',{token:tokenFrom(await response.text())})).status,302);
  let targetInventory=JSON.parse(Buffer.from(tokenFrom(await (await request(li+'?warehouse=Move%20Target&location=DEST')).text()).split('.')[0],'base64url').toString()).rows;
  assert.equal(Number(targetInventory[0].qty_on_hand),10);assert.equal(Number(targetInventory[0].qty_osd),2);
  assert.match(await (await request('/yard/item-history?item=PIPE')).text(),/Inventory Move/);
  assert.equal((await request('/settings/warehouse-locations/9300/toggle',{})).status,302);
  assert.equal((await db.query('select is_active from warehouse_locations where id=9300')).rows[0].is_active,false);
  assert.equal((await request('/settings/warehouses/9200/toggle',{})).status,302);
  assert.equal((await db.query('select is_active from warehouses where id=9200')).rows[0].is_active,false);
  assert.ok((await db.query('select is_active from warehouse_locations where warehouse_id=9200')).rows.every(r=>!r.is_active));
  assert.equal((await db.query('select is_active from warehouse_locations where id=9301')).rows[0].is_active,true); // other warehouse unchanged
  assert.equal((await request('/settings/warehouse-locations/9303/toggle',{})).status,400);
  assert.equal((await request('/settings/warehouse-locations/add',{warehouse_id:'9200',name:'NEW-UNDER-INACTIVE'})).status,400);
  assert.equal((await db.query('select is_active from warehouse_locations where id=9303')).rows[0].is_active,false);
  assert.equal((await request('/settings/warehouses/9200/toggle',{})).status,302);
  assert.equal((await request('/settings/warehouse-locations/9303/toggle',{})).status,302);
  assert.equal((await db.query('select is_active from warehouse_locations where id=9303')).rows[0].is_active,true);
  // OS&D-only material also prevents both location and parent deactivation.
  await db.exec("insert into warehouses(id,job_id,name,is_active) values(9203,101,'OSD Yard',true),(9204,101,'Empty Import Yard',true); insert into warehouse_locations(id,job_id,warehouse_id,name,is_active) values(9304,101,9203,'HOLD',true),(9305,101,9204,'A',true),(9306,101,9204,'B',true); insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,2,'OSD Yard','HOLD','DAMAGED')");
  assert.match((await request('/settings/warehouse-locations/9304/toggle',{})).headers.get('location'),/blocked=1/);
  assert.match((await request('/settings/warehouses/9203/toggle',{})).headers.get('location'),/blocked=1/);
  assert.equal((await db.query('select is_active from warehouse_locations where id=9304')).rows[0].is_active,true);
  assert.equal((await db.query('select is_active from warehouses where id=9203')).rows[0].is_active,true);
  response=await request('/settings/warehouse-locations/import',{csv_text:'warehouse_id,warehouse_name,is_active\n9204,Empty Import Yard,false'});assert.equal(response.status,302,await response.clone().text());
  assert.ok((await db.query('select is_active from warehouse_locations where warehouse_id=9204')).rows.every(r=>!r.is_active));

  // Inventory size filtering and zero visibility work together without hiding OS&D stock.
  await db.query("update material_items set size_1='42',description='Canonical valve description' where id=9198");
  await db.exec("insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,9198,3,'Yard','NEW','DAMAGED')");
  let inventoryPage=await (await request('/inventory?ident_filter=VALVE-ZERO&size_filter=42')).text();
  assert.match(inventoryPage,/Show Zero Quantities/);
  assert.equal(Array.from(inventoryPage.matchAll(/<tr>\s*<td>VALVE-ZERO<\/td>/g)).length,1);
  assert.match(inventoryPage,/size_filter=42/);assert.match(inventoryPage,/show_zero=1/);
  inventoryPage=await (await request('/inventory?ident_filter=VALVE-ZERO&size_filter=42&show_zero=1')).text();
  assert.match(inventoryPage,/Hide Zero Quantities/);
  assert.equal(Array.from(inventoryPage.matchAll(/<tr>\s*<td>VALVE-ZERO<\/td>/g)).length,3);
  assert.match(inventoryPage,/Canonical valve description/);
  inventoryPage=await (await request('/inventory?warehouse_filter=Yard&location_filter=NEW&ident_filter=VALVE-ZERO&size_filter=99999&show_zero=1')).text();
  assert.match(inventoryPage,/No inventory rows match these filters/);
  assert.match(inventoryPage,/size_filter=99999/);assert.match(inventoryPage,/warehouse_filter=Yard/);assert.match(inventoryPage,/location_filter=NEW/);

  // Master dimensions also appear on stock received without a size, and in the download.
  response=await request('/inventory/export.xlsx');assert.equal(response.status,200);
  const displayXlsx=(await import('xlsx')).default;
  const displayBook=displayXlsx.read(Buffer.from(await response.arrayBuffer()),{type:'buffer'});
  const valveExport=displayXlsx.utils.sheet_to_json(displayBook.Sheets.Inventory).filter(r=>r.Item==='VALVE-ZERO');
  assert.ok(valveExport.length>0);assert.ok(valveExport.every(r=>String(r['Size 1'])==='42'&&r.Description==='Canonical valve description'));
  assert.equal(valveExport.reduce((n,r)=>n+Number(r['Qty OS&D']),0),3);
  assert.equal((await db.query('select size_1 from po_lines where id=9197')).rows[0].size_1,''); // ledger snapshot is unchanged

  // Downloaded reset template can be filled and imported without changing another job.
  assert.match(await (await request('/inventory-audit')).text(),/Download XLSX Template/);
  response=await request('/inventory-audit/template.xlsx');assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/inventory-reset-template.xlsx/);
  const XLSX=(await import('xlsx')).default;
  const templateBook=XLSX.read(Buffer.from(await response.arrayBuffer()),{type:'buffer'});
  assert.deepEqual(templateBook.SheetNames,['Inventory','Instructions','Locations']);
  assert.deepEqual(XLSX.utils.sheet_to_json(templateBook.Sheets.Inventory,{header:1})[0],['Item Code','Description','Size 1','Size 2','Thk 1','Thk 2','Warehouse','Location','Actual Qty']);
  assert.match(JSON.stringify(XLSX.utils.sheet_to_json(templateBook.Sheets.Instructions,{header:1})),/omitted.*zero/);
  const job101Stock=Number((await db.query('select sum(qty_adjustment) as qty from inventory_adjustment_lines where job_id=101')).rows[0].qty);
  await request('/jobs/select',{job_id:'102'});
  response=await request('/inventory-audit/template.xlsx');
  const otherTemplate=XLSX.read(Buffer.from(await response.arrayBuffer()),{type:'buffer'});
  assert.ok(!JSON.stringify(XLSX.utils.sheet_to_json(otherTemplate.Sheets.Locations,{header:1})).includes('Move Target'));
  XLSX.utils.sheet_add_aoa(otherTemplate.Sheets.Inventory,[['TEMPLATE-VALVE','Template valve','42','','','','Template Yard','T1',7]],{origin:'A2'});
  const uploadForm=new FormData();uploadForm.append('sheet',new Blob([XLSX.write(otherTemplate,{type:'buffer',bookType:'xlsx'})]),'inventory-reset-template.xlsx');
  response=await fetch(base+'/inventory-audit/import',{method:'POST',headers:{Cookie:cookie},body:uploadForm,redirect:'manual'});
  assert.equal(response.status,302,await response.clone().text());
  assert.equal(Number((await db.query("select actual_qty from inventory_audit_counts where job_id=102 and item_code='TEMPLATE-VALVE'")).rows[0].actual_qty),7);
  assert.equal(Number((await db.query('select sum(qty_adjustment) as qty from inventory_adjustment_lines where job_id=101')).rows[0].qty),job101Stock);
  await request('/jobs/select',{job_id:'101'});

  // Renaming one master ident updates all structured references without changing quantities or other jobs.
  await db.exec("insert into rfqs(id,job_id,rfq_no,project_name) values(9400,101,'RENAME-RFQ','Rename'); insert into rfq_items(job_id,rfq_id,material_item_id,item_code_snapshot,qty) values(101,9400,1001,'PIPE',2); insert into material_receiving_logs(job_id,item_code,ident_code,fluor_item_code) values(101,'PIPE','PIPE','PIPE'),(101,'ORPHAN-IDENT','',''); insert into osd_logs(job_id,item_code) values(101,'PIPE'); insert into vendor_fmr_request_lines(job_id,item_code) values(101,'PIPE'); insert into material_items(job_id,item_code,description,material_type,uom) values(102,'PIPE','Other job','pipe','EA')");
  assert.doesNotMatch(await (await request('/items?q=PIPE')).text(),/>Change Ident<\/a>/);
  assert.match(await (await request('/items/1001/edit')).text(),/Ident locked by issued requests/);
  assert.equal((await request('/items/1001/change-ident')).status,400);
  // Also block partial issues whose header no longer says Issued, and issued split loads.
  await db.query("update material_requisitions set status='ACCEPTED' where job_id=101");
  assert.equal((await request('/items/1001/change-ident')).status,400);
  await db.query('update material_requisition_lines set qty_issued=0 where requisition_id in (select id from material_requisitions where job_id=101)');
  assert.equal((await request('/items/1001/change-ident')).status,400); // posted issue ledger
  await db.query('delete from material_issue_transactions where job_id=101');
  assert.equal((await request('/items/1001/change-ident')).status,400); // issued load
  await db.query("update material_requisition_loads set status='PLANNED' where job_id=101");
  assert.match(await (await request('/items/1001/edit')).text(),/href="\/items\/1001\/change-ident"/);
  assert.match(await (await request('/items/1001/edit')).text(),/name="item_code"[^>]+readonly/);
  const renamePage=await (await request('/items/1001/change-ident')).text();
  const renameToken=tokenFrom(renamePage);
  const issuingRequest=(await db.query("select mr.id from material_requisitions mr join material_requisition_lines mrl on mrl.requisition_id=mr.id join bom_lines bl on bl.id=mrl.bom_line_id where mr.job_id=101 and bl.item_code='PIPE' limit 1")).rows[0];
  await db.query("update material_requisitions set status='ISSUED' where id=$1",[issuingRequest.id]);
  response=await request('/items/1001/change-ident',{token:renameToken,new_ident:'BLOCKED-AFTER-OPEN'});assert.equal(response.status,400);assert.match(await response.text(),/used on issued requests/);
  assert.equal((await db.query('select item_code from material_items where id=1001')).rows[0].item_code,'PIPE');
  await db.query("update material_requisitions set status='ACCEPTED' where id=$1",[issuingRequest.id]);
  assert.equal((await request('/items/1001/change-ident',{token:renameToken,new_ident:'batch-2'})).status,400);
  assert.equal((await request('/items/1001/change-ident',{token:renameToken,new_ident:'ORPHAN-IDENT'})).status,400);
  await assert.rejects(db.transaction(tx=>renameItemIdent(tx,{jobId:101,itemId:1001,oldIdent:'PIPE',newIdent:'ROLLBACK-PIPE',userId:100,auditLog:async()=>{throw new Error('rollback rename');}})),/rollback rename/);
  assert.equal((await db.query('select item_code from material_items where id=1001')).rows[0].item_code,'PIPE');
  assert.equal(Number((await db.query("select count(*) as n from inventory_location_moves where item_code='ROLLBACK-PIPE'")).rows[0].n),0);
  const issueBeforeRename=Number((await db.query('select sum(qty_issued) as n from material_issue_transactions where job_id=101')).rows[0].n);
  const receiptBeforeRename=Number((await db.query('select sum(qty_received) as n from receipts where job_id=101')).rows[0].n);
  response=await request('/items/1001/change-ident',{token:renameToken,new_ident:'PIPE-RENAMED'});assert.equal(response.status,302,await response.clone().text());
  assert.equal((await request('/items/1001/change-ident',{token:renameToken,new_ident:'PIPE-AGAIN'})).status,400);
  for(const [table,column,scope] of identTargets){
    const oldReferences=(await db.query(`select count(*) as n from ${table} where ${scope} and lower(btrim(${column}))='pipe'`,[101])).rows[0].n;
    assert.equal(Number(oldReferences),0,table+'.'+column);
    assert.ok(Number((await db.query(`select count(*) as n from ${table} where ${scope} and ${column}='PIPE-RENAMED'`,[101])).rows[0].n)>0,table+'.'+column);
  }
  assert.equal((await db.query('select item_code from material_items where id=1001')).rows[0].item_code,'PIPE-RENAMED');
  assert.equal((await db.query("select item_code from material_items where job_id=102 and item_code='PIPE'")).rows[0].item_code,'PIPE');
  assert.equal(Number((await db.query('select sum(qty_issued) as n from material_issue_transactions where job_id=101')).rows[0].n),issueBeforeRename);
  assert.equal(Number((await db.query('select sum(qty_received) as n from receipts where job_id=101')).rows[0].n),receiptBeforeRename);
  const renameAudit=JSON.parse((await db.query("select details from audit_log where action='rename_ident' and entity_id='1001'")).rows[0].details);
  assert.equal(renameAudit.old_ident,'PIPE');assert.equal(renameAudit.new_ident,'PIPE-RENAMED');
  assert.match(await (await request('/yard/item-history?item=PIPE-RENAMED')).text(),/PIPE-RENAMED/);
  await request('/jobs/select',{job_id:'102'});
  assert.equal((await request('/items/1001/change-ident')).status,400);
  assert.equal((await request('/items/1001/change-ident',{token:renameToken,new_ident:'WRONG-JOB'})).status,400);
  await request('/jobs/select',{job_id:'101'});

  await request('/jobs/select',{job_id:'102'});
  assert.equal((await request(li+'/save',{token:reviewToken})).status,400);
  await request('/jobs/select',{job_id:'101'});
  await db.query("insert into users(id,username,password_hash,role) values(101,'load-field',$1,'field')", [await bcrypt.hash("test-password", 4)]);
  await db.query("insert into user_jobs(user_id,job_id) values(101,101)");
  await request("/login", { username: "load-field", password: "test-password" });
  await request("/jobs/select", { job_id: "101" });
  assert.equal((await request(p1)).status, 200);
  assert.equal((await request(p1 + "/issue", {})).status, 403);
  assert.equal((await request(correctionPath)).status,403);
  assert.equal((await request('/yard/location-inventory')).status,403);
  assert.equal((await request('/yard/move-inventory?location_id=9300')).status,403);
  assert.equal((await request('/inventory-audit/template.xlsx')).status,403);
  assert.equal((await request('/items/1001/change-ident')).status,403);
  assert.equal((await request(legacyPath+'/unissue',{reason:'Forbidden'})).status,403);
  assert.equal((await request(p1 + "/sign", signature)).status, 403);
  await db.query("insert into users(id,username,password_hash,role) values(102,'location-warehouse',$1,'warehouse')",[await bcrypt.hash('test-password',4)]);
  await db.query('insert into user_jobs(user_id,job_id) values(102,101)');
  await request('/login',{username:'location-warehouse',password:'test-password'});
  await request('/jobs/select',{job_id:'101'});
  assert.equal((await request(li)).status,200);
  page=await (await request(li+'?warehouse=Yard&location=NEW&photo_item='+newItem.id)).text();
  assert.match(page,/Item Photos: START-NEW/);assert.match(page,/data-photo-upload/);

});

test('old numbers stay intact and new requests get PT numbers with three-digit load suffixes',async(t)=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of fs.readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<'055').sort())
    await db.exec(fs.readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  await db.exec(`insert into jobs(id,job_number) values(101,'A');
    insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(1501,101,'A','BOM-A','pipe','ACTIVE');
    insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(1601,1501,'1','PIPE','Pipe','EA',10);
    insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_name,status,request_prefix) values(1701,101,'GR-00001',1501,'Crew','ACCEPTED','GR');
    insert into material_requisition_lines(id,job_id,requisition_id,bom_line_id,qty_requested) values(1801,101,1701,1601,10);
    insert into material_requisition_loads(id,job_id,requisition_id,load_sequence,load_no,trailer_number,status,signed_copy_filename) values(1901,101,1701,1,'GR-00001-01','T1','LOADED','GR-00001-01-signed.pdf');
    insert into material_requisition_load_lines(load_id,requisition_line_id,qty) values(1901,1801,4);`);
  await db.exec(fs.readFileSync(new URL('../db/migrations/055_area_load_numbers.sql',import.meta.url),'utf8'));
  const created=await db.transaction(tx=>createRequisitionLoad(tx,{id:1701,jobId:101,userId:null,trailer:'T2',body:{qty_1801:'6'}}));
  assert.equal(created.load_no,'GR-00001-002');assert.equal(created.load_sequence,2);
  const original=(await db.query('select load_no,signed_copy_filename from material_requisition_loads where id=1901')).rows[0];
  assert.deepEqual(original,{load_no:'GR-00001-01',signed_copy_filename:'GR-00001-01-signed.pdf'});
  assert.equal((await db.query('select requisition_no from material_requisitions where id=1701')).rows[0].requisition_no,'GR-00001');

  // Avoid reusing a standalone PT number allocated by the previous release.
  await db.query("insert into material_requisition_loads(job_id,requisition_id,load_sequence,load_no,trailer_number) values(101,1701,3,'GR-PT-0042','T3')");
  const requestNo=await db.transaction(tx=>nextDeliveryRequestNumber(tx,101,{request_prefix:'GR'}));
  assert.equal(requestNo,'GR-PT-0043');
  await db.query("insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_name,status,request_prefix) values(1702,101,$1,1501,'Crew','ACCEPTED','GR')",[requestNo]);
  await db.query('insert into material_requisition_lines(id,job_id,requisition_id,bom_line_id,qty_requested) values(1802,101,1702,1601,10)');
  const first=await db.transaction(tx=>createRequisitionLoad(tx,{id:1702,jobId:101,userId:null,trailer:'T4',body:{qty_1802:'5'}}));
  const second=await db.transaction(tx=>createRequisitionLoad(tx,{id:1702,jobId:101,userId:null,trailer:'T5',body:{qty_1802:'5'}}));
  assert.equal(first.load_no,'GR-PT-0043-001');
  assert.equal(second.load_no,'GR-PT-0043-002');

});
