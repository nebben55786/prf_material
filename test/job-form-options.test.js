import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create table rfqs(job_id bigint, requestor_name text);
    insert into rfqs values(1,' Alice '),(1,'Alice'),(1,'Bob'),(1,''),(1,null),(2,'Other job requestor');
    create table material_log_lookup_values(job_id bigint, kind text, value text);
    create table vendors(name text);
    create table purchase_orders(job_id bigint, po_no text);
    create table mrr_logs(job_id bigint, discipline text, received_by text, vendor_name text);
    create table material_receiving_logs(job_id bigint, discipline text, received_by text);
    insert into material_log_lookup_values values(1,'received_by','Job One Receiver'),(2,'received_by','Other Receiver'),(null,'received_by','Legacy Receiver');
    insert into purchase_orders values(1,'PO-ONE'),(2,'PO-TWO');
    insert into mrr_logs values(1,'Piping','Alice','Supplier'),(2,'Other discipline','Other Person','Other Supplier');
    insert into material_receiving_logs values(1,'Steel','Bob'),(2,'Other discipline','Other Person');
  `);
  const scope = vm.createContext({query:(sql,params)=>db.query(sql,params), normalizeJobIdValue:value=>Number(value)>0?Number(value):null,
    escAttr:value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  vm.runInContext(source.slice(source.indexOf('function disableJobFormHistory('),source.indexOf('async function getAppPurchaseOrderOptions(')),scope);
  return scope;
}
test('RFQ requestors come only from the current job and survive across browser sessions',async t=>{
  const scope=await fixture(t);
  assert.deepEqual(Array.from(await scope.getRfqRequestorOptions(1)),['Alice','Bob']);
  assert.deepEqual(Array.from(await scope.getRfqRequestorOptions(2)),['Other job requestor']);
  assert.deepEqual(Array.from(await scope.getRfqRequestorOptions(3)),[]);
  assert.deepEqual(Array.from(await scope.getRfqRequestorOptions(null)),[]);
  const html=scope.renderRfqRequestorInput(await scope.getRfqRequestorOptions(1),'Alice');
  assert.match(html,/list="rfq-requestor-options" autocomplete="off"/);
  assert.ok(html.includes('<option value="Alice"></option>'));
  assert.doesNotMatch(html,/Other job/);
  assert.match(scope.renderRfqRequestorInput(['A "quoted" <name>']),/A &quot;quoted&quot; &lt;name&gt;/);
});
test('material log saved histories exclude other jobs and unscoped legacy history',async t=>{
  const scope=await fixture(t);
  assert.deepEqual(Array.from(await scope.getMaterialLogLookupOptions('received_by',1)),['Alice','Bob','Job One Receiver']);
  assert.deepEqual(Array.from(await scope.getMaterialLogLookupOptions('discipline',1)),['Piping','Steel']);
  assert.deepEqual(Array.from(await scope.getMaterialLogLookupOptions('po_number',1)),['PO-ONE']);
  assert.deepEqual(Array.from(await scope.getMaterialLogLookupOptions('received_by',null)),[]);
});
test('job forms turn off browser history while preserving explicit autocomplete choices',async t=>{
  const scope=await fixture(t);
  const html=scope.disableJobFormHistory('<form method="post"><input name="requestor_name"></form><form autocomplete="on"><input autocomplete="username"></form>');
  assert.match(html,/<form autocomplete="off" method="post">/);
  assert.match(html,/<form autocomplete="on"><input autocomplete="username">/);
  assert.equal(scope.disableJobFormHistory(html),html);
});
