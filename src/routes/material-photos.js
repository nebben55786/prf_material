import { Readable } from "node:stream";
import express from "express";
import {
  isMaterialPhotoPath,
  materialPhotoContentTypes,
  materialPhotoMaxBytes,
  materialPhotoPrefix,
  materialPhotoScopeConfig,
  safeMaterialPhotoFilename,
  verifyMaterialPhotoBlob
} from "../material-photos.js";

function photoPermission(config, mode) {
  return mode === "edit" ? config.editAction : config.viewAction;
}

function photoSizeLabel(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function targetExists(query, config, targetId, jobId) {
  const row = (await query(`select id from ${config.table} where id = $1 and job_id = $2`, [targetId, jobId])).rows[0];
  return Boolean(row);
}

async function validateTaggedItem(client, jobId, materialItemId) {
  const itemId = Number(materialItemId || 0);
  if (!itemId) return null;
  const row = (await client.query("select id from material_items where id = $1 and job_id = $2", [itemId, jobId])).rows[0];
  if (!row) throw new Error("Tagged item was not found for this job.");
  return itemId;
}

async function fetchPhotos(query, { scope, targetId, jobId }) {
  const config = materialPhotoScopeConfig(scope);
  if (!config) return [];
  const rows = (await query(`
    select
      mp.*,
      coalesce(u.first_name || ' ' || u.last_name, u.username, '') as uploaded_by_name,
      coalesce(mi.item_code, '') as tagged_item_code,
      coalesce(mi.description, '') as tagged_item_description
    from material_photos mp
    left join users u on u.id = mp.uploaded_by
    left join material_items mi on mi.id = mp.material_item_id
    where mp.job_id = $1
      and mp.${config.idColumn} = $2
      and mp.process_type = $3
    order by mp.created_at desc, mp.id desc
  `, [jobId, targetId, config.processType])).rows;
  return rows;
}

export function registerMaterialPhotoRoutes(app, dependencies) {
  const {
    asyncHandler,
    auditLog,
    canAccess,
    contentDispositionFilename,
    currentJobId,
    del,
    esc,
    escAttr,
    formatShortDateTime,
    get,
    getRequestAuthContext,
    handleUpload,
    query,
    requireAuth,
    requireJobContext,
    vercelBlobClientModuleUrl,
    withTransaction
  } = dependencies;

  function canUsePhotoScope(user, config, mode) {
    return Boolean(user?.activeJob || user?.job_id) && canAccess(user, config.permission, photoPermission(config, mode));
  }

  function renderMaterialPhotoSection({ scope, targetId, jobId, title, subtitle = "", itemOptions = [], canUpload, photos }) {
    const config = materialPhotoScopeConfig(scope);
    if (!config) return "";
    const sectionId = `material-photo-${scope}-${Number(targetId)}`;
    const itemSelectOptions = itemOptions
      .map((item) => `<option value="${escAttr(item.id)}">${esc(item.label || item.item_code || item.id)}</option>`)
      .join("");
    const uploadForm = canUpload ? `
      <form class="stack" data-photo-upload-form>
        <div class="grid">
          <div>
            <label>Photo</label>
            <input type="file" accept="image/*,.heic,.heif" capture="environment" multiple data-photo-input />
          </div>
          ${scope === "item" ? "" : `<div><label>Tag Item</label><select data-photo-item><option value="">No item tag</option>${itemSelectOptions}</select></div>`}
        </div>
        <div><label>Caption</label><input data-photo-caption maxlength="500" placeholder="Optional note for this photo" /></div>
        <div class="actions"><button type="submit">Save Photo</button><span class="muted" data-photo-status></span></div>
      </form>
    ` : `<p class="muted">You can view saved photos, but you do not have permission to add photos here.</p>`;
    const photoCards = photos.length ? photos.map((photo) => {
      const taggedItem = photo.tagged_item_code
        ? `<div class="muted">Item: ${esc(photo.tagged_item_code)}${photo.tagged_item_description ? ` | ${esc(photo.tagged_item_description)}` : ""}</div>`
        : "";
      const uploadedBy = photo.uploaded_by_name ? ` by ${esc(photo.uploaded_by_name)}` : "";
      return `<div class="material-photo-card">
        <a href="/photos/${photo.id}/open" target="_blank" rel="noopener" class="material-photo-thumb">
          <img src="/photos/${photo.id}/open" alt="${escAttr(photo.caption || photo.filename || "Material photo")}" loading="lazy" />
        </a>
        <div class="material-photo-meta">
          <strong>${esc(photo.caption || photo.filename || "Photo")}</strong>
          ${taggedItem}
          <div class="muted">${esc(formatShortDateTime(photo.created_at))}${uploadedBy}${photo.size_bytes ? ` | ${esc(photoSizeLabel(photo.size_bytes))}` : ""}</div>
          <div class="actions">
            <a class="btn btn-secondary" href="/photos/${photo.id}/open" target="_blank" rel="noopener">Open</a>
            ${canUpload ? `<form method="post" action="/photos/${photo.id}/delete" onsubmit="return confirm('Delete this photo?');"><button class="btn btn-danger" type="submit">Delete</button></form>` : ""}
          </div>
        </div>
      </div>`;
    }).join("") : `<p class="muted">No photos saved yet.</p>`;
    return `
      <div class="card material-photo-section"
        id="${escAttr(sectionId)}"
        data-photo-section
        data-scope="${escAttr(scope)}"
        data-target-id="${escAttr(targetId)}"
        data-upload-prefix="${escAttr(materialPhotoPrefix(jobId, scope, targetId))}"
        data-client-module-url="${escAttr(vercelBlobClientModuleUrl)}">
        <h3>${esc(title || `${config.targetLabel} Photos`)}</h3>
        ${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}
        ${uploadForm}
        <div class="material-photo-grid">${photoCards}</div>
      </div>
      <script type="module" src="/public/material-photos.js"></script>
    `;
  }

  async function renderPhotoSectionForTarget(req, options) {
    const config = materialPhotoScopeConfig(options.scope);
    if (!config) return "";
    const jobId = currentJobId(req);
    const targetId = Number(options.targetId);
    const photos = await fetchPhotos(query, { scope: options.scope, targetId, jobId });
    return renderMaterialPhotoSection({
      ...options,
      targetId,
      jobId,
      photos,
      canUpload: canUsePhotoScope(req.user, config, "edit")
    });
  }

  app.locals.renderPhotoSectionForTarget = renderPhotoSectionForTarget;

  app.post("/photos/:scope/:id/client-upload", express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    try {
      const response = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          const user = await getRequestAuthContext(req);
          const config = materialPhotoScopeConfig(req.params.scope);
          const targetId = Number(req.params.id);
          if (!config || !canUsePhotoScope(user, config, "edit")) {
            throw new Error("Sign in with permission to upload photos before trying again.");
          }
          if (!await targetExists(query, config, targetId, user.job_id)) {
            throw new Error("Photo target was not found for this job.");
          }
          if (!isMaterialPhotoPath(pathname, user.job_id, req.params.scope, targetId)) {
            throw new Error("Invalid photo upload target. Refresh the page and try again.");
          }
          return {
            allowedContentTypes: materialPhotoContentTypes,
            maximumSizeInBytes: materialPhotoMaxBytes,
            addRandomSuffix: false,
            allowOverwrite: false
          };
        }
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error.message || "Unable to upload photo." });
    }
  }));

  app.post("/photos/:scope/:id/complete", requireAuth, requireJobContext, express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    const scope = String(req.params.scope || "").trim();
    const config = materialPhotoScopeConfig(scope);
    if (!config || !canUsePhotoScope(req.user, config, "edit")) throw new Error("You do not have permission to upload photos here.");
    const targetId = Number(req.params.id);
    const jobId = currentJobId(req);
    const pathname = String(req.body.pathname || "").trim();
    if (!isMaterialPhotoPath(pathname, jobId, scope, targetId)) throw new Error("Invalid photo upload target. Refresh the page and try again.");
    const inserted = await withTransaction(async (client) => {
      if (!await targetExists(client.query.bind(client), config, targetId, jobId)) throw new Error("Photo target was not found for this job.");
      const blob = await get(pathname, { access: "private", useCache: false });
      await verifyMaterialPhotoBlob(blob);
      const materialItemId = scope === "item"
        ? targetId
        : await validateTaggedItem(client, jobId, req.body.material_item_id);
      const filename = safeMaterialPhotoFilename(req.body.source_filename || pathname.split("/").pop(), blob.blob?.contentType || req.body.content_type || "");
      const columns = ["job_id", "process_type", config.idColumn, "material_item_id", "caption", "filename", "content_type", "size_bytes", "blob_url", "blob_download_url", "blob_pathname", "uploaded_by"];
      const values = [
        jobId,
        config.processType,
        targetId,
        materialItemId,
        String(req.body.caption || "").trim().slice(0, 500),
        filename,
        String(blob.blob?.contentType || req.body.content_type || "").trim(),
        Number(blob.blob?.size || req.body.size_bytes || 0),
        String(blob.url || "").trim(),
        String(blob.downloadUrl || "").trim(),
        pathname,
        req.user.id
      ];
      const row = (await client.query(`
        insert into material_photos (${columns.join(", ")})
        values (${values.map((_, index) => `$${index + 1}`).join(", ")})
        returning id
      `, values)).rows[0];
      await auditLog(client, req.user.id, "upload", "material_photo", row.id, `${config.processType}:${targetId}:${filename}`);
      return row;
    });
    res.json({ ok: true, id: inserted.id, openUrl: `/photos/${inserted.id}/open` });
  }));

  app.get("/photos/:id/open", requireAuth, requireJobContext, asyncHandler(async (req, res) => {
    const jobId = currentJobId(req);
    const photo = (await query("select * from material_photos where id = $1 and job_id = $2", [Number(req.params.id), jobId])).rows[0];
    if (!photo) return res.status(404).send("Photo not found.");
    const config = Object.values(scopeConfigByProcess()).find((entry) => entry.processType === photo.process_type);
    if (!config || !canUsePhotoScope(req.user, config, "view")) return res.status(403).send("Forbidden");
    const blob = await get(photo.blob_pathname || photo.blob_url, { access: "private" });
    if (!blob?.stream) return res.status(404).send("The photo is not available.");
    const filename = contentDispositionFilename(photo.filename || "photo");
    res.setHeader("Content-Type", photo.content_type || blob.blob?.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(photo.filename || filename)}`);
    if (photo.size_bytes) res.setHeader("Content-Length", String(photo.size_bytes));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    Readable.fromWeb(blob.stream).on("error", (error) => res.destroy(error)).pipe(res);
  }));

  app.post("/photos/:id/delete", requireAuth, requireJobContext, asyncHandler(async (req, res) => {
    const jobId = currentJobId(req);
    let redirectPath = "/";
    let blobPathname = "";
    await withTransaction(async (client) => {
      const photo = (await client.query("select * from material_photos where id = $1 and job_id = $2 for update", [Number(req.params.id), jobId])).rows[0];
      if (!photo) throw new Error("Photo not found.");
      const config = Object.values(scopeConfigByProcess()).find((entry) => entry.processType === photo.process_type);
      if (!config || !canUsePhotoScope(req.user, config, "edit")) throw new Error("You do not have permission to delete this photo.");
      redirectPath = photo.mrr_log_id
        ? `/material-logs/mrr/${photo.mrr_log_id}/edit`
        : (photo.requisition_id ? `/requisitions/${photo.requisition_id}` : `/items/${photo.material_item_id}/edit`);
      blobPathname = photo.blob_pathname || photo.blob_url || "";
      await client.query("delete from material_photos where id = $1 and job_id = $2", [photo.id, jobId]);
      await auditLog(client, req.user.id, "delete", "material_photo", photo.id, photo.filename || "");
    });
    if (blobPathname) {
      try { await del(blobPathname); } catch (error) { console.error("Unable to delete material photo blob", error); }
    }
    res.redirect(redirectPath);
  }));
}

function scopeConfigByProcess() {
  return {
    receiving: materialPhotoScopeConfig("mrr"),
    issuing: materialPhotoScopeConfig("requisition"),
    item: materialPhotoScopeConfig("item")
  };
}
