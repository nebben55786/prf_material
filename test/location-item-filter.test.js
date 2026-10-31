import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('existing location items filter by code, description and size together, with safe selection clearing',()=>{
  const fields=['code','description','size'].map(key=>({dataset:{itemFilter:key},value:'',addEventListener(_type,fn){this.input=fn;}}));
  const placeholder={value:''},a={value:'1',dataset:{code:'101B1',description:'Beam Steel',size:'W 21 x 68 / 20 ft'}},b={value:'2',dataset:{code:'101B2',description:'Beam Steel',size:'W 30 x 99 / 30 ft'}},c={value:'3',dataset:{code:'VALVE-1',description:'Butterfly valve',size:'12 inch'}};
  const status={textContent:''},clear={addEventListener(_type,fn){this.click=fn;}};let changes=0,saves=0;
  const picker={options:[placeholder,a,b,c],value:'',closest:()=>form,replaceChildren(...nodes){this.options=nodes;},dispatchEvent(){changes++;}};
  const form={querySelectorAll:()=>fields,querySelector:q=>q.includes('clear')?clear:status,dispatchEvent(){saves++;}};
  vm.runInNewContext(fs.readFileSync(new URL('../public/location-item-filter.js',import.meta.url),'utf8'),{document:{querySelector:()=>picker},Event:class {}});
  assert.equal(picker.options.length,4);
  fields[0].value='101b';fields[0].input();assert.equal(picker.options.length,3);
  fields[1].value='STEEL';fields[1].input();assert.equal(picker.options.length,3);
  picker.value='2';fields[2].value='21 x 68';fields[2].input();assert.equal(picker.options.length,2);assert.equal(picker.options[1],a);assert.equal(picker.value,'');assert.equal(changes,1);assert.match(status.textContent,/selection cleared/);
  fields[2].value='not found';fields[2].input();assert.equal(picker.options.length,1);assert.match(status.textContent,/0 matching/);
  clear.click();assert.equal(picker.options.length,4);assert.ok(fields.every(f=>f.value===''));assert.equal(saves,1);
});
