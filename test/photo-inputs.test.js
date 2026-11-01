import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function control(){return {events:{},addEventListener(type,fn){this.events[type]=fn;},click(){this.clicked=true;},files:[]};}
test('photo gallery and camera buttons open separate inputs and share selection feedback',()=>{
  const gallery=control(),camera=control(),pick=control(),take=control(),form=control(),status={},label={};
  form.querySelectorAll=()=>[];
  const map={'[data-photo-upload-form]':form,'[data-photo-input]':gallery,'[data-photo-camera-input]':camera,'[data-photo-pick]':pick,'[data-photo-camera-pick]':take,'[data-photo-status]':status,'[data-photo-file-label]':label};
  const section={querySelector:q=>map[q]||null};
  vm.runInNewContext(fs.readFileSync(new URL('../public/material-photos.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[section]}});
  pick.events.click();assert.equal(gallery.clicked,true);assert.equal(camera.clicked,undefined);
  take.events.click();assert.equal(camera.clicked,true);
  gallery.files=[{name:'saved1.jpg'},{name:'saved2.jpg'}];gallery.events.change();assert.equal(label.textContent,'2 photos selected');
  camera.files=[{name:'camera.jpg'}];camera.events.change();assert.equal(label.textContent,'1 photo selected');
  gallery.files=[];gallery.events.change();assert.equal(label.textContent,'1 photo selected'); // cancelled picker preserves camera selection
});
