export function normalizeRequestPrefix(value) {
  const prefix = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-+$/, "");
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,59}$/.test(prefix))
    throw Object.assign(
      new Error(
        "Enter a material request prefix using letters, numbers, hyphens, underscores, dots or slashes (maximum 60 characters).",
      ),
      { statusCode: 400 },
    );
  return prefix;
}
export async function getDeliveryLocation(
  db,
  jobId,
  id,
  { lock = false } = {},
) {
  const row = (
    await db.query(
      `select * from delivery_locations where id=$1 and job_id=$2 and is_active=true ${lock ? "for share" : ""}`,
      [Number(id) || 0, jobId],
    )
  ).rows[0];
  if (!row)
    throw Object.assign(
      new Error("Select an active delivery location for this job."),
      { statusCode: 400 },
    );
  return row;
}
export async function nextDeliveryRequestNumber(db, jobId, location) {
  // Settings validate custom prefixes; retain legacy job prefixes exactly for PO-created requests.
  const prefix = String(location.request_prefix || "").trim().replace(/-+$/, "");
  if (!prefix) throw Object.assign(new Error("Material request prefix is required."), {statusCode:400});
  const row = (
    await db.query(
      `
    insert into material_request_counters(job_id,prefix,last_number)
    select $1,$2,coalesce(max(substring(requisition_no from length($2)+2)::bigint),0)+1
    from material_requisitions where job_id=$1 and left(requisition_no,length($2)+1)=$2||'-'
      and substring(requisition_no from length($2)+2) ~ '^[0-9]+$'
    on conflict(job_id,prefix) do update set last_number=greatest(material_request_counters.last_number+1,excluded.last_number)
    returning last_number
  `,
      [jobId, prefix],
    )
  ).rows[0];
  return `${prefix}-${String(row.last_number).padStart(5, "0")}`;
}
export function registerDeliveryLocationRoutes(app, deps) {
  const {
    query,
    withTransaction,
    auditLog,
    requireAuth,
    requireJobContext,
    requirePermission,
    requireRole,
    adminEquivalentRoles,
    asyncHandler,
    currentJobId,
    layout,
    esc,
    canAccess,
  } = deps;
  const path = "/settings/warehouse-setup/delivery-locations";
  app.get(
    path,
    requireAuth,
    requireJobContext,
    requirePermission("settings", "view"),
    asyncHandler(async (req, res) => {
      const rows = (
        await query(
          "select * from delivery_locations where job_id=$1 order by lower(name),id",
          [currentJobId(req)],
        )
      ).rows;
      const edit =
        canAccess(req.user, "settings", "edit") &&
        adminEquivalentRoles.includes(req.user.role);
      res.send(
        layout(
          "Delivery Locations",
          `<style>.delivery-location-section { margin-bottom: 20px; } .delivery-location-table { background: #fff; table-layout: fixed; min-width: 650px; } .delivery-location-table th, .delivery-location-table td { border: 0; border-bottom: 1px solid var(--line); padding: 8px 10px; vertical-align: middle; } .delivery-location-table th:nth-child(1) { width: 40%; } .delivery-location-table th:nth-child(2) { width: 30%; } .delivery-location-table th:nth-child(3) { width: 20%; } .delivery-location-table th:nth-child(4) { width: 10%; } .delivery-location-table tbody tr td { background: #fff; } .delivery-location-table input, .delivery-location-table select { width: 100%; min-width: 0; background: transparent; border: 1px solid transparent; box-shadow: none; border-radius: 0; } .delivery-location-table input:focus, .delivery-location-table select:focus { background: #f7f9fb; border-color: var(--line-strong); } .delivery-location-table button { width: auto; min-width: 65px; }</style><h1>Delivery Locations</h1><div class="delivery-location-section"><p>Choose delivery destinations and their material request number prefixes. Example: prefix MH-MR produces MH-MR-00001. These destinations are separate from stock warehouses and storage locations.</p><a class="btn btn-secondary" href="/settings/warehouse-setup">Back to Warehouse Setup</a></div>${edit ? `<div class="delivery-location-section"><h3>Add Delivery Location</h3><form method="post" action="${path}" class="stack"><div class="grid"><div><label>Delivery Location</label><input name="name" maxlength="120" required /></div><div><label>Material Request Prefix</label><input name="request_prefix" maxlength="60" placeholder="MH-MR" required /></div></div><button>Add Delivery Location</button></form></div>` : ""}<div class="scroll"><table class="delivery-location-table"><tr><th>Delivery Location</th><th>Material Request Prefix</th><th>Status</th><th>Action</th></tr>${rows.map((row) => `<tr>${edit ? `<td><input form="delivery-location-${row.id}" name="name" aria-label="Delivery location" value="${esc(row.name)}" maxlength="120" required /></td><td><input form="delivery-location-${row.id}" name="request_prefix" aria-label="Material request prefix" value="${esc(row.request_prefix)}" maxlength="60" required /></td><td><select form="delivery-location-${row.id}" name="is_active" aria-label="Status"><option value="1" ${row.is_active ? "selected" : ""}>Active</option><option value="0" ${row.is_active ? "" : "selected"}>Inactive</option></select></td><td><form id="delivery-location-${row.id}" method="post" action="${path}/${row.id}"><button type="submit">Save</button></form></td>` : `<td>${esc(row.name)}</td><td>${esc(row.request_prefix)}</td><td>${row.is_active ? "Active" : "Inactive"}</td><td></td>`}</tr>`).join("") || '<tr><td colspan="4">No delivery locations configured.</td></tr>'}</table></div>`,
          req.user,
        ),
      );
    }),
  );
  const save = async (req, res) => {
    const jobId = currentJobId(req),
      name = String(req.body.name || "").trim(),
      prefix = normalizeRequestPrefix(req.body.request_prefix);
    if (!name || name.length > 120)
      throw Object.assign(
        new Error("Enter a delivery location name (maximum 120 characters)."),
        { statusCode: 400 },
      );
    await withTransaction(async (db) => {
      const row = req.params.id
        ? (
            await db.query(
              "update delivery_locations set name=$1,request_prefix=$2,is_active=$3,updated_at=now() where id=$4 and job_id=$5 returning *",
              [name, prefix, req.body.is_active === "1", req.params.id, jobId],
            )
          ).rows[0]
        : (
            await db.query(
              "insert into delivery_locations(job_id,name,request_prefix) values($1,$2,$3) returning *",
              [jobId, name, prefix],
            )
          ).rows[0];
      if (!row)
        throw Object.assign(
          new Error("Delivery location not found for this job."),
          { statusCode: 404 },
        );
      await auditLog(
        db,
        req.user.id,
        req.params.id ? "update" : "create",
        "delivery_location",
        row.id,
        JSON.stringify({ name, prefix, active: row.is_active }),
      );
    });
    res.redirect(path);
  };
  for (const route of [path, path + "/:id"])
    app.post(
      route,
      requireAuth,
      requireJobContext,
      requireRole(adminEquivalentRoles),
      requirePermission("settings", "edit"),
      asyncHandler(save),
    );
}
