import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('request quantities show an availability popup and clear the error after correction',()=>{
  const events={};let message='',popup=0,invalid;
  const input={value:'',dataset:{availableQty:'5',itemCode:'101B1'},setCustomValidity:m=>message=m,setAttribute:(_k,v)=>invalid=v,reportValidity:()=>popup++,addEventListener:(k,fn)=>events[k]=fn};
  vm.runInNewContext(fs.readFileSync(new URL('../public/request-quantity-validation.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[input]},Intl});
  assert.equal(message,'');input.value='6';events.input();assert.match(message,/101B1.*available quantity \(5\)/);assert.equal(popup,1);assert.equal(invalid,'true');
  input.value='5';events.input();assert.equal(message,'');assert.equal(invalid,'false');
  input.value='1,000';events.change();assert.ok(message);input.value='';events.input();assert.equal(message,'');
  input.dataset.availableQty='0';input.value='1';events.input();assert.ok(message);
});
