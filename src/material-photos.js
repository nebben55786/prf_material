import path from "node:path";

export const materialPhotoMaxBytes = 25 * 1024 * 1024;
export const materialPhotoContentTypes = ["image/jpeg"];

const scopeConfig = {
  mrr: {
    processType: "receiving",
    idColumn: "mrr_log_id",
    table: "mrr_logs",
    permission: "material_logs",
    editAction: "edit",
    viewAction: "view",
    targetLabel: "MRR"
  },
  requisition: {
    processType: "issuing",
    idColumn: "requisition_id",
    table: "material_requisitions",
    permission: "requisitions",
    editAction: "issue",
    viewAction: "view",
    targetLabel: "REQ"
  },
  item: {
    processType: "item",
    idColumn: "material_item_id",
    table: "material_items",
    permission: "inventory",
    editAction: "edit",
    viewAction: "view",
    targetLabel: "Item"
  }
};

export function materialPhotoScopeConfig(scope) {
  return scopeConfig[String(scope || "").trim()] || null;
}

export function materialPhotoPrefix(jobId, scope, targetId) {
  return `material-photos/job-${Number(jobId)}/${String(scope)}/${Number(targetId)}/`;
}

export function safeMaterialPhotoFilename(filename, contentType = "") {
  const parsedExt = path.extname(String(filename || "")).toLowerCase();
  const stem = String(path.basename(String(filename || "photo"), parsedExt) || "photo")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 90);
  return `${stem || "photo"}.jpg`;
}

export function isMaterialPhotoPath(pathname, jobId, scope, targetId) {
  const prefix = materialPhotoPrefix(jobId, scope, targetId);
  if (typeof pathname !== "string" || !pathname.startsWith(prefix)) return false;
  const [uploadId, filename, ...extra] = pathname.slice(prefix.length).split("/");
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uploadId)
    && Boolean(filename)
    && extra.length === 0;
}

export async function verifyMaterialPhotoBlob(blob) {
  if (!blob?.stream) throw new Error("Uploaded photo is not available. Please retry the upload.");
  const contentType = String(blob.blob?.contentType || "").toLowerCase();
  const size = Number(blob.blob?.size || 0);
  if (!materialPhotoContentTypes.includes(contentType) || !size || size > materialPhotoMaxBytes) {
    throw new Error("Upload a JPG photo no larger than 25 MB.");
  }
}
