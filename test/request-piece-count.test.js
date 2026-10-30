import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('request total counts selected quantities across filters without double counting, and updates review edits',()=>{
  const output={textContent:''}, staged={value:JSON.stringify({'1':'10','2':'3','9':'5'})};
  const inputs=[{name:'request_qty_1',value:'2'},{name:'request_qty_2',value:'3'},{name:'request_qty_3',value:'1,000.5'},{name:'request_qty_4',value:'-3'},{name:'request_qty_5',value:'bad'}];
  const selections={'1':{type:'checkbox',checked:true},'2':{type:'checkbox',checked:false},'3':{type:'checkbox',checked:true}};
  let mode='builder';
  const form={getAttribute:()=>mode,querySelectorAll:()=>inputs,querySelector:selector=>selector.includes('data-request-piece-total')?output:selector.includes('staged_selection')?staged:selections[selector.match(/value="([^"]+)"/)?.[1]]};
  const listeners={},windowListeners={};
  vm.runInNewContext(fs.readFileSync(new URL('../public/request-piece-count.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[form],addEventListener:(type,fn)=>listeners[type]=fn},window:{addEventListener:(type,fn)=>windowListeners[type]=fn},Intl});
  assert.equal(output.textContent,'1,007.5'); // visible 2 + 1000.5 and hidden selected 5
  inputs[0].value='4';listeners.input({target:{closest:()=>form}});assert.equal(output.textContent,'1,009.5');
  selections['3'].checked=false;listeners.change({target:{closest:()=>form}});assert.equal(output.textContent,'9');
  mode='';inputs.splice(0,inputs.length,{name:'qty_requested_7',value:'6'},{name:'qty_requested_8',value:'2.25'});
  windowListeners.pageshow();assert.equal(output.textContent,'8.25');
  inputs[1].disabled=true;listeners.input({target:{closest:()=>form}});assert.equal(output.textContent,'6');
});
