function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

export async function addOnTheFlyBomItem(client, {
  bomId,
  jobId,
  userId,
  input = {}
}, services) {
  const lineNo = requiredText(input.line_no, "Line No");
  const itemCode = requiredText(input.item_code, "Item Code");
  const qtyRequired = services.parseQtyValue(input.qty_required, NaN);
  if (!Number.isFinite(qtyRequired) || qtyRequired <= 0) {
    throw new Error("Qty Required must be greater than zero.");
  }

  if (input.actual_qty === null || input.actual_qty === undefined || String(input.actual_qty).trim() === "") {
    throw new Error("Actual On-Hand Qty is required. Enter 0 when no starting stock should be posted.");
  }
  const actualQty = services.parseQtyValue(input.actual_qty, NaN);
  if (!Number.isFinite(actualQty) || actualQty < 0) {
    throw new Error("Actual On-Hand Qty must be zero or greater.");
  }
  const storage = services.normalizeWarehouseLocationValues(input.warehouse, input.location);
  if (actualQty > 0 && (!storage.warehouse || !storage.location)) {
    throw new Error("Warehouse and Location are required when Actual On-Hand Qty is greater than zero.");
  }

  const existingItem = (await client.query(`
    select id
    from material_items
    where job_id = $1 and lower(item_code) = lower($2)
    limit 1
  `, [jobId, itemCode])).rows[0];

  let itemCreated = false;
  if (!existingItem) {
    const masterResult = await services.upsertMaterialMasterItem(client, {
      item_code: itemCode,
      description: input.description,
      material_type: input.material_type,
      uom: input.uom,
      commodity_code: input.commodity_code,
      size_1: input.size_1,
      size_2: input.size_2,
      thk_1: input.thk_1,
      thk_2: input.thk_2,
      notes: input.item_notes,
      specs: input.specs
    }, jobId);
    if (masterResult.status === "skipped") throw new Error(masterResult.message);
    itemCreated = true;
  }

  const bomSpec = services.normalizeSpecName(input.spec || "");
  const materialLookup = await services.getMaterialItemForUse(client, itemCode, jobId, bomSpec);
  if (materialLookup.errorCode) throw new Error(materialLookup.message);
  const item = materialLookup.item;
  const sourceUid = `${lineNo}|${item.item_code}`;
  const duplicate = (await client.query(
    "select id from bom_lines where bom_id = $1 and source_uid = $2 limit 1",
    [bomId, sourceUid]
  )).rows[0];
  if (duplicate) throw new Error(`${lineNo} / ${item.item_code} already exists on this BOM.`);

  const insertedLine = (await client.query(`
    insert into bom_lines (
      bom_id, line_no, item_code, description, material_type, uom, qty_required,
      spec, commodity_code, tag_number, iwp_no, iso_no, size_1, size_2, thk_1, thk_2,
      planning_status, notes, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15, $16,
      'PLANNED', $17, now()
    )
    returning id
  `, [
    bomId,
    lineNo,
    item.item_code,
    item.description || item.item_code,
    item.material_type || "misc",
    item.uom || "EA",
    qtyRequired,
    bomSpec,
    item.commodity_code || "",
    String(input.tag_number || "").trim(),
    String(input.iwp_no || "").trim(),
    String(input.iso_no || "").trim(),
    item.size_1 || "",
    item.size_2 || "",
    item.thk_1 || "",
    item.thk_2 || "",
    String(input.bom_notes || "").trim()
  ])).rows[0];

  let inventoryReport = null;
  if (actualQty > 0) {
    inventoryReport = await services.saveInventoryAuditReport(client, {
      userId,
      jobId,
      warehouseFilter: storage.warehouse,
      locationFilter: storage.location,
      identFilter: item.item_code,
      rebuildUnallocated: false,
      desiredRows: [{
        item_code: item.item_code,
        description: item.description || item.item_code,
        size_1: item.size_1 || "",
        size_2: item.size_2 || "",
        thk_1: item.thk_1 || "",
        thk_2: item.thk_2 || "",
        warehouse: storage.warehouse,
        location: storage.location,
        actual_qty: actualQty
      }]
    });
  }

  await services.rebuildUnallocatedBom(client, jobId);
  await services.auditLog(client, userId, "create", "bom_line", insertedLine.id, item.item_code);
  return {
    bomLineId: Number(insertedLine.id),
    itemCode: item.item_code,
    itemCreated,
    actualQty,
    inventoryReport
  };
}
