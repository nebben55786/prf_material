import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("copying a BOM creates independent RFQ snapshots without changing the BOM", async () => {
  const queries = [];
  let handler;
  let redirect;
  const line = { id: 99, item_code: "PIPE", qty_required: 12, spec: "S1", notes: "Test" };
  const item = { id: 7, item_code: "PIPE", description: "Pipe", material_type: "pipe", uom: "EA" };
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes("from bom_headers")) return { rows: [{ id: 1, bom_name: "Test BOM" }] };
    if (sql.includes("from bom_lines")) return { rows: [line] };
    if (sql.includes("insert into rfqs")) return { rows: [{ id: 22 }] };
    return { rows: [] };
  } };
  const start = source.indexOf('app.post("/bom/:id/to-rfq"');
  const end = source.indexOf('\napp.post(', start + 1);
  vm.runInNewContext(source.slice(start, end), {
    app: { post(...args) { handler = args.at(-1); } },
    requireAuth() {}, requireJobContext() {}, requirePermission() {},
    currentJobId: () => 3,
    withTransaction: (fn) => fn(client),
    assertBomAllowsManualChanges() {},
    getNextRfqNumber: async () => "RFQ-1",
    getMaterialItemForUse: async () => ({ item }),
    materialItemSnapshotParams: (value) => [value.item_code, value.description, value.material_type, value.uom],
    auditLog: async () => {}
  });
  await handler({ params: { id: "1" }, body: {}, user: { id: 4 } }, { redirect(value) { redirect = value; } });
  const insert = queries.find(({ sql }) => sql.includes("insert into rfq_items"));
  assert.doesNotMatch(insert.sql, /bom_line_id/);
  assert.deepEqual(Array.from(insert.params), [3, 22, 7, "PIPE", "Pipe", "pipe", "EA", "S1", "", "", "", "", "", "", 12, "Test"]);
  assert.equal(queries.some(({ sql }) => /update bom_/.test(sql)), false);
  assert.equal(redirect, "/rfq/22");
});

test("RFQ history permits deletion while requisitions and issues still block it", () => {
  const start = source.indexOf("function assertBomLineUnusedForDelete");
  const end = source.indexOf("async function ensureUnallocatedBom", start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const check = context.assertBomLineUnusedForDelete;
  assert.doesNotThrow(() => check({ rfqCount: 1 }));
  assert.throws(() => check({ requisitionCount: 1 }), /requisition/);
  assert.throws(() => check({ issueCount: 1 }), /issue transaction/);
});
