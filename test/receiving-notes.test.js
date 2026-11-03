import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { mrrReceivingNotesSql } from "../src/receiving-notes.js";

test("legacy MRR notes move to receiving lines without losing line notes or crossing jobs", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create table mrr_logs(id bigint primary key, job_id bigint, mrr_number text, notes text, updated_at timestamptz);
    create table receipts(id bigint primary key, job_id bigint, mrr_log_id bigint, osd_notes text);
    create table material_receiving_logs(id bigint primary key, job_id bigint, mrr_number text, comments text);
    insert into mrr_logs values(1,101,'MRR-1','GRR-00144',now()),(2,102,'MRR-1','OTHER-JOB',now()),(3,101,'MRR-3','PENDING-GRR',now());
    insert into receipts values(1,101,1,''),(2,101,1,'Line detail'),(3,101,1,'GRR-00144'),(4,102,2,'');
    insert into material_receiving_logs values(1,101,'MRR-1','Manual detail'),(2,102,'MRR-1','Other manual');
  `);
  await db.exec(fs.readFileSync(new URL('../db/migrations/053_receiving_line_notes.sql', import.meta.url),'utf8'));
  const rows = (await db.query('select id, osd_notes from receipts order by id')).rows;
  assert.deepEqual(rows.map(row => row.osd_notes), ['GRR-00144','Line detail | GRR-00144','GRR-00144','OTHER-JOB']);
  assert.equal((await db.query('select comments from material_receiving_logs where id=1')).rows[0].comments,'Manual detail | GRR-00144');
  assert.equal((await db.query('select notes from mrr_logs where id=1')).rows[0].notes,'');
  await db.exec('select move_mrr_notes_to_receiving_lines(1,101)');
  assert.deepEqual((await db.query('select id, osd_notes from receipts order by id')).rows,rows);
  const summary = (await db.query(`select ${mrrReceivingNotesSql('m')} as notes from mrr_logs m where id=1`)).rows[0].notes;
  assert.ok(summary.includes('Line detail') && summary.includes('Manual detail') && !summary.includes('OTHER-JOB'));
  // A header-only legacy import keeps its notes until the first receiving line exists.
  assert.equal((await db.query('select notes from mrr_logs where id=3')).rows[0].notes,'PENDING-GRR');
  await db.exec("insert into receipts values(5,101,3,'First line')");
  assert.equal((await db.query('select osd_notes from receipts where id=5')).rows[0].osd_notes,'First line | PENDING-GRR');
  assert.equal((await db.query('select notes from mrr_logs where id=3')).rows[0].notes,'');
  await db.exec("insert into receipts values(6,101,3,'Second line')");
  assert.equal((await db.query('select osd_notes from receipts where id=6')).rows[0].osd_notes,'Second line');
  // Legacy MRR and manual receiving imports work in either order.
  await db.exec("insert into material_receiving_logs values(3,101,'MRR-4','Existing manual'); insert into mrr_logs values(4,101,'MRR-4','Imported GRR',now()); insert into mrr_logs values(5,101,'MRR-5','Manual pending',now()); insert into material_receiving_logs values(4,101,'MRR-5','New manual');");
  assert.equal((await db.query('select comments from material_receiving_logs where id=3')).rows[0].comments,'Existing manual | Imported GRR');
  assert.equal((await db.query('select comments from material_receiving_logs where id=4')).rows[0].comments,'New manual | Manual pending');
});
