import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import {
  createSharedInventory,
  selectedJobs,
  variantKey,
  ownedKey,
  quantity,
  reservationApplies,
  buildMultiJobReport,
} from "../src/shared-inventory.js";
import { registerSharedInventoryRoutes } from "../src/routes/shared-inventory.js";
import XLSX from "xlsx";

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  for (const f of fs
    .readdirSync(new URL("../db/migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      fs.readFileSync(
        new URL("../db/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  await db.exec(`
    insert into users(id,username,password_hash,role) values(100,'tester','hash','admin');
    insert into jobs(id,job_number) values(101,'A'),(102,'B'),(103,'C'),(104,'D');
    insert into vendors(id,name,categories) values(100,'Supplier','pipe');
  `);
  const jobs = (await db.query("select * from jobs where id>=101 order by id"))
    .rows;
  for (let i = 0; i < 4; i++) {
    const id = 101 + i,
      code = ["PIPE-A", "PIPE-B", "PIPE-C", "PIPE-D"][i],
      stock = [100, 25, 60, 10][i];
    await db.query(
      "insert into material_items(id,job_id,item_code,description,material_type,uom,size_1) values($1,$2,$3,'Pipe','pipe','EA','2')",
      [1001 + i, id, code],
    );
    await db.query(
      "insert into material_specs(id,job_id,name,material_specification) values($1,$2,'S1','S1')",
      [1101 + i, id],
    );
    await db.query(
      "insert into material_item_specs(job_id,material_item_id,spec_id) values($1,$2,$3)",
      [id, 1001 + i, 1101 + i],
    );
    await db.query(
      "insert into purchase_orders(id,job_id,po_no,vendor_id) values($1,$2,$3,100)",
      [1201 + i, id, "PO-" + code],
    );
    await db.query(
      "insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered,size_1) values($1,$2,$3,$4,$5,'2')",
      [1301 + i, id, 1201 + i, 1001 + i, stock],
    );
    await db.query(
      "insert into receipts(id,job_id,po_line_id,qty_received,warehouse,location,osd_status) values($1,$2,$3,$4,'Yard','BIN-1','OK')",
      [1401 + i, id, 1301 + i, stock],
    );
    await db.query(
      "insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values($1,$2,'TEST',$3,'pipe','ACTIVE')",
      [1501 + i, id, "BOM-" + code],
    );
    await db.query(
      "insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required,spec,size_1) values($1,$2,'1',$3,'Pipe','EA',$4,'S1','2')",
      [1601 + i, 1501 + i, code, [70, 50, 100, 20][i]],
    );
  }
  const service = createSharedInventory({
    auditLog: async (db, user, action, type, id, details) =>
      db.query(
        "insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)",
        [user, action, type, String(id), details],
      ),
  });
  const tx = (fn) => db.transaction(fn);
  const pool = await tx((db) =>
    service.createPool(db, {
      name: "Main Yard",
      jobIds: [101, 102],
      userId: 100,
      reviewed: true,
    }),
  );
  const ca = (await service.candidates(db, [101])).find(
    (c) => c.item_code === "PIPE-A",
  );
  await tx((db) =>
    service.addMatch(db, {
      poolId: pool.id,
      row: ca,
      name: "Reviewed Pipe",
      userId: 100,
      reviewed: true,
    }),
  );
  const mat = (
    await db.query("select * from inventory_pool_materials where pool_id=$1", [
      pool.id,
    ])
  ).rows[0];
  const cb = (await service.candidates(db, [102])).find(
    (c) => c.item_code === "PIPE-B",
  );
  await tx((db) =>
    service.addMatch(db, {
      poolId: pool.id,
      row: cb,
      materialId: mat.id,
      userId: 100,
      reviewed: true,
    }),
  );
  let reqIndex = 0;
  const req = async (jobId, qty, issued = qty, status = "ACCEPTED") => {
    const i = jobId - 101;
    return tx(async (db) => {
      const r = (
        await db.query(
          "insert into material_requisitions(job_id,requisition_no,bom_id,requested_by_user_id,requested_by_name,status) values($1,$2,$3,100,'Tester',$4) returning *",
          [jobId, "REQ-" + ++reqIndex, 1501 + i, status],
        )
      ).rows[0];
      const line = (
        await db.query(
          "insert into material_requisition_lines(job_id,requisition_id,bom_line_id,qty_requested,qty_issued) values($1,$2,$3,$4,$5) returning *",
          [jobId, r.id, 1601 + i, qty, issued],
        )
      ).rows[0];
      return { ...r, line };
    });
  };
  const reserve = (jobId, qty, extra = {}) =>
    tx((db) =>
      service.reserve(db, {
        poolId: pool.id,
        materialId: mat.id,
        jobId,
        qty,
        userId: 100,
        ...extra,
      }),
    );
  return { db, tx, service, jobs, pool, mat, req, reserve };
}

test("job selection, quantity validation and reservation purpose protection", () => {
  assert.deepEqual(
    selectedJobs(["101", "102", "101"], [{ id: 101 }, { id: 102 }]),
    [101, 102],
  );
  assert.throws(() => selectedJobs([103], [{ id: 101 }]), /access/);
  for (const qty of [NaN, Infinity, -1, 0, 1.00001])
    assert.throws(() => quantity(qty));
  assert.equal(quantity(0, { zero: true }), 0);
  const r = { id: 4, job_id: 101, purpose: "Shutdown" };
  assert.equal(reservationApplies(r, { jobId: 101 }), false);
  assert.equal(reservationApplies(r, { jobId: 101, reservationId: 4 }), true);
  assert.equal(
    reservationApplies(
      { ...r, requisition_id: 9 },
      { jobId: 101, requisitionId: 8, reservationId: 4 },
    ),
    false,
  );
});

test("only explicitly linked jobs share reviewed materials; receipt provenance stays intact", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.membership(f.db, 103), null);
  const s = await f.service.snapshot(f.db, f.pool.id);
  assert.deepEqual(
    s.jobs.map((j) => Number(j.id)),
    [101, 102],
  );
  assert.equal(
    s.stock.reduce((n, r) => n + r.qty_on_hand, 0),
    125,
  );
  assert.equal(s.stock.filter((r) => r.material_id).length, 2);
  assert.equal(
    (await f.db.query("select job_id from receipts where id=1401")).rows[0]
      .job_id,
    101,
  );
  await assert.rejects(
    f.tx((db) =>
      f.service.createPool(db, {
        name: "Duplicate",
        jobIds: [102, 103],
        userId: 100,
        reviewed: true,
      }),
    ),
    /already belongs/,
  );
  await assert.rejects(
    f.tx((db) =>
      f.service.createPool(db, {
        name: "Unreviewed",
        jobIds: [103],
        userId: 100,
        reviewed: false,
      }),
    ),
    /review/,
  );
  assert.throws(() => f.service.assertPoolAccess(s, [{ id: 103 }]), /access/);
  assert.throws(
    () => f.service.assertPoolAccess(s, [{ id: 101 }], true),
    /every member/,
  );
});

test("matching enforces specification, dimensions, units and review", async (t) => {
  const f = await fixture(t);
  await f.tx((db) =>
    f.service.addJob(db, {
      poolId: f.pool.id,
      jobId: 103,
      userId: 100,
      reviewed: true,
    }),
  );
  const c = (await f.service.candidates(f.db, [103]))[0];
  for (const change of [{ uom: "FT" }, { spec: "S2" }, { size_1: "3" }])
    await assert.rejects(
      f.tx((db) =>
        f.service.addMatch(db, {
          poolId: f.pool.id,
          materialId: f.mat.id,
          row: { ...c, ...change },
          userId: 100,
          reviewed: true,
        }),
      ),
      /variant|match/,
    );
  await assert.rejects(
    f.tx((db) =>
      f.service.addMatch(db, {
        poolId: f.pool.id,
        row: c,
        name: "Other",
        userId: 100,
        reviewed: false,
      }),
    ),
    /review/,
  );
  assert.equal(
    (await f.service.snapshot(f.db, f.pool.id)).stock.find(
      (r) => r.job_id === 103,
    ).material_id,
    null,
  );
});

test("reservation oversubscription, reassign, release and cross-job document validation", async (t) => {
  const f = await fixture(t);
  const r = await f.reserve(101, 40, { purpose: "Shutdown" });
  await assert.rejects(f.reserve(102, 86), /exceeds/);
  await assert.rejects(f.reserve(102, 5, { bomId: 1501 }), /BOM/);
  await f.tx((db) =>
    f.service.changeReservation(db, {
      poolId: f.pool.id,
      reservationId: r.id,
      jobId: 102,
      qty: 40,
      purpose: "Shutdown B",
      userId: 100,
    }),
  );
  const state = await f.service.snapshot(f.db, f.pool.id);
  assert.equal(Number(state.reservations[0].job_id), 102);
  await f.tx((db) =>
    f.service.changeReservation(db, {
      poolId: f.pool.id,
      reservationId: r.id,
      qty: 0,
      userId: 100,
    }),
  );
  assert.equal(
    (await f.service.snapshot(f.db, f.pool.id)).reservations.length,
    0,
  );
  assert.ok(
    (await f.db.query("select * from inventory_reservation_events")).rows
      .length >= 3,
  );
});

test("cross-job issues preserve source stock, destination usage and protect another reservation", async (t) => {
  const f = await fixture(t);
  await f.reserve(101, 100);
  const r = await f.req(102, 30, 30, "REQUESTED");
  await assert.rejects(
    f.tx(async (db) => {
      await db.query(
        "update material_requisitions set status='ACCEPTED' where id=$1",
        [r.id],
      );
      return f.service.issue(db, {
        jobId: 102,
        requisitionId: r.id,
        userId: 100,
      });
    }),
    /reserved/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int as n from shared_inventory_movements",
      )
    ).rows[0].n,
    0,
  );
  const reservation = (await f.db.query("select * from inventory_reservations"))
    .rows[0];
  await f.tx((db) =>
    f.service.changeReservation(db, {
      poolId: f.pool.id,
      reservationId: reservation.id,
      qty: 0,
      userId: 100,
    }),
  );
  await f.tx(async (db) => {
    await db.query(
      "update material_requisitions set status='ACCEPTED' where id=$1",
      [r.id],
    );
    return f.service.issue(db, {
      jobId: 102,
      requisitionId: r.id,
      userId: 100,
    });
  });
  const stock = await f.service.ownedStock(f.db, [101, 102]);
  assert.equal(
    stock.reduce((n, r) => n + r.qty_on_hand, 0),
    95,
  );
  const movement = (
    await f.db.query("select * from shared_inventory_movements")
  ).rows[0];
  assert.equal(Number(movement.source_job_id), 101);
  assert.equal(Number(movement.destination_job_id), 102);
  assert.equal(
    (await f.db.query("select job_id from receipts where id=1401")).rows[0]
      .job_id,
    101,
  );
  await assert.rejects(
    f.tx((db) =>
      f.service.issue(db, { jobId: 102, requisitionId: r.id, userId: 100 }),
    ),
    /accepted/,
  );
});

test("purpose reservation requires explicit selection; partial fulfillment and returns balance", async (t) => {
  const f = await fixture(t);
  const reservation = await f.reserve(101, 100, { purpose: "Shutdown" });
  const r = await f.req(101, 40, 30, "REQUESTED");
  await f.tx(async (db) => {
    await db.query(
      "update material_requisition_lines set inventory_reservation_id=$2 where id=$1",
      [r.line.id, reservation.id],
    );
    await db.query(
      "update material_requisitions set status='ACCEPTED' where id=$1",
      [r.id],
    );
  });
  await assert.rejects(
    f.tx((db) =>
      f.service.issue(db, {
        jobId: 101,
        requisitionId: r.id,
        userId: 100,
        reservationIds: { [r.line.id]: "" },
      }),
    ),
    /reserved/,
  );
  await f.tx((db) =>
    f.service.issue(db, {
      jobId: 101,
      requisitionId: r.id,
      userId: 100,
      reservationIds: { [r.line.id]: reservation.id },
    }),
  );
  const s = await f.service.snapshot(f.db, f.pool.id);
  assert.equal(Number(s.reservations[0].qty_remaining), 70);
  assert.equal(
    s.stock.reduce((n, r) => n + r.qty_on_hand, 0),
    95,
  );
  const m = (
    await f.db.query("select * from shared_inventory_movements order by id")
  ).rows[0];
  await f.tx((db) =>
    f.service.returnStock(db, {
      poolId: f.pool.id,
      movementId: m.id,
      qty: 10,
      userId: 100,
      reason: "Unused",
    }),
  );
  const after = await f.service.snapshot(f.db, f.pool.id);
  assert.equal(
    after.stock.reduce((n, r) => n + r.qty_on_hand, 0),
    105,
  );
  assert.equal(Number(after.reservations[0].qty_remaining), 70);
  assert.equal(
    Number(
      (
        await f.db.query(
          "select qty_issued from material_requisition_lines where id=$1",
          [r.line.id],
        )
      ).rows[0].qty_issued,
    ),
    20,
  );
  await assert.rejects(
    f.tx((db) =>
      f.service.returnStock(db, {
        poolId: f.pool.id,
        movementId: m.id,
        qty: 21,
        userId: 100,
        reason: "Too much",
      }),
    ),
    /exceeds/,
  );
});

test("accepted requisitions hold stock across jobs without double-counting explicit reservations", async (t) => {
  const f = await fixture(t);
  const r = await f.req(101, 40);
  const s = await f.service.snapshot(f.db, f.pool.id);
  assert.equal(
    s.reservations.reduce((n, r) => n + Number(r.qty_remaining), 0),
    40,
  );
  const other = await f.service.availableForJob(f.db, 102);
  assert.equal(other[0].qty_available, 85);
  await f.reserve(101, 40, { requisitionId: r.id });
  const after = await f.service.snapshot(f.db, f.pool.id);
  assert.equal(
    after.reservations.reduce((n, r) => n + Number(r.qty_remaining), 0),
    40,
  );
  await f.tx((db) =>
    f.service.issue(db, { jobId: 101, requisitionId: r.id, userId: 100 }),
  );
  assert.equal(
    (await f.service.snapshot(f.db, f.pool.id)).reservations.length,
    0,
  );
});

test("legacy receipt reductions cannot consume reserved stock; failed transactions roll back", async (t) => {
  const f = await fixture(t);
  await f.reserve(101, 100);
  await assert.rejects(
    f.tx(async (db) => {
      await db.query("update receipts set qty_received=0 where id=1401");
    }),
    /reserved material/,
  );
  assert.equal(
    Number(
      (await f.db.query("select qty_received from receipts where id=1401"))
        .rows[0].qty_received,
    ),
    100,
  );
});

test("membership removal blocks stock, active reservations and outstanding issues; empty jobs can leave", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.tx((db) =>
      f.service.removeJob(db, { poolId: f.pool.id, jobId: 101, userId: 100 }),
    ),
    /stock allocation/,
  );
  await f.db.query("insert into jobs(id,job_number) values(105,'Empty')");
  await f.tx((db) =>
    f.service.addJob(db, {
      poolId: f.pool.id,
      jobId: 105,
      userId: 100,
      reviewed: true,
    }),
  );
  await f.tx((db) =>
    f.service.removeJob(db, { poolId: f.pool.id, jobId: 105, userId: 100 }),
  );
  assert.equal(await f.service.membership(f.db, 105), null);
});

function routeHarness(f) {
  const routes = new Map();
  const middle = () => {};
  const handlers = registerSharedInventoryRoutes(
    {
      get: (url, ...h) => routes.set("GET " + url, h.at(-1)),
      post: (url, ...h) => routes.set("POST " + url, h.at(-1)),
    },
    {
      query: f.db.query.bind(f.db),
      withTransaction: f.tx,
      sharedInventory: f.service,
      requireAuth: middle,
      requireJobContext: middle,
      requirePermission: () => middle,
      asyncHandler: (fn) => fn,
      layout: (_title, html) => html,
      esc: (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll('"', "&quot;"),
      canAccess: () => true,
      currentJobId: () => 101,
      XLSX,
      recomputeBomIssuedSummaries: async () => {},
      rebuildUnallocatedBom: async () => {},
    },
  );
  return { routes, handlers };
}
test("multi-job reports and Excel count shared stock once and protect unselected jobs", async (t) => {
  const f = await fixture(t);
  await f.reserve(102, 40);
  const { routes, handlers } = routeHarness(f);
  const req = {
    query: { job_ids: ["101", "102", "103"] },
    user: { id: 100, accessibleJobs: f.jobs },
    body: {},
  };
  const data = await handlers.reportData(f.db, req);
  const shared = data.rows.find((r) => r.pool_id);
  assert.equal(shared.on_hand, 125);
  assert.equal(shared.required, 120);
  assert.equal(shared.reserved_total, 40);
  assert.equal(shared.available, 125);
  assert.equal(data.rows.find((r) => r.item_code === "PIPE-C").on_hand, 60);
  assert.equal(data.rows.find((r) => r.item_code === "PIPE-C").to_purchase, 40);
  const one = await handlers.reportData(f.db, {
    ...req,
    query: { job_ids: ["101"] },
  });
  assert.equal(one.rows[0].on_hand, 125);
  assert.equal(one.rows[0].available, 85);
  const out = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    send(value) {
      this.body = value;
    },
  };
  await routes.get("GET /inventory/multi-job/export.xlsx")(req, out);
  const workbook = XLSX.read(out.body, { type: "buffer" });
  const row = XLSX.utils
    .sheet_to_json(workbook.Sheets.Combined)
    .find((r) => r["Stock Scope"].startsWith("Shared:"));
  assert.equal(row["On Hand"], shared.on_hand);
  assert.equal(row["Available to Selection"], shared.available);
  assert.equal(row.Required, shared.required);
  await assert.rejects(
    handlers.reportData(f.db, {
      ...req,
      user: { accessibleJobs: [{ id: 101 }] },
      query: { job_ids: ["102"] },
    }),
    /access/,
  );
  const response = {
    send(value) {
      this.html = value;
    },
  };
  await routes.get("GET /inventory/multi-job")(req, response);
  assert.match(response.html, /A Required/);
  assert.match(response.html, /B Required/);
  assert.match(response.html, /On Hand \(Once\)/);
});

test("several pools and independent jobs stay distinct, including identical item codes", async (t) => {
  const f = await fixture(t);
  const other = await f.tx((db) =>
    f.service.createPool(db, {
      name: "Second Yard",
      jobIds: [103, 104],
      userId: 100,
      reviewed: true,
    }),
  );
  for (const id of [103, 104]) {
    const c = (await f.service.candidates(f.db, [id]))[0];
    const material = (
      await f.db.query(
        "select id from inventory_pool_materials where pool_id=$1",
        [other.id],
      )
    ).rows[0];
    await f.tx((db) =>
      f.service.addMatch(db, {
        poolId: other.id,
        materialId: material?.id,
        row: c,
        name: "Second Pipe",
        userId: 100,
        reviewed: true,
      }),
    );
  }
  const data = await routeHarness(f).handlers.reportData(f.db, {
    query: { job_ids: ["101", "102", "103", "104"] },
    user: { accessibleJobs: f.jobs },
  });
  assert.deepEqual(
    data.rows.map((r) => r.on_hand).sort((a, b) => a - b),
    [70, 125],
  );
  assert.equal(data.rows.length, 2);
  const same = { item_code: "SAME", uom: "EA", spec: "S1", size_1: "2" };
  const rows = buildMultiJobReport({
    jobs: [{ id: 1 }, { id: 2 }],
    stock: [
      { ...same, job_id: 1, qty_on_hand: 5 },
      { ...same, job_id: 2, qty_on_hand: 7 },
    ],
    demand: [],
    matches: [],
    reservations: [],
    memberships: [],
  });
  assert.equal(rows.length, 2);
});

test("queued simultaneous reservations and issues cannot allocate the same stock twice", async (t) => {
  const f = await fixture(t);
  const reservations = await Promise.allSettled([
    f.reserve(101, 80),
    f.reserve(102, 80),
  ]);
  assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
  const r = (
    await f.db.query(
      "select * from inventory_reservations where qty_remaining>0",
    )
  ).rows[0];
  await f.tx((db) =>
    f.service.changeReservation(db, {
      poolId: f.pool.id,
      reservationId: r.id,
      qty: 0,
      userId: 100,
    }),
  );
  const a = await f.req(101, 80, 80, "REQUESTED"),
    b = await f.req(102, 80, 80, "REQUESTED");
  const issues = await Promise.allSettled(
    [a, b].map((req) =>
      f.tx(async (db) => {
        await f.service.lock(db);
        await db.query(
          "update material_requisitions set status='ACCEPTED' where id=$1",
          [req.id],
        );
        return f.service.issue(db, {
          jobId: req.job_id,
          requisitionId: req.id,
          userId: 100,
        });
      }),
    ),
  );
  assert.equal(issues.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await f.service.ownedStock(f.db, [101, 102])).reduce(
      (n, r) => n + r.qty_on_hand,
      0,
    ),
    45,
  );
  assert.equal(
    Number(
      (
        await f.db.query(
          "select sum(qty_issued) as qty from shared_inventory_movements",
        )
      ).rows[0].qty,
    ),
    80,
  );
});

test("unmatched stock stays with its receiving job and shared cancellation restores stock", async (t) => {
  const f = await fixture(t);
  await f.tx((db) =>
    f.service.addJob(db, {
      poolId: f.pool.id,
      jobId: 103,
      userId: 100,
      reviewed: true,
    }),
  );
  const r = await f.req(103, 50);
  await f.tx((db) =>
    f.service.issue(db, { jobId: 103, requisitionId: r.id, userId: 100 }),
  );
  assert.equal(
    (await f.service.ownedStock(f.db, [103])).reduce(
      (n, r) => n + r.qty_on_hand,
      0,
    ),
    10,
  );
  assert.equal(
    (await f.service.ownedStock(f.db, [101, 102])).reduce(
      (n, r) => n + r.qty_on_hand,
      0,
    ),
    125,
  );
  await f.tx(async (db) => {
    await f.service.cancelIssues(db, r.id, 100);
    await db.query(
      "update material_requisitions set status='CANCELLED' where id=$1",
      [r.id],
    );
    await db.query(
      "delete from material_issue_transactions where requisition_id=$1",
      [r.id],
    );
    await db.query(
      "update material_requisition_lines set qty_issued=0 where requisition_id=$1",
      [r.id],
    );
  });
  assert.equal(
    (await f.service.ownedStock(f.db, [103])).reduce(
      (n, r) => n + r.qty_on_hand,
      0,
    ),
    60,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int as n from shared_inventory_movements where requisition_id=$1",
        [r.id],
      )
    ).rows[0].n,
    1,
  );
});

test("accepted holds also prevent legacy receipt reductions below committed stock", async (t) => {
  const f = await fixture(t);
  await f.req(101, 100);
  await assert.rejects(
    f.tx(async (db) => {
      await db.query("update receipts set qty_received=0 where id=1401");
    }),
    /accepted requisition holds/,
  );
  assert.equal(
    Number(
      (await f.db.query("select qty_received from receipts where id=1401"))
        .rows[0].qty_received,
    ),
    100,
  );
});

test("stock review totals remain visible when the same variant has demand and several locations", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(101,1301,10,'Yard','BIN-2','OK')",
  );
  const c = (await f.service.candidates(f.db, [101])).find(
    (r) => r.item_code === "PIPE-A",
  );
  assert.equal(c.qty_on_hand, 110);
  assert.equal(c.locations.length, 2);
  assert.equal(c.spec, "S1");
});

test("actual accept and quantity-issue handlers carry a chosen purpose reservation through issue", async (t) => {
  const f = await fixture(t);
  const source = fs.readFileSync(
    new URL("../src/server.js", import.meta.url),
    "utf8",
  );
  const routes = new Map();
  const context = {
    app: { post: (url, ...h) => routes.set(url, h.at(-1)) },
    requireAuth() {},
    requireJobContext() {},
    requirePermission() {},
    asyncHandler: (fn) => fn,
    currentJobId: (req) => Number(req.user.job_id),
    withTransaction: f.tx,
    sharedInventory: f.service,
    ownedKey,
    parseQtyValue: (value, fallback = 0) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    requisitionStatusKey: (s) => s,
    isVerifiedStageRequisitionStatus: (s) =>
      ["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(s),
    auditLog: async () => {},
    recomputeBomIssuedSummaries: async (db, jobId) => {
      await db.query(
        "update bom_lines bl set qty_issued=coalesce((select sum(mit.qty_issued) from material_issue_transactions mit where mit.source_bom_line_id=bl.id),0) from bom_headers bh where bh.id=bl.bom_id and bh.job_id=$1",
        [jobId],
      );
    },
    rebuildUnallocatedBom: async () => {},
  };
  vm.createContext(context);
  const shortageStart = source.indexOf(
    "async function getRequisitionMaterialShortages(",
  );
  const shortageEnd = source.indexOf(
    "\nfunction deriveBomPlanningStatus",
    shortageStart,
  );
  vm.runInContext(source.slice(shortageStart, shortageEnd), context);
  const issueStart = source.indexOf("async function issueRequisitionToField(");
  const issueEnd = source.indexOf(
    '\napp.post("/requisitions/:id/issue"',
    issueStart,
  );
  vm.runInContext(source.slice(issueStart, issueEnd), context);
  for (const name of [
    "/requisitions/:id/verify",
    "/requisitions/:id/issued-qty",
  ]) {
    const start = source.indexOf('app.post("' + name + '"');
    const end = source.indexOf("\napp.", start + 1);
    vm.runInContext(source.slice(start, end), context);
  }
  const reservation = await f.reserve(101, 100, { purpose: "Shutdown" });
  const r = await f.req(101, 40, 0, "REQUESTED");
  const response = {
    redirect(url) {
      this.url = url;
    },
  };
  const req = {
    user: { id: 100, job_id: 101 },
    params: { id: r.id },
    body: { ["reservation_id_" + r.line.id]: String(reservation.id) },
  };
  await routes.get("/requisitions/:id/verify")(req, response);
  assert.equal(
    (
      await f.db.query("select status from material_requisitions where id=$1", [
        r.id,
      ])
    ).rows[0].status,
    "ACCEPTED",
  );
  assert.equal(
    Number(
      (
        await f.db.query(
          "select inventory_reservation_id from material_requisition_lines where id=$1",
          [r.line.id],
        )
      ).rows[0].inventory_reservation_id,
    ),
    Number(reservation.id),
  );
  req.body = {
    ["qty_issued_" + r.line.id]: "15",
    ["reservation_id_" + r.line.id]: String(reservation.id),
    next_action: "issue",
  };
  await routes.get("/requisitions/:id/issued-qty")(req, response);
  assert.equal(
    (
      await f.db.query("select status from material_requisitions where id=$1", [
        r.id,
      ])
    ).rows[0].status,
    "ISSUED",
  );
  assert.equal(
    Number(
      (await f.db.query("select qty_issued from bom_lines where id=1601"))
        .rows[0].qty_issued,
    ),
    15,
  );
  assert.equal(
    Number(
      (
        await f.db.query(
          "select qty_remaining from inventory_reservations where id=$1",
          [reservation.id],
        )
      ).rows[0].qty_remaining,
    ),
    85,
  );
  assert.equal(
    (await f.service.ownedStock(f.db, [101, 102])).reduce(
      (n, r) => n + r.qty_on_hand,
      0,
    ),
    110,
  );
});

test("pool stock screens render review, reservation and return controls without exposing inaccessible job documents", async (t) => {
  const f = await fixture(t);
  const { routes } = routeHarness(f);
  const response = {
    send(html) {
      this.html = html;
    },
  };
  await routes.get("GET /inventory/pools/" + ":id")(
    {
      params: { id: f.pool.id },
      query: {},
      user: { id: 100, accessibleJobs: f.jobs },
    },
    response,
  );
  assert.match(response.html, /Match a Material/);
  assert.match(response.html, /Shared Stock Locations/);
  assert.match(response.html, /Reserve Material/);
  const limited = {
    send(html) {
      this.html = html;
    },
  };
  await routes.get("GET /inventory/pools/:id")(
    {
      params: { id: f.pool.id },
      query: {},
      user: {
        id: 100,
        accessibleJobs: f.jobs.filter((j) => Number(j.id) === 101),
      },
    },
    limited,
  );
  assert.match(limited.html, /Other member job/);
  assert.doesNotMatch(limited.html, /Match a Material/);
  assert.doesNotMatch(limited.html, /Reserve Material/);
});

test("generated pooled inventory BOM keeps specifications and dimensions and selected BOM filters export consistently", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into bom_headers(id,job_id,job_number,bom_no,bom_type,system_key,is_system_generated) values(1701,101,'A','UNALLOC-A','misc','UNALLOCATED',true)",
  );
  await f.tx((db) => f.service.rebuildUnallocated(db, 101, 1701));
  const lines = (await f.db.query("select * from bom_lines where bom_id=1701"))
    .rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].spec, "S1");
  assert.equal(lines[0].size_1, "2");
  assert.equal(Number(lines[0].qty_required), 55);
  const { handlers } = routeHarness(f);
  const req = {
    query: { job_ids: ["101"], source_bom_id: "1501" },
    user: { accessibleJobs: f.jobs },
  };
  const data = await handlers.reportData(f.db, req);
  assert.equal(data.rows[0].required, 70);
  assert.equal(data.rows[0].on_hand, 125);
  assert.equal(
    data.stock.reduce((n, r) => n + r.qty_on_hand, 0),
    125,
  );
  await assert.rejects(
    handlers.reportData(f.db, {
      ...req,
      query: { job_ids: ["101"], source_bom_id: "1502" },
    }),
    /BOM/,
  );
});

test("full Express app serves shared inventory and issues through authenticated HTTP against an isolated database", async (t) => {
  const f = await fixture(t);
  const bcrypt = (await import("bcryptjs")).default;
  const { pathToFileURL } = await import("node:url");
  const root = new URL("../src/", import.meta.url);
  const stubPath = new URL(".shared-test-db-" + process.pid + ".mjs", root);
  const serverPath = new URL(
    ".shared-test-server-" + process.pid + ".mjs",
    root,
  );
  const oldVercel = process.env.VERCEL;
  process.env.VERCEL = "1";
  globalThis.__sharedInventoryHttpTestDb = f.db;
  await f.db.query("update users set password_hash=$1 where id=100", [
    await bcrypt.hash("inventory-test-password", 4),
  ]);
  fs.writeFileSync(
    stubPath,
    `
    const db=globalThis.__sharedInventoryHttpTestDb;
    export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};
    export const pool={query};
    export const initDb=async()=>{};
    export const withTransaction=(fn)=>db.transaction(fn);
    export const auditLog=async(db,user,action,type,id,details)=>db.query("insert into audit_log(user_id,action,entity_type,entity_id,details) values ($1,$2,$3,$4,$5)",[user,action,type,String(id||""),details]);
    export let vendorCategories=["pipe"];
    export let permissionMatrix={};
    export const setVendorCategories=(value)=>{vendorCategories=value;};
    export const setPermissionMatrix=(value)=>{permissionMatrix=value;};
  `,
  );
  const source = fs
    .readFileSync(new URL("server.js", root), "utf8")
    .replace('from "./db.js";', "from " + JSON.stringify(stubPath.href) + ";");
  fs.writeFileSync(serverPath, source);
  let listener;
  t.after(async () => {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(stubPath, { force: true });
    fs.rmSync(serverPath, { force: true });
    if (oldVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = oldVercel;
    delete globalThis.__sharedInventoryHttpTestDb;
  });
  const app = (await import(serverPath.href)).default;
  listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = "http://127.0.0.1:" + listener.address().port;
  let cookie = "";
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
    });
    for (const header of response.headers.getSetCookie())
      if (header.startsWith("session_token=")) cookie = header.split(";")[0];
    return response;
  };
  const login = await request("/login", {
    username: "tester",
    password: "inventory-test-password",
  });
  assert.equal(login.status, 302);
  assert.ok(cookie);
  const select = await request("/jobs/select", { job_id: "101" });
  assert.equal(select.status, 302);
  const pool = await request("/inventory/pools/" + f.pool.id);
  assert.equal(pool.status, 200);
  assert.match(await pool.text(), /Shared Stock Locations/);
  const report = await request(
    "/inventory/multi-job?job_ids=101&job_ids=102&job_ids=103",
  );
  assert.equal(report.status, 200);
  assert.match(await report.text(), /A Required/);
  const reservation = await f.reserve(101, 100, { purpose: "Shutdown" });
  const r = await f.req(101, 40, 0, "REQUESTED");
  const detail = await request("/requisitions/" + r.id);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Reservation \/ purpose/);
  const accepted = await request("/requisitions/" + r.id + "/verify", {
    ["reservation_id_" + r.line.id]: String(reservation.id),
  });
  assert.equal(accepted.status, 302);
  const ticket = await request("/requisitions/" + r.id + "/pick-ticket.pdf");
  assert.equal(ticket.status, 200);
  assert.equal(
    Buffer.from(await ticket.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  const bomLines = await request("/bom/1501/lines");
  assert.equal(bomLines.status, 200);
  assert.match(await bomLines.text(), /<td>125<\/td>/);
  const builder = await request("/requisitions/new?bom_id=1501");
  assert.equal(builder.status, 200);
  assert.match(await builder.text(), /Pool On Hand/);
  const acceptedDetail = await request("/requisitions/" + r.id);
  assert.equal(acceptedDetail.status, 200);
  assert.match(
    await acceptedDetail.text(),
    new RegExp('value="' + reservation.id + '" selected'),
  );
  const issued = await request("/requisitions/" + r.id + "/issued-qty", {
    ["qty_issued_" + r.line.id]: "15",
    ["reservation_id_" + r.line.id]: String(reservation.id),
    next_action: "issue",
  });
  assert.equal(issued.status, 302);
  assert.equal(
    (
      await f.db.query("select status from material_requisitions where id=$1", [
        r.id,
      ])
    ).rows[0].status,
    "ISSUED",
  );
  assert.equal(
    Number(
      (await f.db.query("select qty_issued from bom_lines where id=1601"))
        .rows[0].qty_issued,
    ),
    15,
  );
  const audit = await request("/inventory-audit/new?warehouse_filter=Yard");
  assert.equal(audit.status, 200);
  const exported = await request(
    "/inventory/export.xlsx?job_ids=101&job_ids=102",
  );
  assert.equal(exported.status, 200);
  const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()), {
    type: "buffer",
  });
  assert.equal(
    XLSX.utils.sheet_to_json(workbook.Sheets.Combined)[0]["On Hand"],
    110,
  );
  const received = await request("/inventory");
  assert.equal(received.status, 302);
  assert.equal(
    received.headers.get("location"),
    "/inventory/pools/" + f.pool.id,
  );
});
