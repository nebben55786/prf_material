import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function harness({ fail = false } = {}) {
  let handler;
  const inserted = [];
  const lines = [1, 2].map((id) => ({ rfq_item_id: id, material_item_id: 7, po_line: String(id), item_code: "PIPE", qty: 5, unit_price: 10 }));
  const client = { async query(sql, params) {
    if (fail) throw new Error("Database request failed");
    if (sql.includes("select project_name")) return { rows: [{ project_name: "Test" }] };
    if (sql.includes("vendor_awarded_count")) return { rows: [{ total_count: 2, vendor_awarded_count: 2 }] };
    if (sql.includes("insert into purchase_orders")) return { rows: [{ id: 8 }] };
    if (sql.includes("select ri.id as rfq_item_id")) return { rows: lines };
    if (sql.includes("select id, rfq_item_id")) {
      const match = inserted.find((line) => sql.includes("material_item_id = $2") ? line.material_item_id === params[1] : line.po_line === params[1]);
      return { rows: match ? [match] : [] };
    }
    if (sql.includes("insert into po_lines")) inserted.push({ id: inserted.length + 1, rfq_item_id: params[2], material_item_id: params[3], po_line: params[8] });
    return { rows: [] };
  } };
  const context = vm.createContext({
    app: { post(...args) { handler = args.at(-1); } },
    requireAuth() {}, requireJobContext() {}, requirePermission() {},
    currentJobId: () => 3,
    withTransaction: (fn) => fn(client),
    findCanonicalPurchaseOrderByNumber: async () => null,
    refreshRfqEtaFromPos: async () => {}, recalcPoStatus: async () => {}, recalcRfqStatus: async () => {}, auditLog: async () => {},
    num: Number, getSafeReturnPath: () => "/rfq/6"
  });
  const asyncStart = source.indexOf("function asyncHandler(");
  vm.runInContext(source.slice(asyncStart, source.indexOf("\n}", asyncStart) + 2), context);
  const helperStart = source.indexOf("async function findExistingPoLine(");
  vm.runInContext(source.slice(helperStart, source.indexOf("async function getRfqIdsForPo", helperStart)), context);
  const routeStart = source.indexOf('app.post("/po/create"');
  vm.runInContext(source.slice(routeStart, source.indexOf('\napp.get(', routeStart)), context);
  return { handler, inserted };
}

test("Create PO preserves separate RFQ lines sharing an item code", async () => {
  const { handler, inserted } = harness();
  const result = await new Promise((resolve, reject) => {
    handler({ body: { rfq_id: 6, vendor_id: 4, po_no: "PO-1" }, user: { id: 1 } }, { redirect: resolve }, reject);
  });
  assert.equal(result, "/rfq/6");
  assert.equal(inserted.length, 2);
  assert.deepEqual(inserted.map((line) => line.rfq_item_id), [1, 2]);
});

test("Create PO forwards database failures to error middleware instead of hanging", async () => {
  const { handler } = harness({ fail: true });
  const error = await new Promise((resolve, reject) => {
    handler({ body: { rfq_id: 6, vendor_id: 4, po_no: "PO-1" }, user: { id: 1 } }, { redirect: () => reject(new Error("Unexpected redirect")) }, resolve);
  });
  assert.match(error.message, /Database request failed/);
});
