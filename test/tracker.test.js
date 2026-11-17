import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import {trackerQuantity} from '../src/tracker.js';
import {getIssuedIdentRequests} from '../src/item-ident.js';
import {mergeItems} from '../src/item-merge.js';

test('tracker quantity accepts decimals and rejects invalid stock values',()=>{
  assert.equal(trackerQuantity('1,234.1250'),1234.125);
  for(const q of ['-1','1e3','NaN','','1.00001','1,23'])assert.throws(()=>trackerQuantity(q));
});

test('tracker routes reconcile stock, holds, partial issues, reversals, numbering, contacts and job isolation',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const f of fs.readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(new URL('../db/migrations/'+f,import.meta.url),'utf8'));
  await db.query("insert into users(id,username,password_hash,role) values(900,'tracker-test',$1,'admin')",[await bcrypt.hash('tracker-test',4)]);
  await db.exec(`insert into jobs(id,job_number) values(901,'8883'),(902,'OTHER');
    insert into vendors(id,name) values(901,'Tracker Supplier');
    insert into warehouses(id,job_id,name) values(901,901,'Tracker Yard'),(902,902,'Other Yard');
    insert into warehouse_locations(id,job_id,warehouse_id,name) values(901,901,901,'A'),(902,901,901,'B'),(903,902,902,'C');
    insert into material_items(id,job_id,item_code,description,material_type,uom) values(901,901,'TRACK-PIPE','Tracker Pipe','pipe','FT'),(902,902,'OTHER','Other job item','pipe','EA');`);
  const root=new URL('../src/',import.meta.url),stub=new URL('.tracker-db-'+process.pid+'.mjs',root),serverFile=new URL('.tracker-server-'+process.pid+'.mjs',root);
  const old=process.env.VERCEL;process.env.VERCEL='1';globalThis.__trackerDb=db;
  fs.writeFileSync(stub,`const db=globalThis.__trackerDb;export const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};};export const pool={query};export const initDb=async()=>{};export const withTransaction=fn=>db.transaction(fn);export const auditLog=async(db,u,a,type,id,details)=>db.query('insert into audit_log(user_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)',[u,a,type,String(id||''),details]);export let vendorCategories=['pipe'];export let permissionMatrix={};export const setVendorCategories=x=>vendorCategories=x;export const setPermissionMatrix=x=>permissionMatrix=x;`);
  fs.writeFileSync(serverFile,fs.readFileSync(new URL('server.js',root),'utf8').replace('from "./db.js";','from '+JSON.stringify(stub.href)+';'));
  let server;t.after(async()=>{if(server)await new Promise(r=>server.close(r));fs.rmSync(stub,{force:true});fs.rmSync(serverFile,{force:true});delete globalThis.__trackerDb;if(old===undefined)delete process.env.VERCEL;else process.env.VERCEL=old;});
  const app=(await import(serverFile.href)).default;
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;let cookie='',token='';
  async function request(path,body,form=false){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{Cookie:cookie,...body!==undefined?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json','X-Tracker-Token':token}:{}},body:body===undefined?undefined:form?new URLSearchParams(body):JSON.stringify(body)});
    for(const h of response.headers.getSetCookie())if(h.startsWith('session_token='))cookie=h.split(';')[0];return response;
  }
  async function post(path,body,status=200){const r=await request(path,body),data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
  async function page(kind,id){const r=await request('/tracker/'+kind+(id?'?document='+id:''));const html=await r.text();assert.equal(r.status,200,html);const state=JSON.parse(html.match(/<script type="application\/json" id="tracker-state">([\s\S]*?)<\/script>/)[1]);token=state.token;return state;}
  assert.equal((await request('/login',{username:'tracker-test',password:'tracker-test'},true)).status,302);
  assert.equal((await request('/jobs/select',{job_id:901},true)).status,302);
  await page('receiving');await post('/tracker/receiving/documents',{},400);
  await post('/tracker/reference/import',{});await post('/tracker/reference/import',{});
  assert.equal((await db.query('select count(*)::int as n from tracker_contacts where job_id=901')).rows[0].n,28);
  const create=k=>post('/tracker/'+k+'/documents',{});
  let receipt=await create('receiving');assert.equal(receipt.number,'GRR-00827');
  let r=(await page('receiving',receipt.id)).rows[0];
  const saveRow=async(kind,doc,row,patch,status=200)=>{const result=await post('/tracker/'+kind+'/documents/'+doc.id+'/rows/'+row.id,{version:row.version,patch},status);if(result.document_version)doc.version=result.document_version;return result;};
  const saveDoc=(kind,doc,patch,status=200)=>post('/tracker/'+kind+'/documents/'+doc.id,{version:doc.version,patch},status);
  r=await saveRow('receiving',receipt,r,{material_item_id:901,quantity:'20',warehouse:'Tracker Yard',location:'A'});
  assert.equal(Number(r.posted_quantity),0);
  receipt=await saveDoc('receiving',receipt,{vendor_id:'901',received_date:'2026-11-17',received_by:'Materials',po_number:'MANUAL-PO'});
  r=(await page('receiving',receipt.id)).rows[0];assert.equal(Number(r.posted_quantity),20);
  async function stock(){const html=await (await request('/inventory')).text();assert.match(html,/TRACK-PIPE/);const state=(await db.query('select sum(posted_quantity)::numeric as receipts from tracker_rows r join tracker_documents d on d.id=r.document_id where d.kind=\'receiving\' and not d.cancelled')).rows[0];return Number(state.receipts);}
  assert.equal(await stock(),20);
  assert.equal((await db.query('select count(*)::int as n from purchase_orders')).rows[0].n,0);
  await saveRow('receiving',receipt,{...r,version:0},{quantity:21},409);
  let ticket=await create('issuing');assert.equal(ticket.number,'GRPT-01655');
  const contact=(await db.query('select day_contact from tracker_contacts where job_id=901 order by id limit 1')).rows[0].day_contact;
  ticket=await saveDoc('issuing',ticket,{issued_to:contact,requestor:contact,requested_date:'2026-11-17',date_required:'2026-11-18',destination:'Gun Range',delivery_instructions:'Deliver to northwest corner',usage:'Header material'});
  let line=(await page('issuing',ticket.id)).rows[0];line=await saveRow('issuing',ticket,line,{material_item_id:901,quantity:15});assert.equal(Number(line.reserved_quantity),15);
  assert.match(await (await request('/requisitions/reservations?item_code=TRACK-PIPE')).text(),new RegExp('/tracker/issuing\\?document='+ticket.id));
  r=(await page('receiving',receipt.id)).rows[0];await saveRow('receiving',receipt,r,{quantity:10},400);
  let other=await create('issuing'),otherLine=(await page('issuing',other.id)).rows[0];otherLine=await saveRow('issuing',other,otherLine,{material_item_id:901,quantity:10});assert.equal(Number(otherLine.reserved_quantity),5);
  const review=await (await request('/tracker/issuing/documents/'+ticket.id+'/allocations')).json();assert.equal(review.rows[0].sources[0].receipt_row_id,r.id);
  const body={version:review.document.version,request_key:'tracker-issue-test-1',issued_date:'2026-11-17',allocations:[{row_id:line.id,receipt_row_id:r.id,warehouse:'Tracker Yard',location:'A',quantity:7}]};
  const posting=await post('/tracker/issuing/documents/'+ticket.id+'/issue',body);assert.equal((await post('/tracker/issuing/documents/'+ticket.id+'/issue',body)).id,posting.id);
  line=(await page('issuing',ticket.id)).rows[0];assert.equal(Number(line.issued_quantity),7);assert.equal(Number(line.reserved_quantity),8);
  const after=(await page('receiving',receipt.id)).rows[0];assert.equal(Number(after.receipt_issued),7);assert.match(after.tickets,/GRPT-01655/);
  assert.equal((await getIssuedIdentRequests(db,901,'TRACK-PIPE'))[0].requisition_no,'GRPT-01655');
  assert.equal((await request('/items/901/change-ident')).status,400);
  await db.exec("insert into material_items(id,job_id,item_code,description,material_type,uom) values(903,901,'OTHER-PIPE','Other pipe','pipe','FT')");
  await assert.rejects(db.transaction(tx=>mergeItems(tx,{jobId:901,sourceId:901,targetId:903})),/used on issued requests/);
  await post('/tracker/receiving/documents/'+receipt.id+'/cancel',{},400);
  await saveRow('issuing',ticket,line,{quantity:16},400);
  const pdf=await request('/tracker/issuing/documents/'+ticket.id+'/pick-ticket.pdf');assert.equal(pdf.status,200);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
  if(process.env.TRACKER_QA_DIR){
    fs.mkdirSync(process.env.TRACKER_QA_DIR,{recursive:true});fs.writeFileSync(process.env.TRACKER_QA_DIR+'/pick-ticket.pdf',bytes);
    if(process.env.TRACKER_BROWSER_MODULE){
      const {chromium}=await import(process.env.TRACKER_BROWSER_MODULE),browser=await chromium.launch({headless:true,channel:'msedge'});
      try{
        const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
        await context.addCookies([{name:'session_token',value:cookie.slice('session_token='.length),url:base}]);
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.goto(base+'/tracker/receiving?document='+receipt.id);
        await page.locator('#tracker-add-row').click();await page.waitForFunction(()=>document.querySelectorAll('#tracker-grid tbody tr').length===2);
        const target=page.locator('#tracker-grid tbody tr').nth(1).locator('input[data-field="item_code"]');
        await target.fill('TRACK-PIPE');await target.press('Tab');
        await page.waitForFunction(()=>document.querySelector('#tracker-status').textContent==='Saved');
        assert.equal(await page.locator('#tracker-grid tbody tr').nth(1).locator('input[data-field="description"]').inputValue(),'Tracker Pipe');
        await target.focus();await page.evaluate(()=>{
          const data=new DataTransfer();data.setData('text/plain','TRACK-PIPE\tTracker Pipe\tFT\t1\nTRACK-PIPE\tTracker Pipe\tFT\t1');
          document.activeElement.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
        });
        await page.waitForFunction(()=>document.querySelectorAll('#tracker-grid tbody tr').length===3&&document.querySelector('#tracker-status').textContent==='Saved');
        const third=page.locator('#tracker-grid tbody tr').nth(2),badQuantity=third.locator('input[data-field="quantity"]');
        await badQuantity.fill('-1');await badQuantity.press('Tab');await page.waitForFunction(()=>document.querySelector('#tracker-status').dataset.state==='error');
        await third.locator('input[data-field="notes"]').fill('Draft note');await third.locator('input[data-field="notes"]').press('Tab');
        await page.waitForFunction(()=>document.querySelector('#tracker-grid tbody tr:nth-child(3) input[data-field="notes"]').value==='Draft note'&&document.querySelector('#tracker-status').dataset.state==='error');
        assert.equal(await badQuantity.inputValue(),'-1');await badQuantity.fill('1');await badQuantity.press('Tab');await page.waitForFunction(()=>document.querySelector('#tracker-status').textContent==='Saved');
        const warehouseCell=page.locator('#tracker-grid tbody tr').nth(1).locator('select[data-field="warehouse"]');await warehouseCell.selectOption('Tracker Yard');await warehouseCell.press('Tab');
        await page.waitForFunction(()=>document.querySelector('#tracker-status').textContent==='Saved');
        assert.equal(await page.evaluate(()=>document.activeElement.dataset.field),'location');
        await page.locator('#tracker-grid tbody tr').nth(1).locator('select[data-field="location"]').selectOption('B');
        await page.waitForFunction(()=>document.querySelector('#tracker-status').textContent==='Saved');
        await page.locator('#tracker-grid th').first().evaluate(th=>th.style.width='200px');await page.waitForTimeout(100);
        assert.equal(await page.locator('#tracker-grid th').nth(1).evaluate(th=>Math.round(parseFloat(getComputedStyle(th).left))),Math.round(await page.locator('#tracker-grid th').first().evaluate(th=>th.getBoundingClientRect().width)));
        await page.locator('#tracker-grid th').first().evaluate(th=>th.style.width='140px');
        await page.screenshot({path:process.env.TRACKER_QA_DIR+'/receiving-desktop.png',fullPage:true});
        await page.goto(base+'/tracker/issuing?document='+ticket.id);await page.locator('#tracker-allocate').click();await page.waitForSelector('#tracker-issue-dialog[open]');
        assert.ok(await page.locator('[data-allocation]').count()>0);
        await page.screenshot({path:process.env.TRACKER_QA_DIR+'/allocations-desktop.png',fullPage:true});await page.locator('#tracker-close-dialog').click();
        await page.setViewportSize({width:390,height:844});await page.screenshot({path:process.env.TRACKER_QA_DIR+'/issuing-phone.png',fullPage:true});
        const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth,width:innerWidth,grid:document.querySelector('.tracker-scroll').scrollWidth}));
        assert.ok(overflow.page<=overflow.width+1,JSON.stringify(overflow));assert.ok(overflow.grid>overflow.width);
        assert.deepEqual(errors,[]);
      }finally{await browser.close();}
    }
  }
  const history=await (await request('/yard/item-history?item=TRACK-PIPE')).text();assert.match(history,/Tracker Receipt/);assert.match(history,/Tracker Issue/);
  await post('/tracker/issuing/documents/'+ticket.id+'/reverse/'+posting.id,{});line=(await page('issuing',ticket.id)).rows[0];assert.equal(Number(line.issued_quantity),0);assert.equal(Number(line.reserved_quantity),15);
  await post('/tracker/issuing/documents/'+ticket.id+'/cancel',{});otherLine=(await page('issuing',other.id)).rows[0];assert.equal(Number(otherLine.reserved_quantity),10);
  await post('/tracker/issuing/documents/'+other.id+'/cancel',{});
  r=(await page('receiving',receipt.id)).rows[0];r=await saveRow('receiving',receipt,r,{quantity:12});assert.equal(Number(r.posted_quantity),12);
  // Existing request screens must attribute issues back to tracker receipts too.
  await db.exec(`insert into bom_headers(id,job_id,job_number,bom_no,bom_type,status) values(905,901,'8883','TRACKER-LEGACY-BOM','pipe','ACTIVE');
    insert into bom_lines(id,bom_id,line_no,item_code,description,uom,qty_required) values(905,905,'1','TRACK-PIPE','Tracker Pipe','FT',3);
    insert into material_requisitions(id,job_id,requisition_no,bom_id,requested_by_name,status) values(905,901,'EXISTING-REQUEST',905,'Crew','ACCEPTED');
    insert into material_requisition_lines(id,job_id,requisition_id,bom_line_id,qty_requested,qty_issued) values(905,901,905,905,3,3);`);
  assert.equal((await request('/requisitions/905/issue',{},true)).status,302);
  let attributed=(await page('receiving',receipt.id)).rows[0];assert.equal(Number(attributed.receipt_issued),3);
  assert.ok(attributed.ticket_links.some(l=>l.url==='/requisitions/905/pick-ticket.pdf'));
  await post('/tracker/receiving/documents/'+receipt.id+'/cancel',{},400);
  assert.equal((await request('/requisitions/905/cancel',{},true)).status,302);
  attributed=(await page('receiving',receipt.id)).rows[0];assert.equal(Number(attributed.receipt_issued),0);
  receipt=await saveDoc('receiving',receipt,{number:'GRR-00900'});
  const concurrent=await Promise.all([create('receiving'),create('receiving')]);assert.deepEqual(concurrent.map(d=>d.number).sort(),['GRR-00901','GRR-00902']);
  await saveDoc('receiving',receipt,{number:'GRR-00901'},409);
  // A source receipt's old dimensions can differ from the current master.
  await db.exec(`insert into material_items(id,job_id,item_code,description,material_type,uom,size_1) values(904,901,'LEGACY-PIPE','Legacy pipe','pipe','FT','42');
    insert into purchase_orders(id,job_id,po_no,vendor_id) values(904,901,'LEGACY-PO',901);
    insert into po_lines(id,job_id,po_id,material_item_id,qty_ordered) values(904,901,904,904,6);
    insert into receipts(job_id,po_line_id,qty_received,warehouse,location,osd_status) values(901,904,6,'Tracker Yard','A','OK');`);
  let legacyTicket=await create('issuing');legacyTicket=await saveDoc('issuing',legacyTicket,{issued_to:contact});
  let legacyLine=(await page('issuing',legacyTicket.id)).rows[0];legacyLine=await saveRow('issuing',legacyTicket,legacyLine,{material_item_id:904,quantity:4});
  const legacyReview=await (await request('/tracker/issuing/documents/'+legacyTicket.id+'/allocations')).json(),source=legacyReview.rows[0].sources[0];
  assert.equal(source.size_1,'');assert.equal(legacyLine.size_1,'42');
  await post('/tracker/issuing/documents/'+legacyTicket.id+'/issue',{version:legacyReview.document.version,request_key:'legacy-source-dimensions',issued_date:'2026-11-17',allocations:[{row_id:legacyLine.id,...source,quantity:4}]});
  const allocated=(await db.query('select a.size_1 from tracker_allocations a where row_id=$1',[legacyLine.id])).rows[0];assert.equal(allocated.size_1,'');
  const longTicket=await create('issuing');
  await db.query(`insert into tracker_rows(job_id,document_id,material_item_id,item_code,description,uom,quantity)
    select 901,$1,903,'OTHER-PIPE','Line '||n||' - detailed material description','FT',1 from generate_series(1,40) n`,[longTicket.id]);
  const longPdf=Buffer.from(await (await request('/tracker/issuing/documents/'+longTicket.id+'/pick-ticket.pdf')).arrayBuffer());
  assert.equal((longPdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);
  assert.match(longPdf.toString('latin1'),/Line 40 - detailed material description/);
  if(process.env.TRACKER_QA_DIR)fs.writeFileSync(process.env.TRACKER_QA_DIR+'/pick-ticket-multipage.pdf',longPdf);
  await saveRow('receiving',receipt,r,{material_item_id:902},400);
  await saveRow('receiving',receipt,r,{warehouse:'Other Yard',location:'C'},400);
  await db.exec("insert into vendors(id,name) values(906,'Kept Tracker Supplier')");
  assert.equal((await request('/vendors/merge',{source_id:901,target_id:906},true)).status,302);
  assert.equal((await page('receiving',receipt.id)).selected.data.vendor_id,'906');
  assert.equal((await request('/jobs/select',{job_id:902},true)).status,302);await page('receiving');
  await post('/tracker/receiving/documents/'+receipt.id,{version:receipt.version,patch:{po_number:'STEAL'}},404);
  await post('/tracker/reference/import',{},400);
  assert.equal((await create('receiving')).number,'GRR-00001');
  const setters=await import(stub.href);setters.setPermissionMatrix({admin:{receiving:{view:true,edit:false}}});
  assert.equal((await request('/tracker/receiving/documents',{})).status,403);setters.setPermissionMatrix({});
  const denied=await fetch(base+'/tracker/receiving/documents',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
});
