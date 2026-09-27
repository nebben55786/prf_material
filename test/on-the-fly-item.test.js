import assert from "node:assert/strict";
import test from "node:test";
import { addOnTheFlyBomItem } from "../src/on-the-fly-item.js";

const masterItem = {
  id: 11,
  item_code: "OTF-100",
  description: "On-the-fly item",
  material_type: "misc",
  uom: "EA",
  commodity_code: "",
  size_1: "",
  size_2: "",
  thk_1: "",
  thk_2: ""
};

function harness({ existing = false, duplicate = false, saveInventoryAuditReport } = {}) {
  const actions = [];
  const client = {
    async query(sql, params) {
      if (sql.includes("from material_items")) return { rows: existing ? [{ id: masterItem.id }] : [] };
      if (sql.includes("select id from bom_lines")) return { rows: duplicate ? [{ id: 99 }] : [] };
      if (sql.includes("insert into bom_lines")) {
        actions.push(["insert-line", params]);
        return { rows: [{ id: 31 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const services = {
    parseQtyValue(value, fallback = 0) {
      const parsed = Number(String(value).replace(/,/g, "").trim());
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    normalizeWarehouseLocationValues(warehouse, location) {
      return { warehouse: String(warehouse || "").trim(), location: String(location || "").trim() };
    },
    normalizeSpecName: (value) => String(value || "").trim(),
    async upsertMaterialMasterItem() {
      actions.push(["insert-master"]);
      return { status: "inserted", id: masterItem.id };
    },
    async getMaterialItemForUse() {
      return { item: masterItem };
    },
    async saveInventoryAuditReport(_client, payload) {
      actions.push(["inventory", payload]);
      if (saveInventoryAuditReport) return saveInventoryAuditReport(payload);
      return { reportId: 41, reportNo: "JOB-INV-00001" };
    },
    async rebuildUnallocatedBom() {
      actions.push(["rebuild"]);
    },
    async auditLog() {
      actions.push(["audit"]);
    }
  };
  return { client, services, actions };
}

const validInput = {
  line_no: "10",
  item_code: "OTF-100",
  description: "On-the-fly item",
  material_type: "misc",
  uom: "EA",
  qty_required: "4",
  actual_qty: "2",
  warehouse: "Main",
  location: "A1"
};

test("creates a new master item, BOM line, and stock adjustment", async () => {
  const { client, services, actions } = harness();
  const result = await addOnTheFlyBomItem(client, {
    bomId: 7, jobId: 3, userId: 5, input: validInput
  }, services);
  assert.equal(result.itemCreated, true);
  assert.equal(result.inventoryReport.reportNo, "JOB-INV-00001");
  assert.deepEqual(actions.map(([name]) => name), ["insert-master", "insert-line", "inventory", "rebuild", "audit"]);
  assert.equal(actions.find(([name]) => name === "inventory")[1].desiredRows[0].actual_qty, 2);
  assert.equal(actions.find(([name]) => name === "inventory")[1].rebuildUnallocated, false);
});

test("reuses an existing master item instead of updating or duplicating it", async () => {
  const { client, services, actions } = harness({ existing: true });
  const result = await addOnTheFlyBomItem(client, {
    bomId: 7, jobId: 3, userId: 5, input: { ...validInput, actual_qty: "0", warehouse: "", location: "" }
  }, services);
  assert.equal(result.itemCreated, false);
  assert.equal(actions.some(([name]) => name === "insert-master"), false);
  assert.equal(actions.some(([name]) => name === "inventory"), false);
  assert.equal(actions.some(([name]) => name === "rebuild"), true);
});

test("rejects a duplicate BOM line before changing inventory", async () => {
  const { client, services, actions } = harness({ existing: true, duplicate: true });
  await assert.rejects(
    addOnTheFlyBomItem(client, { bomId: 7, jobId: 3, userId: 5, input: validInput }, services),
    /already exists on this BOM/
  );
  assert.equal(actions.some(([name]) => name === "insert-line"), false);
  assert.equal(actions.some(([name]) => name === "inventory"), false);
});

test("rejects missing and invalid quantities or storage selections", async (t) => {
  for (const [name, input, message] of [
    ["missing required qty", { ...validInput, qty_required: "" }, /Qty Required/],
    ["invalid required qty", { ...validInput, qty_required: "nope" }, /Qty Required/],
    ["missing stock qty", { ...validInput, actual_qty: "" }, /Actual On-Hand Qty is required/],
    ["negative stock qty", { ...validInput, actual_qty: "-1" }, /zero or greater/],
    ["missing warehouse", { ...validInput, warehouse: "" }, /Warehouse and Location/],
    ["missing location", { ...validInput, location: "" }, /Warehouse and Location/]
  ]) {
    await t.test(name, async () => {
      const { client, services } = harness({ existing: true });
      await assert.rejects(
        addOnTheFlyBomItem(client, { bomId: 7, jobId: 3, userId: 5, input }, services),
        message
      );
    });
  }
});

test("surfaces invalid warehouse or location validation from the audit path", async () => {
  const { client, services } = harness({
    existing: true,
    saveInventoryAuditReport: async () => {
      throw new Error("Warehouse/location combination is not active.");
    }
  });
  await assert.rejects(
    addOnTheFlyBomItem(client, { bomId: 7, jobId: 3, userId: 5, input: validInput }, services),
    /Warehouse\/location combination is not active/
  );
});
