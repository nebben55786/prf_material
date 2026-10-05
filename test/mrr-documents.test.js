import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import XLSX from "xlsx";
import { registerMrrDocumentRoutes } from "../src/routes/mrr-documents.js";

test("MRR preserves received items while omitting not-on-load discrepancies", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("function buildMrrFormPdf(");
  const end = source.indexOf("\nfunction renderJobSwitcher", start);
  const context = vm.createContext({
    pdfEscape: (value) => String(value),
    formatShortDate: (value) => value,
    wrapPdfText: (value) => [value],
    buildDrawnPdf: (pages) => pages
  });
  vm.runInContext(source.slice(start, end), context);
  const pages = context.buildMrrFormPdf({}, [
    { item_code: "RECEIVED-PIPE", qty: "4", status: " not on this load ", discrepancy: "NOT ON THIS LOAD" },
    { item_code: "DAMAGED-PIPE", qty: "2", status: "DAMAGED", discrepancy: "Bent pipe" }
  ]);
  const content = pages.join("\n");
  assert.match(content, /RECEIVED-PIPE/);
  assert.match(content, /\(4\) Tj/);
  assert.doesNotMatch(content, /NOT ON THIS LOAD/);
  assert.match(content, /Bent pipe/);
});

function routeHarness(overrides = {}) {
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)) };
  const dependencies = {
    asyncHandler: (handler) => handler,
    auditLog: async () => {},
    buildMrrFormPdf: () => Buffer.from("pdf"),
    buildRfqFlowWorkbook: () => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Item"]]), "FLOW");
      return workbook;
    },
    currentJobId: () => 7,
    formatQtyDisplay: (value) => String(value),
    pool: {},
    query: async () => ({ rows: [] }),
    requireAuth() {},
    requireJobContext() {},
    requirePermission: () => () => {},
    ...overrides
  };
  registerMrrDocumentRoutes(app, dependencies);
  return routes;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = body; }
  };
}

test("MRR form route assembles receipt lines and linked FMR details", async () => {
  let rendered;
  const routes = routeHarness({
    query: async (sql) => {
      if (sql.includes("m.*")) return { rows: [{ mrr_number: "MRR-10", vendor_name: "Vendor", effective_po_number: "PO-3", received_date: "2026-09-26" }] };
      if (sql.includes("from receipts")) return { rows: [{ item_code: "PIPE", description: "Pipe", ordered_qty: 5, received_qty: 4, warehouse: "MAIN", location: "A1", osd_status: "SHORTAGE", notes: "One short" }, { item_code: "EXCLUDED-PO", osd_status: "NOT ON THIS LOAD" }] };
      if (sql.includes("from material_receiving_logs")) return { rows: [{ item_code: "BOLT", description: "Bolt", received_qty: 2, osd_status: "OK" }, { item_code: "EXCLUDED-MANUAL", osd_status: " not on this load " }] };
      if (sql.includes("from fmr_logs")) return { rows: [{ fmr_number: "FMR-YARD-12" }] };
      return { rows: [] };
    },
    buildMrrFormPdf: (header, lines, options) => {
      rendered = { header, lines, options };
      return Buffer.from("mrr-pdf");
    }
  });
  const res = response();
  await routes.get("/material-logs/mrr/:id/form.pdf")({ params: { id: "10" }, user: { activeJob: { job_number: "JOB-1" } } }, res);

  assert.equal(rendered.header.po_number, "PO-3");
  assert.equal(rendered.lines.length, 4);
  assert.equal(rendered.lines[1].item_code, "EXCLUDED-PO");
  assert.equal(rendered.lines[3].item_code, "EXCLUDED-MANUAL");
  assert.equal(rendered.lines[0].location, "MAIN / A1");
  assert.equal(rendered.lines[0].discrepancy, "SHORTAGE | One short");
  assert.deepEqual(rendered.options, { jobNumber: "JOB-1", deliveryLocation: "YARD", fmrNumber: "FMR-YARD-12" });
  assert.equal(res.headers["Content-Type"], "application/pdf");
  assert.match(res.headers["Content-Disposition"], /MRR-10\.pdf/);
  assert.equal(res.body.toString(), "mrr-pdf");
});

test("MRR FLOW export sorts newest lines first and records the export", async () => {
  let exportedRows;
  let auditArgs;
  const pool = {};
  const routes = routeHarness({
    pool,
    query: async (sql) => {
      if (sql.startsWith("select id, mrr_number")) return { rows: [{ id: 10, mrr_number: "MRR/10" }] };
      if (sql.includes("from receipts")) return { rows: [{ id: 1, item_code: "OLD", qty: 1, line_date: "2026-09-24" }] };
      if (sql.includes("from material_receiving_logs")) return { rows: [{ id: 2, item_code: "NEW", qty: 2, line_date: "2026-09-26" }] };
      return { rows: [] };
    },
    buildRfqFlowWorkbook: (rows) => {
      exportedRows = rows;
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Item"], ...rows.map((row) => [row.item_code])]), "FLOW");
      return workbook;
    },
    auditLog: async (...args) => { auditArgs = args; }
  });
  const res = response();
  await routes.get("/material-logs/mrr/:id/export-flow.xlsx")({ params: { id: "10" }, user: { id: 22 } }, res);

  assert.deepEqual(exportedRows.map((row) => row.item_code), ["NEW", "OLD"]);
  assert.deepEqual(auditArgs, [pool, 22, "export", "mrr_flow_workbook", 10, "rows=2|MRR/10"]);
  assert.equal(res.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(res.headers["Content-Disposition"], /MRR_10-flow\.xlsx/);
  assert.ok(Buffer.isBuffer(res.body));
  assert.ok(res.body.length > 0);
});
