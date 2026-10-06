// Shared inventory uses exact, reviewed material variants; receipts never move jobs.
const fields = [
  "item_code",
  "uom",
  "spec",
  "size_1",
  "size_2",
  "thk_1",
  "thk_2",
];
export const text = (value) => String(value ?? "").trim();
export function variant(row) {
  return Object.fromEntries(
    fields.map((f) => [
      f,
      f === "uom" ? text(row[f]).toUpperCase() : text(row[f]),
    ]),
  );
}
export const variantKey = (row) =>
  JSON.stringify(fields.map((f) => variant(row)[f]));
export const ownedKey = (row) =>
  JSON.stringify([Number(row.job_id), variantKey(row)]);
export function quantity(value, { zero = false } = {}) {
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    (!zero && n === 0) ||
    Math.abs(n * 10000 - Math.round(n * 10000)) > 0.000001
  )
    throw Object.assign(
      new Error(
        "Enter a quantity " +
          (zero ? "of zero or greater" : "greater than zero") +
          " with at most four decimal places.",
      ),
      { statusCode: 400 },
    );
  return Math.round(n * 10000) / 10000;
}
const round = (n) => Math.round(n * 10000) / 10000;
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
export function selectedJobs(values, accessible, fallback) {
  const ids = [...new Set([].concat(values ?? fallback ?? []).map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    fail("Select at least one valid job.");
  const allowed = new Set(accessible.map((j) => Number(j.id)));
  if (ids.some((id) => !allowed.has(id)))
    fail("You do not have access to a selected job.", 403);
  return ids;
}
export function normalizeStock(rows) {
  // Legacy issues without a location still reduce their material's total physical stock.
  const result = rows.map((r) => ({
    ...r,
    ...variant(r),
    job_id: Number(r.job_id),
    qty_on_hand: Number(r.qty_on_hand),
    qty_osd: Number(r.qty_osd || 0),
  }));
  for (const debt of result.filter(
    (r) => r.qty_on_hand < 0 && !r.warehouse && !r.location,
  )) {
    let remaining = -debt.qty_on_hand;
    for (const row of result.filter(
      (r) => ownedKey(r) === ownedKey(debt) && r.qty_on_hand > 0,
    )) {
      const used = Math.min(row.qty_on_hand, remaining);
      row.qty_on_hand = round(row.qty_on_hand - used);
      remaining = round(remaining - used);
    }
    debt.qty_on_hand = -remaining;
  }
  return result;
}
export function reservationApplies(
  reservation,
  { jobId, requisitionId, bomId, reservationId },
) {
  if (Number(reservation.job_id) !== Number(jobId)) return false;
  if (
    reservation.requisition_id &&
    Number(reservation.requisition_id) !== Number(requisitionId)
  )
    return false;
  if (reservation.bom_id && Number(reservation.bom_id) !== Number(bomId))
    return false;
  // A free-text purpose must be chosen explicitly, never consumed accidentally.
  if (
    text(reservation.purpose) &&
    !reservation.requisition_id &&
    !reservation.bom_id
  )
    return Number(reservation.id) === Number(reservationId);
  return true;
}
export function allocateStock(rows, qty) {
  let remaining = quantity(qty);
  const allocations = [];
  for (const row of rows
    .filter((r) => r.qty_on_hand > 0)
    .sort(
      (a, b) =>
        Number(a.job_id) - Number(b.job_id) ||
        text(a.warehouse).localeCompare(text(b.warehouse)) ||
        text(a.location).localeCompare(text(b.location)),
    )) {
    const used = Math.min(Number(row.qty_on_hand), remaining);
    if (used > 0) allocations.push({ ...row, qty: used });
    remaining = round(remaining - used);
    if (!remaining) break;
  }
  if (remaining > 0)
    fail("Not enough physical stock is available for this material.");
  return allocations;
}
export function availableFromSnapshot(state, jobId, context = {}) {
  const targetLinks = state.links.filter(
    (m) => Number(m.job_id) === Number(jobId),
  );
  const rows = [];
  for (const link of targetLinks) {
    const stock = state.stock.filter(
      (r) => Number(r.material_id) === Number(link.material_id),
    );
    const held = state.reservations
      .filter(
        (r) =>
          Number(r.material_id) === Number(link.material_id) &&
          !reservationApplies(r, { jobId, ...context }),
      )
      .reduce((n, r) => n + Number(r.qty_remaining), 0);
    rows.push({
      ...link,
      qty_available: Math.max(
        stock.reduce((n, r) => n + r.qty_on_hand, 0) - held,
        0,
      ),
    });
  }
  const unmatched = new Map();
  for (const row of state.stock.filter(
    (r) => Number(r.job_id) === Number(jobId) && !r.material_id,
  )) {
    const k = ownedKey(row);
    if (!unmatched.has(k)) unmatched.set(k, { ...row, qty_available: 0 });
    unmatched.get(k).qty_available += row.qty_on_hand;
  }
  for (const row of unmatched.values()) {
    const held = state.reservations
      .filter(
        (r) =>
          r.virtual &&
          !r.material_id &&
          ownedKey(r) === ownedKey(row) &&
          !reservationApplies(r, { jobId, ...context }),
      )
      .reduce((n, r) => n + Number(r.qty_remaining), 0);
    row.qty_available = Math.max(row.qty_available - held, 0);
    rows.push(row);
  }
  return rows;
}
export function createSharedInventory({ auditLog }) {
  const event = async (
    db,
    userId,
    action,
    { reservationId = null, movementId = null, qty = 0, details = "" } = {},
  ) => {
    await db.query(
      "insert into inventory_reservation_events (reservation_id,movement_id,action,qty,details,created_by) values ($1,$2,$3,$4,$5,$6)",
      [reservationId, movementId, action, qty, details, userId],
    );
    await auditLog(
      db,
      userId,
      action,
      "shared_inventory",
      reservationId || movementId || "",
      details,
    );
  };
  const lock = async (db) => {
    await db.query("select id from inventory_pool_lock where id=1 for update");
  };
  const membership = async (db, jobId) =>
    (
      await db.query(
        "select p.* from inventory_pool_jobs pj join inventory_pools p on p.id=pj.pool_id where pj.job_id=$1",
        [jobId],
      )
    ).rows[0] || null;
  const ownedStock = async (db, ids) =>
    normalizeStock(
      (
        await db.query(
          "select * from shared_inventory_owned_stock where job_id=any($1::bigint[]) order by job_id,item_code,warehouse,location",
          [ids],
        )
      ).rows,
    );
  const addAcceptedHolds = async (db, state) => {
    const ids = state.jobs.map((j) => Number(j.id));
    const lines = (
      await db.query(
        "select mr.job_id,mr.id as requisition_id,bl.bom_id,bl.*,mrl.id as hold_line_id,mrl.inventory_reservation_id,mrl.qty_requested from material_requisition_lines mrl join material_requisitions mr on mr.id=mrl.requisition_id join bom_lines bl on bl.id=mrl.bom_line_id where mr.job_id=any($1::bigint[]) and mr.status in ('ACCEPTED','VERIFIED','FLAGGED','LOADED') order by mr.id,mrl.id",
        [ids],
      )
    ).rows;
    const credit = new Map(
      state.reservations.map((r) => [Number(r.id), Number(r.qty_remaining)]),
    );
    for (const line of lines) {
      const link = state.links.find((m) => ownedKey(m) === ownedKey(line));
      let qty = Number(line.qty_requested);
      if (link)
        for (const r of state.reservations.filter(
          (r) =>
            !r.virtual &&
            Number(r.material_id) === Number(link.material_id) &&
            reservationApplies(r, {
              jobId: line.job_id,
              requisitionId: line.requisition_id,
              bomId: line.bom_id,
              reservationId: line.inventory_reservation_id,
            }),
        )) {
          const used = Math.min(qty, credit.get(Number(r.id)) || 0);
          qty = round(qty - used);
          credit.set(Number(r.id), (credit.get(Number(r.id)) || 0) - used);
        }
      if (qty > 0)
        state.reservations.push({
          id: -Number(line.hold_line_id),
          virtual: true,
          pool_id: state.pool.id,
          material_id: link?.material_id || null,
          ...variant(line),
          job_id: line.job_id,
          requisition_id: line.requisition_id,
          bom_id: line.bom_id,
          purpose: "Accepted requisition hold",
          qty_remaining: qty,
        });
    }
    return state;
  };
  const matches = async (db, ids) =>
    (
      await db.query(
        "select m.*,mat.name as material_name from inventory_pool_matches m join inventory_pool_materials mat on mat.id=m.material_id where m.job_id=any($1::bigint[])",
        [ids],
      )
    ).rows;
  const snapshot = async (db, poolId) => {
    const pool = (
      await db.query("select * from inventory_pools where id=$1", [poolId])
    ).rows[0];
    if (!pool) fail("Inventory pool not found.", 404);
    const jobs = (
      await db.query(
        "select j.* from jobs j join inventory_pool_jobs pj on pj.job_id=j.id where pj.pool_id=$1 order by j.job_number",
        [poolId],
      )
    ).rows;
    const ids = jobs.map((j) => Number(j.id));
    const stock = await ownedStock(db, ids);
    const links = await matches(db, ids);
    const materials = (
      await db.query(
        "select * from inventory_pool_materials where pool_id=$1 order by name",
        [poolId],
      )
    ).rows;
    const reservations = (
      await db.query(
        "select * from inventory_reservations where pool_id=$1 and qty_remaining>0 order by created_at,id",
        [poolId],
      )
    ).rows;
    const linkMap = new Map(links.map((m) => [ownedKey(m), m]));
    for (const row of stock)
      row.material_id = linkMap.get(ownedKey(row))?.material_id || null;
    return addAcceptedHolds(db, {
      pool,
      jobs,
      stock,
      links,
      materials,
      reservations,
    });
  };
  const assertPoolAccess = (state, accessible, manage = false) => {
    const allowed = new Set(accessible.map((j) => Number(j.id)));
    if (
      !state.jobs.some((j) => allowed.has(Number(j.id))) ||
      (manage && state.jobs.some((j) => !allowed.has(Number(j.id))))
    )
      fail(
        manage
          ? "Managing this pool requires access to every member job."
          : "You do not have access to this pool.",
        403,
      );
  };
  const createPool = async (db, { name, jobIds, userId, reviewed }) => {
    await lock(db);
    if (!text(name) || !reviewed || !jobIds.length)
      fail("Enter a pool name, select jobs, and confirm the stock review.");
    const eligible = (
      await db.query(
        "select id from jobs where id=any($1::bigint[]) and is_active=true",
        [jobIds],
      )
    ).rows;
    if (eligible.length !== jobIds.length) fail("Select active jobs only.");
    if (
      (
        await db.query(
          "select job_id from inventory_pool_jobs where job_id=any($1::bigint[])",
          [jobIds],
        )
      ).rows.length
    )
      fail("A selected job already belongs to an inventory pool.");
    const p = (
      await db.query(
        "insert into inventory_pools (name,created_by) values ($1,$2) returning *",
        [text(name), userId],
      )
    ).rows[0];
    for (const id of jobIds)
      await db.query(
        "insert into inventory_pool_jobs (pool_id,job_id,reviewed_by) values ($1,$2,$3)",
        [p.id, id, userId],
      );
    await auditLog(
      db,
      userId,
      "create_pool",
      "inventory_pool",
      p.id,
      JSON.stringify({ name: p.name, jobIds }),
    );
    return p;
  };
  const addJob = async (db, { poolId, jobId, userId, reviewed }) => {
    await lock(db);
    if (!reviewed) fail("Review existing stock before linking this job.");
    if (
      !(
        await db.query("select id from jobs where id=$1 and is_active=true", [
          jobId,
        ])
      ).rows.length
    )
      fail("Select an active job.");
    await db.query(
      "insert into inventory_pool_jobs (pool_id,job_id,reviewed_by) values ($1,$2,$3)",
      [poolId, jobId, userId],
    );
    await auditLog(
      db,
      userId,
      "join_pool",
      "inventory_pool",
      poolId,
      "job=" + jobId,
    );
  };
  const removeJob = async (db, { poolId, jobId, userId }) => {
    await lock(db);
    const s = await snapshot(db, poolId);
    if (!s.jobs.some((j) => Number(j.id) === Number(jobId)))
      fail("Job is not in this pool.");
    if (s.reservations.some((r) => Number(r.job_id) === Number(jobId)))
      fail("Release or reassign this job's reservations first.");
    if (
      s.stock.some(
        (r) =>
          Number(r.job_id) === Number(jobId) &&
          (r.qty_on_hand !== 0 || r.qty_osd !== 0),
      )
    )
      fail(
        "Resolve this job's remaining stock allocation before removing it from the pool.",
      );
    if (
      (
        await db.query(
          "select id from shared_inventory_movements where (source_job_id=$1 or destination_job_id=$1) and qty_issued>qty_returned limit 1",
          [jobId],
        )
      ).rows.length
    )
      fail("Return outstanding shared issues before removing this job.");
    await db.query("delete from inventory_pool_matches where job_id=$1", [
      jobId,
    ]);
    await db.query("delete from inventory_pool_jobs where job_id=$1", [jobId]);
    await auditLog(
      db,
      userId,
      "leave_pool",
      "inventory_pool",
      poolId,
      "job=" + jobId,
    );
  };
  const candidates = async (db, jobIds) => {
    const stock = await ownedStock(db, jobIds);
    const demand = (
      await db.query(
        "select bh.job_id,bl.* from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=any($1::bigint[]) and coalesce(bh.system_key,'')<>'UNALLOCATED'",
        [jobIds],
      )
    ).rows;
    const combined = new Map();
    for (const row of stock) {
      const key = ownedKey(row);
      if (!combined.has(key))
        combined.set(key, {
          ...row,
          ...variant(row),
          qty_on_hand: 0,
          locations: [],
        });
      const candidate = combined.get(key);
      candidate.qty_on_hand = round(candidate.qty_on_hand + row.qty_on_hand);
      candidate.locations.push(
        [row.warehouse, row.location].filter(Boolean).join(" / "),
      );
    }
    for (const row of demand)
      if (!combined.has(ownedKey(row)))
        combined.set(ownedKey(row), { ...row, ...variant(row) });
    return [...combined.values()];
  };
  const addMatch = async (
    db,
    { poolId, materialId, row, name, userId, reviewed },
  ) => {
    await lock(db);
    if (!reviewed)
      fail("Confirm the specifications and unit review before matching.");
    row = { ...variant(row), job_id: Number(row.job_id) };
    if (!row.uom || row.spec.includes("[AMBIGUOUS SPEC]"))
      fail(
        "Resolve the material's unit and ambiguous specifications before matching.",
      );
    if (
      !(await candidates(db, [row.job_id])).some(
        (c) => ownedKey(c) === ownedKey(row),
      )
    )
      fail("Selected material variant was not found in this job.");
    let material;
    if (materialId)
      material = (
        await db.query(
          "select * from inventory_pool_materials where id=$1 and pool_id=$2",
          [materialId, poolId],
        )
      ).rows[0];
    else
      material = (
        await db.query(
          "insert into inventory_pool_materials (pool_id,name,uom,spec,size_1,size_2,thk_1,thk_2) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
          [
            poolId,
            text(name),
            row.uom,
            row.spec,
            row.size_1,
            row.size_2,
            row.thk_1,
            row.thk_2,
          ],
        )
      ).rows[0];
    if (
      !material ||
      ["uom", "spec", "size_1", "size_2", "thk_1", "thk_2"].some(
        (f) => text(material[f]) !== row[f],
      )
    )
      fail(
        "Units, specifications and dimensions must match the shared material exactly.",
      );
    await db.query(
      "insert into inventory_pool_matches (pool_id,job_id,material_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2,reviewed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [poolId, row.job_id, material.id, ...fields.map((f) => row[f]), userId],
    );
    await auditLog(
      db,
      userId,
      "match_material",
      "inventory_pool",
      poolId,
      JSON.stringify({ materialId: material.id, ...row }),
    );
  };
  const reserve = async (
    db,
    { poolId, materialId, jobId, qty, purpose, bomId, requisitionId, userId },
  ) => {
    await lock(db);
    qty = quantity(qty);
    const s = await snapshot(db, poolId);
    if (
      !s.jobs.some((j) => Number(j.id) === Number(jobId)) ||
      !s.links.some(
        (m) =>
          Number(m.job_id) === Number(jobId) &&
          Number(m.material_id) === Number(materialId),
      )
    )
      fail("The destination job must have a reviewed match for this material.");
    if (
      bomId &&
      !(
        await db.query("select id from bom_headers where id=$1 and job_id=$2", [
          bomId,
          jobId,
        ])
      ).rows.length
    )
      fail("BOM does not belong to the destination job.");
    if (
      requisitionId &&
      !(
        await db.query(
          "select id from material_requisitions where id=$1 and job_id=$2 and status not in ('ISSUED','CLOSED','CANCELLED')",
          [requisitionId, jobId],
        )
      ).rows.length
    )
      fail("Select an open requisition belonging to the destination job.");
    const onHand = s.stock
      .filter((r) => Number(r.material_id) === Number(materialId))
      .reduce((n, r) => n + r.qty_on_hand, 0);
    const reserved = s.reservations
      .filter(
        (r) =>
          Number(r.material_id) === Number(materialId) &&
          !(
            r.virtual && reservationApplies(r, { jobId, requisitionId, bomId })
          ),
      )
      .reduce((n, r) => n + Number(r.qty_remaining), 0);
    if (qty > round(onHand - reserved))
      fail("Reservation exceeds unreserved stock on hand.");
    const r = (
      await db.query(
        "insert into inventory_reservations (pool_id,material_id,job_id,qty_remaining,purpose,bom_id,requisition_id,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
        [
          poolId,
          materialId,
          jobId,
          qty,
          text(purpose),
          bomId || null,
          requisitionId || null,
          userId,
        ],
      )
    ).rows[0];
    await event(db, userId, "reserve", {
      reservationId: r.id,
      qty,
      details: JSON.stringify({ jobId, purpose, bomId, requisitionId }),
    });
    return r;
  };
  const changeReservation = async (
    db,
    {
      poolId,
      reservationId,
      jobId,
      qty,
      purpose,
      bomId,
      requisitionId,
      userId,
    },
  ) => {
    await lock(db);
    const r = (
      await db.query(
        "select * from inventory_reservations where id=$1 and pool_id=$2 for update",
        [reservationId, poolId],
      )
    ).rows[0];
    if (!r) fail("Reservation not found.", 404);
    qty = quantity(qty, { zero: true });
    // Revalidate references and available stock using the same creation path, then retain the original ID.
    await db.query(
      "update inventory_reservations set qty_remaining=0 where id=$1",
      [r.id],
    );
    if (qty > 0) {
      const replacement = await reserve(db, {
        poolId,
        materialId: r.material_id,
        jobId,
        qty,
        purpose,
        bomId,
        requisitionId,
        userId,
      });
      await db.query(
        "update inventory_reservations set job_id=$2,qty_remaining=$3,purpose=$4,bom_id=$5,requisition_id=$6,updated_at=now() where id=$1",
        [r.id, jobId, qty, text(purpose), bomId || null, requisitionId || null],
      );
      await db.query(
        "update inventory_reservation_events set reservation_id=$1 where reservation_id=$2",
        [r.id, replacement.id],
      );
      await db.query("delete from inventory_reservations where id=$1", [
        replacement.id,
      ]);
    }
    await event(
      db,
      userId,
      qty > 0 ? "change_reservation" : "release_reservation",
      {
        reservationId: r.id,
        qty,
        details: JSON.stringify({
          previous: r,
          next: { jobId, qty, purpose, bomId, requisitionId },
        }),
      },
    );
  };
  const issue = async (
    db,
    { jobId, requisitionId, userId, reservationIds = {} },
  ) => {
    await lock(db);
    const p = await membership(db, jobId);
    if (!p) return false;
    const header = (
      await db.query(
        "select * from material_requisitions where id=$1 and job_id=$2 for update",
        [requisitionId, jobId],
      )
    ).rows[0];
    if (
      !header ||
      !["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(header.status)
    )
      fail("Requisition must be accepted before issue.");
    if (
      (
        await db.query(
          "select id from shared_inventory_movements where requisition_id=$1 and qty_issued>qty_returned limit 1",
          [requisitionId],
        )
      ).rows.length
    )
      fail("This requisition already has shared issue history.");
    const lines = (
      await db.query(
        "select bl.*,mrl.id as requisition_line_id,mrl.qty_issued as issue_qty,mrl.inventory_reservation_id,mrl.qty_requested from material_requisition_lines mrl join bom_lines bl on bl.id=mrl.bom_line_id where mrl.requisition_id=$1 and mrl.job_id=$2 order by mrl.id",
        [requisitionId, jobId],
      )
    ).rows;
    if (!lines.length) fail("No requisition lines found.");
    for (const line of lines) {
      const qty = quantity(line.issue_qty, { zero: true });
      if (qty > Number(line.qty_requested))
        fail("Issued quantity cannot exceed requested quantity.");
      if (!qty) continue;
      const s = await snapshot(db, p.id);
      const link = s.links.find(
        (m) => ownedKey(m) === ownedKey({ ...line, job_id: jobId }),
      );
      const materialId = link?.material_id || null;
      const stock = s.stock.filter((r) =>
        materialId
          ? Number(r.material_id) === Number(materialId)
          : ownedKey(r) === ownedKey({ ...line, job_id: jobId }) &&
            !r.material_id,
      );
      const reservations = s.reservations.filter((r) =>
        materialId
          ? Number(r.material_id) === Number(materialId)
          : r.virtual &&
            !r.material_id &&
            ownedKey(r) === ownedKey({ ...line, job_id: jobId }),
      );
      const context = {
        jobId,
        requisitionId,
        bomId: line.bom_id,
        reservationId: Object.hasOwn(reservationIds, line.requisition_line_id)
          ? reservationIds[line.requisition_line_id]
          : line.inventory_reservation_id,
      };
      if (
        context.reservationId &&
        !reservations.some(
          (r) =>
            Number(r.id) === Number(context.reservationId) &&
            reservationApplies(r, context),
        )
      )
        fail("Selected reservation does not apply to this requisition line.");
      const eligible = reservations.filter((r) =>
        reservationApplies(r, context),
      );
      const total = stock.reduce((n, r) => n + r.qty_on_hand, 0);
      const protectedQty = reservations
        .filter((r) => !eligible.includes(r))
        .reduce((n, r) => n + Number(r.qty_remaining), 0);
      if (qty > round(total))
        fail("Not enough physical stock is available for this material.");
      if (qty > round(total - protectedQty))
        fail(
          "Issue would use reserved material. Release or reassign its reservation first.",
        );
      const allocations = allocateStock(stock, qty);
      const reservationParts = [];
      let remaining = qty;
      for (const r of eligible.filter((r) => !r.virtual)) {
        const used = Math.min(remaining, Number(r.qty_remaining));
        if (!used) continue;
        await db.query(
          "update inventory_reservations set qty_remaining=qty_remaining-$2,updated_at=now() where id=$1",
          [r.id, used],
        );
        await event(db, userId, "fulfill_reservation", {
          reservationId: r.id,
          qty: used,
          details: "requisition=" + requisitionId,
        });
        reservationParts.push({ id: r.id, qty: used });
        remaining = round(remaining - used);
      }
      if (remaining) reservationParts.push({ id: null, qty: remaining });
      for (const allocation of allocations) {
        let toIssue = allocation.qty;
        while (toIssue > 0) {
          const part = reservationParts.find((r) => r.qty > 0);
          const used = Math.min(toIssue, part.qty);
          const m = (
            await db.query(
              "insert into shared_inventory_movements (pool_id,material_id,source_job_id,destination_job_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2,warehouse,location,requisition_id,requisition_line_id,reservation_id,qty_issued,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id",
              [
                p.id,
                materialId,
                allocation.job_id,
                jobId,
                ...fields.map((f) => allocation[f]),
                allocation.warehouse,
                allocation.location,
                requisitionId,
                line.requisition_line_id,
                part.id,
                used,
                userId,
              ],
            )
          ).rows[0];
          await db.query(
            "insert into material_issue_transactions (job_id,requisition_id,requisition_line_id,source_bom_line_id,issue_source,warehouse,location,qty_issued,created_by,shared_movement_id) values ($1,$2,$3,$4,'SHARED',$5,$6,$7,$8,$9)",
            [
              jobId,
              requisitionId,
              line.requisition_line_id,
              line.id,
              allocation.warehouse,
              allocation.location,
              used,
              userId,
              m.id,
            ],
          );
          await event(db, userId, "shared_issue", {
            movementId: m.id,
            qty: used,
            details: JSON.stringify({
              sourceJob: allocation.job_id,
              destinationJob: jobId,
              requisitionId,
            }),
          });
          part.qty = round(part.qty - used);
          toIssue = round(toIssue - used);
        }
      }
    }
    await db.query(
      "update material_requisitions set status='ISSUED',issued_at=now(),issued_by_user_id=$3 where id=$1 and job_id=$2",
      [requisitionId, jobId, userId],
    );
    await auditLog(
      db,
      userId,
      "issue",
      "material_requisition",
      requisitionId,
      header.requisition_no,
    );
    return true;
  };
  const returnStock = async (
    db,
    { poolId, movementId, qty, userId, reason },
  ) => {
    await lock(db);
    qty = quantity(qty);
    const m = (
      await db.query(
        "select * from shared_inventory_movements where id=$1 and pool_id=$2 for update",
        [movementId, poolId],
      )
    ).rows[0];
    if (!m || qty > round(Number(m.qty_issued) - Number(m.qty_returned)))
      fail("Return quantity exceeds the outstanding issue.");
    if (!text(reason)) fail("Enter a reason for the return.");
    await db.query(
      "update shared_inventory_movements set qty_returned=qty_returned+$2 where id=$1",
      [m.id, qty],
    );
    await db.query(
      "update material_issue_transactions set qty_issued=qty_issued-$2 where shared_movement_id=$1",
      [m.id, qty],
    );
    await db.query(
      "update material_requisition_lines set qty_issued=qty_issued-$2 where id=$1",
      [m.requisition_line_id, qty],
    );
    await event(db, userId, "shared_return", {
      movementId: m.id,
      qty,
      details: text(reason),
    });
    return m;
  };
  const cancelIssues = async (db, requisitionId, userId) => {
    await lock(db);
    const movements = (
      await db.query(
        "select * from shared_inventory_movements where requisition_id=$1 and qty_issued>qty_returned",
        [requisitionId],
      )
    ).rows;
    for (const m of movements)
      await returnStock(db, {
        poolId: m.pool_id,
        movementId: m.id,
        qty: Number(m.qty_issued) - Number(m.qty_returned),
        userId,
        reason: "Requisition cancelled",
      });
  };
  const availableForJob = async (db, jobId, context = {}) => {
    const p = await membership(db, jobId);
    if (!p) return null;
    const state = await snapshot(db, p.id);
    return availableFromSnapshot(state, jobId, context);
  };
  const rebuildUnallocated = async (db, jobId, bomId) => {
    const available = await availableForJob(db, jobId);
    const demand = (
      await db.query(
        "select bh.job_id,bl.* from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=$1 and coalesce(bh.system_key,'')<>'UNALLOCATED'",
        [jobId],
      )
    ).rows;
    const needed = new Map();
    for (const row of demand)
      needed.set(
        ownedKey(row),
        (needed.get(ownedKey(row)) || 0) +
          Math.max(Number(row.qty_required) - Number(row.qty_issued), 0),
      );
    const existing = (
      await db.query(
        "select bl.*, (select count(*) from material_requisition_lines where bom_line_id=bl.id)::int as used from bom_lines bl where bom_id=$1",
        [bomId],
      )
    ).rows;
    const active = new Set();
    for (const row of available) {
      const qty = Math.max(
        round(row.qty_available - (needed.get(ownedKey(row)) || 0)),
        0,
      );
      if (!qty) continue;
      const prior = existing.find((r) => variantKey(r) === variantKey(row));
      active.add(variantKey(row));
      if (prior) {
        await db.query(
          "update bom_lines set qty_required=$2,qty_received=$2,qty_issued=0,planning_status='RECEIVED',updated_at=now() where id=$1",
          [prior.id, qty],
        );
      } else {
        const maxLine = existing.reduce(
          (n, r) => Math.max(n, Number(r.line_no) || 0),
          0,
        );
        const lineNo = String(maxLine + 1);
        const r = (
          await db.query(
            "insert into bom_lines (bom_id,line_no,item_code,description,material_type,uom,spec,size_1,size_2,thk_1,thk_2,qty_required,qty_received,planning_status) values ($1,$2,$3,$4,'misc',$5,$6,$7,$8,$9,$10,$11,$11,'RECEIVED') returning *",
            [
              bomId,
              lineNo,
              row.item_code,
              row.description || row.material_name || row.item_code,
              row.uom,
              row.spec,
              row.size_1,
              row.size_2,
              row.thk_1,
              row.thk_2,
              qty,
            ],
          )
        ).rows[0];
        existing.push({ ...r, used: 0 });
      }
    }
    for (const row of existing.filter((r) => !active.has(variantKey(r)))) {
      if (row.used)
        await db.query(
          "update bom_lines set qty_required=0,qty_received=0,planning_status='CLOSED',updated_at=now() where id=$1",
          [row.id],
        );
      else await db.query("delete from bom_lines where id=$1", [row.id]);
    }
  };
  return {
    rebuildUnallocated,
    availableForJob,
    addAcceptedHolds,
    lock,
    membership,
    ownedStock,
    matches,
    snapshot,
    assertPoolAccess,
    createPool,
    addJob,
    removeJob,
    candidates,
    addMatch,
    reserve,
    changeReservation,
    issue,
    returnStock,
    cancelIssues,
  };
}
export function buildMultiJobReport({
  jobs,
  stock,
  demand,
  matches,
  reservations,
  memberships,
}) {
  const selected = new Set(jobs.map((j) => Number(j.id)));
  const links = new Map(matches.map((m) => [ownedKey(m), m]));
  const pools = new Map(memberships.map((m) => [Number(m.job_id), m]));
  const groups = new Map();
  const groupFor = (row) => {
    const link = links.get(ownedKey(row));
    const key = link
      ? "material:" + link.material_id
      : "job:" + row.job_id + ":" + variantKey(row);
    if (!groups.has(key))
      groups.set(key, {
        key,
        label: link?.material_name || row.item_code,
        ...variant(row),
        description: row.description || "",
        pool_id: link?.pool_id || null,
        pool_name: pools.get(Number(row.job_id))?.name || "",
        stock_job_id: link ? null : Number(row.job_id),
        on_hand: 0,
        reserved_total: 0,
        reserved_selected: 0,
        unreserved: 0,
        available: 0,
        required: 0,
        issued: 0,
        outstanding: 0,
        ordered: 0,
        to_purchase: 0,
        jobs: {},
      });
    return groups.get(key);
  };
  for (const row of stock) {
    const link = links.get(ownedKey(row));
    // Include all members' matched stock, but never unrelated unselected jobs' unmatched stock.
    if (
      !selected.has(Number(row.job_id)) &&
      (!link ||
        !matches.some(
          (m) =>
            Number(m.material_id) === Number(link.material_id) &&
            selected.has(Number(m.job_id)),
        ))
    )
      continue;
    groupFor(row).on_hand += Number(row.qty_on_hand);
  }
  for (const row of demand) {
    if (!selected.has(Number(row.job_id))) continue;
    const g = groupFor(row),
      id = Number(row.job_id);
    const j = (g.jobs[id] ||= {
      required: 0,
      issued: 0,
      outstanding: 0,
      ordered: 0,
      reserved: 0,
    });
    const required = Number(row.qty_required || 0),
      issued = Number(row.qty_issued || 0),
      ordered = Number(row.qty_ordered || 0);
    j.required += required;
    j.issued += issued;
    j.ordered += ordered;
    j.outstanding += Math.max(required - issued, 0);
    g.required += required;
    g.issued += issued;
    g.ordered += ordered;
    g.outstanding += Math.max(required - issued, 0);
  }
  for (const r of reservations) {
    const g = r.material_id
      ? groups.get("material:" + r.material_id)
      : groups.get("job:" + r.job_id + ":" + variantKey(r));
    if (!g) continue;
    const qty = Number(r.qty_remaining);
    g.reserved_total += qty;
    if (selected.has(Number(r.job_id))) {
      g.reserved_selected += qty;
      const j = (g.jobs[r.job_id] ||= {
        required: 0,
        issued: 0,
        outstanding: 0,
        ordered: 0,
        reserved: 0,
      });
      j.reserved += qty;
    }
  }
  return [...groups.values()]
    .map((g) => {
      g.unreserved = Math.max(round(g.on_hand - g.reserved_total), 0);
      g.available = round(g.unreserved + g.reserved_selected);
      // Same buy calculation as the existing Material Purchase Report.
      g.to_purchase = Math.max(round(g.required - g.ordered - g.available), 0);
      return g;
    })
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    );
}
