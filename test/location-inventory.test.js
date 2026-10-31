import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('location inventory drafts survive photo navigation but clear after stock changes and saves',()=>{
  const storage=new Map(),fields=[{name:'actual_0',value:''},{name:'item_queue',value:''}],events={};
  const form={dataset:{locationInventoryDraft:'user-job-location',draftVersion:'stock-v1',draftSaved:'0'},querySelectorAll:()=>fields,addEventListener:(type,fn)=>events[type]=fn};
  const run=()=>vm.runInNewContext(fs.readFileSync(new URL('../public/location-inventory.js',import.meta.url),'utf8'),{document:{querySelector:()=>form},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  run();fields[0].value='12';fields[1].value='[{"id":7,"qty":3}]';events.input();fields.forEach(f=>f.value='');run();assert.equal(fields[0].value,'12');assert.equal(fields[1].value,'[{"id":7,"qty":3}]');
  fields.forEach(f=>f.value='');form.dataset.draftVersion='stock-v2';run();assert.equal(fields[0].value,'');assert.equal(storage.size,0);
  fields[0].value='3';events.input();fields[0].value='';form.dataset.draftSaved='1';run();assert.equal(fields[0].value,'');assert.equal(storage.size,0);
});
