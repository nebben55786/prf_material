export function createMaterialWorkflow(query) {
  const forbidden = (message) => {
    const error = new Error(message);
    error.statusCode = 403;
    throw error;
  };
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  async function scope(user) {
    const current = Number(user.job_id);
    const members = (
      await query(
        `select p.id, p.name, pj.job_id from inventory_pool_jobs own join inventory_pools p on p.id=own.pool_id join inventory_pool_jobs pj on pj.pool_id=p.id where own.job_id=$1`,
        [current],
      )
    ).rows;
    const ids = new Set(members.map((r) => Number(r.job_id)));
    const jobs = (user.accessibleJobs || []).filter((j) =>
      ids.size ? ids.has(Number(j.id)) : Number(j.id) === current,
    );
    return { id: members[0]?.id || null, name: members[0]?.name || "", jobs };
  }
  const documents = [
    [/^\/rfq\/(\d+)(?:\/|$)/, "rfqs"],
    [/^\/rfq-item\/(\d+)(?:\/|$)/, "rfq_items"],
    [/^\/po\/(\d+)(?:\/|$)/, "purchase_orders"],
    [/^\/po-line\/(\d+)(?:\/|$)/, "po_lines"],
    [/^\/requisitions\/(\d+)(?:\/|$)/, "material_requisitions"],
    [/^\/bom\/(\d+)(?:\/|$)/, "bom_headers"],
    [/^\/material-logs\/mrr\/(\d+)(?:\/|$)/, "mrr_logs"],
    [/^\/receive\/(\d+)(?:\/|$)/, "mrr_logs"],
    [/^\/imports\/(\d+)(?:\/|$)/, "import_batches"],
    [/^\/material-logs\/fmr\/(\d+)(?:\/|$)/, "fmr_logs"],
    [/^\/material-logs\/receiving\/(\d+)(?:\/|$)/, "material_receiving_logs"],
  ];
  async function prepare(req) {
    const group = await scope(req.user);
    req.materialWorkflow = group;
    req.user.materialWorkflow = group;
    let target = req.body?.workflow_job_id ?? req.query?.workflow_job_id;
    for (const [pattern, table] of documents) {
      const match = req.path.match(pattern);
      if (!match) continue;
      const row = (
        await query(`select job_id from ${table} where id=$1`, [match[1]])
      ).rows[0];
      if (row) {
        if (target && Number(target) !== Number(row.job_id))
          invalid("The document job cannot be changed.");
        target = row.job_id;
      }
      break;
    }
    if (req.path === "/po/create" && req.body?.rfq_id) {
      const row = (
        await query("select job_id from rfqs where id=$1", [req.body.rfq_id])
      ).rows[0];
      if (row) target = row.job_id;
    }
    if (req.path === "/material-logs/mrr/add" && req.body?.app_po_id) {
      const row = (
        await query("select job_id from purchase_orders where id=$1", [
          req.body.app_po_id,
        ])
      ).rows[0];
      if (row) {
        if (target && Number(target) !== Number(row.job_id))
          invalid("Receiving job must match the ordering PO.");
        target = row.job_id;
      }
    }
    if (target !== undefined && target !== null && target !== "") {
      const job = group.jobs.find((j) => Number(j.id) === Number(target));
      if (!job)
        forbidden("That job is outside your authorized material system.");
      req.user = { ...req.user, job_id: Number(job.id), activeJob: job };
    }
  }
  function jobIds(req) {
    const jobs = req.materialWorkflow?.jobs ||
      req.user.materialWorkflow?.jobs || [req.user.activeJob];
    const selected = req.query?.workflow_job_id;
    return jobs
      .filter(Boolean)
      .filter((j) => !selected || Number(j.id) === Number(selected))
      .map((j) => Number(j.id));
  }
  return { scope, prepare, jobIds };
}
