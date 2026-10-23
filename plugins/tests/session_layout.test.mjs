import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactGrid, layoutOverlaps } from '../chrome/session-layout.js';

test('centers windows in rows and preserves minimum composer dimensions',()=>{
 const r=compactGrid(4,{left:20,top:30,width:1500,height:1000});
 assert.equal(r.length,4);
 assert.ok(new Set(r.map(x=>x.top)).size>=2);
 for(const rect of r){assert.ok(rect.width>=480);assert.ok(rect.height>=400);}
});
test('stagger rather than request native windows below macOS readable minimum',()=>{
 const display={left:0,top:0,width:1100,height:800};
 const boxes=compactGrid(10,display);
 assert.equal(boxes.length,10);
 assert.equal(layoutOverlaps(boxes),true);
 for(const rect of boxes){
   assert.ok(rect.width>=640);
   assert.ok(rect.height>=440);
   assert.ok(rect.left>=display.left && rect.top>=display.top);
   assert.ok(rect.left+rect.width<=display.left+display.width);
   assert.ok(rect.top+rect.height<=display.top+display.height);
 }
});
test('reject impossible displays before altering Chrome windows',()=>{
 assert.throws(()=>compactGrid(2,{left:0,top:0,width:600,height:900}),/at least/);
 assert.throws(()=>compactGrid(0,{left:0,top:0,width:1400,height:900}),/Select/);
});
test('one session uses usable display',()=>{
 assert.deepEqual(compactGrid(1,{left:-1200,top:0,width:1200,height:850}),[{left:-1200,top:0,width:1200,height:850}]);
});
