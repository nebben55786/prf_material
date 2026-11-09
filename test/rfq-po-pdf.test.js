import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import bcrypt from "bcryptjs";
import { PGlite } from "@electric-sql/pglite";

// A synthetic two-page fixture in the supplier's layout, with a repeated item.
function purchaseOrderPdf() {
  const at = (x, y, text) => `BT /F1 9 Tf ${x} ${y} Td (${text}) Tj ET\n`;
  const header = y => ["Line", "Item number", "Description", "Quantity", "Unit", "Unit price", "Line total"]
    .map((label, i) => at([59, 79, 137, 338, 385, 419, 515][i], y, label)).join("");
  const line = (y, number, description, quantity, price) => at(59, y, number) + at(137, y, description) +
    at(352, y, quantity) + at(388, y - 1, "EA") + at(425, y, price);
  const first = at(231, 735, "Vendor") + at(231, 719, "Wholesale Electric Supply") +
    at(231, 708, "Company, Inc") + at(231, 668, "Ship to") +
    at(372, 723, "PO Number") + at(518, 723, "580852-1") +
    at(371, 689, "PO creator") + at(467, 689, "Hoffmann, Joshua David") +
    header(417) + line(407, 1, "G3200RG15018M Gasket", "64.00", "12.41");
  const second = header(747) + line(736, 2, "G3200RG15018M Gasket", "8.00", "13.50") +
    line(711, 3, "VENDOR-ONLY Alternate gasket", "2.00", "3.50") +
    line(687, 4, "SKIP-ME Unneeded part", "1.00", "1.00");
  const page = content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`;
  const stream = contents => `<< /Length ${contents.length} >>\nstream\n${contents}endstream`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    page(6), page(7), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", stream(first), stream(second)];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("PO PDF review creates one awarded RFQ using current-job idents and rolls back a failed save", async t => {
  const db = new PGlite();
  const root = new URL("../src/", import.meta.url);
  const stub = new URL(`.po-pdf-test-db-${process.pid}.mjs`, root);
  const serverFile = new URL(`.po-pdf-test-server-${process.pid}.mjs`, root);
  const oldVercel = process.env.VERCEL;
  let listener;
  t.after(async () => {
    if (listener) await new Promise(resolve => listener.close(resolve));
    await db.close();
    fs.rmSync(stub, { force: true });
    fs.rmSync(serverFile, { force: true });
    if (oldVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = oldVercel;
    delete globalThis.__poPdfTestDb;
  });
  const migrations = new URL("../db/migrations/", import.meta.url);
  for (const file of fs.readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(new URL(file, migrations), "utf8"));
  }
  await db.query("insert into users(id,username,password_hash,role) values(100,'pdf-tester',$1,'admin')", [await bcrypt.hash("test-password", 4)]);
  await db.exec(`
    insert into jobs(id,job_number) values(101,'A'),(102,'B');
    insert into vendors(id,name,categories) values(100,'Wholesale Electric Supply Company Inc.','pipe'),(101,'Alternate Vendor','pipe');
    insert into material_items(id,job_id,item_code,description,material_type,uom) values
      (1001,101,'G3200RG15018M','Gasket','pipe','EA'),(1002,101,'LOCAL-IDENT','Alternate gasket','pipe','BOX'),
      (1003,102,'OTHER-JOB','Foreign item','pipe','EA');
  `);
  globalThis.__poPdfTestDb = db;
  process.env.VERCEL = "1";
  fs.writeFileSync(stub, `
    const db=globalThis.__poPdfTestDb;
    export const query=async(sql,params=[])=>{const result=await db.query(sql,params);return {...result,rowCount:result.affectedRows??result.rows.length};};
    export const pool={query};
    export const initDb=async()=>{};
    export const withTransaction=fn=>db.transaction(fn);
    export const auditLog=(client,u,a,type,id,details)=>client.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",[u,a,type,String(id),details]);
    export let vendorCategories=['pipe'];
    export let permissionMatrix={};
    export const setVendorCategories=value=>vendorCategories=value;
    export const setPermissionMatrix=value=>permissionMatrix=value;
  `);
  fs.writeFileSync(serverFile, fs.readFileSync(new URL("server.js", root), "utf8").replace('from "./db.js";', `from "${stub.href}";`));
  const app = (await import(serverFile.href)).default;
  listener = await new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  let cookie = "";
  async function request(path, body) {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
      method: body ? "POST" : "GET", body, redirect: "manual", headers: { Cookie: cookie }
    });
    for (const value of response.headers.getSetCookie()) {
      if (value.startsWith("session_token=")) cookie = value.split(";")[0];
    }
    return response;
  }
  assert.equal((await request("/login", new URLSearchParams({ username: "pdf-tester", password: "test-password" }))).status, 302);
  assert.equal((await request("/jobs/select", new URLSearchParams({ job_id: "101" }))).status, 302);
  assert.match(await (await request("/rfq/new")).text(), /Create RFQ from PO PDF/);
  const path = "/rfq/new/po-pdf";
  const invalidUpload = new FormData();
  invalidUpload.set("po_pdf", new Blob(["not a PDF"]), "invalid.pdf");
  const invalid = await request(`${path}/review`, invalidUpload);
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /does not contain a readable purchase order/);
  const upload = new FormData();
  upload.set("po_pdf", new Blob([purchaseOrderPdf()], { type: "application/pdf" }), "fixture.pdf");
  const preview = await request(`${path}/review`, upload);
  const html = await preview.text();
  assert.equal(preview.status, 200, html.match(/role="alert">([^<]+)/)?.[1]);
  assert.match(html, /value="580852-1"/);
  assert.match(html, /value="Joshua David Hoffmann"/);
  assert.match(html, /value="100" selected/);
  assert.match(html, /name="ident_0"[^>]+value="G3200RG15018M"/);
  assert.match(html, /name="ident_1"[^>]+value="G3200RG15018M"/);
  assert.match(html, /name="ident_2"[^>]+value=""/);
  assert.deepEqual((await (await request(`${path}/idents?q=Alternate%20gasket`)).json()).map(item => item.item_code), ["LOCAL-IDENT"]);
  const body = new URLSearchParams({
    review_token: html.match(/name="review_token" value="([^"]+)"/)[1],
    po_number: "580852-1", project_name: "PO 580852-1", requestor_name: "Joshua David Hoffmann", due_date: "2026-12-01", vendor_id: "101",
    ident_0: "G3200RG15018M", ident_1: "G3200RG15018M", ident_2: "OTHER-JOB", skip_3: "1"
  });
  const assertEmpty = async () => {
    for (const table of ["rfqs", "rfq_items", "rfq_vendors", "quotes", "quote_revisions", "purchase_orders"]) {
      assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
    }
  };
  await assertEmpty();
  const crossJob = await request(`${path}/create`, body);
  assert.equal(crossJob.status, 422);
  assert.match(await crossJob.text(), /PO line 3: choose a unique Item Master ident from this job/);
  body.set("ident_2", "LOCAL-IDENT");
  const unitMismatch = await request(`${path}/create`, body);
  assert.equal(unitMismatch.status, 422);
  assert.match(await unitMismatch.text(), /Item Master unit BOX/);
  body.set("confirm_units", "1");
  await db.exec("alter table quotes add constraint test_force_failure check (unit_price <> 13.50)");
  assert.equal((await request(`${path}/create`, body)).status, 500);
  await assertEmpty();
  await db.exec("alter table quotes drop constraint test_force_failure");
  const created = await request(`${path}/create`, body);
  assert.equal(created.status, 302, await created.text());
  const retry = await request(`${path}/create`, body);
  assert.equal(retry.headers.get("location"), created.headers.get("location"));
  const rfqPage = await request(created.headers.get("location"));
  assert.equal(rfqPage.status, 200);
  const rfqHtml = await rfqPage.text();
  assert.match(rfqHtml, /Alternate Vendor/);
  assert.match(rfqHtml, /\$13\.50/);
  assert.deepEqual((await db.query("select po_number, requestor_name, status from rfqs")).rows,
    [{ po_number: "580852-1", requestor_name: "Joshua David Hoffmann", status: "AWARDED" }]);
  const lines = (await db.query(`
    select po_line, item_code_snapshot, qty, awarded_vendor_id, awarded_unit_price, unit_price
    from rfq_items join quotes on quotes.rfq_item_id = rfq_items.id order by po_line
  `)).rows;
  assert.deepEqual(lines.map(row => [row.po_line, row.item_code_snapshot, Number(row.qty), Number(row.awarded_vendor_id), Number(row.awarded_unit_price), Number(row.unit_price)]),
    [["1", "G3200RG15018M", 64, 101, 12.41, 12.41], ["2", "G3200RG15018M", 8, 101, 13.5, 13.5], ["3", "LOCAL-IDENT", 2, 101, 3.5, 3.5]]);
  assert.equal((await db.query("select count(*)::int as n from purchase_orders")).rows[0].n, 0);
});
