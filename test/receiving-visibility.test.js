import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('hide/show fully received rows preserves receipt form values without navigation',()=>{
  const values={mrr_number:'MRR-58',received_date:'2026-10-09',received_by:'Canesha',load_number:'520-2-14D',warehouse:'West',location:'STAGING',qty_received_1:'3',short_action_1:'backorder',mrr_notes:'Keep this note',osd_notes:'Check damage'};
  const original={...values},rows=[{dataset:{fullyReceived:'true'},hidden:false},{dataset:{fullyReceived:'false'},hidden:false}];
  const count={textContent:'2 line(s) shown'},attributes={'aria-pressed':'false'};
  let click;
  const form={values,querySelectorAll:()=>rows,querySelector:()=>count};
  const button={closest:()=>form,addEventListener:(_name,fn)=>click=fn,getAttribute:name=>attributes[name],setAttribute:(name,value)=>attributes[name]=value,textContent:'Hide Fully Received Items'};
  const window={location:{href:'https://example.test/po/12/receive?other=keep'},history:{state:{x:1},replaceState(state,_title,url){assert.equal(state.x,1);window.location.href=url;}}};
  const context=vm.createContext({document:{querySelectorAll:()=>[button]},window,URL});
  vm.runInContext(fs.readFileSync(new URL('../public/receiving-visibility.js',import.meta.url),'utf8'),context);
  click();assert.equal(rows[0].hidden,true);assert.equal(rows[1].hidden,false);assert.equal(count.textContent,'1 line(s) shown');assert.equal(button.textContent,'Show Fully Received Items');assert.equal(new URL(window.location.href).searchParams.get('hide_received'),'1');assert.equal(new URL(window.location.href).searchParams.get('other'),'keep');assert.deepEqual(values,original);
  click();assert.equal(rows[0].hidden,false);assert.equal(count.textContent,'2 line(s) shown');assert.equal(button.textContent,'Hide Fully Received Items');assert.equal(new URL(window.location.href).searchParams.has('hide_received'),false);assert.deepEqual(values,original);
  attributes['aria-pressed']='true';rows[0].hidden=true;click();assert.equal(rows[0].hidden,false);assert.deepEqual(values,original);
});
