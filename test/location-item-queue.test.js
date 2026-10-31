import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag=''){this.tag=tag;this.children=[];this.events={};this.value='';this.dataset={};}
  appendChild(e){this.children.push(e);return e;}
  replaceChildren(...e){this.children=e;}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(){} focus(){}
  querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
}
test('master queue holds multiple quantities, survives filters, removes items, and validates before review',()=>{
  const hidden=new Element(),form=new Element(),body=new Element(),count=new Element(),status=new Element(),clear=new Element();
  hidden.value=JSON.stringify([{id:1,qty:4}]);hidden.closest=()=>form;hidden.dispatchEvent=()=>{};form.dispatchEvent=()=>{};
  const rows=[1,2].map(id=>{const row=new Element();row.dataset={id:String(id),code:'PART-'+id,description:'Steel '+id,size:id===1?'12':'24',uom:'EA',type:'steel'};row.button=new Element();row.querySelector=()=>row.button;return row;});
  const filter=new Element();filter.dataset.masterFilter='size';
  form.querySelectorAll=q=>q.includes('master-row')?rows:[filter];
  form.querySelector=q=>q.includes('queue-rows')?body:q.includes('queue-count')?count:q.includes('match-count')?status:clear;
  let alerts=0;
  vm.runInNewContext(fs.readFileSync(new URL('../public/location-item-queue.js',import.meta.url),'utf8'),{document:{querySelector:()=>hidden,createElement:tag=>new Element(tag)},Event:class{},window:{alert:()=>alerts++}});
  assert.equal(rows[0].button.disabled,true);assert.match(count.textContent,/1 item/);
  rows[1].button.events.click();assert.equal(JSON.parse(hidden.value).length,2);
  let inputs=body.querySelectorAll('input');inputs[1].value='8';inputs[1].events.input();assert.equal(JSON.parse(hidden.value)[1].qty,'8');
  filter.value='12';filter.events.input();assert.equal(rows[1].hidden,true);assert.equal(JSON.parse(hidden.value).length,2);
  let prevented=false;form.events.submit({preventDefault(){prevented=true;}});assert.equal(prevented,false);
  inputs[1].value='';inputs[1].events.input();form.events.submit({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(alerts,1);
  body.querySelectorAll('button')[1].events.click();assert.equal(JSON.parse(hidden.value).length,1);assert.equal(rows[1].button.disabled,false);
});
