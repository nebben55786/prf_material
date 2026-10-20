import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('receiving piece total sums only current editable receipt quantities and updates for bulk actions',()=>{
  const inputs=[
    {name:'qty_received_1',value:'1',dataset:{remaining:'5'}},
    {name:'qty_received_2',value:'3',dataset:{remaining:'15'}},
    {name:'qty_received_3',value:'8',dataset:{remaining:'40'}},
    {name:'qty_ordered',value:'999'},
    {name:'short_qty',value:'999'},
    {name:'mrr_notes',value:'999'}
  ];
  const output={textContent:''}, singleOutput={textContent:''};
  const singleInput={name:'qty_received',value:'2.5'};
  const listeners={}, windowListeners={};
  function makeForm(fields,out){const form={
    querySelector:()=>out,
    querySelectorAll:()=>fields.filter(i=>i.name==='qty_received'||i.name.startsWith('qty_received_')),
    closest:()=>form,
    dispatchEvent(event){listeners[event.type]?.({target:form});}
  };fields.forEach(i=>i.closest=()=>form);return form;}
  const form=makeForm(inputs,output),single=makeForm([singleInput],singleOutput);
  const document={querySelectorAll:()=>[form,single],addEventListener:(name,fn)=>listeners[name]=fn,getElementById:()=>form};
  const context=vm.createContext({document,window:{addEventListener:(name,fn)=>windowListeners[name]=fn},Intl,Event});
  vm.runInContext(fs.readFileSync(new URL('../public/receiving-piece-count.js',import.meta.url),'utf8'),context);
  assert.equal(output.textContent,'12');assert.equal(singleOutput.textContent,'2.5');
  inputs[0].value='2.5';listeners.input({target:inputs[0]});assert.equal(output.textContent,'13.5');
  inputs[2].disabled=true;listeners.change({target:inputs[2]});assert.equal(output.textContent,'5.5');
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start=server.indexOf('        function setPoReceiptQuantities('),end=server.indexOf('        function updatePoLineQuantityState(',start);
  vm.runInContext(server.slice(start,end),context);
  context.setPoReceiptQuantities('42',false);assert.equal(output.textContent,'0');
  context.setPoReceiptQuantities('42',true);assert.equal(output.textContent,'20');
  inputs[2].disabled=false;listeners.change({target:inputs[2]});assert.equal(output.textContent,'60');
  inputs[0].value='bad';inputs[1].value='-2';inputs[2].value='1,200.5';windowListeners.pageshow();assert.equal(output.textContent,'1,200.5');
  singleInput.value='7';listeners.input({target:singleInput});assert.equal(singleOutput.textContent,'7');assert.equal(output.textContent,'1,200.5');
});
