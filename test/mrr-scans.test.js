import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, PassThrough } from "node:stream";
import { once } from "node:events";
import { mrrScanFilename, mrrScanPrefix, isMrrScanPath, mrrScanMaxBytes, verifyMrrScan } from "../src/mrr-scans.js";

const uploadId = "b6503b1a-c353-46c2-9080-1141df1467b5";
const pathname = `${mrrScanPrefix(1, 2)}${uploadId}/MRR-123.pdf`;
const makeBlob = (text = "%PDF-1.7", metadata = {}) => ({
  blob: { contentType: "application/pdf", size: 100, ...metadata },
  stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text.slice(0, 2))); controller.enqueue(Buffer.from(text.slice(2))); controller.close(); } })
});

test("MRR filenames retain the number and replace unsafe filename characters", () => {
  assert.equal(mrrScanFilename("MRR-00123"), "MRR-00123.pdf");
  assert.equal(mrrScanFilename("MRR/123:4"), "MRR_123_4.pdf");
  assert.equal(mrrScanFilename(""), "MRR.pdf");
});

test("attachment paths are restricted to the job, MRR, unique upload, and generated filename", () => {
  assert.equal(isMrrScanPath(pathname, 1, 2, "MRR-123"), true);
  for (const candidate of [pathname.replace("job-1", "job-9"), pathname.replace("mrr-2", "mrr-9"), pathname + "/extra", pathname.replace(uploadId, ".."), pathname.replace("MRR-123.pdf", "other.pdf"), "https://example.com/scan.pdf"]) {
    assert.equal(isMrrScanPath(candidate, 1, 2, "MRR-123"), false);
  }
});

test("PDF validation handles split headers and rejects disguised files, empty files, and large files", async () => {
  await verifyMrrScan(makeBlob());
  await assert.rejects(verifyMrrScan(makeBlob("not a pdf")), /not a PDF/);
  await assert.rejects(verifyMrrScan(makeBlob("%PDF-", { contentType: "text/html" })), /Upload a PDF/);
  await assert.rejects(verifyMrrScan(makeBlob("%PDF-", { size: 0 })), /Upload a PDF/);
  await assert.rejects(verifyMrrScan(makeBlob("%PDF-", { size: mrrScanMaxBytes + 1 })), /Upload a PDF/);
  await assert.rejects(verifyMrrScan(null), /not available/);
});

// Exercise the actual route handlers without connecting to the production database or Blob store.
const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
function routeHarness(overrides = {}) {
  const routes = new Map();
  const row = { id: 2, mrr_number: "MRR-123", scanned_pdf_pathname: "old-scan.pdf" };
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
        if (sql.includes("update mrr_logs")) actions.push(["update", params]);
        return { rows: [row] };
      } });
      actions.push(["commit"]);
      return result;
    },
    auditLog: async () => actions.push(["audit"]),
    get: async () => makeBlob(),
    del: async (path) => actions.push(["delete", path]),
    handleUpload: async (options) => options.onBeforeGenerateToken(pathname),
    mrrScanFilename, mrrScanPrefix, isMrrScanPath, mrrScanMaxBytes, verifyMrrScan,
    console, Readable, contentDispositionFilename: (value) => value, ...overrides
  };
  vm.runInNewContext(source.slice(source.indexOf('app.post("/material-logs/mrr/:id/scanned-pdf/client-upload"'), source.indexOf('app.post("/material-logs/mrr/:id/reverse"')), context);
  return { routes, row, actions };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, send(body) { this.body = body; } };
}
const request = () => ({ params: { id: "2" }, body: { pathname }, user: { id: 3 } });
const completeRoute = "POST /material-logs/mrr/:id/scanned-pdf/complete";
const tokenRoute = "POST /material-logs/mrr/:id/scanned-pdf/client-upload";

test("upload token enforces PDF type, size, and immutable storage paths", async () => {
  const { routes } = routeHarness();
  const res = response();
  await routes.get(tokenRoute)(request(), res);
  assert.equal(res.body.allowedContentTypes[0], "application/pdf");
  assert.equal(res.body.maximumSizeInBytes, mrrScanMaxBytes);
  assert.equal(res.body.allowOverwrite, false);
});

test("upload token denies missing edit permission and inaccessible MRR", async () => {
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
  assert.equal(res.body.openUrl, "/material-logs/mrr/2/scanned-pdf/open");
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
  row.scanned_pdf_pathname = pathname;
  const res = response();
  await routes.get(completeRoute)(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(actions.map(([action]) => action), ["commit"]);
});

test("opening an MRR without a scan returns 404", async () => {
  const { routes, row } = routeHarness();
  row.scanned_pdf_pathname = "";
  const res = response();
  await routes.get("GET /material-logs/mrr/:id/scanned-pdf/open")(request(), res);
  assert.equal(res.statusCode, 404);
});

test("opening a scan streams a private PDF with the MRR number as its filename", async () => {
  const { routes } = routeHarness({ query: async (sql, params) => {
    assert.deepEqual(Array.from(params), [2, 1]);
    return { rows: [{ mrr_number: "MRR-123", scanned_pdf_pathname: pathname }] };
  } });
  const res = new PassThrough();
  const headers = {};
  const chunks = [];
  res.setHeader = (key, value) => { headers[key] = value; };
  res.on("data", (chunk) => chunks.push(chunk));
  const finished = once(res, "end");
  await routes.get("GET /material-logs/mrr/:id/scanned-pdf/open")(request(), res);
  await finished;
  assert.equal(headers["Content-Type"], "application/pdf");
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.match(headers["Content-Disposition"], /inline; filename="MRR-123.pdf"/);
  assert.equal(Buffer.concat(chunks).toString(), "%PDF-1.7");
});

async function renderLog(canEdit = true) {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const css = source.slice(source.indexOf("<style>") + 7, source.indexOf("</style>"));
  const { routes } = routeHarness({
    query: async () => ({ rows: [
      { id: 2, mrr_number: "MRR-123", vendor_name: "Test Vendor", material_description: "Pipe fittings", scanned_pdf_pathname: "" },
      { id: 3, mrr_number: "MRR-124", vendor_name: "Test Vendor", scanned_pdf_pathname: "saved.pdf" }
    ] }),
    canAccess: () => canEdit,
    esc: escape, escAttr: escape, formatShortDateTime: () => "09/17/2026",
    vercelBlobClientModuleUrl: "/mock-blob.js",
    layout: (title, body) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="shell">${body}</main></body></html>`
  });
  const res = response();
  await routes.get("GET /material-logs/mrr")({ query: {}, user: {} }, res);
  return res.body;
}

test("log disables missing scans, links saved scans, and hides upload for read-only users", async () => {
  const html = await renderLog();
  assert.match(html, /aria-disabled="true" tabindex="-1"/);
  assert.match(html, /href="\/material-logs\/mrr\/3\/scanned-pdf\/open"/);
  assert.match(html, /data-scan-upload/);
  assert.doesNotMatch(await renderLog(false), /data-scan-upload/);
});

test("browser: row drop, picker, replacement failure, and responsive scan controls", { skip: !process.env.TEST_PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.TEST_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const html = await renderLog();
    const uploadedPaths = [];
    let fail = false;
    await page.route("http://127.0.0.1:3199/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/public/mrr-scans.js") return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(new URL("../public/mrr-scans.js", import.meta.url), "utf8") });
      if (url.pathname === "/mock-blob.js") return route.fulfill({ contentType: "text/javascript", body: 'export async function upload(pathname, file, options) { options.onUploadProgress({percentage: 100}); return {pathname}; }' });
      if (url.pathname.endsWith("/complete")) {
        uploadedPaths.push(route.request().postDataJSON().pathname);
        return route.fulfill({ status: fail ? 400 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "Test storage failure" } : { openUrl: "/material-logs/mrr/2/scanned-pdf/open" }) });
      }
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto("http://127.0.0.1:3199/material-logs/mrr");
    const row = page.locator('[data-mrr-id="2"]');
    const open = row.locator("[data-scan-open]");
    assert.equal(await open.getAttribute("aria-disabled"), "true");
    const drop = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["%PDF-1.7\nTest scan"], "scanner-original.pdf", { type: "application/pdf" }));
      return transfer;
    });
    await row.dispatchEvent("dragover", { dataTransfer: drop });
    assert.match(await row.getAttribute("class"), /scan-drag-over/);
    await row.dispatchEvent("drop", { dataTransfer: drop });
    await page.waitForFunction(() => document.querySelector('[data-mrr-id="2"] [data-scan-status]').textContent === "Scan saved.");
    assert.equal(await open.getAttribute("aria-disabled"), null);
    assert.equal(await open.getAttribute("href"), "/material-logs/mrr/2/scanned-pdf/open");
    assert.match(uploadedPaths[0], /\/MRR-123\.pdf$/);
    page.on("dialog", (dialog) => dialog.accept());
    fail = true;
    await row.locator("[data-scan-input]").setInputFiles({ name: "replacement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 replacement") });
    await page.waitForFunction(() => document.querySelector('[data-mrr-id="2"] [data-scan-status]').textContent === "Test storage failure");
    assert.equal(await open.getAttribute("href"), "/material-logs/mrr/2/scanned-pdf/open");
    assert.equal(await row.locator("[data-scan-upload]").isEnabled(), true);
    await row.locator("[data-scan-input]").setInputFiles({ name: "bad.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF") });
    await page.waitForFunction(() => document.querySelector('[data-mrr-id="2"] [data-scan-status]').textContent === "The selected file is not a PDF.");
    assert.equal(uploadedPaths.length, 2);
    await page.screenshot({ path: path.join(os.tmpdir(), "mrr-scan-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await open.scrollIntoViewIfNeeded();
    const box = await open.boundingBox();
    assert.ok(box.width > 60 && box.height > 20);
    await page.screenshot({ path: path.join(os.tmpdir(), "mrr-scan-mobile.png"), fullPage: true });
  } finally {
    await browser.close();
  }
});
