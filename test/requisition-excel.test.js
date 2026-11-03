import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { importHeaders, parseRequisitionWorkbook, registerRequisitionExcelRoutes } from "../src/requisition-excel.js";

function file(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([importHeaders, ...rows]), "Import");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
test("Excel imports group request lines and reject invalid or conflicting rows", () => {
  const row = ["A", 123, 2.125, "Requester", "Recipient", "", "Notes"];
  assert.equal(parseRequisitionWorkbook(file([row, ["A",124,1,...row.slice(3)]]))[0].lines.length, 2);
  assert.throws(() => parseRequisitionWorkbook(file([])), /no request lines/);
  for (const qty of [0, -1, "bad", 0.00001]) assert.throws(() => parseRequisitionWorkbook(file([[...row.slice(0,2), qty,...row.slice(3)]])), /Row 2/);
  assert.throws(() => parseRequisitionWorkbook(file([row,row])), /duplicate/);
  assert.throws(() => parseRequisitionWorkbook(file([row, ["A",124,1,"Other",...row.slice(4)]])), /must match/);
});

test("template download contains a blank import sheet and current-job BOM references", async () => {
  const routes = new Map();
  const pass = () => {};
  registerRequisitionExcelRoutes({ get: (path,...handlers) => routes.set(path,handlers.at(-1)), post: pass }, {
    requireAuth: pass, requireJobContext: pass, requirePermission: () => pass, asyncHandler: fn => fn, upload: { single: () => pass },
    currentJobId: () => 42, query: async (sql,params) => { assert.deepEqual(params,[42]); assert.match(sql,/bh.job_id=\$1/); return { rows: [{ id: 123,bom_no:"BOM",line_no:"1",item_code:"ITEM",description:"Item",uom:"EA" }] }; }
  });
  let buffer;
  const res = { type() { return this; }, attachment() { return this; }, send(value) { buffer=value; } };
  await routes.get("/requisitions/excel/template.xlsx")({},res);
  const book = XLSX.read(buffer,{ type: "buffer" });
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Import,{header:1}),[importHeaders]);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets["BOM Lines"])[0]["BOM Line ID"],123);
});

test("import creates grouped requests through a transaction and rejects lines outside the selected BOM", async () => {
  for (const valid of [true, false]) {
    let handler, committed = false, rolledBack = false, audited = false;
    const pass = () => {};
    const client = { query: async (sql,params) => {
      if (sql.startsWith("select * from bom_headers")) { assert.deepEqual(params,[10,42]); return { rows: [{ id:10 }] }; }
      if (sql.startsWith("select * from bom_lines")) { assert.deepEqual(params,[123,10]); return { rows: valid ? [{ item_code:"ITEM" }] : [] }; }
      return { rows: [{ id:99 }] };
    } };
    registerRequisitionExcelRoutes({ get: pass, post: (path,...handlers) => { handler=handlers.at(-1); } }, {
      requireAuth: pass, requireJobContext: pass, requirePermission: () => pass, asyncHandler: fn => fn, upload: { single: () => pass },
      currentJobId: () => 42, withTransaction: async fn => { try { await fn(client); committed=true; } catch (error) { rolledBack=true; throw error; } },
      getDeliveryLocation: async () => ({ id:3,name:"Yard",request_prefix:"TEST" }), nextDeliveryRequestNumber: async () => "TEST-PT-0001",
      getAvailableInventoryByItemMap: async () => new Map([["ITEM",10]]), buildInventoryItemKey: line => line.item_code,
      getUserDisplayName: () => "Tester", getRequisitionMaterialShortages: async () => [], auditLog: async () => { audited=true; }
    });
    const req = { user:{ id:1 },body:{ bom_id:10,delivery_location_id:3 },file:{ originalname:"import.xlsx",buffer:file([["A",123,2,"Requester","Recipient","",""]]) } };
    const res = { redirect(url) { assert.equal(url,"/requisitions/excel?imported=1"); } };
    if (valid) { await handler(req,res); assert.ok(committed && audited); }
    else { await assert.rejects(handler(req,res),/not in the selected BOM/); assert.ok(rolledBack && !committed && !audited); }
  }
});
