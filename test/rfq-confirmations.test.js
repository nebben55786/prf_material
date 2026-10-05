import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Readable, PassThrough } from "node:stream";
import { once } from "node:events";
import vm from "node:vm";
import { rfqConfirmationFilename, rfqConfirmationPrefix, isRfqConfirmationPath, rfqConfirmationMaxBytes, verifyRfqConfirmation } from "../src/rfq-confirmations.js";
import { registerRfqConfirmationRoutes } from "../src/routes/rfq-confirmations.js";

test("Purchasing row drop saves a confirmation without adding a view link", async () => {
  const handlers = {};
  const status = { textContent: "" };
  const input = { addEventListener: (name, fn) => { handlers[name] = fn; }, click() {} };
  const button = { addEventListener() {} };
  const row = {
    dataset: { rfqId: "2", hasScan: "false", uploadPrefix: "rfq-confirmations/job-1/rfq-2/", filename: "RFQ-123-PO-confirmation.pdf" },
    querySelector: (selector) => ({ "[data-scan-input]": input, "[data-scan-upload]": button, "[data-scan-status]": status })[selector],
    addEventListener: (name, fn) => { handlers[name] = fn; },
    classList: { add() {}, remove() {} }, contains: () => false
  };
  let saved;
  const source = fs.readFileSync(new URL("../public/rfq-confirmations.js", import.meta.url), "utf8");
  vm.runInNewContext(source.replace("await import(moduleUrl)", "await mockImport(moduleUrl)"), {
    document: { querySelector: () => ({ dataset: { clientModuleUrl: "/blob-client.js" } }), querySelectorAll: () => [row] },
    crypto: { randomUUID: () => uploadId }, window: { confirm: () => true },
    mockImport: async () => ({ upload: async (pathname, file, options) => {
      assert.equal(options.access, "private");
      assert.equal(options.handleUploadUrl, "/rfq/2/po-confirmation/client-upload");
      return { pathname };
    } }),
    fetch: async (url, options) => {
      assert.equal(url, "/rfq/2/po-confirmation/complete");
      saved = JSON.parse(options.body).pathname;
      return { ok: true, json: async () => ({ openUrl: "/rfq/2/po-confirmation/open" }) };
    }
  });
  handlers.drop({ preventDefault() {}, dataTransfer: { files: [{ name: "confirmation.pdf", size: 100, slice: () => ({ text: async () => "%PDF-" }) }] } });
  for (let i = 0; i < 20 && status.textContent !== "PO confirmation saved."; i++) await new Promise(setImmediate);
  assert.equal(status.textContent, "PO confirmation saved.");
  assert.equal(saved, pathname);
  assert.equal(row.dataset.hasScan, "true");
  assert.equal(button.disabled, false);
});

const uploadId = "b6503b1a-c353-46c2-9080-1141df1467b5";
const pathname = `${rfqConfirmationPrefix(1, 2)}${uploadId}/RFQ-123-PO-confirmation.pdf`;
const makeBlob = (text = "%PDF-1.7", metadata = {}) => ({
  blob: { contentType: "application/pdf", size: 100, ...metadata },
  stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text.slice(0, 2))); controller.enqueue(Buffer.from(text.slice(2))); controller.close(); } })
});

test("RFQ filenames retain the number and replace unsafe filename characters", () => {
  assert.equal(rfqConfirmationFilename("RFQ-00123"), "RFQ-00123-PO-confirmation.pdf");
  assert.equal(rfqConfirmationFilename("RFQ/123:4"), "RFQ_123_4-PO-confirmation.pdf");
  assert.equal(rfqConfirmationFilename(""), "RFQ-PO-confirmation.pdf");
});

test("attachment paths are restricted to the job, RFQ, unique upload, and generated filename", () => {
  assert.equal(isRfqConfirmationPath(pathname, 1, 2, "RFQ-123"), true);
  for (const candidate of [pathname.replace("job-1", "job-9"), pathname.replace("rfq-2", "rfq-9"), pathname + "/extra", pathname.replace(uploadId, ".."), pathname.replace("RFQ-123-PO-confirmation.pdf", "other.pdf"), "https://example.com/scan.pdf"]) {
    assert.equal(isRfqConfirmationPath(candidate, 1, 2, "RFQ-123"), false);
  }
});

test("PDF validation handles split headers and rejects disguised files, empty files, and large files", async () => {
  await verifyRfqConfirmation(makeBlob());
  await assert.rejects(verifyRfqConfirmation(makeBlob("not a pdf")), /not a PDF/);
  await assert.rejects(verifyRfqConfirmation(makeBlob("%PDF-", { contentType: "text/html" })), /Upload a PDF/);
  await assert.rejects(verifyRfqConfirmation(makeBlob("%PDF-", { size: 0 })), /Upload a PDF/);
  await assert.rejects(verifyRfqConfirmation(makeBlob("%PDF-", { size: rfqConfirmationMaxBytes + 1 })), /Upload a PDF/);
  await assert.rejects(verifyRfqConfirmation(null), /not available/);
});

// Exercise the actual route handlers without connecting to the production database or Blob store.
function routeHarness(overrides = {}) {
  const routes = new Map();
  const row = { id: 2, rfq_no: "RFQ-123", po_confirmation_pdf_pathname: "old-scan.pdf" };
  const actions = [];
  const context = {
    app: {
      post: (url, ...handlers) => routes.set("POST " + url, handlers.at(-1)),
      get: (url, ...handlers) => routes.set("GET " + url, handlers.at(-1))
    },
    express: { json: () => () => {} },
    requireAuth() {}, requireJobContext() {}, requirePermission: () => () => {},
    asyncHandler: (fn) => fn,
    currentJobId: () => 1,
    getRequestAuthContext: async () => ({ id: 3, job_id: 1, activeJob: { id: 1 } }),
    canAccess: () => true,
    query: async () => ({ rows: [row] }),
    withTransaction: async (fn) => {
      const result = await fn({ query: async (sql, params) => {
        if (sql.includes("update rfqs")) actions.push(["update", params]);
        return { rows: [row] };
      } });
      actions.push(["commit"]);
      return result;
    },
    auditLog: async () => actions.push(["audit"]),
    get: async () => makeBlob(),
    del: async (path) => actions.push(["delete", path]),
    handleUpload: async (options) => options.onBeforeGenerateToken(pathname),
    rfqConfirmationFilename, rfqConfirmationPrefix, isRfqConfirmationPath, rfqConfirmationMaxBytes, verifyRfqConfirmation,
    console, Readable, contentDispositionFilename: (value) => value, ...overrides
  };
  registerRfqConfirmationRoutes(context.app, context);
  return { routes, row, actions };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, send(body) { this.body = body; } };
}
const request = () => ({ params: { id: "2" }, body: { pathname }, user: { id: 3 } });
const completeRoute = "POST /rfq/:id/po-confirmation/complete";
const tokenRoute = "POST /rfq/:id/po-confirmation/client-upload";

test("upload token enforces PDF type, size, and immutable storage paths", async () => {
  const { routes } = routeHarness();
  const res = response();
  await routes.get(tokenRoute)(request(), res);
  assert.equal(res.body.allowedContentTypes[0], "application/pdf");
  assert.equal(res.body.maximumSizeInBytes, rfqConfirmationMaxBytes);
  assert.equal(res.body.allowOverwrite, false);
});

test("upload token denies missing edit permission and inaccessible RFQ", async () => {
  for (const overrides of [{ canAccess: () => false }, { query: async () => ({ rows: [] }) }]) {
    const { routes } = routeHarness(overrides);
    const res = response();
    await routes.get(tokenRoute)(request(), res);
    assert.equal(res.statusCode, 400);
  }
});

test("replacement commits the new scan before deleting the old scan", async () => {
  const { routes, actions } = routeHarness();
  const res = response();
  await routes.get(completeRoute)(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.openUrl, "/rfq/2/po-confirmation/open");
  assert.deepEqual(actions.map(([action]) => action), ["update", "audit", "commit", "delete"]);
  assert.equal(actions[0][1][0], pathname);
});

test("invalid PDF does not update or delete the saved scan", async () => {
  const { routes, actions } = routeHarness({ get: async () => makeBlob("not pdf") });
  const res = response();
  await routes.get(completeRoute)(request(), res);
  assert.equal(res.statusCode, 400);
  assert.equal(actions.length, 0);
});

test("completion cannot attach a different job's scan", async () => {
  const { routes, actions } = routeHarness();
  const res = response();
  const req = request();
  req.body.pathname = pathname.replace("job-1", "job-8");
  await routes.get(completeRoute)(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(actions.length, 0);
});

test("repeated completion is idempotent and does not delete the current scan", async () => {
  const { routes, row, actions } = routeHarness();
  row.po_confirmation_pdf_pathname = pathname;
  const res = response();
  await routes.get(completeRoute)(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(actions.map(([action]) => action), ["commit"]);
});

test("opening an RFQ without a scan returns 404", async () => {
  const { routes, row } = routeHarness();
  row.po_confirmation_pdf_pathname = "";
  const res = response();
  await routes.get("GET /rfq/:id/po-confirmation/open")(request(), res);
  assert.equal(res.statusCode, 404);
});

test("opening a scan streams a private PDF with the RFQ number as its filename", async () => {
  const { routes } = routeHarness({ query: async (sql, params) => {
    assert.deepEqual(Array.from(params), [2, 1]);
    return { rows: [{ rfq_no: "RFQ-123", po_confirmation_pdf_pathname: pathname }] };
  } });
  const res = new PassThrough();
  const headers = {};
  const chunks = [];
  res.setHeader = (key, value) => { headers[key] = value; };
  res.on("data", (chunk) => chunks.push(chunk));
  const finished = once(res, "end");
  await routes.get("GET /rfq/:id/po-confirmation/open")(request(), res);
  await finished;
  assert.equal(headers["Content-Type"], "application/pdf");
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.match(headers["Content-Disposition"], /inline; filename="RFQ-123-PO-confirmation.pdf"/);
  assert.equal(Buffer.concat(chunks).toString(), "%PDF-1.7");
});

