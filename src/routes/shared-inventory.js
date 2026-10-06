import {
  selectedJobs,
  ownedKey,
  variant,
  buildMultiJobReport,
} from "../shared-inventory.js";

export function registerSharedInventoryRoutes(app, deps) {
  const {
    query,
    withTransaction,
    sharedInventory: service,
    requireAuth,
    requireJobContext,
    requirePermission,
    asyncHandler,
    layout,
    esc,
    canAccess,
    currentJobId,
    XLSX,
    recomputeBomIssuedSummaries,
    rebuildUnallocatedBom,
  } = deps;
  const jobsFor = (req) => req.user.accessibleJobs || [];
  const checked = (value) => value === "on";
  const quantityInput = (name, value = "", zero = false) =>
    `<input type="number" name="${name}" value="${esc(value)}" min="${zero ? "0" : "0.0001"}" step="0.0001" required />`;
  const jobOptions = (jobs, id) =>
    jobs
      .map(
        (j) =>
          `<option value="${j.id}" ${Number(j.id) === Number(id) ? "selected" : ""}>${esc(j.job_number)}</option>`,
      )
      .join("");
  const jobChecks = (jobs, ids) =>
    jobs
      .map(
        (j) =>
          `<label class="check-option"><input type="checkbox" name="job_ids" value="${j.id}" ${ids.includes(Number(j.id)) ? "checked" : ""} /><span>${esc(j.job_number)} ${esc(j.plant_name || "")}</span></label>`,
      )
      .join("");
  const table = (heads, rows) =>
    `<div class="card scroll"><table><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows || `<tr><td colspan="${heads.length}">No records.</td></tr>`}</table></div>`;
  const cells = (values) =>
    `<tr>${values.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`;
  const reviewTable = (rows, jobs) =>
    table(
      [
        "Job",
        "Item",
        "Description",
        "UOM",
        "Spec",
        "Size 1",
        "Size 2",
        "Thk 1",
        "Thk 2",
        "Locations",
        "On hand",
      ],
      rows
        .map((r) =>
          cells([
            jobs.find((j) => Number(j.id) === Number(r.job_id))?.job_number,
            r.item_code,
            r.description,
            r.uom,
            r.spec,
            r.size_1,
            r.size_2,
            r.thk_1,
            r.thk_2,
            r.locations?.join(", ") ||
              [r.warehouse, r.location].filter(Boolean).join(" / "),
            r.qty_on_hand ?? "Demand only",
          ]),
        )
        .join(""),
    );
  const canManage = (req) => canAccess(req.user, "inventory_pools", "edit");
  const accessState = async (db, req, poolId, manage = false) => {
    const s = await service.snapshot(db, poolId);
    service.assertPoolAccess(s, jobsFor(req), manage);
    return s;
  };
  const manageMutation = (path, fn) =>
    app.post(
      path,
      requireAuth,
      requireJobContext,
      requirePermission("inventory_pools", "edit"),
      asyncHandler(async (req, res) => {
        await withTransaction(async (db) => {
          await service.lock(db);
          await accessState(db, req, req.params.id, true);
          await fn(db, req);
        });
        res.redirect("/inventory/pools/" + req.params.id);
      }),
    );
  app.get(
    "/inventory/pools",
    requireAuth,
    requireJobContext,
    requirePermission("inventory", "view"),
    requirePermission("inventory_pools", "view"),
    asyncHandler(async (req, res) => {
      const ids = jobsFor(req).map((j) => Number(j.id));
      const pools = (
        await query(
          "select distinct p.* from inventory_pools p join inventory_pool_jobs pj on pj.pool_id=p.id where pj.job_id=any($1::bigint[]) order by p.name",
          [ids],
        )
      ).rows;
      res.send(
        layout(
          "Inventory Pools",
          `<h1>Inventory Pools</h1><div class="card"><p>Only jobs explicitly linked to a pool share stock. Unmatched items remain with their receiving job.</p><div class="actions">
      ${canManage(req) ? '<a class="btn btn-primary" href="/inventory/pools/new">Create Pool</a>' : ""}
      <a class="btn btn-secondary" href="/inventory/multi-job">Multi-job Needs &amp; Stock</a><a class="btn btn-secondary" href="/inventory">Job Inventory</a></div></div>
      ${table(["Pool", "Action"], pools.map((p) => `<tr><td>${esc(p.name)}</td><td><a class="btn btn-secondary" href="/inventory/pools/${p.id}">Stock &amp; Reservations</a></td></tr>`).join(""))}`,
          req.user,
        ),
      );
    }),
  );
  app.get(
    "/inventory/pools/new",
    requireAuth,
    requireJobContext,
    requirePermission("inventory_pools", "edit"),
    asyncHandler(async (req, res) => {
      const jobs = jobsFor(req).filter((j) => j.is_active !== false);
      const ids = req.query.job_ids
        ? selectedJobs(req.query.job_ids, jobs)
        : [];
      const rows = ids.length ? await service.candidates({ query }, ids) : [];
      res.send(
        layout(
          "Create Inventory Pool",
          `<h1>Create Inventory Pool</h1><div class="card"><form method="get" class="stack"><label>Choose jobs to share this inventory</label><div class="check-grid">${jobChecks(jobs, ids)}</div><button>Review Existing Stock and Materials</button></form></div>
      ${
        ids.length
          ? reviewTable(rows, jobs) +
            `<div class="card"><form method="post" action="/inventory/pools" class="stack">${ids.map((id) => `<input type="hidden" name="job_ids" value="${id}" />`).join("")}
      <label>Pool name</label><input name="name" required maxlength="120" />
      <label class="check-option"><input type="checkbox" name="reviewed" required /><span>I reviewed the existing stock. These jobs hold different stock, not duplicated records of the same physical materials.</span></label>
      <p>Materials will be matched explicitly after creating the pool. Nothing is combined automatically.</p><button>Create Pool</button></form></div>`
          : ""
      }`,
          req.user,
        ),
      );
    }),
  );
  app.post(
    "/inventory/pools",
    requireAuth,
    requireJobContext,
    requirePermission("inventory_pools", "edit"),
    asyncHandler(async (req, res) => {
      const jobIds = selectedJobs(req.body.job_ids, jobsFor(req));
      const p = await withTransaction((db) =>
        service.createPool(db, {
          name: req.body.name,
          jobIds,
          userId: req.user.id,
          reviewed: checked(req.body.reviewed),
        }),
      );
      res.redirect("/inventory/pools/" + p.id);
    }),
  );
  app.get(
    "/inventory/pools/:id",
    requireAuth,
    requireJobContext,
    requirePermission("inventory", "view"),
    requirePermission("inventory_pools", "view"),
    asyncHandler(async (req, res) => {
      const s = await accessState({ query }, req, req.params.id);
      const allowed = new Set(jobsFor(req).map((j) => Number(j.id)));
      const editable =
        canManage(req) && s.jobs.every((j) => allowed.has(Number(j.id)));
      const visibleJobs = s.jobs.filter((j) => allowed.has(Number(j.id)));
      const jobName = (id) =>
        allowed.has(Number(id))
          ? s.jobs.find((j) => Number(j.id) === Number(id))?.job_number
          : "Other member job";
      const options = s.materials
        .map(
          (m) =>
            `<option value="${m.id}">${esc(m.name)} | ${esc(m.uom)} | ${esc(m.spec)} | ${esc([m.size_1, m.size_2, m.thk_1, m.thk_2].join(" / "))}</option>`,
        )
        .join("");
      const rows = s.materials
        .map((m) => {
          const onHand = s.stock
            .filter((r) => Number(r.material_id) === Number(m.id))
            .reduce((n, r) => n + r.qty_on_hand, 0);
          const reserved = s.reservations
            .filter((r) => Number(r.material_id) === Number(m.id))
            .reduce((n, r) => n + Number(r.qty_remaining), 0);
          return cells([
            m.name,
            m.uom,
            m.spec,
            m.size_1,
            m.size_2,
            m.thk_1,
            m.thk_2,
            onHand,
            reserved,
            Math.max(onHand - reserved, 0),
          ]);
        })
        .join("");
      const reservationRows = s.reservations
        .filter((r) => allowed.has(Number(r.job_id)))
        .map(
          (r) =>
            `<tr><td>${r.virtual ? "Accepted hold" : r.id}</td><td>${esc(s.materials.find((m) => Number(m.id) === Number(r.material_id))?.name || r.item_code)}</td><td>${esc(jobName(r.job_id))}</td><td>${esc(r.purpose)}</td><td>${esc(r.bom_id || "")}</td><td>${esc(r.requisition_id || "")}</td><td>${esc(r.qty_remaining)}</td><td>${
              editable && !r.virtual
                ? `<form method="post" action="/inventory/pools/${s.pool.id}/reservations/${r.id}" class="stack">
      <label>Destination job</label><select name="job_id">${jobOptions(s.jobs, r.job_id)}</select><label>Remaining quantity (0 releases)</label>${quantityInput("qty", r.qty_remaining, true)}
      <label>Purpose</label><input name="purpose" value="${esc(r.purpose)}" /><label>BOM ID (optional)</label><input name="bom_id" type="number" min="1" value="${esc(r.bom_id || "")}" />
      <label>REQ ID (optional)</label><input name="requisition_id" type="number" min="1" value="${esc(r.requisition_id || "")}" /><button>Update / Release</button></form>`
                : ""
            }</td></tr>`,
        )
        .join("");
      const movements = (
        await query(
          "select * from shared_inventory_movements where pool_id=$1 and qty_issued>qty_returned order by id desc",
          [s.pool.id],
        )
      ).rows.filter((m) => allowed.has(Number(m.destination_job_id)));
      const movementRows = movements
        .map(
          (m) =>
            `<tr><td>${m.id}</td><td>${esc(jobName(m.source_job_id))}</td><td>${esc(jobName(m.destination_job_id))}</td><td>${esc(m.item_code)}</td><td>${esc(m.requisition_id)}</td><td>${esc(m.warehouse)}</td><td>${esc(m.location)}</td><td>${Number(m.qty_issued) - Number(m.qty_returned)}</td><td>${editable ? `<form method="post" action="/inventory/pools/${s.pool.id}/returns/${m.id}" class="stack">${quantityInput("qty")}<input name="reason" placeholder="Return reason" required /><button>Return to Stock</button></form>` : ""}</td></tr>`,
        )
        .join("");
      const candidates = editable
        ? await service.candidates(
            { query },
            s.jobs.map((j) => Number(j.id)),
          )
        : [];
      const candidateOptions = candidates
        .filter((r) => !s.links.some((m) => ownedKey(m) === ownedKey(r)))
        .map(
          (r) =>
            `<option value="${esc(ownedKey(r))}">${esc(jobName(r.job_id))} | ${esc(r.item_code)} | ${esc(r.uom)} | ${esc(r.spec)} | ${esc([r.size_1, r.size_2, r.thk_1, r.thk_2].join(" / "))}</option>`,
        )
        .join("");
      const independentJobs = jobsFor(req).filter(
        (j) => !s.jobs.some((m) => Number(m.id) === Number(j.id)),
      );
      const joinId = Number(req.query.review_job || 0);
      const joinReview =
        editable && independentJobs.some((j) => Number(j.id) === joinId)
          ? await service.candidates({ query }, [joinId])
          : null;
      const links = table(
        [
          "Job",
          "Item",
          "Shared material",
          "UOM",
          "Spec",
          "Size 1",
          "Size 2",
          "Thk 1",
          "Thk 2",
        ],
        s.links
          .filter((m) => allowed.has(Number(m.job_id)))
          .map((m) =>
            cells([
              jobName(m.job_id),
              m.item_code,
              m.material_name,
              m.uom,
              m.spec,
              m.size_1,
              m.size_2,
              m.thk_1,
              m.thk_2,
            ]),
          )
          .join(""),
      );
      const eventRows = editable
        ? (
            await query(
              "select e.*,u.username from inventory_reservation_events e join users u on u.id=e.created_by left join inventory_reservations r on r.id=e.reservation_id left join shared_inventory_movements m on m.id=e.movement_id where r.pool_id=$1 or m.pool_id=$1 order by e.id desc limit 100",
              [s.pool.id],
            )
          ).rows
        : [];
      res.send(
        layout(
          s.pool.name,
          `<h1>${esc(s.pool.name)}</h1><div class="card"><p>Member jobs: ${visibleJobs.map((j) => esc(j.job_number)).join(", ")}${visibleJobs.length < s.jobs.length ? " (plus other member jobs)" : ""}</p><p>Shared stock is counted once. Reservations for every pool member are included in availability.</p><a class="btn btn-secondary" href="/inventory/multi-job?${visibleJobs.map((j) => "job_ids=" + j.id).join("&")}">Multi-job Needs &amp; Stock</a></div>
      <h2>Shared Materials</h2>${table(["Material", "UOM", "Spec", "Size 1", "Size 2", "Thk 1", "Thk 2", "On Hand", "Reserved", "Available"], rows)}
      <h2>Shared Stock Locations</h2>${table(
        [
          "Shared Material",
          "Source Job",
          "Source Item",
          "UOM",
          "Spec",
          "Size 1",
          "Size 2",
          "Thk 1",
          "Thk 2",
          "Warehouse",
          "Location",
          "On Hand",
          "OS&D",
        ],
        s.stock
          .filter((r) => r.material_id)
          .map((r) =>
            cells([
              s.materials.find((m) => Number(m.id) === Number(r.material_id))
                ?.name,
              jobName(r.job_id),
              r.item_code,
              r.uom,
              r.spec,
              r.size_1,
              r.size_2,
              r.thk_1,
              r.thk_2,
              r.warehouse,
              r.location,
              r.qty_on_hand,
              r.qty_osd,
            ]),
          )
          .join(""),
      )}
      <h2>Reviewed Matches</h2>${links}
      <h2>Unmatched Stock (Receiving Job Only)</h2>${reviewTable(
        s.stock.filter((r) => !r.material_id && allowed.has(Number(r.job_id))),
        s.jobs,
      )}
      ${editable ? `<div class="card"><h2>Match a Material</h2><form method="post" action="/inventory/pools/${s.pool.id}/matches" class="stack"><label>Job material variant</label><select name="candidate" required>${candidateOptions}</select><label>Existing shared material</label><select name="material_id"><option value="">Create new shared material</option>${options}</select><label>Name for a new shared material</label><input name="name" maxlength="120" /><label class="check-option"><input type="checkbox" name="reviewed" required /><span>I verified that the specification, dimensions and unit identify equivalent material.</span></label><button>Save Reviewed Match</button></form></div>` : ""}
      <h2>Reservations</h2>${table(["ID", "Material", "Job", "Purpose", "BOM ID", "REQ ID", "Remaining", "Actions"], reservationRows)}
      ${editable ? `<div class="card"><h2>Reserve Material</h2><form method="post" action="/inventory/pools/${s.pool.id}/reservations" class="stack"><label>Material</label><select name="material_id" required>${options}</select><label>Destination job</label><select name="job_id">${jobOptions(s.jobs)}</select><label>Quantity</label>${quantityInput("qty")}<label>Purpose (optional)</label><input name="purpose" /><label>BOM ID (optional)</label><input type="number" min="1" name="bom_id" /><label>REQ ID (optional)</label><input type="number" min="1" name="requisition_id" /><button>Reserve</button></form></div>` : ""}
      <h2>Outstanding Shared Issues</h2>${table(["ID", "Source Job", "Destination Job", "Source Item", "REQ ID", "Warehouse", "Location", "Outstanding", "Return"], movementRows)}
      ${
        editable
          ? `<div class="card"><h2>Pool Membership</h2><form method="get" class="stack"><label>Review another job before linking</label><select name="review_job">${jobOptions(independentJobs, joinId)}</select><button>Review Job</button></form>
      ${joinReview ? reviewTable(joinReview, jobsFor(req)) + `<form method="post" action="/inventory/pools/${s.pool.id}/jobs"><input type="hidden" name="job_id" value="${joinId}" /><label class="check-option"><input type="checkbox" name="reviewed" required /><span>I reviewed this job's stock and confirmed it is not duplicated in the pool.</span></label><button>Link Reviewed Job</button></form>` : ""}
      ${s.jobs.map((j) => `<form method="post" action="/inventory/pools/${s.pool.id}/jobs/${j.id}/remove"><button class="btn btn-secondary">Remove Job ${esc(j.job_number)}</button></form>`).join("")}<p>Removal requires resolved stock and reservations.</p></div>
      <h2>Reservation and Movement History</h2>${table(["Date", "User", "Action", "Quantity", "Reservation", "Movement", "Details"], eventRows.map((e) => cells([String(e.created_at), e.username, e.action, e.qty, e.reservation_id, e.movement_id, e.details])).join(""))}`
          : ""
      }`,
          req.user,
        ),
      );
    }),
  );
  manageMutation("/inventory/pools/:id/jobs", async (db, req) => {
    const [jobId] = selectedJobs(req.body.job_id, jobsFor(req));
    await service.addJob(db, {
      poolId: req.params.id,
      jobId,
      userId: req.user.id,
      reviewed: checked(req.body.reviewed),
    });
  });
  manageMutation("/inventory/pools/:id/jobs/:jobId/remove", (db, req) =>
    service.removeJob(db, {
      poolId: req.params.id,
      jobId: req.params.jobId,
      userId: req.user.id,
    }),
  );
  manageMutation("/inventory/pools/:id/matches", async (db, req) => {
    const s = await service.snapshot(db, req.params.id);
    const row = (
      await service.candidates(
        db,
        s.jobs.map((j) => Number(j.id)),
      )
    ).find((r) => ownedKey(r) === req.body.candidate);
    if (!row)
      throw Object.assign(new Error("Choose an existing material variant."), {
        statusCode: 400,
      });
    await service.addMatch(db, {
      poolId: req.params.id,
      materialId: req.body.material_id || null,
      row,
      name: req.body.name,
      userId: req.user.id,
      reviewed: checked(req.body.reviewed),
    });
  });
  const reservationArgs = (req) => ({
    poolId: req.params.id,
    reservationId: req.params.reservationId,
    materialId: req.body.material_id,
    jobId: req.body.job_id,
    qty: req.body.qty,
    purpose: req.body.purpose,
    bomId: req.body.bom_id || null,
    requisitionId: req.body.requisition_id || null,
    userId: req.user.id,
  });
  manageMutation("/inventory/pools/:id/reservations", (db, req) =>
    service.reserve(db, reservationArgs(req)),
  );
  manageMutation(
    "/inventory/pools/:id/reservations/:reservationId",
    (db, req) => service.changeReservation(db, reservationArgs(req)),
  );
  manageMutation(
    "/inventory/pools/:id/returns/:movementId",
    async (db, req) => {
      const m = await service.returnStock(db, {
        poolId: req.params.id,
        movementId: req.params.movementId,
        qty: req.body.qty,
        userId: req.user.id,
        reason: req.body.reason,
      });
      await recomputeBomIssuedSummaries(db, m.destination_job_id);
      await rebuildUnallocatedBom(db, m.destination_job_id);
      if (Number(m.source_job_id) !== Number(m.destination_job_id))
        await rebuildUnallocatedBom(db, m.source_job_id);
    },
  );
  const reportData = async (db, req) => {
    const ids = selectedJobs(
      req.query.job_ids,
      jobsFor(req),
      currentJobId(req),
    );
    const jobs = jobsFor(req).filter((j) => ids.includes(Number(j.id)));
    const memberships = (
      await db.query(
        "select pj.*,p.name from inventory_pool_jobs pj join inventory_pools p on p.id=pj.pool_id where pj.pool_id in (select pool_id from inventory_pool_jobs where job_id=any($1::bigint[]))",
        [ids],
      )
    ).rows;
    const allIds = [
      ...new Set([...ids, ...memberships.map((m) => Number(m.job_id))]),
    ];
    const stock = await service.ownedStock(db, allIds);
    const matches = await service.matches(db, allIds);
    let sourceBomId = null;
    if (req.query.source_bom_id) {
      sourceBomId = Number(req.query.source_bom_id);
      if (
        ids.length !== 1 ||
        !(
          await db.query(
            "select id from bom_headers where id=$1 and job_id=$2 and coalesce(system_key,'')<>'UNALLOCATED'",
            [sourceBomId, ids[0]],
          )
        ).rows.length
      )
        throw Object.assign(
          new Error("Select a BOM belonging to the selected job."),
          { statusCode: 400 },
        );
    }
    const demand = (
      await db.query(
        "select bh.job_id,bl.* from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=any($1::bigint[]) and coalesce(bh.system_key,'')<>'UNALLOCATED' and ($2::bigint is null or bh.id=$2)",
        [ids, sourceBomId],
      )
    ).rows;
    const reservations = [];
    for (const poolId of [
      ...new Set(memberships.map((m) => Number(m.pool_id))),
    ])
      reservations.push(...(await service.snapshot(db, poolId)).reservations);
    const selectedMaterialIds = new Set(
      matches
        .filter((m) => ids.includes(Number(m.job_id)))
        .map((m) => Number(m.material_id)),
    );
    const links = new Map(matches.map((m) => [ownedKey(m), m]));
    const relevantStock = stock
      .filter(
        (r) =>
          ids.includes(Number(r.job_id)) ||
          selectedMaterialIds.has(Number(links.get(ownedKey(r))?.material_id)),
      )
      .map((r) => ({
        ...r,
        material_name: links.get(ownedKey(r))?.material_name || "",
      }));
    return {
      ids,
      jobs,
      sourceBomId,
      rows: buildMultiJobReport({
        jobs,
        stock,
        demand,
        matches,
        reservations,
        memberships,
      }),
      stock: relevantStock,
    };
  };
  const stockScope = (row, data) =>
    row.pool_id
      ? "Shared: " + row.pool_name
      : "Job " +
        (data.jobs.find((j) => Number(j.id) === row.stock_job_id)?.job_number ||
          row.stock_job_id) +
        (row.pool_name ? " (unmatched in " + row.pool_name + ")" : "");
  const sourceJobName = (row, req) =>
    jobsFor(req).find((j) => Number(j.id) === Number(row.job_id))?.job_number ||
    "Other pool member";
  const exportReport = async (req, res) => {
    const data = await withTransaction(async (db) => {
      await db.query("set transaction isolation level repeatable read");
      return reportData(db, req);
    });
    const wb = XLSX.utils.book_new();
    const summary = data.rows.map((r) => ({
      Material: r.label,
      Description: r.description,
      UOM: r.uom,
      Spec: r.spec,
      "Size 1": r.size_1,
      "Size 2": r.size_2,
      "Thk 1": r.thk_1,
      "Thk 2": r.thk_2,
      "Stock Scope": stockScope(r, data),
      "On Hand": r.on_hand,
      "Reserved (All Members)": r.reserved_total,
      "Reserved (Selected Jobs)": r.reserved_selected,
      Unreserved: r.unreserved,
      "Available to Selection": r.available,
      Required: r.required,
      Issued: r.issued,
      "Outstanding Need": r.outstanding,
      Ordered: r.ordered,
      "To Purchase": r.to_purchase,
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(summary),
      "Combined",
    );
    const perJob = data.rows.flatMap((r) =>
      Object.entries(r.jobs).map(([id, j]) => ({
        Job: data.jobs.find((job) => Number(job.id) === Number(id))?.job_number,
        Material: r.label,
        UOM: r.uom,
        Spec: r.spec,
        ...j,
      })),
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(perJob),
      "Job Needs",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        data.stock.map((r) => ({
          "Source Job": sourceJobName(r, req),
          "Shared Material": r.material_name,
          ...variant(r),
          Warehouse: r.warehouse,
          Location: r.location,
          "On Hand": r.qty_on_hand,
          "OS&D": r.qty_osd,
        })),
      ),
      "Stock Locations",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="multi-job-inventory.xlsx"',
    );
    res.send(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
  };
  app.get(
    "/inventory/multi-job/export.xlsx",
    requireAuth,
    requireJobContext,
    requirePermission("inventory", "view"),
    asyncHandler(exportReport),
  );
  app.get(
    "/inventory/multi-job",
    requireAuth,
    requireJobContext,
    requirePermission("inventory", "view"),
    asyncHandler(async (req, res) => {
      const data = await withTransaction(async (db) => {
        await db.query("set transaction isolation level repeatable read");
        return reportData(db, req);
      });
      const heads = [
        "Material",
        "Description",
        "UOM",
        "Spec",
        "Size 1",
        "Size 2",
        "Thk 1",
        "Thk 2",
        "Stock Scope",
        "On Hand (Once)",
        "Reserved (All Members)",
        "Unreserved",
        "Available to Selection",
        "Required",
        "Issued",
        "Outstanding Need",
        "Ordered",
        "To Purchase",
        ...data.jobs.flatMap((j) => [
          j.job_number + " Required",
          j.job_number + " Issued",
          j.job_number + " Outstanding",
          j.job_number + " Reserved",
        ]),
      ];
      const rows = data.rows
        .map((r) =>
          cells([
            r.label,
            r.description,
            r.uom,
            r.spec,
            r.size_1,
            r.size_2,
            r.thk_1,
            r.thk_2,
            stockScope(r, data),
            r.on_hand,
            r.reserved_total,
            r.unreserved,
            r.available,
            r.required,
            r.issued,
            r.outstanding,
            r.ordered,
            r.to_purchase,
            ...data.jobs.flatMap((j) => {
              const v = r.jobs[j.id] || {};
              return [
                v.required || 0,
                v.issued || 0,
                v.outstanding || 0,
                v.reserved || 0,
              ];
            }),
          ]),
        )
        .join("");
      res.send(
        layout(
          "Multi-job Needs & Stock",
          `<h1>Multi-job Needs &amp; Stock</h1><div class="card"><form method="get" class="stack">${data.sourceBomId ? `<input type="hidden" name="source_bom_id" value="${data.sourceBomId}" /><p>BOM source: #${data.sourceBomId}. <a href="/inventory/multi-job">Show all BOMs</a></p>` : ""}<label>Jobs to include</label><div class="check-grid">${jobChecks(jobsFor(req), data.ids)}</div><button>Load Report</button></form><div class="actions"><a class="btn btn-primary" href="/inventory/multi-job/export.xlsx?${data.ids.map((id) => "job_ids=" + id).join("&")}${data.sourceBomId ? "&source_bom_id=" + data.sourceBomId : ""}">Download Excel</a><button type="button" onclick="window.print()">Print Report</button><a class="btn btn-secondary" href="/inventory/pools">Inventory Pools</a></div><p>Shared stock and unreserved quantities appear once per material and pool. Job columns show needs and reservations; selecting jobs here does not link their inventory.</p><p>Available to selection includes unreserved stock plus selected jobs' reservations. Reservations for unselected members remain protected. To purchase uses Required − Ordered − Available, as in the Material Purchase Report. Totals are per material and unit.</p></div>${table(heads, rows)}<h2>Relevant Stock Locations</h2>${table(["Shared Material", "Source Job", "Source Item", "UOM", "Spec", "Size 1", "Size 2", "Thk 1", "Thk 2", "Warehouse", "Location", "On Hand", "OS&D"], data.stock.map((r) => cells([r.material_name, sourceJobName(r, req), r.item_code, r.uom, r.spec, r.size_1, r.size_2, r.thk_1, r.thk_2, r.warehouse, r.location, r.qty_on_hand, r.qty_osd])).join(""))}`,
          req.user,
        ),
      );
    }),
  );
  return { reportData, exportReport };
}
