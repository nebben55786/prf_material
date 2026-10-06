import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
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
test("delivery prefixes validate and location access stays separate from storage", async (t) => {
  const db = await fixture(t);
  assert.equal(normalizeRequestPrefix(" mh-mr- "), "MH-MR");
  assert.equal(normalizeRequestPrefix("MH/GR-MR"), "MH/GR-MR");
  for (const value of ["", "bad prefix", "<script>", "a".repeat(61)])
    assert.throws(() => normalizeRequestPrefix(value));
  assert.equal((await getDeliveryLocation(db, 101, 100)).name, "Memphis");
  await assert.rejects(getDeliveryLocation(db, 101, 102), /active delivery/);
  await db.query("update delivery_locations set is_active=false where id=100");
  await assert.rejects(getDeliveryLocation(db, 101, 100), /active delivery/);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from warehouses where job_id=101",
      )
    ).rows[0].n,
    0,
  );
});
test("per-prefix numbers allocate uniquely and failed transactions roll back counters", async (t) => {
  const db = await fixture(t),
    location = await getDeliveryLocation(db, 101, 100);
  const numbers = await Promise.all([
    db.transaction((tx) => nextDeliveryRequestNumber(tx, 101, location)),
    db.transaction((tx) => nextDeliveryRequestNumber(tx, 101, location)),
  ]);
  assert.deepEqual(numbers, ["MH-MR-00001", "MH-MR-00002"]);
  await assert.rejects(
    db.transaction(async (tx) => {
      await nextDeliveryRequestNumber(tx, 101, location);
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(
    await db.transaction((tx) => nextDeliveryRequestNumber(tx, 101, location)),
    "MH-MR-00003",
  );
  assert.equal(
    await db.transaction((tx) =>
      nextDeliveryRequestNumber(tx, 101, { request_prefix: "GR-MR" }),
    ),
    "GR-MR-00001",
  );
  assert.equal(await db.transaction(tx=>nextDeliveryRequestNumber(tx,101,{request_prefix:"Legacy Job-MR"})),"Legacy Job-MR-00001");
});
test("request builder, preview, save and settings carry delivery location through actual authenticated routes", async (t) => {
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
    stub = new URL(".delivery-test-db-" + process.pid + ".mjs", root),
    serverFile = new URL(".delivery-test-server-" + process.pid + ".mjs", root);
  const old = process.env.VERCEL;
  process.env.VERCEL = "1";
  globalThis.__deliveryTestDb = db;
  fs.writeFileSync(
    stub,
    `const db=globalThis.__deliveryTestDb; export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};export const pool={query};export const initDb=async()=>{};export const withTransaction=fn=>db.transaction(fn);export const auditLog=async(db,u,a,type,id,details)=>db.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",[u,a,type,String(id||''),details]);export let vendorCategories=['pipe'];export let permissionMatrix={};export const setVendorCategories=x=>vendorCategories=x;export const setPermissionMatrix=x=>permissionMatrix=x;`,
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
    delete globalThis.__deliveryTestDb;
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
  const setup = await request("/settings/warehouse-setup");
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /Delivery Locations/);
  const first = await request("/requisitions/new");
  const firstHtml = await first.text();
  assert.equal(first.status, 200);
  assert.ok(
    firstHtml.indexOf("Select Delivery Location") <
      firstHtml.indexOf("Select BOM"),
  );
  assert.match(firstHtml, /Memphis/);
  assert.doesNotMatch(firstHtml, /Other Job/);
  const builder = await request(
    "/requisitions/new?bom_id=1501&delivery_location_id=100",
  );
  assert.equal(builder.status, 200);
  assert.match(await builder.text(), /name="delivery_location_id" value="100"/);
  const body = {
    delivery_location_id: "100",
    issued_to: "Crew",
    selected_line_ids: "1601",
    request_qty_1601: "3",
  };
  const preview = await request("/bom/1501/requisitions/preview", body);
  assert.equal(preview.status, 200, await preview.text());
  const created = await request("/bom/1501/requisitions", body);
  assert.equal(created.status, 302, await created.text());
  const req = (
    await db.query(
      "select * from material_requisitions where requisition_no='MH-MR-00001'",
    )
  ).rows[0];
  assert.ok(req);
  assert.equal(req.delivery_location_name, "Memphis");
  assert.equal(req.request_prefix, "MH-MR");
  await db.query(
    "update material_requisitions set status='ACCEPTED' where id=$1",
    [req.id],
  );
  const ticket = await request("/requisitions/" + req.id + "/pick-ticket.pdf");
  assert.equal(ticket.status, 200);
  const pdf = Buffer.from(await ticket.arrayBuffer()).toString("latin1");
  assert.match(pdf, /DELIVERY LOCATION/);
  assert.match(pdf, /Memphis/);
  const changed = await request(
    "/settings/warehouse-setup/delivery-locations/100",
    { name: "New Name", request_prefix: "NEW-MR", is_active: "1" },
  );
  assert.equal(changed.status, 302);
  const detail = await request("/requisitions/" + req.id);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Memphis/);
  assert.equal(
    (
      await request("/bom/1501/requisitions", {
        ...body,
        delivery_location_id: "102",
      })
    ).status,
    400,
  );
  const missing = { ...body };
  delete missing.delivery_location_id;
  assert.equal((await request("/bom/1501/requisitions", missing)).status, 400);
  const created2 = await request("/bom/1501/requisitions", body);
  assert.equal(created2.status, 302);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from material_requisitions where requisition_no='NEW-MR-00001'",
      )
    ).rows[0].n,
    1,
  );
});
