import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
function helper(name, next) {
  return source.slice(source.indexOf("async function " + name + "("), source.indexOf("async function " + next + "("));
}
function route(path, next) {
  return source.slice(source.indexOf('app.post("' + path + '"'), source.indexOf(next, source.indexOf('app.post("' + path + '"') + 1));
}
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create table material_items(id serial primary key, job_id bigint, item_code text, description text, material_type text, uom text);
    create table rfqs(id serial primary key, job_id bigint, project_name text, po_number text);
    create table rfq_items(id serial primary key, job_id bigint, rfq_id bigint, material_item_id bigint,
      item_code_snapshot text, description_snapshot text, material_type_snapshot text, uom_snapshot text,
      po_line text, spec text, commodity_code text, tag_number text, size_1 text, size_2 text, thk_1 text, thk_2 text,
      qty numeric, notes text, updated_at timestamptz, award_status text, awarded_vendor_id bigint,
      awarded_unit_price numeric, awarded_lead_days int);
    create table purchase_orders(id serial primary key, job_id bigint, po_no text, vendor_id bigint, rfq_id bigint,
      description text, status text, updated_at timestamptz, vendor_contact text, freight_terms text, ship_to text,
      bill_to text, notes text, buyer_name text);
    create table po_lines(id serial primary key, job_id bigint, po_id bigint, rfq_item_id bigint, material_item_id bigint,
      item_code_snapshot text, description_snapshot text, material_type_snapshot text, uom_snapshot text, po_line text,
      size_1 text, size_2 text, thk_1 text, thk_2 text, qty_ordered numeric, unit_price numeric, lead_days int, updated_at timestamptz);
    create table rfq_vendors(rfq_id bigint, job_id bigint, vendor_id bigint);
    create table quotes(id serial primary key, job_id bigint, rfq_item_id bigint, vendor_id bigint,
      unit_price numeric, lead_days int, quoted_at timestamptz, unique(rfq_item_id, vendor_id));
    insert into material_items values(7,3,'STRAINER','12 inch Y Strainer','pipe','EA');
    insert into rfqs values(22,3,'Strainers',null);
    insert into rfq_vendors values(22,3,8);
  `);
  const item = {id:7, item_code:'STRAINER', description:'12 inch Y Strainer', material_type:'pipe', uom:'EA'};
  const errors = [];
  const handlers = new Map();
  const scope = vm.createContext({
    app:{post:(path,...args)=>handlers.set(path,args.at(-1))},
    requireAuth(){}, requireJobContext(){}, requirePermission(){}, asyncHandler:fn=>fn,
    upload:{single:()=>()=>{}}, currentJobId:()=>3,
    num:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,
    parseQtyValue:Number, normalizeSpecName:value=>String(value||''),
    ensureRfqMaterialItem:async(client,row)=>row,
    getMaterialItemForUse:async()=>({item}), getMaterialItemSpecsText:async()=>'',
    materialItemSnapshotParams:value=>[value.item_code,value.description,value.material_type,value.uom],
    getNextRfqLineNumber:async(client,id)=>String(Number((await client.query("select coalesce(max(po_line::int),0) as n from rfq_items where rfq_id=$1",[id])).rows[0].n)+1),
    findCanonicalPurchaseOrderByNumber:async(client,jobId,poNo)=>(await client.query("select * from purchase_orders where job_id=$1 and po_no=$2",[jobId,poNo])).rows[0],
    findOrCreateVendorByName:async()=>8,
    withTransaction:fn=>db.transaction(fn), auditLog:async()=>{}, refreshRfqEtaFromPos:async()=>{},
    recalcPoStatus:async()=>{}, recalcRfqStatus:async()=>{}, getSafeReturnPath:()=>'/po',
    parseUploadedRows:()=>scope.importRows, backfillRfqVendors:async()=>{}, createImportBatch:async()=>1,
    addImportBatchError:async(client,batch,row,code,message)=>errors.push({code,message}),
    updateImportBatch:async()=>{}, writeQuoteRevision:async()=>{}
  });
  vm.runInContext(helper('findExistingPoLine','getRfqIdsForPo'),scope);
  vm.runInContext(helper('upsertRfqItemRow','upsertPurchaseOrderRow'),scope);
  vm.runInContext(helper('upsertPurchaseOrderRow','upsertPurchaseOrderHeaderRow'),scope);
  vm.runInContext(helper('upsertPurchaseOrderLineRow','writeQuoteRevision'),scope);
  vm.runInContext(route('/po/create','app.get("/rfq-item/:id/award"'),scope);
  vm.runInContext(route('/rfq/:id/quotes/import','app.get("/imports/:id"'),scope);
  return {db,scope,handlers,errors};
}

test('three identical RFQ item codes retain separate quantities and prices through PO creation', async t => {
  const {db,scope,handlers}=await fixture(t);
  const quantities=[1,13,10], prices=[7118,7118,11523];
  for(const qty of quantities) {
    const result=await scope.upsertRfqItemRow(db,22,{item_code:'STRAINER',qty,uom:'EA'},3);
    assert.equal(result.status,'inserted');
  }
  const rfqRows=(await db.query('select id,po_line,qty from rfq_items order by id')).rows;
  assert.deepEqual(rfqRows.map(row=>[row.po_line,Number(row.qty)]),[['1',1],['2',13],['3',10]]);
  for(let i=0;i<rfqRows.length;i++) await db.query("update rfq_items set award_status='AWARDED', awarded_vendor_id=8, awarded_unit_price=$2 where id=$1",[rfqRows[i].id,prices[i]]);
  await handlers.get('/po/create')({body:{rfq_id:22,vendor_id:8,po_no:'PO-1'},user:{id:4}},{redirect(){}});
  const poRows=(await db.query('select po_line,qty_ordered,unit_price,rfq_item_id from po_lines order by po_line')).rows;
  assert.deepEqual(poRows.map(row=>[row.po_line,Number(row.qty_ordered),Number(row.unit_price)]),[['1',1,7118],['2',13,7118],['3',10,11523]]);
  assert.equal(new Set(poRows.map(row=>row.rfq_item_id)).size,3);
  await assert.rejects(()=>handlers.get('/po/create')({body:{rfq_id:22,vendor_id:8,po_no:'PO-1'},user:{id:4}},{redirect(){}}),/no unissued/);
  assert.equal((await db.query('select count(*)::int as n from po_lines')).rows[0].n,3);
});

test('both PO import paths match line numbers instead of overwriting matching item codes', async t => {
  const {db,scope}=await fixture(t);
  for(let i=1;i<=3;i++) await scope.upsertPurchaseOrderRow(db,{po_no:'PO-2',vendor_name:'Supplier',po_line:String(i),item_code:'STRAINER',qty_ordered:i,unit_price:100*i},3);
  assert.equal((await db.query('select count(*)::int as n from po_lines')).rows[0].n,3);
  await scope.upsertPurchaseOrderLineRow(db,{po_no:'PO-2',po_line:'4',item_code:'STRAINER',qty_ordered:4,unit_price:400},3);
  await scope.upsertPurchaseOrderLineRow(db,{po_no:'PO-2',po_line:'2',item_code:'STRAINER',qty_ordered:20,unit_price:250},3);
  const rows=(await db.query('select po_line,qty_ordered,unit_price from po_lines order by po_line')).rows;
  assert.deepEqual(rows.map(row=>[row.po_line,Number(row.qty_ordered),Number(row.unit_price)]),[['1',1,100],['2',20,250],['3',3,300],['4',4,400]]);
});

test('quote import uses PO line numbers and rejects ambiguous repeated item codes', async t => {
  const {db,scope,handlers,errors}=await fixture(t);
  for(const qty of [1,13,10]) await scope.upsertRfqItemRow(db,22,{item_code:'STRAINER',qty},3);
  scope.importRows=[{item_code:'STRAINER',unit_price:999},...[7118,7118,11523].map((price,i)=>({po_line:String(i+1),item_code:'STRAINER',unit_price:price}))];
  await handlers.get('/rfq/:id/quotes/import')({params:{id:22},body:{vendor_id:8},user:{id:4}},{redirect(){}});
  assert.deepEqual(errors.map(error=>error.code),['ambiguous_rfq_item']);
  const quotes=(await db.query('select ri.po_line,q.unit_price from quotes q join rfq_items ri on ri.id=q.rfq_item_id order by ri.po_line')).rows;
  assert.deepEqual(quotes.map(row=>[row.po_line,Number(row.unit_price)]),[['1',7118],['2',7118],['3',11523]]);
});
