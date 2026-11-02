import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('audit zero toggle preserves entered counts and remembers visibility across filter reloads', () => {
  const rows=[{dataset:{zeroQty:'1'},hidden:false,input:{value:'4',disabled:false}},{dataset:{zeroQty:'0'},hidden:false,input:{value:'9',disabled:false}},{dataset:{zeroQty:'0'},hidden:false,input:{value:'',disabled:false}}];
  const original=structuredClone(rows.map(row=>row.input));
  let click;const attributes={};
  const button={textContent:'',addEventListener:(_,fn)=>{click=fn;},setAttribute:(key,value)=>{attributes[key]=value;}};
  const stored=new Map();
  const context=vm.createContext({document:{querySelector:()=>button,querySelectorAll:()=>rows},sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)}});
  const script=fs.readFileSync(new URL('../public/inventory-audit-visibility.js',import.meta.url),'utf8');
  vm.runInContext(script,context);
  assert.equal(rows[0].hidden,true);assert.equal(rows[1].hidden,false);assert.equal(button.textContent,'Show Zero Qty');
  click();assert.equal(rows[0].hidden,false);assert.equal(button.textContent,'Hide Zero Qty');assert.equal(attributes['aria-pressed'],'true');
  vm.runInContext(script,context);assert.equal(rows[0].hidden,false);
  click();assert.equal(rows[0].hidden,true);assert.equal(rows[2].hidden,false);assert.deepEqual(rows.map(row=>row.input),original);
});
