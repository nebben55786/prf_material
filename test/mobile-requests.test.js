import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function el(text='') {
  const classes=new Set();return {textContent:text,children:[],dataset:{},attributes:{},events:{},classList:{add:c=>classes.add(c),contains:c=>classes.has(c),toggle(c,on){if(on)classes.add(c);else classes.delete(c);}},querySelector:()=>null,querySelectorAll:()=>[],appendChild(c){this.children.push(c);},addEventListener(type,fn){this.events[type]=fn;},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]??null;}};
}
test('phone request cards preserve original quantity inputs and add expandable details and accessible labels',()=>{
  const input=el();input.value='7';input.name='request_qty_12';
  const cells=['LINE-1','PART-12','','Pipe','3 in','9','EA'].map(el);
  cells[2].querySelector=()=>input;cells[2].querySelectorAll=()=>[input];
  const header=el(),row=el();row.children=cells;
  header.querySelectorAll=()=>['Line','Item','Request Qty','Description','Size','Available','UOM'].map(el);
  const table=el();table.querySelector=()=>header;table.querySelectorAll=()=>[header,row];table.parentElement=el();
  vm.runInNewContext(fs.readFileSync(new URL('../public/mobile-requests.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[table],createElement:()=>el()}});
  assert.equal(cells[2].querySelector(),input);assert.equal(input.value,'7');assert.equal(input.name,'request_qty_12');
  assert.equal(input.attributes['aria-label'],'Request Qty for PART-12');
  assert.equal(cells[1].classList.contains('phone-request-item'),true);
  assert.equal(cells[2].classList.contains('phone-request-quantity'),true);
  assert.equal(cells[4].classList.contains('phone-request-secondary'),true);
  const toggle=row.children.at(-1).children[0];assert.equal(toggle.type,'button');toggle.events.click();assert.equal(toggle.attributes['aria-expanded'],'true');assert.equal(row.classList.contains('phone-request-expanded'),true);
  toggle.events.click();assert.equal(row.classList.contains('phone-request-expanded'),false);
});
