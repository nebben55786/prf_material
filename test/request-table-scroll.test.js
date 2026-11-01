import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('request wheel scroll reaches header before scrolling rows and leaves horizontal/phone gestures alone',()=>{
 let wheel,top=220,mobile=false,moves=[];
 const scroller={getBoundingClientRect:()=>({top}),addEventListener(type,fn,options){assert.equal(type,'wheel');assert.equal(options.passive,false);wheel=fn;}};
 const window={innerHeight:800,scrollY:100,matchMedia:()=>({matches:mobile}),scrollBy:move=>moves.push(move.top)};
 vm.runInNewContext(fs.readFileSync(new URL('../public/request-table-scroll.js',import.meta.url),'utf8'),{document:{getElementById:()=>scroller,documentElement:{scrollHeight:2000}},window});
 function scroll(overrides={}){let blocked=false;wheel({deltaY:100,deltaX:0,deltaMode:0,preventDefault(){blocked=true;},...overrides});return blocked;}
 assert.equal(scroll(),true);assert.deepEqual(moves,[100]);
 top=40;assert.equal(scroll(),true);assert.equal(moves.at(-1),40);
 top=0;assert.equal(scroll(),false);
 top=200;assert.equal(scroll({shiftKey:true}),false);assert.equal(scroll({ctrlKey:true}),false);assert.equal(scroll({deltaX:200}),false);assert.equal(scroll({deltaY:-100}),false);
 mobile=true;assert.equal(scroll(),false);
});
