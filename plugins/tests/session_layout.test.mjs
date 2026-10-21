import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactGrid } from '../chrome/session-layout.js';

test('centers windows in rows and preserves minimum composer dimensions',()=>{
 const r=compactGrid(4,{left:20,top:30,width:1500,height:1000});
 assert.equal(r.length,4);
 assert.ok(new Set(r.map(x=>x.top)).size>=2);
 for(const rect of r){assert.ok(rect.width>=480);assert.ok(rect.height>=400);}
});
test('fails before changing any windows when display cannot fit',()=>{
 assert.throws(()=>compactGrid(10,{left:0,top:0,width:1100,height:800}),/Only/);
});
test('one session uses usable display',()=>{
 assert.deepEqual(compactGrid(1,{left:-1200,top:0,width:1200,height:850}),[{left:-1200,top:0,width:1200,height:850}]);
});
