import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import bcrypt from "bcryptjs";
import XLSX from "xlsx";
import { initDb, query, withTransaction, auditLog, vendorCategories, setVendorCategories, permissionMatrix, setPermissionMatrix, pool } from "./db.js";

const app = express();
const upload = multer();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const bomTypes = ["pipe", "pipe fab", "support fab", "steel", "civil", "tubing", "grout", "misc", "equipment"];
const bomStatuses = ["DRAFT", "ACTIVE", "ISSUED_FOR_RFQ", "PARTIALLY_PROCURED", "FULLY_PROCURED", "CLOSED"];
const bomLineStatuses = ["PLANNED", "ON_RFQ", "AWARDED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "ISSUED_TO_FIELD", "CLOSED"];
const requisitionStatuses = ["REQUESTED", "VERIFIED", "ISSUED", "CANCELLED", "CLOSED"];
const rfqStatuses = [
  { value: "SEND_FOR_QUOTES", label: "Send for Quotes" },
  { value: "WAITING_ON_QUOTES", label: "Waiting on Quotes" },
  { value: "AWARDED", label: "Awarded" },
  { value: "WAITING_ON_CLIENT", label: "Waiting on Client" },
  { value: "PURCHASED", label: "Purchased" },
  { value: "RECEIVED", label: "Received" }
];
const permissionSections = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  { key: "material_logs", label: "Material Logs", href: "/material-logs" },
  { key: "vendors", label: "Vendors", href: "/vendors" },
  { key: "rfqs", label: "RFQs", href: "/rfq" },
  { key: "pos", label: "POs", href: "/po" },
  { key: "bom", label: "BOM", href: "/bom" },
  { key: "receiving", label: "Receiving", href: "/receive" },
  { key: "yard", label: "Yard", href: "/yard" },
  { key: "requisitions", label: "REQs", href: "/requisitions" },
  { key: "settings", label: "Settings", href: "/settings" }
];
const permissionRoles = ["admin", "buyer", "warehouse", "field", "supervisor"];

const defaultPermissionMatrix = {
  admin: {
    dashboard: { view: true },
    material_logs: { view: true, edit: true },
    vendors: { view: true, edit: true },
    rfqs: { view: true, edit: true },
    pos: { view: true, edit: true },
    bom: { view: true, edit: true },
    receiving: { view: true, edit: true },
    yard: { view: true },
    inventory: { view: true, edit: true },
    requisitions: { view: true, create: true, edit: true, verify: true, issue: true, unverify: true, delete: true },
    settings: { view: true, edit: true }
  },
  buyer: {
    dashboard: { view: true },
    material_logs: { view: true, edit: true },
    vendors: { view: true, edit: true },
    rfqs: { view: true, edit: true },
    pos: { view: true, edit: true },
    bom: { view: true, edit: true },
    receiving: { view: true, edit: false },
    yard: { view: true },
    inventory: { view: true, edit: true },
    requisitions: { view: true, create: false, edit: false, verify: false, issue: false, unverify: false, delete: false },
    settings: { view: true, edit: true }
  },
  warehouse: {
    dashboard: { view: true },
    material_logs: { view: true, edit: true },
    vendors: { view: false, edit: false },
    rfqs: { view: false, edit: false },
    pos: { view: true, edit: false },
    bom: { view: false, edit: false },
    receiving: { view: true, edit: true },
    yard: { view: true },
    inventory: { view: true, edit: false },
    requisitions: { view: true, create: true, edit: true, verify: true, issue: true, unverify: true, delete: false },
    settings: { view: false, edit: false }
  },
  field: {
    dashboard: { view: true },
    material_logs: { view: false, edit: false },
    vendors: { view: false, edit: false },
    rfqs: { view: false, edit: false },
    pos: { view: false, edit: false },
    bom: { view: false, edit: false },
    receiving: { view: false, edit: false },
    yard: { view: true },
    inventory: { view: true, edit: false },
    requisitions: { view: true, create: true, edit: true, verify: false, issue: false, unverify: false, delete: false },
    settings: { view: false, edit: false }
  },
  supervisor: {
    dashboard: { view: true },
    material_logs: { view: true, edit: false },
    vendors: { view: true, edit: false },
    rfqs: { view: true, edit: false },
    pos: { view: true, edit: false },
    bom: { view: true, edit: false },
    receiving: { view: true, edit: false },
    yard: { view: true },
    inventory: { view: true, edit: false },
    requisitions: { view: true, create: true, edit: true, verify: false, issue: false, unverify: false, delete: false },
    settings: { view: false, edit: false }
  }
};

function safeCookieDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getPermissionsForRole(role) {
  return {
    ...(defaultPermissionMatrix[role] || {}),
    ...(permissionMatrix[role] || {})
  };
}

function canAccess(user, section, action = "view") {
  if (!user) return false;
  const rolePermissions = getPermissionsForRole(user.role);
  const sectionPermissions = {
    ...(defaultPermissionMatrix[user.role]?.[section] || {}),
    ...(rolePermissions[section] || {})
  };
  return Boolean(sectionPermissions[action]);
}

function canEditInventoryAudit(user) {
  if (!user) return false;
  return user.role === "admin" || user.role === "warehouse" || canAccess(user, "inventory", "edit");
}

app.use(express.urlencoded({ extended: true, limit: "20mb", parameterLimit: 20000 }));
app.use(cookieParser(undefined, { decode: safeCookieDecode }));
app.use("/public", express.static(path.join(process.cwd(), "public")));

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escAttr(value) {
  return esc(value).replaceAll("`", "&#96;");
}

function pdfEscape(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function padPdfColumn(value, width, align = "left") {
  const text = String(value ?? "");
  if (text.length >= width) return text.slice(0, width);
  const padding = " ".repeat(width - text.length);
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}

function wrapPdfText(value, width) {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function roundQtyUpToHalf(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return Math.ceil(qty * 2) / 2;
}

function parseQtyValue(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? roundQtyUpToHalf(parsed) : fallback;
}

function formatQtyDisplay(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const rounded = roundQtyUpToHalf(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatShortDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const day = String(parsed.getDate()).padStart(2, "0");
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const year = String(parsed.getFullYear());
    return `${day}-${month}-${year}`;
  }
  return text;
}

function formatShortDateTime(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (match) {
    const dateText = `${match[3]}-${match[2]}-${match[1]}`;
    return match[4] && match[5] ? `${dateText} ${match[4]}:${match[5]}` : dateText;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const day = String(parsed.getDate()).padStart(2, "0");
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const year = String(parsed.getFullYear());
    const hours = String(parsed.getHours()).padStart(2, "0");
    const minutes = String(parsed.getMinutes()).padStart(2, "0");
    const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0 || /[T\s]\d{1,2}:\d{2}/.test(text);
    return hasTime ? `${day}-${month}-${year} ${hours}:${minutes}` : `${day}-${month}-${year}`;
  }
  return text;
}

function parseSelectedIdList(value) {
  if (Array.isArray(value)) return value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0);
  if (value === null || value === undefined || value === "") return [];
  return [Number(value)].filter((entry) => Number.isFinite(entry) && entry > 0);
}

function renderVendorSelectionOptions(vendors, selectedVendorIds = []) {
  const selected = new Set(selectedVendorIds.map((vendorId) => Number(vendorId)));
  return vendors.map((vendor) => `
    <label class="check-option">
      <input type="checkbox" name="vendor_ids" value="${vendor.id}" ${selected.has(Number(vendor.id)) ? "checked" : ""} />
      <span>${esc(vendor.name)}</span>
    </label>
  `).join("");
}

const defaultJobNumberValue = String(process.env.DEFAULT_JOB_NUMBER || "0000").trim() || "0000";
const resetTargetGroups = {
  full_reset: {
    label: "Full Reset",
    confirmText: "DELETE FULL RESET",
    description: "Deletes operational data, removes other users, and resets the job number back to the default value."
  },
  data_only: {
    label: "Operational Data Only",
    confirmText: "DELETE OPERATIONAL DATA",
    description: "Deletes the app's working data but keeps users and setup settings."
  },
  vendors: {
    label: "Vendors",
    confirmText: "DELETE VENDORS",
    description: "Deletes vendors and vendor contacts."
  },
  boms_reqs: {
    label: "BOMs And REQs",
    confirmText: "DELETE BOMS AND REQS",
    description: "Deletes BOMs and material requisitions."
  },
  rfq_procurement: {
    label: "RFQs / POs / Quotes",
    confirmText: "DELETE RFQS POS QUOTES",
    description: "Deletes RFQs, vendor selections, quotes, purchase orders, PO lines, and receipts."
  },
  material_logs: {
    label: "Material Logs",
    confirmText: "DELETE MATERIAL LOGS",
    description: "Deletes receiving logs, MRR/FMR/OPI/OS&D logs, request-builder lines, and material log lookups."
  },
  inventory: {
    label: "Inventory / Warehouses",
    confirmText: "DELETE INVENTORY",
    description: "Deletes inventory audit history, inventory adjustments, warehouses, and locations."
  },
  imports: {
    label: "Import History",
    confirmText: "DELETE IMPORT HISTORY",
    description: "Deletes stored import batches and import errors."
  },
  access_requests: {
    label: "Access Requests",
    confirmText: "DELETE ACCESS REQUESTS",
    description: "Deletes all pending and historical access requests."
  },
  audit_log: {
    label: "Audit Log",
    confirmText: "DELETE AUDIT LOG",
    description: "Deletes the audit history log."
  },
  job_number: {
    label: "Reset Job Number",
    confirmText: "RESET JOB NUMBER",
    description: `Resets the job number back to ${defaultJobNumberValue}.`
  }
};

const resetTargetSections = [
  {
    heading: "Full Reset Options",
    targets: ["full_reset", "data_only", "job_number"]
  },
  {
    heading: "Delete Individual Data Sets",
    targets: ["vendors", "boms_reqs", "rfq_procurement", "material_logs", "inventory", "imports", "access_requests", "audit_log"]
  }
];

function getResetTargetConfig(target) {
  return resetTargetGroups[target] || null;
}

async function runResetTarget(client, target, user) {
  if (!user?.id) throw new Error("A signed-in admin user is required.");
  switch (target) {
    case "full_reset":
      await client.query(`truncate table inventory_adjustment_lines, inventory_audit_report_lines, inventory_audit_reports, inventory_audit_counts, vendor_fmr_request_lines, opi_logs, osd_logs, fmr_logs, mrr_logs, material_receiving_logs, receipts, po_lines, purchase_orders, quote_revisions, quotes, rfq_vendors, rfq_items, rfqs, material_requisition_lines, material_requisitions, bom_lines, bom_headers, material_items, vendor_contacts, vendors, warehouse_locations, warehouses, import_batch_errors, import_batches, material_log_lookup_values, access_requests, audit_log restart identity cascade`);
      await client.query("delete from users where id <> $1", [user.id]);
      await client.query("update users set is_active = true where id = $1", [user.id]);
      await client.query(`
        insert into app_settings (key, value, updated_at)
        values ('job_number', $1, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
      `, [defaultJobNumberValue]);
      await auditLog(client, user.id, "reset", "app_data", target, "Full reset completed.");
      return;
    case "data_only":
      await client.query(`truncate table inventory_adjustment_lines, inventory_audit_report_lines, inventory_audit_reports, inventory_audit_counts, vendor_fmr_request_lines, opi_logs, osd_logs, fmr_logs, mrr_logs, material_receiving_logs, receipts, po_lines, purchase_orders, quote_revisions, quotes, rfq_vendors, rfq_items, rfqs, material_requisition_lines, material_requisitions, bom_lines, bom_headers, material_items, vendor_contacts, vendors, warehouse_locations, warehouses, import_batch_errors, import_batches, material_log_lookup_values, access_requests, audit_log restart identity cascade`);
      await auditLog(client, user.id, "reset", "app_data", target, "Operational data reset completed.");
      return;
    case "vendors":
      await client.query("truncate table vendor_contacts, vendors restart identity cascade");
      break;
    case "boms_reqs":
      await client.query("truncate table material_requisition_lines, material_requisitions, bom_lines, bom_headers restart identity cascade");
      break;
    case "rfq_procurement":
      await client.query("truncate table receipts, po_lines, purchase_orders, quote_revisions, quotes, rfq_vendors, rfq_items, rfqs restart identity cascade");
      break;
    case "material_logs":
      await client.query("truncate table vendor_fmr_request_lines, opi_logs, osd_logs, fmr_logs, mrr_logs, material_receiving_logs, material_log_lookup_values restart identity cascade");
      break;
    case "inventory":
      await client.query("truncate table inventory_adjustment_lines, inventory_audit_report_lines, inventory_audit_reports, inventory_audit_counts, warehouse_locations, warehouses restart identity cascade");
      break;
    case "imports":
      await client.query("truncate table import_batch_errors, import_batches restart identity cascade");
      break;
    case "access_requests":
      await client.query("truncate table access_requests restart identity cascade");
      break;
    case "audit_log":
      await client.query("truncate table audit_log restart identity cascade");
      break;
    case "job_number":
      await client.query(`
        insert into app_settings (key, value, updated_at)
        values ('job_number', $1, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
      `, [defaultJobNumberValue]);
      break;
    default:
      throw new Error("Unknown reset target.");
  }
  await auditLog(client, user.id, "reset", "app_data", target, `Reset target ${target} completed.`);
}

function buildSimplePdf(title, detailLines, tableLines) {
  const pageWidth = 612;
  const pageHeight = 792;
  const marginLeft = 36;
  const marginTop = 42;
  const lineHeight = 13;
  const pageLineLimit = 50;
  const allLines = [
    title,
    "",
    ...detailLines,
    "",
    ...tableLines
  ];
  const pages = [];
  for (let i = 0; i < allLines.length; i += pageLineLimit) {
    pages.push(allLines.slice(i, i + pageLineLimit));
  }
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontObjectId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageObjectIds = [];
  const contentObjectIds = [];
  for (const pageLines of pages) {
    let y = pageHeight - marginTop;
    const contentParts = ["BT", `/F1 10 Tf`, "0 g"];
    for (let i = 0; i < pageLines.length; i += 1) {
      const line = pageLines[i];
      if (i === 0) {
        contentParts.push(`/F1 14 Tf`);
      } else if (i === 1) {
        contentParts.push(`/F1 10 Tf`);
      }
      contentParts.push(`1 0 0 1 ${marginLeft} ${y} Tm (${pdfEscape(line)}) Tj`);
      y -= lineHeight;
    }
    contentParts.push("ET");
    const contentStream = contentParts.join("\n");
    const contentObjectId = addObject(`<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream`);
    contentObjectIds.push(contentObjectId);
    pageObjectIds.push(addObject(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`));
  }
  const pagesObjectId = addObject(`<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  objects[pagesObjectId - 1] = objects[pagesObjectId - 1];
  for (const pageObjectId of pageObjectIds) {
    objects[pageObjectId - 1] = objects[pageObjectId - 1].replace("PAGES_REF", `${pagesObjectId} 0 R`);
  }
  const catalogObjectId = addObject(`<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function formatPickTicketTimestamp(value = new Date()) {
  return formatShortDateTime(value);
}

function buildRfqSheetPdf(rfq, items) {
  const pageWidth = 792;
  const pageHeight = 612;
  const left = 28;
  const right = pageWidth - 28;
  const top = pageHeight - 24;
  const usableWidth = right - left;
  const cols = [
    { key: "line", label: "LINE", width: 78 },
    { key: "item", label: "ITEM", width: 150 },
    { key: "description", label: "DESCRIPTION", width: 398 },
    { key: "qty", label: "QTY", width: 60 },
    { key: "uom", label: "UOM", width: 50 }
  ];
  const makeText = (x, y, text, font = "F1", size = 9) => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`;
  const rect = (x, y, w, h) => `${x} ${y} ${w} ${h} re S`;
  const line = (x1, y1, x2, y2) => `${x1} ${y1} m ${x2} ${y2} l S`;

  const rows = items.map((item) => {
    const lineLines = wrapPdfText(item.po_line || "", 12);
    const itemLines = wrapPdfText(item.item_code || "", 22);
    const descriptionLines = wrapPdfText(item.description || "", 58);
    const extraDescription = [];
    if (item.spec) extraDescription.push(...wrapPdfText(`Spec: ${item.spec}`, 58));
    if (item.notes) extraDescription.push(...wrapPdfText(`Notes: ${item.notes}`, 58));
    const combinedDescription = descriptionLines.concat(extraDescription);
    const lineCount = Math.max(lineLines.length, itemLines.length, combinedDescription.length, 1);
    return {
      lineLines,
      itemLines,
      descriptionLines: combinedDescription.length ? combinedDescription : [""],
      qty: formatQtyDisplay(item.qty),
      uom: String(item.uom || ""),
      height: 10 + (lineCount * 11)
    };
  });

  const pages = [];
  let currentPage = [];
  let currentHeight = 0;
  const tableHeaderHeight = 24;
  const reservedHeaderHeight = 82;
  const footerPadding = 22;
  const pageBodyLimit = pageHeight - reservedHeaderHeight - footerPadding - 36;
  for (const row of rows) {
    if (currentPage.length && currentHeight + row.height > pageBodyLimit) {
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }
    currentPage.push(row);
    currentHeight += row.height;
  }
  if (!pages.length || currentPage.length) pages.push(currentPage);

  return buildDrawnPdf(pages.map((pageRows, pageIndex) => {
    const content = [];
    content.push("0.2 w");
    content.push("0 0 0 RG");

    const metaTop = top;
    content.push(rect(left, metaTop - 26, usableWidth, 26));
    content.push(line(left + 160, metaTop, left + 160, metaTop - 26));
    content.push(line(right - 170, metaTop, right - 170, metaTop - 26));
    content.push(makeText(left + 8, metaTop - 17, "RFQ #", "F2", 9));
    content.push(makeText(left + 48, metaTop - 17, String(rfq.rfq_no || ""), "F1", 10));
    content.push(makeText(left + 168, metaTop - 17, "DESCRIPTION", "F2", 9));
    content.push(makeText(right - 162, metaTop - 17, "CREATED", "F2", 9));
  content.push(makeText(right - 110, metaTop - 17, formatShortDateTime(rfq.created_at), "F1", 10));

    const descriptionBoxTop = metaTop - 26;
    content.push(rect(left, descriptionBoxTop - 30, usableWidth, 30));
    const headerDescription = wrapPdfText(String(rfq.project_name || ""), 92);
    content.push(makeText(left + 8, descriptionBoxTop - 19, headerDescription[0] || "", "F1", 10));

    const tableTop = descriptionBoxTop - 42;
    let x = left;
    content.push(rect(left, tableTop - tableHeaderHeight, usableWidth, tableHeaderHeight));
    cols.forEach((column) => {
      content.push(makeText(x + 6, tableTop - 16, column.label, "F2", 8));
      x += column.width;
      if (x < right) content.push(line(x, tableTop, x, tableTop - tableHeaderHeight));
    });

    let y = tableTop - tableHeaderHeight;
    for (const row of pageRows) {
      const rowTop = y;
      const rowBottom = y - row.height;
      x = left;
      content.push(rect(left, rowBottom, usableWidth, row.height));
      cols.forEach((column) => {
        x += column.width;
        if (x < right) content.push(line(x, rowTop, x, rowBottom));
      });

      const rowLineCount = Math.max(row.lineLines.length, row.itemLines.length, row.descriptionLines.length, 1);
      for (let index = 0; index < rowLineCount; index += 1) {
        const baseline = rowTop - 14 - (index * 11);
        if (row.lineLines[index]) content.push(makeText(left + 6, baseline, row.lineLines[index], "F1", 8.5));
        if (row.itemLines[index]) content.push(makeText(left + cols[0].width + 6, baseline, row.itemLines[index], "F1", 8.5));
        if (row.descriptionLines[index]) content.push(makeText(left + cols[0].width + cols[1].width + 6, baseline, row.descriptionLines[index], "F1", 8.5));
        if (index === 0 && row.qty) content.push(makeText(left + cols[0].width + cols[1].width + cols[2].width + 18, baseline, row.qty, "F1", 8.5));
        if (index === 0 && row.uom) content.push(makeText(right - cols[4].width + 6, baseline, row.uom, "F1", 8.5));
      }

      y = rowBottom;
    }

    content.push(makeText(right - 92, 18, `Page ${pageIndex + 1} of ${pages.length}`, "F1", 8));
    return content.join("\n");
  }), { pageWidth, pageHeight });
}

function buildDrawnPdf(pages, options = {}) {
  const pageWidth = options.pageWidth || 612;
  const pageHeight = options.pageHeight || 792;
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds = [];
  for (const contentStream of pages) {
    const contentId = addObject(`<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream`);
    pageIds.push(addObject(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  const pagesId = addObject(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace("PAGES_REF", `${pagesId} 0 R`);
  }
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function buildPickLocationPlan(locationRows, qtyRequested) {
  let qtyNeeded = Number(qtyRequested || 0);
  const plan = [];
  for (const row of locationRows) {
    if (qtyNeeded <= 0) break;
    const qtyAvailable = Number(row.qty_available || 0);
    if (qtyAvailable <= 0) continue;
    const qtyPulled = Math.min(qtyNeeded, qtyAvailable);
    plan.push(`${row.warehouse}/${row.location} (${qtyPulled})`);
    qtyNeeded -= qtyPulled;
  }
  if (!plan.length) return "No inventory location";
  if (qtyNeeded > 0) plan.push(`Short ${qtyNeeded}`);
  return plan.join(", ");
}

function buildPickTicketPdf(header, lines) {
  const pageWidth = 792;
  const pageHeight = 612;
  const left = 28;
  const right = pageWidth - 28;
  const top = pageHeight - 24;
  const rowHeight = 24;
  const maxRowsFirstPage = 14;
  const maxRowsOtherPages = 17;
  const chunks = [];
  let cursor = 0;
  while (cursor < lines.length || !chunks.length) {
    const maxRows = chunks.length ? maxRowsOtherPages : maxRowsFirstPage;
    chunks.push(lines.slice(cursor, cursor + maxRows));
    cursor += maxRows;
  }

  const makeText = (x, y, text, font = "F1", size = 9) => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`;
  const rect = (x, y, w, h) => `${x} ${y} ${w} ${h} re S`;
  const line = (x1, y1, x2, y2) => `${x1} ${y1} m ${x2} ${y2} l S`;

  return buildDrawnPdf(chunks.map((pageLines, pageIndex) => {
    const content = [];
    content.push("0.2 w");
    content.push("0 0 0 RG");
    content.push(rect(left, top - 40, right - left, 40));
    content.push(makeText(left + 12, top - 18, "PICK TICKET", "F2", 17));
    content.push(makeText(left + 12, top - 32, "Laydown Yard Material Pick Copy", "F1", 8));
    content.push(makeText(right - 170, top - 18, `REQ # ${header.requisition_no || ""}`, "F2", 12));
    content.push(makeText(right - 170, top - 32, `Page ${pageIndex + 1} of ${chunks.length}`, "F1", 8));

    const metaTop = top - 52;
    content.push(rect(left, metaTop - 34, 240, 34));
    content.push(rect(left + 240, metaTop - 34, 132, 34));
    content.push(rect(left + 372, metaTop - 34, 140, 34));
    content.push(rect(left + 512, metaTop - 34, 224, 34));
    content.push(makeText(left + 8, metaTop - 13, "REQUESTED BY", "F2", 8));
    content.push(makeText(left + 8, metaTop - 26, String(header.requested_by_name || "").slice(0, 34), "F1", 10));
    content.push(makeText(left + 248, metaTop - 13, "CREATED", "F2", 8));
  content.push(makeText(left + 248, metaTop - 26, formatShortDateTime(header.created_at), "F1", 9));
    content.push(makeText(left + 380, metaTop - 13, "PRINTED", "F2", 8));
    content.push(makeText(left + 380, metaTop - 26, formatPickTicketTimestamp().slice(0, 19), "F1", 9));
    content.push(makeText(left + 520, metaTop - 13, "BOM", "F2", 8));
    content.push(makeText(left + 520, metaTop - 26, String(header.bom_name || header.bom_description || header.bom_no || "").slice(0, 32), "F1", 9));

    const meta2Top = metaTop - 42;
    if (header.notes) {
      content.push(rect(left, meta2Top - 26, right - left, 26));
      content.push(makeText(left + 8, meta2Top - 10, "NOTES", "F2", 7));
      content.push(makeText(left + 8, meta2Top - 20, String(header.notes).slice(0, 108), "F1", 8));
    }

    const tableTop = meta2Top - (header.notes ? 40 : 14);
    const widths = [126, 96, 254, 50, 40, 170];
    const headers = ["LINE", "ITEM", "DESCRIPTION", "QTY", "UOM", "LOCATION"];
    let x = left;
    content.push(rect(left, tableTop - rowHeight, right - left, rowHeight));
    for (let i = 0; i < widths.length; i += 1) {
      if (i > 0) content.push(line(x, tableTop, x, tableTop - rowHeight - (pageLines.length * rowHeight)));
      content.push(makeText(x + 4, tableTop - 15, headers[i], "F2", 8));
      x += widths[i];
    }
    content.push(line(right, tableTop, right, tableTop - rowHeight - (pageLines.length * rowHeight)));

    let y = tableTop - rowHeight;
    for (const item of pageLines) {
      content.push(rect(left, y - rowHeight, right - left, rowHeight));
      let cellX = left;
      const wrappedDescription = wrapPdfText(item.description, 36);
      const wrappedLocation = wrapPdfText(item.pick_location || "", 22);
      const rowValues = [
        item.line_no || "",
        item.item_code || "",
        wrappedDescription[0] || "",
        formatQtyDisplay(item.qty_requested),
        item.uom || "",
        wrappedLocation[0] || ""
      ];
      for (let i = 0; i < widths.length; i += 1) {
        const value = rowValues[i];
        const textX = i === 3 ? cellX + widths[i] - 24 : cellX + 4;
        content.push(makeText(textX, y - 15, value, "F1", 8));
        cellX += widths[i];
      }
      if (wrappedDescription[1]) {
        content.push(makeText(left + widths[0] + widths[1] + 4, y - 21, wrappedDescription[1], "F1", 7));
      }
      if (wrappedLocation[1]) {
        content.push(makeText(left + widths[0] + widths[1] + widths[2] + widths[3] + widths[4] + 4, y - 21, wrappedLocation[1], "F1", 7));
      }
      y -= rowHeight;
    }

    const footerTop = 86;
    content.push(rect(left + 8, footerTop, 510, 30));
    content.push(rect(left + 518, footerTop, 160, 30));
    content.push(makeText(left + 12, footerTop + 18, "Pulled by:", "F1", 8));
    content.push(makeText(left + 522, footerTop + 18, "Date:", "F1", 8));

    content.push(rect(left + 8, footerTop - 46, 510, 30));
    content.push(makeText(left + 12, footerTop - 28, "Received by (PRINT):", "F1", 8));

    content.push(rect(left + 8, footerTop - 92, 510, 30));
    content.push(rect(left + 518, footerTop - 92, 160, 30));
    content.push(makeText(left + 12, footerTop - 74, "Received by (SIGN):", "F1", 8));
    content.push(makeText(left + 522, footerTop - 74, "Date:", "F1", 8));

    return content.join("\n");
  }), { pageWidth, pageHeight });
}

function buildMrrFormPdf(header, lines, options = {}) {
  const pageWidth = 612;
  const pageHeight = 792;
  const left = 18;
  const right = pageWidth - 18;
  const top = pageHeight - 18;
  const content = [];
  const makeText = (x, y, text, font = "F1", size = 8) => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`;
  const rect = (x, y, w, h) => `${x} ${y} ${w} ${h} re S`;
  const line = (x1, y1, x2, y2) => `${x1} ${y1} m ${x2} ${y2} l S`;
  const centerText = (x, y, w, text, font = "F1", size = 8) => {
    const safe = String(text ?? "");
    const estimatedWidth = safe.length * size * 0.42;
    const textX = x + Math.max(2, (w - estimatedWidth) / 2);
    return makeText(textX, y, safe, font, size);
  };
  const field = (x, yTop, w, h, label, value = "", opts = {}) => {
    const labelSize = opts.labelSize || 6;
    const valueSize = opts.valueSize || 8;
    const align = opts.align || "left";
    content.push(rect(x, yTop - h, w, h));
    content.push(makeText(x + 2, yTop - 8, label, "F2", labelSize));
    const text = String(value || "");
    if (align === "center") {
      content.push(centerText(x, yTop - 18, w, text, "F1", valueSize));
    } else {
      content.push(makeText(x + 2, yTop - 19, text, "F1", valueSize));
    }
  };
  const checkbox = (x, y, checked = false, label = "") => {
    content.push(rect(x, y - 8, 8, 8));
    if (checked) {
      content.push(line(x + 1.5, y - 6.5, x + 6.5, y - 1.5));
      content.push(line(x + 6.5, y - 6.5, x + 1.5, y - 1.5));
    }
    if (label) content.push(makeText(x + 12, y - 6, label, "F1", 7));
  };
  const formatDate = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    return formatShortDateTime(text);
  };
  const lineItems = lines.slice(0, 12);
  const discrepancyItems = lines.filter((row) => String(row.status || "").trim() && String(row.status || "").trim().toUpperCase() !== "OK").slice(0, 8);
  const jobNumber = String(options.jobNumber || "").trim();
  const deliveryLocation = String(options.deliveryLocation || "KEQ3").trim();
  const fmrNumber = String(options.fmrNumber || "").trim();
  const pageNo = "1";
  const pageCount = "1";
  const topSectionBottom = top - 290;

  content.push("0.4 w");
  content.push("0 0 0 RG");
  content.push(rect(left, topSectionBottom, right - left, top - topSectionBottom));

  const x0 = left;
  const totalWidth = right - left;
  const col1 = 92;
  const col2 = 108;
  const col3 = 96;
  const col4 = totalWidth - col1 - col2 - col3;
  const y1 = top;
  field(x0, y1, totalWidth - 94, 28, " ", "", { align: "center" });
  content.push(centerText(x0, y1 - 10, totalWidth - 94, "PERFORMANCE CONTRACTORS, INC.", "F2", 9));
  content.push(centerText(x0, y1 - 21, totalWidth - 94, "MATERIAL RECEIVING REPORT (MRR)", "F2", 9));
  field(right - 94, y1, 94, 28, "MRR NO.", header.mrr_number || "", { align: "center", valueSize: 9 });

  const y2 = y1 - 28;
  field(x0, y2, col1, 24, "1.JOB(CONTRACT)NO.", jobNumber);
  field(x0 + col1, y2, col2, 24, "2.DATE RECEIVED", formatDate(header.received_date));
  field(x0 + col1 + col2, y2, col3, 24, "3.P.O.NO", header.po_number || "");
  field(x0 + col1 + col2 + col3, y2, 46, 24, "4.PAGE", pageNo);
  field(x0 + col1 + col2 + col3 + 46, y2, totalWidth - col1 - col2 - col3 - 46, 24, "OF", pageCount);

  const y3 = y2 - 24;
  field(x0, y3, 130, 24, "5. SHIP TICKET NO", header.pick_ticket || "");
  field(x0 + 130, y3, 140, 24, "6. SUPPLIER ORDER NO.", "");
  field(x0 + 270, y3, 198, 24, "7. MATERIAL REQ/LOAD NO.", header.load_number || fmrNumber);
  field(x0 + 468, y3, totalWidth - 468, 24, "8. DELIVERY LOCATION (LAYDOWNYARD, UNIT, ETC.)", deliveryLocation);

  const y4 = y3 - 24;
  field(x0, y4, 392, 24, "9. SUPPLIER", header.vendor_name || "");
  field(x0 + 392, y4, totalWidth - 392, 24, "10.CARRIER", "");

  const y5 = y4 - 24;
  field(x0, y5, totalWidth / 2, 46, "11. DELIVERED BY", "");
  field(x0 + totalWidth / 2, y5, totalWidth / 2, 46, "12. RECEIVED BY", header.received_by || "");
  content.push(makeText(x0 + 128, y5 - 19, "(PRINT)", "F1", 6));
  content.push(makeText(x0 + 128, y5 - 35, "(SIGNATURE)", "F1", 6));
  content.push(makeText(x0 + 150, y5 - 35, "(DATE)", "F1", 6));
  content.push(makeText(x0 + totalWidth / 2 + 125, y5 - 19, "(PRINT)", "F1", 6));
  content.push(makeText(x0 + totalWidth / 2 + 125, y5 - 35, "(SIGNATURE)", "F1", 6));
  content.push(makeText(x0 + totalWidth / 2 + 150, y5 - 35, "(DATE)", "F1", 6));

  const tableTop = y5 - 46;
  const tableHeaderHeight = 24;
  const itemCols = [160, 252, 48, 52, 64];
  const itemHeaders = [
    "13. STOCK/ITEM NO (TAG NO)",
    "14. DESCRIPTION",
    "15\nQTY",
    "16\nLOCATION",
    "17\nGRID"
  ];
  content.push(rect(x0, tableTop - tableHeaderHeight - (lineItems.length * 18 || 216), totalWidth, tableHeaderHeight + (Math.max(lineItems.length, 12) * 18)));
  let itemX = x0;
  for (let i = 0; i < itemCols.length; i += 1) {
    if (i > 0) content.push(line(itemX, tableTop, itemX, tableTop - tableHeaderHeight - (Math.max(lineItems.length, 12) * 18)));
    const headerLines = itemHeaders[i].split("\n");
    content.push(makeText(itemX + 2, tableTop - 8, headerLines[0], "F2", 6));
    if (headerLines[1]) content.push(centerText(itemX, tableTop - 17, itemCols[i], headerLines[1], "F2", 6));
    itemX += itemCols[i];
  }
  content.push(line(x0, tableTop - tableHeaderHeight, right, tableTop - tableHeaderHeight));
  content.push(makeText(x0 + 164, tableTop - 14, "(INDICATE NUMBER OF SHIPPING CONTAINERS - TYPE OF CONTAINER - CONTAINER NUMBER, ETC.)", "F1", 5));
  let rowY = tableTop - tableHeaderHeight;
  for (let i = 0; i < 12; i += 1) {
    const item = lineItems[i] || {};
    const descLines = wrapPdfText(item.description || "", 48);
    content.push(line(x0, rowY - 18, right, rowY - 18));
    content.push(makeText(x0 + 2, rowY - 12, item.item_code || "", "F1", 7));
    content.push(makeText(x0 + itemCols[0] + 2, rowY - 10, descLines[0] || "", "F1", 6));
    if (descLines[1]) content.push(makeText(x0 + itemCols[0] + 2, rowY - 16, descLines[1], "F1", 6));
    content.push(centerText(x0 + itemCols[0] + itemCols[1], rowY - 12, itemCols[2], item.qty || "", "F1", 7));
    content.push(centerText(x0 + itemCols[0] + itemCols[1] + itemCols[2], rowY - 12, itemCols[3], item.location || "", "F1", 7));
    content.push(centerText(x0 + itemCols[0] + itemCols[1] + itemCols[2] + itemCols[3], rowY - 12, itemCols[4], item.grid || "", "F1", 7));
    rowY -= 18;
  }

  const osdTop = rowY - 10;
  content.push(rect(x0, osdTop - 18, totalWidth, 18));
  content.push(makeText(x0 + 2, osdTop - 8, "18.REPORT OF UNSATISFACTORY OVER SHORT AND DAMAGED MATERIAL (ONLY NECESSARY IF DISCREPANCIES EXIST)", "F2", 5.5));
  const osdHeaderTop = osdTop - 18;
  const osdRowsHeight = Math.max(discrepancyItems.length, 8) * 16;
  const itemWidth = 68;
  const qtyTotalWidth = 240;
  const qtyColWidth = qtyTotalWidth / 3;
  const descWidth = totalWidth - itemWidth - qtyTotalWidth;
  content.push(rect(x0, osdHeaderTop - 34 - osdRowsHeight, totalWidth, 34 + osdRowsHeight));
  content.push(line(x0 + itemWidth, osdHeaderTop, x0 + itemWidth, osdHeaderTop - 34 - osdRowsHeight));
  content.push(line(x0 + itemWidth + qtyTotalWidth, osdHeaderTop, x0 + itemWidth + qtyTotalWidth, osdHeaderTop - 34 - osdRowsHeight));
  content.push(line(x0, osdHeaderTop - 18, right, osdHeaderTop - 18));
  content.push(line(x0, osdHeaderTop - 34, right, osdHeaderTop - 34));
  content.push(line(x0 + itemWidth + qtyColWidth, osdHeaderTop - 18, x0 + itemWidth + qtyColWidth, osdHeaderTop - 34 - osdRowsHeight));
  content.push(line(x0 + itemWidth + qtyColWidth * 2, osdHeaderTop - 18, x0 + itemWidth + qtyColWidth * 2, osdHeaderTop - 34 - osdRowsHeight));
  content.push(centerText(x0, osdHeaderTop - 12, itemWidth, "ITEM", "F2", 6));
  content.push(centerText(x0 + itemWidth, osdHeaderTop - 12, qtyTotalWidth, "QUANTITY", "F2", 6));
  content.push(makeText(x0 + itemWidth + qtyTotalWidth + 2, osdHeaderTop - 12, "COMPLETE DESCRIPTION OF DESCREPENCEY", "F2", 6));
  content.push(centerText(x0, osdHeaderTop - 28, itemWidth, "TAG NO.", "F2", 5.5));
  content.push(centerText(x0 + itemWidth, osdHeaderTop - 28, qtyColWidth, "ORDERED", "F2", 5.5));
  content.push(centerText(x0 + itemWidth + qtyColWidth, osdHeaderTop - 28, qtyColWidth, "SHIPPED", "F2", 5.5));
  content.push(centerText(x0 + itemWidth + qtyColWidth * 2, osdHeaderTop - 28, qtyColWidth, "RECEIVED", "F2", 5.5));
  let osdY = osdHeaderTop - 34;
  for (let i = 0; i < 8; i += 1) {
    const item = discrepancyItems[i] || {};
    const issueText = wrapPdfText(item.discrepancy || "", 40);
    content.push(line(x0, osdY - 16, right, osdY - 16));
    content.push(makeText(x0 + 2, osdY - 11, item.item_code || "", "F1", 6));
    content.push(centerText(x0 + itemWidth, osdY - 11, qtyColWidth, item.ordered || "", "F1", 6));
    content.push(centerText(x0 + itemWidth + qtyColWidth, osdY - 11, qtyColWidth, item.shipped || "", "F1", 6));
    content.push(centerText(x0 + itemWidth + qtyColWidth * 2, osdY - 11, qtyColWidth, item.received || "", "F1", 6));
    content.push(makeText(x0 + itemWidth + qtyTotalWidth + 2, osdY - 11, issueText[0] || "", "F1", 5.5));
    if (issueText[1]) content.push(makeText(x0 + itemWidth + qtyTotalWidth + 2, osdY - 15, issueText[1], "F1", 5.5));
    osdY -= 16;
  }

  const remarksTop = osdY;
  field(x0, remarksTop, totalWidth, 18, "NATURE AND EXTENT OF OVERAGE-LOSS-DAMAGED OR UNSATISFACTORY CONDITION OF MATERIAL AND REMARKS:", "");
  const infoTop = remarksTop - 18;
  field(x0, infoTop, 192, 18, "TYPE OF CONTAINER:", header.container_type || "");
  field(x0 + 192, infoTop, 166, 18, "CONTAINER FILED TO CAPACITY?:", "");
  field(x0 + 358, infoTop, totalWidth - 358, 18, "TYPE OF PACKING USED:", "");

  const info2Top = infoTop - 18;
  field(x0, info2Top, 192, 18, "EXCEPTION NOTED ON SHIPPING/FREIGHT TICKET?", "");
  field(x0 + 192, info2Top, 166, 18, "CARRIER NOTIFIED?", "");
  field(x0 + 358, info2Top, totalWidth - 358, 18, "WAS DAMAGE CONCEALED?", "");

  const info3Top = info2Top - 18;
  field(x0, info3Top, 240, 18, "INSPECTED FOR CARRIER BY:", "");
  field(x0 + 240, info3Top, 120, 18, "DATE:", "");
  field(x0 + 360, info3Top, totalWidth - 360, 18, "CARRIER INSPECTION REPORT NO.:", "");

  const optsTop = info3Top - 18;
  content.push(rect(x0, optsTop - 24, totalWidth, 24));
  content.push(makeText(x0 + 2, optsTop - 8, "THIS REPORT IS FOR:", "F2", 6));
  checkbox(x0 + 76, optsTop - 6, false, "OVERAGE");
  checkbox(x0 + 156, optsTop - 6, false, "SHORTAGE");
  checkbox(x0 + 278, optsTop - 6, false, "DAMAGED");
  checkbox(x0 + 400, optsTop - 6, false, "UNSATISFACTORY");
  checkbox(x0 + 520, optsTop - 6, false, "OTHER");

  const attachTop = optsTop - 24;
  content.push(rect(x0, attachTop - 30, totalWidth, 30));
  content.push(makeText(x0 + 2, attachTop - 8, "ATACHMENTS:", "F2", 6));
  content.push(makeText(x0 + 2, attachTop - 18, "CARRIER INSPECTION REPORT", "F2", 6));
  checkbox(x0 + 188, attachTop - 18, false, "PHOTOS");
  checkbox(x0 + 268, attachTop - 18, false, "PICK/SHIPPING TICKET");
  checkbox(x0 + 404, attachTop - 18, false, "NCR(IF APPLICABLE)");
  checkbox(x0 + 522, attachTop - 18, false, "MTRS");
  checkbox(x0 + 560, attachTop - 18, false, "OTHER");

  const dispoTop = attachTop - 30;
  field(x0, dispoTop, 310, 18, "INSPECTING FIELD SUPT./ENG.:", "");
  field(x0 + 310, dispoTop, totalWidth - 310, 18, "DISPOSITION RECOMMENDED:", "");

  const certTop = dispoTop - 22;
  field(x0, certTop, totalWidth, 18, "I CERTIFY THE ABOVE REPORT TO BE TRUE AND IN ACCORDANCE WITH THE CONDITION OF THE GOODS UPON RECEIPT", "");
  const signTop = certTop - 18;
  field(x0, signTop, 194, 18, "DATE:", "");
  field(x0 + 194, signTop, 164, 18, "BY:", "");
  field(x0 + 358, signTop, totalWidth - 358, 18, "TITLE:", "");

  return buildDrawnPdf([content.join("\n")], { pageWidth, pageHeight });
}

function layout(title, body, user) {
  const navLinks = user
    ? permissionSections
        .filter((section) => canAccess(user, section.key, "view"))
        .map((section) => `<a href="${section.href}">${section.label}</a>`)
        .concat(`<a href="/logout">Logout</a>`)
        .join("")
    : "";
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      :root {
        --bg: #dfe3e8;
        --panel: #ffffff;
        --ink: #16212b;
        --muted: #4d5b69;
        --line: #9ca8b3;
        --line-strong: #798693;
        --brand: #2d5d87;
        --brand-2: #4b5966;
        --warn: #a23622;
        --header: #cfd6de;
        --header-strong: #bcc6cf;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Tahoma, Verdana, sans-serif; color: var(--ink); background: var(--bg); }
      .shell { max-width: 1600px; margin: 0 auto; padding: 12px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; padding: 10px 12px; background: linear-gradient(180deg, var(--header) 0%, var(--header-strong) 100%); border: 1px solid var(--line-strong); border-radius: 2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.55); }
      .brand-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .brand-link { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; min-width: 0; }
      .brand-logo { width: 74px; height: 46px; object-fit: contain; flex-shrink: 0; }
      .brand-copy { min-width: 0; }
      .brand { font-size: 22px; font-weight: 700; letter-spacing: .01em; }
      .userline { color: var(--muted); font-size: 12px; }
      nav { display: flex; gap: 6px; flex-wrap: wrap; }
      nav a { color: #12324b; text-decoration: none; font-weight: 600; padding: 6px 9px; border: 1px solid transparent; border-radius: 2px; }
      nav a:hover { background: #edf1f4; border-color: var(--line); }
      .card { background: var(--panel); border: 1px solid var(--line-strong); border-radius: 2px; box-shadow: none; padding: 12px; margin-bottom: 10px; }
      h1, h2, h3 { margin: 0 0 12px; }
      h1 { font-size: 24px; }
      h2 { font-size: 20px; }
      h3 { font-size: 16px; text-transform: uppercase; letter-spacing: .03em; }
      .muted { color: var(--muted); font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .stat { padding: 10px; border: 1px solid var(--line-strong); border-radius: 2px; background: linear-gradient(180deg, #f6f8fa 0%, #e9eef2 100%); }
      .stat strong { display: block; font-size: 24px; margin-top: 4px; }
      label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 3px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
      input, select, textarea { width: 100%; padding: 7px 8px; border-radius: 2px; border: 1px solid var(--line-strong); background: #fff; color: var(--ink); font: inherit; box-shadow: inset 0 1px 1px rgba(0,0,0,.04); }
      textarea { min-height: 96px; resize: vertical; }
      button, .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; height: 32px; padding: 0 12px; border-radius: 2px; border: 1px solid rgba(0,0,0,.15); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,.25); }
      button, .btn-primary { background: linear-gradient(180deg, #4278a9 0%, var(--brand) 100%); color: white; }
      .btn-secondary { background: linear-gradient(180deg, #6a7681 0%, var(--brand-2) 100%); color: white; }
      .btn-danger { background: linear-gradient(180deg, #bf5b49 0%, var(--warn) 100%); color: white; }
      .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .check-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px 14px; }
      .check-option { display: grid; grid-template-columns: 18px 1fr; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; text-transform: uppercase; }
      .check-option input { width: 14px; height: 14px; margin: 0; justify-self: center; }
      .inline-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .scroll { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
      th, td { padding: 6px 7px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: #223240; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: linear-gradient(180deg, #e5eaef 0%, #d3dbe3 100%); }
      th.sortable-th { cursor: pointer; }
      th.sortable-th .sort-indicator { margin-left: 4px; color: var(--muted); font-size: 10px; }
      tr:nth-child(even) td { background: #f7f9fb; }
      .data-grid { table-layout: fixed; min-width: 1400px; }
      .data-grid th { position: relative; user-select: none; }
      .data-grid td { overflow: hidden; text-overflow: ellipsis; }
      .data-grid td.wrap, .data-grid th.wrap { white-space: normal; }
      .data-grid td.nowrap, .data-grid th.nowrap { white-space: nowrap; }
      .resize-handle { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize; }
      .chip { display: inline-block; padding: 3px 8px; border-radius: 2px; background: #e3ebf2; border: 1px solid #b6c4d1; color: #264b69; font-weight: 700; }
      .tab-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .tab-link { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; min-height: 32px; padding: 6px 12px; border-radius: 2px; border: 1px solid var(--line-strong); background: linear-gradient(180deg, #eef3f7 0%, #d9e1e8 100%); color: #18354e; font-weight: 700; text-decoration: none; }
      .tab-link.active { background: linear-gradient(180deg, #4278a9 0%, var(--brand) 100%); border-color: rgba(0,0,0,.15); color: white; }
      .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .dashboard-sections { display: grid; gap: 10px; }
      .error { border-color: #d0a19b; background: #f8ecea; color: var(--warn); }
      .stack { display: grid; gap: 10px; }
      @media (max-width: 900px) { .grid, .grid-4, .stats, .summary-grid { grid-template-columns: 1fr; } .topbar { flex-direction: column; align-items: flex-start; } }
    </style>
    <script>
      function togglePassword(button, targetId) {
        const input = document.getElementById(targetId);
        if (!input) return;
        const nextType = input.type === "password" ? "text" : "password";
        input.type = nextType;
        button.textContent = nextType === "password" ? "Show" : "Hide";
      }
      function passwordRuleError(value) {
        const password = String(value || "");
        if (password.length < 10) return "Password must be at least 10 characters.";
        if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
        if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
        if (!/[0-9]/.test(password)) return "Password must include at least one number.";
        return "";
      }
      function validatePasswordForm(formId, inputName, messageId) {
        const form = document.getElementById(formId);
        if (!form) return true;
        const input = form.querySelector('[name="' + inputName + '"]');
        const message = document.getElementById(messageId);
        if (!input) return true;
        const value = String(input.value || "");
        if (!value) {
          if (message) {
            message.textContent = "";
            message.style.color = "#4d5b69";
          }
          return true;
        }
        const error = passwordRuleError(value);
        if (message) {
          message.textContent = error || "Password meets requirements.";
          message.style.color = error ? "#a23622" : "#1f6b3a";
        }
        return !error;
      }
      function attachPasswordValidation(formId, inputName, messageId) {
        const form = document.getElementById(formId);
        if (!form) return;
        const input = form.querySelector('[name="' + inputName + '"]');
        const run = () => validatePasswordForm(formId, inputName, messageId);
        if (input) input.addEventListener("input", run);
        form.addEventListener("submit", (event) => {
          if (!validatePasswordForm(formId, inputName, messageId)) {
            event.preventDefault();
          }
        });
      }
      function phoneDigits(value) {
        return String(value || "").replace(/\D/g, "").slice(0, 11);
      }
      function formatPhoneValue(value) {
        const digits = phoneDigits(value);
        if (digits.length === 11 && digits.startsWith("1")) {
          return "1-" + digits.slice(1, 4) + "-" + digits.slice(4, 7) + "-" + digits.slice(7, 11);
        }
        if (digits.length <= 3) return digits;
        if (digits.length <= 6) return digits.slice(0, 3) + "-" + digits.slice(3);
        return digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6, 10);
      }
      function applyPhoneMask(input) {
        if (!input) return;
        input.value = formatPhoneValue(input.value);
      }
      function formatPhoneOnBlur(input) {
        applyPhoneMask(input);
      }
      function validateBulkAward(form) {
        if (!form) return true;
        const prices = Array.from(form.querySelectorAll('input[name^="unit_price_"]'));
        let populatedCount = 0;
        for (const priceInput of prices) {
          const itemId = priceInput.name.replace("unit_price_", "");
          const leadInput = form.querySelector('input[name="lead_days_' + itemId + '"]');
          const priceValue = String(priceInput.value || "").trim();
          const leadValue = String(leadInput ? leadInput.value || "" : "").trim();
          if (!priceValue) continue;
          populatedCount += 1;
          if (!leadValue) {
            window.alert("Lead time is required for every row with a unit price before awarding.");
            return false;
          }
        }
        if (!populatedCount) {
          window.alert("Enter at least one unit price before awarding.");
          return false;
        }
        return true;
      }
      function promptPoNumber(button, vendorSelectId, targetFormId) {
        const vendorSelect = document.getElementById(vendorSelectId);
        const targetForm = document.getElementById(targetFormId);
        if (!vendorSelect || !targetForm) return false;
        if (!vendorSelect.value) {
          window.alert("Select a vendor first.");
          return false;
        }
        const poNumber = window.prompt("Enter PO number");
        if (!poNumber || !String(poNumber).trim()) return false;
        const poInput = targetForm.querySelector('input[name="po_no"]');
        const vendorInput = targetForm.querySelector('input[name="vendor_id"]');
        if (!poInput || !vendorInput) return false;
        poInput.value = String(poNumber).trim();
        vendorInput.value = vendorSelect.value;
        targetForm.submit();
        return false;
      }
      function filterTableRows(inputId, tableId) {
        const input = document.getElementById(inputId);
        const table = document.getElementById(tableId);
        if (!input || !table) return;
        const term = input.value.toLowerCase();
        const rows = table.querySelectorAll("tbody tr");
        rows.forEach((row) => {
          row.style.display = row.innerText.toLowerCase().includes(term) ? "" : "none";
        });
      }
      function syncLocationOptions(warehouseSelectId, locationSelectId, optionsByWarehouse, selectedValue) {
        const warehouseSelect = document.getElementById(warehouseSelectId);
        const locationSelect = document.getElementById(locationSelectId);
        if (!warehouseSelect || !locationSelect) return;
        const warehouseName = String(warehouseSelect.value || "");
        const locations = optionsByWarehouse[warehouseName] || [];
        const keepValue = selectedValue !== undefined ? String(selectedValue || "") : String(locationSelect.value || "");
        const placeholder = locationSelect.getAttribute("data-placeholder") || "Select location";
        locationSelect.innerHTML = "";
        const placeholderOption = document.createElement("option");
        placeholderOption.value = "";
        placeholderOption.textContent = placeholder;
        locationSelect.appendChild(placeholderOption);
        locations.forEach((locationName) => {
          const option = document.createElement("option");
          option.value = locationName;
          option.textContent = locationName;
          if (locationName === keepValue) option.selected = true;
          locationSelect.appendChild(option);
        });
        if (!locations.includes(keepValue)) {
          locationSelect.value = "";
        }
      }
      function enableResizableTable(tableId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const headers = table.querySelectorAll("th[data-resizable='true']");
        headers.forEach((header) => {
          if (header.querySelector(".resize-handle")) return;
          const handle = document.createElement("span");
          handle.className = "resize-handle";
          header.appendChild(handle);
          handle.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const startX = event.pageX;
            const startWidth = header.offsetWidth;
            const onMove = (moveEvent) => {
              const nextWidth = Math.max(60, startWidth + (moveEvent.pageX - startX));
              header.style.width = nextWidth + "px";
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          });
        });
      }
      function getSortableCellText(cell) {
        if (!cell) return "";
        if (cell.dataset && cell.dataset.sortValue !== undefined) return String(cell.dataset.sortValue || "");
        const select = cell.querySelector("select");
        if (select) {
          const selectedOption = select.options[select.selectedIndex];
          return selectedOption ? String(selectedOption.text || selectedOption.value || "") : String(select.value || "");
        }
        const input = cell.querySelector("input, textarea");
        if (input) return String(input.value || input.getAttribute("value") || "");
        return String(cell.innerText || cell.textContent || "");
      }
      function parseSortableValue(text) {
        const value = String(text || "").trim();
        if (!value) return { type: "text", value: "" };
        const shortDateMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
        if (shortDateMatch) {
          const year = Number(shortDateMatch[3]);
          const month = Number(shortDateMatch[2]) - 1;
          const day = Number(shortDateMatch[1]);
          const hour = Number(shortDateMatch[4] || 0);
          const minute = Number(shortDateMatch[5] || 0);
          return { type: "number", value: new Date(year, month, day, hour, minute).getTime() };
        }
        const numericText = value.replace(/,/g, "");
        if (/^-?\d+(?:\.\d+)?$/.test(numericText)) {
          return { type: "number", value: Number(numericText) };
        }
        return { type: "text", value: value.toLowerCase() };
      }
      function makeTableSortable(table) {
        if (!table) return;
        const rows = Array.from(table.querySelectorAll("tr"));
        if (rows.length < 2) return;
        const headerRow = rows[0];
        const headers = Array.from(headerRow.querySelectorAll("th"));
        if (!headers.length) return;
        headers.forEach((th, index) => {
          if (th.querySelector("a")) return;
          const headerText = String(th.innerText || "").trim().toLowerCase();
          if (!headerText || headerText === "action" || headerText === "actions") return;
          if (th.dataset.sortReady === "1") return;
          th.dataset.sortReady = "1";
          th.classList.add("sortable-th");
          const indicator = document.createElement("span");
          indicator.className = "sort-indicator";
          indicator.textContent = "";
          th.appendChild(indicator);
            th.addEventListener("click", () => {
              const currentIndex = Number(table.dataset.sortIndex || -1);
              const nextDir = currentIndex === index && table.dataset.sortDir === "asc" ? "desc" : "asc";
              const bodyRows = Array.from(table.querySelectorAll("tr")).slice(1);
              bodyRows.sort((a, b) => {
                const aParsed = parseSortableValue(getSortableCellText(a.children[index]));
                const bParsed = parseSortableValue(getSortableCellText(b.children[index]));
                let result = 0;
                if (aParsed.type === "number" && bParsed.type === "number") {
                  result = aParsed.value - bParsed.value;
              } else {
                result = String(aParsed.value).localeCompare(String(bParsed.value), undefined, { numeric: true, sensitivity: "base" });
              }
              return nextDir === "asc" ? result : -result;
            });
            bodyRows.forEach((row) => table.appendChild(row));
            table.dataset.sortIndex = String(index);
            table.dataset.sortDir = nextDir;
            headers.forEach((header, headerIndex) => {
              const headerIndicator = header.querySelector(".sort-indicator");
              if (!headerIndicator) return;
              headerIndicator.textContent = headerIndex === index ? (nextDir === "asc" ? "↑" : "↓") : "";
            });
          });
        });
      }
      function randomSixDigitCode() {
        return String(Math.floor(100000 + Math.random() * 900000));
      }
      function prepareRfqGrid(formId, rowCount) {
        const form = document.getElementById(formId);
        if (!form) return true;
        const rowsMissingCode = [];
        const usedCodes = new Set();
        form.querySelectorAll('[name^="item_code_"]').forEach((input) => {
          const value = String(input.value || "").trim();
          if (value) usedCodes.add(value);
        });
        for (let index = 0; index < rowCount; index += 1) {
          const itemCodeInput = form.querySelector('[name="item_code_' + index + '"]');
          const descriptionInput = form.querySelector('[name="description_' + index + '"]');
          const qtyInput = form.querySelector('[name="qty_' + index + '"]');
          const materialTypeInput = form.querySelector('[name="material_type_' + index + '"]');
          const uomInput = form.querySelector('[name="uom_' + index + '"]');
          const hasRowData = [descriptionInput, qtyInput, materialTypeInput, uomInput]
            .some((input) => input && String(input.value || "").trim());
          if (itemCodeInput && !String(itemCodeInput.value || "").trim() && hasRowData) {
            rowsMissingCode.push(itemCodeInput);
          }
        }
        if (!rowsMissingCode.length) return true;
        if (!window.confirm("No Item Code Entered. Do you want me to create on for you?")) {
          return false;
        }
        rowsMissingCode.forEach((input) => {
          let nextCode = randomSixDigitCode();
          while (usedCodes.has(nextCode)) {
            nextCode = randomSixDigitCode();
          }
          usedCodes.add(nextCode);
          input.value = nextCode;
        });
        return true;
      }
      document.addEventListener("DOMContentLoaded", () => {
        attachPasswordValidation("new-user-form", "password", "new-user-password-error");
        document.querySelectorAll("form[data-password-form='edit-user']").forEach((form) => {
          attachPasswordValidation(form.id, "password", form.dataset.passwordMessageId);
        });
        document.querySelectorAll("form[data-password-form='access-approve']").forEach((form) => {
          attachPasswordValidation(form.id, "temp_password", form.dataset.passwordMessageId);
        });
        document.querySelectorAll(".card.scroll table").forEach((table) => makeTableSortable(table));
      });
    </script>
  </head>
  <body>
    <div class="shell">
      <div class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="${user ? "/dashboard" : "/"}">
            <img class="brand-logo" src="/public/prf-logo.png" alt="Performance Contractors logo" />
            <div class="brand-copy">
              <div class="brand">Material Control</div>
              ${user ? `<div class="userline">${esc(user.username)} | ${esc(user.role)}</div>` : ""}
            </div>
          </a>
        </div>
        ${user ? `<nav>${navLinks}</nav>` : ""}
      </div>
      ${body}
    </div>
  </body>
  </html>`;
}

function normalizeCategories(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return vendorCategories.filter((category) => values.includes(category)).join(",");
}

function normalizeCategoryList(text) {
  const seen = new Set();
  return String(text || "")
    .split(/\r?\n|,/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length === 11 && digits.startsWith("1")) {
    return `1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
  }
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function randomSixDigitItemCode(used = new Set()) {
  let nextCode = "";
  do {
    nextCode = String(Math.floor(100000 + Math.random() * 900000));
  } while (used.has(nextCode));
  used.add(nextCode);
  return nextCode;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function nextSortDir(currentSort, currentDir, column) {
  if (currentSort !== column) return "asc";
  return currentDir === "asc" ? "desc" : "asc";
}

function sortLabel(label, currentSort, currentDir, column) {
  if (currentSort !== column) return label;
  return `${label} ${currentDir === "asc" ? "↑" : "↓"}`;
}

async function syncLegacyVendorContact(client, vendorId) {
  const vendor = (await client.query("select contact_name, email, phone from vendors where id = $1", [vendorId])).rows[0];
  if (!vendor) return;
  const contactName = String(vendor.contact_name || "").trim();
  const email = normalizeEmail(vendor.email);
  const phone = normalizePhone(vendor.phone);
  if (!contactName && !email && !phone) return;
  const existing = (await client.query(`
    select id
    from vendor_contacts
    where vendor_id = $1
      and coalesce(contact_name, '') = $2
      and coalesce(email, '') = $3
      and coalesce(phone, '') = $4
  `, [vendorId, contactName, email, phone])).rows[0];
  if (existing) {
    await client.query("update vendor_contacts set is_primary = true where id = $1", [existing.id]);
    return;
  }
  await client.query(`
    insert into vendor_contacts (vendor_id, contact_name, email, phone, is_primary)
    values ($1, $2, $3, $4, true)
  `, [vendorId, contactName || "Primary Contact", email, phone]);
}

function parseUploadedRows(file, pastedText) {
  const normalizeHeader = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (file?.buffer?.length) {
    if ((file.originalname || "").toLowerCase().endsWith(".xlsx")) {
      const workbook = XLSX.read(file.buffer, { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), String(value ?? "").trim()])));
    }
    pastedText = file.buffer.toString("utf8");
  }
  if (!pastedText?.trim()) return [];
  const lines = pastedText.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((cell) => normalizeHeader(cell));
  return lines.filter((line) => line.trim()).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()]));
  });
}

function normalizePoImportRow(row) {
  const aliases = {
    po_no: ["po_no", "po_number", "po", "po_", "purchase_order", "purchase_order_number"],
    po_line: ["po_line", "po_line_no", "po_line_number", "line_no", "line_number", "line"],
    vendor_name: ["vendor_name", "vendor", "supplier", "supplier_name"],
    item_code: ["item_code", "item", "item_no", "item_number", "material_code", "material_item"],
    description: ["description", "item_description", "material_description", "desc"],
    material_type: ["material_type", "type", "item_type"],
    uom: ["uom", "unit", "unit_of_measure"],
    size_1: ["size_1", "size1", "primary_size"],
    size_2: ["size_2", "size2", "secondary_size"],
    thk_1: ["thk_1", "thk1", "thickness_1", "wall_1"],
    thk_2: ["thk_2", "thk2", "thickness_2", "wall_2"],
    qty_ordered: ["qty_ordered", "qty", "quantity", "ordered_qty", "order_qty"],
    unit_price: ["unit_price", "price", "unitcost", "unit_cost", "cost"],
    vendor_contact: ["vendor_contact", "contact_name", "contact"],
    freight_terms: ["freight_terms", "freight"],
    ship_to: ["ship_to", "shipto"],
    bill_to: ["bill_to", "billto"],
    po_description: ["po_description", "purchase_order_description", "project_name", "project"],
    notes: ["notes", "comments", "remarks"],
    buyer_name: ["buyer_name", "buyer", "purchased_by"],
    status: ["status", "po_status"]
  };
  const normalized = {};
  for (const [target, keys] of Object.entries(aliases)) {
    const sourceKey = keys.find((key) => row[key] !== undefined && String(row[key] || "").trim() !== "");
    normalized[target] = sourceKey ? String(row[sourceKey] || "").trim() : "";
  }
  const normalizedNames = normalizeWarehouseLocationValues(normalized.warehouse_name, normalized.location_name);
  normalized.warehouse_name = normalizedNames.warehouse;
  normalized.location_name = normalizedNames.location;
  return normalized;
}

function normalizeVendorFmrRequestLine(row) {
  const aliases = {
    po_number: ["po", "po_number"],
    vendor_name: ["supplier", "vendor", "vendor_name"],
    item_code: ["item_code", "item"],
    abbrev_description: ["abbrev_description", "description", "abbrev_desc"],
    po_line: ["line", "po_line"],
    sub_line: ["sub", "sub_line"],
    qty_ordered: ["ord", "ordered_qty", "qty_ordered"],
    qty_received: ["rcvd", "received_qty", "qty_received"],
    mrr_number: ["mrr_number"],
    issued_date: ["issued", "issued_date"],
    received_date: ["date_rcvd", "received_date"],
    srn_number: ["srn", "srn_number", "shipment_number", "shipment_no"]
  };
  const normalized = {};
  for (const [target, keys] of Object.entries(aliases)) {
    const sourceKey = keys.find((key) => row[key] !== undefined && String(row[key] ?? "").trim() !== "");
    const raw = sourceKey ? row[sourceKey] : "";
    if (target === "qty_ordered" || target === "qty_received") normalized[target] = parseQtyValue(raw);
    else normalized[target] = textValue(raw);
  }
  normalized.crate_number = textValue(row.crate_number || row.container_no || row.package_number || "");
  return normalized;
}

function parseVendorFmrRequestWorkbook(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) return [];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "", raw: false });
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeWorkbookHeader(key), value])))
    .map(normalizeVendorFmrRequestLine)
    .filter((row) => row.po_number && row.item_code && row.abbrev_description);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function quoteCell(unitPrice, leadDays) {
  return `$${Number(unitPrice).toFixed(2)} | ${num(leadDays)}d`;
}

function validatePasswordRules(password) {
  const value = String(password || "");
  if (value.length < 10) return "Password must be at least 10 characters.";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter.";
  if (!/[0-9]/.test(value)) return "Password must include at least one number.";
  return "";
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function landingPage() {
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PRF Material Control</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", Tahoma, Verdana, sans-serif; background: linear-gradient(180deg, #dfe3e8 0%, #c7d0da 100%); color: #16212b; }
      .hero { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .panel { width: min(760px, 100%); background: #fff; border: 1px solid #798693; padding: 24px; text-align: center; }
      .logo { max-width: 336px; width: 100%; height: auto; margin-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 34px; }
      p { margin: 0 0 20px; color: #4d5b69; }
      .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
      .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 150px; height: 40px; padding: 0 14px; text-decoration: none; font-weight: 700; border: 1px solid rgba(0,0,0,.15); }
      .btn-primary { background: linear-gradient(180deg, #4278a9 0%, #2d5d87 100%); color: #fff; }
      .btn-secondary { background: linear-gradient(180deg, #6a7681 0%, #4b5966 100%); color: #fff; }
    </style>
  </head>
  <body>
    <div class="hero">
      <div class="panel">
        <img class="logo" src="/public/prf-logo.png" alt="PRF Logo" />
        <h1>Material Control</h1>
        <p>Procurement, receiving, inventory, and field issue tracking for Performance Contractors.</p>
        <div class="actions">
          <a class="btn btn-primary" href="/login">Sign In</a>
          <a class="btn btn-secondary" href="/request-access">Request Access</a>
        </div>
      </div>
    </div>
  </body>
  </html>`;
}

function requestAccessPage(error = "", success = "") {
  return layout("Request Access", `
    ${error ? `<div class="card error"><strong>${esc(error)}</strong></div>` : ""}
    ${success ? `<div class="card"><strong>${esc(success)}</strong></div>` : ""}
    <div class="card">
      <h2>Request Access</h2>
      <p class="muted">Enter your email address and an administrator will review the request, assign a username, and create a temporary password.</p>
      <form method="post" action="/request-access" class="stack">
        <div class="grid">
          <div><label>Email Address</label><input type="email" name="email" required /></div>
        </div>
        <div class="actions"><button type="submit">Submit Request</button><a class="btn btn-secondary" href="/">Back</a></div>
      </form>
    </div>
  `, null);
}

const rfqItemColumns = ["po_line", "item_code", "description", "material_type", "uom", "spec", "commodity_code", "tag_number", "size_1", "size_2", "thk_1", "thk_2", "qty", "notes"];

function parseDelimitedRows(text, columns = rfqItemColumns) {
  if (!text?.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length === 0) return [];
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const splitLine = (line) => line.split(delimiter).map((cell) => String(cell ?? "").trim());
  const firstRow = splitLine(lines[0]);
  const normalizedFirstRow = firstRow.map((cell) => String(cell ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
  const hasHeaders = normalizedFirstRow.some((cell) => columns.includes(cell));
  const headers = hasHeaders ? normalizedFirstRow : columns;
  const dataLines = hasHeaders ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const values = splitLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()]));
  });
}

async function upsertMaterialItem(client, row) {
  const itemCode = String(row.item_code || "").trim();
  const description = String(row.description || "").trim();
  const materialType = String(row.material_type || "").trim();
  const uom = String(row.uom || "").trim();
  if (!itemCode) throw new Error("Item code is required.");
  const existing = await client.query("select id, description, material_type, uom from material_items where item_code = $1", [itemCode]);
  if (existing.rows[0]) {
    const current = existing.rows[0];
    await client.query(
      "update material_items set description = $2, material_type = $3, uom = $4 where id = $1",
      [current.id, description || current.description, materialType || current.material_type, uom || current.uom]
    );
    return current.id;
  }
  const insert = await client.query(
    "insert into material_items (item_code, description, material_type, uom) values ($1, $2, $3, $4) returning id",
    [itemCode, description || itemCode, materialType || "misc", uom || "EA"]
  );
  return insert.rows[0].id;
}

async function findOrCreateVendorByName(client, vendorName) {
  const normalized = String(vendorName || "").trim();
  if (!normalized) throw new Error("Vendor name is required.");
  const existing = (await client.query("select id from vendors where lower(name) = lower($1) limit 1", [normalized])).rows[0];
  if (existing) {
    await client.query("update vendors set is_active = true where id = $1", [existing.id]);
    return existing.id;
  }
  const insert = await client.query(`
    insert into vendors (name, contact_name, website, email, phone, categories, is_active)
    values ($1, '', '', '', '', '', true)
    returning id
  `, [normalized]);
  return insert.rows[0].id;
}

async function upsertRfqItemRow(client, rfqId, row) {
  const itemCode = String(row.item_code || "").trim();
  const poLine = String(row.po_line || row.line_no || row.line || "").trim();
  const qty = parseQtyValue(row.qty);
  if (!itemCode) return { status: "skipped", errorCode: "missing_item_code", message: "Item code is required." };
  if (qty <= 0) return { status: "skipped", errorCode: "invalid_qty", message: "Qty must be greater than zero." };
  const materialItemId = await upsertMaterialItem(client, row);
  const existingItem = await client.query(`
    select id
    from rfq_items
    where rfq_id = $1 and material_item_id = $2
      and coalesce(size_1, '') = $3 and coalesce(size_2, '') = $4
      and coalesce(thk_1, '') = $5 and coalesce(thk_2, '') = $6
  `, [rfqId, materialItemId, row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || ""]);
  if (existingItem.rows[0]) {
    await client.query(`
      update rfq_items
      set po_line = $2, spec = $3, commodity_code = $4, tag_number = $5, qty = $6, notes = $7, updated_at = now()
      where id = $1
    `, [existingItem.rows[0].id, poLine, row.spec || "", row.commodity_code || "", row.tag_number || "", qty, row.notes || ""]);
    return { status: "updated" };
  }
  await client.query(`
    insert into rfq_items (rfq_id, material_item_id, po_line, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
  `, [rfqId, materialItemId, poLine, row.spec || "", row.commodity_code || "", row.tag_number || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qty, row.notes || ""]);
  return { status: "inserted" };
}

async function upsertPurchaseOrderRow(client, row) {
  const poNo = String(row.po_no || row.po_number || "").trim();
  const vendorName = String(row.vendor_name || row.vendor || "").trim();
  const itemCode = String(row.item_code || "").trim();
  const qtyOrdered = parseQtyValue(row.qty_ordered || row.qty || row.quantity);
  const unitPrice = num(row.unit_price || row.price || row.unitcost || row.unit_cost);
  const poLine = String(row.po_line || row.line_no || row.line || "").trim();
  if (!poNo) return { status: "skipped", errorCode: "missing_po_no", message: "PO number is required." };
  if (!vendorName) return { status: "skipped", errorCode: "missing_vendor", message: "Vendor name is required." };
  if (!itemCode) return { status: "skipped", errorCode: "missing_item_code", message: "Item code is required." };
  if (qtyOrdered <= 0) return { status: "skipped", errorCode: "invalid_qty", message: "Qty ordered must be greater than zero." };
  if (unitPrice < 0) return { status: "skipped", errorCode: "invalid_unit_price", message: "Unit price cannot be negative." };

  const vendorId = await findOrCreateVendorByName(client, vendorName);
  const materialItemId = await upsertMaterialItem(client, {
    item_code: itemCode,
    description: row.description || row.item_description || itemCode,
    material_type: row.material_type || row.type || "misc",
    uom: row.uom || row.unit || "EA"
  });

  const poRow = (await client.query("select id from purchase_orders where po_no = $1", [poNo])).rows[0];
  let poId;
  let headerStatus = "updated";
  if (poRow) {
    poId = poRow.id;
    await client.query(`
      update purchase_orders
      set vendor_id = $2,
          vendor_contact = $3,
          freight_terms = $4,
          ship_to = $5,
          bill_to = $6,
          description = $7,
          notes = $8,
          buyer_name = $9,
          status = $10,
          updated_at = now()
      where id = $1
    `, [
      poId,
      vendorId,
      String(row.vendor_contact || row.contact_name || "").trim(),
      String(row.freight_terms || "").trim(),
      String(row.ship_to || "").trim(),
      String(row.bill_to || "").trim(),
      String(row.po_description || "").trim(),
      String(row.notes || "").trim(),
      String(row.buyer_name || row.buyer || "").trim(),
      String(row.status || "OPEN").trim() || "OPEN"
    ]);
  } else {
    const insertPo = await client.query(`
      insert into purchase_orders (po_no, vendor_id, rfq_id, vendor_contact, freight_terms, ship_to, bill_to, description, notes, buyer_name, status, updated_at)
      values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, now())
      returning id
    `, [
      poNo,
      vendorId,
      String(row.vendor_contact || row.contact_name || "").trim(),
      String(row.freight_terms || "").trim(),
      String(row.ship_to || "").trim(),
      String(row.bill_to || "").trim(),
      String(row.po_description || "").trim(),
      String(row.notes || "").trim(),
      String(row.buyer_name || row.buyer || "").trim(),
      String(row.status || "OPEN").trim() || "OPEN"
    ]);
    poId = insertPo.rows[0].id;
    headerStatus = "inserted";
  }

  const size1 = String(row.size_1 || "").trim();
  const size2 = String(row.size_2 || "").trim();
  const thk1 = String(row.thk_1 || "").trim();
  const thk2 = String(row.thk_2 || "").trim();
  const existingLine = (await client.query(`
    select id
    from po_lines
    where po_id = $1 and material_item_id = $2
      and coalesce(size_1, '') = $3 and coalesce(size_2, '') = $4
      and coalesce(thk_1, '') = $5 and coalesce(thk_2, '') = $6
    limit 1
  `, [poId, materialItemId, size1, size2, thk1, thk2])).rows[0];
  if (existingLine) {
    await client.query(`
      update po_lines
      set po_line = $2, qty_ordered = $3, unit_price = $4, size_1 = $5, size_2 = $6, thk_1 = $7, thk_2 = $8, updated_at = now()
      where id = $1
    `, [existingLine.id, poLine, qtyOrdered, unitPrice, size1, size2, thk1, thk2]);
    return { status: headerStatus === "inserted" ? "inserted" : "updated" };
  }

  await client.query(`
    insert into po_lines (po_id, rfq_item_id, material_item_id, po_line, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, updated_at)
    values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, now())
  `, [poId, materialItemId, poLine, size1, size2, thk1, thk2, qtyOrdered, unitPrice]);
  return { status: "inserted" };
}

async function writeQuoteRevision(client, { rfqItemId, vendorId, unitPrice, leadDays, sourceType, sourceBatchId = null, createdBy = null }) {
  await client.query(`
    insert into quote_revisions (rfq_item_id, vendor_id, unit_price, lead_days, source_type, source_batch_id, created_by)
    values ($1, $2, $3, $4, $5, $6, $7)
  `, [rfqItemId, vendorId, unitPrice, leadDays, sourceType, sourceBatchId, createdBy]);
}

async function createImportBatch(client, { entityType, rfqId, uploadedBy, filename }) {
  const result = await client.query(`
    insert into import_batches (entity_type, rfq_id, uploaded_by, filename, status)
    values ($1, $2, $3, $4, 'COMPLETED')
    returning id
  `, [entityType, rfqId, uploadedBy || null, filename || ""]);
  return result.rows[0].id;
}

async function updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount, status = "COMPLETED" }) {
  await client.query(`
    update import_batches
    set inserted_count = $2, updated_count = $3, skipped_count = $4, status = $5
    where id = $1
  `, [batchId, insertedCount, updatedCount, skippedCount, status]);
}

async function addImportBatchError(client, batchId, rowNumber, errorCode, message, rawPayload) {
  await client.query(`
    insert into import_batch_errors (batch_id, row_number, error_code, message, raw_payload)
    values ($1, $2, $3, $4, $5::jsonb)
  `, [batchId, rowNumber, errorCode, message, JSON.stringify(rawPayload || {})]);
}

function normalizeWorkbookHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\r?\n/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function numberValue(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function workbookRowsFromSheet(workbook, sheetName, headerRowIndex) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerRow = matrix[headerRowIndex] || [];
  const headers = headerRow.map(normalizeWorkbookHeader);
  const rows = [];
  for (let index = headerRowIndex + 1; index < matrix.length; index += 1) {
    const rawRow = matrix[index] || [];
    const row = {};
    let hasValue = false;
    headers.forEach((header, colIndex) => {
      if (!header) return;
      const cell = rawRow[colIndex];
      if (cell !== "" && cell !== null && cell !== undefined) hasValue = true;
      row[header] = cell;
    });
    if (hasValue) rows.push(row);
  }
  return rows;
}

function importRowsFromWorkbook(fileBuffer, logType) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  if (logType === "receiving") {
    return workbookRowsFromSheet(workbook, workbook.SheetNames.includes("Table_Receiving") ? "Table_Receiving" : "Material Receiving", workbook.SheetNames.includes("Table_Receiving") ? 0 : 1);
  }
  if (logType === "mrr") {
    return workbookRowsFromSheet(workbook, workbook.SheetNames.includes("MRR_Log_Table") ? "MRR_Log_Table" : "MRR Log", workbook.SheetNames.includes("MRR_Log_Table") ? 0 : 1);
  }
  if (logType === "fmr") {
    return workbookRowsFromSheet(workbook, "FMR Log", 4);
  }
  throw new Error("Unsupported log type.");
}

function formatTimestamp(value) {
  return textValue(value).replace("T", " ").replace("Z", "");
}

function normalizeWarehouseName(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  return text.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function normalizeLocationName(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeWarehouseLocationValues(warehouseName, locationName) {
  return {
    warehouse: normalizeWarehouseName(warehouseName),
    location: normalizeLocationName(locationName)
  };
}

async function saveMaterialLogLookup(client, kind, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  await client.query(`
    insert into material_log_lookup_values (kind, value)
    values ($1, $2)
    on conflict (kind, value) do nothing
  `, [kind, normalized]);
}

async function getMaterialLogLookupOptions(kind) {
  const result = await query(`
    select value
    from (
      select value from material_log_lookup_values where kind = $1
      union
      select name as value from vendors where $1 = 'vendor_name' and coalesce(name, '') <> ''
      union
      select po_no as value from purchase_orders where $1 = 'po_number' and coalesce(po_no, '') <> ''
      union
      select discipline as value from mrr_logs where $1 = 'discipline' and coalesce(discipline, '') <> ''
      union
      select discipline as value from material_receiving_logs where $1 = 'discipline' and coalesce(discipline, '') <> ''
      union
      select received_by as value from mrr_logs where $1 = 'received_by' and coalesce(received_by, '') <> ''
      union
      select received_by as value from material_receiving_logs where $1 = 'received_by' and coalesce(received_by, '') <> ''
      union
      select vendor_name as value from mrr_logs where $1 = 'vendor_name' and coalesce(vendor_name, '') <> ''
    ) options
    where coalesce(value, '') <> ''
    order by value
  `, [kind]);
  return result.rows.map((row) => row.value);
}

async function getAppPurchaseOrderOptions() {
  const result = await query(`
    select po.id, po.po_no, coalesce(po.description, '') as description, coalesce(v.name, '') as vendor_name
    from purchase_orders po
    left join vendors v on v.id = po.vendor_id
    where coalesce(po.po_no, '') <> ''
    order by po.id desc
  `);
  return result.rows;
}

async function getWarehouseOptions() {
  const result = await query(`
    select id, name
    from warehouses
    where is_active = true
    order by name
  `);
  const seen = new Set();
  return result.rows
    .map((row) => ({ ...row, name: normalizeWarehouseName(row.name) }))
    .filter((row) => {
      const key = row.name.toLowerCase();
      if (!row.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getWarehouseLocationOptions() {
  const result = await query(`
    select wl.id, wl.name, wl.warehouse_id, w.name as warehouse_name
    from warehouse_locations wl
    join warehouses w on w.id = wl.warehouse_id
    where wl.is_active = true and w.is_active = true
    order by w.name, wl.name
  `);
  const seen = new Set();
  return result.rows
    .map((row) => {
      const normalizedNames = normalizeWarehouseLocationValues(row.warehouse_name, row.name);
      return {
        ...row,
        warehouse_name: normalizedNames.warehouse,
        name: normalizedNames.location
      };
    })
    .filter((row) => {
      const key = `${row.warehouse_name.toLowerCase()}|${row.name.toLowerCase()}`;
      if (!row.warehouse_name || !row.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getWarehouseLocationMap() {
  const rows = await getWarehouseLocationOptions();
  const map = {};
  for (const row of rows) {
    if (!map[row.warehouse_name]) map[row.warehouse_name] = [];
    map[row.warehouse_name].push(row.name);
  }
  return map;
}

function getInventoryByLocationSubquery() {
  return `
    select
      coalesce(receipt_inventory.item_code, adjustment_inventory.item_code) as item_code,
      coalesce(receipt_inventory.description, adjustment_inventory.description) as description,
      coalesce(receipt_inventory.size_1, adjustment_inventory.size_1) as size_1,
      coalesce(receipt_inventory.size_2, adjustment_inventory.size_2) as size_2,
      coalesce(receipt_inventory.thk_1, adjustment_inventory.thk_1) as thk_1,
      coalesce(receipt_inventory.thk_2, adjustment_inventory.thk_2) as thk_2,
      coalesce(receipt_inventory.warehouse, adjustment_inventory.warehouse) as warehouse,
      coalesce(receipt_inventory.location, adjustment_inventory.location) as location,
      coalesce(receipt_inventory.qty_on_hand, 0) + coalesce(adjustment_inventory.qty_adjustment, 0) as qty_on_hand,
      coalesce(receipt_inventory.qty_osd, 0) as qty_osd
    from (
      select
        mi.item_code,
        mi.description,
        coalesce(pl.size_1, '') as size_1,
        coalesce(pl.size_2, '') as size_2,
        coalesce(pl.thk_1, '') as thk_1,
        coalesce(pl.thk_2, '') as thk_2,
        initcap(lower(coalesce(r.warehouse, ''))) as warehouse,
        upper(coalesce(r.location, '')) as location,
        sum(case when coalesce(r.osd_status, 'OK') = 'OK' then r.qty_received else 0 end) as qty_on_hand,
        sum(case when coalesce(r.osd_status, 'OK') = 'OK' then 0 else r.qty_received end) as qty_osd
      from receipts r
      join po_lines pl on pl.id = r.po_line_id
      join material_items mi on mi.id = pl.material_item_id
      group by
        mi.item_code,
        mi.description,
        coalesce(pl.size_1, ''),
        coalesce(pl.size_2, ''),
        coalesce(pl.thk_1, ''),
        coalesce(pl.thk_2, ''),
        initcap(lower(coalesce(r.warehouse, ''))),
        upper(coalesce(r.location, ''))
    ) receipt_inventory
    full outer join (
      select
        item_code,
        description,
        coalesce(size_1, '') as size_1,
        coalesce(size_2, '') as size_2,
        coalesce(thk_1, '') as thk_1,
        coalesce(thk_2, '') as thk_2,
        initcap(lower(coalesce(warehouse, ''))) as warehouse,
        upper(coalesce(location, '')) as location,
        sum(qty_adjustment) as qty_adjustment
      from inventory_adjustment_lines
      group by
        item_code,
        description,
        coalesce(size_1, ''),
        coalesce(size_2, ''),
        coalesce(thk_1, ''),
        coalesce(thk_2, ''),
        initcap(lower(coalesce(warehouse, ''))),
        upper(coalesce(location, ''))
    ) adjustment_inventory
      on adjustment_inventory.item_code = receipt_inventory.item_code
     and adjustment_inventory.size_1 = receipt_inventory.size_1
     and adjustment_inventory.size_2 = receipt_inventory.size_2
     and adjustment_inventory.thk_1 = receipt_inventory.thk_1
     and adjustment_inventory.thk_2 = receipt_inventory.thk_2
     and adjustment_inventory.warehouse = receipt_inventory.warehouse
     and adjustment_inventory.location = receipt_inventory.location
  `;
}

function getInventoryTotalsSubquery() {
  return `
    select
      item_code,
      coalesce(size_1, '') as size_1,
      coalesce(size_2, '') as size_2,
      coalesce(thk_1, '') as thk_1,
      coalesce(thk_2, '') as thk_2,
      sum(qty_on_hand) as qty_on_hand
    from (${getInventoryByLocationSubquery()}) inventory_by_location
      group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
  `;
}

function buildInventoryIssueKey(parts) {
  return JSON.stringify({
    item_code: normalizeInventoryKeyPart(parts.item_code),
    size_1: normalizeInventoryKeyPart(parts.size_1),
    size_2: normalizeInventoryKeyPart(parts.size_2),
    thk_1: normalizeInventoryKeyPart(parts.thk_1),
    thk_2: normalizeInventoryKeyPart(parts.thk_2)
  });
}

async function getIssuedInventoryTotals(runner = { query }) {
  return (await runner.query(`
    select
      bl.item_code,
      coalesce(bl.size_1, '') as size_1,
      coalesce(bl.size_2, '') as size_2,
      coalesce(bl.thk_1, '') as thk_1,
      coalesce(bl.thk_2, '') as thk_2,
      sum(mrl.qty_issued) as qty_issued_total
    from material_requisition_lines mrl
    join bom_lines bl on bl.id = mrl.bom_line_id
    where coalesce(mrl.qty_issued, 0) > 0
    group by
      bl.item_code,
      coalesce(bl.size_1, ''),
      coalesce(bl.size_2, ''),
      coalesce(bl.thk_1, ''),
      coalesce(bl.thk_2, '')
  `)).rows;
}

function applyIssuedInventoryToRows(rows, issuedRows = []) {
  const issuedMap = new Map(
    issuedRows.map((row) => [buildInventoryIssueKey(row), parseQtyValue(row.qty_issued_total || 0)])
  );
  const clonedRows = rows.map((row) => ({
    ...row,
    qty_on_hand: parseQtyValue(row.qty_on_hand || 0),
    qty_osd: parseQtyValue(row.qty_osd || 0)
  }));
  const groupedRows = new Map();
  for (const row of clonedRows) {
    const key = buildInventoryIssueKey(row);
    if (!groupedRows.has(key)) groupedRows.set(key, []);
    groupedRows.get(key).push(row);
  }
  for (const [key, group] of groupedRows.entries()) {
    let issuedRemaining = parseQtyValue(issuedMap.get(key) || 0);
    group.sort((a, b) => (
      String(a.warehouse || "").localeCompare(String(b.warehouse || ""), undefined, { numeric: true, sensitivity: "base" })
      || String(a.location || "").localeCompare(String(b.location || ""), undefined, { numeric: true, sensitivity: "base" })
      || String(a.item_code || "").localeCompare(String(b.item_code || ""), undefined, { numeric: true, sensitivity: "base" })
    ));
    for (const row of group) {
      if (issuedRemaining <= 0) break;
      const availableQty = Math.max(parseQtyValue(row.qty_on_hand || 0), 0);
      const consumed = Math.min(availableQty, issuedRemaining);
      row.qty_on_hand = parseQtyValue(parseQtyValue(row.qty_on_hand || 0) - consumed, 0);
      issuedRemaining = parseQtyValue(issuedRemaining - consumed, 0);
    }
  }
  return clonedRows;
}

async function getCurrentOnHandRows(runner = { query }, { whereSql = "", params = [], orderSql = "inventory_by_location.item_code, inventory_by_location.warehouse, inventory_by_location.location" } = {}) {
  const baseRows = (await runner.query(`
    select inventory_by_location.*
    from (${getInventoryByLocationSubquery()}) inventory_by_location
    ${whereSql}
    order by ${orderSql}
  `, params)).rows;
  const issuedRows = await getIssuedInventoryTotals(runner);
  return applyIssuedInventoryToRows(baseRows, issuedRows);
}

function normalizeWarehouseLocationImportRow(row) {
  const normalized = {};
  const aliases = {
    warehouse_id: ["warehouse_id", "warehouseid"],
    warehouse_name: ["warehouse_name", "warehouse", "warehouse_code"],
    location_id: ["location_id", "locationid"],
    location_name: ["location_name", "location", "bin", "slot"],
    is_active: ["is_active", "active", "status"]
  };
  for (const [target, keys] of Object.entries(aliases)) {
    const sourceKey = keys.find((key) => row[key] !== undefined && String(row[key] || "").trim() !== "");
    normalized[target] = sourceKey ? String(row[sourceKey] || "").trim() : "";
  }
  return normalized;
}

function normalizeInventoryTrueUpRow(row) {
  const aliases = {
    item_code: ["ident_code", "item_code", "item", "ident"],
    description: ["description", "column1"],
    size_1: ["size_1", "size1"],
    size_2: ["size_2", "size2"],
    thk_1: ["thk_1", "thk1"],
    thk_2: ["thk_2", "thk2"],
    actual_qty: ["in_stock", "instock", "qty_on_hand", "actual_qty", "quantity"],
    warehouse: ["warehouse"],
    location: ["location"]
  };
  const normalized = {};
  for (const [target, keys] of Object.entries(aliases)) {
    const sourceKey = target === "actual_qty"
      ? keys.find((key) => row[key] !== undefined)
      : keys.find((key) => row[key] !== undefined && String(row[key] ?? "").trim() !== "");
    normalized[target] = sourceKey ? row[sourceKey] : "";
  }
  const rawActualQty = normalized.actual_qty;
  const actualQty = String(rawActualQty ?? "").trim() === ""
    ? 0
    : parseQtyValue(rawActualQty, NaN);
  return {
    item_code: textValue(normalized.item_code),
    description: textValue(normalized.description),
    size_1: textValue(normalized.size_1),
    size_2: textValue(normalized.size_2),
    thk_1: textValue(normalized.thk_1),
    thk_2: textValue(normalized.thk_2),
    warehouse: normalizeWarehouseName(normalized.warehouse),
    location: normalizeLocationName(normalized.location),
    actual_qty: actualQty
  };
}

function importInventoryTrueUpRows(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  for (const sheetName of workbook.SheetNames) {
    const rows = workbookRowsFromSheet(workbook, sheetName, 0);
    if (rows.length === 0) continue;
    const sample = rows[0] || {};
    const headers = new Set(Object.keys(sample));
    if (!headers.has("warehouse") || !headers.has("location")) continue;
    if (!(headers.has("in_stock") || headers.has("instock") || headers.has("qty_on_hand") || headers.has("actual_qty"))) continue;
    if (!(headers.has("ident_code") || headers.has("item_code") || headers.has("ident"))) continue;
    return rows.map(normalizeInventoryTrueUpRow);
  }
  throw new Error("Could not find an inventory sheet with item, warehouse, location, and in-stock columns.");
}

function normalizeInventoryKeyPart(value) {
  return String(value || "").trim();
}

function buildInventoryEntryKey(parts) {
  return JSON.stringify({
    item_code: normalizeInventoryKeyPart(parts.item_code),
    size_1: normalizeInventoryKeyPart(parts.size_1),
    size_2: normalizeInventoryKeyPart(parts.size_2),
    thk_1: normalizeInventoryKeyPart(parts.thk_1),
    thk_2: normalizeInventoryKeyPart(parts.thk_2),
    warehouse: normalizeInventoryKeyPart(parts.warehouse),
    location: normalizeInventoryKeyPart(parts.location)
  });
}

function setDesiredInventoryRow(targetMap, row, actualQty) {
  const normalized = {
    item_code: normalizeInventoryKeyPart(row.item_code),
    description: String(row.description || "").trim(),
    size_1: normalizeInventoryKeyPart(row.size_1),
    size_2: normalizeInventoryKeyPart(row.size_2),
    thk_1: normalizeInventoryKeyPart(row.thk_1),
    thk_2: normalizeInventoryKeyPart(row.thk_2),
    warehouse: normalizeInventoryKeyPart(row.warehouse),
    location: normalizeInventoryKeyPart(row.location),
    actual_qty: parseQtyValue(actualQty, 0)
  };
  targetMap.set(buildInventoryEntryKey(normalized), normalized);
}

function addDesiredInventoryRow(targetMap, row, actualQty) {
  const normalized = {
    item_code: normalizeInventoryKeyPart(row.item_code),
    description: String(row.description || "").trim(),
    size_1: normalizeInventoryKeyPart(row.size_1),
    size_2: normalizeInventoryKeyPart(row.size_2),
    thk_1: normalizeInventoryKeyPart(row.thk_1),
    thk_2: normalizeInventoryKeyPart(row.thk_2),
    warehouse: normalizeInventoryKeyPart(row.warehouse),
    location: normalizeInventoryKeyPart(row.location)
  };
  const key = buildInventoryEntryKey(normalized);
  const current = targetMap.get(key);
  const nextQty = parseQtyValue((current?.actual_qty || 0) + actualQty, 0);
  targetMap.set(key, {
    ...normalized,
    description: normalized.description || current?.description || "",
    actual_qty: nextQty
  });
}

function parseImportActiveFlag(value, fallback = true) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "yes", "y", "1", "active"].includes(text)) return true;
  if (["false", "no", "n", "0", "inactive"].includes(text)) return false;
  return fallback;
}

async function assertValidWarehouseLocation(client, warehouseName, locationName) {
  const normalizedNames = normalizeWarehouseLocationValues(warehouseName, locationName);
  const warehouse = normalizedNames.warehouse;
  const location = normalizedNames.location;
  if (!warehouse) throw new Error("Warehouse is required.");
  if (!location) throw new Error("Location is required.");
  const match = (await client.query(`
    select wl.id
    from warehouse_locations wl
    join warehouses w on w.id = wl.warehouse_id
    where w.is_active = true
      and wl.is_active = true
      and lower(w.name) = lower($1)
      and lower(wl.name) = lower($2)
    limit 1
  `, [warehouse, location])).rows[0];
  if (!match) throw new Error("Select a valid location for the chosen warehouse.");
}

async function ensureWarehouseLocationExists(client, warehouseName, locationName) {
  const normalizedNames = normalizeWarehouseLocationValues(warehouseName, locationName);
  const warehouse = normalizedNames.warehouse;
  const location = normalizedNames.location;
  if (!warehouse || !location) return;
  let warehouseRow = (await client.query(`
    select id
    from warehouses
    where lower(name) = lower($1)
    limit 1
  `, [warehouse])).rows[0];
  if (!warehouseRow) {
    warehouseRow = (await client.query(`
      insert into warehouses (name, is_active)
      values ($1, true)
      returning id
    `, [warehouse])).rows[0];
  } else {
    await client.query("update warehouses set is_active = true where id = $1", [warehouseRow.id]);
  }
  const locationRow = (await client.query(`
    select wl.id
    from warehouse_locations wl
    where wl.warehouse_id = $1
      and lower(wl.name) = lower($2)
    limit 1
  `, [warehouseRow.id, location])).rows[0];
  if (!locationRow) {
    await client.query(`
      insert into warehouse_locations (warehouse_id, name, is_active)
      values ($1, $2, true)
    `, [warehouseRow.id, location]);
  } else {
    await client.query("update warehouse_locations set is_active = true where id = $1", [locationRow.id]);
  }
}

async function getNextMrrNumber(client = null) {
  const runner = client || { query };
  const latest = (await runner.query(`
    select mrr_number
    from mrr_logs
    where coalesce(mrr_number, '') <> '' and mrr_number ~ '\\d+$'
    order by ((regexp_match(mrr_number, '(\\d+)$'))[1])::bigint desc, id desc
    limit 1
  `)).rows[0];
  const current = String(latest?.mrr_number || "").trim();
  if (!current) return "MRR-000001";
  const match = current.match(/^(.*?)(\d+)$/);
  if (!match) return "MRR-000001";
  const prefix = match[1];
  const nextValue = String(Number(match[2]) + 1).padStart(match[2].length, "0");
  return `${prefix}${nextValue}`;
}

async function getNextFmrNumber(client = null) {
  const runner = client || { query };
  const latest = (await runner.query(`
    select fmr_number
    from fmr_logs
    where coalesce(fmr_number, '') <> '' and fmr_number ~ '\\d+$'
    order by ((regexp_match(fmr_number, '(\\d+)$'))[1])::bigint desc, id desc
    limit 1
  `)).rows[0];
  const current = String(latest?.fmr_number || "").trim();
  if (!current) return "FMR-000001";
  const match = current.match(/^(.*?)(\d+)$/);
  if (!match) return "FMR-000001";
  const prefix = match[1];
  const nextValue = String(Number(match[2]) + 1).padStart(match[2].length, "0");
  return `${prefix}${nextValue}`;
}

async function getNextOpiNumber(client = null) {
  const runner = client || { query };
  const latest = (await runner.query(`
    select opi_number
    from mrr_logs
    where coalesce(opi_number, '') <> '' and opi_number ~ '\\d+$'
    order by ((regexp_match(opi_number, '(\\d+)$'))[1])::bigint desc, id desc
    limit 1
  `)).rows[0];
  const current = String(latest?.opi_number || "").trim();
  if (!current) return "OPI-000001";
  const match = current.match(/^(.*?)(\d+)$/);
  if (!match) return "OPI-000001";
  const prefix = match[1];
  const nextValue = String(Number(match[2]) + 1).padStart(match[2].length, "0");
  return `${prefix}${nextValue}`;
}

async function getLatestMrrForPo(client, poId) {
  if (!poId) return null;
  return (await client.query(`
    select id, mrr_number
    from mrr_logs
    where app_po_id = $1
    order by id desc
    limit 1
  `, [poId])).rows[0] || null;
}

async function getPoNumberForVendorCrate(client, vendorName, containerNo) {
  const vendor = String(vendorName || "").trim();
  const crate = String(containerNo || "").trim();
  if (!vendor || !crate) return "";
  const row = (await client.query(`
    select trim(coalesce(po_number, '')) as po_number
    from vendor_fmr_request_lines
    where lower(trim(coalesce(vendor_name, ''))) = lower($1)
      and lower(trim(coalesce(crate_number, ''))) = lower($2)
      and trim(coalesce(po_number, '')) <> ''
    order by id
    limit 1
  `, [vendor, crate])).rows[0];
  return String(row?.po_number || "").trim();
}

async function ensureMrrForVendorCrate(client, { userId = null, fmrId = null, vendorName = "", containerNo = "", mrrNumber = "", poNumber = "" } = {}) {
  const vendor = String(vendorName || "").trim();
  const crate = String(containerNo || "").trim();
  if (!vendor || !crate) {
    return { mrrNumber: String(mrrNumber || "").trim(), opiNumber: "", poNumber: String(poNumber || "").trim(), created: false };
  }
  const description = `${vendor} pkg: ${crate}`;
  const effectivePoNumber = String(poNumber || "").trim() || await getPoNumberForVendorCrate(client, vendor, crate);
  const linkedPo = effectivePoNumber
    ? (await client.query("select id, po_no from purchase_orders where po_no = $1 order by id desc limit 1", [effectivePoNumber])).rows[0]
    : null;
  const saveLinkedFmr = async (resolvedMrrNumber) => {
    if (!fmrId) return;
    await client.query(`
      update fmr_logs
      set mrr_number = $2,
          updated_at = now()
      where id = $1
    `, [fmrId, resolvedMrrNumber]);
  };
  const syncExistingMrr = async (row) => {
    let resolvedOpiNumber = String(row.opi_number || "").trim();
    const updates = [];
    const params = [row.id];
    if (!String(row.po_number || "").trim() && effectivePoNumber) {
      params.push(effectivePoNumber);
      updates.push(`po_number = $${params.length}`);
    }
    if (!row.app_po_id && linkedPo?.id) {
      params.push(linkedPo.id);
      updates.push(`app_po_id = $${params.length}`);
    }
    if (!resolvedOpiNumber) {
      resolvedOpiNumber = await getNextOpiNumber(client);
      params.push(resolvedOpiNumber);
      updates.push(`opi_number = $${params.length}`);
    }
    if (updates.length > 0) {
      await client.query(`
        update mrr_logs
        set ${updates.join(", ")}, updated_at = now()
        where id = $1
      `, params);
      await syncOpiLogsFromMrr(client);
    }
    await saveLinkedFmr(row.mrr_number);
    return { mrrNumber: row.mrr_number, opiNumber: resolvedOpiNumber, poNumber: effectivePoNumber, created: false };
  };
  const requestedMrrNumber = String(mrrNumber || "").trim();
  if (requestedMrrNumber) {
    const exactMatch = (await client.query(`
      select id, mrr_number, opi_number, po_number, app_po_id
      from mrr_logs
      where mrr_number = $1
        and lower(trim(coalesce(vendor_name, ''))) = lower($2)
        and lower(trim(coalesce(material_description, ''))) = lower($3)
      limit 1
    `, [requestedMrrNumber, vendor, description])).rows[0];
    if (exactMatch) {
      return syncExistingMrr(exactMatch);
    }
  }
  const existing = (await client.query(`
    select id, mrr_number, opi_number, po_number, app_po_id
    from mrr_logs
    where lower(trim(coalesce(vendor_name, ''))) = lower($1)
      and lower(trim(coalesce(material_description, ''))) = lower($2)
    order by id desc
    limit 1
  `, [vendor, description])).rows[0];
  if (existing) {
    return syncExistingMrr(existing);
  }
  const nextMrrNumber = await getNextMrrNumber(client);
  const nextOpiNumber = await getNextOpiNumber(client);
  const insert = (await client.query(`
    insert into mrr_logs (
      discipline, mrr_number, vendor_name, app_po_id, po_number, pick_ticket, material_description,
      received_date, received_by, notes, load_number, opi_number, opi_date, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
    returning id
  `, [
    "",
    nextMrrNumber,
    vendor,
    linkedPo?.id || null,
    effectivePoNumber,
    "",
    description,
    "",
    "",
    "",
    "",
    nextOpiNumber,
    ""
  ])).rows[0];
  await saveMaterialLogLookup(client, "vendor_name", vendor);
  await saveMaterialLogLookup(client, "po_number", effectivePoNumber);
  await syncMrrVendorsIntoVendorTable(client);
  await syncOpiLogsFromMrr(client);
  await saveLinkedFmr(nextMrrNumber);
  if (userId) {
    await auditLog(client, userId, "create", "mrr_log", insert.id, nextMrrNumber);
  }
  return { mrrNumber: nextMrrNumber, opiNumber: nextOpiNumber, poNumber: effectivePoNumber, created: true };
}

async function createOsdLog(client, payload) {
  await client.query(`
    insert into osd_logs (
      mrr_log_id, receipt_id, po_id, po_line_id, mrr_number, po_number, item_code, description,
      warehouse, location, expected_qty, received_qty, osd_qty, osd_status, notes, updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
  `, [
    payload.mrr_log_id || null,
    payload.receipt_id || null,
    payload.po_id || null,
    payload.po_line_id || null,
    String(payload.mrr_number || ""),
    String(payload.po_number || ""),
    String(payload.item_code || ""),
    String(payload.description || ""),
    String(payload.warehouse || ""),
    String(payload.location || ""),
    Number(payload.expected_qty || 0),
    Number(payload.received_qty || 0),
    Number(payload.osd_qty || 0),
    String(payload.osd_status || ""),
    String(payload.notes || "")
  ]);
}

async function syncMrrVendorsIntoVendorTable(client) {
  await client.query(`
    insert into vendors (name, contact_name, website, email, phone, categories)
    select distinct trim(m.vendor_name), '', '', '', '', ''
    from mrr_logs m
    left join vendors v on lower(v.name) = lower(trim(m.vendor_name))
    where trim(coalesce(m.vendor_name, '')) <> ''
      and v.id is null
  `);
}

async function syncOpiLogsFromMrr(client) {
  await client.query(`
    delete from opi_logs o
    where not exists (
      select 1
      from mrr_logs m
      where trim(coalesce(m.opi_number, '')) <> ''
        and trim(m.opi_number) = o.opi_number
    )
  `);
  await client.query(`
    insert into opi_logs (opi_number, vendor_name, material_description, load_number, mrr_number, updated_at)
    select distinct on (trim(m.opi_number))
           trim(m.opi_number),
           coalesce(m.vendor_name, ''),
           coalesce(m.material_description, ''),
           coalesce(m.load_number, ''),
           coalesce(m.mrr_number, ''),
           now()
    from mrr_logs m
    where trim(coalesce(m.opi_number, '')) <> ''
    order by trim(m.opi_number), m.id desc
    on conflict (opi_number) do update set
      vendor_name = excluded.vendor_name,
      material_description = excluded.material_description,
      load_number = excluded.load_number,
      mrr_number = excluded.mrr_number,
      updated_at = now()
  `);
}

async function ensureUniqueFmrContainer(client, vendorName, containerNo, excludeId = null) {
  const vendor = String(vendorName || "").trim().toLowerCase();
  const normalized = String(containerNo || "").trim();
  if (!vendor || !normalized) return;
  const params = [vendor, normalized.toLowerCase()];
  let sql = `
    select id
    from fmr_logs
    where lower(trim(coalesce(vendor_name, ''))) = $1
      and lower(trim(coalesce(container_no, ''))) = $2
  `;
  if (excludeId) {
    params.push(excludeId);
    sql += " and id <> $3";
  }
  sql += " limit 1";
  const existing = (await client.query(sql, params)).rows[0];
  if (existing) {
    throw new Error("This vendor already has that container number on the Vendor FMR Log.");
  }
}

async function getRequestedVendorCrateSet(client = null) {
  const runner = client || { query };
  const rows = (await runner.query(`
    select lower(trim(coalesce(vendor_name, ''))) as vendor_key,
           lower(trim(coalesce(container_no, ''))) as crate_key
    from fmr_logs
    where trim(coalesce(vendor_name, '')) <> ''
      and trim(coalesce(container_no, '')) <> ''
  `)).rows;
  return new Set(rows.map((row) => `${row.vendor_key}|${row.crate_key}`));
}

function getVendorFmrRequestBuilderQuery(source = {}) {
  return new URLSearchParams({
    po_number: String(source.po_number || ""),
    item_code: String(source.item_code || ""),
    abbrev_description: String(source.abbrev_description || ""),
    show_requested: String(source.show_requested || "0"),
    current_crate_number: String(source.current_crate_number || "")
  }).toString();
}

async function buildVendorFmrPreviewData(client) {
  const requestedSet = await getRequestedVendorCrateSet(client);
  const stagedRows = (await client.query(`
    select *
    from vendor_fmr_request_lines
    where selected_for_request = true
    order by id
  `)).rows;
  const requestGroups = new Map();
  const invalidRows = [];
  const skippedRows = [];
  for (const row of stagedRows) {
    const crateNumber = String(row.crate_number || "").trim();
    const srnNumber = String(row.srn_number || "").trim();
    const vendorName = String(row.vendor_name || "").trim();
    const vendorKey = vendorName.toLowerCase();
    if (!crateNumber) {
      invalidRows.push({
        id: row.id,
        vendorName,
        poNumber: row.po_number || "",
        itemCode: row.item_code || "",
        abbrevDescription: row.abbrev_description || "",
        srnNumber
      });
      continue;
    }
    const crateKey = `${vendorKey}|${crateNumber.toLowerCase()}`;
    if (requestedSet.has(crateKey)) {
      skippedRows.push({
        id: row.id,
        vendorName,
        crateNumber,
        poNumber: row.po_number || "",
        itemCode: row.item_code || "",
        abbrevDescription: row.abbrev_description || "",
        srnNumber
      });
      continue;
    }
    const requestGroupKey = `${vendorKey}|${srnNumber ? srnNumber.toLowerCase() : "__blank__"}`;
    if (!requestGroups.has(requestGroupKey)) {
      requestGroups.set(requestGroupKey, {
        vendorName,
        srnNumber,
        rowsByCrate: new Map()
      });
    }
    const group = requestGroups.get(requestGroupKey);
    if (!group.rowsByCrate.has(crateKey)) {
      group.rowsByCrate.set(crateKey, {
        row,
        vendorName,
        crateNumber,
        srnNumber,
        stagedLineCount: 1
      });
    } else {
      group.rowsByCrate.get(crateKey).stagedLineCount += 1;
    }
  }
  const previewGroups = Array.from(requestGroups.values()).map((group) => ({
    ...group,
    crates: Array.from(group.rowsByCrate.values())
  }));
  const previewRows = previewGroups.flatMap((group) => group.crates.map((crate) => ({
    vendorName: crate.vendorName,
    crateNumber: crate.crateNumber,
    srnNumber: crate.srnNumber,
    poNumber: crate.row.po_number || "",
    itemCode: crate.row.item_code || "",
    abbrevDescription: crate.row.abbrev_description || "",
    stagedLineCount: crate.stagedLineCount
  })));
  return { stagedRows, previewGroups, previewRows, invalidRows, skippedRows };
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function currentUser(req) {
  const sessionToken = req?.cookies?.session_token;
  return sessionToken ? readSession(sessionToken) : null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    res.redirect("/login");
    return;
  }
  req.user = user;
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      res.status(403).send(layout("Forbidden", `<div class="card error"><h3>Forbidden</h3><p>You do not have access to this action.</p></div>`, req.user));
      return;
    }
    next();
  };
}

function requirePermission(section, action = "view") {
  return (req, res, next) => {
    if (!canAccess(req.user, section, action)) {
      res.status(403).send(layout("Forbidden", `<div class="card error"><h3>Forbidden</h3><p>You do not have permission for this action.</p></div>`, req.user));
      return;
    }
    next();
  };
}

function requireInventoryAuditEdit(req, res, next) {
  if (!canEditInventoryAudit(req.user)) {
    res.status(403).send(layout("Forbidden", `<div class="card error"><h3>Forbidden</h3><p>You do not have permission for this action.</p></div>`, req.user));
    return;
  }
  next();
}

function canEditRequisition(user, header) {
  if (!user || !header) return false;
  return header.status === "REQUESTED" && canAccess(user, "requisitions", "edit");
}

async function recalcRfqStatus(client, rfqId) {
  const total = Number((await client.query("select count(*) from rfq_items where rfq_id = $1", [rfqId])).rows[0].count);
  const awardedCount = Number((await client.query("select count(*) from rfq_items where rfq_id = $1 and award_status = 'AWARDED' and awarded_vendor_id is not null", [rfqId])).rows[0]?.count || 0);
  const quotedCount = Number((await client.query(`
    select count(distinct ri.id) as quoted_count
    from rfq_items ri
    join quotes q on q.rfq_item_id = ri.id
    where ri.rfq_id = $1
  `, [rfqId])).rows[0]?.quoted_count || 0);
  const totals = (await client.query(`
    select count(distinct pl.rfq_item_id)
      filter (where pl.rfq_item_id is not null) as issued_count,
      count(distinct pl.rfq_item_id)
      filter (
        where pl.rfq_item_id is not null
          and coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) >= pl.qty_ordered
      ) as fully_received_count
    from purchase_orders po
    join po_lines pl on pl.po_id = po.id
    where po.rfq_id = $1
  `, [rfqId])).rows[0];
  const issued = Number(totals?.issued_count || 0);
  const fullyReceived = Number(totals?.fully_received_count || 0);
  if (total > 0 && fullyReceived >= total) {
    await client.query("update rfqs set status = 'RECEIVED' where id = $1", [rfqId]);
  } else if (issued > 0) {
    await client.query("update rfqs set status = 'PURCHASED' where id = $1 and status <> 'RECEIVED'", [rfqId]);
  } else if (total > 0 && awardedCount >= total) {
    await client.query("update rfqs set status = 'AWARDED' where id = $1 and status not in ('PURCHASED', 'RECEIVED')", [rfqId]);
  } else if (quotedCount > 0) {
    await client.query("update rfqs set status = 'WAITING_ON_QUOTES' where id = $1 and status not in ('AWARDED', 'PURCHASED', 'RECEIVED')", [rfqId]);
  } else {
    await client.query("update rfqs set status = 'SEND_FOR_QUOTES' where id = $1 and status not in ('AWARDED', 'PURCHASED', 'RECEIVED')", [rfqId]);
  }
}

async function backfillRfqVendors(client, rfqId) {
  await client.query(`
    insert into rfq_vendors (rfq_id, vendor_id)
    select distinct ri.rfq_id, q.vendor_id
    from rfq_items ri
    join quotes q on q.rfq_item_id = ri.id
    where ri.rfq_id = $1
    on conflict (rfq_id, vendor_id) do nothing
  `, [rfqId]);
  await client.query(`
    insert into rfq_vendors (rfq_id, vendor_id)
    select distinct rfq_id, awarded_vendor_id
    from rfq_items
    where rfq_id = $1 and awarded_vendor_id is not null
    on conflict (rfq_id, vendor_id) do nothing
  `, [rfqId]);
}

async function getRfqVendorRows(client, rfqId) {
  await backfillRfqVendors(client, rfqId);
  return (await client.query(`
    select rv.vendor_id, v.name
    from rfq_vendors rv
    join vendors v on v.id = rv.vendor_id
    where rv.rfq_id = $1
    order by v.name
  `, [rfqId])).rows;
}

async function syncRfqVendors(client, rfqId, vendorIds) {
  const deduped = Array.from(new Set(vendorIds.map((vendorId) => Number(vendorId)).filter((vendorId) => Number.isFinite(vendorId) && vendorId > 0)));
  await client.query("delete from rfq_vendors where rfq_id = $1 and not (vendor_id = any($2::bigint[]))", [rfqId, deduped]);
  if (deduped.length === 0) {
    await client.query("delete from rfq_vendors where rfq_id = $1", [rfqId]);
    return;
  }
  await client.query(`
    insert into rfq_vendors (rfq_id, vendor_id)
    select $1, vendor_id
    from unnest($2::bigint[]) as vendor_id
    on conflict (rfq_id, vendor_id) do nothing
  `, [rfqId, deduped]);
}

async function recalcPoStatus(client, poId) {
  const po = (await client.query("select status from purchase_orders where id = $1", [poId])).rows[0];
  if (!po || po.status === "CANCELLED" || po.status === "DRAFT") return;
  const totals = (await client.query(`
    select
      count(*) as line_count,
      count(*) filter (
        where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) >= pl.qty_ordered
      ) as fully_received_count,
      count(*) filter (
        where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) > 0
      ) as received_count
    from po_lines pl
    where pl.po_id = $1
  `, [poId])).rows[0];
  const lineCount = num(totals?.line_count);
  const fullyReceivedCount = num(totals?.fully_received_count);
  const receivedCount = num(totals?.received_count);
  let nextStatus = "ISSUED";
  if (lineCount > 0 && fullyReceivedCount >= lineCount) nextStatus = "FULLY_RECEIVED";
  else if (receivedCount > 0) nextStatus = "PARTIALLY_RECEIVED";
  await client.query(`
    update purchase_orders
    set status = $2,
        issued_at = case when $2 in ('ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED') and issued_at is null then now() else issued_at end,
        closed_at = case when $2 = 'FULLY_RECEIVED' then now() else null end,
        updated_at = now()
    where id = $1
  `, [poId, nextStatus]);
}

async function getJobNumber(client = null) {
  const runner = client || { query };
  const result = await runner.query("select value from app_settings where key = 'job_number'");
  return String(result.rows[0]?.value || "0000").trim() || "0000";
}

async function getNextInventoryAuditReportNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(report_no, 5) as integer)), 0) as max_no
    from inventory_audit_reports
    where report_no ~ '-INV-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-INV-${String(nextNumber).padStart(5, "0")}`;
}

async function saveInventoryAuditReport(client, { userId, warehouseFilter = "", locationFilter = "", identFilter = "", desiredRows = [] }) {
  if (!desiredRows.length) throw new Error("No inventory rows were provided for this audit.");
  const currentRows = await getCurrentOnHandRows(client);
  const currentMap = new Map(currentRows.map((row) => [buildInventoryEntryKey(row), row]));
  const reportNo = await getNextInventoryAuditReportNumber(client);
  const reportInsert = await client.query(`
    insert into inventory_audit_reports (
      report_no, created_by, warehouse_filter, location_filter, ident_filter
    ) values ($1,$2,$3,$4,$5)
    returning id
  `, [reportNo, userId || null, String(warehouseFilter || ""), String(locationFilter || ""), String(identFilter || "")]);
  const reportId = Number(reportInsert.rows[0]?.id || 0);
  for (const desiredRow of desiredRows) {
    await assertValidWarehouseLocation(client, desiredRow.warehouse, desiredRow.location);
    const key = buildInventoryEntryKey(desiredRow);
    const currentRow = currentMap.get(key);
    const bookQty = parseQtyValue(currentRow?.qty_on_hand || 0);
    const actualQty = parseQtyValue(desiredRow.actual_qty || 0);
    const adjustmentQty = parseQtyValue(actualQty - bookQty);
    const lineInsert = await client.query(`
      insert into inventory_audit_report_lines (
        report_id, item_code, description, size_1, size_2, thk_1, thk_2, warehouse, location, book_qty, actual_qty, adjustment_qty
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning id
    `, [
      reportId,
      String(desiredRow.item_code || ""),
      String(desiredRow.description || currentRow?.description || ""),
      String(desiredRow.size_1 || ""),
      String(desiredRow.size_2 || ""),
      String(desiredRow.thk_1 || ""),
      String(desiredRow.thk_2 || ""),
      String(desiredRow.warehouse || ""),
      String(desiredRow.location || ""),
      bookQty,
      actualQty,
      adjustmentQty
    ]);
    if (adjustmentQty !== 0) {
      await client.query(`
        insert into inventory_adjustment_lines (
          report_id, report_line_id, item_code, description, size_1, size_2, thk_1, thk_2, warehouse, location, qty_adjustment, created_by
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        reportId,
        Number(lineInsert.rows[0]?.id || 0),
        String(desiredRow.item_code || ""),
        String(desiredRow.description || currentRow?.description || ""),
        String(desiredRow.size_1 || ""),
        String(desiredRow.size_2 || ""),
        String(desiredRow.thk_1 || ""),
        String(desiredRow.thk_2 || ""),
        String(desiredRow.warehouse || ""),
        String(desiredRow.location || ""),
        adjustmentQty,
        userId || null
      ]);
    }
    await client.query(`
      insert into inventory_audit_counts (
        item_code, description, size_1, size_2, thk_1, thk_2, warehouse, location, actual_qty, updated_by, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      on conflict (item_code, size_1, size_2, thk_1, thk_2, warehouse, location)
      do update set
        description = excluded.description,
        actual_qty = excluded.actual_qty,
        updated_by = excluded.updated_by,
        updated_at = now()
    `, [
      String(desiredRow.item_code || ""),
      String(desiredRow.description || currentRow?.description || ""),
      String(desiredRow.size_1 || ""),
      String(desiredRow.size_2 || ""),
      String(desiredRow.thk_1 || ""),
      String(desiredRow.thk_2 || ""),
      String(desiredRow.warehouse || ""),
      String(desiredRow.location || ""),
      actualQty,
      userId || null
    ]);
    await auditLog(client, userId, "update", "inventory_audit_counts", `${desiredRow.item_code}|${desiredRow.warehouse}|${desiredRow.location}`, `actual_qty=${actualQty};report=${reportNo};delta=${adjustmentQty}`);
  }
  return { reportId, reportNo };
}

async function getNextRfqNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(rfq_no, 5) as integer)), 0) as max_no
    from rfqs
    where rfq_no ~ '-RFQ-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-RFQ-${String(nextNumber).padStart(5, "0")}`;
}

async function getNextRequisitionNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(requisition_no, 5) as integer)), 0) as max_no
    from material_requisitions
    where requisition_no ~ '-MR-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-MR-${String(nextNumber).padStart(5, "0")}`;
}

async function getNextBomNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(bom_no, 5) as integer)), 0) as max_no
    from bom_headers
    where bom_no ~ '-BOM-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-BOM-${String(nextNumber).padStart(5, "0")}`;
}

function loginPage(error = "") {
  return layout("Login", `
      ${error ? `<div class="card error"><strong>${esc(error)}</strong></div>` : ""}
      <div class="card">
        <h2>Sign In</h2>
        <p class="muted">Default admin login: <strong>admin</strong> / <strong>admin123</strong></p>
        <form method="post" action="/login" class="stack">
          <div class="grid">
            <div><label>Username</label><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required /></div>
            <div><label>Password</label><input type="password" name="password" autocomplete="current-password" required /></div>
          </div>
          <div class="actions"><button type="submit">Sign In</button></div>
        </form>
      </div>
    `, null);
}

app.get("/login", (req, res) => {
  if (currentUser(req)) {
    res.redirect("/dashboard");
    return;
  }
  const errorMap = {
    invalid: "Invalid username or password.",
    inactive: "This user is inactive. Contact an administrator."
  };
  const error = errorMap[String(req.query.error || "").trim()] || "";
  res.send(loginPage(error));
});

app.post("/login", asyncHandler(async (req, res) => {
  const { username = "", password = "" } = req.body;
  const result = await query("select id, username, role, password_hash, is_active from users where username = $1", [username.trim()]);
  const user = result.rows[0];
  if (user && !user.is_active) {
    res.redirect("/login?error=inactive");
    return;
  }
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.redirect("/login?error=invalid");
    return;
  }
  const token = signSession({ id: user.id, username: user.username, role: user.role });
  res.cookie("session_token", token, { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  res.redirect("/dashboard");
}));

app.get("/logout", (req, res) => {
  res.clearCookie("session_token", { path: "/" });
  res.redirect("/login");
});

app.get("/", async (req, res) => {
  if (currentUser(req)) {
    res.redirect("/dashboard");
    return;
  }
  res.send(landingPage());
});

app.get("/dashboard", requireAuth, requirePermission("dashboard", "view"), async (req, res) => {
  const [rfqs, pos, receipts, vendors, osd, jobNumber, pendingAccessRequests, rfqStatusCounts] = await Promise.all([
    query("select count(*) from rfqs"),
    query("select count(*) from purchase_orders"),
    query("select count(*) from receipts"),
    query("select count(*) from vendors"),
    query("select count(*) from receipts where osd_status <> 'OK'"),
    getJobNumber(),
    req.user.role === "admin"
      ? query("select count(*) from access_requests where status = 'PENDING'").catch(() => ({ rows: [{ count: 0 }] }))
      : Promise.resolve({ rows: [{ count: 0 }] }),
    ["admin", "buyer"].includes(req.user.role)
      ? query(`
          select status, count(*)::int as count
          from rfqs
          group by status
        `)
      : Promise.resolve({ rows: [] })
  ]);
  const rfqStatusMap = Object.fromEntries(rfqStatusCounts.rows.map((row) => [row.status, Number(row.count || 0)]));
  const rfqStatusCards = ["admin", "buyer"].includes(req.user.role)
    ? `<div class="card"><h3>RFQ Status</h3><div class="stats">${
        rfqStatuses.map((status) => `<div class="stat"><div>${esc(status.label)}</div><strong>${rfqStatusMap[status.value] || 0}</strong></div>`).join("")
      }</div></div>`
    : "";
  res.send(layout("Dashboard", `
    <h1>Operations Dashboard</h1>
    ${req.user.role === "admin" && Number(pendingAccessRequests.rows[0].count) > 0 ? `<div class="card error"><strong>${pendingAccessRequests.rows[0].count} pending access request(s)</strong><div class="actions" style="margin-top:10px;"><a class="btn btn-primary" href="/settings">Review Requests</a></div></div>` : ""}
    <div class="card"><strong>Job Number:</strong> ${esc(jobNumber)}</div>
    <div class="dashboard-sections">
      <div class="card">
        <div class="stats">
          <div class="stat"><div>RFQs</div><strong>${rfqs.rows[0].count}</strong></div>
          <div class="stat"><div>POs</div><strong>${pos.rows[0].count}</strong></div>
          <div class="stat"><div>POs Received</div><strong>${receipts.rows[0].count}</strong></div>
          <div class="stat"><div>Open OS&amp;Ds</div><strong>${osd.rows[0].count}</strong></div>
        </div>
      </div>
      ${rfqStatusCards}
    </div>
  `, req.user));
});

app.get("/yard", requireAuth, requirePermission("yard", "view"), async (req, res) => {
  const [unverifiedRes, verifiedRes] = await Promise.all([
    query("select count(*) from material_requisitions where status = 'REQUESTED'"),
    query("select count(*) from material_requisitions where status = 'VERIFIED'")
  ]);
  const unverifiedCount = Number(unverifiedRes.rows[0]?.count || 0);
  const verifiedCount = Number(verifiedRes.rows[0]?.count || 0);
  res.send(layout("Yard", `
    <h1>Yard</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-primary" href="/inventory">Inventory</a>
        <a class="btn btn-primary" href="/yard/locations">Locations</a>
        <a class="btn btn-primary" href="/inventory-audit">Inventory Audit</a>
        ${req.user.role === "admin" ? `<a class="btn btn-primary" href="/yard/item-history">Item History</a>` : ""}
      </div>
    </div>
    <div class="stats">
      <a class="stat" href="/requisitions?status=REQUESTED" style="text-decoration:none;color:inherit;">
        <div>Unverified Requests</div>
        <strong>${unverifiedCount}</strong>
      </a>
      <a class="stat" href="/requisitions?status=VERIFIED" style="text-decoration:none;color:inherit;">
        <div>Verified Requests</div>
        <strong>${verifiedCount}</strong>
      </a>
    </div>
  `, req.user));
});

function getInventoryAuditQueryString(source = {}) {
  return new URLSearchParams({
    warehouse_filter: String(source.warehouse_filter || ""),
    location_filter: String(source.location_filter || ""),
    ident_filter: String(source.ident_filter || "")
  }).toString();
}

function getSafeReturnPath(req, fallback = "/settings") {
  const returnTo = String(req.body?.return_to || req.query?.return_to || "").trim();
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

app.get("/settings", requireAuth, requirePermission("settings", "view"), async (req, res) => {
  const resetComplete = String(req.query.reset || "").trim() === "1";
  const accessRequestsRes = await query("select * from access_requests where status = 'PENDING' order by created_at asc");
  const accessRequestRows = accessRequestsRes.rows.map((record) => `
    <tr>
      <td>${esc(record.email)}</td>
              <td>${esc(formatShortDateTime(record.created_at))}</td>
      <td>
        <form id="access-request-${record.id}" method="post" action="/settings/access-requests/${record.id}/approve" class="stack" data-password-form="access-approve" data-password-message-id="access-request-${record.id}-password-error">
          <input type="hidden" name="return_to" value="/settings" />
          <div class="grid">
            <div><input name="username" placeholder="Username" required /></div>
            <div><input name="temp_password" placeholder="Temp Password" required /></div>
            <div>
              <select name="role">
                <option value="buyer">buyer</option>
                <option value="warehouse">warehouse</option>
                <option value="field">field</option>
                <option value="supervisor">supervisor</option>
                <option value="admin">admin</option>
              </select>
            </div>
          </div>
          <div class="actions">
            <button type="submit">Approve</button>
            <button class="btn btn-danger" type="submit" formaction="/settings/access-requests/${record.id}/deny">Deny</button>
          </div>
          <div id="access-request-${record.id}-password-error" class="muted" style="color:#a23622;"></div>
        </form>
      </td>
    </tr>
  `).join("");
  res.send(layout("Settings", `
    <h1>Settings</h1>
    ${resetComplete ? `<div class="card success"><strong>App reset complete.</strong> Operational data was deleted, and the app is ready for a fresh setup/import.</div>` : ""}
    <div class="card">
      <div class="actions">
        <a class="btn btn-primary" href="/settings/job-setup">Job Setup</a>
        <a class="btn btn-primary" href="/settings/warehouse-setup">Warehouse Setup</a>
        <a class="btn btn-primary" href="/settings/user-management">User Management</a>
      </div>
      <p class="muted" style="margin-top:12px;">Use these setup pages to manage job settings, warehouse/location setup, and users without crowding the main settings screen.</p>
    </div>
    ${req.user.role === "admin" ? `
      <div class="card error">
        <h3 style="margin-top:0;">Danger Zone</h3>
        <p>This admin-only page lets you delete specific data sections or run a broader reset with verification.</p>
        <div class="actions">
          <a class="btn btn-danger" href="/settings/reset-app">Open Reset Controls</a>
        </div>
      </div>
    ` : ""}
    <div class="card scroll">
      <h3>Access Requests</h3>
      <table>
        <tr><th>Email</th><th>Requested</th><th>Approve / Deny</th></tr>
        ${accessRequestRows || `<tr><td colspan="3" class="muted">No pending access requests.</td></tr>`}
      </table>
    </div>
  `, req.user));
});

app.get("/settings/reset-app", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const completedTarget = String(req.query.done || "").trim();
  const completedConfig = getResetTargetConfig(completedTarget);
  const sectionMarkup = resetTargetSections.map((section) => `
    <div class="card">
      <h3 style="margin-top:0;">${esc(section.heading)}</h3>
      <div class="stack">
        ${section.targets.map((target) => {
          const config = getResetTargetConfig(target);
          return `
            <div style="border:1px solid #b7c3d0; padding:12px; border-radius:4px;">
              <div style="display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap;">
                <div style="flex:1 1 420px;">
                  <strong>${esc(config.label)}</strong>
                  <div class="muted" style="margin-top:6px;">${esc(config.description)}</div>
                </div>
                <div class="actions">
                  <a class="btn btn-danger" href="/settings/reset-app/${encodeURIComponent(target)}">Open Delete Confirmation</a>
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `).join("");
  res.send(layout("Reset App Data", `
    <h1>Reset App Data</h1>
    ${completedConfig ? `<div class="card success"><strong>${esc(completedConfig.label)} complete.</strong> The selected reset action finished successfully.</div>` : ""}
    <div class="card error">
      <h3 style="margin-top:0;">Admin-only reset controls</h3>
      <p>Each action below has its own confirmation step. Use the broader reset options only if you are intentionally clearing large parts of the app.</p>
      <div class="actions">
        <a class="btn btn-secondary" href="/settings">Back To Settings</a>
      </div>
    </div>
    ${sectionMarkup}
  `, req.user));
}));

app.get("/settings/reset-app/:target", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const config = getResetTargetConfig(String(req.params.target || "").trim());
  if (!config) throw new Error("Reset target not found.");
  res.send(layout(config.label, `
    <h1>${esc(config.label)}</h1>
    <div class="card error">
      <h3 style="margin-top:0;">Verification required</h3>
      <p>${esc(config.description)}</p>
      <p>To continue, type <code>${esc(config.confirmText)}</code> and your current username <code>${esc(req.user.username)}</code>.</p>
    </div>
    <div class="card">
      <form method="post" action="/settings/reset-app/${encodeURIComponent(String(req.params.target || "").trim())}" class="stack">
        <div class="grid">
          <div><label>Confirmation Phrase</label><input name="confirm_text" autocomplete="off" required /></div>
          <div><label>Current Username</label><input name="confirm_username" autocomplete="off" required /></div>
        </div>
        <div class="actions">
          <button class="btn btn-danger" type="submit">Confirm ${esc(config.label)}</button>
          <a class="btn btn-secondary" href="/settings/reset-app">Cancel</a>
        </div>
      </form>
    </div>
  `, req.user));
}));

app.post("/settings/reset-app/:target", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const target = String(req.params.target || "").trim();
  const config = getResetTargetConfig(target);
  if (!config) throw new Error("Reset target not found.");
  const confirmText = String(req.body.confirm_text || "").trim();
  const confirmUsername = String(req.body.confirm_username || "").trim();
  if (confirmText !== config.confirmText) throw new Error(`Type ${config.confirmText} to confirm this reset.`);
  if (confirmUsername !== String(req.user.username || "").trim()) throw new Error("Enter your current username exactly to confirm the reset.");
  await withTransaction(async (client) => {
    await runResetTarget(client, target, req.user);
  });
  if (target === "full_reset" || target === "job_number") {
    await query(`
      insert into app_settings (key, value, updated_at)
      values ('job_number', $1, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
    `, [defaultJobNumberValue]);
  }
  res.redirect(`/settings/reset-app?done=${encodeURIComponent(target)}`);
}));

app.get("/settings/job-setup", requireAuth, requirePermission("settings", "view"), async (req, res) => {
  const jobNumber = await getJobNumber();
  const vendorCategoryText = vendorCategories.join("\n");
  const permissionRows = permissionSections.map((section) => {
    const cells = permissionRoles.map((role) => {
      const perms = {
        ...(defaultPermissionMatrix[role]?.[section.key] || {}),
        ...(permissionMatrix[role]?.[section.key] || {})
      };
      const viewChecked = perms.view ? "checked" : "";
      const editChecked = perms.edit ? "checked" : "";
      const createChecked = perms.create ? "checked" : "";
      const verifyChecked = perms.verify ? "checked" : "";
      const issueChecked = perms.issue ? "checked" : "";
      const unverifyChecked = perms.unverify ? "checked" : "";
      const deleteChecked = perms.delete ? "checked" : "";
      return `<td>
        <div class="stack">
          <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__view" ${viewChecked} /><span>View</span></label>
          <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__edit" ${editChecked} /><span>Edit</span></label>
          ${section.key === "requisitions" ? `
            <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__create" ${createChecked} /><span>Create</span></label>
            <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__verify" ${verifyChecked} /><span>Verify</span></label>
            <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__issue" ${issueChecked} /><span>Issue</span></label>
            <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__unverify" ${unverifyChecked} /><span>Unverify</span></label>
            <label class="check-option"><input type="checkbox" name="perm__${role}__${section.key}__delete" ${deleteChecked} /><span>Delete</span></label>
          ` : ""}
        </div>
      </td>`;
    }).join("");
    return `<tr><td><strong>${esc(section.label)}</strong></td>${cells}</tr>`;
  }).join("");
  res.send(layout("Job Setup", `
    <h1>Job Setup</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-secondary" href="/settings">Back To Settings</a>
      </div>
    </div>
    <div class="card">
      <form method="post" action="/settings/job-number" class="stack">
        <input type="hidden" name="return_to" value="/settings/job-setup" />
        <div class="grid">
          <div><label>Job Number</label><input name="job_number" value="${esc(jobNumber)}" required /></div>
        </div>
        <p class="muted">Future RFQs will use this format: <strong>${esc(jobNumber)}-RFQ-00001</strong></p>
        <div class="actions"><button type="submit">Save Job Number</button></div>
      </form>
    </div>
    <div class="card">
      <h3>Vendor Categories</h3>
      <form method="post" action="/settings/vendor-categories" class="stack">
        <input type="hidden" name="return_to" value="/settings/job-setup" />
        <div><label>One Category Per Line</label><textarea name="vendor_categories">${esc(vendorCategoryText)}</textarea></div>
        <div class="muted">These values control the category checkboxes on vendor screens.</div>
        <div class="actions"><button type="submit">Save Vendor Categories</button></div>
      </form>
    </div>
    <div class="card">
      <h3>Material Log Imports</h3>
      <div class="muted">Import receiving, MRR, and FMR workbook data from a separate admin page.</div>
      <div class="actions" style="margin-top:12px;"><a class="btn btn-primary" href="/settings/material-log-imports">Open Material Log Imports</a></div>
    </div>
    ${req.user.role === "admin" ? `
      <div class="card scroll">
        <h3>Sheet Permissions</h3>
        <form method="post" action="/settings/permissions" class="stack">
          <input type="hidden" name="return_to" value="/settings/job-setup" />
          <table>
            <tr><th>Sheet</th><th>Admin</th><th>Buyer</th><th>Warehouse</th><th>Field</th><th>Supervisor</th></tr>
            ${permissionRows}
          </table>
          <div class="actions"><button type="submit">Save Permissions</button></div>
        </form>
      </div>
    ` : ""}
  `, req.user));
});

app.get("/settings/warehouse-setup", requireAuth, requirePermission("settings", "view"), async (req, res) => {
  const warehousesRes = req.user.role === "admin"
    ? await query("select id, name, is_active from warehouses order by name")
    : { rows: [] };
  const warehouseLocationsRes = req.user.role === "admin"
    ? await query(`
        select wl.id, wl.name, wl.is_active, wl.warehouse_id, w.name as warehouse_name
        from warehouse_locations wl
        join warehouses w on w.id = wl.warehouse_id
        order by w.name, wl.name
      `)
    : { rows: [] };
  const warehouseOptions = warehousesRes.rows.map((row) => `<option value="${row.id}">${esc(row.name)}</option>`).join("");
  const warehouseRows = warehousesRes.rows.map((row) => `
    <tr>
      <td>${esc(normalizeWarehouseName(row.name))}</td>
      <td>${row.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>
        <form method="post" action="/settings/warehouses/${row.id}/toggle">
          <input type="hidden" name="return_to" value="/settings/warehouse-setup" />
          <button type="submit">${row.is_active ? "Set Inactive" : "Set Active"}</button>
        </form>
      </td>
    </tr>
  `).join("");
  const warehouseLocationRows = warehouseLocationsRes.rows.map((row) => `
    <tr>
      <td>${esc(normalizeWarehouseName(row.warehouse_name))}</td>
      <td>${esc(normalizeLocationName(row.name))}</td>
      <td>${row.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>
        <form method="post" action="/settings/warehouse-locations/${row.id}/toggle">
          <input type="hidden" name="return_to" value="/settings/warehouse-setup" />
          <button type="submit">${row.is_active ? "Set Inactive" : "Set Active"}</button>
        </form>
      </td>
    </tr>
  `).join("");
  res.send(layout("Warehouse Setup", `
    <h1>Warehouse Setup</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-secondary" href="/settings">Back To Settings</a>
      </div>
    </div>
    ${req.user.role === "admin" ? `
      <div class="card">
        <h3>Warehouses</h3>
        <form method="post" action="/settings/warehouses/add" class="stack">
          <input type="hidden" name="return_to" value="/settings/warehouse-setup" />
          <div class="grid">
            <div><label>Warehouse Name</label><input name="name" required /></div>
          </div>
          <div class="actions"><button type="submit">Add Warehouse</button></div>
        </form>
      </div>
      <div class="card scroll">
        <table>
          <tr><th>Warehouse</th><th>Status</th><th>Action</th></tr>
          ${warehouseRows || `<tr><td colspan="3" class="muted">No warehouses saved yet.</td></tr>`}
        </table>
      </div>
      <div class="card">
        <h3>Warehouse Locations</h3>
        <form method="post" action="/settings/warehouse-locations/add" class="stack">
          <input type="hidden" name="return_to" value="/settings/warehouse-setup" />
          <div class="grid">
            <div><label>Warehouse</label><select name="warehouse_id" required><option value="">Select warehouse</option>${warehouseOptions}</select></div>
            <div><label>Location Name</label><input name="name" required /></div>
          </div>
          <div class="actions"><button type="submit">Add Location</button></div>
        </form>
        <form method="post" enctype="multipart/form-data" action="/settings/warehouse-locations/import" class="stack" style="margin-top:16px;">
          <input type="hidden" name="return_to" value="/settings/warehouse-setup" />
          <div><label>Import Warehouses / Locations From .xlsx</label><input type="file" name="sheet" accept=".xlsx,.csv" required /></div>
          <div class="muted">Supported columns: <code>warehouse</code> and <code>location</code>. Export first if you want an update-friendly workbook with IDs and active status.</div>
          <div class="actions"><button type="submit">Import Warehouse Locations</button><a class="btn btn-secondary" href="/settings/warehouse-locations/export.xlsx">Export Warehouses / Locations (.xlsx)</a></div>
        </form>
      </div>
      <div class="card scroll">
        <table>
          <tr><th>Warehouse</th><th>Location</th><th>Status</th><th>Action</th></tr>
          ${warehouseLocationRows || `<tr><td colspan="4" class="muted">No warehouse locations saved yet.</td></tr>`}
        </table>
      </div>
    ` : `<div class="card error"><p>You do not have access to warehouse setup.</p></div>`}
  `, req.user));
});

app.get("/settings/user-management", requireAuth, requireRole(["admin"]), async (req, res) => {
  const usersRes = await query("select id, username, role, is_active, created_at from users order by username");
  const userRows = usersRes.rows.map((record) => `
    <tr>
      <td>${esc(record.username)}</td>
      <td>${esc(record.role)}</td>
      <td>${record.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>${esc(formatShortDateTime(record.created_at))}</td>
      <td>
        <div class="stack">
          <form id="edit-user-${record.id}" method="post" action="/settings/users/${record.id}/edit" class="stack" data-password-form="edit-user" data-password-message-id="edit-user-${record.id}-password-error">
            <input type="hidden" name="return_to" value="/settings/user-management" />
            <div class="grid">
              <div><input name="username" value="${esc(record.username)}" required /></div>
              <div>
                <select name="role">
                  <option value="admin" ${record.role === "admin" ? "selected" : ""}>admin</option>
                  <option value="buyer" ${record.role === "buyer" ? "selected" : ""}>buyer</option>
                  <option value="warehouse" ${record.role === "warehouse" ? "selected" : ""}>warehouse</option>
                  <option value="field" ${record.role === "field" ? "selected" : ""}>field</option>
                  <option value="supervisor" ${record.role === "supervisor" ? "selected" : ""}>supervisor</option>
                </select>
              </div>
              <div>
                <select name="is_active">
                  <option value="true" ${record.is_active ? "selected" : ""}>active</option>
                  <option value="false" ${!record.is_active ? "selected" : ""}>inactive</option>
                </select>
              </div>
            </div>
            <div class="actions">
              <input type="password" name="password" placeholder="Enter a new password to reset it" />
              <button type="submit">Save User</button>
            </div>
            <div id="edit-user-${record.id}-password-error" class="muted" style="color:#a23622;"></div>
            <div class="muted">Passwords are never displayed. Enter a new password only if you want to reset it.</div>
          </form>
          <div class="actions">
            ${req.user.id === record.id ? `<span class="muted">Current user</span>` : `<a class="btn btn-danger" href="/settings/users/${record.id}/delete?return_to=%2Fsettings%2Fuser-management">Delete</a>`}
          </div>
        </div>
      </td>
    </tr>
  `).join("");
  res.send(layout("User Management", `
    <h1>User Management</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-secondary" href="/settings">Back To Settings</a>
      </div>
    </div>
    <div class="card">
      <form id="new-user-form" method="post" action="/settings/users/add" class="stack">
        <input type="hidden" name="return_to" value="/settings/user-management" />
        <div class="grid">
          <div><label>Username</label><input name="username" required /></div>
          <div>
            <label>Role</label>
            <select name="role">
              <option value="buyer">buyer</option>
              <option value="warehouse">warehouse</option>
              <option value="field">field</option>
              <option value="supervisor">supervisor</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <div class="grid">
          <div>
            <label>Password</label>
            <div class="actions">
              <input id="new-user-password" type="password" name="password" required />
              <button type="button" class="btn btn-secondary" onclick="togglePassword(this, 'new-user-password')">Show</button>
            </div>
            <div id="new-user-password-error" class="muted" style="color:#a23622;"></div>
            <div class="muted">Minimum 10 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number.</div>
          </div>
        </div>
        <div class="actions"><button type="submit">Add User</button></div>
      </form>
    </div>
    <div class="card scroll">
      <h3>Existing Users</h3>
      <table>
        <tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Edit / Delete</th></tr>
        ${userRows || `<tr><td colspan="5" class="muted">No users found.</td></tr>`}
      </table>
    </div>
  `, req.user));
});

app.get("/yard/item-history", requireAuth, requireRole(["admin"]), requirePermission("yard", "view"), asyncHandler(async (req, res) => {
  const itemFilter = String(req.query.item || "").trim();
  const historyRows = itemFilter ? (await query(`
    select *
    from (
      select
        r.received_at as transaction_date,
        mi.item_code,
        mi.description,
        initcap(lower(coalesce(r.warehouse, ''))) as warehouse,
        upper(coalesce(r.location, '')) as location,
        r.qty_received as transaction_qty,
        case when coalesce(r.osd_status, 'OK') = 'OK' then r.qty_received else 0 end as inventory_effect,
        true as affects_on_hand,
        'Receipt' as source_type,
        coalesce(m.received_by, '') as actor_name,
        trim(both ' |' from concat_ws(' | ',
          case when coalesce(po.po_no, '') <> '' then concat('PO ', po.po_no) else '' end,
          case when coalesce(m.mrr_number, '') <> '' then concat('MRR ', m.mrr_number) else '' end,
          case when coalesce(r.osd_status, 'OK') <> 'OK' then concat('OS&D ', r.osd_status) else '' end,
          coalesce(r.osd_notes, '')
        )) as details
      from receipts r
      join po_lines pl on pl.id = r.po_line_id
      join material_items mi on mi.id = pl.material_item_id
      left join purchase_orders po on po.id = pl.po_id
      left join mrr_logs m on m.id = r.mrr_log_id
      where mi.item_code ilike $1 or mi.description ilike $1

      union all

      select
        ial.created_at as transaction_date,
        ial.item_code,
        ial.description,
        initcap(lower(coalesce(ial.warehouse, ''))) as warehouse,
        upper(coalesce(ial.location, '')) as location,
        abs(ial.qty_adjustment) as transaction_qty,
        ial.qty_adjustment as inventory_effect,
        true as affects_on_hand,
        'Inventory Audit' as source_type,
        coalesce(u.username, '') as actor_name,
        trim(both ' |' from concat_ws(' | ',
          case when coalesce(r.report_no, '') <> '' then concat('Report ', r.report_no) else '' end,
          case when ial.qty_adjustment < 0 then 'Decrease' when ial.qty_adjustment > 0 then 'Increase' else '' end
        )) as details
      from inventory_adjustment_lines ial
      left join inventory_audit_reports r on r.id = ial.report_id
      left join users u on u.id = ial.created_by
      where ial.item_code ilike $1 or ial.description ilike $1

      union all

      select
        mrl.created_at as transaction_date,
        coalesce(nullif(mrl.item_code, ''), nullif(mrl.ident_code, ''), nullif(mrl.fluor_item_code, '')) as item_code,
        mrl.description,
        initcap(lower(coalesce(mrl.warehouse, ''))) as warehouse,
        upper(coalesce(mrl.location, '')) as location,
        mrl.received_qty as transaction_qty,
        0::numeric as inventory_effect,
        false as affects_on_hand,
        'Manual Receiving Log' as source_type,
        coalesce(mrl.received_by, '') as actor_name,
        trim(both ' |' from concat_ws(' | ',
          case when coalesce(mrl.mrr_number, '') <> '' then concat('MRR ', mrl.mrr_number) else '' end,
          case when coalesce(mrl.po_number, '') <> '' then concat('PO ', mrl.po_number) else '' end,
          coalesce(mrl.comments, '')
        )) as details
      from material_receiving_logs mrl
      where (
        coalesce(nullif(mrl.item_code, ''), nullif(mrl.ident_code, ''), nullif(mrl.fluor_item_code, '')) ilike $1
        or coalesce(mrl.description, '') ilike $1
      )

      union all

      select
        coalesce(mr.issued_at, mr.created_at) as transaction_date,
        bl.item_code,
        bl.description,
        '' as warehouse,
        '' as location,
        mrl.qty_issued as transaction_qty,
        0::numeric as inventory_effect,
        false as affects_on_hand,
        'Material Issue' as source_type,
        coalesce(u.username, mr.requested_by_name, '') as actor_name,
        trim(both ' |' from concat_ws(' | ',
          concat('REQ ', mr.requisition_no),
          case when coalesce(mr.iwp_no, '') <> '' then concat('IWP ', mr.iwp_no) else '' end,
          case when coalesce(mr.iso_no, '') <> '' then concat('ISO ', mr.iso_no) else '' end
        )) as details
      from material_requisition_lines mrl
      join material_requisitions mr on mr.id = mrl.requisition_id
      join bom_lines bl on bl.id = mrl.bom_line_id
      left join users u on u.id = mr.issued_by_user_id
      where mrl.qty_issued > 0
        and (bl.item_code ilike $1 or bl.description ilike $1)
    ) item_history
    order by transaction_date desc nulls last, source_type, warehouse, location
  `, [`%${itemFilter}%`])).rows : [];
  const currentRows = itemFilter ? await getCurrentOnHandRows({ query }, {
    whereSql: "where coalesce(item_code, '') ilike $1 or coalesce(description, '') ilike $1",
    params: [`%${itemFilter}%`],
    orderSql: "inventory_by_location.warehouse, inventory_by_location.location, inventory_by_location.item_code"
  }) : [];
  const currentRowMarkup = currentRows.map((row) => `<tr>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(row.warehouse)}</td>
    <td>${esc(row.location)}</td>
    <td>${esc(formatQtyDisplay(row.qty_on_hand))}</td>
    <td>${esc(formatQtyDisplay(row.qty_osd))}</td>
  </tr>`).join("");
  const historyMarkup = historyRows.map((row) => {
    const effect = Number(row.inventory_effect || 0);
    const effectText = effect > 0 ? `+${formatQtyDisplay(effect)}` : formatQtyDisplay(effect);
    return `<tr>
      <td>${esc(formatShortDateTime(row.transaction_date))}</td>
      <td>${esc(row.source_type)}</td>
      <td>${esc(row.item_code || "")}</td>
      <td>${esc(row.description || "")}</td>
      <td>${esc(row.warehouse || "")}</td>
      <td>${esc(row.location || "")}</td>
      <td>${esc(formatQtyDisplay(row.transaction_qty))}</td>
      <td>${row.affects_on_hand ? "Yes" : "No"}</td>
      <td>${esc(effectText)}</td>
      <td>${esc(row.actor_name || "")}</td>
      <td>${esc(row.details || "")}</td>
    </tr>`;
  }).join("");
  res.send(layout("Item History", `
    <h1>Item History</h1>
    <div class="card">
      <form method="get" action="/yard/item-history" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto auto;">
          <div><label>Item Filter</label><input name="item" value="${esc(itemFilter)}" placeholder="Item code or description" /></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
          <div style="align-self:end;"><a class="btn btn-secondary" href="/yard/item-history">Clear</a></div>
        </div>
      </form>
      <div class="actions" style="margin-top:12px;">
        <a class="btn btn-secondary" href="/yard">Back To Yard</a>
      </div>
      <p class="muted" style="margin-top:12px;">Negative on-hand rows usually mean the posted inventory audit adjustments drove that warehouse/location below the receipt-backed balance. This page shows the transaction trail for the filtered item so you can see the receipts and adjustments behind it.</p>
    </div>
    ${itemFilter ? `
      <div class="card scroll">
        <h3 style="margin-top:0;">Current Inventory Rows</h3>
        <table><tr><th>Item</th><th>Description</th><th>Warehouse</th><th>Location</th><th>Qty On Hand</th><th>Qty OS&D</th></tr>${currentRowMarkup || `<tr><td colspan="6" class="muted">No current inventory rows match that filter.</td></tr>`}</table>
      </div>
      <div class="card scroll">
        <h3 style="margin-top:0;">Transaction History</h3>
        <table><tr><th>Date</th><th>Source</th><th>Item</th><th>Description</th><th>Warehouse</th><th>Location</th><th>Qty</th><th>Affects On-Hand</th><th>On-Hand Effect</th><th>User / Name</th><th>Details</th></tr>${historyMarkup || `<tr><td colspan="11" class="muted">No item history was found for that filter.</td></tr>`}</table>
      </div>
    ` : `<div class="card"><p class="muted">Filter by an item code or description to view the posted history for that item.</p></div>`}
  `, req.user));
}));

app.get("/yard/locations", requireAuth, requirePermission("yard", "view"), async (req, res) => {
  const warehousesRes = await query("select id, name, is_active from warehouses order by name");
  const warehouseLocationsRes = await query(`
    select wl.id, wl.name, wl.is_active, wl.warehouse_id, w.name as warehouse_name
    from warehouse_locations wl
    join warehouses w on w.id = wl.warehouse_id
    order by w.name, wl.name
  `);
  const warehouseOptions = warehousesRes.rows.map((row) => `<option value="${row.id}">${esc(row.name)}</option>`).join("");
  const canManageLocations = req.user.role === "admin" || canAccess(req.user, "settings", "edit");
  const warehouseRows = warehousesRes.rows.map((row) => `
    <tr>
      <td>${esc(normalizeWarehouseName(row.name))}</td>
      <td>${row.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>${canManageLocations ? `<form method="post" action="/settings/warehouses/${row.id}/toggle"><input type="hidden" name="return_to" value="/yard/locations" /><button type="submit">${row.is_active ? "Set Inactive" : "Set Active"}</button></form>` : ""}</td>
    </tr>
  `).join("");
  const locationRows = warehouseLocationsRes.rows.map((row) => `
    <tr>
      <td>${esc(normalizeWarehouseName(row.warehouse_name))}</td>
      <td>${esc(normalizeLocationName(row.name))}</td>
      <td>${row.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>${canManageLocations ? `<form method="post" action="/settings/warehouse-locations/${row.id}/toggle"><input type="hidden" name="return_to" value="/yard/locations" /><button type="submit">${row.is_active ? "Set Inactive" : "Set Active"}</button></form>` : ""}</td>
    </tr>
  `).join("");
  res.send(layout("Locations", `
    <h1>Locations</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-secondary" href="/yard">Back To Yard</a>
      </div>
    </div>
    ${canManageLocations ? `
      <div class="card">
        <h3>Warehouses</h3>
        <form method="post" action="/settings/warehouses/add" class="stack">
          <input type="hidden" name="return_to" value="/yard/locations" />
          <div class="grid">
            <div><label>Warehouse Name</label><input name="name" required /></div>
          </div>
          <div class="actions"><button type="submit">Add Warehouse</button></div>
        </form>
      </div>
      <div class="card">
        <h3>Locations</h3>
        <form method="post" action="/settings/warehouse-locations/add" class="stack">
          <input type="hidden" name="return_to" value="/yard/locations" />
          <div class="grid">
            <div><label>Warehouse</label><select name="warehouse_id" required><option value="">Select warehouse</option>${warehouseOptions}</select></div>
            <div><label>Location Name</label><input name="name" required /></div>
          </div>
          <div class="actions"><button type="submit">Add Location</button></div>
        </form>
      </div>
    ` : ""}
    <div class="card scroll">
      <h3>Warehouse List</h3>
      <table>
        <tr><th>Warehouse</th><th>Status</th><th>Action</th></tr>
        ${warehouseRows || `<tr><td colspan="3" class="muted">No warehouses saved yet.</td></tr>`}
      </table>
    </div>
    <div class="card scroll">
      <h3>Location List</h3>
      <table>
        <tr><th>Warehouse</th><th>Location</th><th>Status</th><th>Action</th></tr>
        ${locationRows || `<tr><td colspan="4" class="muted">No warehouse locations saved yet.</td></tr>`}
      </table>
    </div>
  `, req.user));
});

app.get("/request-access", (req, res) => {
  res.send(requestAccessPage());
});

app.post("/request-access", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) {
    res.status(400).send(requestAccessPage("Email address is required."));
    return;
  }
  const existing = (await query(
    "select id from access_requests where email = $1 and status = 'PENDING' order by id desc limit 1",
    [email]
  )).rows[0];
  if (existing) {
    res.send(requestAccessPage("", "Your request is already pending review."));
    return;
  }
  await withTransaction(async (client) => {
    await client.query("insert into access_requests (email, status) values ($1, 'PENDING')", [email]);
    await auditLog(client, null, "create", "access_request", email, "pending");
  });
  res.send(requestAccessPage("", "Request submitted. An administrator will review it."));
});

app.post("/settings/job-number", requireAuth, requirePermission("settings", "edit"), async (req, res) => {
  const jobNumber = String(req.body.job_number || "").trim().toUpperCase();
  if (!jobNumber) throw new Error("Job number is required.");
  await withTransaction(async (client) => {
    await client.query(`
      insert into app_settings (key, value, updated_at)
      values ('job_number', $1, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
    `, [jobNumber]);
    await auditLog(client, req.user.id, "update", "app_setting", "job_number", jobNumber);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
});

app.post("/settings/vendor-categories", requireAuth, requirePermission("settings", "edit"), async (req, res) => {
  const categories = normalizeCategoryList(req.body.vendor_categories);
  if (categories.length === 0) throw new Error("At least one vendor category is required.");
  await withTransaction(async (client) => {
    await client.query(`
      insert into app_settings (key, value, updated_at)
      values ('vendor_categories', $1, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
    `, [categories.join(",")]);
    await auditLog(client, req.user.id, "update", "app_setting", "vendor_categories", categories.join(", "));
  });
  setVendorCategories(categories);
  res.redirect(getSafeReturnPath(req, "/settings/job-setup"));
});

app.post("/settings/warehouses/add", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const name = normalizeWarehouseName(req.body.name);
  if (!name) throw new Error("Warehouse name is required.");
  await withTransaction(async (client) => {
    const insert = await client.query(`
      insert into warehouses (name, is_active)
      values ($1, true)
      on conflict (name) do update
      set is_active = true
      returning id
    `, [name]);
    await auditLog(client, req.user.id, "create", "warehouse", insert.rows[0].id, name);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
}));

app.post("/settings/warehouses/:id/toggle", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const current = (await client.query("select * from warehouses where id = $1", [req.params.id])).rows[0];
    if (!current) throw new Error("Warehouse not found.");
    const nextState = !current.is_active;
    await client.query("update warehouses set is_active = $2 where id = $1", [req.params.id, nextState]);
    await auditLog(client, req.user.id, nextState ? "activate" : "deactivate", "warehouse", req.params.id, current.name);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
}));

app.post("/settings/warehouse-locations/add", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const warehouseId = Number(req.body.warehouse_id);
  const name = normalizeLocationName(req.body.name);
  if (!warehouseId) throw new Error("Warehouse is required.");
  if (!name) throw new Error("Location name is required.");
  await withTransaction(async (client) => {
    const warehouse = (await client.query("select name from warehouses where id = $1", [warehouseId])).rows[0];
    if (!warehouse) throw new Error("Warehouse not found.");
    const insert = await client.query(`
      insert into warehouse_locations (warehouse_id, name, is_active)
      values ($1, $2, true)
      on conflict (warehouse_id, name) do update
      set is_active = true
      returning id
    `, [warehouseId, name]);
    await auditLog(client, req.user.id, "create", "warehouse_location", insert.rows[0].id, `${warehouse.name}:${name}`);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
}));

app.post("/settings/warehouse-locations/:id/toggle", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const current = (await client.query(`
      select wl.id, wl.name, wl.is_active, w.name as warehouse_name
      from warehouse_locations wl
      join warehouses w on w.id = wl.warehouse_id
      where wl.id = $1
    `, [req.params.id])).rows[0];
    if (!current) throw new Error("Warehouse location not found.");
    const nextState = !current.is_active;
    await client.query("update warehouse_locations set is_active = $2 where id = $1", [req.params.id, nextState]);
    await auditLog(client, req.user.id, nextState ? "activate" : "deactivate", "warehouse_location", req.params.id, `${current.warehouse_name}:${current.name}`);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
}));

app.post("/settings/warehouse-locations/import", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), upload.single("sheet"), asyncHandler(async (req, res) => {
  const rows = parseUploadedRows(req.file, req.body.csv_text).map(normalizeWarehouseLocationImportRow);
  if (rows.length === 0) throw new Error("No rows found.");
  await withTransaction(async (client) => {
    let importedCount = 0;
    for (const row of rows) {
      const warehouseId = Number(row.warehouse_id || 0);
      const warehouseName = normalizeWarehouseName(row.warehouse_name);
      const locationId = Number(row.location_id || 0);
      const locationName = normalizeLocationName(row.location_name);
      const isActive = parseImportActiveFlag(row.is_active, true);
      if (!warehouseId && !warehouseName) continue;
      let warehouse;
      if (warehouseId > 0) {
        warehouse = (await client.query(`
          update warehouses
          set name = coalesce(nullif($2, ''), name), is_active = $3
          where id = $1
          returning id, name
        `, [warehouseId, warehouseName, isActive])).rows[0];
        if (!warehouse) throw new Error(`Warehouse id ${warehouseId} was not found in the import file.`);
      } else {
        warehouse = (await client.query(`
          insert into warehouses (name, is_active)
          values ($1, $2)
          on conflict (name) do update
          set is_active = excluded.is_active
          returning id, name
        `, [warehouseName, isActive])).rows[0];
      }
      if (!locationId && !locationName) {
        importedCount += 1;
        continue;
      }
      if (locationId > 0) {
        const updated = await client.query(`
          update warehouse_locations
          set warehouse_id = $2, name = coalesce(nullif($3, ''), name), is_active = $4
          where id = $1
        `, [locationId, warehouse.id, locationName, isActive]);
        if (!updated.rowCount) throw new Error(`Location id ${locationId} was not found in the import file.`);
      } else {
        await client.query(`
          insert into warehouse_locations (warehouse_id, name, is_active)
          values ($1, $2, $3)
          on conflict (warehouse_id, name) do update
          set is_active = excluded.is_active
        `, [warehouse.id, locationName, isActive]);
      }
      importedCount += 1;
    }
    if (!importedCount) throw new Error("No valid warehouse/location rows were found. Use columns named warehouse and location, or export the current workbook first.");
    await auditLog(client, req.user.id, "import", "warehouse_locations", "settings", `rows=${importedCount}`);
  });
  res.redirect(getSafeReturnPath(req, "/settings/warehouse-setup"));
}));

app.get("/settings/warehouse-locations/export.xlsx", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const rows = (await query(`
    select
      w.id as warehouse_id,
      w.name as warehouse,
      wl.id as location_id,
      coalesce(wl.name, '') as location,
      case when w.is_active and coalesce(wl.is_active, true) then 'active' else 'inactive' end as is_active
    from warehouses w
    left join warehouse_locations wl on wl.warehouse_id = w.id
    order by w.name, wl.name
  `)).rows;
  const worksheetRows = rows.length ? rows : [{
    warehouse_id: "",
    warehouse: "",
    location_id: "",
    location: "",
    is_active: "active"
  }];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(worksheetRows, {
    header: ["warehouse_id", "warehouse", "location_id", "location", "is_active"]
  });
  worksheet["!cols"] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 14 },
    { wch: 28 },
    { wch: 12 }
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "Warehouse Locations");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  await auditLog(pool, req.user.id, "export", "warehouse_locations", "settings", `rows=${rows.length}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="warehouse-locations.xlsx"');
  res.send(buffer);
}));

app.post("/settings/permissions", requireAuth, requireRole(["admin"]), requirePermission("settings", "edit"), asyncHandler(async (req, res) => {
  const nextMatrix = {};
  for (const role of permissionRoles) {
    nextMatrix[role] = {};
    for (const section of permissionSections) {
      const currentDefaults = defaultPermissionMatrix[role]?.[section.key] || {};
      nextMatrix[role][section.key] = {
        ...currentDefaults,
        view: String(req.body[`perm__${role}__${section.key}__view`] || "") === "on",
        edit: String(req.body[`perm__${role}__${section.key}__edit`] || "") === "on"
      };
      if (section.key === "requisitions") {
        nextMatrix[role][section.key].create = String(req.body[`perm__${role}__${section.key}__create`] || "") === "on";
        nextMatrix[role][section.key].verify = String(req.body[`perm__${role}__${section.key}__verify`] || "") === "on";
        nextMatrix[role][section.key].issue = String(req.body[`perm__${role}__${section.key}__issue`] || "") === "on";
        nextMatrix[role][section.key].unverify = String(req.body[`perm__${role}__${section.key}__unverify`] || "") === "on";
        nextMatrix[role][section.key].delete = String(req.body[`perm__${role}__${section.key}__delete`] || "") === "on";
      }
    }
  }
  await withTransaction(async (client) => {
    await client.query(`
      insert into app_settings (key, value, updated_at)
      values ('permission_matrix', $1, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
    `, [JSON.stringify(nextMatrix)]);
    await auditLog(client, req.user.id, "update", "app_setting", "permission_matrix", "updated");
  });
  setPermissionMatrix(nextMatrix);
  res.redirect(getSafeReturnPath(req, "/settings/job-setup"));
}));

app.get("/settings/material-log-imports", requireAuth, requirePermission("settings", "view"), async (req, res) => {
  res.send(layout("Material Log Imports", `
    <h1>Material Log Imports</h1>
    <div class="card">
      <p class="muted">Upload one of your current workbook files to refresh the Material Logs module.</p>
      <form method="post" enctype="multipart/form-data" action="/material-logs/import" class="stack">
        <div class="grid">
          <div><label>Log Type</label><select name="log_type"><option value="receiving">Issue Report</option><option value="mrr">MRR Log</option><option value="fmr">Vendor FMR Log</option></select></div>
          <div><label>Workbook File</label><input type="file" name="sheet" required /></div>
        </div>
        <div class="actions"><button type="submit">Import Workbook</button><a class="btn btn-secondary" href="/settings/job-setup">Back To Job Setup</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/settings/access-requests/:id/approve", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const requestId = Number(req.params.id);
  const username = String(req.body.username || "").trim();
  const tempPassword = String(req.body.temp_password || "");
  const role = String(req.body.role || "buyer").trim();
  if (!username) throw new Error("Username is required.");
  if (!tempPassword) throw new Error("Temporary password is required.");
  if (!["admin", "buyer", "warehouse", "field", "supervisor"].includes(role)) throw new Error("Invalid role.");
  const passwordError = validatePasswordRules(tempPassword);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await bcrypt.hash(tempPassword, 8);
  await withTransaction(async (client) => {
    const requestRecord = (await client.query("select * from access_requests where id = $1 and status = 'PENDING'", [requestId])).rows[0];
    if (!requestRecord) throw new Error("Access request not found.");
    await client.query(
      "insert into users (username, password_hash, role, is_active) values ($1, $2, $3, true)",
      [username, passwordHash, role]
    );
    await client.query(`
      update access_requests
      set status = 'APPROVED',
          approved_by_user_id = $2,
          assigned_username = $3,
          approved_at = now()
      where id = $1
    `, [requestId, req.user.id, username]);
    await auditLog(client, req.user.id, "approve", "access_request", requestId, `${requestRecord.email}|${username}|${role}`);
  });
  res.redirect(getSafeReturnPath(req, "/settings/job-setup"));
}));

app.post("/settings/access-requests/:id/deny", requireAuth, requireRole(["admin"]), async (req, res) => {
  const requestId = Number(req.params.id);
  await withTransaction(async (client) => {
    const requestRecord = (await client.query("select * from access_requests where id = $1 and status = 'PENDING'", [requestId])).rows[0];
    if (!requestRecord) throw new Error("Access request not found.");
    await client.query(`
      update access_requests
      set status = 'DENIED',
          approved_by_user_id = $2,
          approved_at = now()
      where id = $1
    `, [requestId, req.user.id]);
    await auditLog(client, req.user.id, "deny", "access_request", requestId, requestRecord.email);
  });
  res.redirect(getSafeReturnPath(req, "/settings"));
});

app.post("/settings/users/add", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "buyer").trim();
  if (!username) throw new Error("Username is required.");
  if (!password) throw new Error("Password is required.");
  if (!["admin", "buyer", "warehouse", "field", "supervisor"].includes(role)) throw new Error("Invalid role.");
  const passwordError = validatePasswordRules(password);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await bcrypt.hash(password, 8);
  await withTransaction(async (client) => {
    await client.query("insert into users (username, password_hash, role, is_active) values ($1, $2, $3, true)", [username, passwordHash, role]);
    await auditLog(client, req.user.id, "create", "user", username, role);
  });
  res.redirect(getSafeReturnPath(req, "/settings"));
}));

app.post("/settings/users/:id/edit", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "buyer").trim();
  const isActive = String(req.body.is_active || "true") === "true";
  if (!username) throw new Error("Username is required.");
  if (!["admin", "buyer", "warehouse", "field", "supervisor"].includes(role)) throw new Error("Invalid role.");
  let passwordHash = "";
  if (password) {
    const passwordError = validatePasswordRules(password);
    if (passwordError) throw new Error(passwordError);
    passwordHash = await bcrypt.hash(password, 8);
  }
  await withTransaction(async (client) => {
    const current = (await client.query("select id, username, role, is_active from users where id = $1", [userId])).rows[0];
    if (!current) throw new Error("User not found.");
    if (current.role === "admin" && role !== "admin") {
      const adminCount = Number((await client.query("select count(*) from users where role = 'admin'")).rows[0].count);
      if (adminCount <= 1) throw new Error("At least one admin user is required.");
    }
    if (current.role === "admin" && !isActive) {
      const activeAdminCount = Number((await client.query("select count(*) from users where role = 'admin' and is_active = true")).rows[0].count);
      if (activeAdminCount <= 1) throw new Error("At least one active admin user is required.");
    }
    if (req.user.id === userId && !isActive) throw new Error("You cannot deactivate your own user.");
    if (passwordHash) {
      await client.query("update users set username = $2, role = $3, password_hash = $4, is_active = $5 where id = $1", [userId, username, role, passwordHash, isActive]);
    } else {
      await client.query("update users set username = $2, role = $3, is_active = $4 where id = $1", [userId, username, role, isActive]);
    }
    await auditLog(client, req.user.id, "update", "user", userId, `${username}|${role}|${isActive ? "active" : "inactive"}`);
  });
  res.redirect(getSafeReturnPath(req, "/settings/user-management"));
}));

app.get("/settings/users/:id/delete", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  const current = (await query("select id, username, role, is_active, created_at from users where id = $1", [userId])).rows[0];
  if (!current) throw new Error("User not found.");
  if (req.user.id === userId) throw new Error("You cannot deactivate your own user.");
  res.send(layout("Confirm User Deactivation", `
    <h1>Confirm User Deactivation</h1>
    <div class="card">
      <p><strong>User:</strong> ${esc(current.username)}</p>
      <p><strong>Role:</strong> ${esc(current.role)}</p>
      <p><strong>Status:</strong> ${current.is_active ? "Active" : "Inactive"}</p>
      <p class="muted">This will mark the user inactive. They will no longer be able to sign in, but their history will remain in the system.</p>
      <div class="actions">
        <form method="post" action="/settings/users/${current.id}/delete">
          <input type="hidden" name="return_to" value="${esc(getSafeReturnPath(req, "/settings/user-management"))}" />
          <button class="btn btn-danger" type="submit">Confirm Deactivate</button>
        </form>
        <a class="btn btn-secondary" href="${esc(getSafeReturnPath(req, "/settings/user-management"))}">Cancel</a>
      </div>
    </div>
  `, req.user));
}));

app.post("/settings/users/:id/delete", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  if (req.user.id === userId) throw new Error("You cannot deactivate your own user.");
  await withTransaction(async (client) => {
    const current = (await client.query("select id, username, role, is_active from users where id = $1", [userId])).rows[0];
    if (!current) throw new Error("User not found.");
    if (current.role === "admin" && current.is_active) {
      const activeAdminCount = Number((await client.query("select count(*) from users where role = 'admin' and is_active = true")).rows[0].count);
      if (activeAdminCount <= 1) throw new Error("At least one active admin user is required.");
    }
    await client.query("update users set is_active = false where id = $1", [userId]);
    await auditLog(client, req.user.id, "deactivate", "user", userId, current.username);
  });
  res.redirect(getSafeReturnPath(req, "/settings/user-management"));
}));

app.get("/bom", requireAuth, requirePermission("bom", "view"), async (req, res) => {
  const bomNo = String(req.query.bom_no || "").trim();
  const bomName = String(req.query.bom_name || "").trim();
  const bomType = String(req.query.bom_type || "").trim();
  const area = String(req.query.area || "").trim();
  const systemName = String(req.query.system || req.query.system_name || "").trim();
  const status = String(req.query.status || "").trim();
  const jobNumber = await getJobNumber();
  const nextBomNumber = await getNextBomNumber();
  const where = [];
  const params = [];
  if (bomNo) { params.push(`%${bomNo}%`); where.push(`bh.bom_no ilike $${params.length}`); }
  if (bomName) { params.push(`%${bomName}%`); where.push(`coalesce(bh.bom_name, bh.description, '') ilike $${params.length}`); }
  if (bomType) { params.push(bomType); where.push(`bh.bom_type = $${params.length}`); }
  if (area) { params.push(`%${area}%`); where.push(`bh.area ilike $${params.length}`); }
  if (systemName) { params.push(`%${systemName}%`); where.push(`bh.system_name ilike $${params.length}`); }
  if (status) { params.push(status); where.push(`bh.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const boms = (await query(`
    select bh.*, coalesce((select count(*) from bom_lines bl where bl.bom_id = bh.id), 0) as line_count
    from bom_headers bh
    ${whereSql}
    order by bh.id desc
    limit 300
  `, params)).rows;
  const filterTypeOptions = [`<option value="">All Types</option>`].concat(
    bomTypes.map((value) => `<option value="${esc(value)}" ${bomType === value ? "selected" : ""}>${esc(value)}</option>`)
  ).join("");
  const filterStatusOptions = [`<option value="">All Statuses</option>`].concat(
    bomStatuses.map((value) => `<option value="${esc(value)}" ${status === value ? "selected" : ""}>${esc(value)}</option>`)
  ).join("");
  const createTypeOptions = bomTypes.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  const createStatusOptions = bomStatuses.map((value) => `<option value="${esc(value)}" ${value === "DRAFT" ? "selected" : ""}>${esc(value)}</option>`).join("");
  const rows = boms.map((bom) => `<tr>
    <td><a href="/bom/${bom.id}">${esc(bom.bom_name || bom.description || bom.bom_no)}</a></td>
    <td>${esc(bom.bom_no)}</td>
    <td>${esc(bom.job_number)}</td>
    <td>${esc(bom.bom_type)}</td>
    <td>${esc(bom.area || "")}</td>
    <td>${esc(bom.system_name || "")}</td>
    <td>${esc(bom.revision || "")}</td>
    <td>${bom.line_count}</td>
    <td><span class="chip">${esc(bom.status)}</span></td>
  </tr>`).join("");
  res.send(layout("BOMs", `
    <h1>BOM Planning</h1>
    <div class="card">
      <form method="get" action="/bom" class="stack">
        <div class="grid-4">
          <div><label>BOM #</label><input name="bom_no" value="${esc(bomNo)}" /></div>
          <div><label>BOM Name</label><input name="bom_name" value="${esc(bomName)}" /></div>
          <div><label>Type</label><select name="bom_type">${filterTypeOptions}</select></div>
          <div><label>Area</label><input name="area" value="${esc(area)}" /></div>
        </div>
        <div class="grid">
          <div><label>System</label><input name="system" value="${esc(systemName)}" /></div>
          <div><label>Status</label><select name="status">${filterStatusOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Filter BOMs</button><a class="btn btn-secondary" href="/bom">Clear</a><span class="muted">${boms.length} result(s), max 300 shown</span></div>
      </form>
    </div>
    <div class="card">
      <form method="post" action="/bom" class="stack">
        <div class="grid-4">
          <div><label>Job Number</label><input name="job_number" value="${esc(jobNumber)}" readonly /></div>
          <div><label>BOM Number</label><input name="bom_no" value="${esc(nextBomNumber)}" readonly /></div>
          <div><label>BOM Name</label><input name="bom_name" required /></div>
          <div><label>BOM Type</label><select name="bom_type">${createTypeOptions}</select></div>
        </div>
        <div class="grid">
          <div><label>Status</label><select name="status">${createStatusOptions}</select></div>
          <div><label>Area</label><input name="area" /></div>
          <div><label>System</label><input name="system" /></div>
          <div><label>Revision</label><input name="revision" value="0" /></div>
        </div>
        <div><label>Description</label><input name="description" /></div>
        <div><label>Notes</label><textarea name="notes"></textarea></div>
        <div class="actions"><button type="submit">Create BOM</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>BOM Name</th><th>BOM #</th><th>Job</th><th>Type</th><th>Area</th><th>System</th><th>Revision</th><th>Lines</th><th>Status</th></tr>${rows || `<tr><td colspan="9" class="muted">No BOMs match the current filter.</td></tr>`}</table></div>
  `, req.user));
});

app.post("/bom", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const bomId = await withTransaction(async (client) => {
    const jobNumber = String((req.body.job_number || await getJobNumber(client))).trim().toUpperCase();
    const bomNo = String(req.body.bom_no || "").trim() || await getNextBomNumber(client);
    const bomName = String(req.body.bom_name || "").trim();
    if (!bomName) throw new Error("BOM name is required.");
    const insert = await client.query(`
      insert into bom_headers (job_number, bom_no, bom_name, bom_type, area, system_name, revision, status, description, notes, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      returning id
    `, [
      jobNumber,
      bomNo,
      bomName,
      req.body.bom_type || "misc",
      req.body.area || "",
      req.body.system || req.body.system_name || "",
      req.body.revision || "0",
      req.body.status || "DRAFT",
      req.body.description || "",
      req.body.notes || ""
    ]);
    await auditLog(client, req.user.id, "create", "bom_header", insert.rows[0].id, bomNo);
    return insert.rows[0].id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.get("/bom/:id/edit", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const bom = (await query("select * from bom_headers where id = $1", [req.params.id])).rows[0];
  if (!bom) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM not found.</h3></div>`, req.user));
    return;
  }
  const typeOptions = bomTypes.map((value) => `<option value="${esc(value)}" ${bom.bom_type === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  const statusOptions = bomStatuses.map((value) => `<option value="${esc(value)}" ${bom.status === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  res.send(layout("Edit BOM", `
    <h1>Edit BOM</h1>
    <div class="card">
      <form method="post" action="/bom/${bom.id}/edit" class="stack">
        <div class="grid-4">
          <div><label>Job Number</label><input name="job_number" value="${esc(bom.job_number)}" required /></div>
          <div><label>BOM Number</label><input name="bom_no" value="${esc(bom.bom_no)}" required /></div>
          <div><label>BOM Name</label><input name="bom_name" value="${esc(bom.bom_name || "")}" required /></div>
          <div><label>BOM Type</label><select name="bom_type">${typeOptions}</select></div>
        </div>
        <div class="grid">
          <div><label>Status</label><select name="status">${statusOptions}</select></div>
          <div><label>Area</label><input name="area" value="${esc(bom.area || "")}" /></div>
          <div><label>System</label><input name="system" value="${esc(bom.system_name || "")}" /></div>
          <div><label>Revision</label><input name="revision" value="${esc(bom.revision || "")}" /></div>
        </div>
        <div><label>Description</label><input name="description" value="${esc(bom.description || "")}" /></div>
        <div><label>Notes</label><textarea name="notes">${esc(bom.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save BOM</button><a class="btn btn-secondary" href="/bom/${bom.id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/bom/:id/edit", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query(`
      update bom_headers
      set job_number = $2, bom_no = $3, bom_name = $4, bom_type = $5, area = $6, system_name = $7, revision = $8, status = $9, description = $10, notes = $11, updated_at = now()
      where id = $1
    `, [
      req.params.id,
      String(req.body.job_number || "").trim().toUpperCase(),
      String(req.body.bom_no || "").trim(),
      String(req.body.bom_name || "").trim(),
      req.body.bom_type || "misc",
      req.body.area || "",
      req.body.system || req.body.system_name || "",
      req.body.revision || "0",
      req.body.status || "DRAFT",
      req.body.description || "",
      req.body.notes || ""
    ]);
    await auditLog(client, req.user.id, "update", "bom_header", req.params.id, req.body.bom_no || "");
  });
  res.redirect(`/bom/${req.params.id}`);
});

app.get("/bom/:id", requireAuth, async (req, res) => {
  const bom = (await query("select * from bom_headers where id = $1", [req.params.id])).rows[0];
  if (!bom) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM not found.</h3></div>`, req.user));
    return;
  }
  const [importsRes, coverageRes, requisitionSummaryRes] = await Promise.all([
    query(`
      select ib.id, ib.status, ib.inserted_count, ib.updated_count, ib.skipped_count, ib.created_at,
             coalesce((select count(*) from import_batch_errors ibe where ibe.batch_id = ib.id), 0) as error_count
      from import_batches ib
      where ib.entity_type = 'bom_lines' and ib.rfq_id = $1
      order by ib.id desc
      limit 5
    `, [req.params.id]),
    query(`
      select
        count(*) as line_count,
        coalesce(sum(qty_required), 0) as qty_required,
        coalesce(sum(qty_issued), 0) as qty_issued,
        count(*) filter (where planning_status = 'ON_RFQ') as on_rfq_count,
        count(*) filter (where planning_status in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'ISSUED_TO_FIELD', 'CLOSED')) as ordered_count,
        count(*) filter (where planning_status in ('PARTIALLY_RECEIVED', 'RECEIVED', 'ISSUED_TO_FIELD', 'CLOSED')) as received_count
      from bom_lines
      where bom_id = $1
    `, [req.params.id]),
    query(`
      select count(*) as requisition_count, coalesce(sum(mrl.qty_requested), 0) as qty_requested
      from material_requisitions mr
      join material_requisition_lines mrl on mrl.requisition_id = mr.id
      where mr.bom_id = $1
    `, [req.params.id])
  ]);
  const coverage = coverageRes.rows[0];
  const requisitionSummary = requisitionSummaryRes.rows[0];
  const importRows = importsRes.rows.length > 0
      ? importsRes.rows.map((batch) => `<tr><td><a href="/imports/${batch.id}">${batch.id}</a></td><td>${esc(formatShortDateTime(batch.created_at))}</td><td>${esc(batch.status)}</td><td>${batch.inserted_count}</td><td>${batch.updated_count}</td><td>${batch.skipped_count}</td><td>${batch.error_count}</td></tr>`).join("")
    : `<tr><td colspan="7" class="muted">No imports logged yet.</td></tr>`;
  res.send(layout(`BOM ${bom.bom_name || bom.description || bom.bom_no}`, `
    <h1>${esc(bom.bom_name || bom.description || bom.bom_no)}</h1>
    <div class="card">
      <p class="muted">BOM #: ${esc(bom.bom_no)} | Job: ${esc(bom.job_number)} | Type: ${esc(bom.bom_type)} | Area: ${esc(bom.area || "")} | System: ${esc(bom.system_name || "")} | Revision: ${esc(bom.revision || "")} | Status: ${esc(bom.status)}</p>
      <p>${esc(bom.description || "")}</p>
      ${bom.notes ? `<p class="muted">${esc(bom.notes)}</p>` : ""}
      <div class="actions"><a class="btn btn-secondary" href="/bom/${bom.id}/edit">Edit BOM</a><a class="btn btn-secondary" href="/bom/${bom.id}/lines">View BOM Lines</a></div>
    </div>
    <div class="stats">
      <div class="stat"><div>Lines</div><strong>${coverage.line_count}</strong></div>
      <div class="stat"><div>Qty Required</div><strong>${esc(formatQtyDisplay(coverage.qty_required))}</strong></div>
      <div class="stat"><div>Qty Issued</div><strong>${esc(formatQtyDisplay(coverage.qty_issued))}</strong></div>
      <div class="stat"><div>Requisitioned</div><strong>${esc(formatQtyDisplay(requisitionSummary.qty_requested))}</strong></div>
    </div>
    <div class="card">
      <h3>Create RFQ From BOM</h3>
        <p class="muted">Creates an RFQ for BOM lines that are still in planning and marks those lines as <code>ON_RFQ</code>.</p>
      <form method="post" action="/bom/${bom.id}/to-rfq" class="stack">
        <div class="grid">
          <div><label>Project</label><input name="project_name" value="${esc(bom.bom_name || bom.description || bom.bom_no)}" required /></div>
          <div><label>Due Date</label><input type="date" name="due_date" /></div>
        </div>
        <div class="actions"><button type="submit">Create RFQ From BOM Lines</button></div>
      </form>
    </div>
    <div class="card">
      <h3>Upload BOM Lines</h3>
      <p class="muted">CSV/XLSX columns: line_no, item_code, description, material_type, uom, spec, commodity_code, tag_number, iwp_no, iso_no, size_1, size_2, thk_1, thk_2, qty_required, notes</p>
        <form id="bom-lines-import-form" method="post" enctype="multipart/form-data" action="/bom/${bom.id}/lines/import" class="stack">
          <div><label>CSV/XLSX File</label><input id="bom-lines-import-file" type="file" name="sheet" /></div>
          <div><label>Or Paste CSV</label><textarea id="bom-lines-import-text" name="csv_text"></textarea></div>
          <div class="actions"><button type="submit">Import BOM Lines</button></div>
        </form>
        <script>
          (() => {
            const form = document.getElementById("bom-lines-import-form");
            const fileInput = document.getElementById("bom-lines-import-file");
            const textInput = document.getElementById("bom-lines-import-text");
            if (!form || !fileInput || !textInput) return;
            form.addEventListener("submit", (event) => {
              const hasFile = fileInput.files && fileInput.files.length > 0;
              const hasText = textInput.value.trim().length > 0;
              if (hasFile || hasText) return;
              event.preventDefault();
              window.alert("Upload BOM lines or paste CSV before importing.");
            });
          })();
        </script>
      </div>
    <div class="card scroll"><table><tr><th>Batch</th><th>Created</th><th>Status</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Errors</th></tr>${importRows}</table></div>
  `, req.user));
});

app.post("/bom/:id/to-rfq", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const bomId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const bom = (await client.query("select * from bom_headers where id = $1", [bomId])).rows[0];
    if (!bom) throw new Error("BOM not found.");
    const lines = (await client.query(`
      select *
      from bom_lines
      where bom_id = $1 and planning_status = 'PLANNED'
      order by line_no, id
    `, [bomId])).rows;
    if (lines.length === 0) throw new Error("No BOM lines are available to move onto an RFQ.");
    const rfqNo = await getNextRfqNumber(client);
    const rfqInsert = await client.query(`
      insert into rfqs (rfq_no, project_name, due_date, status)
      values ($1, $2, $3, 'OPEN')
      returning id
    `, [rfqNo, req.body.project_name?.trim() || bom.bom_name || bom.description || bom.bom_no, req.body.due_date || null]);
    const newRfqId = rfqInsert.rows[0].id;
    for (const line of lines) {
      let materialItemId;
      const existingItem = await client.query("select id from material_items where item_code = $1", [line.item_code]);
      if (existingItem.rows[0]) {
        materialItemId = existingItem.rows[0].id;
        await client.query(
          "update material_items set description = $2, material_type = $3, uom = $4 where id = $1",
          [materialItemId, line.description, line.material_type || "misc", line.uom || "EA"]
        );
      } else {
        const inserted = await client.query(
          "insert into material_items (item_code, description, material_type, uom) values ($1, $2, $3, $4) returning id",
          [line.item_code, line.description, line.material_type || "misc", line.uom || "EA"]
        );
        materialItemId = inserted.rows[0].id;
      }
      await client.query(`
        insert into rfq_items (rfq_id, bom_line_id, material_item_id, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      `, [newRfqId, line.id, materialItemId, line.spec || "", line.commodity_code || "", line.tag_number || "", line.size_1 || "", line.size_2 || "", line.thk_1 || "", line.thk_2 || "", line.qty_required, line.notes || ""]);
      await client.query(`
        update bom_lines
        set planning_status = 'ON_RFQ', qty_quoted = qty_required, updated_at = now()
        where id = $1
      `, [line.id]);
    }
    await client.query(`
      update bom_headers
      set status = case when status = 'DRAFT' then 'ISSUED_FOR_RFQ' else status end, updated_at = now()
      where id = $1
    `, [bomId]);
    await auditLog(client, req.user.id, "create", "rfq", newRfqId, rfqNo);
    await auditLog(client, req.user.id, "generate_rfq", "bom_header", bomId, rfqNo);
    return newRfqId;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/bom/:id/requisitions", requireAuth, requirePermission("requisitions", "create"), asyncHandler(async (req, res) => {
  const bomId = Number(req.params.id);
  const selectedLineQtys = new Map();
  try {
    const stagedSelection = JSON.parse(String(req.body.staged_selection || "{}"));
    if (stagedSelection && typeof stagedSelection === "object" && !Array.isArray(stagedSelection)) {
      for (const [lineId, qty] of Object.entries(stagedSelection)) {
        const numericLineId = Number(lineId);
        const qtyRequested = parseQtyValue(qty, NaN);
        if (Number.isFinite(numericLineId) && numericLineId > 0 && Number.isFinite(qtyRequested) && qtyRequested > 0) {
          selectedLineQtys.set(numericLineId, qtyRequested);
        }
      }
    }
  } catch {
    // fall back to visible checkbox submission
  }
  for (const value of [].concat(req.body.selected_line_ids || [])) {
    const lineId = Number(value);
    const qtyRequested = parseQtyValue(req.body[`request_qty_${lineId}`], NaN);
    if (Number.isFinite(lineId) && lineId > 0 && Number.isFinite(qtyRequested) && qtyRequested > 0) {
      selectedLineQtys.set(lineId, qtyRequested);
    }
  }
  const selectedLineIds = Array.from(selectedLineQtys.keys());
  if (selectedLineIds.length === 0) throw new Error("Select at least one BOM line for the requisition.");
  const requisitionId = await withTransaction(async (client) => {
    const bom = (await client.query("select * from bom_headers where id = $1", [bomId])).rows[0];
    if (!bom) throw new Error("BOM not found.");
    const requisitionNo = await getNextRequisitionNumber(client);
      const insertReq = await client.query(`
        insert into material_requisitions (requisition_no, bom_id, requested_by_user_id, requested_by_name, iwp_no, iso_no, status, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id
    `, [requisitionNo, bomId, req.user.id, String(req.body.requested_by_name || req.user.username).trim(), req.body.iwp_no || "", req.body.iso_no || "", "REQUESTED", req.body.notes || ""]);
      let createdLineCount = 0;
    for (const lineId of selectedLineIds) {
      const qtyRequested = selectedLineQtys.get(lineId);
      const line = (await client.query(`
        select
          bl.id,
          bl.item_code,
          bl.qty_required,
          bl.qty_issued,
          greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0) - coalesce(alloc.qty_allocated_total, 0), 0) as qty_available
        from bom_lines bl
        left join (
          ${getInventoryTotalsSubquery()}
        ) inv
          on inv.item_code = bl.item_code
         and inv.size_1 = coalesce(bl.size_1, '')
         and inv.size_2 = coalesce(bl.size_2, '')
         and inv.thk_1 = coalesce(bl.thk_1, '')
         and inv.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            item_code,
            coalesce(size_1, '') as size_1,
            coalesce(size_2, '') as size_2,
            coalesce(thk_1, '') as thk_1,
            coalesce(thk_2, '') as thk_2,
            sum(qty_issued) as qty_issued_total
          from bom_lines
          group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
        ) issued
          on issued.item_code = bl.item_code
         and issued.size_1 = coalesce(bl.size_1, '')
         and issued.size_2 = coalesce(bl.size_2, '')
         and issued.thk_1 = coalesce(bl.thk_1, '')
         and issued.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            bl2.item_code,
            coalesce(bl2.size_1, '') as size_1,
            coalesce(bl2.size_2, '') as size_2,
            coalesce(bl2.thk_1, '') as thk_1,
            coalesce(bl2.thk_2, '') as thk_2,
            sum(mrl2.qty_requested) as qty_allocated_total
          from material_requisition_lines mrl2
          join material_requisitions mr2 on mr2.id = mrl2.requisition_id
          join bom_lines bl2 on bl2.id = mrl2.bom_line_id
          where mr2.status = 'VERIFIED'
          group by bl2.item_code, coalesce(bl2.size_1, ''), coalesce(bl2.size_2, ''), coalesce(bl2.thk_1, ''), coalesce(bl2.thk_2, '')
        ) alloc
          on alloc.item_code = bl.item_code
         and alloc.size_1 = coalesce(bl.size_1, '')
         and alloc.size_2 = coalesce(bl.size_2, '')
         and alloc.thk_1 = coalesce(bl.thk_1, '')
         and alloc.thk_2 = coalesce(bl.thk_2, '')
        where bl.id = $1 and bl.bom_id = $2
      `, [lineId, bomId])).rows[0];
      if (!line) continue;
      const remaining = Math.max(num(line.qty_required) - num(line.qty_issued), 0);
      if (qtyRequested <= 0 || qtyRequested > remaining) {
        throw new Error(`Requested qty for ${line.item_code} must be greater than zero and cannot exceed the remaining BOM qty.`);
      }
      if (qtyRequested > num(line.qty_available)) {
        throw new Error(`Requested qty for ${line.item_code} exceeds available received stock.`);
      }
        await client.query(`
          insert into material_requisition_lines (requisition_id, bom_line_id, qty_requested)
          values ($1, $2, $3)
        `, [insertReq.rows[0].id, lineId, qtyRequested]);
        createdLineCount += 1;
      }
    if (createdLineCount === 0) throw new Error("No valid requisition lines were created.");
    await auditLog(client, req.user.id, "create", "material_requisition", insertReq.rows[0].id, requisitionNo);
    return insertReq.rows[0].id;
  });
  res.redirect(`/requisitions/${requisitionId}`);
}));

app.post("/bom/:id/lines/import", requireAuth, requirePermission("bom", "edit"), upload.single("sheet"), async (req, res) => {
  const bomId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "bom_lines",
      rfqId: bomId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const lineNo = String(row.line_no || "").trim();
      const itemCode = String(row.item_code || "").trim();
      const qtyRequired = parseQtyValue(row.qty_required);
      if (!lineNo || !itemCode || qtyRequired <= 0) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "invalid_bom_line", "Line no, item code, and qty_required are required.", row);
        continue;
      }
      const existingLine = await client.query(
        "select id from bom_lines where bom_id = $1 and source_uid = ($2 || '|' || $3)",
        [bomId, lineNo, itemCode]
      );
      if (existingLine.rows[0]) {
        await client.query(`
          update bom_lines
          set item_code = $2, description = $3, material_type = $4, uom = $5, spec = $6, commodity_code = $7, tag_number = $8,
              iwp_no = $9, iso_no = $10, size_1 = $11, size_2 = $12, thk_1 = $13, thk_2 = $14, qty_required = $15, notes = $16, updated_at = now()
          where id = $1
        `, [existingLine.rows[0].id, itemCode, row.description || itemCode, row.material_type || "misc", row.uom || "EA", row.spec || "", row.commodity_code || "", row.tag_number || "", row.iwp_no || row.iwp || "", row.iso_no || row.iso || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qtyRequired, row.notes || ""]);
        updatedCount += 1;
      } else {
        await client.query(`
          insert into bom_lines (bom_id, line_no, item_code, description, material_type, uom, spec, commodity_code, tag_number, iwp_no, iso_no, size_1, size_2, thk_1, thk_2, qty_required, notes, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
        `, [bomId, lineNo, itemCode, row.description || itemCode, row.material_type || "misc", row.uom || "EA", row.spec || "", row.commodity_code || "", row.tag_number || "", row.iwp_no || row.iwp || "", row.iso_no || row.iso || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qtyRequired, row.notes || ""]);
        insertedCount += 1;
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "bom_lines", bomId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.get("/bom-line/:id/edit", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const line = (await query("select bl.*, bh.bom_no from bom_lines bl join bom_headers bh on bh.id = bl.bom_id where bl.id = $1", [req.params.id])).rows[0];
  if (!line) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM line not found.</h3></div>`, req.user));
    return;
  }
  const statusOptions = bomLineStatuses.map((value) => `<option value="${esc(value)}" ${line.planning_status === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  res.send(layout("Edit BOM Line", `
    <h1>Edit BOM Line</h1>
    <div class="card"><strong>BOM:</strong> ${esc(line.bom_no)} | <strong>Line:</strong> ${esc(line.line_no)}</div>
    <div class="card">
      <form method="post" action="/bom-line/${line.id}/edit" class="stack">
        <div class="grid">
          <div><label>Line No</label><input name="line_no" value="${esc(line.line_no)}" required /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(line.item_code)}" required /></div>
          <div><label>Description</label><input name="description" value="${esc(line.description)}" required /></div>
          <div><label>Material Type</label><input name="material_type" value="${esc(line.material_type)}" /></div>
          <div><label>UOM</label><input name="uom" value="${esc(line.uom)}" required /></div>
          <div><label>Qty Required</label><input name="qty_required" value="${esc(formatQtyDisplay(line.qty_required))}" required /></div>
          <div><label>Spec</label><input name="spec" value="${esc(line.spec || "")}" /></div>
          <div><label>Commodity Code</label><input name="commodity_code" value="${esc(line.commodity_code || "")}" /></div>
          <div><label>Tag Number</label><input name="tag_number" value="${esc(line.tag_number || "")}" /></div>
          <div><label>IWP</label><input name="iwp_no" value="${esc(line.iwp_no || "")}" /></div>
          <div><label>ISO</label><input name="iso_no" value="${esc(line.iso_no || "")}" /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(line.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(line.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(line.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(line.thk_2 || "")}" /></div>
          <div><label>Status</label><select name="planning_status">${statusOptions}</select></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(line.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save BOM Line</button><a class="btn btn-secondary" href="/bom/${line.bom_id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/bom-line/:id/edit", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const lineId = Number(req.params.id);
  const bomId = await withTransaction(async (client) => {
    const current = (await client.query("select bom_id from bom_lines where id = $1", [lineId])).rows[0];
    if (!current) throw new Error("BOM line not found.");
    await client.query(`
      update bom_lines
      set line_no = $2, item_code = $3, description = $4, material_type = $5, uom = $6, qty_required = $7,
          spec = $8, commodity_code = $9, tag_number = $10, iwp_no = $11, iso_no = $12, size_1 = $13, size_2 = $14, thk_1 = $15, thk_2 = $16,
          planning_status = $17, notes = $18, updated_at = now()
      where id = $1
    `, [lineId, String(req.body.line_no || "").trim(), req.body.item_code || "", req.body.description || "", req.body.material_type || "misc", req.body.uom || "EA", parseQtyValue(req.body.qty_required), req.body.spec || "", req.body.commodity_code || "", req.body.tag_number || "", req.body.iwp_no || "", req.body.iso_no || "", req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", req.body.planning_status || "PLANNED", req.body.notes || ""]);
    await auditLog(client, req.user.id, "update", "bom_line", lineId, req.body.item_code || "");
    return current.bom_id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.post("/bom-line/:id/delete", requireAuth, requirePermission("bom", "edit"), async (req, res) => {
  const lineId = Number(req.params.id);
  const bomId = await withTransaction(async (client) => {
    const current = (await client.query("select bom_id from bom_lines where id = $1", [lineId])).rows[0];
    if (!current) throw new Error("BOM line not found.");
    await client.query("delete from bom_lines where id = $1", [lineId]);
    await auditLog(client, req.user.id, "delete", "bom_line", lineId, "");
    return current.bom_id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.get("/requisitions/new", requireAuth, requirePermission("requisitions", "create"), async (req, res) => {
  const availableBoms = (await query(`
    select id, bom_no, bom_name, description, status
    from bom_headers
    where bom_type = 'pipe'
    order by id desc
  `)).rows;
  const selectedBomId = Number(req.query.bom_id || availableBoms[0]?.id || 0);
  const selectedBom = availableBoms.find((row) => Number(row.id) === selectedBomId) || null;
  const clearFilters = String(req.query.clear_filters || "") === "1";
  const lineFilter = {
    iwp: clearFilters ? "" : String(req.query.iwp || "").trim(),
    itemCode: clearFilters ? "" : String(req.query.item_code || "").trim(),
    lineNo: clearFilters ? "" : String(req.query.line_no || "").trim(),
    limit: Math.min(Math.max(num(req.query.limit, 250), 50), 1000)
  };
  let stagedSelection = {};
  try {
    const parsed = JSON.parse(String(req.query.staged_selection || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stagedSelection = Object.fromEntries(
        Object.entries(parsed)
          .map(([lineId, qty]) => [String(num(lineId, 0)), parseQtyValue(qty, NaN)])
          .filter(([lineId, qty]) => num(lineId, 0) > 0 && Number.isFinite(qty) && qty > 0)
      );
    }
  } catch {
    stagedSelection = {};
  }
  let filteredCount = 0;
  let lineRows = "";
  if (selectedBom) {
    const lineWhere = ["bom_id = $1"];
    const lineParams = [selectedBom.id];
    if (lineFilter.iwp) { lineParams.push(`%${lineFilter.iwp}%`); lineWhere.push(`coalesce(iwp_no, '') ilike $${lineParams.length}`); }
    if (lineFilter.itemCode) { lineParams.push(`%${lineFilter.itemCode}%`); lineWhere.push(`item_code ilike $${lineParams.length}`); }
    if (lineFilter.lineNo) { lineParams.push(`%${lineFilter.lineNo}%`); lineWhere.push(`line_no ilike $${lineParams.length}`); }
    const lineWhereSql = lineWhere.join(" and ");
    const [linesRes, filteredCountRes] = await Promise.all([
      query(`
        select
          bl.*,
          greatest(bl.qty_required - bl.qty_issued, 0) as qty_remaining,
          coalesce(inv.qty_on_hand, 0) as qty_on_hand,
          greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0) - coalesce(alloc.qty_allocated_total, 0), 0) as qty_available
        from bom_lines bl
        left join (
          ${getInventoryTotalsSubquery()}
        ) inv
          on inv.item_code = bl.item_code
         and inv.size_1 = coalesce(bl.size_1, '')
         and inv.size_2 = coalesce(bl.size_2, '')
         and inv.thk_1 = coalesce(bl.thk_1, '')
         and inv.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            item_code,
            coalesce(size_1, '') as size_1,
            coalesce(size_2, '') as size_2,
            coalesce(thk_1, '') as thk_1,
            coalesce(thk_2, '') as thk_2,
            sum(qty_issued) as qty_issued_total
          from bom_lines
          group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
        ) issued
          on issued.item_code = bl.item_code
         and issued.size_1 = coalesce(bl.size_1, '')
         and issued.size_2 = coalesce(bl.size_2, '')
         and issued.thk_1 = coalesce(bl.thk_1, '')
         and issued.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            bl2.item_code,
            coalesce(bl2.size_1, '') as size_1,
            coalesce(bl2.size_2, '') as size_2,
            coalesce(bl2.thk_1, '') as thk_1,
            coalesce(bl2.thk_2, '') as thk_2,
            sum(mrl2.qty_requested) as qty_allocated_total
          from material_requisition_lines mrl2
          join material_requisitions mr2 on mr2.id = mrl2.requisition_id
          join bom_lines bl2 on bl2.id = mrl2.bom_line_id
          where mr2.status = 'VERIFIED'
          group by bl2.item_code, coalesce(bl2.size_1, ''), coalesce(bl2.size_2, ''), coalesce(bl2.thk_1, ''), coalesce(bl2.thk_2, '')
        ) alloc
          on alloc.item_code = bl.item_code
         and alloc.size_1 = coalesce(bl.size_1, '')
         and alloc.size_2 = coalesce(bl.size_2, '')
         and alloc.thk_1 = coalesce(bl.thk_1, '')
         and alloc.thk_2 = coalesce(bl.thk_2, '')
        where ${lineWhereSql.replace(/\bbom_id\b/g, "bl.bom_id").replace(/\bitem_code\b/g, "bl.item_code").replace(/\bline_no\b/g, "bl.line_no")}
        order by coalesce(bl.iwp_no, ''), bl.line_no, bl.id
        limit ${lineFilter.limit}
      `, lineParams),
      query(`select count(*) as filtered_count from bom_lines where ${lineWhereSql}`, lineParams)
    ]);
    filteredCount = Number(filteredCountRes.rows[0]?.filtered_count || 0);
    lineRows = linesRes.rows.map((line) => `<tr>
      <td><input type="checkbox" name="selected_line_ids" value="${line.id}" ${stagedSelection[String(line.id)] !== undefined ? "checked" : ""} /></td>
      <td>${esc(line.line_no)}</td>
      <td>${esc(line.iwp_no || "")}</td>
      <td>${esc(line.item_code)}</td>
      <td>${esc(line.description)}</td>
      <td>${esc(line.material_type)}</td>
      <td>${esc(formatQtyDisplay(line.qty_required))}</td>
      <td>${esc(formatQtyDisplay(line.qty_issued))}</td>
      <td>${esc(formatQtyDisplay(line.qty_remaining))}</td>
      <td>${esc(formatQtyDisplay(line.qty_available))}</td>
      <td><input name="request_qty_${line.id}" value="${esc(formatQtyDisplay(stagedSelection[String(line.id)] ?? Math.min(num(line.qty_remaining), num(line.qty_available))))}" /></td>
      <td>${esc(line.uom)}</td>
      <td>${esc(line.spec || "")}</td>
      <td>${esc(line.commodity_code || "")}</td>
      <td>${esc(line.tag_number || "")}</td>
      <td>${esc(line.size_1 || "")}</td>
      <td>${esc(line.size_2 || "")}</td>
      <td>${esc(line.thk_1 || "")}</td>
      <td>${esc(line.thk_2 || "")}</td>
      <td>${esc(line.notes || "")}</td>
      <td><span class="chip">${esc(line.planning_status)}</span></td>
      <td><div class="actions"><a class="btn btn-secondary" href="/bom-line/${line.id}/edit">Edit</a></div></td>
    </tr>`).join("");
  }
  const bomOptions = availableBoms.map((row) => `<option value="${row.id}" ${Number(row.id) === selectedBomId ? "selected" : ""}>${esc(row.bom_name || row.description || row.bom_no)} | ${esc(row.bom_no)}</option>`).join("");
  const stagedSelectionJson = escAttr(JSON.stringify(stagedSelection));
  res.send(layout("New Request", `
    <h1>New Material Request</h1>
    <div class="card">
      <form method="get" action="/requisitions/new" class="stack" id="requisition-filter-form">
        <input type="hidden" name="staged_selection" value="${stagedSelectionJson}" id="requisition-filter-staged-selection" />
        <div class="grid">
          <div><label>Piping BOM</label><select name="bom_id">${bomOptions || `<option value="">No piping BOMs found</option>`}</select></div>
          <div><label>Max Rows</label><input name="limit" value="${esc(lineFilter.limit)}" /></div>
          <div><label>IWP</label><input name="iwp" value="${esc(lineFilter.iwp)}" /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(lineFilter.itemCode)}" /></div>
          <div><label>Line No</label><input name="line_no" value="${esc(lineFilter.lineNo)}" /></div>
        </div>
        <div class="actions">
          <button type="submit">Load Lines</button>
          <button class="btn btn-secondary" type="submit" name="clear_filters" value="1">Clear Filter</button>
          <a class="btn btn-secondary" href="/requisitions">Back to Requisitions</a>
        </div>
      </form>
    </div>
    ${selectedBom ? `
      <div class="card">
        <h3>Create Material Requisition</h3>
        <p class="muted">BOM: ${esc(selectedBom.bom_name || selectedBom.description || selectedBom.bom_no)} | ${esc(selectedBom.bom_no)}. Showing up to ${esc(lineFilter.limit)} rows, ${filteredCount} matching the current filter.</p>
        <form method="post" action="/bom/${selectedBom.id}/requisitions" class="stack" id="requisition-create-form">
          <input type="hidden" name="staged_selection" value="${stagedSelectionJson}" id="requisition-create-staged-selection" />
          <div class="grid">
            <div><label>Requested By</label><input name="requested_by_name" value="${esc(req.user.username)}" required /></div>
            <div><label>Status</label><select name="status">${requisitionStatuses.map((value) => `<option value="${esc(value)}" ${value === "REQUESTED" ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></div>
            <div><label>IWP</label><input name="iwp_no" value="${esc(lineFilter.iwp)}" /></div>
          </div>
          <div><label>Notes</label><textarea name="notes"></textarea></div>
          <div class="scroll">
            <table id="requisition-builder-table" class="data-grid">
              <colgroup>
                <col style="width:80px" />
                <col style="width:170px" />
                <col style="width:120px" />
                <col style="width:120px" />
                <col style="width:380px" />
                <col style="width:90px" />
                <col style="width:90px" />
                <col style="width:90px" />
                <col style="width:100px" />
                <col style="width:100px" />
                <col style="width:110px" />
                <col style="width:80px" />
                <col style="width:120px" />
                <col style="width:140px" />
                <col style="width:130px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:180px" />
                <col style="width:120px" />
                <col style="width:140px" />
              </colgroup>
              <tr>
                <th class="nowrap" data-resizable="true">Pick</th>
                <th class="wrap" data-resizable="true">Line</th>
                <th class="nowrap" data-resizable="true">IWP</th>
                <th class="nowrap" data-resizable="true">Item</th>
                <th class="wrap" data-resizable="true">Description</th>
                <th class="nowrap" data-resizable="true">Type</th>
                <th class="nowrap" data-resizable="true">Req Qty</th>
                <th class="nowrap" data-resizable="true">Issued</th>
                <th class="nowrap" data-resizable="true">Remaining</th>
                <th class="nowrap" data-resizable="true">Available</th>
                <th class="nowrap" data-resizable="true">Request</th>
                <th class="nowrap" data-resizable="true">UOM</th>
                <th class="nowrap" data-resizable="true">Spec</th>
                <th class="wrap" data-resizable="true">Commodity Code</th>
                <th class="wrap" data-resizable="true">Tag Number</th>
                <th class="nowrap" data-resizable="true">Size 1</th>
                <th class="nowrap" data-resizable="true">Size 2</th>
                <th class="nowrap" data-resizable="true">Thk 1</th>
                <th class="nowrap" data-resizable="true">Thk 2</th>
                <th class="wrap" data-resizable="true">Notes</th>
                <th class="nowrap" data-resizable="true">Status</th>
                <th class="nowrap" data-resizable="true">Actions</th>
              </tr>
              ${lineRows || `<tr><td colspan="22" class="muted">No BOM lines match the current filter.</td></tr>`}
            </table>
          </div>
          <div class="actions"><button type="submit">Create Material Requisition</button></div>
        </form>
      </div>
      <script>
        enableResizableTable("requisition-builder-table");
        (function () {
          const stagedSelection = ${JSON.stringify(stagedSelection)};
          const rowCheckboxes = Array.from(document.querySelectorAll('input[name="selected_line_ids"]'));
          const filterInput = document.getElementById("requisition-filter-staged-selection");
          const createInput = document.getElementById("requisition-create-staged-selection");
          function syncStagedSelection() {
            rowCheckboxes.forEach((checkbox) => {
              const lineId = String(checkbox.value || "");
              const qtyInput = document.querySelector('input[name="request_qty_' + lineId + '"]');
              delete stagedSelection[lineId];
              if (checkbox.checked && qtyInput) {
                const qty = parseFloat(String(qtyInput.value || "").trim());
                if (Number.isFinite(qty) && qty > 0) stagedSelection[lineId] = qty;
              }
            });
            const payload = JSON.stringify(stagedSelection);
            if (filterInput) filterInput.value = payload;
            if (createInput) createInput.value = payload;
          }
          rowCheckboxes.forEach((checkbox) => {
            checkbox.addEventListener("change", syncStagedSelection);
            const lineId = String(checkbox.value || "");
            const qtyInput = document.querySelector('input[name="request_qty_' + lineId + '"]');
            if (qtyInput) qtyInput.addEventListener("input", syncStagedSelection);
          });
          const filterForm = document.getElementById("requisition-filter-form");
          const createForm = document.getElementById("requisition-create-form");
          if (filterForm) filterForm.addEventListener("submit", syncStagedSelection);
          if (createForm) createForm.addEventListener("submit", syncStagedSelection);
        }());
      </script>
    ` : `<div class="card error"><h3>No Piping BOM Found</h3><p>Select or create a piping BOM first.</p></div>`}
  `, req.user));
});

app.get("/requisitions", requireAuth, requirePermission("requisitions", "view"), async (req, res) => {
  const iwp = String(req.query.iwp || "").trim();
  const status = String(req.query.status || "").trim();
  const where = [];
  const params = [];
  if (iwp) { params.push(`%${iwp}%`); where.push(`coalesce(mr.iwp_no, '') ilike $${params.length}`); }
  if (status) { params.push(status); where.push(`mr.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = (await query(`
    select mr.*, bh.bom_no, bh.bom_name, bh.description as bom_description, count(mrl.id) as line_count, coalesce(sum(mrl.qty_requested), 0) as qty_requested
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    left join material_requisition_lines mrl on mrl.requisition_id = mr.id
    ${whereSql}
    group by mr.id, bh.bom_no, bh.bom_name, bh.description
    order by mr.id desc
    limit 300
  `, params)).rows;
  const tableRows = rows.map((row) => `<tr>
    <td><a href="/requisitions/${row.id}">${esc(row.requisition_no)}</a></td>
    <td>${esc(row.bom_name || row.bom_description || row.bom_no)}</td>
    <td>${esc(row.bom_no)}</td>
    <td>${esc(row.requested_by_name)}</td>
    <td>${esc(row.iwp_no || "")}</td>
    <td>${row.line_count}</td>
    <td>${esc(formatQtyDisplay(row.qty_requested))}</td>
    <td><span class="chip">${esc(row.status)}</span></td>
    <td>${esc(formatShortDateTime(row.created_at))}</td>
    <td>${row.status === "VERIFIED" ? `<a class="btn btn-secondary" target="_blank" href="/requisitions/${row.id}/pick-ticket.pdf">Pick Ticket</a>` : ""}</td>
  </tr>`).join("");
  res.send(layout("Requisitions", `
    <h1>Material Requisitions</h1>
    ${canAccess(req.user, "requisitions", "create") ? `<div class="card">
      <div class="actions"><a class="btn btn-primary" href="/requisitions/new">New Request</a></div>
    </div>` : ""}
    <div class="card">
      <form method="get" action="/requisitions" class="stack">
        <div class="grid">
          <div><label>IWP</label><input name="iwp" value="${esc(iwp)}" /></div>
          <div><label>Status</label><select name="status"><option value="">All Statuses</option>${requisitionStatuses.map((value) => `<option value="${esc(value)}" ${status === value ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></div>
        </div>
        <div class="actions"><button type="submit">Filter Requisitions</button><a class="btn btn-secondary" href="/requisitions">Clear</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Req #</th><th>BOM Name</th><th>BOM #</th><th>Requested By</th><th>IWP</th><th>Lines</th><th>Qty</th><th>Status</th><th>Created</th><th>Actions</th></tr>${tableRows || `<tr><td colspan="10" class="muted">No requisitions yet.</td></tr>`}</table></div>
  `, req.user));
});

app.get("/bom/:id/lines", requireAuth, requirePermission("bom", "view"), asyncHandler(async (req, res) => {
  const bom = (await query("select * from bom_headers where id = $1", [req.params.id])).rows[0];
  if (!bom) throw new Error("BOM not found.");
  const search = String(req.query.search || "").trim();
  const iwp = String(req.query.iwp || "").trim();
  const lineNo = String(req.query.line_no || "").trim();
  const where = ["bl.bom_id = $1"];
  const params = [req.params.id];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(bl.item_code ilike $${params.length} or coalesce(bl.description, '') ilike $${params.length})`);
  }
  if (iwp) {
    params.push(`%${iwp}%`);
    where.push(`coalesce(bl.iwp_no, '') ilike $${params.length}`);
  }
  if (lineNo) {
    params.push(`%${lineNo}%`);
    where.push(`coalesce(bl.line_no, '') ilike $${params.length}`);
  }
  const lines = (await query(`
    select bl.*
    from bom_lines bl
    where ${where.join(" and ")}
    order by coalesce(bl.iwp_no, ''), coalesce(bl.line_no, ''), bl.id
  `, params)).rows;
  const lineRows = lines.map((line) => `<tr>
    <td>${esc(line.line_no)}</td>
    <td>${esc(line.iwp_no || "")}</td>
    <td>${esc(line.item_code)}</td>
    <td>${esc(line.description)}</td>
    <td>${esc(line.material_type || "")}</td>
    <td>${esc(formatQtyDisplay(line.qty_required))}</td>
    <td>${esc(formatQtyDisplay(line.qty_issued))}</td>
    <td>${esc(line.uom || "")}</td>
    <td>${esc(line.spec || "")}</td>
    <td>${esc(line.size_1 || "")}</td>
    <td>${esc(line.size_2 || "")}</td>
    <td>${esc(line.thk_1 || "")}</td>
    <td>${esc(line.thk_2 || "")}</td>
    <td><span class="chip">${esc(line.planning_status || "")}</span></td>
    <td><div class="actions"><a class="btn btn-secondary" href="/bom-line/${line.id}/edit">Edit</a></div></td>
  </tr>`).join("");
  res.send(layout(`BOM Lines ${bom.bom_name || bom.description || bom.bom_no}`, `
    <h1>BOM Lines</h1>
    <div class="card">
      <p class="muted">BOM: <a href="/bom/${bom.id}">${esc(bom.bom_name || bom.description || bom.bom_no)}</a> | BOM #: ${esc(bom.bom_no)} | Type: ${esc(bom.bom_type)} | Status: ${esc(bom.status)}</p>
      <div class="actions"><a class="btn btn-secondary" href="/bom/${bom.id}">Back to BOM</a></div>
    </div>
    <div class="card">
      <form method="get" action="/bom/${bom.id}/lines" class="stack">
        <div class="grid">
          <div><label>Search</label><input name="search" value="${esc(search)}" /></div>
          <div><label>IWP</label><input name="iwp" value="${esc(iwp)}" /></div>
          <div><label>Line No</label><input name="line_no" value="${esc(lineNo)}" /></div>
        </div>
        <div class="actions"><button type="submit">Filter Lines</button><a class="btn btn-secondary" href="/bom/${bom.id}/lines">Clear</a><span class="muted">${lines.length} line(s)</span></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Line</th><th>IWP</th><th>Item</th><th>Description</th><th>Type</th><th>Qty Req</th><th>Qty Issued</th><th>UOM</th><th>Spec</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Status</th><th>Actions</th></tr>${lineRows || `<tr><td colspan="15" class="muted">No BOM lines found.</td></tr>`}</table></div>
  `, req.user));
}));

app.get("/requisitions/:id", requireAuth, requirePermission("requisitions", "view"), async (req, res) => {
  const header = (await query(`
    select mr.*, bh.bom_no, bh.bom_name, bh.description as bom_description
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    where mr.id = $1
  `, [req.params.id])).rows[0];
  if (!header) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Requisition not found.</h3></div>`, req.user));
    return;
  }
  const lines = (await query(`
    select mrl.qty_requested, mrl.qty_issued, bl.line_no, bl.iwp_no, bl.item_code, bl.description, bl.uom, bl.spec, bl.size_1, bl.size_2, bl.thk_1, bl.thk_2
    from material_requisition_lines mrl
    join bom_lines bl on bl.id = mrl.bom_line_id
    where mrl.requisition_id = $1
    order by bl.line_no, bl.id
  `, [req.params.id])).rows;
  const lineRows = lines.map((line) => `<tr>
    <td>${esc(line.line_no)}</td>
    <td>${esc(line.iwp_no || "")}</td>
    <td>${esc(line.item_code)}</td>
    <td>${esc(line.description)}</td>
    <td>${esc(formatQtyDisplay(line.qty_requested))}</td>
    <td>${esc(formatQtyDisplay(line.qty_issued))}</td>
    <td>${esc(line.uom)}</td>
    <td>${esc(line.spec || "")}</td>
    <td>${esc(line.size_1 || "")}</td>
    <td>${esc(line.size_2 || "")}</td>
    <td>${esc(line.thk_1 || "")}</td>
    <td>${esc(line.thk_2 || "")}</td>
  </tr>`).join("");
  const headerActions = [];
  if (canEditRequisition(req.user, header)) {
    headerActions.push(`<a class="btn btn-secondary" href="/requisitions/${header.id}/edit">Edit Request</a>`);
  }
  if (header.status === "REQUESTED" && canAccess(req.user, "requisitions", "verify")) {
    headerActions.push(`<form method="post" action="/requisitions/${header.id}/verify"><button type="submit">Verify Request</button></form>`);
  }
  if (header.status === "VERIFIED") {
    headerActions.push(`<a class="btn btn-secondary" target="_blank" href="/requisitions/${header.id}/pick-ticket.pdf">Open Pick Ticket PDF</a>`);
    if (canAccess(req.user, "requisitions", "unverify")) {
      headerActions.push(`<form method="post" action="/requisitions/${header.id}/unverify"><button class="btn btn-secondary" type="submit">Set To Un-Verified</button></form>`);
    }
    if (canAccess(req.user, "requisitions", "issue")) {
      headerActions.push(`<form method="post" action="/requisitions/${header.id}/issue"><button type="submit">Issue To Field</button></form>`);
    }
  }
  if (req.user?.role === "admin" && header.status !== "CANCELLED") {
    headerActions.push(`<form method="post" action="/requisitions/${header.id}/cancel" onsubmit="return confirm('Cancel this requisition? The record will be kept. If it was issued, BOM issued quantities will be rolled back.');"><button class="btn btn-danger" type="submit">Cancel Requisition</button></form>`);
  }
  res.send(layout(`Requisition ${header.requisition_no}`, `
    <h1>Requisition ${esc(header.requisition_no)}</h1>
    <div class="card">
      <p class="muted">BOM: <a href="/bom/${header.bom_id}">${esc(header.bom_name || header.bom_description || header.bom_no)}</a> | BOM #: ${esc(header.bom_no)} | Requested By: ${esc(header.requested_by_name)} | Status: ${esc(header.status)} | Created: ${esc(formatShortDateTime(header.created_at))}</p>
      <p class="muted">IWP: ${esc(header.iwp_no || "")}</p>
      ${header.notes ? `<p class="muted">${esc(header.notes)}</p>` : ""}
      ${headerActions.length ? `<div class="actions">${headerActions.join("")}</div>` : ""}
    </div>
    <div class="card scroll"><table><tr><th>Line</th><th>IWP</th><th>Item</th><th>Description</th><th>Qty Requested</th><th>Qty Issued</th><th>UOM</th><th>Spec</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th></tr>${lineRows || `<tr><td colspan="12" class="muted">No lines on this requisition.</td></tr>`}</table></div>
  `, req.user));
});

app.get("/requisitions/:id/pick-ticket.pdf", requireAuth, requirePermission("requisitions", "view"), asyncHandler(async (req, res) => {
  const header = (await query(`
    select mr.*, bh.bom_no, bh.bom_name, bh.description as bom_description
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    where mr.id = $1
  `, [req.params.id])).rows[0];
  if (!header) throw new Error("Requisition not found.");
  if (header.status !== "VERIFIED") throw new Error("Pick tickets are only available for verified requisitions.");
  const lines = (await query(`
    select mrl.qty_requested, bl.line_no, bl.iwp_no, bl.iso_no, bl.item_code, bl.description, bl.uom,
           coalesce(bl.size_1, '') as size_1, coalesce(bl.size_2, '') as size_2,
           coalesce(bl.thk_1, '') as thk_1, coalesce(bl.thk_2, '') as thk_2
    from material_requisition_lines mrl
    join bom_lines bl on bl.id = mrl.bom_line_id
    where mrl.requisition_id = $1
    order by bl.line_no, bl.id
  `, [req.params.id])).rows;

  const inventoryRows = (await query(`
    select
      item_code,
      coalesce(size_1, '') as size_1,
      coalesce(size_2, '') as size_2,
      coalesce(thk_1, '') as thk_1,
      coalesce(thk_2, '') as thk_2,
      warehouse,
      location,
      qty_on_hand
    from (${getInventoryByLocationSubquery()}) inventory_by_location
    order by warehouse, location
  `)).rows;
  const issuedRows = (await query(`
    select
      item_code,
      coalesce(size_1, '') as size_1,
      coalesce(size_2, '') as size_2,
      coalesce(thk_1, '') as thk_1,
      coalesce(thk_2, '') as thk_2,
      sum(qty_issued) as qty_issued_total
    from bom_lines
    group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
  `)).rows;

  const inventoryMap = new Map();
  for (const row of inventoryRows) {
    const key = [row.item_code, row.size_1, row.size_2, row.thk_1, row.thk_2].join("|");
    if (!inventoryMap.has(key)) inventoryMap.set(key, []);
    inventoryMap.get(key).push({
      warehouse: row.warehouse,
      location: row.location,
      qty_available: parseQtyValue(row.qty_on_hand || 0)
    });
  }
  const issuedMap = new Map();
  for (const row of issuedRows) {
    issuedMap.set([row.item_code, row.size_1, row.size_2, row.thk_1, row.thk_2].join("|"), Number(row.qty_issued_total || 0));
  }

  for (const [key, locations] of inventoryMap.entries()) {
    let issuedRemaining = issuedMap.get(key) || 0;
    for (const location of locations) {
      if (issuedRemaining <= 0) break;
      const consumed = Math.min(issuedRemaining, location.qty_available);
      location.qty_available -= consumed;
      issuedRemaining -= consumed;
    }
  }

  const printableLines = lines.map((line) => {
    const key = [line.item_code, line.size_1, line.size_2, line.thk_1, line.thk_2].join("|");
    const locationRows = inventoryMap.get(key) || [];
    const pickLocation = buildPickLocationPlan(locationRows, line.qty_requested);
    let qtyToReserve = Number(line.qty_requested || 0);
    for (const location of locationRows) {
      if (qtyToReserve <= 0) break;
      const consumed = Math.min(qtyToReserve, location.qty_available);
      location.qty_available -= consumed;
      qtyToReserve -= consumed;
    }
    return { ...line, pick_location: pickLocation };
  });

  const pdfBuffer = buildPickTicketPdf(header, printableLines);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=\"${String(header.requisition_no || "pick-ticket").replace(/[^A-Za-z0-9._-]/g, "_")}-pick-ticket.pdf\"`);
  res.send(pdfBuffer);
}));

app.get("/material-logs/mrr/:id/form.pdf", requireAuth, requirePermission("material_logs", "view"), asyncHandler(async (req, res) => {
  const [headerRes, poReceiptLines, manualLines, linkedFmrRes, jobNumber] = await Promise.all([
    query(`
      select
        m.*,
        coalesce(po.po_no, m.po_number) as effective_po_number
      from mrr_logs m
      left join purchase_orders po on po.id = m.app_po_id
      where m.id = $1
    `, [req.params.id]),
    query(`
      select
        r.id,
        coalesce(pl.po_line, '') as po_line,
        coalesce(mi.item_code, '') as item_code,
        coalesce(mi.description, '') as description,
        coalesce(pl.qty_ordered, 0) as ordered_qty,
        coalesce(r.qty_received, 0) as received_qty,
        coalesce(r.warehouse, '') as warehouse,
        coalesce(r.location, '') as location,
        coalesce(r.osd_status, '') as osd_status,
        coalesce(r.osd_notes, '') as notes
      from receipts r
      join po_lines pl on pl.id = r.po_line_id
      join material_items mi on mi.id = pl.material_item_id
      where r.mrr_log_id = $1
      order by r.id
    `, [req.params.id]),
    query(`
      select
        mrl.id,
        coalesce(mrl.po_position, '') as po_line,
        coalesce(mrl.item_code, '') as item_code,
        coalesce(mrl.description, '') as description,
        0 as ordered_qty,
        coalesce(mrl.received_qty, 0) as received_qty,
        coalesce(mrl.warehouse, '') as warehouse,
        coalesce(mrl.location, '') as location,
        coalesce(mrl.received_status, '') as osd_status,
        coalesce(mrl.comments, '') as notes
      from material_receiving_logs mrl
      where coalesce(mrl.mrr_number, '') = (
        select coalesce(mrr_number, '') from mrr_logs where id = $1
      )
      order by coalesce(mrl.legacy_row_id, mrl.id)
    `, [req.params.id]),
    query(`
      select fmr_number, container_no
      from fmr_logs
      where coalesce(mrr_number, '') = (
        select coalesce(mrr_number, '') from mrr_logs where id = $1
      )
      order by id
      limit 1
    `, [req.params.id]),
    getJobNumber()
  ]);
  const header = headerRes.rows[0];
  if (!header) throw new Error("MRR log row not found.");
  const linkedFmr = linkedFmrRes.rows[0] || {};
  const deliveryMatch = String(linkedFmr.fmr_number || "").match(/^FMR-([A-Z0-9]+)-/i);
  const printableLines = [...poReceiptLines.rows, ...manualLines.rows].map((row) => ({
    item_code: row.item_code || "",
    description: header.material_description || row.description || "",
    qty: formatQtyDisplay(row.received_qty),
    location: [row.warehouse, row.location].filter(Boolean).join(" / "),
    grid: "",
    status: row.osd_status || "",
    ordered: row.ordered_qty ? formatQtyDisplay(row.ordered_qty) : "",
    shipped: row.ordered_qty ? formatQtyDisplay(row.ordered_qty) : "",
    received: formatQtyDisplay(row.received_qty),
    discrepancy: [row.osd_status && row.osd_status !== "OK" ? row.osd_status : "", row.notes || ""].filter(Boolean).join(" | ")
  }));
  const pdfBuffer = buildMrrFormPdf({
    mrr_number: header.mrr_number || "",
    vendor_name: header.vendor_name || "",
    po_number: header.effective_po_number || "",
    pick_ticket: header.pick_ticket || "",
    received_date: header.received_date || "",
    received_by: header.received_by || "",
    load_number: header.load_number || "",
    notes: header.notes || "",
    container_type: "",
    material_description: header.material_description || ""
  }, printableLines, {
    jobNumber,
    deliveryLocation: deliveryMatch?.[1] || "KEQ3",
    fmrNumber: linkedFmr.fmr_number || ""
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${String(header.mrr_number || "MRR").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`);
  res.send(pdfBuffer);
}));

app.post("/requisitions/:id/verify", requireAuth, requirePermission("requisitions", "verify"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status !== "REQUESTED") throw new Error("Only requested requisitions can be verified.");
    await client.query(`
      update material_requisitions
      set status = 'VERIFIED',
          verified_at = now(),
          verified_by_user_id = $2
      where id = $1
    `, [req.params.id, req.user.id]);
    await auditLog(client, req.user.id, "verify", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.get("/requisitions/:id/edit", requireAuth, requirePermission("requisitions", "edit"), asyncHandler(async (req, res) => {
  const header = (await query(`
    select mr.*, bh.bom_no, bh.bom_name, bh.description as bom_description
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    where mr.id = $1
  `, [req.params.id])).rows[0];
  if (!header) throw new Error("Requisition not found.");
  if (!canEditRequisition(req.user, header)) throw new Error("Only requested requisitions can be edited.");
  const lines = (await query(`
    select
      mrl.id as requisition_line_id,
      mrl.qty_requested,
      bl.id as bom_line_id,
      bl.line_no,
      bl.iwp_no,
      bl.item_code,
      bl.description,
      bl.uom,
      bl.qty_required,
      bl.qty_issued,
      greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0) - coalesce(alloc.qty_allocated_total, 0), 0) as qty_available
    from material_requisition_lines mrl
    join bom_lines bl on bl.id = mrl.bom_line_id
    left join (
      ${getInventoryTotalsSubquery()}
    ) inv
      on inv.item_code = bl.item_code
     and inv.size_1 = coalesce(bl.size_1, '')
     and inv.size_2 = coalesce(bl.size_2, '')
     and inv.thk_1 = coalesce(bl.thk_1, '')
     and inv.thk_2 = coalesce(bl.thk_2, '')
    left join (
      select
        item_code,
        coalesce(size_1, '') as size_1,
        coalesce(size_2, '') as size_2,
        coalesce(thk_1, '') as thk_1,
        coalesce(thk_2, '') as thk_2,
        sum(qty_issued) as qty_issued_total
      from bom_lines
      group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
    ) issued
      on issued.item_code = bl.item_code
     and issued.size_1 = coalesce(bl.size_1, '')
     and issued.size_2 = coalesce(bl.size_2, '')
     and issued.thk_1 = coalesce(bl.thk_1, '')
     and issued.thk_2 = coalesce(bl.thk_2, '')
    left join (
      select
        bl2.item_code,
        coalesce(bl2.size_1, '') as size_1,
        coalesce(bl2.size_2, '') as size_2,
        coalesce(bl2.thk_1, '') as thk_1,
        coalesce(bl2.thk_2, '') as thk_2,
        sum(mrl2.qty_requested) as qty_allocated_total
      from material_requisition_lines mrl2
      join material_requisitions mr2 on mr2.id = mrl2.requisition_id
      join bom_lines bl2 on bl2.id = mrl2.bom_line_id
      where mr2.status = 'VERIFIED'
      group by bl2.item_code, coalesce(bl2.size_1, ''), coalesce(bl2.size_2, ''), coalesce(bl2.thk_1, ''), coalesce(bl2.thk_2, '')
    ) alloc
      on alloc.item_code = bl.item_code
     and alloc.size_1 = coalesce(bl.size_1, '')
     and alloc.size_2 = coalesce(bl.size_2, '')
     and alloc.thk_1 = coalesce(bl.thk_1, '')
     and alloc.thk_2 = coalesce(bl.thk_2, '')
    where mrl.requisition_id = $1
    order by bl.line_no, bl.id
  `, [req.params.id])).rows;
  const lineRows = lines.map((line) => {
    const maxQty = Math.min(Math.max(num(line.qty_required) - num(line.qty_issued), 0), num(line.qty_available) + num(line.qty_requested));
    return `<tr>
      <td>${esc(line.line_no)}</td>
      <td>${esc(line.iwp_no || "")}</td>
      <td>${esc(line.item_code)}</td>
      <td>${esc(line.description)}</td>
      <td>${esc(formatQtyDisplay(line.qty_required))}</td>
      <td>${esc(formatQtyDisplay(line.qty_issued))}</td>
      <td>${esc(formatQtyDisplay(line.qty_available))}</td>
      <td>${esc(line.uom)}</td>
      <td><input name="qty_requested_${line.requisition_line_id}" value="${esc(formatQtyDisplay(line.qty_requested))}" /></td>
      <td><button class="btn btn-danger" type="submit" name="remove_line_id" value="${line.requisition_line_id}">Remove</button></td>
      <td class="muted">Max ${esc(formatQtyDisplay(maxQty))}</td>
    </tr>`;
  }).join("");
  res.send(layout(`Edit ${header.requisition_no}`, `
    <h1>Edit Requisition ${esc(header.requisition_no)}</h1>
    <div class="card">
      <p class="muted">BOM: ${esc(header.bom_name || header.bom_description || header.bom_no)} | BOM #: ${esc(header.bom_no)} | Status: ${esc(header.status)}</p>
      <form method="post" action="/requisitions/${header.id}/edit" class="stack">
        <div class="grid">
          <div><label>Requested By</label><input name="requested_by_name" value="${esc(header.requested_by_name)}" required /></div>
          <div><label>IWP</label><input name="iwp_no" value="${esc(header.iwp_no || "")}" /></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(header.notes || "")}</textarea></div>
        <div class="card scroll"><table><tr><th>Line</th><th>IWP</th><th>Item</th><th>Description</th><th>Req Qty</th><th>Issued</th><th>Available</th><th>UOM</th><th>New Qty</th><th>Remove</th><th>Limit</th></tr>${lineRows || `<tr><td colspan="11" class="muted">No lines on this requisition.</td></tr>`}</table></div>
        <div class="actions"><button type="submit">Save Requisition</button><a class="btn btn-secondary" href="/requisitions/${header.id}">Back</a></div>
      </form>
    </div>
  `, req.user));
}));

app.post("/requisitions/:id/edit", requireAuth, requirePermission("requisitions", "edit"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (!canEditRequisition(req.user, header)) throw new Error("Only requested requisitions can be edited.");
    await client.query(`
      update material_requisitions
      set requested_by_name = $2, iwp_no = $3, notes = $4
      where id = $1
    `, [req.params.id, String(req.body.requested_by_name || "").trim(), req.body.iwp_no || "", req.body.notes || ""]);
    const lines = (await client.query(`
      select
        mrl.id as requisition_line_id,
        mrl.qty_requested,
        bl.id as bom_line_id,
        bl.item_code,
        bl.qty_required,
        bl.qty_issued,
        greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0) - coalesce(alloc.qty_allocated_total, 0), 0) as qty_available
      from material_requisition_lines mrl
      join bom_lines bl on bl.id = mrl.bom_line_id
      left join (
        ${getInventoryTotalsSubquery()}
      ) inv
        on inv.item_code = bl.item_code
       and inv.size_1 = coalesce(bl.size_1, '')
       and inv.size_2 = coalesce(bl.size_2, '')
       and inv.thk_1 = coalesce(bl.thk_1, '')
       and inv.thk_2 = coalesce(bl.thk_2, '')
      left join (
        select
          item_code,
          coalesce(size_1, '') as size_1,
          coalesce(size_2, '') as size_2,
          coalesce(thk_1, '') as thk_1,
          coalesce(thk_2, '') as thk_2,
          sum(qty_issued) as qty_issued_total
        from bom_lines
        group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
      ) issued
        on issued.item_code = bl.item_code
       and issued.size_1 = coalesce(bl.size_1, '')
       and issued.size_2 = coalesce(bl.size_2, '')
       and issued.thk_1 = coalesce(bl.thk_1, '')
       and issued.thk_2 = coalesce(bl.thk_2, '')
      left join (
        select
          bl2.item_code,
          coalesce(bl2.size_1, '') as size_1,
          coalesce(bl2.size_2, '') as size_2,
          coalesce(bl2.thk_1, '') as thk_1,
          coalesce(bl2.thk_2, '') as thk_2,
          sum(mrl2.qty_requested) as qty_allocated_total
        from material_requisition_lines mrl2
        join material_requisitions mr2 on mr2.id = mrl2.requisition_id
        join bom_lines bl2 on bl2.id = mrl2.bom_line_id
        where mr2.status = 'VERIFIED'
        group by bl2.item_code, coalesce(bl2.size_1, ''), coalesce(bl2.size_2, ''), coalesce(bl2.thk_1, ''), coalesce(bl2.thk_2, '')
      ) alloc
        on alloc.item_code = bl.item_code
       and alloc.size_1 = coalesce(bl.size_1, '')
       and alloc.size_2 = coalesce(bl.size_2, '')
       and alloc.thk_1 = coalesce(bl.thk_1, '')
       and alloc.thk_2 = coalesce(bl.thk_2, '')
      where mrl.requisition_id = $1
    `, [req.params.id])).rows;
    const removeLineId = Number(req.body.remove_line_id || 0);
    for (const line of lines) {
      if (removeLineId && line.requisition_line_id === removeLineId) {
        await client.query("delete from material_requisition_lines where id = $1", [removeLineId]);
        continue;
      }
      const requestedQty = parseQtyValue(req.body[`qty_requested_${line.requisition_line_id}`]);
      if (requestedQty <= 0) throw new Error(`Requested qty for ${line.item_code} must be greater than zero.`);
      const maxQty = Math.min(Math.max(num(line.qty_required) - num(line.qty_issued), 0), num(line.qty_available) + num(line.qty_requested));
      if (requestedQty > maxQty) throw new Error(`Requested qty for ${line.item_code} exceeds available stock.`);
      await client.query("update material_requisition_lines set qty_requested = $2 where id = $1", [line.requisition_line_id, requestedQty]);
    }
    const remainingCount = Number((await client.query("select count(*) from material_requisition_lines where requisition_id = $1", [req.params.id])).rows[0].count);
    if (remainingCount <= 0) throw new Error("At least one line is required on the requisition.");
    await auditLog(client, req.user.id, "update", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.post("/requisitions/:id/unverify", requireAuth, requirePermission("requisitions", "unverify"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status !== "VERIFIED") throw new Error("Only verified requisitions can be set to un-verified.");
    await client.query(`
      update material_requisitions
      set status = 'REQUESTED',
          verified_at = null,
          verified_by_user_id = null
      where id = $1
    `, [req.params.id]);
    await auditLog(client, req.user.id, "unverify", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.post("/requisitions/:id/issue", requireAuth, requirePermission("requisitions", "issue"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status !== "VERIFIED") throw new Error("Requisition must be verified before issue.");
    const lines = (await client.query(`
      select
        mrl.id as requisition_line_id,
        mrl.qty_requested,
        bl.id as bom_line_id,
        bl.item_code,
        bl.qty_required,
        bl.qty_issued,
        greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0) - coalesce(alloc.qty_allocated_total, 0), 0) as qty_available
      from material_requisition_lines mrl
      join bom_lines bl on bl.id = mrl.bom_line_id
      left join (
        ${getInventoryTotalsSubquery()}
      ) inv
        on inv.item_code = bl.item_code
       and inv.size_1 = coalesce(bl.size_1, '')
       and inv.size_2 = coalesce(bl.size_2, '')
       and inv.thk_1 = coalesce(bl.thk_1, '')
       and inv.thk_2 = coalesce(bl.thk_2, '')
      left join (
        select
          item_code,
          coalesce(size_1, '') as size_1,
          coalesce(size_2, '') as size_2,
          coalesce(thk_1, '') as thk_1,
          coalesce(thk_2, '') as thk_2,
          sum(qty_issued) as qty_issued_total
        from bom_lines
        group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
      ) issued
        on issued.item_code = bl.item_code
       and issued.size_1 = coalesce(bl.size_1, '')
       and issued.size_2 = coalesce(bl.size_2, '')
       and issued.thk_1 = coalesce(bl.thk_1, '')
       and issued.thk_2 = coalesce(bl.thk_2, '')
      left join (
        select
          bl2.item_code,
          coalesce(bl2.size_1, '') as size_1,
          coalesce(bl2.size_2, '') as size_2,
          coalesce(bl2.thk_1, '') as thk_1,
          coalesce(bl2.thk_2, '') as thk_2,
          sum(mrl2.qty_requested) as qty_allocated_total
        from material_requisition_lines mrl2
        join material_requisitions mr2 on mr2.id = mrl2.requisition_id
        join bom_lines bl2 on bl2.id = mrl2.bom_line_id
        where mr2.status = 'VERIFIED' and mr2.id <> $2
        group by bl2.item_code, coalesce(bl2.size_1, ''), coalesce(bl2.size_2, ''), coalesce(bl2.thk_1, ''), coalesce(bl2.thk_2, '')
      ) alloc
        on alloc.item_code = bl.item_code
       and alloc.size_1 = coalesce(bl.size_1, '')
       and alloc.size_2 = coalesce(bl.size_2, '')
       and alloc.thk_1 = coalesce(bl.thk_1, '')
       and alloc.thk_2 = coalesce(bl.thk_2, '')
      where mrl.requisition_id = $1
      order by bl.line_no, bl.id
    `, [req.params.id, req.params.id])).rows;
    if (lines.length === 0) throw new Error("No requisition lines found.");
    for (const line of lines) {
      if (num(line.qty_requested) > num(line.qty_available)) {
        throw new Error(`Cannot issue ${line.item_code}; requested qty exceeds available stock.`);
      }
    }
    for (const line of lines) {
      await client.query(`
        update bom_lines
        set qty_issued = qty_issued + $2,
            planning_status = case
              when qty_issued + $2 >= qty_required then 'ISSUED_TO_FIELD'
              else planning_status
            end,
            updated_at = now()
        where id = $1
      `, [line.bom_line_id, line.qty_requested]);
      await client.query(`
        update material_requisition_lines
        set qty_issued = qty_requested
        where id = $1
      `, [line.requisition_line_id]);
    }
    await client.query(`
      update material_requisitions
      set status = 'ISSUED',
          issued_at = now(),
          issued_by_user_id = $2
      where id = $1
    `, [req.params.id, req.user.id]);
    await auditLog(client, req.user.id, "issue", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.post("/requisitions/:id/cancel", requireAuth, requirePermission("requisitions", "delete"), asyncHandler(async (req, res) => {
  if (req.user?.role !== "admin") throw new Error("Only admins can cancel requisitions.");
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status === "CANCELLED") return;
    const lines = (await client.query(`
      select mrl.bom_line_id, mrl.qty_issued, bl.planning_status, bl.qty_required, bl.qty_issued as bom_qty_issued
      from material_requisition_lines mrl
      join bom_lines bl on bl.id = mrl.bom_line_id
      where mrl.requisition_id = $1
    `, [req.params.id])).rows;
    for (const line of lines) {
      const issuedRollback = num(line.qty_issued);
      if (issuedRollback <= 0) continue;
      const nextIssued = Math.max(num(line.bom_qty_issued) - issuedRollback, 0);
      let nextStatus = line.planning_status;
      if (line.planning_status === "ISSUED_TO_FIELD" && nextIssued < num(line.qty_required)) {
        nextStatus = nextIssued > 0 ? "PARTIALLY_RECEIVED" : "RECEIVED";
      }
      await client.query(`
        update bom_lines
        set qty_issued = $2,
            planning_status = $3,
            updated_at = now()
        where id = $1
      `, [line.bom_line_id, nextIssued, nextStatus]);
    }
      await client.query(`
        update material_requisitions
        set status = 'CANCELLED'
        where id = $1
      `, [req.params.id]);
    await auditLog(client, req.user.id, "cancel", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.get("/vendors", requireAuth, requirePermission("vendors", "view"), async (req, res) => {
  const search = String(req.query.search || "").trim();
  const category = String(req.query.category || "").trim();
  const showInactive = String(req.query.show_inactive || "").trim() === "1";
  const sort = String(req.query.sort || "name").trim().toLowerCase();
  const dir = String(req.query.dir || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
  const vendorSortColumns = {
    name: "name",
    contact_name: "contact_name",
    website: "website",
    email: "email",
    phone: "phone",
    categories: "categories"
  };
  const sortColumn = vendorSortColumns[sort] || "name";
  const where = [];
  const params = [];
  if (!showInactive) {
    where.push("v.is_active = true");
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ilike $${params.length} or coalesce(contact_name, '') ilike $${params.length} or coalesce(website, '') ilike $${params.length} or coalesce(email, '') ilike $${params.length} or coalesce(phone, '') ilike $${params.length})`);
  }
  if (category) {
    params.push(`%${category}%`);
    where.push(`coalesce(categories, '') ilike $${params.length}`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const vendors = (await query(`
    select v.*,
           coalesce(vc.contact_count, 0) as contact_count
    from vendors v
    left join (
      select vendor_id, count(*) as contact_count
      from vendor_contacts
      group by vendor_id
    ) vc on vc.vendor_id = v.id
    ${whereSql.replaceAll("name", "v.name").replaceAll("contact_name", "v.contact_name").replaceAll("email", "v.email").replaceAll("phone", "v.phone").replaceAll("categories", "v.categories")}
    order by coalesce(v.${sortColumn}, '') ${dir}, v.name asc
  `, params)).rows;
  const sortLink = (column) => `/vendors?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}&show_inactive=${showInactive ? "1" : ""}&sort=${encodeURIComponent(column)}&dir=${encodeURIComponent(nextSortDir(sort, dir, column))}`;
  const rows = vendors.map((vendor) => `<tr>
        <td>${esc(vendor.name)}</td>
        <td>${esc(vendor.contact_name || "")}</td>
        <td>${vendor.website ? `<a href="${esc(vendor.website)}" target="_blank" rel="noopener noreferrer">${esc(vendor.website)}</a>` : ""}</td>
        <td>${esc(vendor.email || "")}</td>
        <td>${esc(normalizePhone(vendor.phone || ""))}</td>
        <td>${(vendor.categories || "").split(",").filter(Boolean).map((value) => `<span class="chip">${esc(value)}</span>`).join(" ") || `<span class="muted">None</span>`}</td>
        <td>${esc(vendor.contact_count)}</td>
        <td>${vendor.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
        <td><div class="actions"><a class="btn btn-secondary" href="/vendors/${vendor.id}/edit">Edit</a><a class="btn btn-secondary" href="/vendors/${vendor.id}/edit#contacts">Contacts</a>${vendor.is_active ? `<form method="post" action="/vendors/${vendor.id}/deactivate"><button class="btn btn-danger" type="submit">Deactivate</button></form>` : `<form method="post" action="/vendors/${vendor.id}/activate"><button class="btn btn-primary" type="submit">Activate</button></form>`}</div></td>
      </tr>`).join("");
  const categoryOptions = [`<option value="">All Categories</option>`]
    .concat(vendorCategories.map((value) => `<option value="${esc(value)}" ${category === value ? "selected" : ""}>${esc(value)}</option>`))
    .join("");
  res.send(layout("Vendors", `
        <h1>Vendors</h1>
        <div class="card">
          <div class="actions"><a class="btn btn-primary" href="/vendors/new">Add Vendor</a></div>
        </div>
        <div class="card">
          <form method="get" action="/vendors" class="stack">
            <div class="grid">
              <div><label>Search</label><input name="search" value="${esc(search)}" placeholder="Name, contact, website, email, or phone" /></div>
              <div><label>Category</label><select name="category">${categoryOptions}</select></div>
            </div>
            <div class="actions"><label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;text-transform:none;"><input type="checkbox" name="show_inactive" value="1" ${showInactive ? "checked" : ""} style="width:auto;" /> Show inactive</label><button type="submit">Filter Vendors</button><a class="btn btn-secondary" href="/vendors">Clear</a><span class="muted">${vendors.length} vendor(s)</span></div>
          </form>
        </div>
        <div class="card scroll"><table><tr><th><a href="${sortLink("name")}">Name</a></th><th><a href="${sortLink("contact_name")}">Primary Contact</a></th><th><a href="${sortLink("website")}">Website</a></th><th><a href="${sortLink("email")}">Email</a></th><th><a href="${sortLink("phone")}">Phone</a></th><th><a href="${sortLink("categories")}">Categories</a></th><th>Contacts</th><th>Status</th><th>Action</th></tr>${rows}</table></div>
      `, req.user));
});

app.get("/vendors/new", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  const checks = vendorCategories.map((category) => `<label class="check-option"><input type="checkbox" name="categories" value="${esc(category)}" /><span>${esc(category)}</span></label>`).join("");
  res.send(layout("Add Vendor", `
    <h1>Add Vendor</h1>
    <div class="card">
      <form method="post" action="/vendors/add" class="stack">
        <div class="grid">
          <div><label>Name</label><input name="name" required /></div>
          <div><label>Contact Name</label><input name="contact_name" /></div>
          <div><label>Website</label><input name="website" placeholder="https://example.com" /></div>
          <div><label>Email</label><input name="email" /></div>
          <div><label>Phone</label><input name="phone" inputmode="tel" autocomplete="off" onblur="formatPhoneOnBlur(this)" /><div class="muted">Accepts 000-000-0000, 1-000-000-0000, or 0000000000</div></div>
        </div>
        <div><label>Categories</label><div class="check-grid">${checks}</div></div>
        <div class="actions"><button type="submit">Add Vendor</button><a class="btn btn-secondary" href="/vendors">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/vendors/add", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
      const result = await client.query(
        "insert into vendors (name, contact_name, website, email, phone, categories) values ($1, $2, $3, $4, $5, $6) returning id",
      [req.body.name?.trim(), req.body.contact_name?.trim(), req.body.website?.trim(), normalizeEmail(req.body.email), normalizePhone(req.body.phone), normalizeCategories(req.body.categories)]
      );
    await syncLegacyVendorContact(client, result.rows[0].id);
    await auditLog(client, req.user.id, "create", "vendor", result.rows[0].id, req.body.name?.trim() || "");
  });
  res.redirect("/vendors");
});

app.get("/vendors/:id/edit", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  const [vendorRes, contactsRes] = await Promise.all([
    query("select * from vendors where id = $1", [req.params.id]),
    query("select * from vendor_contacts where vendor_id = $1 order by is_primary desc, contact_name asc, id asc", [req.params.id])
  ]);
  const vendor = vendorRes.rows[0];
  if (!vendor) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Vendor not found.</h3></div>`, req.user));
    return;
  }
  const contacts = contactsRes.rows;
  const selected = new Set((vendor.categories || "").split(",").filter(Boolean));
  const checks = vendorCategories.map((category) => `<label class="check-option"><input type="checkbox" name="categories" value="${esc(category)}" ${selected.has(category) ? "checked" : ""}/><span>${esc(category)}</span></label>`).join("");
  const contactRows = contacts.map((contact) => `<tr>
    <td>${esc(contact.contact_name)}</td>
    <td>${esc(contact.email || "")}</td>
    <td>${esc(normalizePhone(contact.phone || ""))}</td>
    <td>${contact.is_primary ? `<span class="chip">Primary</span>` : ""}</td>
    <td>
      <div class="actions">
        ${!contact.is_primary ? `<form method="post" action="/vendors/${vendor.id}/contacts/${contact.id}/primary"><button type="submit" class="btn btn-secondary">Make Primary</button></form>` : ""}
        <form method="post" action="/vendors/${vendor.id}/contacts/${contact.id}/delete"><button type="submit" class="btn btn-danger">Delete</button></form>
      </div>
    </td>
  </tr>`).join("");
  res.send(layout("Edit Vendor", `
      <h1>Edit Vendor</h1>
      <div class="card">
        <form method="post" action="/vendors/${vendor.id}/edit" class="stack">
          <div class="grid">
            <div><label>Name</label><input name="name" value="${esc(vendor.name)}" required /></div>
            <div><label>Contact Name</label><input name="contact_name" value="${esc(vendor.contact_name || "")}" /></div>
            <div><label>Website</label><input name="website" value="${esc(vendor.website || "")}" placeholder="https://example.com" /></div>
            <div><label>Email</label><input name="email" value="${esc(vendor.email || "")}" /></div>
            <div><label>Phone</label><input name="phone" value="${esc(normalizePhone(vendor.phone || ""))}" inputmode="tel" autocomplete="off" onblur="formatPhoneOnBlur(this)" /><div class="muted">Accepts 000-000-0000, 1-000-000-0000, or 0000000000</div></div>
          </div>
          <div><label>Categories</label><div class="check-grid">${checks}</div></div>
          <div class="actions"><button type="submit">Save Vendor</button><a class="btn btn-secondary" href="/vendors">Back</a></div>
        </form>
      </div>
      <div class="card" id="contacts">
        <h3>Vendor Contacts</h3>
        <form method="post" action="/vendors/${vendor.id}/contacts/add" class="stack">
          <div class="grid">
            <div><label>Contact Name</label><input name="contact_name" required /></div>
            <div><label>Email</label><input name="email" /></div>
            <div><label>Phone</label><input name="phone" inputmode="tel" autocomplete="off" onblur="formatPhoneOnBlur(this)" /><div class="muted">Accepts 000-000-0000, 1-000-000-0000, or 0000000000</div></div>
          </div>
          <div class="actions"><button type="submit">Add Contact</button></div>
        </form>
        <div class="scroll" style="margin-top:12px;"><table><tr><th>Contact</th><th>Email</th><th>Phone</th><th>Primary</th><th>Action</th></tr>${contactRows || `<tr><td colspan="5" class="muted">No contacts yet.</td></tr>`}</table></div>
      </div>
    `, req.user));
});

app.post("/vendors/:id/edit", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
      await client.query(
        "update vendors set name = $2, contact_name = $3, website = $4, email = $5, phone = $6, categories = $7 where id = $1",
      [req.params.id, req.body.name?.trim(), req.body.contact_name?.trim(), req.body.website?.trim(), normalizeEmail(req.body.email), normalizePhone(req.body.phone), normalizeCategories(req.body.categories)]
      );
    await syncLegacyVendorContact(client, req.params.id);
    await auditLog(client, req.user.id, "update", "vendor", req.params.id, req.body.name?.trim() || "");
  });
  res.redirect("/vendors");
});

app.post("/vendors/:id/contacts/add", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const vendorId = Number(req.params.id);
    const vendor = (await client.query("select id from vendors where id = $1", [vendorId])).rows[0];
    if (!vendor) throw new Error("Vendor not found.");
    const contactName = String(req.body.contact_name || "").trim();
    if (!contactName) throw new Error("Contact name is required.");
    await client.query(`
      insert into vendor_contacts (vendor_id, contact_name, email, phone, is_primary)
      values ($1, $2, $3, $4, false)
    `, [vendorId, contactName, normalizeEmail(req.body.email), normalizePhone(req.body.phone)]);
    await auditLog(client, req.user.id, "create", "vendor_contact", vendorId, contactName);
  });
  res.redirect(`/vendors/${req.params.id}/edit`);
});

app.post("/vendors/:id/deactivate", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query("update vendors set is_active = false where id = $1", [req.params.id]);
    await auditLog(client, req.user.id, "deactivate", "vendor", req.params.id, "");
  });
  res.redirect("/vendors");
});

app.post("/vendors/:id/activate", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query("update vendors set is_active = true where id = $1", [req.params.id]);
    await auditLog(client, req.user.id, "activate", "vendor", req.params.id, "");
  });
  res.redirect("/vendors");
});

app.post("/vendors/:id/contacts/:contactId/primary", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const vendorId = Number(req.params.id);
    const contactId = Number(req.params.contactId);
    const contact = (await client.query("select * from vendor_contacts where id = $1 and vendor_id = $2", [contactId, vendorId])).rows[0];
    if (!contact) throw new Error("Vendor contact not found.");
    await client.query("update vendor_contacts set is_primary = false where vendor_id = $1", [vendorId]);
    await client.query("update vendor_contacts set is_primary = true where id = $1", [contactId]);
    await client.query(`
      update vendors
      set contact_name = $2, email = $3, phone = $4
      where id = $1
    `, [vendorId, contact.contact_name, normalizeEmail(contact.email), normalizePhone(contact.phone)]);
    await auditLog(client, req.user.id, "set_primary", "vendor_contact", contactId, contact.contact_name);
  });
  res.redirect(`/vendors/${req.params.id}/edit`);
});

app.post("/vendors/:id/contacts/:contactId/delete", requireAuth, requirePermission("vendors", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const vendorId = Number(req.params.id);
    const contactId = Number(req.params.contactId);
    const contact = (await client.query("select * from vendor_contacts where id = $1 and vendor_id = $2", [contactId, vendorId])).rows[0];
    if (!contact) throw new Error("Vendor contact not found.");
    if (contact.is_primary) throw new Error("Set another primary contact before deleting this one.");
    await client.query("delete from vendor_contacts where id = $1", [contactId]);
    await auditLog(client, req.user.id, "delete", "vendor_contact", contactId, contact.contact_name);
  });
  res.redirect(`/vendors/${req.params.id}/edit`);
});

app.get("/rfq", requireAuth, requirePermission("rfqs", "view"), async (req, res) => {
  const rfqNo = String(req.query.rfq_no || "").trim();
  const project = String(req.query.project || "").trim();
  const status = String(req.query.status || "").trim();
  const itemCode = String(req.query.item_code || "").trim();
  const vendorId = String(req.query.vendor_id || "").trim();
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const where = [];
  const params = [];
  if (rfqNo) {
    params.push(`%${rfqNo}%`);
    where.push(`r.rfq_no ilike $${params.length}`);
  }
  if (project) {
    params.push(`%${project}%`);
    where.push(`r.project_name ilike $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (itemCode) {
    params.push(`%${itemCode}%`);
    where.push(`exists (
      select 1
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.rfq_id = r.id and mi.item_code ilike $${params.length}
    )`);
  }
  if (vendorId) {
    params.push(num(vendorId));
    where.push(`exists (
      select 1
      from rfq_items ri
      join quotes q on q.rfq_item_id = ri.id
      where ri.rfq_id = r.id and q.vendor_id = $${params.length}
    )`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const [rfqsRes] = await Promise.all([
    query(`
    select r.*
    from rfqs r
    ${whereSql}
    order by r.id desc
    limit 300
  `, params)
  ]);
  const rfqs = rfqsRes.rows;
  const vendorOptions = [`<option value="">All Vendors</option>`]
    .concat(vendors.map((vendor) => `<option value="${vendor.id}" ${String(vendor.id) === vendorId ? "selected" : ""}>${esc(vendor.name)}</option>`))
    .join("");
  const rfqStatusOptions = [`<option value="">All Statuses</option>`]
    .concat(rfqStatuses.map((rfqStatus) => `<option value="${rfqStatus.value}" ${status === rfqStatus.value ? "selected" : ""}>${esc(rfqStatus.label)}</option>`))
    .join("");
  const rows = rfqs.map((rfq) => `<tr>
    <td><a href="/rfq/${rfq.id}">${esc(rfq.rfq_no)}</a></td>
    <td>${esc(rfq.project_name)}</td>
    <td>${esc(formatShortDateTime(rfq.due_date || ""))}</td>
    <td><span class="chip">${esc((rfqStatuses.find((item) => item.value === rfq.status) || { label: rfq.status }).label)}</span></td>
  </tr>`).join("");
  res.send(layout("RFQs", `
    <h1>RFQs</h1>
    <div class="card">
      <form method="get" action="/rfq" class="stack">
        <div class="grid-4">
          <div><label>RFQ #</label><input name="rfq_no" value="${esc(rfqNo)}" /></div>
          <div><label>Description</label><input name="project" value="${esc(project)}" /></div>
          <div><label>Status</label><select name="status">${rfqStatusOptions}</select></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(itemCode)}" /></div>
        </div>
        <div class="grid">
          <div><label>Quoted Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
        </div>
        <div class="actions">
          <button type="submit">Filter RFQs</button>
          <a class="btn btn-secondary" href="/rfq">Clear</a>
          <a class="btn btn-primary" href="/rfq/new">Create RFQ</a>
          <span class="muted">${rfqs.length} result(s), max 300 shown</span>
        </div>
      </form>
      <div class="scroll" style="margin-top:12px;">
        <table><tr><th>RFQ</th><th>Description</th><th>Due</th><th>Status</th></tr>${rows || `<tr><td colspan="4" class="muted">No RFQs match the current filter.</td></tr>`}</table>
      </div>
    </div>
  `, req.user));
});

app.get("/rfq/new", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const [nextRfqNo, jobNumber, vendorsRes] = await Promise.all([
    getNextRfqNumber(),
    getJobNumber(),
    query("select id, name from vendors order by name")
  ]);
  const vendors = vendorsRes.rows;
  const rfqStatusOptions = rfqStatuses.map((status) => `<option value="${status.value}" ${status.value === "SEND_FOR_QUOTES" ? "selected" : ""}>${esc(status.label)}</option>`).join("");
  res.send(layout("Create RFQ", `
    <h1>Create RFQ</h1>
    <div class="card">
      <form method="post" action="/rfq" class="stack">
        <div class="grid">
          <div><label>Job Number</label><input value="${esc(jobNumber)}" readonly /></div>
          <div><label>Next RFQ Number</label><input value="${esc(nextRfqNo)}" readonly /></div>
        </div>
        <div class="grid">
          <div><label>Description</label><input name="project_name" required /></div>
          <div><label>Due Date</label><input type="date" name="due_date" /></div>
        </div>
        <div class="grid">
          <div><label>Status</label><select name="status">${rfqStatusOptions}</select></div>
        </div>
        <div>
          <label>Participating Vendors</label>
          <div class="check-grid">
            ${renderVendorSelectionOptions(vendors)}
          </div>
        </div>
        <div class="actions">
          <button type="submit">Create RFQ</button>
          <a class="btn btn-secondary" href="/rfq">Back</a>
        </div>
      </form>
    </div>
  `, req.user));
});

app.post("/rfq", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const id = await withTransaction(async (client) => {
    const rfqNo = await getNextRfqNumber(client);
    const requestedStatus = String(req.body.status || "SEND_FOR_QUOTES").trim();
    const status = rfqStatuses.some((row) => row.value === requestedStatus) ? requestedStatus : "SEND_FOR_QUOTES";
    const selectedVendorIds = parseSelectedIdList(req.body.vendor_ids);
    const insert = await client.query(
      "insert into rfqs (rfq_no, project_name, due_date, status) values ($1, $2, $3, $4) returning id",
      [rfqNo, req.body.project_name?.trim(), req.body.due_date || null, status]
    );
    await syncRfqVendors(client, insert.rows[0].id, selectedVendorIds);
    await auditLog(client, req.user.id, "create", "rfq", insert.rows[0].id, rfqNo);
    return insert.rows[0].id;
  });
  res.redirect(`/rfq/${id}`);
});

app.post("/rfq/:id/status", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const requestedStatus = String(req.body.status || "").trim();
  const status = rfqStatuses.some((row) => row.value === requestedStatus) ? requestedStatus : "";
  if (!status) throw new Error("Choose a valid RFQ status.");
  await withTransaction(async (client) => {
    const rfq = (await client.query("select rfq_no from rfqs where id = $1", [rfqId])).rows[0];
    if (!rfq) throw new Error("RFQ not found.");
    await client.query("update rfqs set status = $2 where id = $1", [rfqId, status]);
    await auditLog(client, req.user.id, "update_status", "rfq", rfqId, `${rfq.rfq_no}:${status}`);
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq/:id/vendors", requireAuth, requirePermission("rfqs", "edit"), asyncHandler(async (req, res) => {
  const rfqId = Number(req.params.id);
  const selectedVendorIds = parseSelectedIdList(req.body.vendor_ids);
  await withTransaction(async (client) => {
    const rfq = (await client.query("select rfq_no from rfqs where id = $1", [rfqId])).rows[0];
    if (!rfq) throw new Error("RFQ not found.");
    await syncRfqVendors(client, rfqId, selectedVendorIds);
    await auditLog(client, req.user.id, "update", "rfq_vendors", rfqId, `count=${selectedVendorIds.length}`);
  });
  res.redirect(`/rfq/${rfqId}`);
}));

app.get("/rfq/:id", requireAuth, requirePermission("rfqs", "view"), async (req, res) => {
  const rfqId = Number(req.params.id);
  await backfillRfqVendors(pool, rfqId);
  const selectedVendorId = String(req.query.vendor_tab_id || "").trim();
  const rfq = (await query("select * from rfqs where id = $1", [rfqId])).rows[0];
  if (!rfq) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ not found.</h3></div>`, req.user));
    return;
  }
  const [itemsRes, vendorsRes, selectedVendorsRes, poCountRes, recentImportsRes, materialItemsRes, quotesRes, poRefsRes] = await Promise.all([
    query(`
      select ri.id, ri.po_line, ri.qty, ri.notes, ri.spec, ri.commodity_code, ri.tag_number, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.updated_at,
             ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days, ri.award_notes,
             mi.item_code, mi.description, mi.material_type, mi.uom
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.rfq_id = $1
      order by
        case when coalesce(ri.po_line, '') = '' then 1 else 0 end,
        case when coalesce(ri.po_line, '') ~ '^[0-9]+$' then lpad(ri.po_line, 20, '0') else lower(coalesce(ri.po_line, '')) end,
        ri.id
    `, [rfqId]),
    query("select id, name from vendors order by name"),
    query(`
      select rv.vendor_id, v.name
      from rfq_vendors rv
      join vendors v on v.id = rv.vendor_id
      where rv.rfq_id = $1
      order by v.name
    `, [rfqId]),
    query("select count(*) from purchase_orders where rfq_id = $1", [rfqId]),
    query(`
      select ib.id, ib.entity_type, ib.status, ib.inserted_count, ib.updated_count, ib.skipped_count, ib.created_at,
             coalesce((select count(*) from import_batch_errors ibe where ibe.batch_id = ib.id), 0) as error_count
      from import_batches ib
      where ib.rfq_id = $1
      order by ib.id desc
      limit 5
    `, [rfqId]),
    query("select item_code, description, material_type, uom from material_items order by item_code limit 500"),
    query(`
      select q.rfq_item_id, q.vendor_id, q.unit_price, q.lead_days, q.quoted_at, v.name as vendor_name
      from quotes q
      join rfq_items ri on ri.id = q.rfq_item_id
      join vendors v on v.id = q.vendor_id
      where ri.rfq_id = $1
    `, [rfqId]),
    query(`
      select pl.rfq_item_id, string_agg(distinct po.po_no, ', ' order by po.po_no) as po_refs
      from po_lines pl
      join purchase_orders po on po.id = pl.po_id
      where po.rfq_id = $1 and pl.rfq_item_id is not null
      group by pl.rfq_item_id
    `, [rfqId])
  ]);

  const items = itemsRes.rows;
  const vendors = vendorsRes.rows;
  const selectedVendors = selectedVendorsRes.rows;
  const poCount = Number(poCountRes.rows[0].count);
  const recentImports = recentImportsRes.rows;
  const materialItems = materialItemsRes.rows;
  const allQuotes = quotesRes.rows;
  const vendorNameMap = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const selectedVendorIds = selectedVendors.map((vendor) => Number(vendor.vendor_id));
  const activeQuoteVendorId = selectedVendorIds.includes(Number(selectedVendorId))
    ? String(selectedVendorId)
    : String(selectedVendors[0]?.vendor_id || "");
  const quoteMap = new Map();
  const quoteCountsByVendor = new Map();
  for (const quote of allQuotes) {
    const itemKey = Number(quote.rfq_item_id);
    const vendorKey = Number(quote.vendor_id);
    if (!quoteMap.has(itemKey)) quoteMap.set(itemKey, new Map());
    quoteMap.get(itemKey).set(vendorKey, quote);
    quoteCountsByVendor.set(vendorKey, (quoteCountsByVendor.get(vendorKey) || 0) + 1);
  }
  const poRefMap = new Map(poRefsRes.rows.map((row) => [Number(row.rfq_item_id), row.po_refs]));
  const awardedItems = items.filter((item) => item.award_status === "AWARDED" && item.awarded_vendor_id);
  const awardedVendorSet = new Set(awardedItems.map((item) => Number(item.awarded_vendor_id)));
  const awardedVendorId = items.length > 0 && awardedItems.length === items.length && awardedVendorSet.size === 1
    ? Number(awardedItems[0].awarded_vendor_id)
    : 0;
  const awardedVendorName = awardedVendorId ? (vendorNameMap.get(awardedVendorId) || `Vendor ${awardedVendorId}`) : "";
  const awardedTotal = awardedItems.reduce((sum, item) => sum + (Number(item.awarded_unit_price || 0) * Number(item.qty || 0)), 0);
  const activeVendor = selectedVendors.find((vendor) => String(vendor.vendor_id) === activeQuoteVendorId) || null;
  const materialItemRows = materialItems
    .map((item) => `<tr>
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.description)}</td>
      <td>${esc(item.material_type)}</td>
      <td>${esc(item.uom)}</td>
      <td>
        <form method="post" action="/rfq/${rfqId}/items/add">
          <input type="hidden" name="item_code" value="${esc(item.item_code)}" />
          <input type="hidden" name="description" value="${esc(item.description)}" />
          <input type="hidden" name="material_type" value="${esc(item.material_type)}" />
          <input type="hidden" name="uom" value="${esc(item.uom)}" />
          <input type="hidden" name="qty" value="1" />
          <button type="submit">Add</button>
        </form>
      </td>
    </tr>`)
    .join("");
  const newItemRows = Array.from({ length: 8 }, (_, index) => `
    <tr>
      <td><input name="item_code_${index}" /></td>
      <td><input name="description_${index}" /></td>
      <td><input name="material_type_${index}" /></td>
      <td><input name="uom_${index}" /></td>
      <td><input name="po_line_${index}" /></td>
      <td><input name="spec_${index}" /></td>
      <td><input name="commodity_code_${index}" /></td>
      <td><input name="tag_number_${index}" /></td>
      <td><input name="size_1_${index}" /></td>
      <td><input name="size_2_${index}" /></td>
      <td><input name="thk_1_${index}" /></td>
      <td><input name="thk_2_${index}" /></td>
      <td><input name="qty_${index}" /></td>
      <td><input name="notes_${index}" /></td>
    </tr>
  `).join("");

  const itemRows = [];
  for (const item of items) {
    const itemQuotes = quoteMap.get(Number(item.id)) || new Map();
    const selectedQuote = itemQuotes.get(Number(activeQuoteVendorId));
    const poRefs = poRefMap.get(Number(item.id)) || "Not Issued";
    const awardedVendor = item.awarded_vendor_id ? (vendorNameMap.get(item.awarded_vendor_id) || `Vendor ${item.awarded_vendor_id}`) : "";
    const awardSummary = item.award_status === "AWARDED"
      ? `${awardedVendor} | $${Number(item.awarded_unit_price || 0).toFixed(2)} | ${num(item.awarded_lead_days)}d`
      : "Open";
    itemRows.push(`<tr>
      <td>${esc(item.po_line || "")}</td>
      <td><input type="hidden" name="rfq_item_id_${item.id}" value="${item.id}" />${esc(item.item_code)}</td>
      <td>${esc(item.description)}</td>
      <td>${esc(formatQtyDisplay(item.qty))}</td>
      <td>${esc(item.uom)}</td>
      <td>${esc(item.spec || "")}</td>
      <td>${esc([item.size_1, item.size_2].filter(Boolean).join(" x "))}</td>
      <td>${esc([item.thk_1, item.thk_2].filter(Boolean).join(" x "))}</td>
      <td>${esc(item.notes || "")}</td>
      <td><input name="unit_price_${item.id}" value="${esc(selectedQuote?.unit_price || "")}" inputmode="decimal" /></td>
      <td><input name="lead_days_${item.id}" value="${esc(selectedQuote?.lead_days || "")}" inputmode="numeric" /></td>
      <td>${esc(item.award_status)}</td>
      <td>${esc(awardSummary)}</td>
      <td>${esc(poRefs)}</td>
      <td><div class="actions">
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/quotes">Quotes / History</a>
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/edit">Edit</a>
        ${item.award_status === "AWARDED" ? `<form method="post" action="/rfq-item/${item.id}/award/clear"><button class="btn btn-secondary" type="submit">Clear Award</button></form>` : ""}
        <form method="post" action="/rfq-item/${item.id}/delete"><button class="btn btn-danger" type="submit">Delete</button></form>
      </div></td>
    </tr>`);
  }

  const awardVendorOptions = [`<option value="">Select vendor</option>`]
    .concat(selectedVendors.map((vendor) => `<option value="${vendor.vendor_id}" ${Number(vendor.vendor_id) === awardedVendorId ? "selected" : ""}>${esc(vendor.name)}</option>`))
    .join("");
  const rfqStatusOptions = rfqStatuses
    .map((status) => `<option value="${status.value}" ${rfq.status === status.value ? "selected" : ""}>${esc(status.label)}</option>`)
    .join("");
  const rfqStatusLabel = (rfqStatuses.find((status) => status.value === rfq.status) || { label: rfq.status }).label;
  const selectedVendorChips = selectedVendors.length > 0
    ? selectedVendors.map((vendor) => `<span class="chip">${esc(vendor.name)}</span>`).join(" ")
    : `<span class="muted">No participating vendors selected yet.</span>`;
  const vendorTabs = selectedVendors.length > 0
    ? selectedVendors.map((vendor) => `<a class="tab-link ${String(vendor.vendor_id) === activeQuoteVendorId ? "active" : ""}" href="/rfq/${rfqId}?vendor_tab_id=${vendor.vendor_id}">${esc(vendor.name)} (${quoteCountsByVendor.get(Number(vendor.vendor_id)) || 0})</a>`).join("")
    : "";
  const importRows = recentImports.length > 0
    ? recentImports.map((batch) => `<tr><td><a href="/imports/${batch.id}">${esc(batch.entity_type)}</a></td><td>${esc(formatShortDateTime(batch.created_at))}</td><td>${esc(batch.status)}</td><td>${batch.inserted_count}</td><td>${batch.updated_count}</td><td>${batch.skipped_count}</td><td>${batch.error_count}</td></tr>`).join("")
    : `<tr><td colspan="7" class="muted">No imports logged yet.</td></tr>`;
  const addItemCard = `
    <div class="card">
      <h3>Existing Items</h3>
      <p class="muted">Filter the master item list like a spreadsheet, then add the line into this RFQ.</p>
      <div class="grid" style="grid-template-columns: 1fr auto;">
        <div><label>Filter Existing Items</label><input id="existing-items-filter-${rfqId}" placeholder="Search item code, description, type, or UOM" /></div>
        <div style="align-self:end;"><button type="button" onclick="filterTableRows('existing-items-filter-${rfqId}', 'existing-items-table-${rfqId}')">Apply Filter</button></div>
      </div>
      <div class="scroll">
        <table id="existing-items-table-${rfqId}">
          <thead><tr><th>Item Code</th><th>Description</th><th>Type</th><th>UOM</th><th>Add</th></tr></thead>
          <tbody>${materialItemRows || `<tr><td colspan="5" class="muted">No existing items found.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>Add New RFQ Items</h3>
      <p class="muted">Use this like an Excel grid. Fill in the rows you want, leave the rest blank, and save. New item codes are also added to the master item table.</p>
      <form id="rfq-grid-form-${rfqId}" method="post" action="/rfq/${rfqId}/items/grid" class="stack" onsubmit="return prepareRfqGrid('rfq-grid-form-${rfqId}', 8)">
        <div class="scroll">
          <table class="data-grid">
            <thead><tr><th>Item Code</th><th>Description</th><th>Type</th><th>UOM</th><th>PO Line</th><th>Spec</th><th>Commodity Code</th><th>Tag Number</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Notes</th></tr></thead>
            <tbody>${newItemRows}</tbody>
          </table>
        </div>
        <div class="actions"><button type="submit">Save Grid Rows</button></div>
      </form>
    </div>`;
  const uploadItemsCard = `
    <div class="card">
      <h3>Import RFQ Items From File</h3>
      <p class="muted">CSV/XLSX columns: po_line, item_code, description, material_type, uom, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes</p>
      <form method="post" enctype="multipart/form-data" action="/rfq/${rfqId}/items/import" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div class="actions"><button type="submit">Import File</button></div>
      </form>
    </div>`;
  const pasteItemsCard = `
    <div class="card">
      <h3>Paste RFQ Items</h3>
      <p class="muted">Paste CSV with columns: po_line, item_code, description, material_type, uom, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes</p>
      <form method="post" action="/rfq/${rfqId}/items/paste" class="stack">
        <div><label>Pasted CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit">Paste Items</button></div>
      </form>
    </div>`;
  const importQuotesCard = `
    <div class="card">
      <h3>Import Quotes For ${esc(activeVendor?.name || "Selected Vendor")}</h3>
      <p class="muted">CSV/XLSX columns: item_code, unit_price, lead_days. If you include vendor_name, it must match one of the selected RFQ vendors.</p>
      <form method="post" enctype="multipart/form-data" action="/rfq/${rfqId}/quotes/import" class="stack">
        <input type="hidden" name="vendor_id" value="${esc(activeQuoteVendorId)}" />
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div><label>Or Paste Quote CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit" ${activeQuoteVendorId ? "" : "disabled"}>Import Quotes</button></div>
      </form>
    </div>`;
  const awardSummaryCard = `
    <div class="card">
      <h3>Award Summary</h3>
      <div class="summary-grid">
        <div class="stat"><div>RFQ Status</div><strong>${esc(rfqStatusLabel)}</strong></div>
        <div class="stat"><div>Lines</div><strong>${items.length}</strong></div>
        <div class="stat"><div>Participating Vendors</div><strong>${selectedVendors.length}</strong></div>
        <div class="stat"><div>Issued POs</div><strong>${poCount}</strong></div>
      </div>
      <div style="margin-top:12px;">${selectedVendorChips}</div>
      <form method="post" action="/rfq/${rfqId}/award" class="stack" style="margin-top:12px;">
        <div class="grid" style="grid-template-columns: minmax(0, 280px) 1fr;">
          <div><label>Award RFQ To Vendor</label><select id="rfq-award-vendor-${rfqId}" name="vendor_id">${awardVendorOptions}</select></div>
          <div><label>Award Notes</label><input name="award_notes" value="${esc(items.find((item) => item.award_notes)?.award_notes || "")}" /></div>
        </div>
        <div class="actions">
          <button type="submit" ${selectedVendors.length === 0 ? "disabled" : ""}>Award Whole RFQ</button>
          ${awardedItems.length > 0 ? `<button class="btn btn-secondary" type="submit" formaction="/rfq/${rfqId}/award/clear">Clear Whole RFQ Award</button>` : ""}
          ${awardedVendorId ? `<button type="button" onclick="return promptPoNumber(this, 'rfq-awarded-vendor-${rfqId}', 'rfq-po-create-form-${rfqId}')">Create Draft PO</button>` : ""}
          <a class="btn btn-secondary" target="_blank" href="/rfq/${rfqId}/sheet.pdf">Open RFQ PDF</a>
        </div>
        ${awardedVendorId ? `<div class="muted">Current award: <strong>${esc(awardedVendorName)}</strong> | ${awardedItems.length} line(s) | Estimated total $${awardedTotal.toFixed(2)}</div>` : `<div class="muted">Award the full RFQ to one vendor once the selected vendor has quotes on every RFQ line.</div>`}
      </form>
      <form id="rfq-po-create-form-${rfqId}" method="post" action="/po/create" style="display:none;">
        <input type="hidden" name="rfq_id" value="${rfqId}" />
        <input type="hidden" name="po_no" value="" />
        <input type="hidden" id="rfq-awarded-vendor-${rfqId}" name="vendor_id" value="${awardedVendorId ? esc(String(awardedVendorId)) : ""}" />
      </form>
    </div>`;
  res.send(layout(`RFQ ${rfq.rfq_no}`, `
    <h1>RFQ ${esc(rfq.rfq_no)}${rfq.project_name ? ` | ${esc(rfq.project_name)}` : ""}</h1>
    <div class="card">
      <form method="post" action="/rfq/${rfqId}/status" class="stack">
        <div class="grid" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
          <div><label>RFQ Number</label><input value="${esc(rfq.rfq_no)}" readonly /></div>
          <div><label>Description</label><input value="${esc(rfq.project_name || "")}" readonly /></div>
          <div><label>Due Date</label><input value="${esc(formatShortDate(rfq.due_date))}" readonly /></div>
          <div><label>Status</label><select name="status">${rfqStatusOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Save Status</button><span class="chip">${esc(rfqStatusLabel)}</span></div>
      </form>
    </div>
    <div class="card">
      <h3>Selected Vendors</h3>
      <form method="post" action="/rfq/${rfqId}/vendors" class="stack">
        <div class="check-grid">
          ${renderVendorSelectionOptions(vendors, selectedVendorIds)}
        </div>
        <div class="actions">
          <button type="submit">Save Vendor List</button>
          <span class="muted">Choose the vendors for this RFQ once, then enter quotes vendor-by-vendor in the tabs below.</span>
        </div>
      </form>
    </div>
    ${awardSummaryCard}
    <div class="card scroll">
      <h3>Vendor Quote Workspace</h3>
      ${selectedVendors.length > 0 ? `<div class="tab-row">${vendorTabs}</div>` : `<div class="muted" style="margin-bottom:10px;">Save at least one selected vendor to unlock quote tabs.</div>`}
      <form method="post" action="/rfq/${rfqId}/quotes/grid" class="stack">
        <input type="hidden" name="vendor_id" value="${esc(activeQuoteVendorId)}" />
        <div class="grid" style="grid-template-columns: minmax(0, 260px) 1fr;">
          <div><label>Active Quote Vendor</label><input value="${esc(activeVendor?.name || "Select a participating vendor")}" readonly /></div>
          <div style="align-self:end;"><span class="muted">Enter prices and lead days for <strong>${esc(activeVendor?.name || "the active vendor")}</strong>. Save one vendor tab at a time. Quote history stays available per line.</span></div>
        </div>
        <div class="actions">
          <button type="submit" ${activeQuoteVendorId ? "" : "disabled"}>Save ${esc(activeVendor?.name || "Vendor")} Quotes</button>
        </div>
        <table>
          <tr><th>PO Line</th><th>Item</th><th>Description</th><th>Qty</th><th>UOM</th><th>Spec</th><th>Size</th><th>Thk</th><th>Notes</th><th>Unit Price</th><th>Lead Days</th><th>Award Status</th><th>Award Summary</th><th>Issued PO</th><th>Actions</th></tr>
          ${itemRows.join("") || `<tr><td colspan="15" class="muted">No RFQ items loaded yet.</td></tr>`}
        </table>
      </form>
    </div>
    ${poCount === 0 ? addItemCard : ""}
    ${poCount === 0 ? uploadItemsCard : ""}
    ${poCount === 0 ? pasteItemsCard : ""}
    ${poCount === 0 ? importQuotesCard : ""}
    <div class="card scroll">
      <h3>Recent Imports</h3>
      <table>
        <tr><th>Type</th><th>Created</th><th>Status</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Errors</th></tr>
        ${importRows}
      </table>
    </div>
  `, req.user));
});

app.get("/rfq/:id/sheet.pdf", requireAuth, requirePermission("rfqs", "view"), asyncHandler(async (req, res) => {
  const rfqId = Number(req.params.id);
  const [rfqRes, itemsRes] = await Promise.all([
    query("select * from rfqs where id = $1", [rfqId]),
    query(`
      select
        ri.po_line,
        ri.qty,
        ri.notes,
        ri.spec,
        mi.item_code,
        mi.description,
        mi.uom
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.rfq_id = $1
      order by
        case when coalesce(ri.po_line, '') = '' then 1 else 0 end,
        case when coalesce(ri.po_line, '') ~ '^[0-9]+$' then lpad(ri.po_line, 20, '0') else lower(coalesce(ri.po_line, '')) end,
        ri.id
    `, [rfqId])
  ]);
  const rfq = rfqRes.rows[0];
  if (!rfq) throw new Error("RFQ not found.");
  const pdfBuffer = buildRfqSheetPdf(rfq, itemsRes.rows);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${String(rfq.rfq_no || "RFQ").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`);
  res.send(pdfBuffer);
}));

app.post("/rfq/:id/items/import", requireAuth, requirePermission("rfqs", "edit"), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const result = await upsertRfqItemRow(client, rfqId, row);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, result.errorCode, result.message, row);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/items/add", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const rfqId = Number(req.params.id);
  await withTransaction(async (client) => {
    const result = await upsertRfqItemRow(client, rfqId, req.body);
    if (result.status === "skipped") throw new Error(result.message);
    await auditLog(client, req.user.id, "upsert", "rfq_item", rfqId, `item=${req.body.item_code || ""}`);
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq/:id/items/grid", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const usedItemCodes = new Set();
  const rows = Array.from({ length: 8 }, (_, index) => ({
    po_line: req.body[`po_line_${index}`],
    item_code: req.body[`item_code_${index}`],
    description: req.body[`description_${index}`],
    material_type: req.body[`material_type_${index}`],
    uom: req.body[`uom_${index}`],
    spec: req.body[`spec_${index}`],
    commodity_code: req.body[`commodity_code_${index}`],
    tag_number: req.body[`tag_number_${index}`],
    size_1: req.body[`size_1_${index}`],
    size_2: req.body[`size_2_${index}`],
    thk_1: req.body[`thk_1_${index}`],
    thk_2: req.body[`thk_2_${index}`],
    qty: req.body[`qty_${index}`],
    notes: req.body[`notes_${index}`]
  })).map((row) => {
    const normalizedCode = String(row.item_code || "").trim();
    if (normalizedCode) {
      usedItemCodes.add(normalizedCode);
      return row;
    }
    const hasRowData = String(row.description || "").trim() || String(row.qty || "").trim() || String(row.material_type || "").trim() || String(row.uom || "").trim();
    if (hasRowData) {
      row.item_code = randomSixDigitItemCode(usedItemCodes);
    }
    return row;
  }).filter((row) => String(row.item_code || "").trim() || String(row.description || "").trim() || String(row.qty || "").trim());
  if (rows.length === 0) throw new Error("No grid rows were entered.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: "manual-grid"
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const result = await upsertRfqItemRow(client, rfqId, rows[index]);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, index + 1, result.errorCode, result.message, rows[index]);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "grid_add", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/items/paste", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseDelimitedRows(req.body.table_text);
  if (rows.length === 0) throw new Error("No pasted rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: "pasted-table"
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 1;
      const result = await upsertRfqItemRow(client, rfqId, row);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, result.errorCode, result.message, row);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "paste", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/quotes/import", requireAuth, requirePermission("rfqs", "edit"), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const scopedVendorId = Number(req.body.vendor_id || 0);
  const batchId = await withTransaction(async (client) => {
    await backfillRfqVendors(client, rfqId);
    const batchId = await createImportBatch(client, {
      entityType: "quotes",
      rfqId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    const selectedVendorIds = new Set((await client.query("select vendor_id from rfq_vendors where rfq_id = $1", [rfqId])).rows.map((row) => Number(row.vendor_id)));
    if (scopedVendorId && !selectedVendorIds.has(scopedVendorId)) {
      throw new Error("Choose a vendor from the RFQ vendor tabs before importing.");
    }
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const vendorName = scopedVendorId ? "" : String(row.vendor_name || "").trim();
      const itemCode = String(row.item_code || "").trim();
      const unitPrice = num(row.unit_price, NaN);
      const leadDays = num(row.lead_days);
      if ((!scopedVendorId && !vendorName) || !itemCode || !Number.isFinite(unitPrice) || unitPrice <= 0) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "invalid_quote", "Vendor, item code, and unit price are required.", row);
        continue;
      }
      let vendorId = scopedVendorId;
      if (!vendorId) {
        const vendorRes = await client.query("select id from vendors where name = $1", [vendorName]);
        if (vendorRes.rows[0]) {
          vendorId = vendorRes.rows[0].id;
        } else {
          skippedCount += 1;
          await addImportBatchError(client, batchId, rowNumber, "vendor_not_selected", "Vendor is not available on this RFQ.", row);
          continue;
        }
      }
      if (!selectedVendorIds.has(Number(vendorId))) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "vendor_not_selected", "Vendor is not selected on this RFQ.", row);
        continue;
      }
      const rfqItemRes = await client.query(`
        select ri.id
        from rfq_items ri
        join material_items mi on mi.id = ri.material_item_id
        where ri.rfq_id = $1 and mi.item_code = $2
      `, [rfqId, itemCode]);
      if (!rfqItemRes.rows[0]) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "rfq_item_not_found", "Item code does not exist on this RFQ.", row);
        continue;
      }
      const rfqItemId = rfqItemRes.rows[0].id;
      const existingQuote = await client.query(
        "select id from quotes where rfq_item_id = $1 and vendor_id = $2",
        [rfqItemId, vendorId]
      );
      await client.query(`
        insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
        values ($1, $2, $3, $4, now())
        on conflict (rfq_item_id, vendor_id)
        do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
      `, [rfqItemId, vendorId, unitPrice, leadDays]);
      await client.query(`
        update rfq_items
        set awarded_unit_price = $3, awarded_lead_days = $4, updated_at = now()
        where id = $1 and award_status = 'AWARDED' and awarded_vendor_id = $2
      `, [rfqItemId, vendorId, unitPrice, leadDays]);
      await writeQuoteRevision(client, {
        rfqItemId,
        vendorId,
        unitPrice,
        leadDays,
        sourceType: "import",
        sourceBatchId: batchId,
        createdBy: req.user.id
      });
      if (existingQuote.rows[0]) updatedCount += 1;
      else insertedCount += 1;
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await recalcRfqStatus(client, rfqId);
    await auditLog(client, req.user.id, "import", "quotes", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.get("/imports/:id", requireAuth, async (req, res) => {
  const batch = (await query(`
    select ib.*, r.rfq_no
    from import_batches ib
    left join rfqs r on r.id = ib.rfq_id
    where ib.id = $1
  `, [req.params.id])).rows[0];
  if (!batch) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Import batch not found.</h3></div>`, req.user));
    return;
  }
  const errors = (await query(`
    select row_number, error_code, message, raw_payload
    from import_batch_errors
    where batch_id = $1
    order by row_number, id
  `, [req.params.id])).rows;
  const errorRows = errors.length > 0
    ? errors.map((error) => `<tr><td>${error.row_number}</td><td>${esc(error.error_code)}</td><td>${esc(error.message)}</td><td><code>${esc(JSON.stringify(error.raw_payload))}</code></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No row-level errors.</td></tr>`;
  res.send(layout("Import Results", `
    <h1>Import Results</h1>
    <div class="card">
      <div class="grid">
        <div><label>RFQ</label><div>${esc(batch.rfq_no || "N/A")}</div></div>
        <div><label>Import Type</label><div>${esc(batch.entity_type)}</div></div>
        <div><label>File</label><div>${esc(batch.filename || "Pasted data")}</div></div>
        <div><label>Status</label><div>${esc(batch.status)}</div></div>
      </div>
      <div class="stats" style="margin-top:18px;">
        <div class="stat"><div>Inserted</div><strong>${batch.inserted_count}</strong></div>
        <div class="stat"><div>Updated</div><strong>${batch.updated_count}</strong></div>
        <div class="stat"><div>Skipped</div><strong>${batch.skipped_count}</strong></div>
        <div class="stat"><div>Errors</div><strong>${errors.length}</strong></div>
      </div>
      <div class="actions" style="margin-top:18px;"><a class="btn btn-secondary" href="/rfq/${batch.rfq_id}">Back To RFQ</a></div>
    </div>
    <div class="card scroll">
      <h3>Row Results</h3>
      <table><tr><th>Row</th><th>Code</th><th>Message</th><th>Payload</th></tr>${errorRows}</table>
    </div>
  `, req.user));
});

app.post("/rfq/:id/award", requireAuth, requirePermission("rfqs", "edit"), asyncHandler(async (req, res) => {
  const rfqId = Number(req.params.id);
  const vendorId = Number(req.body.vendor_id);
  if (!vendorId) throw new Error("Select a participating vendor to award this RFQ.");
  await withTransaction(async (client) => {
    const isSelectedVendor = (await client.query("select 1 from rfq_vendors where rfq_id = $1 and vendor_id = $2", [rfqId, vendorId])).rows[0];
    if (!isSelectedVendor) throw new Error("Choose a vendor from the RFQ vendor list.");
    const items = (await client.query(`
      select ri.id, mi.item_code, mi.description, q.unit_price, q.lead_days
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      left join quotes q on q.rfq_item_id = ri.id and q.vendor_id = $2
      where ri.rfq_id = $1
      order by ri.id
    `, [rfqId, vendorId])).rows;
    if (items.length === 0) throw new Error("Add RFQ items before awarding.");
    const missingItems = items.filter((item) => !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) <= 0);
    if (missingItems.length > 0) {
      const missingList = missingItems.slice(0, 8).map((item) => item.item_code || `Line ${item.id}`).join(", ");
      throw new Error(`Cannot award this RFQ yet. The selected vendor is missing quotes for: ${missingList}${missingItems.length > 8 ? ", ..." : ""}`);
    }
    await client.query(`
      update rfq_items
      set award_status = 'OPEN',
          awarded_vendor_id = null,
          awarded_unit_price = null,
          awarded_lead_days = null,
          awarded_at = null,
          awarded_by = null,
          award_notes = null,
          updated_at = now()
      where rfq_id = $1
    `, [rfqId]);
    for (const item of items) {
      await client.query(`
        update rfq_items
        set award_status = 'AWARDED',
            awarded_vendor_id = $2,
            awarded_unit_price = $3,
            awarded_lead_days = $4,
            awarded_at = now(),
            awarded_by = $5,
            award_notes = $6,
            updated_at = now()
        where id = $1
      `, [item.id, vendorId, item.unit_price, item.lead_days, req.user.id, String(req.body.award_notes || "").trim()]);
      await auditLog(client, req.user.id, "award", "rfq_item", item.id, `vendor=${vendorId};rfq=${rfqId}`);
    }
    await client.query("update rfqs set status = 'AWARDED' where id = $1", [rfqId]);
    await auditLog(client, req.user.id, "award", "rfq", rfqId, `vendor=${vendorId}`);
  });
  res.redirect(`/rfq/${rfqId}?vendor_tab_id=${encodeURIComponent(String(vendorId))}`);
}));

app.post("/rfq/:id/award/clear", requireAuth, requirePermission("rfqs", "edit"), asyncHandler(async (req, res) => {
  const rfqId = Number(req.params.id);
  await withTransaction(async (client) => {
    const issued = await client.query(`
      select 1
      from po_lines pl
      join purchase_orders po on po.id = pl.po_id
      where po.rfq_id = $1
      limit 1
    `, [rfqId]);
    if (issued.rows[0]) throw new Error("Cannot clear the RFQ award after a PO has been created.");
    await client.query(`
      update rfq_items
      set award_status = 'OPEN',
          awarded_vendor_id = null,
          awarded_unit_price = null,
          awarded_lead_days = null,
          awarded_at = null,
          awarded_by = null,
          award_notes = null,
          updated_at = now()
      where rfq_id = $1
    `, [rfqId]);
    await recalcRfqStatus(client, rfqId);
    await auditLog(client, req.user.id, "clear_award", "rfq", rfqId, "");
  });
  res.redirect(`/rfq/${rfqId}`);
}));

app.post("/po/create", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  const rfqId = Number(req.body.rfq_id);
  const vendorId = Number(req.body.vendor_id);
  const poNo = String(req.body.po_no || "").trim();
  if (!vendorId) throw new Error("Select a vendor with awarded RFQ lines.");
  await withTransaction(async (client) => {
    const rfq = (await client.query("select project_name from rfqs where id = $1", [rfqId])).rows[0];
    const awardTotals = (await client.query(`
      select
        count(*) as total_count,
        count(*) filter (where award_status = 'AWARDED' and awarded_vendor_id = $2) as vendor_awarded_count
      from rfq_items
      where rfq_id = $1
    `, [rfqId, vendorId])).rows[0];
    const totalCount = Number(awardTotals?.total_count || 0);
    const vendorAwardedCount = Number(awardTotals?.vendor_awarded_count || 0);
    if (totalCount === 0) throw new Error("Add RFQ items before creating a PO.");
    if (vendorAwardedCount !== totalCount) throw new Error("Award the whole RFQ to one vendor before creating the draft PO.");
    const poInsert = await client.query(
      "insert into purchase_orders (po_no, vendor_id, rfq_id, description, status, updated_at) values ($1, $2, $3, $4, 'OPEN', now()) returning id",
      [poNo, vendorId, rfqId, rfq?.project_name || ""]
    );
    const poId = poInsert.rows[0].id;
    const lines = await client.query(`
      select ri.id as rfq_item_id, ri.material_item_id, ri.po_line, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.qty,
             ri.awarded_unit_price as unit_price, ri.awarded_lead_days as lead_days
      from rfq_items ri
      where ri.rfq_id = $1 and ri.award_status = 'AWARDED' and ri.awarded_vendor_id = $2
        and not exists (
          select 1
          from po_lines pl
          join purchase_orders po on po.id = pl.po_id
          where po.rfq_id = ri.rfq_id and pl.rfq_item_id = ri.id
        )
    `, [rfqId, vendorId]);
    if (lines.rows.length === 0) throw new Error("Selected vendor has no unissued awarded lines on this RFQ.");
    for (const line of lines.rows) {
      await client.query(`
        insert into po_lines (po_id, rfq_item_id, material_item_id, po_line, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, lead_days, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
      `, [poId, line.rfq_item_id, line.material_item_id, line.po_line || "", line.size_1 || "", line.size_2 || "", line.thk_1 || "", line.thk_2 || "", line.qty, line.unit_price, num(line.lead_days)]);
    }
    await recalcRfqStatus(client, rfqId);
    await auditLog(client, req.user.id, "create", "purchase_order", poId, poNo);
  });
  res.redirect("/po");
});

app.get("/rfq-item/:id/award", requireAuth, async (req, res) => {
  const [itemRes, quotesRes] = await Promise.all([
    query(`
      select ri.id, ri.rfq_id, ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days, ri.award_notes,
             mi.item_code, mi.description
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.id = $1
    `, [req.params.id]),
    query(`
      select v.id as vendor_id, v.name as vendor_name, q.unit_price, q.lead_days, q.quoted_at
      from quotes q
      join vendors v on v.id = q.vendor_id
      where q.rfq_item_id = $1
      order by q.unit_price, q.lead_days, v.name
    `, [req.params.id])
  ]);
  const item = itemRes.rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  const quoteOptions = quotesRes.rows.map((quote) => `<option value="${quote.vendor_id}" ${quote.vendor_id === item.awarded_vendor_id ? "selected" : ""}>${esc(quote.vendor_name)} | ${quoteCell(quote.unit_price, quote.lead_days)}</option>`).join("");
  const quoteRows = quotesRes.rows.length > 0
    ? quotesRes.rows.map((quote) => `<tr><td>${esc(quote.vendor_name)}</td><td>$${Number(quote.unit_price).toFixed(2)}</td><td>${quote.lead_days} days</td><td>${esc(formatShortDateTime(quote.quoted_at))}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Add quotes before awarding this line.</td></tr>`;
  res.send(layout("Award RFQ Item", `
    <h1>Award RFQ Item</h1>
    <div class="card"><strong>${esc(item.item_code)}</strong> | ${esc(item.description)}</div>
    <div class="card">
      <form method="post" action="/rfq-item/${item.id}/award" class="stack">
        <div class="grid">
          <div><label>Quoted Vendor</label><select name="vendor_id" ${quotesRes.rows.length === 0 ? "disabled" : ""}>${quoteOptions}</select></div>
          <div><label>Award Notes</label><input name="award_notes" value="${esc(item.award_notes || "")}" /></div>
        </div>
        <div class="actions"><button type="submit" ${quotesRes.rows.length === 0 ? "disabled" : ""}>Save Award</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Updated</th></tr>${quoteRows}</table></div>
  `, req.user));
});

app.post("/rfq-item/:id/award", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const quote = (await client.query(`
      select ri.rfq_id, q.vendor_id, q.unit_price, q.lead_days
      from rfq_items ri
      join quotes q on q.rfq_item_id = ri.id
      where ri.id = $1 and q.vendor_id = $2
    `, [itemId, Number(req.body.vendor_id)])).rows[0];
    if (!quote) throw new Error("Select a quoted vendor before awarding.");
    await client.query(`
      update rfq_items
      set award_status = 'AWARDED',
          awarded_vendor_id = $2,
          awarded_unit_price = $3,
          awarded_lead_days = $4,
          awarded_at = now(),
          awarded_by = $5,
          award_notes = $6,
          updated_at = now()
      where id = $1
    `, [itemId, quote.vendor_id, quote.unit_price, quote.lead_days, req.user.id, req.body.award_notes || ""]);
    await auditLog(client, req.user.id, "award", "rfq_item", itemId, `vendor=${quote.vendor_id}`);
    return quote.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq-item/:id/award/clear", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    const issued = await client.query(`
      select 1
      from po_lines pl
      join purchase_orders po on po.id = pl.po_id
      where pl.rfq_item_id = $1
      limit 1
    `, [itemId]);
    if (issued.rows[0]) throw new Error("Cannot clear an award after a PO line has been issued.");
    await client.query(`
      update rfq_items
      set award_status = 'OPEN',
          awarded_vendor_id = null,
          awarded_unit_price = null,
          awarded_lead_days = null,
          awarded_at = null,
          awarded_by = null,
          award_notes = null,
          updated_at = now()
      where id = $1
    `, [itemId]);
    await auditLog(client, req.user.id, "clear_award", "rfq_item", itemId, "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.get("/rfq-item/:id/edit", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const item = (await query(`
    select ri.id, ri.rfq_id, ri.qty, ri.notes, ri.spec, ri.commodity_code, ri.tag_number, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, extract(epoch from ri.updated_at)::text as updated_token,
           mi.item_code, mi.description, mi.material_type, mi.uom
    from rfq_items ri
    join material_items mi on mi.id = ri.material_item_id
    where ri.id = $1
  `, [req.params.id])).rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  res.send(layout("Edit RFQ Item", `
    <h1>Edit RFQ Item</h1>
    <div class="card">
      <form method="post" action="/rfq-item/${item.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(item.updated_token)}" />
        <div class="grid">
          <div><label>Item Code</label><input name="item_code" value="${esc(item.item_code)}" required /></div>
          <div><label>Description</label><input name="description" value="${esc(item.description)}" /></div>
          <div><label>Type</label><input name="material_type" value="${esc(item.material_type)}" /></div>
          <div><label>UOM</label><input name="uom" value="${esc(item.uom)}" /></div>
          <div><label>Qty</label><input name="qty" value="${esc(item.qty)}" required /></div>
          <div><label>Spec</label><input name="spec" value="${esc(item.spec || "")}" /></div>
          <div><label>Commodity Code</label><input name="commodity_code" value="${esc(item.commodity_code || "")}" /></div>
          <div><label>Tag Number</label><input name="tag_number" value="${esc(item.tag_number || "")}" /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(item.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(item.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(item.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(item.thk_2 || "")}" /></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(item.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save Item</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/rfq-item/:id/edit", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id, material_item_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    await client.query(
      "update material_items set item_code = $2, description = $3, material_type = $4, uom = $5 where id = $1",
      [current.material_item_id, req.body.item_code?.trim(), req.body.description?.trim() || req.body.item_code?.trim(), req.body.material_type?.trim() || "misc", req.body.uom?.trim() || "EA"]
    );
    const update = await client.query(`
      update rfq_items
      set spec = $2, commodity_code = $3, tag_number = $4, size_1 = $5, size_2 = $6, thk_1 = $7, thk_2 = $8, qty = $9, notes = $10, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $11
    `, [itemId, req.body.spec || "", req.body.commodity_code || "", req.body.tag_number || "", req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", parseQtyValue(req.body.qty || 0), req.body.notes || "", req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This RFQ item was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "rfq_item", itemId, req.body.item_code?.trim() || "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq-item/:id/delete", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    await client.query("delete from rfq_items where id = $1", [itemId]);
    await auditLog(client, req.user.id, "delete", "rfq_item", itemId, "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.get("/rfq-item/:id/quotes", requireAuth, async (req, res) => {
  const item = (await query(`
    select ri.id, ri.rfq_id, ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days,
           mi.item_code, mi.description
    from rfq_items ri
    join material_items mi on mi.id = ri.material_item_id
    where ri.id = $1
  `, [req.params.id])).rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  await backfillRfqVendors(pool, item.rfq_id);
  const vendors = (await query(`
    select rv.vendor_id as id, v.name
    from rfq_vendors rv
    join vendors v on v.id = rv.vendor_id
    where rv.rfq_id = $1
    order by v.name
  `, [item.rfq_id])).rows;
  const quotes = (await query(`
    select v.id as vendor_id, v.name as vendor_name, q.unit_price, q.lead_days, q.quoted_at
    from quotes q
    join vendors v on v.id = q.vendor_id
    where q.rfq_item_id = $1
    order by q.unit_price, q.lead_days
  `, [req.params.id])).rows;
  const revisions = (await query(`
    select v.name as vendor_name, qr.unit_price, qr.lead_days, qr.source_type, qr.created_at
    from quote_revisions qr
    join vendors v on v.id = qr.vendor_id
    where qr.rfq_item_id = $1
    order by qr.id desc
    limit 20
  `, [req.params.id])).rows;
  const vendorOptions = vendors.map((vendor) => `<option value="${vendor.id}">${esc(vendor.name)}</option>`).join("");
  const quoteRows = quotes.length > 0
    ? quotes.map((quote) => `<tr><td>${esc(quote.vendor_name)}</td><td>$${Number(quote.unit_price).toFixed(2)}</td><td>${quote.lead_days} days</td><td>${esc(formatShortDateTime(quote.quoted_at))}</td>${item.awarded_vendor_id === quote.vendor_id ? `<td><span class="chip">Awarded</span></td>` : `<td></td>`}</tr>`).join("")
    : `<tr><td colspan="5" class="muted">No quotes yet</td></tr>`;
  const revisionRows = revisions.length > 0
    ? revisions.map((revision) => `<tr><td>${esc(revision.vendor_name)}</td><td>$${Number(revision.unit_price).toFixed(2)}</td><td>${revision.lead_days} days</td><td>${esc(revision.source_type)}</td><td>${esc(formatShortDateTime(revision.created_at))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">No quote revisions yet</td></tr>`;
  res.send(layout("Manage Quotes", `
    <h1>Manage Quotes</h1>
    <div class="card"><strong>${esc(item.item_code)}</strong> | ${esc(item.description)} | <strong>Award:</strong> ${item.award_status === "AWARDED" ? `${esc(quotes.find((quote) => quote.vendor_id === item.awarded_vendor_id)?.vendor_name || "Awarded")} @ $${Number(item.awarded_unit_price || 0).toFixed(2)} | ${num(item.awarded_lead_days)}d` : "Open"}</div>
    <div class="card">
      <form method="post" action="/quotes" class="stack">
        <input type="hidden" name="rfq_item_id" value="${item.id}" />
        <input type="hidden" name="rfq_id" value="${item.rfq_id}" />
        <div class="grid">
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Unit Price</label><input name="unit_price" required /></div>
          <div><label>Lead Days</label><input name="lead_days" /></div>
        </div>
        <div class="actions"><button type="submit">Save Quote</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Updated</th><th>Award</th></tr>${quoteRows}</table></div>
    <div class="card scroll"><h3>Quote Revision History</h3><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Source</th><th>Logged</th></tr>${revisionRows}</table></div>
  `, req.user));
});

app.post("/quotes", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const rfqItemId = Number(req.body.rfq_item_id);
    const vendorId = Number(req.body.vendor_id);
    const unitPrice = num(req.body.unit_price, NaN);
    const leadDays = num(req.body.lead_days);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("Unit price must be greater than zero.");
    const item = (await client.query("select rfq_id from rfq_items where id = $1", [rfqItemId])).rows[0];
    if (!item) throw new Error("RFQ item not found.");
    const vendorRow = (await client.query("select 1 from rfq_vendors where rfq_id = $1 and vendor_id = $2", [item.rfq_id, vendorId])).rows[0];
    if (!vendorRow) throw new Error("Select a vendor from the RFQ vendor list.");
    await client.query(`
      insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
      values ($1, $2, $3, $4, now())
      on conflict (rfq_item_id, vendor_id)
      do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
    `, [rfqItemId, vendorId, unitPrice, leadDays]);
    await client.query(`
      update rfq_items
      set awarded_unit_price = $3, awarded_lead_days = $4, updated_at = now()
      where id = $1 and award_status = 'AWARDED' and awarded_vendor_id = $2
    `, [rfqItemId, vendorId, unitPrice, leadDays]);
    await writeQuoteRevision(client, {
      rfqItemId,
      vendorId,
      unitPrice,
      leadDays,
      sourceType: "manual",
      createdBy: req.user.id
    });
    await auditLog(client, req.user.id, "upsert", "quote", req.body.rfq_item_id, `vendor=${req.body.vendor_id}`);
    await recalcRfqStatus(client, item.rfq_id);
  });
  res.redirect(`/rfq/${req.body.rfq_id}?vendor_tab_id=${encodeURIComponent(String(req.body.vendor_id || ""))}`);
});

app.post("/rfq/:id/quotes/grid", requireAuth, requirePermission("rfqs", "edit"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const vendorId = Number(req.body.vendor_id);
  if (!vendorId) throw new Error("Select a vendor tab first.");
  await withTransaction(async (client) => {
    const vendorRow = (await client.query("select 1 from rfq_vendors where rfq_id = $1 and vendor_id = $2", [rfqId, vendorId])).rows[0];
    if (!vendorRow) throw new Error("Choose a vendor from the RFQ vendor list.");
    const items = (await client.query("select id, awarded_vendor_id, award_status from rfq_items where rfq_id = $1", [rfqId])).rows;
    for (const item of items) {
      const unitPriceRaw = String(req.body[`unit_price_${item.id}`] || "").trim();
      const leadDaysRaw = String(req.body[`lead_days_${item.id}`] || "").trim();
      if (!unitPriceRaw && !leadDaysRaw) continue;
      const unitPrice = num(unitPriceRaw, NaN);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new Error(`Unit price for RFQ item ${item.id} must be greater than zero.`);
      }
      const leadDays = leadDaysRaw ? num(leadDaysRaw) : 0;
      await client.query(`
        insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
        values ($1, $2, $3, $4, now())
        on conflict (rfq_item_id, vendor_id)
        do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
      `, [item.id, vendorId, unitPrice, leadDays]);
      await client.query(`
        update rfq_items
        set awarded_unit_price = $3, awarded_lead_days = $4, updated_at = now()
        where id = $1 and award_status = 'AWARDED' and awarded_vendor_id = $2
      `, [item.id, vendorId, unitPrice, leadDays]);
      await writeQuoteRevision(client, {
        rfqItemId: item.id,
        vendorId,
        unitPrice,
        leadDays,
        sourceType: "manual",
        createdBy: req.user.id
      });
      await auditLog(client, req.user.id, "upsert", "quote", item.id, `vendor=${vendorId}`);
    }
    await recalcRfqStatus(client, rfqId);
  });
  res.redirect(`/rfq/${rfqId}?vendor_tab_id=${encodeURIComponent(String(vendorId))}`);
});

app.get("/po", requireAuth, requirePermission("pos", "view"), async (req, res) => {
  const poNo = String(req.query.po_no || "").trim();
  const rfqNo = String(req.query.rfq_no || "").trim();
  const vendorId = String(req.query.vendor_id || "").trim();
  const status = String(req.query.status || "").trim();
  const where = [];
  const params = [];
  if (poNo) { params.push(`%${poNo}%`); where.push(`po.po_no ilike $${params.length}`); }
  if (rfqNo) { params.push(`%${rfqNo}%`); where.push(`r.rfq_no ilike $${params.length}`); }
  if (vendorId) { params.push(Number(vendorId)); where.push(`po.vendor_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`po.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const pos = (await query(`
        select po.id, po.po_no, po.vendor_id, po.status, po.created_at, extract(epoch from po.updated_at)::text as updated_token,
               v.name as vendor, coalesce(r.rfq_no, '') as rfq_no, coalesce(po.description, '') as description, coalesce(po.vendor_contact, '') as vendor_contact,
               coalesce(po.freight_terms, '') as freight_terms, coalesce(po.ship_to, '') as ship_to, coalesce(po.buyer_name, '') as buyer_name,
               coalesce(open_counts.open_items, 0) as open_items,
               coalesce(line_refs.po_lines, '') as po_line_refs
    from purchase_orders po
    join vendors v on v.id = po.vendor_id
    left join rfqs r on r.id = po.rfq_id
    left join (
      select
        pl.po_id,
        count(*) filter (where coalesce(rcv.qty_received, 0) < pl.qty_ordered) as open_items
      from po_lines pl
      left join (
        select po_line_id, sum(qty_received) as qty_received
        from receipts
        group by po_line_id
      ) rcv on rcv.po_line_id = pl.id
      group by pl.po_id
    ) open_counts on open_counts.po_id = po.id
    left join (
      select
        pl.po_id,
        string_agg(nullif(pl.po_line, ''), ', ' order by nullif(pl.po_line, ''), pl.id) as po_lines
      from po_lines pl
      where coalesce(pl.po_line, '') <> ''
      group by pl.po_id
    ) line_refs on line_refs.po_id = po.id
    ${whereSql}
    order by po.id desc
    limit 300
  `, params)).rows;
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const poRows = pos.map((po) => `<tr>
    <td>${esc(po.po_no)}</td>
    <td>${esc(po.vendor)}</td>
    <td>${esc(po.rfq_no || "")}</td>
    <td>${esc(po.description || "")}</td>
    <td>${esc(po.vendor_contact || "")}</td>
    <td>${esc(po.freight_terms || "")}</td>
    <td>${esc(po.ship_to || "")}</td>
    <td>${esc(po.buyer_name || "")}</td>
    <td>${esc(po.status)}</td>
    <td>${esc(po.po_line_refs || "")}</td>
    <td>${esc(po.open_items)}</td>
    <td>${esc(formatShortDateTime(po.created_at))}</td>
    <td>
      <div class="actions">
        <a class="btn btn-secondary" href="/po/${po.id}/receive">Receive</a>
        <a class="btn btn-secondary" href="/po/${po.id}/edit">Edit</a>
      </div>
    </td>
  </tr>`).join("");
  const vendorOptions = [`<option value="">All Vendors</option>`]
    .concat(vendors.map((vendor) => `<option value="${vendor.id}" ${String(vendor.id) === vendorId ? "selected" : ""}>${esc(vendor.name)}</option>`)).join("");
  res.send(layout("POs", `
    <h1>Purchase Orders</h1>
    <div class="card">
      <form method="get" action="/po" class="stack">
        <div class="grid-4">
          <div><label>PO #</label><input name="po_no" value="${esc(poNo)}" /></div>
          <div><label>RFQ #</label><input name="rfq_no" value="${esc(rfqNo)}" /></div>
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Status</label><select name="status"><option value="">All Statuses</option><option value="OPEN" ${status === "OPEN" ? "selected" : ""}>OPEN</option><option value="CLOSED" ${status === "CLOSED" ? "selected" : ""}>CLOSED</option></select></div>
        </div>
        <div class="actions"><button type="submit">Filter POs</button><a class="btn btn-secondary" href="/po">Clear</a><span class="muted">${pos.length} result(s), max 300 shown</span></div>
      </form>
    </div>
    <div class="card">
      <div class="actions"><a class="btn btn-primary" href="/po/import">Import Existing POs</a></div>
    </div>
    <div class="card scroll">
      <table><tr><th>PO #</th><th>Vendor</th><th>RFQ</th><th>Description</th><th>Contact</th><th>Freight</th><th>Ship To</th><th>Buyer</th><th>Status</th><th>PO Line</th><th>Open Items</th><th>Created</th><th>Actions</th></tr>${poRows || `<tr><td colspan="13" class="muted">No POs match the current filter.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.get("/po/import", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  res.send(layout("Import Existing POs", `
    <h1>Import Existing POs</h1>
    <div class="card">
      <p class="muted">Upload a CSV/XLSX file to create or update PO headers and lines. Missing vendors are added to the vendors table, missing item codes are added to the items table, and imported PO lines are tied to those item records.</p>
      <p class="muted">Supported columns: po_no, po_line, vendor_name, item_code, description, material_type, uom, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, vendor_contact, freight_terms, ship_to, bill_to, notes, buyer_name, status. Alternate headers like PO Number, Vendor, Supplier, Item No, Qty, Ordered Qty, Unit Cost, Price, and PO Description are also accepted.</p>
      <div class="actions"><a class="btn btn-secondary" href="/po/import/template">Download Template</a></div>
      <form method="post" enctype="multipart/form-data" action="/po/import/preview" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div><label>Or Paste CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit">Preview Import</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.get("/po/import/template", requireAuth, requirePermission("pos", "edit"), async (_req, res) => {
  const csv = [
    "po_no,po_line,vendor_name,po_description,item_code,description,material_type,uom,size_1,size_2,thk_1,thk_2,qty_ordered,unit_price,vendor_contact,freight_terms,ship_to,bill_to,notes,buyer_name,status",
    "PO-00001,0010,Example Vendor,Pipe Supports Release 1,ITEM-1001,Pipe Example,pipe,EA,2,,SCH40,,12,18.75,John Smith,FOB,SITE A,OFFICE A,Legacy import sample,Buyer One,OPEN"
  ].join("\\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="po-import-template.csv"');
  res.send(csv);
});

app.post("/po/import/preview", requireAuth, requirePermission("pos", "edit"), upload.single("sheet"), async (req, res) => {
  const rows = parseUploadedRows(req.file, req.body.csv_text).map(normalizePoImportRow);
  if (rows.length === 0) throw new Error("No rows found.");
  const previewRows = rows.slice(0, 100).map((row) => `<tr>
    <td>${esc(row.po_no)}</td>
    <td>${esc(row.po_line)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.po_description)}</td>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(formatQtyDisplay(row.qty_ordered))}</td>
    <td>${esc(row.unit_price)}</td>
  </tr>`).join("");
  res.send(layout("Preview PO Import", `
    <h1>Preview PO Import</h1>
    <div class="card">
      <p class="muted">${rows.length} row(s) parsed. Review the mapped values below, then confirm the import.</p>
      <form method="post" action="/po/import/commit" class="stack">
        <input type="hidden" name="rows_json" value="${esc(JSON.stringify(rows))}" />
        <div class="actions"><button type="submit">Confirm Import</button><a class="btn btn-secondary" href="/po/import">Back</a></div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>PO #</th><th>PO Line</th><th>Vendor</th><th>PO Description</th><th>Item Code</th><th>Description</th><th>Qty Ordered</th><th>Unit Price</th></tr>${previewRows}</table>
    </div>
  `, req.user));
});

app.post("/po/import/commit", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  const rows = JSON.parse(String(req.body.rows_json || "[]"));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "purchase_orders",
      rfqId: null,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const result = await upsertPurchaseOrderRow(client, rows[index]);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, index + 2, result.errorCode, result.message, rows[index]);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "purchase_orders", batchId, `rows=${rows.length}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.get("/po/new", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  const vendors = (await query("select id, name from vendors where is_active = true order by name")).rows;
  const vendorOptions = vendors.map((vendor) => `<option value="${vendor.id}">${esc(vendor.name)}</option>`).join("");
  res.send(layout("Add PO", `
    <h1>Add PO</h1>
    <div class="card">
      <form method="post" action="/po/add" class="stack">
        <div class="grid">
          <div><label>PO Number</label><input name="po_no" required /></div>
          <div><label>Vendor</label><select name="vendor_id" required><option value="">Select vendor</option>${vendorOptions}</select></div>
          <div><label>Status</label><select name="status"><option value="OPEN">OPEN</option><option value="CLOSED">CLOSED</option></select></div>
        </div>
        <div class="grid">
          <div><label>Description</label><input name="description" /></div>
        </div>
        <div class="actions"><button type="submit">Add PO</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/po/add", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const result = await client.query(`
      insert into purchase_orders (po_no, vendor_id, rfq_id, description, status, updated_at)
      values ($1, $2, null, $3, $4, now())
      returning id
    `, [String(req.body.po_no || "").trim(), Number(req.body.vendor_id), String(req.body.description || "").trim(), req.body.status || "OPEN"]);
    await auditLog(client, req.user.id, "create", "purchase_order", result.rows[0].id, String(req.body.po_no || "").trim());
  });
  res.redirect("/po");
});

app.get("/po/:id/receive", requireAuth, requirePermission("receiving", "edit"), async (req, res) => {
  const poId = Number(req.params.id);
  const [po, warehouseOptions, locationMap, nextMrrNumber, receivedByOptions] = await Promise.all([
    query(`
      select po.id, po.po_no, coalesce(po.description, '') as description, v.name as vendor_name
      from purchase_orders po
      join vendors v on v.id = po.vendor_id
      where po.id = $1
    `, [poId]),
    getWarehouseOptions(),
    getWarehouseLocationMap(),
    getNextMrrNumber(),
    getMaterialLogLookupOptions("received_by")
  ]);
  const record = po.rows[0];
  if (!record) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>PO not found.</h3></div>`, req.user));
    return;
  }
  const poLines = (await query(`
    select
      pl.id,
      coalesce(pl.po_line, '') as po_line,
      mi.item_code,
      mi.description,
      pl.qty_ordered,
      pl.size_1,
      pl.size_2,
      pl.thk_1,
      pl.thk_2,
      coalesce(rcv.qty_received, 0) as qty_received,
      coalesce(last_receipt.warehouse, '') as last_warehouse,
      coalesce(last_receipt.location, '') as last_location
    from po_lines pl
    join material_items mi on mi.id = pl.material_item_id
    left join (
      select po_line_id, sum(qty_received) as qty_received
      from receipts
      group by po_line_id
    ) rcv on rcv.po_line_id = pl.id
    left join lateral (
      select r.warehouse, r.location
      from receipts r
      where r.po_line_id = pl.id
      order by r.id desc
      limit 1
    ) last_receipt on true
    where pl.po_id = $1
    order by
      case when coalesce(pl.po_line, '') = '' then 1 else 0 end,
      case when coalesce(pl.po_line, '') ~ '^[0-9]+$' then lpad(pl.po_line, 20, '0') else lower(coalesce(pl.po_line, '')) end,
      pl.id
  `, [poId])).rows;
  const history = (await query(`
    select r.received_at, mi.item_code, mi.description, r.qty_received, r.warehouse, r.location, r.osd_status, r.osd_notes
    from receipts r
    join po_lines pl on pl.id = r.po_line_id
    join material_items mi on mi.id = pl.material_item_id
    where pl.po_id = $1
    order by r.id desc
    limit 30
  `, [poId])).rows;
  const warehouseOptionsHtml = [`<option value="">Select warehouse</option>`]
    .concat(warehouseOptions.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`))
    .join("");
  const receivedByOptionsHtml = [`<option value="">Select received by</option>`]
    .concat(receivedByOptions.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`))
    .join("");
  const today = new Date().toISOString().slice(0, 10);
  const lineRows = poLines.map((line) => {
    const lineId = Number(line.id);
    const remainingQty = Math.max(Number(line.qty_ordered || 0) - Number(line.qty_received || 0), 0);
    const locked = remainingQty <= 0;
    const qtyCell = locked
      ? `<span class="chip">Received</span><input type="hidden" name="po_line_ids" value="${lineId}" />`
      : `<input type="hidden" name="po_line_ids" value="${lineId}" /><input name="qty_received_${lineId}" inputmode="decimal" />`;
    const warehouseCell = locked
      ? `<span>${esc(line.last_warehouse || "")}</span>`
      : `<select id="po-line-warehouse-${lineId}" name="warehouse_${lineId}" onchange='syncLocationOptions("po-line-warehouse-${lineId}", "po-line-location-${lineId}", ${escAttr(JSON.stringify(locationMap))})'>${warehouseOptionsHtml}</select>`;
    const locationCell = locked
      ? `<span>${esc(line.last_location || "")}</span>`
      : `<select id="po-line-location-${lineId}" name="location_${lineId}" data-placeholder="Select location"><option value="">Select location</option></select>`;
    return `<tr>
      <td>${esc(line.po_line || "")}</td>
      <td>${esc(line.item_code)}</td>
      <td>${esc(line.description)}</td>
      <td>${esc(line.size_1 || "")}</td>
      <td>${esc(line.size_2 || "")}</td>
      <td>${esc(line.thk_1 || "")}</td>
      <td>${esc(line.thk_2 || "")}</td>
    <td>${esc(formatQtyDisplay(line.qty_ordered))}</td>
      <td>${esc(formatQtyDisplay(line.qty_received))}</td>
      <td>${esc(formatQtyDisplay(remainingQty))}</td>
      <td>${qtyCell}</td>
      <td>${warehouseCell}</td>
      <td>${locationCell}</td>
    </tr>`;
  }).join("");
  const historyRows = history.map((row) => `<tr>
    <td>${esc(formatShortDateTime(row.received_at))}</td>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(formatQtyDisplay(row.qty_received))}</td>
    <td>${esc(row.warehouse)}</td>
    <td>${esc(row.location)}</td>
    <td>${esc(row.osd_status)}</td>
    <td>${esc(row.osd_notes || "")}</td>
  </tr>`).join("");
  res.send(layout("Receive PO", `
    <h1>Receive PO ${esc(record.po_no)}</h1>
    <div class="card">
      <div class="stats">
        <div class="stat"><div>Vendor</div><strong>${esc(record.vendor_name)}</strong></div>
        <div class="stat"><div>Description</div><strong>${esc(record.description || "")}</strong></div>
        <div class="stat"><div>PO Lines</div><strong>${poLines.length}</strong></div>
      </div>
    </div>
    <div class="card">
      <form method="post" action="/po/${record.id}/receive" class="stack" id="po-receive-form-${record.id}">
        <div class="grid">
          <div><label>MRR Number</label><input name="mrr_number" value="${esc(nextMrrNumber)}" readonly /></div>
          <div><label>Received Date</label><input name="received_date" type="date" value="${esc(today)}" required /></div>
          <div><label>Received By</label><div class="inline-field"><select name="received_by" required>${receivedByOptionsHtml}</select><input name="received_by_manual" placeholder="Or enter received by" /></div></div>
          <div><label>Load Number</label><input name="load_number" /></div>
        </div>
        <div class="grid">
          <div><label>Default Warehouse</label><select id="po-receive-warehouse-${record.id}" onchange='applyPoHeaderDefaults("${record.id}", ${escAttr(JSON.stringify(locationMap))})'>${warehouseOptionsHtml}</select></div>
          <div><label>Default Location</label><select id="po-receive-location-${record.id}" data-placeholder="Select location" onchange='applyPoHeaderDefaults("${record.id}", ${escAttr(JSON.stringify(locationMap))})'><option value="">Select location</option></select></div>
          <div><label>OS&D Status</label><select name="osd_status"><option>OK</option><option>OVERAGE</option><option>SHORTAGE</option><option>DAMAGE</option></select></div>
        </div>
        <div class="scroll">
          <table>
            <tr><th>PO Line</th><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Ordered</th><th>Received</th><th>Remaining</th><th>Qty This Receipt</th><th>Warehouse</th><th>Location</th></tr>
            ${lineRows || `<tr><td colspan="13" class="muted">No PO lines found.</td></tr>`}
          </table>
        </div>
        <div><label>MRR Notes</label><textarea name="mrr_notes"></textarea></div>
        <div><label>OS&D Notes</label><textarea name="osd_notes"></textarea></div>
        <div class="actions"><button type="submit">Post Receipt</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
      <script>
        function applyPoHeaderDefaults(poId, optionsByWarehouse) {
          const headerWarehouse = document.getElementById("po-receive-warehouse-" + poId);
          const headerLocation = document.getElementById("po-receive-location-" + poId);
          if (!headerWarehouse || !headerLocation) return;
          syncLocationOptions(headerWarehouse.id, headerLocation.id, optionsByWarehouse, headerLocation.value || "");
          document.querySelectorAll('select[id^="po-line-warehouse-"]').forEach(function(select) {
            select.value = headerWarehouse.value;
            const locationId = select.id.replace("warehouse", "location");
            syncLocationOptions(select.id, locationId, optionsByWarehouse, "");
            const lineLocation = document.getElementById(locationId);
            if (lineLocation) lineLocation.value = headerLocation.value;
          });
        }
        syncLocationOptions("po-receive-warehouse-${record.id}", "po-receive-location-${record.id}", ${JSON.stringify(locationMap)});
        ${poLines.filter((line) => Math.max(Number(line.qty_ordered || 0) - Number(line.qty_received || 0), 0) > 0).map((line) => `syncLocationOptions("po-line-warehouse-${line.id}", "po-line-location-${line.id}", ${JSON.stringify(locationMap)});`).join("\n")}
        document.getElementById("po-receive-form-${record.id}").addEventListener("keydown", function(event) {
          if (event.key !== "Enter") return;
          const tag = (event.target.tagName || "").toUpperCase();
          if (tag === "TEXTAREA" || tag === "BUTTON") return;
          event.preventDefault();
        });
        document.getElementById("po-receive-form-${record.id}").addEventListener("submit", function(event) {
          let hasQty = false;
          let hasError = false;
          const receivedBySelect = document.querySelector('select[name="received_by"]');
          const receivedByManual = document.querySelector('input[name="received_by_manual"]');
          if ((!receivedBySelect || !receivedBySelect.value) && (!receivedByManual || !receivedByManual.value.trim())) {
            event.preventDefault();
            alert("Received By is required for every new MRR.");
            return;
          }
          document.querySelectorAll('input[name^="qty_received_"]').forEach(function(input) {
            const lineId = input.name.replace("qty_received_", "");
            const qty = Number(input.value || 0);
            if (!Number.isFinite(qty) || qty <= 0) return;
            hasQty = true;
            const warehouse = document.getElementById("po-line-warehouse-" + lineId);
            const location = document.getElementById("po-line-location-" + lineId);
            if (!warehouse || !warehouse.value || !location || !location.value) {
              hasError = true;
            }
          });
          if (!hasQty) {
            event.preventDefault();
            alert("Enter a received quantity on at least one editable PO line.");
            return;
          }
          if (hasError) {
            event.preventDefault();
            alert("Warehouse and location are required on every PO line with a received quantity.");
          }
        });
      </script>
    </div>
    <div class="card scroll">
      <table><tr><th>Received</th><th>Item</th><th>Description</th><th>Qty</th><th>Warehouse</th><th>Location</th><th>OS&D</th><th>Notes</th></tr>${historyRows || `<tr><td colspan="8" class="muted">No receipts posted yet for this PO.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.post("/po/:id/receive", requireAuth, requirePermission("receiving", "edit"), async (req, res) => {
  const poId = Number(req.params.id);
  await withTransaction(async (client) => {
    const po = (await client.query(`
      select po.id, po.po_no, po.rfq_id, coalesce(po.description, '') as description, coalesce(v.name, '') as vendor_name
      from purchase_orders po
      left join vendors v on v.id = po.vendor_id
      where po.id = $1
    `, [poId])).rows[0];
    if (!po) throw new Error("PO not found.");
    const mrrNumber = String(req.body.mrr_number || "").trim();
    const receivedBy = String(req.body.received_by_manual || req.body.received_by || "").trim();
    const receivedDate = String(req.body.received_date || "").trim();
    const loadNumber = String(req.body.load_number || "").trim();
    const mrrNotes = String(req.body.mrr_notes || "").trim();
    if (!mrrNumber) throw new Error("MRR number is required.");
    if (!receivedBy) throw new Error("Received By is required.");
    if (!receivedDate) throw new Error("Received Date is required.");
    const lineIds = Array.isArray(req.body.po_line_ids) ? req.body.po_line_ids : [req.body.po_line_ids].filter(Boolean);
    const mrrInsert = (await client.query(`
      insert into mrr_logs (
        discipline, mrr_number, vendor_name, app_po_id, po_number, material_description,
        received_date, received_by, notes, load_number, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      returning id
    `, [
      "",
      mrrNumber,
      po.vendor_name || "",
      po.id,
      po.po_no || "",
      po.description || "",
      receivedDate,
      receivedBy,
      mrrNotes,
      loadNumber
    ])).rows[0];
    await saveMaterialLogLookup(client, "received_by", receivedBy);
    await saveMaterialLogLookup(client, "vendor_name", po.vendor_name || "");
    await saveMaterialLogLookup(client, "po_number", po.po_no || "");
    await auditLog(client, req.user.id, "create", "mrr_log", mrrInsert.id, mrrNumber);
    let postedCount = 0;
    for (const rawLineId of lineIds) {
      const lineId = Number(rawLineId);
      const qtyReceived = parseQtyValue(req.body[`qty_received_${lineId}`] || 0);
      if (!Number.isFinite(qtyReceived) || qtyReceived <= 0) continue;
      const line = (await client.query(`
        select pl.id, pl.qty_ordered, mi.item_code, mi.description, coalesce(sum(r.qty_received), 0) as qty_received
        from po_lines pl
        join material_items mi on mi.id = pl.material_item_id
        left join receipts r on r.po_line_id = pl.id
        where pl.id = $1 and pl.po_id = $2
        group by pl.id, pl.qty_ordered, mi.item_code, mi.description
      `, [lineId, poId])).rows[0];
      if (!line) throw new Error("PO line not found.");
      const remainingQty = Math.max(Number(line.qty_ordered || 0) - Number(line.qty_received || 0), 0);
      if (remainingQty <= 0) throw new Error("Fully received PO lines cannot be edited.");
      const warehouse = normalizeWarehouseName(req.body[`warehouse_${lineId}`]);
      const location = normalizeLocationName(req.body[`location_${lineId}`]);
      await assertValidWarehouseLocation(client, warehouse, location);
      const enteredStatus = String(req.body.osd_status || "OK").trim() || "OK";
      const enteredNotes = String(req.body.osd_notes || "").trim();
      const baseQty = Math.min(qtyReceived, remainingQty);
      const overageQty = Math.max(qtyReceived - remainingQty, 0);
      if (baseQty > 0) {
        const receipt = (await client.query(`
          insert into receipts (po_line_id, mrr_log_id, qty_received, warehouse, location, osd_status, osd_notes)
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id
        `, [lineId, mrrInsert.id, baseQty, warehouse, location, enteredStatus, enteredNotes])).rows[0];
        postedCount += 1;
        if (enteredStatus !== "OK") {
          await createOsdLog(client, {
            mrr_log_id: mrrInsert.id,
            receipt_id: receipt.id,
            po_id: po.id,
            po_line_id: lineId,
            mrr_number: mrrNumber,
            po_number: po.po_no || "",
            item_code: line.item_code || "",
            description: line.description || "",
            warehouse,
            location,
            expected_qty: remainingQty,
            received_qty: baseQty,
            osd_qty: baseQty,
            osd_status: enteredStatus,
            notes: enteredNotes
          });
        }
      }
      if (overageQty > 0) {
        const overReceipt = (await client.query(`
          insert into receipts (po_line_id, mrr_log_id, qty_received, warehouse, location, osd_status, osd_notes)
          values ($1, $2, $3, $4, $5, 'OVERAGE', $6)
          returning id
        `, [lineId, mrrInsert.id, overageQty, warehouse, location, enteredNotes ? `Auto-created overage from PO receipt. ${enteredNotes}` : "Auto-created overage from PO receipt."])).rows[0];
        postedCount += 1;
        await createOsdLog(client, {
          mrr_log_id: mrrInsert.id,
          receipt_id: overReceipt.id,
          po_id: po.id,
          po_line_id: lineId,
          mrr_number: mrrNumber,
          po_number: po.po_no || "",
          item_code: line.item_code || "",
          description: line.description || "",
          warehouse,
          location,
          expected_qty: remainingQty,
          received_qty: qtyReceived,
          osd_qty: overageQty,
          osd_status: "OVERAGE",
          notes: enteredNotes ? `Auto-created from over receipt. ${enteredNotes}` : "Auto-created from over receipt."
        });
      }
    }
    if (postedCount === 0) throw new Error("Enter a received quantity on at least one editable PO line.");
    await recalcPoStatus(client, poId);
    if (po?.rfq_id) await recalcRfqStatus(client, po.rfq_id);
    await auditLog(client, req.user.id, "create", "receipt", poId, `po=${poId};mrr=${mrrNumber};lines=${postedCount}`);
  });
  res.redirect("/dashboard");
});

app.get("/po/:id/edit", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  const [po, vendors, poLines] = await Promise.all([
    query(`
      select po.id, po.po_no, po.vendor_id, po.status, po.created_at, extract(epoch from po.updated_at)::text as updated_token,
             coalesce(po.description, '') as description, coalesce(r.rfq_no, '') as rfq_no
      from purchase_orders po
      left join rfqs r on r.id = po.rfq_id
      where po.id = $1
    `, [req.params.id]),
    query("select id, name from vendors order by name"),
    query(`
      select pl.id, coalesce(pl.po_line, '') as po_line, mi.item_code, mi.description, pl.qty_ordered, pl.unit_price,
             coalesce(pl.size_1, '') as size_1, coalesce(pl.size_2, '') as size_2, coalesce(pl.thk_1, '') as thk_1, coalesce(pl.thk_2, '') as thk_2
      from po_lines pl
      join material_items mi on mi.id = pl.material_item_id
      where pl.po_id = $1
      order by
        case when coalesce(pl.po_line, '') = '' then 1 else 0 end,
        case when coalesce(pl.po_line, '') ~ '^[0-9]+$' then lpad(pl.po_line, 20, '0') else lower(coalesce(pl.po_line, '')) end,
        pl.id
    `, [req.params.id])
  ]);
  const record = po.rows[0];
  const vendorOptions = vendors.rows.map((vendor) => `<option value="${vendor.id}" ${vendor.id === record.vendor_id ? "selected" : ""}>${esc(vendor.name)}</option>`).join("");
  const poLineRows = poLines.rows.map((line) => `<tr>
    <td>${esc(line.po_line || "")}</td>
    <td>${esc(line.item_code)}</td>
    <td>${esc(line.description)}</td>
    <td>${esc(line.size_1)}</td>
    <td>${esc(line.size_2)}</td>
    <td>${esc(line.thk_1)}</td>
    <td>${esc(line.thk_2)}</td>
      <td>${esc(formatQtyDisplay(line.qty_ordered))}</td>
    <td>${esc(line.unit_price)}</td>
    <td><a class="btn btn-secondary" href="/po-line/${line.id}/edit">Edit Line</a></td>
  </tr>`).join("");
  res.send(layout("Edit PO", `
    <h1>Edit PO</h1>
    <div class="card">
      <p class="muted">RFQ: ${esc(record.rfq_no || "N/A")} | Created: ${esc(formatShortDateTime(record.created_at))}</p>
      <form method="post" action="/po/${record.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(record.updated_token)}" />
        <div class="grid">
          <div><label>PO Number</label><input name="po_no" value="${esc(record.po_no)}" required /></div>
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Status</label><select name="status"><option value="OPEN" ${record.status === "OPEN" ? "selected" : ""}>OPEN</option><option value="CLOSED" ${record.status === "CLOSED" ? "selected" : ""}>CLOSED</option></select></div>
        </div>
        <div class="grid">
          <div><label>Description</label><input name="description" value="${esc(record.description || "")}" /></div>
        </div>
        <div class="actions">
          <button type="submit">Save PO</button>
          <a class="btn btn-secondary" href="/po">Back</a>
          <form method="post" action="/po/${record.id}/delete" onsubmit="return confirm('Delete PO ${escAttr(record.po_no)}? This will also remove its PO lines and receipts.');">
            <button class="btn btn-danger" type="submit">Delete PO</button>
          </form>
        </div>
      </form>
    </div>
    <div class="card scroll">
      <h3>PO Lines</h3>
      <table><tr><th>PO Line</th><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Unit Price</th><th>Action</th></tr>${poLineRows || `<tr><td colspan="10" class="muted">No PO lines found.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.post("/po/:id/edit", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const update = await client.query(`
      update purchase_orders
      set po_no = $2, vendor_id = $3, status = $4, description = $5, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $6
    `, [req.params.id, req.body.po_no?.trim(), Number(req.body.vendor_id), req.body.status || "OPEN", String(req.body.description || "").trim(), req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This PO was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "purchase_order", req.params.id, req.body.po_no?.trim() || "");
  });
  res.redirect("/po");
});

app.post("/po/:id/delete", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const po = (await client.query("select rfq_id from purchase_orders where id = $1", [req.params.id])).rows[0];
    await client.query("delete from purchase_orders where id = $1", [req.params.id]);
    if (po?.rfq_id) await recalcRfqStatus(client, po.rfq_id);
    await auditLog(client, req.user.id, "delete", "purchase_order", req.params.id, "");
  });
  res.redirect("/po");
});

app.get("/po-line/:id/edit", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  const line = (await query(`
    select pl.id, coalesce(pl.po_line, '') as po_line, pl.qty_ordered, pl.unit_price, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2, extract(epoch from pl.updated_at)::text as updated_token,
           mi.item_code, mi.description, po.po_no
    from po_lines pl
    join material_items mi on mi.id = pl.material_item_id
    join purchase_orders po on po.id = pl.po_id
    where pl.id = $1
  `, [req.params.id])).rows[0];
  res.send(layout("Edit PO Line", `
    <h1>Edit PO Line</h1>
    <div class="card"><strong>PO:</strong> ${esc(line.po_no)} | <strong>Item:</strong> ${esc(line.item_code)} - ${esc(line.description)}</div>
    <div class="card">
      <form method="post" action="/po-line/${line.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(line.updated_token)}" />
        <div class="grid">
          <div><label>PO Line</label><input name="po_line" value="${esc(line.po_line || "")}" /></div>
          <div><label>Qty Ordered</label><input name="qty_ordered" value="${esc(formatQtyDisplay(line.qty_ordered))}" required /></div>
          <div><label>Unit Price</label><input name="unit_price" value="${esc(line.unit_price)}" required /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(line.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(line.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(line.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(line.thk_2 || "")}" /></div>
        </div>
        <div class="actions"><button type="submit">Save PO Line</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/po-line/:id/edit", requireAuth, requirePermission("pos", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const update = await client.query(`
      update po_lines
      set po_line = $2, qty_ordered = $3, unit_price = $4, size_1 = $5, size_2 = $6, thk_1 = $7, thk_2 = $8, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $9
    `, [req.params.id, req.body.po_line || "", parseQtyValue(req.body.qty_ordered), Number(req.body.unit_price), req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This PO line was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "po_line", req.params.id, "");
  });
  res.redirect("/po");
});

app.get("/receive", requireAuth, requirePermission("receiving", "view"), async (req, res) => {
  res.send(layout("Receiving", `
    <h1>Receiving</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-primary" href="/receive/by-po">By PO</a>
        <a class="btn btn-primary" href="/material-logs/mrr/new">Manual Entry</a>
      </div>
    </div>
  `, req.user));
});

app.get("/receive/by-po", requireAuth, requirePermission("receiving", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(po.po_no ilike $1 or coalesce(po.description, '') ilike $1)`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = (await query(`
    select
      po.id,
      po.po_no,
      coalesce(po.description, '') as description,
      coalesce(v.name, '') as vendor_name,
      po.status,
      count(pl.id) as line_count,
      count(pl.id) filter (
        where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) < pl.qty_ordered
      ) as open_line_count
    from purchase_orders po
    left join vendors v on v.id = po.vendor_id
    left join po_lines pl on pl.po_id = po.id
    ${whereSql}
    group by po.id, po.po_no, po.description, v.name, po.status
    order by po.id desc
    limit 300
  `, params)).rows;
  const poRows = rows.map((row) => `<tr>
    <td>${esc(row.po_no)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.status)}</td>
    <td>${esc(row.line_count)}</td>
    <td>${esc(row.open_line_count)}</td>
    <td><a class="btn btn-secondary" href="/po/${row.id}/receive">Receive</a></td>
  </tr>`).join("");
  res.send(layout("Receive By PO", `
    <h1>Receive By PO</h1>
    <div class="card">
      <form method="get" action="/receive/by-po" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto auto;">
          <div><label>Filter POs</label><input name="q" value="${esc(q)}" placeholder="PO number or description" /></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
          <div style="align-self:end;"><a class="btn btn-secondary" href="/receive/by-po">Clear</a></div>
        </div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>PO #</th><th>Description</th><th>Vendor</th><th>Status</th><th>Lines</th><th>Open Lines</th><th>Action</th></tr>${poRows || `<tr><td colspan="7" class="muted">No purchase orders found.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.get("/receive/:mrrId", requireAuth, requirePermission("receiving", "edit"), async (req, res) => {
  const mrrId = Number(req.params.mrrId);
  const backHref = typeof req.query.back === "string" && req.query.back.startsWith("/") ? req.query.back : "/receive";
  const mrr = (await query("select * from mrr_logs where id = $1", [mrrId])).rows[0];
  if (!mrr) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>MRR not found.</h3></div>`, req.user));
    return;
  }
  const po = mrr.app_po_id
    ? (await query("select id, po_no from purchase_orders where id = $1", [mrr.app_po_id])).rows[0]
    : (mrr.po_number ? (await query("select id, po_no from purchase_orders where po_no = $1", [mrr.po_number])).rows[0] : null);
  const warehouseOptions = await getWarehouseOptions();
  const locationMap = await getWarehouseLocationMap();
  const warehouseOptionsHtml = [`<option value="">Select warehouse</option>`]
    .concat(warehouseOptions.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`))
    .join("");
  const openLines = po ? (await query(`
    select
      pl.id,
      coalesce(pl.po_line, '') as po_line,
      mi.item_code,
      mi.description,
      pl.qty_ordered,
      pl.size_1,
      pl.size_2,
      pl.thk_1,
      pl.thk_2,
      coalesce(rcv.qty_received, 0) as qty_received
    from po_lines pl
    join material_items mi on mi.id = pl.material_item_id
    left join (
      select po_line_id, sum(qty_received) as qty_received
      from receipts
      group by po_line_id
    ) rcv on rcv.po_line_id = pl.id
    where pl.po_id = $1
      and coalesce(rcv.qty_received, 0) < pl.qty_ordered
    order by
      case when coalesce(pl.po_line, '') = '' then 1 else 0 end,
      case when coalesce(pl.po_line, '') ~ '^[0-9]+$' then lpad(pl.po_line, 20, '0') else lower(coalesce(pl.po_line, '')) end,
      pl.id
  `, [po.id])).rows : [];
  const lineOptions = openLines.map((line) => `<option value="${line.id}">${esc(line.po_line || "")}${line.po_line ? " | " : ""}${esc(line.item_code)} | ${esc(line.description)} | Ordered ${esc(formatQtyDisplay(line.qty_ordered))} | Rec ${esc(formatQtyDisplay(line.qty_received))} | ${esc(line.size_1 || "")}/${esc(line.size_2 || "")} | ${esc(line.thk_1 || "")}/${esc(line.thk_2 || "")}</option>`).join("");
  res.send(layout("Receive MRR", `
    <h1>Receive ${esc(mrr.mrr_number)}</h1>
    <div class="card">
      <div class="stats">
        <div class="stat"><div>PO</div><strong>${esc(mrr.po_number || "No PO")}</strong></div>
        <div class="stat"><div>Vendor</div><strong>${esc(mrr.vendor_name || "")}</strong></div>
        <div class="stat"><div>Received By</div><strong>${esc(mrr.received_by || "")}</strong></div>
        <div class="stat"><div>Load #</div><strong>${esc(mrr.load_number || "")}</strong></div>
      </div>
      <p class="muted" style="margin-top:10px;">${esc(mrr.material_description || "")}</p>
    </div>
    <div class="card">
      <h3>${po ? "Receive Against PO" : "Receive Without PO"}</h3>
      <form method="post" action="/receive/${mrr.id}" class="stack">
        <input type="hidden" name="mode" value="${po ? "po" : "manual"}" />
        ${po ? `
          <div><label>PO Line</label><select name="po_line_id" required><option value="">Select open PO line</option>${lineOptions}</select></div>
        ` : `
          <div class="grid">
            <div><label>Item Code</label><input name="item_code" /></div>
            <div><label>Qty Unit</label><input name="qty_unit" value="EA" /></div>
          </div>
          <div><label>Description</label><input name="description" value="${esc(mrr.material_description || "")}" /></div>
        `}
        <div class="grid">
          <div><label>Qty Received</label><input name="qty_received" required inputmode="decimal" /></div>
          <div><label>Warehouse</label><select id="receive-warehouse-${mrr.id}" name="warehouse" required onchange='syncLocationOptions("receive-warehouse-${mrr.id}", "receive-location-${mrr.id}", ${escAttr(JSON.stringify(locationMap))})'>${warehouseOptionsHtml}</select></div>
          <div><label>Location</label><select id="receive-location-${mrr.id}" name="location" data-placeholder="Select location" required><option value="">Select location</option></select></div>
          <div><label>OS&D Status</label><select name="osd_status"><option>OK</option><option>OVERAGE</option><option>SHORTAGE</option><option>DAMAGE</option></select></div>
        </div>
        <div><label>OS&D Notes</label><textarea name="osd_notes"></textarea></div>
        <div class="actions"><button type="submit">${po ? "Post Receipt Against PO" : "Log No-PO Receipt"}</button><a class="btn btn-secondary" href="${escAttr(backHref)}">Back</a></div>
      </form>
      <script>syncLocationOptions("receive-warehouse-${mrr.id}", "receive-location-${mrr.id}", ${JSON.stringify(locationMap)});</script>
      ${po ? (openLines.length ? "" : `<p class="muted">All PO lines tied to this MRR are already fully received.</p>`) : `<p class="muted">No-PO receipts are logged for traceability, but they do not post into PO-based inventory until a PO line exists.</p>`}
    </div>
  `, req.user));
});

app.post("/receive/:mrrId", requireAuth, requirePermission("receiving", "edit"), async (req, res) => {
  const mrrId = Number(req.params.mrrId);
  await withTransaction(async (client) => {
    const mrr = (await client.query("select * from mrr_logs where id = $1", [mrrId])).rows[0];
    if (!mrr) throw new Error("MRR not found.");
    const qtyReceived = parseQtyValue(req.body.qty_received || 0);
    if (!Number.isFinite(qtyReceived) || qtyReceived <= 0) throw new Error("Qty received must be greater than zero.");
    await assertValidWarehouseLocation(client, req.body.warehouse, req.body.location);
    const normalizedNames = normalizeWarehouseLocationValues(req.body.warehouse, req.body.location);
    if (String(req.body.mode || "") === "po") {
      const poLine = (await client.query(`
        select po.id as po_id, po.po_no, po.rfq_id, mi.item_code, mi.description
        from po_lines pl
        join purchase_orders po on po.id = pl.po_id
        join material_items mi on mi.id = pl.material_item_id
        where pl.id = $1
      `, [Number(req.body.po_line_id)])).rows[0];
      const insert = await client.query(`
        insert into receipts (mrr_log_id, po_line_id, qty_received, warehouse, location, osd_status, osd_notes)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `, [mrrId, Number(req.body.po_line_id), qtyReceived, normalizedNames.warehouse, normalizedNames.location, req.body.osd_status || "OK", req.body.osd_notes || ""]);
      if ((req.body.osd_status || "OK") !== "OK") {
        await createOsdLog(client, {
          mrr_log_id: mrrId,
          receipt_id: insert.rows[0].id,
          po_id: poLine?.po_id || null,
          po_line_id: Number(req.body.po_line_id),
          mrr_number: mrr.mrr_number || "",
          po_number: poLine?.po_no || mrr.po_number || "",
          item_code: poLine?.item_code || "",
          description: poLine?.description || "",
          warehouse: normalizedNames.warehouse,
          location: normalizedNames.location,
          expected_qty: qtyReceived,
          received_qty: qtyReceived,
          osd_qty: qtyReceived,
          osd_status: req.body.osd_status || "OK",
          notes: req.body.osd_notes || ""
        });
      }
      if (poLine?.po_id) await recalcPoStatus(client, poLine.po_id);
      if (poLine?.rfq_id) await recalcRfqStatus(client, poLine.rfq_id);
      await auditLog(client, req.user.id, "create", "receipt", insert.rows[0].id, `mrr=${mrr.mrr_number};po_line=${req.body.po_line_id}`);
    } else {
      const result = await client.query(`
        insert into material_receiving_logs (
          discipline, vendor_name, po_number, item_code, description, received_qty, qty_unit, mrr_number, warehouse, location, recv_date, comments, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        returning id
      `, [
        mrr.discipline || "",
        mrr.vendor_name || "",
        mrr.po_number || "",
        req.body.item_code?.trim() || "",
        req.body.description?.trim() || mrr.material_description || "",
        qtyReceived,
        req.body.qty_unit?.trim() || "",
        mrr.mrr_number || "",
        normalizedNames.warehouse,
        normalizedNames.location,
        mrr.received_date || "",
        req.body.osd_notes?.trim() || ""
      ]);
      await auditLog(client, req.user.id, "create", "material_receiving_log", result.rows[0].id, `mrr=${mrr.mrr_number}`);
    }
  });
  res.redirect("/receive");
});

app.get("/inventory", requireAuth, requirePermission("inventory", "view"), async (req, res) => {
  const warehouseFilter = String(req.query.warehouse_filter || "").trim();
  const locationFilter = String(req.query.location_filter || "").trim();
  const identFilter = String(req.query.ident_filter || "").trim();
  const allowedSorts = {
    item_code: "coalesce(item_code, '')",
    description: "coalesce(description, '')",
    size_1: "coalesce(size_1, '')",
    size_2: "coalesce(size_2, '')",
    thk_1: "coalesce(thk_1, '')",
    thk_2: "coalesce(thk_2, '')",
    warehouse: "coalesce(warehouse, '')",
    location: "coalesce(location, '')",
    qty_on_hand: "qty_on_hand",
    qty_osd: "qty_osd"
  };
  const sort = String(req.query.sort || "item_code").trim();
  const dir = String(req.query.dir || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
  const sortSql = allowedSorts[sort] || allowedSorts.item_code;
  const [warehouseOptions, locationMap] = await Promise.all([
    getWarehouseOptions(),
    getWarehouseLocationMap()
  ]);
  const params = [];
  const where = [];
  if (warehouseFilter) {
    params.push(`%${warehouseFilter}%`);
    where.push(`coalesce(warehouse, '') ilike $${params.length}`);
  }
  if (locationFilter) {
    params.push(`%${locationFilter}%`);
    where.push(`coalesce(location, '') ilike $${params.length}`);
  }
  if (identFilter) {
    params.push(`%${identFilter}%`);
    where.push(`(coalesce(item_code, '') ilike $${params.length} or coalesce(description, '') ilike $${params.length})`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const inventoryQueryString = (source = {}) => new URLSearchParams({
    warehouse_filter: String(source.warehouse_filter || ""),
    location_filter: String(source.location_filter || ""),
    ident_filter: String(source.ident_filter || ""),
    sort: String(source.sort || sort),
    dir: String(source.dir || dir)
  }).toString();
  const rows = (await query(`
    select *
    from (${getInventoryByLocationSubquery()}) inventory_by_location
    ${whereSql}
    order by ${sortSql} ${dir}, item_code asc, warehouse asc, location asc
  `, params)).rows;
  const sortLink = (column) => `/inventory?${inventoryQueryString({ warehouse_filter: warehouseFilter, location_filter: locationFilter, ident_filter: identFilter, sort: column, dir: nextSortDir(sort, dir, column) })}`;
  const warehouseOptionsHtml = [`<option value="">All warehouses</option>`]
    .concat(warehouseOptions.map((row) => `<option value="${esc(row.name)}" ${row.name === warehouseFilter ? "selected" : ""}>${esc(row.name)}</option>`))
    .join("");
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.item_code)}</td><td>${esc(row.description)}</td><td>${esc(row.size_1 || "")}</td><td>${esc(row.size_2 || "")}</td>
    <td>${esc(row.thk_1 || "")}</td><td>${esc(row.thk_2 || "")}</td><td>${esc(row.warehouse)}</td><td>${esc(row.location)}</td>
    <td>${esc(formatQtyDisplay(row.qty_on_hand))}</td><td>${esc(formatQtyDisplay(row.qty_osd))}</td>
  </tr>`).join("");
  res.send(layout("Inventory", `
    <h1>Inventory by Location</h1>
    <div class="card">
      <div class="grid" style="grid-template-columns: 1fr 1fr 1fr;">
        <form method="get" action="/inventory" class="stack">
          <label>Warehouse</label>
          <select id="inventory-warehouse" name="warehouse_filter" onchange='syncLocationOptions("inventory-warehouse", "inventory-location", ${escAttr(JSON.stringify(locationMap))}, "${escAttr(locationFilter)}")'>${warehouseOptionsHtml}</select>
          <input type="hidden" name="location_filter" value="${esc(locationFilter)}" />
          <input type="hidden" name="ident_filter" value="${esc(identFilter)}" />
          <input type="hidden" name="sort" value="${esc(sort)}" />
          <input type="hidden" name="dir" value="${esc(dir)}" />
          <div class="actions">
            <button type="submit">Apply Warehouse</button>
            <a class="btn btn-secondary" href="/inventory?${inventoryQueryString({ location_filter: locationFilter, ident_filter: identFilter })}">Clear Warehouse</a>
          </div>
        </form>
        <form method="get" action="/inventory" class="stack">
          <input type="hidden" name="warehouse_filter" value="${esc(warehouseFilter)}" />
          <label>Location</label>
          <select id="inventory-location" name="location_filter" data-placeholder="All locations"><option value="">All locations</option></select>
          <input type="hidden" name="ident_filter" value="${esc(identFilter)}" />
          <input type="hidden" name="sort" value="${esc(sort)}" />
          <input type="hidden" name="dir" value="${esc(dir)}" />
          <div class="actions">
            <button type="submit">Apply Location</button>
            <a class="btn btn-secondary" href="/inventory?${inventoryQueryString({ warehouse_filter: warehouseFilter, ident_filter: identFilter })}">Clear Location</a>
          </div>
        </form>
        <form method="get" action="/inventory" class="stack">
          <label>Ident</label>
          <input name="ident_filter" value="${esc(identFilter)}" />
          <input type="hidden" name="warehouse_filter" value="${esc(warehouseFilter)}" />
          <input type="hidden" name="location_filter" value="${esc(locationFilter)}" />
          <input type="hidden" name="sort" value="${esc(sort)}" />
          <input type="hidden" name="dir" value="${esc(dir)}" />
          <div class="actions">
            <button type="submit">Apply Ident</button>
            <a class="btn btn-secondary" href="/inventory?${inventoryQueryString({ warehouse_filter: warehouseFilter, location_filter: locationFilter })}">Clear Ident</a>
          </div>
        </form>
      </div>
    </div>
    <div class="card scroll"><table><tr><th><a href="${sortLink("item_code")}">${esc(sortLabel("Item", sort, dir, "item_code"))}</a></th><th><a href="${sortLink("description")}">${esc(sortLabel("Description", sort, dir, "description"))}</a></th><th><a href="${sortLink("size_1")}">${esc(sortLabel("Size 1", sort, dir, "size_1"))}</a></th><th><a href="${sortLink("size_2")}">${esc(sortLabel("Size 2", sort, dir, "size_2"))}</a></th><th><a href="${sortLink("thk_1")}">${esc(sortLabel("Thk 1", sort, dir, "thk_1"))}</a></th><th><a href="${sortLink("thk_2")}">${esc(sortLabel("Thk 2", sort, dir, "thk_2"))}</a></th><th><a href="${sortLink("warehouse")}">${esc(sortLabel("Warehouse", sort, dir, "warehouse"))}</a></th><th><a href="${sortLink("location")}">${esc(sortLabel("Location", sort, dir, "location"))}</a></th><th><a href="${sortLink("qty_on_hand")}">${esc(sortLabel("Qty On Hand", sort, dir, "qty_on_hand"))}</a></th><th><a href="${sortLink("qty_osd")}">${esc(sortLabel("Qty OS&D", sort, dir, "qty_osd"))}</a></th></tr>${tableRows}</table></div>
    <script>syncLocationOptions("inventory-warehouse", "inventory-location", ${JSON.stringify(locationMap)}, ${JSON.stringify(locationFilter)});</script>
  `, req.user));
});

app.get("/inventory-audit", requireAuth, requirePermission("inventory", "view"), asyncHandler(async (req, res) => {
  const createdReportNo = String(req.query.created_report_no || "").trim();
  const recentReports = await query(`
    select
      r.id,
      r.report_no,
      r.created_at,
      u.username as created_by_name
    from inventory_audit_reports r
    left join users u on u.id = r.created_by
    order by r.id desc
    limit 50
  `);
  const recentReportRows = recentReports.rows.map((row) => `<tr>
    <td>${esc(row.report_no)}</td>
    <td>${esc(formatShortDateTime(row.created_at))}</td>
    <td>${esc(row.created_by_name || "")}</td>
    <td><a class="btn btn-secondary" href="/inventory-audit/reports/${row.id}">View</a></td>
  </tr>`).join("");
  res.send(layout("Inventory Audit", `
    <h1>Inventory Audit</h1>
    ${createdReportNo ? `<div class="card success"><strong>Saved audit ${esc(createdReportNo)}.</strong> Inventory quantities have been updated and the entry sheet was reset.</div>` : ""}
    <div class="card">
      <div class="actions">
        ${canEditInventoryAudit(req.user) ? `<a class="btn btn-primary" href="/inventory-audit/new">New Audit</a>` : ""}
        <a class="btn btn-secondary" href="/yard">Back To Yard</a>
      </div>
    </div>
    ${canEditInventoryAudit(req.user) ? `
      <div class="card">
        <h3 style="margin-top:0;">Import Current Inventory Reset</h3>
        <p class="muted">Upload the current inventory workbook to create one full replacement audit. Rows in the workbook become the new on-hand truth, and inventory rows missing from the file are reset to zero.</p>
        <form method="post" enctype="multipart/form-data" action="/inventory-audit/import" class="stack">
          <div><label>Inventory Workbook</label><input type="file" name="sheet" required /></div>
          <div class="actions"><button type="submit">Import Current Inventory</button></div>
        </form>
      </div>
    ` : ""}
    <div class="card scroll">
      <h3 style="margin-top:0;">Past Inventory Audit Reports</h3>
      <table><tr><th>Report #</th><th>Created</th><th>Created By</th><th>Action</th></tr>${recentReportRows || `<tr><td colspan="4" class="muted">No audit reports created yet.</td></tr>`}</table>
    </div>
  `, req.user));
}));

app.get("/inventory-audit/new", requireAuth, requireInventoryAuditEdit, asyncHandler(async (req, res) => {
  const warehouseFilter = String(req.query.warehouse_filter || "").trim();
  const locationFilter = String(req.query.location_filter || "").trim();
  const identFilter = String(req.query.ident_filter || "").trim();
  const [warehouseOptions, locationMap] = await Promise.all([
    getWarehouseOptions(),
    getWarehouseLocationMap()
  ]);
  const params = [];
  const where = [];
  if (warehouseFilter) {
    params.push(`%${warehouseFilter}%`);
    where.push(`coalesce(inventory_by_location.warehouse, '') ilike $${params.length}`);
  }
  if (locationFilter) {
    params.push(`%${locationFilter}%`);
    where.push(`coalesce(inventory_by_location.location, '') ilike $${params.length}`);
  }
  if (identFilter) {
    params.push(`%${identFilter}%`);
    where.push(`(
      coalesce(inventory_by_location.item_code, '') ilike $${params.length}
      or coalesce(inventory_by_location.description, '') ilike $${params.length}
    )`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = await getCurrentOnHandRows({ query }, {
    whereSql,
    params,
    orderSql: "inventory_by_location.item_code, inventory_by_location.warehouse, inventory_by_location.location"
  });
  const warehouseOptionsHtml = [`<option value="">All warehouses</option>`]
    .concat(warehouseOptions.map((row) => `<option value="${esc(row.name)}" ${row.name === warehouseFilter ? "selected" : ""}>${esc(row.name)}</option>`))
    .join("");
  const rowWarehouseOptionsHtml = [`<option value="">Select warehouse</option>`]
    .concat(warehouseOptions.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`))
    .join("");
  const rowLocationScripts = [];
  const tableRows = rows.map((row, index) => {
    const key = Buffer.from(JSON.stringify({
      item_code: row.item_code || "",
      description: row.description || "",
      size_1: row.size_1 || "",
      size_2: row.size_2 || "",
      thk_1: row.thk_1 || "",
      thk_2: row.thk_2 || "",
      warehouse: row.warehouse || "",
      location: row.location || ""
    })).toString("base64url");
    const warehouseSelectId = `inventory-audit-row-warehouse-${index}`;
    const locationSelectId = `inventory-audit-row-location-${index}`;
    rowLocationScripts.push(`syncLocationOptions("${warehouseSelectId}", "${locationSelectId}", ${JSON.stringify(locationMap)}, ${JSON.stringify(row.location || "")});`);
    return `<tr>
      <td>${esc(row.item_code)}</td>
      <td>${esc(row.description)}</td>
      <td>${esc(row.size_1 || "")}</td>
      <td>${esc(row.size_2 || "")}</td>
      <td>${esc(row.thk_1 || "")}</td>
      <td>${esc(row.thk_2 || "")}</td>
      <td>
        <select id="${warehouseSelectId}" name="warehouse_${index}" tabindex="-1" onchange='syncLocationOptions("${warehouseSelectId}", "${locationSelectId}", ${escAttr(JSON.stringify(locationMap))})'>${rowWarehouseOptionsHtml.replace(`value="${esc(row.warehouse)}"`, `value="${esc(row.warehouse)}" selected`)}</select>
      </td>
      <td>
        <select id="${locationSelectId}" name="location_${index}" tabindex="-1" data-placeholder="Select location"><option value="">Select location</option></select>
      </td>
      <td>${esc(formatQtyDisplay(row.qty_on_hand))}</td>
      <td>
        <input type="hidden" name="key_${index}" value="${esc(key)}" />
        <input name="actual_qty_${index}" value="" placeholder="Actual qty" style="min-width:110px;" inputmode="decimal" enterkeyhint="next" autocapitalize="off" autocomplete="off" data-qty-input="true" />
      </td>
    </tr>`;
  }).join("");
  res.send(layout("Inventory Audit", `
    <h1>New Inventory Audit</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-secondary" href="/inventory-audit">Back To Audit Reports</a>
      </div>
    </div>
    <div class="card">
      <div class="grid" style="grid-template-columns: 1fr 1fr 1fr;">
        <form method="get" action="/inventory-audit/new" class="stack">
          <label>Warehouse</label>
          <select id="inventory-audit-warehouse" name="warehouse_filter" onchange='syncLocationOptions("inventory-audit-warehouse", "inventory-audit-location", ${escAttr(JSON.stringify(locationMap))}, "${escAttr(locationFilter)}")'>${warehouseOptionsHtml}</select>
          <input type="hidden" name="location_filter" value="${esc(locationFilter)}" />
          <input type="hidden" name="ident_filter" value="${esc(identFilter)}" />
          <div class="actions">
            <button type="submit">Apply Warehouse</button>
            <a class="btn btn-secondary" href="/inventory-audit/new?${getInventoryAuditQueryString({ location_filter: locationFilter, ident_filter: identFilter })}">Clear Warehouse</a>
          </div>
        </form>
        <form method="get" action="/inventory-audit/new" class="stack">
          <input type="hidden" name="warehouse_filter" value="${esc(warehouseFilter)}" />
          <label>Location</label>
          <select id="inventory-audit-location" name="location_filter" data-placeholder="All locations"><option value="">All locations</option></select>
          <input type="hidden" name="ident_filter" value="${esc(identFilter)}" />
          <div class="actions">
            <button type="submit">Apply Location</button>
            <a class="btn btn-secondary" href="/inventory-audit/new?${getInventoryAuditQueryString({ warehouse_filter: warehouseFilter, ident_filter: identFilter })}">Clear Location</a>
          </div>
        </form>
        <form method="get" action="/inventory-audit/new" class="stack">
          <label>Ident</label>
          <input name="ident_filter" value="${esc(identFilter)}" />
          <input type="hidden" name="warehouse_filter" value="${esc(warehouseFilter)}" />
          <input type="hidden" name="location_filter" value="${esc(locationFilter)}" />
          <div class="actions">
            <button type="submit">Apply Ident</button>
            <a class="btn btn-secondary" href="/inventory-audit/new?${getInventoryAuditQueryString({ warehouse_filter: warehouseFilter, location_filter: locationFilter })}">Clear Ident</a>
          </div>
        </form>
      </div>
    </div>
    <form method="post" action="/inventory-audit/commit" class="stack" id="inventory-audit-commit-form">
      <input type="hidden" name="row_count" value="${rows.length}" />
      <input type="hidden" name="warehouse_filter" value="${esc(warehouseFilter)}" />
      <input type="hidden" name="location_filter" value="${esc(locationFilter)}" />
      <input type="hidden" name="ident_filter" value="${esc(identFilter)}" />
      <div class="card">
        <div class="actions">
          <button type="submit">Save Audit</button>
        </div>
        <p class="muted" style="margin:8px 0 0 0;">Enter only the rows you counted. You can also change warehouse and location before saving. Saving creates one audit report and applies all entered quantity adjustments together.</p>
      </div>
      <div class="card scroll">
        <table>
          <tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Warehouse</th><th>Location</th><th>Qty On Hand</th><th>Actual On-Hand Qty</th></tr>
          ${tableRows || `<tr><td colspan="10" class="muted">No inventory rows found for the current filters.</td></tr>`}
        </table>
      </div>
      ${rows.length ? `<div class="card"><div class="actions"><button type="submit">Save Audit</button></div></div>` : ""}
    </form>
    <script>
      syncLocationOptions("inventory-audit-warehouse", "inventory-audit-location", ${JSON.stringify(locationMap)}, ${JSON.stringify(locationFilter)});
      ${rowLocationScripts.join("\n      ")}
      (function () {
        const commitForm = document.getElementById("inventory-audit-commit-form");
        const qtyInputs = Array.from(document.querySelectorAll('input[data-qty-input="true"]'));
        if (!commitForm || !qtyInputs.length) return;
        function focusNextQty(currentInput) {
          const currentIndex = qtyInputs.indexOf(currentInput);
          if (currentIndex >= 0 && currentIndex < qtyInputs.length - 1) {
            const nextInput = qtyInputs[currentIndex + 1];
            nextInput.focus();
            nextInput.select();
          }
        }
        commitForm.addEventListener("keydown", function (event) {
          const target = event.target;
          if (!target || event.key !== "Enter") return;
          if (target.matches('button[type="submit"], input[type="submit"]')) return;
          if (target.matches('input[data-qty-input="true"]')) {
            event.preventDefault();
            focusNextQty(target);
            return;
          }
          event.preventDefault();
        });
        qtyInputs.forEach((input) => {
          input.addEventListener("focus", function () {
            input.select();
          });
        });
      }());
    </script>
  `, req.user));
}));

app.post("/inventory-audit/commit", requireAuth, requireInventoryAuditEdit, asyncHandler(async (req, res) => {
  const rowCount = Math.max(0, num(req.body.row_count, 0));
  const desiredRows = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const rawActualQty = String(req.body[`actual_qty_${index}`] || "").trim();
    if (!rawActualQty) continue;
    const key = String(req.body[`key_${index}`] || "").trim();
    if (!key) continue;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
    } catch {
      throw new Error("Invalid inventory audit row.");
    }
    const actualQty = parseQtyValue(rawActualQty);
    if (!Number.isFinite(actualQty) || actualQty < 0) throw new Error("Actual on-hand qty must be zero or greater.");
    const normalizedNames = normalizeWarehouseLocationValues(req.body[`warehouse_${index}`] || decoded.warehouse || "", req.body[`location_${index}`] || decoded.location || "");
    const targetWarehouse = normalizedNames.warehouse;
    const targetLocation = normalizedNames.location;
    if (!targetWarehouse || !targetLocation) throw new Error("Choose a warehouse and location for each counted audit row.");
    const sourceRow = {
      item_code: String(decoded.item_code || ""),
      description: String(decoded.description || ""),
      size_1: String(decoded.size_1 || ""),
      size_2: String(decoded.size_2 || ""),
      thk_1: String(decoded.thk_1 || ""),
      thk_2: String(decoded.thk_2 || ""),
      warehouse: String(decoded.warehouse || ""),
      location: String(decoded.location || "")
    };
    const targetRow = { ...sourceRow, warehouse: targetWarehouse, location: targetLocation };
    if (buildInventoryEntryKey(sourceRow) !== buildInventoryEntryKey(targetRow)) {
      setDesiredInventoryRow(desiredRows, sourceRow, 0);
    }
    setDesiredInventoryRow(desiredRows, targetRow, actualQty);
  }
  if (desiredRows.size === 0) throw new Error("Enter at least one actual on-hand qty before saving the audit.");
  let createdReportNo = "";
  await withTransaction(async (client) => {
    const result = await saveInventoryAuditReport(client, {
      userId: req.user.id || null,
      warehouseFilter: String(req.body.warehouse_filter || ""),
      locationFilter: String(req.body.location_filter || ""),
      identFilter: String(req.body.ident_filter || ""),
      desiredRows: Array.from(desiredRows.values())
    });
    createdReportNo = result.reportNo;
  });
  res.redirect(`/inventory-audit?created_report_no=${encodeURIComponent(createdReportNo)}`);
}));

app.post("/inventory-audit/import", requireAuth, requireInventoryAuditEdit, upload.single("sheet"), asyncHandler(async (req, res) => {
  if (!req.file?.buffer) throw new Error("Choose an inventory workbook to import.");
  const importedRows = importInventoryTrueUpRows(req.file.buffer);
  if (!importedRows.length) throw new Error("No inventory rows were found in the workbook.");
  let createdReportNo = "";
  await withTransaction(async (client) => {
      const currentRows = await getCurrentOnHandRows(client);
      const desiredRows = new Map();
    for (const currentRow of currentRows) {
      setDesiredInventoryRow(desiredRows, {
        item_code: currentRow.item_code,
        description: currentRow.description,
        size_1: currentRow.size_1,
        size_2: currentRow.size_2,
        thk_1: currentRow.thk_1,
        thk_2: currentRow.thk_2,
        warehouse: currentRow.warehouse,
        location: currentRow.location
      }, 0);
    }
    let importedCount = 0;
    for (const row of importedRows) {
      if (!row.item_code || !row.warehouse || !row.location) continue;
      if (!Number.isFinite(row.actual_qty) || row.actual_qty < 0) continue;
      addDesiredInventoryRow(desiredRows, row, row.actual_qty);
      importedCount += 1;
    }
    if (importedCount === 0) throw new Error("The workbook did not contain any usable inventory rows.");
    const ensuredPairs = new Set();
    for (const desiredRow of desiredRows.values()) {
      const warehouse = String(desiredRow.warehouse || "").trim();
      const location = String(desiredRow.location || "").trim();
      if (!warehouse || !location) continue;
      const pairKey = `${warehouse.toLowerCase()}|${location.toLowerCase()}`;
      if (ensuredPairs.has(pairKey)) continue;
      await ensureWarehouseLocationExists(client, warehouse, location);
      ensuredPairs.add(pairKey);
    }
    const result = await saveInventoryAuditReport(client, {
      userId: req.user.id || null,
      identFilter: `FULL RESET IMPORT | ${req.file.originalname || "inventory workbook"}`,
      desiredRows: Array.from(desiredRows.values())
    });
    createdReportNo = result.reportNo;
    await auditLog(client, req.user.id, "import", "inventory_audit_reports", result.reportId, `${req.file.originalname || "inventory workbook"}|rows=${importedCount}`);
  });
  res.redirect(`/inventory-audit?created_report_no=${encodeURIComponent(createdReportNo)}`);
}));

app.get("/inventory-audit/reports/:id", requireAuth, requirePermission("inventory", "view"), asyncHandler(async (req, res) => {
  const report = (await query(`
    select r.*, u.username as created_by_name
    from inventory_audit_reports r
    left join users u on u.id = r.created_by
    where r.id = $1
  `, [req.params.id])).rows[0];
  if (!report) throw new Error("Inventory audit report not found.");
  const lines = (await query(`
    select *
    from inventory_audit_report_lines
    where report_id = $1
    order by id
  `, [req.params.id])).rows;
  const lineRows = lines.map((row) => `<tr>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(row.size_1 || "")}</td>
    <td>${esc(row.size_2 || "")}</td>
    <td>${esc(row.thk_1 || "")}</td>
    <td>${esc(row.thk_2 || "")}</td>
    <td>${esc(row.warehouse || "")}</td>
    <td>${esc(row.location || "")}</td>
    <td>${esc(formatQtyDisplay(row.book_qty))}</td>
    <td>${esc(formatQtyDisplay(row.actual_qty))}</td>
    <td>${esc(formatQtyDisplay(row.adjustment_qty))}</td>
  </tr>`).join("");
  res.send(layout(`Inventory Audit ${report.report_no}`, `
    <h1>${esc(report.report_no)}</h1>
    <div class="card">
      <div class="stats">
        <div class="stat"><div>Created</div><strong>${esc(formatShortDateTime(report.created_at))}</strong></div>
        <div class="stat"><div>Created By</div><strong>${esc(report.created_by_name || "")}</strong></div>
        <div class="stat"><div>Warehouse Filter</div><strong>${esc(report.warehouse_filter || "All")}</strong></div>
        <div class="stat"><div>Location Filter</div><strong>${esc(report.location_filter || "All")}</strong></div>
        <div class="stat"><div>Ident Filter</div><strong>${esc(report.ident_filter || "All")}</strong></div>
      </div>
      <div class="actions" style="margin-top:12px;"><a class="btn btn-secondary" href="/inventory-audit">Back To Inventory Audit</a></div>
    </div>
    <div class="card scroll">
      <table><tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Warehouse</th><th>Location</th><th>Book Qty</th><th>Actual Qty</th><th>Adjustment</th></tr>${lineRows || `<tr><td colspan="11" class="muted">No report lines found.</td></tr>`}</table>
    </div>
  `, req.user));
}));

app.get("/material-logs", requireAuth, requirePermission("material_logs", "view"), async (req, res) => {
  res.send(layout("Material Logs", `
    <h1>Material Logs</h1>
    <div class="card">
      <div class="actions">
        <a class="btn btn-primary" href="/material-logs/mrr">MRR Log</a>
        <a class="btn btn-primary" href="/material-logs/fmr">Vendor FMR Log</a>
        <a class="btn btn-primary" href="/material-logs/opi">OPI Log</a>
        <a class="btn btn-primary" href="/material-logs/issue-report">Issue Report</a>
      </div>
    </div>
  `, req.user));
});

app.get("/material-logs/mrr", requireAuth, requirePermission("material_logs", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = (await query(`
    select m.id, m.discipline, m.mrr_number, m.vendor_name, coalesce(po.po_no, m.po_number) as po_number,
           m.pick_ticket, m.material_description, m.received_date, m.received_by, m.load_number, m.opi_number
    from mrr_logs m
    left join purchase_orders po on po.id = m.app_po_id
    ${q ? "where (coalesce(m.mrr_number, '') ilike $1 or coalesce(m.vendor_name, '') ilike $1 or coalesce(po.po_no, m.po_number, '') ilike $1 or coalesce(m.material_description, '') ilike $1 or coalesce(m.received_by, '') ilike $1)" : ""}
    order by m.id desc
    limit 200
  `, q ? [`%${q}%`] : [])).rows;
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.mrr_number)}</td>
    <td>${esc(row.discipline)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.po_number)}</td>
    <td>${esc(row.pick_ticket)}</td>
    <td>${esc(row.material_description)}</td>
    <td>${esc(formatShortDateTime(row.received_date))}</td>
    <td>${esc(row.received_by)}</td>
    <td>${esc(row.load_number)}</td>
    <td>${esc(row.opi_number)}</td>
    <td><div class="actions"><a class="btn btn-secondary" href="/material-logs/mrr/${row.id}/edit">Edit</a><a class="btn btn-secondary" target="_blank" href="/material-logs/mrr/${row.id}/form.pdf">MRR Form</a></div></td>
  </tr>`).join("");
  res.send(layout("MRR Log", `
    <h1>MRR Log</h1>
    <div class="card">
      <form method="get" action="/material-logs/mrr" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto auto;">
          <div><label>Filter MRR Log</label><input name="q" value="${esc(q)}" placeholder="MRR, vendor, PO, description, received by" /></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
          <div style="align-self:end;"><a class="btn btn-primary" href="/material-logs/mrr/new">Add New MRR</a></div>
        </div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>MRR #</th><th>Disc.</th><th>Vendor</th><th>PO</th><th>Pick Ticket</th><th>Description</th><th>Recv Date</th><th>Recv By</th><th>Load #</th><th>OPI #</th><th>Action</th></tr>${tableRows || `<tr><td colspan="11" class="muted">No MRR rows found.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.get("/material-logs/mrr/new", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await syncMrrVendorsIntoVendorTable(client);
  });
  const [disciplines, vendors, pos, receivers, nextMrrNumber, appPos] = await Promise.all([
    getMaterialLogLookupOptions("discipline"),
    getMaterialLogLookupOptions("vendor_name"),
    getMaterialLogLookupOptions("po_number"),
    getMaterialLogLookupOptions("received_by"),
    getNextMrrNumber(),
    getAppPurchaseOrderOptions()
  ]);
  const optionList = (values, placeholder) => [`<option value="">${esc(placeholder)}</option>`]
    .concat(values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`))
    .join("");
  const appPoOptions = [`<option value="">Select app PO</option>`]
    .concat(appPos.map((po) => `<option value="${po.id}">${esc(po.po_no)}${po.vendor_name ? ` | ${esc(po.vendor_name)}` : ""}${po.description ? ` | ${esc(po.description)}` : ""}</option>`))
    .join("");
  res.send(layout("Add MRR", `
    <h1>Add MRR</h1>
    <div class="card">
      <form method="post" action="/material-logs/mrr/add" class="stack">
        <div class="grid">
          <div><label>MRR Number</label><input name="mrr_number" value="${esc(nextMrrNumber)}" readonly /></div>
          <div><label>Discipline</label><select name="discipline">${optionList(disciplines, "Select discipline")}</select></div>
          <div><label>Vendor</label><div class="inline-field"><select name="vendor_name">${optionList(vendors, "Select vendor")}</select><a class="btn btn-secondary" href="/vendors/new">Add Vendor</a></div></div>
          <div><label>App PO</label><div class="inline-field"><select name="app_po_id">${appPoOptions}</select><a class="btn btn-secondary" href="/po/new">Add PO</a></div></div>
          <div><label>Legacy PO Number</label><select name="po_number">${optionList(pos, "Select legacy PO")}</select></div>
          <div><label>Pick Ticket</label><input name="pick_ticket" /></div>
          <div><label>Received Date</label><input type="date" name="received_date" /></div>
          <div><label>Received By</label><div class="inline-field"><select name="received_by">${optionList(receivers, "Select received by")}</select><a class="btn btn-secondary" href="/material-logs/received-by/new">Add Person</a></div></div>
          <div><label>Load #</label><input name="load_number" /></div>
          <div><label>OPI #</label><input name="opi_number" /></div>
          <div><label>OPI Date</label><input type="date" name="opi_date" /></div>
        </div>
        <div><label>Material Description</label><textarea name="material_description"></textarea></div>
        <div><label>Notes</label><textarea name="notes"></textarea></div>
        <div class="actions"><button type="submit">Add MRR</button><a class="btn btn-secondary" href="/material-logs/mrr">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.get("/material-logs/fmr", requireAuth, requirePermission("material_logs", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const createdCount = Number(req.query.created || 0);
  const createdLineCount = Number(req.query.lines || 0);
  const skippedCount = Number(req.query.skipped || 0);
  const rows = (await query(`
    select id, fmr_number, vendor_name, container_no, fluor_id, fluor_desc, mrr_number, request_date, need_date, pickup_location, pickup_date
    from fmr_logs
    ${q ? "where (coalesce(fmr_number, '') ilike $1 or coalesce(vendor_name, '') ilike $1 or coalesce(container_no, '') ilike $1 or coalesce(fluor_id, '') ilike $1 or coalesce(mrr_number, '') ilike $1)" : ""}
    order by id desc
    limit 200
  `, q ? [`%${q}%`] : [])).rows;
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.fmr_number)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.container_no)}</td>
    <td>${esc(row.fluor_id)}</td>
    <td>${esc(row.fluor_desc)}</td>
    <td>${esc(row.mrr_number)}</td>
    <td>${esc(formatShortDateTime(row.request_date))}</td>
    <td>${esc(formatShortDateTime(row.need_date))}</td>
    <td>${esc(row.pickup_location)}</td>
    <td>${esc(formatShortDateTime(row.pickup_date))}</td>
    <td><a class="btn btn-secondary" href="/material-logs/fmr/${row.id}/edit">Edit</a></td>
    </tr>`).join("");
    res.send(layout("Vendor FMR Log", `
      <h1>Vendor FMR Log</h1>
    ${createdCount > 0 || createdLineCount > 0 || skippedCount > 0 ? `<div class="card"><strong>Vendor FMR Generation:</strong> Created ${createdCount} FMR${createdCount === 1 ? "" : "s"} | ${createdLineCount} Line${createdLineCount === 1 ? "" : "s"} | Skipped ${skippedCount}</div>` : ""}
      <div class="card">
        <form method="get" action="/material-logs/fmr" class="stack">
          <div class="grid" style="grid-template-columns: 1fr auto auto auto;">
            <div><label>Filter Vendor FMR Log</label><input name="q" value="${esc(q)}" placeholder="FMR, vendor, container, fluor ID, MRR" /></div>
            <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
            <div style="align-self:end;"><a class="btn btn-secondary" href="/material-logs/fmr/request-lines">Build Vendor FMRs</a></div>
            <div style="align-self:end;"><a class="btn btn-primary" href="/material-logs/fmr/new">Add Vendor FMR</a></div>
          </div>
        </form>
      </div>
      <div class="card scroll">
          <table><tr><th>FMR #</th><th>Vendor</th><th>Container</th><th>Fluor ID</th><th>Fluor Description</th><th>MRR #</th><th>Request Date</th><th>Need Date</th><th>Pickup Location</th><th>Pickup Date</th><th>Action</th></tr>${tableRows || `<tr><td colspan="11" class="muted">No vendor FMR rows found.</td></tr>`}</table>
      </div>
    `, req.user));
  });

app.get("/material-logs/fmr/request-lines", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  const poNumber = String(req.query.po_number || "").trim();
  const itemCode = String(req.query.item_code || "").trim();
  const abbrevDescription = String(req.query.abbrev_description || "").trim();
  const currentCrateNumber = String(req.query.current_crate_number || "").trim() || itemCode || abbrevDescription;
  const showRequested = String(req.query.show_requested || "").trim() === "1";
  const params = [];
  const where = [];
  if (poNumber) {
    params.push(`%${poNumber}%`);
    where.push(`coalesce(vl.po_number, '') ilike $${params.length}`);
  }
  if (itemCode) {
    params.push(`%${itemCode}%`);
    where.push(`coalesce(vl.item_code, '') ilike $${params.length}`);
  }
  if (abbrevDescription) {
    params.push(`%${abbrevDescription}%`);
    where.push(`coalesce(vl.abbrev_description, '') ilike $${params.length}`);
  }
  if (!showRequested) {
    where.push(`not (
      trim(coalesce(vl.crate_number, '')) <> ''
      and exists (
        select 1
        from fmr_logs f
        where lower(trim(coalesce(f.vendor_name, ''))) = lower(trim(coalesce(vl.vendor_name, '')))
          and lower(trim(coalesce(f.container_no, ''))) = lower(trim(coalesce(vl.crate_number, '')))
      )
    )`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const stagedRows = (await query(`
    select *
    from vendor_fmr_request_lines
    where selected_for_request = true
    order by updated_at desc, id desc
    limit 100
  `)).rows;
  const stagedCount = stagedRows.length;
  const rows = (await query(`
    select
      vl.*,
      exists (
        select 1
        from fmr_logs f
        where trim(coalesce(vl.crate_number, '')) <> ''
          and lower(trim(coalesce(f.vendor_name, ''))) = lower(trim(coalesce(vl.vendor_name, '')))
          and lower(trim(coalesce(f.container_no, ''))) = lower(trim(coalesce(vl.crate_number, '')))
      ) as already_requested
    from vendor_fmr_request_lines vl
    ${whereSql}
    order by coalesce(vl.po_number, ''), coalesce(vl.item_code, ''), coalesce(vl.abbrev_description, ''), vl.id
    limit 300
  `, params)).rows;
  const stagedMarkup = stagedRows.map((row) => `<tr>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.po_number)}</td>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.abbrev_description)}</td>
    <td>${esc(row.crate_number || "")}</td>
    <td>${esc(row.srn_number || "")}</td>
    <td>
      <form method="post" action="/material-logs/fmr/request-lines/staged/${row.id}/delete">
        <input type="hidden" name="po_number" value="${esc(poNumber)}" />
        <input type="hidden" name="item_code" value="${esc(itemCode)}" />
        <input type="hidden" name="abbrev_description" value="${esc(abbrevDescription)}" />
        <input type="hidden" name="show_requested" value="${showRequested ? "1" : "0"}" />
        <input type="hidden" name="current_crate_number" value="${esc(currentCrateNumber)}" />
        <button type="submit" class="btn btn-secondary">Remove</button>
      </form>
    </td>
  </tr>`).join("");
  const rowMarkup = rows.map((row) => `<tr>
    <td>${row.already_requested ? `<span class="chip">Requested</span>` : `<input type="checkbox" class="vendor-fmr-pick" data-row-id="${row.id}" name="selected_ids" value="${row.id}" ${row.selected_for_request ? "checked" : ""} />`}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.po_number)}</td>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.abbrev_description)}</td>
    <td><input class="vendor-fmr-crate-input" data-row-id="${row.id}" name="crate_number_${row.id}" value="${esc(row.crate_number || "")}" placeholder="Enter crate #" /></td>
    <td><input name="srn_number_${row.id}" value="${esc(row.srn_number || "")}" placeholder="Optional SRN" /></td>
    <td>${esc(row.po_line || "")}</td>
    <td>${esc(row.sub_line || "")}</td>
    <td>${esc(formatQtyDisplay(row.qty_received))}</td>
    <td>${esc(row.mrr_number || "")}</td>
    <td>${esc(formatShortDateTime(row.received_date || ""))}</td>
  </tr>`).join("");
  res.send(layout("Build Vendor FMRs", `
    <h1>Build Vendor FMRs</h1>
    <div class="card">
      <form method="post" enctype="multipart/form-data" action="/material-logs/fmr/request-lines/import" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto auto;">
          <div><label>PO Receiving Status Report</label><input type="file" name="sheet" accept=".xlsx,.xls,.xlsb" required /></div>
          <div style="align-self:end;"><button type="submit">Import PO Status Report</button></div>
          <div style="align-self:end;"><a class="btn btn-secondary" href="/material-logs/fmr">Back To Vendor FMR Log</a></div>
        </div>
        <div class="muted">Imports columns from the vendor PO receiving status report and only adds new line items based on PO + Item Code + Abbrev Description.</div>
      </form>
    </div>
    <div class="card">
      <form method="get" action="/material-logs/fmr/request-lines" class="stack">
        <div class="grid" style="grid-template-columns: 1fr 1fr 1fr 1fr auto auto;">
          <div><label>PO</label><input name="po_number" value="${esc(poNumber)}" /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(itemCode)}" /></div>
          <div><label>Abbrev Description</label><input name="abbrev_description" value="${esc(abbrevDescription)}" /></div>
          <div><label>Current Crate #</label><input id="current_crate_number_display" name="current_crate_number" value="${esc(currentCrateNumber)}" placeholder="Use this crate # for checked rows" /></div>
          <div><label>Show Requested</label><select name="show_requested"><option value="0" ${showRequested ? "" : "selected"}>No</option><option value="1" ${showRequested ? "selected" : ""}>Yes</option></select></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="muted">Work one crate at a time here. Type the current crate number once, check the matching lines, and the app will fill that crate number into each checked row. Save as many staged crates as you need, then click Generate Vendor FMRs once to create all staged requests.</div>
      <div class="muted" style="margin-top:8px;">Staged lines ready to generate: <strong>${stagedCount}</strong></div>
    </div>
    <div class="card scroll">
      <h2 style="margin-top:0;">Currently Staged</h2>
      <table><tr><th>Vendor</th><th>PO</th><th>Item Code</th><th>Abbrev Description</th><th>Crate #</th><th>SRN</th><th>Action</th></tr>${stagedMarkup || `<tr><td colspan="7" class="muted">No lines are staged yet.</td></tr>`}</table>
    </div>
    <form method="post" action="/material-logs/fmr/request-lines/bulk" class="stack">
      <input type="hidden" name="po_number" value="${esc(poNumber)}" />
      <input type="hidden" name="item_code" value="${esc(itemCode)}" />
      <input type="hidden" name="abbrev_description" value="${esc(abbrevDescription)}" />
      <input type="hidden" name="show_requested" value="${showRequested ? "1" : "0"}" />
      <input id="current_crate_number" type="hidden" name="current_crate_number" value="${esc(currentCrateNumber)}" />
      <div class="actions">
        <button type="submit" name="action" value="save">Save Crate / SRN</button>
        <button type="submit" name="action" value="generate">Generate Vendor FMRs</button>
      </div>
      <div class="card scroll">
        <table><tr><th>Pick</th><th>Vendor</th><th>PO</th><th>Item Code</th><th>Abbrev Description</th><th>Crate #</th><th>SRN</th><th>Line</th><th>Sub</th><th>Rcvd</th><th>MRR #</th><th>Date Rcvd</th></tr>${rowMarkup || `<tr><td colspan="12" class="muted">No request lines found.</td></tr>`}</table>
      </div>
    </form>
    <script>
      (() => {
        const crateSource = document.getElementById("current_crate_number_display");
        const crateHidden = document.getElementById("current_crate_number");
        if (!crateSource || !crateHidden) return;
        const applyCrateToCheckedRows = () => {
          const crateValue = crateSource.value.trim();
          crateHidden.value = crateValue;
          if (!crateValue) return;
          document.querySelectorAll(".vendor-fmr-pick:checked").forEach((checkbox) => {
            const crateInput = document.querySelector('.vendor-fmr-crate-input[data-row-id="' + checkbox.dataset.rowId + '"]');
            if (crateInput) crateInput.value = crateValue;
          });
        };
        document.querySelectorAll(".vendor-fmr-pick").forEach((checkbox) => {
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) applyCrateToCheckedRows();
          });
        });
        crateSource.addEventListener("input", applyCrateToCheckedRows);
        applyCrateToCheckedRows();
      })();
    </script>
  `, req.user));
}));

app.post("/material-logs/fmr/request-lines/import", requireAuth, requirePermission("material_logs", "edit"), upload.single("sheet"), asyncHandler(async (req, res) => {
  if (!req.file?.buffer?.length) throw new Error("Choose a PO receiving status report file to import.");
  const rows = parseVendorFmrRequestWorkbook(req.file.buffer);
  if (rows.length === 0) throw new Error("No matching line items were found in that report.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "vendor_fmr_request_lines",
      rfqId: null,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const existing = (await client.query(`
        select id
        from vendor_fmr_request_lines
        where po_number = $1 and item_code = $2 and abbrev_description = $3
      `, [row.po_number, row.item_code, row.abbrev_description])).rows[0];
      if (existing) {
        await client.query(`
          update vendor_fmr_request_lines
          set vendor_name = $2,
              po_line = $3,
              sub_line = $4,
              qty_ordered = $5,
              qty_received = $6,
              mrr_number = $7,
              issued_date = $8,
              received_date = $9,
              source_filename = $10,
              updated_at = now()
          where id = $1
        `, [existing.id, row.vendor_name, row.po_line, row.sub_line, parseQtyValue(row.qty_ordered), parseQtyValue(row.qty_received), row.mrr_number, row.issued_date, row.received_date, req.file?.originalname || ""]);
        updatedCount += 1;
      } else {
        await client.query(`
          insert into vendor_fmr_request_lines (
            vendor_name, po_number, item_code, abbrev_description, po_line, sub_line,
            qty_ordered, qty_received, mrr_number, issued_date, received_date, srn_number, crate_number, source_filename, updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
        `, [row.vendor_name, row.po_number, row.item_code, row.abbrev_description, row.po_line, row.sub_line, parseQtyValue(row.qty_ordered), parseQtyValue(row.qty_received), row.mrr_number, row.issued_date, row.received_date, row.srn_number || "", row.crate_number || "", req.file?.originalname || ""]);
        insertedCount += 1;
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "vendor_fmr_request_lines", batchId, `rows=${rows.length}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
}));

app.post("/material-logs/fmr/request-lines/staged/:id/delete", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) throw new Error("Invalid staged request line.");
  await withTransaction(async (client) => {
    await client.query(`
      update vendor_fmr_request_lines
      set selected_for_request = false,
          updated_at = now()
      where id = $1
    `, [id]);
    await auditLog(client, req.user.id, "update", "vendor_fmr_request_lines", id, "unstaged");
  });
  res.redirect(`/material-logs/fmr/request-lines?${getVendorFmrRequestBuilderQuery(req.body)}`);
}));

app.post("/material-logs/fmr/request-lines/bulk", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  const action = String(req.body.action || "save").trim();
  const currentCrateNumber = String(req.body.current_crate_number || "").trim();
  const fieldIds = Object.keys(req.body)
    .map((key) => {
      const match = key.match(/^(crate_number|srn_number)_(\d+)$/);
      return match ? Number(match[2]) : null;
    })
    .filter((value, index, array) => Number.isFinite(value) && array.indexOf(value) === index);
  const selectedIds = Array.isArray(req.body.selected_ids)
    ? req.body.selected_ids.map((value) => Number(value)).filter(Number.isFinite)
    : req.body.selected_ids
      ? [Number(req.body.selected_ids)].filter(Number.isFinite)
      : [];
  const redirectQuery = getVendorFmrRequestBuilderQuery({
    po_number: String(req.body.po_number || ""),
    item_code: String(req.body.item_code || ""),
    abbrev_description: String(req.body.abbrev_description || ""),
    show_requested: String(req.body.show_requested || "0"),
    current_crate_number: currentCrateNumber
  });
  await withTransaction(async (client) => {
    const selectedIdSet = new Set(selectedIds);
    for (const id of fieldIds) {
      const savedCrateNumber = String(req.body[`crate_number_${id}`] || "").trim() || (selectedIdSet.has(id) ? currentCrateNumber : "");
      await client.query(`
        update vendor_fmr_request_lines
        set crate_number = $2,
            srn_number = $3,
            selected_for_request = $4,
            updated_at = now()
        where id = $1
      `, [id, savedCrateNumber, String(req.body[`srn_number_${id}`] || "").trim(), selectedIdSet.has(id)]);
    }
    if (action !== "generate") {
      await auditLog(client, req.user.id, "update", "vendor_fmr_request_lines", fieldIds.join(","), `count=${fieldIds.length}`);
      return;
    }
    const preview = await buildVendorFmrPreviewData(client);
    if (preview.stagedRows.length === 0) throw new Error("Save at least one staged line before generating Vendor FMRs.");
  });
  if (action === "generate") {
    res.redirect(`/material-logs/fmr/request-lines/preview?${redirectQuery}`);
    return;
  }
  res.redirect(`/material-logs/fmr/request-lines?${redirectQuery}`);
}));

app.get("/material-logs/fmr/request-lines/preview", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  const queryString = getVendorFmrRequestBuilderQuery(req.query);
  const preview = await withTransaction(async (client) => buildVendorFmrPreviewData(client));
  if (preview.stagedRows.length === 0) {
    res.redirect(`/material-logs/fmr/request-lines?${queryString}`);
    return;
  }
  const previewMarkup = preview.previewRows.map((row) => `<tr>
    <td>${esc(row.vendorName)}</td>
    <td>${esc(row.crateNumber)}</td>
    <td>${esc(row.srnNumber || "")}</td>
    <td>${esc(row.poNumber)}</td>
    <td>${esc(row.itemCode)}</td>
    <td>${esc(row.abbrevDescription)}</td>
    <td>${esc(row.stagedLineCount)}</td>
    <td>
      <form method="post" action="/material-logs/fmr/request-lines/preview/remove">
        <input type="hidden" name="vendor_name" value="${esc(row.vendorName)}" />
        <input type="hidden" name="crate_number" value="${esc(row.crateNumber)}" />
        <input type="hidden" name="srn_number" value="${esc(row.srnNumber || "")}" />
        <input type="hidden" name="po_number" value="${esc(String(req.query.po_number || ""))}" />
        <input type="hidden" name="item_code" value="${esc(String(req.query.item_code || ""))}" />
        <input type="hidden" name="abbrev_description" value="${esc(String(req.query.abbrev_description || ""))}" />
        <input type="hidden" name="show_requested" value="${esc(String(req.query.show_requested || "0"))}" />
        <input type="hidden" name="current_crate_number" value="${esc(String(req.query.current_crate_number || ""))}" />
        <button type="submit" class="btn btn-secondary">Remove</button>
      </form>
    </td>
  </tr>`).join("");
  const skippedMarkup = preview.skippedRows.map((row) => `<tr>
    <td>${esc(row.vendorName)}</td>
    <td>${esc(row.crateNumber)}</td>
    <td>${esc(row.srnNumber || "")}</td>
    <td>${esc(row.poNumber)}</td>
    <td>${esc(row.itemCode)}</td>
    <td>${esc(row.abbrevDescription)}</td>
    <td>Already on Vendor FMR Log</td>
  </tr>`).join("");
  const invalidMarkup = preview.invalidRows.map((row) => `<tr>
    <td>${esc(row.vendorName)}</td>
    <td>${esc(row.poNumber)}</td>
    <td>${esc(row.itemCode)}</td>
    <td>${esc(row.abbrevDescription)}</td>
    <td>${esc(row.srnNumber || "")}</td>
    <td>Missing crate #</td>
  </tr>`).join("");
  res.send(layout("Review Vendor FMRs", `
    <h1>Review Vendor FMRs</h1>
    <div class="card">
      <div class="muted">This is the final review before new Vendor FMRs are created. Each row below represents one crate that will become one Vendor FMR line.</div>
    </div>
    ${preview.invalidRows.length ? `<div class="card scroll"><h2 style="margin-top:0;">Needs Attention</h2><table><tr><th>Vendor</th><th>PO</th><th>Item Code</th><th>Abbrev Description</th><th>SRN</th><th>Issue</th></tr>${invalidMarkup}</table></div>` : ""}
    ${preview.skippedRows.length ? `<div class="card scroll"><h2 style="margin-top:0;">Already Requested</h2><table><tr><th>Vendor</th><th>Crate #</th><th>SRN</th><th>PO</th><th>Item Code</th><th>Abbrev Description</th><th>Status</th></tr>${skippedMarkup}</table></div>` : ""}
    <div class="card scroll">
      <h2 style="margin-top:0;">Will Be Added</h2>
      <table><tr><th>Vendor</th><th>Crate #</th><th>SRN</th><th>PO</th><th>Item Code</th><th>Abbrev Description</th><th>Staged Lines</th><th>Action</th></tr>${previewMarkup || `<tr><td colspan="8" class="muted">No new Vendor FMRs are queued right now.</td></tr>`}</table>
    </div>
    <div class="actions">
      <a class="btn btn-secondary" href="/material-logs/fmr/request-lines?${queryString}">Back And Add More</a>
      ${preview.invalidRows.length || preview.previewRows.length === 0 ? "" : `<form method="post" action="/material-logs/fmr/request-lines/preview/create" style="display:inline-block;">
        <input type="hidden" name="po_number" value="${esc(String(req.query.po_number || ""))}" />
        <input type="hidden" name="item_code" value="${esc(String(req.query.item_code || ""))}" />
        <input type="hidden" name="abbrev_description" value="${esc(String(req.query.abbrev_description || ""))}" />
        <input type="hidden" name="show_requested" value="${esc(String(req.query.show_requested || "0"))}" />
        <input type="hidden" name="current_crate_number" value="${esc(String(req.query.current_crate_number || ""))}" />
        <button type="submit">Confirm And Create Vendor FMRs</button>
      </form>`}
    </div>
  `, req.user));
}));

app.post("/material-logs/fmr/request-lines/preview/remove", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  const vendorName = String(req.body.vendor_name || "").trim();
  const crateNumber = String(req.body.crate_number || "").trim();
  const srnNumber = String(req.body.srn_number || "").trim();
  if (!vendorName || !crateNumber) throw new Error("Invalid staged crate.");
  await withTransaction(async (client) => {
    await client.query(`
      update vendor_fmr_request_lines
      set selected_for_request = false,
          updated_at = now()
      where selected_for_request = true
        and lower(trim(coalesce(vendor_name, ''))) = lower(trim($1))
        and lower(trim(coalesce(crate_number, ''))) = lower(trim($2))
        and lower(trim(coalesce(srn_number, ''))) = lower(trim($3))
    `, [vendorName, crateNumber, srnNumber]);
    await auditLog(client, req.user.id, "update", "vendor_fmr_request_lines", crateNumber, `preview-remove ${vendorName}`);
  });
  res.redirect(`/material-logs/fmr/request-lines/preview?${getVendorFmrRequestBuilderQuery(req.body)}`);
}));

app.post("/material-logs/fmr/request-lines/preview/create", requireAuth, requirePermission("material_logs", "edit"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const preview = await buildVendorFmrPreviewData(client);
    if (preview.stagedRows.length === 0) throw new Error("There are no staged lines ready to create.");
    if (preview.invalidRows.length > 0) throw new Error("Fix the staged lines that are missing crate numbers before creating Vendor FMRs.");
    if (preview.previewGroups.length === 0) throw new Error("All staged crates have already been requested.");
    let createdCount = 0;
    let createdLineCount = 0;
    for (const group of preview.previewGroups) {
      const fmrNumber = await getNextFmrNumber(client);
      createdCount += 1;
      for (const { row, crateNumber, srnNumber } of group.crates) {
        await ensureUniqueFmrContainer(client, row.vendor_name, crateNumber);
        const requestDescription = [
          row.po_number ? `PO ${row.po_number}` : "",
          row.item_code || "",
          row.abbrev_description || "",
          srnNumber ? `SRN ${srnNumber}` : ""
        ].filter(Boolean).join(" | ");
        const insert = await client.query(`
          insert into fmr_logs (
            fmr_number, vendor_name, container_no, fluor_id, fluor_desc, request_description, request_date, updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7, now())
          returning id
        `, [
          fmrNumber,
          row.vendor_name || "",
          crateNumber,
          row.item_code || "",
          row.abbrev_description || "",
          requestDescription,
          new Date().toISOString().slice(0, 10)
        ]);
        await ensureMrrForVendorCrate(client, {
          userId: req.user.id,
          fmrId: insert.rows[0].id,
          vendorName: row.vendor_name || "",
          containerNo: crateNumber,
          poNumber: row.po_number || ""
        });
        await auditLog(client, req.user.id, "create", "fmr_log", insert.rows[0].id, fmrNumber);
        createdLineCount += 1;
      }
    }
    await client.query(`
      update vendor_fmr_request_lines
      set selected_for_request = false,
          updated_at = now()
      where selected_for_request = true
    `);
    req._vendorFmrGenerateResult = {
      createdCount,
      createdLineCount,
      skippedRequestedCount: preview.skippedRows.length
    };
  });
  const createdCount = Number(req._vendorFmrGenerateResult?.createdCount || 0);
  const createdLineCount = Number(req._vendorFmrGenerateResult?.createdLineCount || 0);
  const skippedRequestedCount = Number(req._vendorFmrGenerateResult?.skippedRequestedCount || 0);
  res.redirect(`/material-logs/fmr?created=${createdCount}&lines=${createdLineCount}&skipped=${skippedRequestedCount}`);
}));

app.get("/material-logs/opi", requireAuth, requirePermission("material_logs", "view"), async (req, res) => {
  await withTransaction(async (client) => {
    await syncOpiLogsFromMrr(client);
  });
  const q = String(req.query.q || "").trim();
  const rows = (await query(`
    select id, opi_number, vendor_name, material_description, load_number, mrr_number
    from opi_logs
    ${q ? "where (coalesce(opi_number, '') ilike $1 or coalesce(vendor_name, '') ilike $1 or coalesce(material_description, '') ilike $1 or coalesce(load_number, '') ilike $1 or coalesce(mrr_number, '') ilike $1)" : ""}
    order by id desc
    limit 300
  `, q ? [`%${q}%`] : [])).rows;
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.opi_number)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.material_description)}</td>
    <td>${esc(row.load_number)}</td>
    <td>${esc(row.mrr_number)}</td>
  </tr>`).join("");
  res.send(layout("OPI Log", `
    <h1>OPI Log</h1>
    <div class="card">
      <form method="get" action="/material-logs/opi" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto;">
          <div><label>Filter OPI Log</label><input name="q" value="${esc(q)}" placeholder="OPI, vendor, description, load, MRR" /></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
        </div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>OPI #</th><th>Vendor</th><th>Description</th><th>Load #</th><th>MRR #</th></tr>${tableRows || `<tr><td colspan="5" class="muted">No OPI rows found.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.get("/material-logs/fmr/new", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  const [nextFmrNumber, vendors] = await Promise.all([
    getNextFmrNumber(),
    query("select name from vendors where is_active = true order by name")
  ]);
  const vendorOptions = [`<option value="">Select vendor</option>`]
    .concat(vendors.rows.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`))
    .join("");
  res.send(layout("Add Vendor FMR", `
    <h1>Add Vendor FMR</h1>
      <div class="card">
        <form method="post" action="/material-logs/fmr/add" class="stack">
          <div class="grid">
            <div><label>FMR Number</label><input name="fmr_number" value="${esc(nextFmrNumber)}" readonly /></div>
            <div><label>Vendor</label><div class="inline-field"><select name="vendor_name" required>${vendorOptions}</select><a class="btn btn-secondary" href="/vendors/new">Add Vendor</a></div></div>
            <div><label>Container #</label><input name="container_no" required /></div>
            <div><label>Fluor ID</label><input name="fluor_id" /></div>
            <div><label>MRR #</label><input name="mrr_number" /></div>
          <div><label>Request Date</label><input name="request_date" /></div>
          <div><label>Need Date</label><input name="need_date" /></div>
          <div><label>Pick Ticket #</label><input name="pick_ticket" /></div>
          <div><label>Pickup Location</label><input name="pickup_location" /></div>
          <div><label>Pickup Date</label><input name="pickup_date" /></div>
        </div>
        <div><label>Fluor Description</label><textarea name="fluor_desc"></textarea></div>
        <div><label>Request Description</label><textarea name="request_description"></textarea></div>
        <div class="actions"><button type="submit">Add Vendor FMR</button><a class="btn btn-secondary" href="/material-logs/fmr">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.get("/material-logs/received-by/new", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  const values = await getMaterialLogLookupOptions("received_by");
  const rows = values.map((value) => `<tr><td>${esc(value)}</td></tr>`).join("");
  res.send(layout("Add Received By", `
    <h1>Add Received By</h1>
    <div class="card">
      <form method="post" action="/material-logs/received-by/add" class="stack">
        <div><label>Name</label><input name="value" required /></div>
        <div class="actions"><button type="submit">Add Person</button><a class="btn btn-secondary" href="/material-logs/mrr/new">Back to Add MRR</a></div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>Existing Names</th></tr>${rows || `<tr><td class="muted">No names saved yet.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.post("/material-logs/received-by/add", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await saveMaterialLogLookup(client, "received_by", req.body.value);
    await auditLog(client, req.user.id, "create", "material_log_lookup", "received_by", String(req.body.value || "").trim());
  });
  res.redirect("/material-logs/mrr/new");
});

app.get("/material-logs/issue-report", requireAuth, requirePermission("material_logs", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const params = q ? [`%${q}%`] : [];
  const rows = (await query(`
    select id, legacy_row_id, discipline, vendor_name, po_number, item_code, description, received_qty, qty_unit, mrr_number, fmr_number, warehouse, location, recv_date
    from material_receiving_logs
    ${q ? "where (coalesce(discipline, '') ilike $1 or coalesce(vendor_name, '') ilike $1 or coalesce(po_number, '') ilike $1 or coalesce(item_code, '') ilike $1 or coalesce(description, '') ilike $1 or coalesce(mrr_number, '') ilike $1 or coalesce(fmr_number, '') ilike $1)" : ""}
    order by coalesce(legacy_row_id, id) desc
    limit 200
  `, params)).rows;
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.legacy_row_id || row.id)}</td>
    <td>${esc(row.discipline)}</td>
    <td>${esc(row.vendor_name)}</td>
    <td>${esc(row.po_number)}</td>
    <td>${esc(row.item_code)}</td>
    <td>${esc(row.description)}</td>
    <td>${esc(formatQtyDisplay(row.received_qty))}</td>
    <td>${esc(row.qty_unit)}</td>
    <td>${esc(row.mrr_number)}</td>
    <td>${esc(row.fmr_number)}</td>
    <td>${esc(row.warehouse)}</td>
    <td>${esc(row.location)}</td>
    <td>${esc(formatShortDateTime(row.recv_date))}</td>
    <td><a class="btn btn-secondary" href="/material-logs/receiving/${row.id}/edit">Edit</a></td>
  </tr>`).join("");
  res.send(layout("Issue Report", `
    <h1>Issue Report</h1>
    <div class="card">
      <form method="get" action="/material-logs/issue-report" class="stack">
        <div class="grid" style="grid-template-columns: 1fr auto;">
          <div><label>Filter Issue Report</label><input name="q" value="${esc(q)}" placeholder="PO, item, vendor, MRR, FMR, description" /></div>
          <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
        </div>
      </form>
    </div>
    <div class="card scroll">
      <table><tr><th>ID</th><th>Disc.</th><th>Vendor</th><th>PO</th><th>Item</th><th>Description</th><th>Recv Qty</th><th>UOM</th><th>MRR</th><th>FMR</th><th>Warehouse</th><th>Location</th><th>Recv Date</th><th>Action</th></tr>${tableRows || `<tr><td colspan="14" class="muted">No issue report rows found.</td></tr>`}</table>
    </div>
  `, req.user));
});

app.post("/material-logs/import", requireAuth, requirePermission("material_logs", "edit"), upload.single("sheet"), async (req, res) => {
  if (!req.file?.buffer?.length) throw new Error("Upload a workbook file first.");
  const logType = String(req.body.log_type || "").trim();
  const rows = importRowsFromWorkbook(req.file.buffer, logType);
  if (rows.length === 0) throw new Error("No rows were found in that workbook.");

  await withTransaction(async (client) => {
    if (logType === "receiving") {
      for (const row of rows) {
        const legacyId = numberValue(row.id);
        await client.query(`
          insert into material_receiving_logs (
            legacy_row_id, discipline, vendor_name, po_number, po_position, purchased_by, delivery_to, eta_to_site, company, slid,
            fluor_item_code, item_code, ident_code, commodity_code, description, size_1, size_2, thk_1, thk_2, bom_qty, ship_qty,
            received_qty, qty_unit, fmr_number, mrr_number, picking_ticket, opi, osd_number, load_no, container_no, load_date, mir_no,
            mir_date, cwa, area, drawing, sheet_no, iso, pipe_class, item_type, short_code, received_by, warehouse, location, recv_date,
            received_status, comments, iwp, package_number, scope, on_off_skid, updated_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
            $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
            $33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,
            $46,$47,$48,$49,$50,$51, now()
          )
          on conflict (legacy_row_id) do update set
            discipline = excluded.discipline,
            vendor_name = excluded.vendor_name,
            po_number = excluded.po_number,
            po_position = excluded.po_position,
            purchased_by = excluded.purchased_by,
            delivery_to = excluded.delivery_to,
            eta_to_site = excluded.eta_to_site,
            company = excluded.company,
            slid = excluded.slid,
            fluor_item_code = excluded.fluor_item_code,
            item_code = excluded.item_code,
            ident_code = excluded.ident_code,
            commodity_code = excluded.commodity_code,
            description = excluded.description,
            size_1 = excluded.size_1,
            size_2 = excluded.size_2,
            thk_1 = excluded.thk_1,
            thk_2 = excluded.thk_2,
            bom_qty = excluded.bom_qty,
            ship_qty = excluded.ship_qty,
            received_qty = excluded.received_qty,
            qty_unit = excluded.qty_unit,
            fmr_number = excluded.fmr_number,
            mrr_number = excluded.mrr_number,
            picking_ticket = excluded.picking_ticket,
            opi = excluded.opi,
            osd_number = excluded.osd_number,
            load_no = excluded.load_no,
            container_no = excluded.container_no,
            load_date = excluded.load_date,
            mir_no = excluded.mir_no,
            mir_date = excluded.mir_date,
            cwa = excluded.cwa,
            area = excluded.area,
            drawing = excluded.drawing,
            sheet_no = excluded.sheet_no,
            iso = excluded.iso,
            pipe_class = excluded.pipe_class,
            item_type = excluded.item_type,
            short_code = excluded.short_code,
            received_by = excluded.received_by,
            warehouse = excluded.warehouse,
            location = excluded.location,
            recv_date = excluded.recv_date,
            received_status = excluded.received_status,
            comments = excluded.comments,
            iwp = excluded.iwp,
            package_number = excluded.package_number,
            scope = excluded.scope,
            on_off_skid = excluded.on_off_skid,
            updated_at = now()
        `, [
          legacyId || null,
          textValue(row.discipline),
          textValue(row.vendor),
          textValue(row.po),
          textValue(row.po_position),
          textValue(row.purchased_by),
          textValue(row.delivery_to),
          textValue(row.eta_to_site),
          textValue(row.company),
          textValue(row.slid),
          textValue(row.fluor_item_code),
          textValue(row.item_code),
          textValue(row.ident_code),
          textValue(row.commodity_code),
          textValue(row.description),
          textValue(row.size_1),
          textValue(row.size_2),
          textValue(row.thk_1),
          textValue(row.thk_2),
          parseQtyValue(row.bom_qty),
          parseQtyValue(row.ship_qty),
          parseQtyValue(row.received_qty),
          textValue(row.qty_unit),
          textValue(row.fmr_number),
          textValue(row.mrr_number),
          textValue(row.picking_ticket),
          textValue(row.opi),
          textValue(row.osd_number),
          textValue(row.load_no),
          textValue(row.container_no),
          textValue(row.load_date),
          textValue(row.mir_no),
          textValue(row.mir_date),
          textValue(row.cwa),
          textValue(row.area),
          textValue(row.drawing),
          textValue(row.sheet),
          textValue(row.iso),
          textValue(row.pipe_class),
          textValue(row.item_type),
          textValue(row.short_code),
          textValue(row.received_by),
          normalizeWarehouseName(row.warehouse),
          normalizeLocationName(row.location),
          textValue(row.recv_date),
          textValue(row.received_status),
          textValue(row.comments),
          textValue(row.iwp),
          textValue(row.package_number),
          textValue(row.scope),
          textValue(row.on_off_skid)
        ]);
      }
    } else if (logType === "mrr") {
      for (const row of rows) {
        const mrrNumber = textValue(row.mrr_number);
        if (!mrrNumber) continue;
        await client.query(`
          insert into mrr_logs (
            discipline, mrr_number, vendor_name, po_number, pick_ticket, material_description, received_date, received_by,
            mrr_lookup, client_mrr, mrr_link_label, mtrs_required, osd_required, notes, blank_mrr_link_label, mrr_entered,
            pictures_loaded, sent_to_matheson, load_number, opi_number, opi_date, updated_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,
            $9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,$20,$21, now()
          )
          on conflict (mrr_number) do update set
            discipline = excluded.discipline,
            vendor_name = excluded.vendor_name,
            po_number = excluded.po_number,
            pick_ticket = excluded.pick_ticket,
            material_description = excluded.material_description,
            received_date = excluded.received_date,
            received_by = excluded.received_by,
            mrr_lookup = excluded.mrr_lookup,
            client_mrr = excluded.client_mrr,
            mrr_link_label = excluded.mrr_link_label,
            mtrs_required = excluded.mtrs_required,
            osd_required = excluded.osd_required,
            notes = excluded.notes,
            blank_mrr_link_label = excluded.blank_mrr_link_label,
            mrr_entered = excluded.mrr_entered,
            pictures_loaded = excluded.pictures_loaded,
            sent_to_matheson = excluded.sent_to_matheson,
            load_number = excluded.load_number,
            opi_number = excluded.opi_number,
            opi_date = excluded.opi_date,
            updated_at = now()
        `, [
          textValue(row.discipline),
          mrrNumber,
          textValue(row.vendor),
          textValue(row.po),
          textValue(row.pick_ticket),
          textValue(row.material_description),
          textValue(row.received_date),
          textValue(row.received_by),
          textValue(row.mrr_lookup),
          textValue(row.client_mrr),
          textValue(row.mrr_link),
          textValue(row.mtrs),
          textValue(row.os_d),
          textValue(row.notes),
          textValue(row.blank_mrr_link),
          textValue(row.mrr_entered),
          textValue(row.pictures_loaded),
          textValue(row.sent_to_matheson),
          textValue(row.load),
          textValue(row.opi),
          textValue(row.opi_date)
        ]);
      }
      await syncMrrVendorsIntoVendorTable(client);
      await syncOpiLogsFromMrr(client);
    } else if (logType === "fmr") {
      for (const row of rows) {
        const fmrNumber = textValue(row.fmr);
        const containerNo = textValue(row.container_no);
        const fluorId = textValue(row.fluor_id);
        if (!fmrNumber && !containerNo && !fluorId) continue;
        await client.query(`
          insert into fmr_logs (
            fmr_number, vendor_name, container_no, fmr_lookup, request_description, fluor_id, fluor_desc, mrr_number,
            mr_fmr, mr_opi, requestor, request_date, need_date, pick_ticket, ready_to_pickup, pickup_location, pickup_date, updated_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,
            $9,$10,$11,$12,$13,$14,$15,$16,$17, now()
          )
          on conflict (fmr_number, container_no, fluor_id) do update set
            vendor_name = excluded.vendor_name,
            fmr_lookup = excluded.fmr_lookup,
            request_description = excluded.request_description,
            fluor_desc = excluded.fluor_desc,
            mrr_number = excluded.mrr_number,
            mr_fmr = excluded.mr_fmr,
            mr_opi = excluded.mr_opi,
            requestor = excluded.requestor,
            request_date = excluded.request_date,
            need_date = excluded.need_date,
            pick_ticket = excluded.pick_ticket,
            ready_to_pickup = excluded.ready_to_pickup,
            pickup_location = excluded.pickup_location,
            pickup_date = excluded.pickup_date,
            updated_at = now()
        `, [
          fmrNumber,
          textValue(row.vendor),
          containerNo,
          textValue(row.fmr_lookup),
          textValue(row.request_description),
          fluorId,
          textValue(row.fluor_desc),
          textValue(row.mrr),
          textValue(row.mr_fmr),
          textValue(row.mr_opi),
          textValue(row.requestor),
          textValue(row.request_date),
          textValue(row.need_date),
          textValue(row.pick_ticket),
          textValue(row.ready_to_pickup),
          textValue(row.pickup_location),
          textValue(row.pickup_date)
        ]);
      }
    } else {
      throw new Error("Choose a valid log type.");
    }
    if (logType === "mrr") {
      for (const row of rows) {
        await saveMaterialLogLookup(client, "discipline", textValue(row.discipline));
        await saveMaterialLogLookup(client, "vendor_name", textValue(row.vendor));
        await saveMaterialLogLookup(client, "po_number", textValue(row.po));
        await saveMaterialLogLookup(client, "received_by", textValue(row.received_by));
      }
    }
    await auditLog(client, req.user.id, "import", "material_logs", logType, `rows=${rows.length}`);
  });

  res.redirect("/settings/material-log-imports");
});

app.post("/material-logs/receiving/add", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await assertValidWarehouseLocation(client, req.body.warehouse, req.body.location);
    const result = await client.query(`
      insert into material_receiving_logs (
        legacy_row_id, discipline, vendor_name, po_number, item_code, description, received_qty, qty_unit, mrr_number, fmr_number, warehouse, location, recv_date, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
      returning id
    `, [
      req.body.legacy_row_id ? Number(req.body.legacy_row_id) : null,
      req.body.discipline?.trim() || "",
      req.body.vendor_name?.trim() || "",
      req.body.po_number?.trim() || "",
      req.body.item_code?.trim() || "",
      req.body.description?.trim() || "",
      parseQtyValue(req.body.received_qty || 0),
      req.body.qty_unit?.trim() || "",
      req.body.mrr_number?.trim() || "",
      req.body.fmr_number?.trim() || "",
      normalizeWarehouseName(req.body.warehouse),
      normalizeLocationName(req.body.location),
      req.body.recv_date?.trim() || ""
    ]);
    await auditLog(client, req.user.id, "create", "material_receiving_log", result.rows[0].id, req.body.item_code?.trim() || "");
  });
  res.redirect("/material-logs");
});

app.post("/material-logs/mrr/add", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const mrrNumber = await getNextMrrNumber();
    const appPoId = req.body.app_po_id ? Number(req.body.app_po_id) : null;
    const linkedPo = appPoId
      ? (await client.query("select id, po_no from purchase_orders where id = $1", [appPoId])).rows[0]
      : null;
    const effectivePoNumber = linkedPo?.po_no || req.body.po_number?.trim() || "";
    const result = await client.query(`
      insert into mrr_logs (
        discipline, mrr_number, vendor_name, app_po_id, po_number, pick_ticket, material_description, received_date, received_by, notes, load_number, opi_number, opi_date, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
      returning id
    `, [
      req.body.discipline?.trim() || "",
      mrrNumber,
      req.body.vendor_name?.trim() || "",
      linkedPo?.id || null,
      effectivePoNumber,
      req.body.pick_ticket?.trim() || "",
      req.body.material_description?.trim() || "",
      req.body.received_date?.trim() || "",
      req.body.received_by?.trim() || "",
      req.body.notes?.trim() || "",
      req.body.load_number?.trim() || "",
      req.body.opi_number?.trim() || "",
      req.body.opi_date?.trim() || ""
    ]);
    await saveMaterialLogLookup(client, "discipline", req.body.discipline);
    await saveMaterialLogLookup(client, "vendor_name", req.body.vendor_name);
    await saveMaterialLogLookup(client, "po_number", effectivePoNumber);
    await saveMaterialLogLookup(client, "received_by", req.body.received_by);
    await syncMrrVendorsIntoVendorTable(client);
    await syncOpiLogsFromMrr(client);
    await auditLog(client, req.user.id, "create", "mrr_log", result.rows[0].id, mrrNumber);
  });
  res.redirect("/material-logs/mrr");
});

app.post("/material-logs/fmr/add", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const fmrNumber = await getNextFmrNumber(client);
    await ensureUniqueFmrContainer(client, req.body.vendor_name, req.body.container_no);
    const result = await client.query(`
      insert into fmr_logs (
        fmr_number, vendor_name, container_no, fluor_id, fluor_desc, request_description, mrr_number, request_date, need_date, pick_ticket, pickup_location, pickup_date, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
      returning id
    `, [
      fmrNumber,
      req.body.vendor_name?.trim() || "",
      req.body.container_no?.trim() || "",
      req.body.fluor_id?.trim() || "",
      req.body.fluor_desc?.trim() || "",
      req.body.request_description?.trim() || "",
      req.body.mrr_number?.trim() || "",
      req.body.request_date?.trim() || "",
      req.body.need_date?.trim() || "",
      req.body.pick_ticket?.trim() || "",
      req.body.pickup_location?.trim() || "",
      req.body.pickup_date?.trim() || ""
    ]);
    await ensureMrrForVendorCrate(client, {
      userId: req.user.id,
      fmrId: result.rows[0].id,
      vendorName: req.body.vendor_name?.trim() || "",
      containerNo: req.body.container_no?.trim() || "",
      mrrNumber: req.body.mrr_number?.trim() || ""
    });
    await auditLog(client, req.user.id, "create", "fmr_log", result.rows[0].id, fmrNumber);
  });
  res.redirect("/material-logs/fmr");
});

app.get("/material-logs/receiving/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  const row = (await query("select * from material_receiving_logs where id = $1", [req.params.id])).rows[0];
  if (!row) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Receiving log row not found.</h3></div>`, req.user));
    return;
  }
  const normalizedRowWarehouse = normalizeWarehouseName(row.warehouse);
  const normalizedRowLocation = normalizeLocationName(row.location);
  const warehouseOptions = await getWarehouseOptions();
  const locationMap = await getWarehouseLocationMap();
  const warehouseOptionsHtml = [`<option value="">Select warehouse</option>`]
    .concat(warehouseOptions.map((warehouse) => `<option value="${esc(warehouse.name)}" ${warehouse.name === normalizedRowWarehouse ? "selected" : ""}>${esc(warehouse.name)}</option>`))
    .join("");
  res.send(layout("Edit Receiving Log", `
    <h1>Edit Material Receiving Line</h1>
    <div class="card">
      <form method="post" action="/material-logs/receiving/${row.id}/edit" class="stack">
        <div class="grid">
          <div><label>Legacy ID</label><input name="legacy_row_id" value="${esc(row.legacy_row_id || "")}" /></div>
          <div><label>Discipline</label><input name="discipline" value="${esc(row.discipline)}" /></div>
          <div><label>Vendor</label><input name="vendor_name" value="${esc(row.vendor_name)}" /></div>
          <div><label>PO</label><input name="po_number" value="${esc(row.po_number)}" /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(row.item_code)}" /></div>
          <div><label>Description</label><input name="description" value="${esc(row.description)}" /></div>
          <div><label>Received Qty</label><input name="received_qty" value="${esc(formatQtyDisplay(row.received_qty))}" /></div>
          <div><label>Qty Unit</label><input name="qty_unit" value="${esc(row.qty_unit)}" /></div>
          <div><label>MRR Number</label><input name="mrr_number" value="${esc(row.mrr_number)}" /></div>
          <div><label>FMR Number</label><input name="fmr_number" value="${esc(row.fmr_number)}" /></div>
          <div><label>Warehouse</label><select id="receiving-log-warehouse-${row.id}" name="warehouse" onchange='syncLocationOptions("receiving-log-warehouse-${row.id}", "receiving-log-location-${row.id}", ${escAttr(JSON.stringify(locationMap))}, "${escAttr(normalizedRowLocation)}")'>${warehouseOptionsHtml}</select></div>
          <div><label>Location</label><select id="receiving-log-location-${row.id}" name="location" data-placeholder="Select location"><option value="">Select location</option></select></div>
        </div>
        <div><label>Received Date</label><input name="recv_date" value="${esc(formatShortDateTime(row.recv_date))}" /></div>
        <div><label>Comments</label><textarea name="comments">${esc(row.comments)}</textarea></div>
        <div class="actions"><button type="submit">Save Receiving Line</button><a class="btn btn-secondary" href="/material-logs">Back</a></div>
      </form>
      <script>syncLocationOptions("receiving-log-warehouse-${row.id}", "receiving-log-location-${row.id}", ${JSON.stringify(locationMap)}, ${JSON.stringify(normalizedRowLocation)});</script>
    </div>
  `, req.user));
});

app.post("/material-logs/receiving/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await assertValidWarehouseLocation(client, req.body.warehouse, req.body.location);
    await client.query(`
      update material_receiving_logs
      set legacy_row_id = $2, discipline = $3, vendor_name = $4, po_number = $5, item_code = $6, description = $7, received_qty = $8,
          qty_unit = $9, mrr_number = $10, fmr_number = $11, warehouse = $12, location = $13, recv_date = $14, comments = $15, updated_at = now()
      where id = $1
    `, [
      req.params.id,
      req.body.legacy_row_id ? Number(req.body.legacy_row_id) : null,
      req.body.discipline?.trim() || "",
      req.body.vendor_name?.trim() || "",
      req.body.po_number?.trim() || "",
      req.body.item_code?.trim() || "",
      req.body.description?.trim() || "",
      parseQtyValue(req.body.received_qty || 0),
      req.body.qty_unit?.trim() || "",
      req.body.mrr_number?.trim() || "",
      req.body.fmr_number?.trim() || "",
      normalizeWarehouseName(req.body.warehouse),
      normalizeLocationName(req.body.location),
      req.body.recv_date?.trim() || "",
      req.body.comments?.trim() || ""
    ]);
    await auditLog(client, req.user.id, "update", "material_receiving_log", req.params.id, req.body.item_code?.trim() || "");
  });
  res.redirect("/material-logs");
});

app.get("/material-logs/mrr/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    await syncMrrVendorsIntoVendorTable(client);
  });
  const row = (await query("select * from mrr_logs where id = $1", [req.params.id])).rows[0];
  if (!row) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>MRR log row not found.</h3></div>`, req.user));
    return;
  }
  const [disciplines, vendors, pos, receivers, appPos, poReceiptLines, manualLines] = await Promise.all([
      getMaterialLogLookupOptions("discipline"),
      getMaterialLogLookupOptions("vendor_name"),
      getMaterialLogLookupOptions("po_number"),
      getMaterialLogLookupOptions("received_by"),
      getAppPurchaseOrderOptions(),
      query(`
        select
          r.id,
          'PO Receipt' as source_type,
          coalesce(pl.po_line, '') as po_line,
          mi.item_code,
          mi.description,
          r.qty_received,
          r.warehouse,
          r.location,
          r.osd_status,
          coalesce(r.osd_notes, '') as notes,
          r.received_at::text as line_date
        from receipts r
        join po_lines pl on pl.id = r.po_line_id
        join material_items mi on mi.id = pl.material_item_id
        where r.mrr_log_id = $1
        order by r.id desc
      `, [req.params.id]),
      query(`
        select
          mrl.id,
          'Manual Entry' as source_type,
          coalesce(mrl.po_position, '') as po_line,
          coalesce(mrl.item_code, '') as item_code,
          coalesce(mrl.description, '') as description,
          coalesce(mrl.received_qty, 0) as qty_received,
          coalesce(mrl.warehouse, '') as warehouse,
          coalesce(mrl.location, '') as location,
          coalesce(mrl.received_status, '') as osd_status,
          coalesce(mrl.comments, '') as notes,
          coalesce(mrl.recv_date, '') as line_date
        from material_receiving_logs mrl
        where coalesce(mrl.mrr_number, '') = $1
        order by coalesce(mrl.legacy_row_id, mrl.id) desc
      `, [row.mrr_number])
    ]);
  const optionList = (values, selectedValue, placeholder) => [`<option value="">${esc(placeholder)}</option>`]
    .concat(values.map((value) => `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(value)}</option>`))
    .join("");
    const appPoOptions = [`<option value="">Select app PO</option>`]
      .concat(appPos.map((po) => `<option value="${po.id}" ${Number(po.id) === Number(row.app_po_id || 0) ? "selected" : ""}>${esc(po.po_no)}${po.vendor_name ? ` | ${esc(po.vendor_name)}` : ""}${po.description ? ` | ${esc(po.description)}` : ""}</option>`))
      .join("");
    const mrrLineRows = [...poReceiptLines.rows, ...manualLines.rows]
      .sort((a, b) => String(b.line_date || "").localeCompare(String(a.line_date || "")) || Number(b.id || 0) - Number(a.id || 0))
      .map((line) => `<tr>
        <td>${esc(line.source_type)}</td>
        <td>${esc(line.po_line || "")}</td>
        <td>${esc(line.item_code || "")}</td>
        <td>${esc(line.description || "")}</td>
        <td>${esc(formatQtyDisplay(line.qty_received))}</td>
        <td>${esc(line.warehouse || "")}</td>
        <td>${esc(line.location || "")}</td>
        <td>${esc(line.osd_status || "")}</td>
        <td>${esc(formatShortDateTime(line.line_date || ""))}</td>
        <td>${esc(line.notes || "")}</td>
      </tr>`).join("");
    res.send(layout("Edit MRR Log", `
      <h1>Edit MRR Header</h1>
      <div class="card">
      <form method="post" action="/material-logs/mrr/${row.id}/edit" class="stack">
        <div class="grid">
          <div><label>MRR Number</label><input name="mrr_number" value="${esc(row.mrr_number)}" required /></div>
          <div><label>Discipline</label><select name="discipline">${optionList(disciplines, row.discipline, "Select discipline")}</select></div>
          <div><label>Vendor</label><div class="inline-field"><select name="vendor_name">${optionList(vendors, row.vendor_name, "Select vendor")}</select><a class="btn btn-secondary" href="/vendors/new">Add Vendor</a></div></div>
          <div><label>App PO</label><div class="inline-field"><select name="app_po_id">${appPoOptions}</select><a class="btn btn-secondary" href="/po/new">Add PO</a></div></div>
          <div><label>Legacy PO Number</label><select name="po_number">${optionList(pos, row.po_number, "Select legacy PO")}</select></div>
          <div><label>Pick Ticket</label><input name="pick_ticket" value="${esc(row.pick_ticket)}" /></div>
          <div><label>Received Date</label><input type="date" name="received_date" value="${esc(row.received_date)}" /></div>
          <div><label>Received By</label><div class="inline-field"><select name="received_by">${optionList(receivers, row.received_by, "Select received by")}</select><a class="btn btn-secondary" href="/material-logs/received-by/new">Add Person</a></div></div>
          <div><label>Load #</label><input name="load_number" value="${esc(row.load_number)}" /></div>
          <div><label>OPI #</label><input name="opi_number" value="${esc(row.opi_number)}" /></div>
          <div><label>OPI Date</label><input type="date" name="opi_date" value="${esc(row.opi_date)}" /></div>
        </div>
        <div><label>Description</label><textarea name="material_description">${esc(row.material_description)}</textarea></div>
        <div><label>Notes</label><textarea name="notes">${esc(row.notes)}</textarea></div>
          <div class="actions"><button type="submit">Save MRR</button><a class="btn btn-secondary" href="/receive/${row.id}?back=/material-logs/mrr/${row.id}/edit">Receive Missed Line</a><a class="btn btn-secondary" target="_blank" href="/material-logs/mrr/${row.id}/form.pdf">Open MRR PDF</a><a class="btn btn-secondary" href="/material-logs/mrr">Back</a></div>
        </form>
      </div>
      <div class="card scroll">
        <h3>MRR Lines</h3>
        <table><tr><th>Source</th><th>PO Line</th><th>Item</th><th>Description</th><th>Qty</th><th>Warehouse</th><th>Location</th><th>Status</th><th>Date</th><th>Notes</th></tr>${mrrLineRows || `<tr><td colspan="10" class="muted">No MRR lines found for this header yet.</td></tr>`}</table>
      </div>
    `, req.user));
  });

app.post("/material-logs/mrr/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  await withTransaction(async (client) => {
    const appPoId = req.body.app_po_id ? Number(req.body.app_po_id) : null;
    const linkedPo = appPoId
      ? (await client.query("select id, po_no from purchase_orders where id = $1", [appPoId])).rows[0]
      : null;
    const effectivePoNumber = linkedPo?.po_no || req.body.po_number?.trim() || "";
    await client.query(`
      update mrr_logs
      set mrr_number = $2, discipline = $3, vendor_name = $4, app_po_id = $5, po_number = $6, pick_ticket = $7, material_description = $8,
          received_date = $9, received_by = $10, notes = $11, load_number = $12, opi_number = $13, opi_date = $14, updated_at = now()
      where id = $1
    `, [
      req.params.id,
      req.body.mrr_number?.trim(),
      req.body.discipline?.trim() || "",
      req.body.vendor_name?.trim() || "",
      linkedPo?.id || null,
      effectivePoNumber,
      req.body.pick_ticket?.trim() || "",
      req.body.material_description?.trim() || "",
      req.body.received_date?.trim() || "",
      req.body.received_by?.trim() || "",
      req.body.notes?.trim() || "",
      req.body.load_number?.trim() || "",
      req.body.opi_number?.trim() || "",
      req.body.opi_date?.trim() || ""
    ]);
    await saveMaterialLogLookup(client, "discipline", req.body.discipline);
    await saveMaterialLogLookup(client, "vendor_name", req.body.vendor_name);
    await saveMaterialLogLookup(client, "po_number", effectivePoNumber);
    await saveMaterialLogLookup(client, "received_by", req.body.received_by);
    await syncMrrVendorsIntoVendorTable(client);
    await syncOpiLogsFromMrr(client);
    await auditLog(client, req.user.id, "update", "mrr_log", req.params.id, req.body.mrr_number?.trim() || "");
  });
  res.redirect("/material-logs/mrr");
});

app.get("/material-logs/fmr/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
  const [rowRes, vendors] = await Promise.all([
    query("select * from fmr_logs where id = $1", [req.params.id]),
    query("select name from vendors where is_active = true order by name")
  ]);
  const row = rowRes.rows[0];
  if (!row) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Vendor FMR log row not found.</h3></div>`, req.user));
    return;
  }
  const vendorNames = vendors.rows.map((vendor) => String(vendor.name || "").trim()).filter(Boolean);
  if (String(row.vendor_name || "").trim() && !vendorNames.some((name) => name.toLowerCase() === String(row.vendor_name || "").trim().toLowerCase())) {
    vendorNames.unshift(String(row.vendor_name || "").trim());
  }
  const vendorOptions = [`<option value="">Select vendor</option>`]
    .concat(vendorNames.map((vendorName) => `<option value="${esc(vendorName)}" ${String(row.vendor_name || "").trim().toLowerCase() === vendorName.toLowerCase() ? "selected" : ""}>${esc(vendorName)}</option>`))
    .join("");
  res.send(layout("Edit Vendor FMR Log", `
      <h1>Edit Vendor FMR Entry</h1>
      <div class="card">
        <form method="post" action="/material-logs/fmr/${row.id}/edit" class="stack">
          <div class="grid">
            <div><label>FMR Number</label><input name="fmr_number" value="${esc(row.fmr_number)}" required /></div>
            <div><label>Vendor</label><div class="inline-field"><select name="vendor_name" required>${vendorOptions}</select><a class="btn btn-secondary" href="/vendors/new">Add Vendor</a></div></div>
            <div><label>Container #</label><input name="container_no" value="${esc(row.container_no)}" /></div>
            <div><label>Fluor ID</label><input name="fluor_id" value="${esc(row.fluor_id)}" /></div>
            <div><label>MRR #</label><input name="mrr_number" value="${esc(row.mrr_number)}" /></div>
          <div><label>Request Date</label><input name="request_date" value="${esc(formatShortDateTime(row.request_date))}" /></div>
          <div><label>Need Date</label><input name="need_date" value="${esc(formatShortDateTime(row.need_date))}" /></div>
          <div><label>Pick Ticket #</label><input name="pick_ticket" value="${esc(row.pick_ticket)}" /></div>
          <div><label>Pickup Location</label><input name="pickup_location" value="${esc(row.pickup_location)}" /></div>
          <div><label>Pickup Date</label><input name="pickup_date" value="${esc(formatShortDateTime(row.pickup_date))}" /></div>
        </div>
        <div><label>Fluor Description</label><textarea name="fluor_desc">${esc(row.fluor_desc)}</textarea></div>
        <div><label>Request Description</label><textarea name="request_description">${esc(row.request_description)}</textarea></div>
        <div class="actions">
          <button type="submit">Save Vendor FMR</button>
          <a class="btn btn-secondary" href="/material-logs">Back</a>
          <form method="post" action="/material-logs/fmr/${row.id}/delete" onsubmit="return confirm('Delete Vendor FMR ${escAttr(row.fmr_number)}?');">
            <button class="btn btn-danger" type="submit">Delete Vendor FMR</button>
          </form>
        </div>
        </form>
      </div>
    `, req.user));
  });

  app.post("/material-logs/fmr/:id/edit", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
    await withTransaction(async (client) => {
      await ensureUniqueFmrContainer(client, req.body.vendor_name, req.body.container_no, req.params.id);
    await client.query(`
      update fmr_logs
      set fmr_number = $2, vendor_name = $3, container_no = $4, fluor_id = $5, fluor_desc = $6, request_description = $7,
          mrr_number = $8, request_date = $9, need_date = $10, pick_ticket = $11, pickup_location = $12, pickup_date = $13, updated_at = now()
      where id = $1
    `, [
      req.params.id,
      req.body.fmr_number?.trim(),
      req.body.vendor_name?.trim() || "",
      req.body.container_no?.trim() || "",
      req.body.fluor_id?.trim() || "",
      req.body.fluor_desc?.trim() || "",
      req.body.request_description?.trim() || "",
      req.body.mrr_number?.trim() || "",
      req.body.request_date?.trim() || "",
      req.body.need_date?.trim() || "",
      req.body.pick_ticket?.trim() || "",
      req.body.pickup_location?.trim() || "",
      req.body.pickup_date?.trim() || ""
    ]);
    await ensureMrrForVendorCrate(client, {
      userId: req.user.id,
      fmrId: req.params.id,
      vendorName: req.body.vendor_name?.trim() || "",
      containerNo: req.body.container_no?.trim() || "",
      mrrNumber: req.body.mrr_number?.trim() || ""
    });
    await auditLog(client, req.user.id, "update", "fmr_log", req.params.id, req.body.fmr_number?.trim() || "");
    });
    res.redirect("/material-logs/fmr");
  });

  app.post("/material-logs/fmr/:id/delete", requireAuth, requirePermission("material_logs", "edit"), async (req, res) => {
    await withTransaction(async (client) => {
      const current = (await client.query("select fmr_number from fmr_logs where id = $1", [req.params.id])).rows[0];
      if (!current) throw new Error("Vendor FMR log row not found.");
      await client.query("delete from fmr_logs where id = $1", [req.params.id]);
      await auditLog(client, req.user.id, "delete", "fmr_log", req.params.id, current.fmr_number || "");
    });
    res.redirect("/material-logs/fmr");
  });

app.use((error, req, res, _next) => {
  const user = currentUser(req);
  res.status(400).send(layout("Error", `<div class="card error"><h3>Error</h3><pre>${esc(error.message)}</pre></div>`, user));
});

await initDb();

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Running on http://127.0.0.1:${PORT}`);
  });
}

export default app;
