import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('phone menu starts closed, remains user-toggleable, and expands when returning to desktop',()=>{
  const menu={open:true},media={matches:true,addEventListener(_event,fn){this.change=fn;}};
  vm.runInNewContext(fs.readFileSync(new URL('../public/mobile-header.js',import.meta.url),'utf8'),{document:{querySelector:()=>menu},window:{matchMedia:()=>media}});
  assert.equal(menu.open,false);menu.open=true;assert.equal(menu.open,true);
  media.matches=false;media.change();assert.equal(menu.open,true);
  media.matches=true;media.change();assert.equal(menu.open,false);
});
test('shared header renders permitted navigation in native disclosure with phone assets',()=>{
  const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const layout=source.slice(source.indexOf('function layout('),source.indexOf('function vendorLayout('));
  const context={normalizeJobIdValue:()=>false,getAppHeaderTitle:()=> 'Material Control',permissionSections:[{key:'yard',href:'/yard',label:'Yard'},{key:'settings',href:'/settings',label:'Settings'}],canAccess:()=>true,isWarehouseUser:()=>false,isAdminRole:()=>false,getUserHomePath:()=>'/dashboard',renderJobSwitcher:()=>'<form class="job-switcher"></form>',esc:String,displayRole:String};
  vm.createContext(context);vm.runInContext(layout,context);
  const html=context.layout('Yard','<h1>Yard</h1>',{username:'warehouse',role:'warehouse'});
  assert.match(html,/<details class="app-menu" open><summary>Menu<\/summary><nav aria-label="Main navigation">/);
  assert.match(html,/href="\/yard">Yard/);assert.doesNotMatch(html,/href="\/settings"/);
  assert.match(html,/mobile-header.css/);assert.match(html,/mobile-header.js/);
  assert.doesNotMatch(context.layout('Login','',null),/<details class="app-menu"/);
});
