import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { importHeaders, parseRequisitionWorkbook, registerRequisitionExcelRoutes } from "../src/requisition-excel.js";

function file(rows, headers = importHeaders) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Import");
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

test("review highlights combined overages without writes, rechecks stock, and saves edited quantities", async () => {
  let handler, stock = 3;
  const writes = [];
  const pass = () => {};
  const client = { query: async (sql, params) => {
    if (sql.startsWith("select * from bom_headers")) return { rows: [{ id:10,bom_no:"BOM" }] };
    if (sql.startsWith("select * from bom_lines")) return { rows: params[0] === "184B2" ? [] : [{ id:123,item_code:"104B3",description:"Part" }] };
    writes.push({ sql,params });
    return { rows: [{ id:99 }] };
  } };
  registerRequisitionExcelRoutes({ get:pass, post: (_path,...handlers) => { handler=handlers.at(-1); } }, {
    requireAuth:pass, requireJobContext:pass, requirePermission:() => pass, asyncHandler:fn => fn, upload:{ single:() => pass },
    layout:(_title,body) => body, esc:value => String(value ?? ""), currentJobId:() => 42,
    withTransaction:fn => fn(client), getDeliveryLocation:async () => ({ id:3,name:"Yard" }),
    getAvailableInventoryByItemMap:async () => new Map([["104B3",stock]]), buildInventoryItemKey:line => line.item_code,
    nextDeliveryRequestNumber:async () => { writes.push({ sql:"number" }); return "REQ"; },
    getUserDisplayName:() => "Tester", getRequisitionMaterialShortages:async () => [], auditLog:async () => {}
  });
  const buffer = file([["A","104B3",2,"Paul","Paul","",""],["B","104B3",2,"Paul","Paul","",""]]);
  const req = { user:{ id:1 },body:{ bom_id:10,delivery_location_id:3 },file:{ originalname:"import.xlsx",buffer } };
  let html, redirect;
  const res = { send:value => { html=value; }, redirect:value => { redirect=value; } };
  await handler(req,res);
  assert.equal(writes.length,0);
  assert.match(html,/Overage Qty/);
  assert.match(html,/color:#b42318;font-weight:bold;">1<\/td>/);
  delete req.file;
  Object.assign(req.body,{ workbook:buffer.toString("base64"),qty_2:"2",qty_3:"1",confirm:"save" });
  stock = 1;
  await handler(req,res);
  assert.equal(writes.length,0);
  assert.equal(redirect,undefined);
  assert.match(html,/Some quantities exceed/);
  stock = 3;
  req.body.qty_3 = "0";
  req.body.confirm = "review";
  await handler(req,res);
  assert.match(html,/name="qty_3" value="0"/);
  assert.equal(writes.length,0);
  req.body.confirm = "save";
  await handler(req,res);
  assert.equal(redirect,"/requisitions/excel?imported=1");
  const lines = writes.filter(write => write.sql.startsWith("insert into material_requisition_lines"));
  assert.deepEqual(lines.map(line => line.params),[[42,99,123,2]]);
  writes.length = 0;
  redirect = undefined;
  const missingBuffer = file([["A","104B3",2,"Paul","Paul","",""],["A","184B2",1,"Paul","Paul","",""]]);
  req.file = { originalname:"import.xlsx",buffer:missingBuffer };
  req.body = { bom_id:10,delivery_location_id:3 };
  await handler(req,res);
  assert.match(html,/Ident 184B2 is not in the selected BOM/);
  assert.match(html,/name="delete_row" value="3"/);
  assert.equal(writes.length,0);
  delete req.file;
  Object.assign(req.body,{ workbook:missingBuffer.toString("base64"),qty_2:"2",qty_3:"1",confirm:"save" });
  await handler(req,res);
  assert.equal(writes.length,0);
  assert.equal(redirect,undefined);
  req.body.delete_row = "3";
  await handler(req,res);
  assert.doesNotMatch(html,/Ident 184B2 is not in the selected BOM/);
  assert.match(html,/name="qty_3" value="0"/);
  assert.equal(writes.length,0);
  delete req.body.delete_row;
  req.body.qty_3 = "0";
  await handler(req,res);
  assert.equal(redirect,"/requisitions/excel?imported=1");
  assert.deepEqual(writes.filter(w => w.sql.startsWith("insert into material_requisition_lines")).map(w => w.params),[[42,99,123,2]]);

});

test("import resolves idents and keeps missing or ambiguous lines in review without saving", async () => {
  for (const mode of ["ident", "numeric-ident", "legacy-ident", "legacy-id", "missing", "ambiguous"]) {
    const valid = !["missing", "ambiguous"].includes(mode);
    const reference = mode === "legacy-id" ? 123 : mode === "numeric-ident" ? "123" : "102B2";
    const legacy = mode.startsWith("legacy");
    let handler, committed = false, rolledBack = false, audited = false;
    const pass = () => {};
    const client = { query: async (sql,params) => {
      if (sql.startsWith("select * from bom_headers")) { assert.deepEqual(params,[10,42]); return { rows: [{ id:10 }] }; }
      if (sql.startsWith("select * from bom_lines")) { assert.deepEqual(params,[reference,10]); assert.ok(sql.includes(mode === "legacy-id" ? "where id=$1" : "where item_code=$1")); return { rows: mode === "missing" ? [] : mode === "ambiguous" ? [{ id:123 },{ id:124 }] : [{ id:123,item_code:"ITEM" }] }; }
      if (sql.startsWith("insert into material_requisition_lines")) assert.deepEqual(params,[42,99,123,2]);
      return { rows: [{ id:99 }] };
    } };
    registerRequisitionExcelRoutes({ get: pass, post: (path,...handlers) => { handler=handlers.at(-1); } }, {
      requireAuth: pass, requireJobContext: pass, requirePermission: () => pass, asyncHandler: fn => fn, upload: { single: () => pass },
      layout: (_title,body) => body, esc: value => String(value ?? ""), currentJobId: () => 42, withTransaction: async fn => { try { const result = await fn(client); committed=true; return result; } catch (error) { rolledBack=true; throw error; } },
      getDeliveryLocation: async () => ({ id:3,name:"Yard",request_prefix:"TEST" }), nextDeliveryRequestNumber: async () => "TEST-PT-0001",
      getAvailableInventoryByItemMap: async () => new Map([["ITEM",10]]), buildInventoryItemKey: line => line.item_code,
      getUserDisplayName: () => "Tester", getRequisitionMaterialShortages: async () => [], auditLog: async () => { audited=true; }
    });
    const req = { user:{ id:1 },body:{ bom_id:10,delivery_location_id:3 },file:{ originalname:"import.xlsx",buffer:file([["A",reference,2,"Requester","Recipient","",""]], legacy ? importHeaders.map((h,i) => i === 1 ? "BOM Line ID" : h) : importHeaders) } };
    const res = { send(html) { assert.match(html,/Review Excel Import/); if (!valid) { assert.match(html,mode === "ambiguous" ? /matches multiple lines/ : /not in the selected BOM/); assert.match(html,/name="delete_row" value="2"/); } }, redirect(url) { assert.equal(url,"/requisitions/excel?imported=1"); } };
    if (valid) { await handler(req,res); assert.ok(committed && !audited); req.body.workbook = req.file.buffer.toString("base64"); delete req.file; req.body.qty_2 = "2"; req.body.confirm = "save"; await handler(req,res); assert.ok(audited); }
    else { await handler(req,res); assert.ok(committed && !rolledBack && !audited); req.body.workbook = req.file.buffer.toString("base64"); delete req.file; Object.assign(req.body,{ qty_2:"2",confirm:"save" }); await handler(req,res); assert.ok(!audited); }
  }
});
