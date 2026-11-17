import test from 'node:test';
import assert from 'node:assert/strict';
import {withTrackerItemStock} from '../src/tracker-item-search.js';

test('picker shows shared unreserved quantity and groups usable stock by warehouse/location',()=>{
  const key=row=>String(row.item_code).trim().toLowerCase();
  const items=[{id:1,item_code:'PIPE',uom:'FT'},{id:2,item_code:'EMPTY',uom:'EA'}];
  const stock=[
    {item_code:'pipe',warehouse:'Main Yard',location:'A',qty_on_hand:'4.1250'},
    {item_code:'PIPE',warehouse:'main yard',location:'a',qty_on_hand:'2.3750'},
    {item_code:'PIPE',warehouse:'Main Yard',location:'B',qty_on_hand:'3.0000'},
    {item_code:'PIPE',warehouse:'Remote Yard',location:'C',qty_on_hand:'8.0000'},
    {item_code:'PIPE',warehouse:'Quarantine',location:'Q',qty_on_hand:0,qty_osd:100},
    {item_code:'PIPE',warehouse:'Empty Yard',location:'X',qty_on_hand:0}
  ];
  const [pipe,empty]=withTrackerItemStock(items,stock,new Map([['pipe',5.25]]),key);
  assert.equal(pipe.qty_available,5.25); // Physical stock also includes material held by requests.
  assert.deepEqual(pipe.stock_locations,[
    {warehouse:'Main Yard',location:'A',qty_on_hand:6.5},
    {warehouse:'Main Yard',location:'B',qty_on_hand:3},
    {warehouse:'Remote Yard',location:'C',qty_on_hand:8}
  ]);
  assert.equal(empty.qty_available,0);assert.deepEqual(empty.stock_locations,[]);
  assert.equal(items[0].stock_locations,undefined);
});
