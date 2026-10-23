import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSessionWindows } from '../chrome/session-arrangement.js';

const windows=[{id:10,type:'normal'},{id:11,type:'normal'},{id:12,type:'popup'}];
const sessions=[
  {tab_id:1,window_id:10,active:false},
  {tab_id:2,window_id:11,active:false},
  {tab_id:3,window_id:11,active:true},
  {tab_id:4,window_id:12,active:true},
];
test('reuse an isolated window; retain the active tab when splitting a shared window',()=>{
 const plan=planSessionWindows(sessions,windows);
 assert.deepEqual(plan.map(p=>p.reuse_window_id),[10,null,11,null]);
 assert.deepEqual(plan.map(p=>p.tab_id),[1,2,3,4]);
});
test('second arrange is idempotent when each conversation is in a normal window',()=>{
 const ownWindows=sessions.map((s,i)=>({id:100+i,type:'normal'}));
 const ownSessions=sessions.map((s,i)=>({...s,window_id:100+i}));
 const plan=planSessionWindows(ownSessions,ownWindows);
 assert.ok(plan.every(step=>step.reuse_window_id!==null));
});
test('popup ChatGPT window must become normal, not resize to an unsupported type',()=>{
 const plan=planSessionWindows([{tab_id:22,window_id:12,active:true}],windows);
 assert.equal(plan[0].reuse_window_id,null);
});
