# Material Control Node/Postgres Port

This workspace now includes a Node.js + Postgres port of the material control app.

## New stack

- Node.js
- Express
- PostgreSQL
- Server-rendered HTML

## Files

- `package.json`
- `src/server.js`
- `src/db.js`
- `src/init-db.js`
- `db/schema.sql`
- `.env.example`

## Setup

1. Install Node.js 20+ and PostgreSQL.
2. Create a database, for example `material_control`.
3. Copy `.env.example` to `.env` and update `DATABASE_URL`.
4. Install packages:

```powershell
npm install
```

5. Initialize the database:

```powershell
npm run db:init
```

6. If you want to migrate your current SQLite data from `app.db` into Postgres:

```powershell
npm run db:migrate-sqlite
```

7. Start the app:

```powershell
npm run dev
```

Open:

- `http://127.0.0.1:3000`

## Default login

- Username: `admin`
- Password: `admin123`

## Included workflows

- Login / logout
- Vendors with categories
- RFQ creation
- RFQ item CSV/XLSX import
- Vendor quote CSV/XLSX import
- RFQ quote comparison by vendor
- PO issuance from RFQ quotes
- PO filtering, editing, deletion
- PO line editing
- Receiving with sticky PO filter
- Inventory by warehouse/location
- Audit log writes on key changes
- Role-based permissions
- Optimistic locking for RFQ item / PO / PO line edits

## SQLite migration

`npm run db:migrate-sqlite` reads the legacy `app.db` file and migrates:

- users
- audit log
- vendors
- material items
- RFQs
- RFQ items
- quotes
- purchase orders
- PO lines
- receipts

## Vercel deployment

This repo is prepared for Vercel with:

- `api/index.js`
- `vercel.json`

To deploy without installing Postgres locally:

1. Create a hosted Postgres database in Neon or Supabase.
2. Copy its connection string into Vercel as `DATABASE_URL`.
3. Add these Vercel environment variables:

```text
DATABASE_URL=postgresql://neondb_owner:npg_91WTLxPMFAyt@ep-falling-thunder-a89uohj4-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require
SESSION_SECRET=change-me
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=admin123
PORT=3000
```

4. Import this project into Vercel.
5. Deploy.

After the first deploy, run the database bootstrap once from a machine with Node.js:

```powershell
npm install
npm run db:init
npm run db:migrate-sqlite
```

The app will then run on Vercel against Neon or Supabase Postgres.

## Legacy app

The old Python/SQLite app is still present as `app.py` and `app.db` for reference during the cutover.

## Selected-job shared inventory

Open **Yard → Inventory Pools**, create a named pool, select its member jobs, and review their existing stock. Jobs stay independent until explicitly linked; report selection never links jobs. Each job can belong to one pool.

Use **Match a Material** to link an existing job variant to a shared material. Review its specification, unit, sizes, and thicknesses first. Equivalent item codes in different jobs are not matched automatically. Unmatched stock remains usable only by its receiving job. Ambiguous master specifications must be resolved before matching.

Admins and material controllers can manage pools by default. To designate other inventory staff, enable **Inventory Pools → Edit** in **Settings → Job Setup → permissions**. Managing a pool also requires access to all its member jobs.

Reserve quantities for a destination job and optionally a purpose, BOM ID, or requisition ID. Acceptance of a requisition continues to hold stock. Choose a purpose reservation when accepting or issuing the requisition; another job or purpose cannot consume that stock until its reservation is released or reassigned. Partial issues reduce the reservation balance. Return unused shared material from **Outstanding Shared Issues**; returns restore unreserved stock and update destination-job issue totals.

Receipts, purchase orders, and MRRs retain their original job. Shared issue history records both the source and destination jobs. Removing a job requires resolving its stock, reservations, and outstanding shared issues.

Open **Yard → Multi-job Needs & Stock** to select any accessible jobs, including jobs in different pools and independent jobs. The report shows job needs side by side, counts shared stock once per pool/material, and protects reservations for unselected pool members. Its Excel export includes combined balances, job needs, and relevant stock locations. Requirements are combined only for explicitly matched variants with compatible units.

### Migration and tests

Migration `048_shared_inventory.sql` is applied by the normal database initialization on startup (or `npm run db:init`). It adds pool, matching, reservation, movement, and audit records without enrolling any jobs or moving existing receipts. Stock changes use a transaction lock and deferred balance checks, including receipt reversals, inventory audits, and accepted requisition holds.

Run `npm test` after installing development dependencies. Shared-inventory tests use an isolated PGlite PostgreSQL database, apply the full migration sequence, and never connect to the configured live database.
