import {test} from 'node:test';
import assert from 'node:assert/strict';

const conversations = [
 {id:1,windowId:10,url:'https://chatgpt.com/c/chat-a',active:true,title:'ChatGPT A'},
 {id:2,windowId:11,url:'https://claude.ai/chat/chat-b',active:true,title:'Claude B'},
 {id:3,windowId:11,url:'https://chatgpt.com/c/chat-c',active:false,title:'ChatGPT C'},
];
const calls=[];
let enabled=true;
let handler;
const chrome={
 runtime:{
   getURL:(path)=>'chrome-extension://unit-test/'+path,
   onMessage:{addListener:(fn)=>{handler=fn}},
   onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},reload:()=>{},
 },
 storage:{
   local:{get:async(keys)=>{if (typeof keys==='object')return {...keys,enabled};return {}},set:async(obj)=>{if(typeof obj.enabled==='boolean')enabled=obj.enabled}},
   session:{get:async()=>({}),set:async()=>{}},
 },
 alarms:{onAlarm:{addListener:()=>{}},create:async()=>{}},
 tabs:{
  query:async()=>conversations,
  get:async(id)=>conversations.find(t=>t.id===id),
  update:async(id,props)=>{calls.push(['tab-update',id,props]);return conversations.find(t=>t.id===id)},
  sendMessage:async()=>({ready:true}),
  onUpdated:{addListener:()=>{}},
 },
 windows:{
  get:async(id)=>({id,focused:true}),
  update:async(id,props)=>{calls.push(['window-update',id,props])},
  create:async(props)=>{calls.push(['window-create',props]);return{id:200+calls.length}},
  getAll:async()=>[],
 },
 action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
 downloads:{onChanged:{addListener:()=>{},removeListener:()=>{}},onCreated:{addListener:()=>{},removeListener:()=>{}}},
 scripting:{executeScript:async()=>{}},
};
globalThis.chrome=chrome;
globalThis.fetch=async()=>({ok:false});
await import('../chrome/background.js');
function send(type, extra={}){
 return new Promise(resolve=>{
  handler({type,...extra},{url:'chrome-extension://unit-test/popup.html'},result=>resolve(result));
 });
}

test('enumerates sessions and never follows stored endpoint override',async()=>{
 const result=await send('get-open-sessions');
 assert.equal(result.ok,true);
 assert.equal(result.result.sessions.length,3);
 assert.equal(result.result.config.endpoint,'http://127.0.0.1:5173');
});
test('jump focuses original tab and window',async()=>{
 calls.length=0; const result=await send('focus-session',{tab_id:2});
 assert.equal(result.ok,true);
 assert.deepEqual(calls[0],['tab-update',2,{active:true}]);
 assert.deepEqual(calls[1],['window-update',11,{focused:true}]);
});
test('compact moves sessions into bounded windows and dashboard opens to the right',async()=>{
 calls.length=0;
 const compact=await send('compact-sessions',{screen:{left:0,top:0,width:1440,height:900}});
 assert.equal(compact.ok,true);
 const windows=calls.filter(c=>c[0]==='window-create');
 assert.equal(windows.length,3);
 for(const [,w] of windows){assert.ok(w.tabId);assert.ok(w.height>=400);assert.ok(w.width>=480)}
 calls.length=0;
 const dashboard=await send('open-dashboard-window',{screen:{left:0,top:0,width:1440,height:900}});
 assert.equal(dashboard.ok,true);
 const opened=calls.filter(c=>c[0]==='window-create');
 assert.equal(opened.length,2);
 assert.ok(opened[1][1].left>=opened[0][1].left+opened[0][1].width);
 assert.ok(opened[1][1].url.startsWith('http://127.0.0.1:5173'));
});
test('untrusted webpage cannot focus an unrelated session',async()=>{
 const r=await new Promise(resolve=>handler({type:'focus-session',tab_id:1},{url:'https://chatgpt.com/c/chat-a',tab:{id:1}},resolve));
 assert.equal(r.ok,false);
});

test('popup toggle disables processing but retains navigation',async()=>{
  let config=await send('get-popup-config');
  assert.equal(config.ok,true);
  assert.equal(config.result.enabled,true);
  assert.equal('session_diff' in config.result,false);
  const off=await send('set-enabled',{enabled:false});
  assert.equal(off.result.enabled,false);
  config=await send('get-popup-config');
  assert.equal(config.result.enabled,false);
  const sender={tab:{id:1,active:true,windowId:10,url:'https://chatgpt.com/c/chat-a'},url:'https://chatgpt.com/c/chat-a'};
  const disabled=await new Promise(resolve=>handler({type:'process-source',content:'// Path: src/x.js\n'+('x'.repeat(1300))},sender,resolve));
  assert.equal(disabled.ok,false);
  assert.match(disabled.error,/turned off/);
  assert.equal((await send('get-open-sessions')).ok,true);
  await send('set-enabled',{enabled:true});
  const legacy=await send('load-session');
  assert.equal(legacy.ok,false);
});
