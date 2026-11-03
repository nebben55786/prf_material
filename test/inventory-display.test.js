import assert from 'node:assert/strict';
import test from 'node:test';
import {withItemMasterAttributes} from '../src/inventory-display.js';
test('master display attributes replace receipt snapshots without changing stock keys or quantities',()=>{
  const original={item_code:'part',description:'Receipt text',size_1:'',size_2:'Old size',thk_1:'Old thickness',warehouse:'East',location:'A1',qty_on_hand:66,qty_osd:2};
  const [display]=withItemMasterAttributes([original],[{item_code:'PART',description:'Master text',size_1:'12',size_2:'',thk_1:'',thk_2:'',uom:'EA'}]);
  assert.equal(display.size_1,'12');assert.equal(display.size_2,'');assert.equal(display.thk_1,'');assert.equal(display.description,'Master text');
  assert.equal(display.qty_on_hand,66);assert.equal(display.qty_osd,2);assert.equal(display.warehouse,'East');assert.equal(display.location,'A1');
  assert.equal(original.size_1,'');assert.equal(original.size_2,'Old size');
  assert.deepEqual(withItemMasterAttributes([original],[])[0],original);
});
