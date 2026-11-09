import { randomUUID } from "node:crypto";
import multer from "multer";
import { extractPoPdf } from "../po-pdf.js";

const path = "/rfq/new/po-pdf";
const normalize = value => String(value ?? "").trim().toLowerCase();
const vendorKey = value => normalize(value).replace(/[^\p{L}\p{N}]/gu, "");
const input = (body, key) => typeof body[key] === "string" ? body[key].trim() : "";
const reviewError = message => Object.assign(new Error(message), { reviewError: true });

async function findIdents(client, jobId, codes, lock = false) {
  const result = await client.query(`
    select id, item_code, description, uom from material_items
    where job_id = $1 and lower(item_code) = any($2::text[])
    ${lock ? "for share" : ""}
  `, [jobId, [...new Set(codes.map(normalize).filter(Boolean))]]);
  const matches = new Map();
  for (const item of result.rows) {
    const key = normalize(item.item_code);
    matches.set(key, matches.has(key) ? null : item);
  }
  return matches;
}

export function registerRfqPoPdfRoutes(app, d) {
  const access = [d.requireAuth, d.requireJobContext, d.requirePermission("rfqs", "edit")];
  const upload = multer({ limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 0 } }).single("po_pdf");
  const runner = { query: d.query };
  const vendors = async () => (await d.query("select id, name from vendors where is_active = true order by name")).rows;
  const { esc, layout } = d;

  function uploadPage(req, res, error = "") {
    return res.send(layout("Create RFQ from PO PDF", `
      <h1>Create RFQ from PO PDF</h1>
      <div class="card">
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
        <p>Upload a text-based purchase order PDF to review the vendor, item idents, quantities, and unit prices.</p>
        <form action="${path}/review" method="post" enctype="multipart/form-data" class="stack">
          <div><label for="po-pdf">Purchase Order PDF</label><input id="po-pdf" name="po_pdf" type="file" accept=".pdf,application/pdf" required /></div>
          <div class="actions"><button type="submit">Review PDF</button><a class="btn btn-secondary" href="/rfq/new">Back to New RFQ</a></div>
        </form>
      </div>
    `, req.user));
  }

  async function reviewPage(req, res, draft, token, body, error = "") {
    const jobId = d.currentJobId(req);
    const codes = draft.lines.map((line, i) => body ? input(body, `ident_${i}`) : line.itemNumber);
    const [activeVendors, matches] = await Promise.all([vendors(), findIdents(runner, jobId, codes)]);
    const vendorMatches = activeVendors.filter(vendor => vendorKey(vendor.name) === vendorKey(draft.vendorName));
    const selectedVendor = body ? input(body, "vendor_id") : vendorMatches.length === 1 ? String(vendorMatches[0].id) : "";
    const canAddItem = d.canAccess(req.user, "items", "edit");
    const rows = draft.lines.map((line, i) => {
      const match = matches.get(normalize(codes[i]));
      const ident = body ? codes[i] : match?.item_code || "";
      const mismatch = match && normalize(match.uom) !== normalize(line.unit);
      return `<tr>
        <td>${esc(line.lineNumber)}</td><td>${esc(line.itemNumber)}</td><td>${esc(line.description)}</td>
        <td>${esc(line.quantity)}</td><td>${esc(line.unit)}</td><td>$${esc(line.unitPrice)}</td>
        <td data-po-match>
          <div class="actions"><input name="ident_${i}" aria-label="Ident for PO line ${esc(line.lineNumber)}" value="${esc(ident)}" autocomplete="off" data-po-ident data-po-unit="${esc(line.unit)}" placeholder="Enter an ident or use Find Ident" style="min-width:190px" />
          <button type="button" class="btn btn-secondary" data-po-find data-po-number="${esc(line.itemNumber)}" data-po-description="${esc(line.description)}" data-po-line="${esc(line.lineNumber)}">Find Ident</button></div>
          <div data-po-ident-status aria-live="polite" class="muted">${match ? esc(match.description) : "Choose an existing ident or skip this line."}${mismatch ? ` <strong style="color:#b42318">Item Master unit: ${esc(match.uom || "(blank)")}</strong>` : ""}</div>
          ${canAddItem ? `<details ${body && input(body, `new_${i}`) === "1" ? "open" : ""}>
            <summary>Add New Item</summary>
            <label><input type="checkbox" name="new_${i}" value="1" ${body && input(body, `new_${i}`) === "1" ? "checked" : ""} /> Create this item when saving</label>
            <div class="grid">
              <label>New Ident<input name="new_ident_${i}" maxlength="120" value="${esc(body ? input(body, `new_ident_${i}`) : line.itemNumber)}" /></label>
              <label>Description<input name="new_description_${i}" maxlength="500" value="${esc(body ? input(body, `new_description_${i}`) : line.description)}" /></label>
              <label>Unit<input name="new_unit_${i}" maxlength="40" value="${esc(body ? input(body, `new_unit_${i}`) : line.unit)}" /></label>
              <label>Material Type<input name="new_type_${i}" maxlength="80" value="${esc(body ? input(body, `new_type_${i}`) : "misc")}" /></label>
            </div>
          </details>` : ""}
        </td>
        <td><label><input type="checkbox" name="skip_${i}" value="1" ${body && input(body, `skip_${i}`) === "1" ? "checked" : ""} /> Skip</label></td>
      </tr>`;
    }).join("");
    return res.send(layout("Review PO PDF for RFQ", `
      <h1>Review PO PDF for RFQ</h1>
      <div class="card">
        <p>PDF vendor: <strong>${esc(draft.vendorName)}</strong></p>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
        <form action="${path}/create" method="post" class="stack">
          <input type="hidden" name="review_token" value="${esc(token)}" />
          <div class="grid">
            <div><label for="pdf-po-number">PO Number</label><input id="pdf-po-number" name="po_number" value="${esc(body ? input(body, "po_number") : draft.poNumber)}" maxlength="120" required /></div>
            <div><label for="pdf-requestor">Requestor</label><input id="pdf-requestor" name="requestor_name" value="${esc(body ? input(body, "requestor_name") : draft.requestor)}" maxlength="250" required /></div>
            <div><label for="pdf-description">Description</label><input id="pdf-description" name="project_name" value="${esc(body ? input(body, "project_name") : `PO ${draft.poNumber}`)}" maxlength="250" required /></div>
            <div><label for="pdf-due-date">Due Date</label><input id="pdf-due-date" type="date" name="due_date" value="${esc(body && input(body, "due_date"))}" required /></div>
            <div><label for="pdf-vendor">Vendor</label><select id="pdf-vendor" name="vendor_id" required>
              <option value="">Choose an existing vendor</option>
              ${activeVendors.map(vendor => `<option value="${vendor.id}" ${String(vendor.id) === selectedVendor ? "selected" : ""}>${esc(vendor.name)}</option>`).join("")}
            </select></div>
          </div>
          <p>Choose a current-job ident for each line you want to include. The RFQ will use Item Master's unit and the PDF's quantity and unit price.</p>
          <div class="scroll"><table><thead><tr><th>PO Line</th><th>PDF Item Number</th><th>PDF Description</th><th>Quantity</th><th>PDF Unit</th><th>Unit Price</th><th>Item Master Ident</th><th>Skip</th></tr></thead><tbody>${rows}</tbody></table></div>
          <label><input type="checkbox" name="confirm_units" value="1" ${body && input(body, "confirm_units") === "1" ? "checked" : ""} /> I reviewed any differences between PDF units and Item Master units.</label>
          <div class="actions"><button type="submit">Create Awarded RFQ</button><a class="btn btn-secondary" href="${path}">Cancel</a></div>
        </form>
      </div>
      <dialog id="po-ident-search" style="width:min(760px,94vw);max-height:90vh">
        <div class="stack">
          <h2>Find Item Master Ident</h2>
          <p data-po-source></p>
          <label for="po-ident-query">Search by ident or description keywords</label>
          <input id="po-ident-query" type="search" maxlength="120" placeholder="Example: gasket ring 150" />
          <div class="actions">
            <button type="button" class="btn btn-secondary" data-po-use-number>Search PDF Item Number</button>
            <button type="button" class="btn btn-secondary" data-po-use-description>Search PDF Description</button>
          </div>
          <p data-po-results-status role="status"></p>
          <div class="scroll" style="max-height:45vh"><table><thead><tr><th>Ident</th><th>Description</th><th>Unit</th><th>Action</th></tr></thead><tbody data-po-results></tbody></table></div>
          <div class="actions"><button type="button" class="btn btn-secondary" data-po-previous>Previous</button><button type="button" class="btn btn-secondary" data-po-next>Next</button><button type="button" class="btn btn-secondary" data-po-close>Close</button></div>
        </div>
      </dialog>
      <script src="/public/rfq-po-pdf.js" defer></script>
    `, req.user));
  }

  app.get(path, ...access, (req, res) => uploadPage(req, res));
  app.get(`${path}/idents`, ...access, d.asyncHandler(async (req, res) => {
    const term = String(req.query.q || "").trim().slice(0, 120);
    const page = Math.max(0, Math.min(10000, Number.parseInt(req.query.page, 10) || 0));
    res.set("Cache-Control", "no-store");
    if (!term) return res.json({ items: [], more: false });
    const terms = term.toLowerCase().split(/\s+/).slice(0, 16);
    const result = await d.query(`
      select item_code, description, uom from material_items
      where job_id = $1 and not exists (
        select 1 from unnest($3::text[]) as keywords(word)
        where strpos(lower(item_code || ' ' || coalesce(description, '')), word) = 0
      )
      order by (lower(item_code) = lower($2)) desc, (strpos(lower(item_code), lower($2)) = 1) desc,
        (strpos(lower(coalesce(description, '')), lower($2)) > 0) desc, item_code, id
      limit 26 offset $4
    `, [d.currentJobId(req), term, terms, page * 25]);
    res.json({ items: result.rows.slice(0, 25), more: result.rows.length > 25 });
  }));
  app.post(`${path}/review`, ...access, d.asyncHandler(async (req, res) => {
    try {
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      if (!req.file) throw new Error("Select a purchase order PDF.");
    } catch (error) {
      return uploadPage(req, res.status(400), error.code === "LIMIT_FILE_SIZE" ? "Choose a PDF under 4 MB." : "Select one purchase order PDF.");
    }
    let draft;
    try {
      draft = await extractPoPdf(req.file.buffer);
    } catch (error) {
      const knownFormatError = /^(This PDF|Could not read purchase order line|Purchase order PDFs)/.test(error.message);
      if (!knownFormatError) console.warn("[rfq-po-pdf] extraction failed", error.name, error.code ?? "", error.stack?.split("\n").slice(1, 3).join("\n") ?? "");
      const detail = knownFormatError ? error.message : "Could not read this PDF. Upload a text-based purchase order in the supported layout.";
      return uploadPage(req, res.status(400), detail);
    }
    const token = d.signSession({
      scope: "rfq_po_pdf", job: String(d.currentJobId(req)), actor: String(req.user.id),
      deadline: Date.now() + 60 * 60 * 1000, nonce: randomUUID(), draft
    });
    return reviewPage(req, res, draft, token);
  }));

  app.post(`${path}/create`, ...access, d.asyncHandler(async (req, res) => {
    const jobId = d.currentJobId(req);
    const body = req.body;
    const token = input(body, "review_token");
    const review = d.readSession(token);
    if (review?.scope !== "rfq_po_pdf" || review.job !== String(jobId) || review.actor !== String(req.user.id) || review.deadline <= Date.now()) {
      return uploadPage(req, res.status(400), "This review has expired or belongs to another job. Upload the PDF again.");
    }
    const { draft } = review;
    const vendorId = input(body, "vendor_id");
    const poNumber = input(body, "po_number");
    const requestor = input(body, "requestor_name");
    const description = input(body, "project_name");
    const dueDate = input(body, "due_date");
    const included = draft.lines.flatMap((line, index) => {
      if (input(body, `skip_${index}`) === "1") return [];
      const newItem = input(body, `new_${index}`) === "1" ? {
        item_code: input(body, `new_ident_${index}`),
        description: input(body, `new_description_${index}`),
        uom: input(body, `new_unit_${index}`),
        material_type: input(body, `new_type_${index}`) || "misc"
      } : null;
      return [{ ...line, ident: newItem?.item_code ?? input(body, `ident_${index}`), newItem }];
    });
    try {
      if (!poNumber || poNumber.length > 120 || !requestor || requestor.length > 250 || !description || description.length > 250) throw reviewError("Enter a PO number, requestor, and description.");
      const date = new Date(dueDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) throw reviewError("Enter a valid due date.");
      if (!/^[1-9]\d{0,17}$/.test(vendorId)) throw reviewError("Choose an existing vendor.");
      if (!included.length) throw reviewError("Include at least one line.");
      if (included.some(line => line.newItem) && !d.canAccess(req.user, "items", "edit")) {
        throw reviewError("Item Master edit permission is required to add new items.");
      }
      const id = await d.withTransaction(async client => {
        // Serialize PDF imports per job so a double submit cannot create two RFQs.
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`rfq-po-pdf:${jobId}`]);
        const auditKey = `po-pdf-review=${review.nonce}`;
        const previous = (await client.query(`
          select r.id from audit_log a join rfqs r on r.id::text = a.entity_id
          where a.action = 'import' and a.entity_type = 'rfq' and a.user_id = $1 and a.details = $2 and r.job_id = $3
        `, [req.user.id, auditKey, jobId])).rows[0];
        if (previous) return previous.id;
        const vendor = (await client.query("select id from vendors where id = $1 and is_active = true for share", [vendorId])).rows[0];
        if (!vendor) throw reviewError("Choose an active vendor.");
        const matches = await findIdents(client, jobId, included.map(line => line.ident), true);
        const additions = new Map();
        for (const { newItem, ident, lineNumber } of included) {
          if (!newItem) continue;
          if (!ident || ident.length > 120 || !newItem.description || newItem.description.length > 500 || !newItem.uom || newItem.uom.length > 40 || newItem.material_type.length > 80) {
            throw reviewError(`PO line ${lineNumber}: enter a valid new ident, description, and unit.`);
          }
          const key = normalize(ident);
          if (matches.has(key)) throw reviewError(`PO line ${lineNumber}: ident ${ident} already exists. Choose it as an existing item.`);
          if (additions.has(key)) throw reviewError(`PO line ${lineNumber}: ident ${ident} is already marked new on another line. Enter that ident as an existing match on this line.`);
          additions.set(key, newItem);
        }
        for (const line of included) {
          const key = normalize(line.ident);
          const match = matches.get(key) || additions.get(key);
          if (!match) throw reviewError(`PO line ${line.lineNumber}: choose a unique Item Master ident from this job or skip the line.`);
          if (normalize(match.uom) !== normalize(line.unit) && input(body, "confirm_units") !== "1") {
            throw reviewError(`PO line ${line.lineNumber}: PDF unit ${line.unit} differs from Item Master unit ${match.uom || "(blank)"}. Review and confirm the unit differences before saving.`);
          }
        }
        const rfqNo = await d.getNextRfqNumber(client, jobId);
        const rfq = (await client.query(`
          insert into rfqs (job_id, rfq_no, project_name, po_number, requestor_name, due_date, status)
          values ($1, $2, $3, $4, $5, $6, 'WAITING_ON_QUOTES') returning id
        `, [jobId, rfqNo, description, poNumber, requestor, dueDate])).rows[0];
        await d.syncRfqVendors(client, rfq.id, [vendor.id]);
        for (const [key, item] of additions) {
          let result;
          try {
            result = await d.upsertMaterialMasterItem(client, item, jobId, { createOnly: true });
          } catch (error) {
            if (error.code === "23505") throw reviewError(`Ident ${item.item_code} already exists. Choose it as an existing item.`);
            throw error;
          }
          if (result.status !== "inserted") throw reviewError(`Ident ${item.item_code}: ${result.message}`);
          matches.set(key, result.item);
          await d.auditLog(client, req.user.id, "inserted", "material_item", result.id, item.item_code);
        }
        for (const line of included) {
          const item = matches.get(normalize(line.ident));
          const result = await d.upsertRfqItemRow(client, rfq.id, { item_code: item.item_code, qty: line.quantity, po_line: line.lineNumber }, jobId);
          if (result.status !== "inserted") throw reviewError(`PO line ${line.lineNumber}: ${result.message || "Could not add this RFQ line."}`);
          await client.query("insert into quotes (job_id, rfq_item_id, vendor_id, unit_price, quoted_at) values ($1, $2, $3, $4, now())", [jobId, result.itemId, vendor.id, line.unitPrice]);
          await d.writeQuoteRevision(client, { rfqItemId: result.itemId, vendorId: vendor.id, unitPrice: line.unitPrice, leadDays: null, sourceType: "po_pdf", createdBy: req.user.id, jobId });
          await client.query(`
            update rfq_items set award_status = 'AWARDED', awarded_vendor_id = $2, awarded_unit_price = $3,
              awarded_at = now(), awarded_by = $4, updated_at = now()
            where id = $1 and job_id = $5
          `, [result.itemId, vendor.id, line.unitPrice, req.user.id, jobId]);
        }
        await d.recalcRfqStatus(client, rfq.id);
        await d.auditLog(client, req.user.id, "import", "rfq", rfq.id, auditKey);
        return rfq.id;
      });
      return res.redirect(`/rfq/${id}`);
    } catch (error) {
      if (!error.reviewError) throw error;
      return reviewPage(req, res.status(422), draft, token, body, error.message);
    }
  }));
}
