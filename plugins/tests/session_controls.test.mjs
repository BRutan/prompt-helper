import {test} from 'node:test';
import assert from 'node:assert/strict';

const conversations = [
 {id:1,windowId:10,url:'https://chatgpt.com/c/chat-a',active:true,title:'ChatGPT A'},
 {id:2,windowId:11,url:'https://claude.ai/chat/chat-b',active:true,title:'Claude B'},
 {id:3,windowId:11,url:'https://chatgpt.com/c/chat-c',active:false,title:'ChatGPT C'},
 {id:4,windowId:12,url:'https://claude.ai/new',active:false,title:'New Claude Chat'},
];
const browserWindows = [
  {id:10,type:'normal',focused:true,tabs:[conversations[0]]},
  {id:11,type:'normal',focused:false,tabs:[conversations[1],conversations[2]]},
  {id:12,type:'popup',focused:false,tabs:[conversations[3]]},
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
  get:async(id)=>browserWindows.find(w=>w.id===id) || {id,type:'popup'},
  getLastFocused:async()=>browserWindows[0],
  update:async(id,props)=>{calls.push(['window-update',id,props])},
  create:async(props)=>{calls.push(['window-create',props]);return{id:200+calls.length}},
  getAll:async(opts)=> opts?.windowTypes?.includes('normal') && !opts?.windowTypes?.includes('popup')
    ? browserWindows.filter(w=>w.type==='normal') : browserWindows,
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
 assert.equal(result.result.sessions.length,4);
 assert.equal(result.result.config.endpoint,'http://127.0.0.1:5173');
});
test('jump focuses original tab and window',async()=>{
 calls.length=0; const result=await send('focus-session',{tab_id:2});
 assert.equal(result.ok,true);
 assert.deepEqual(calls[0],['tab-update',2,{active:true}]);
 assert.deepEqual(calls[1],['window-update',11,{focused:true}]);
});
test('arrange all sessions: reuse isolated normal windows, split only shared/popup tabs',async()=>{
 calls.length=0;
 const arranged=await send('arrange-sessions',{screen:{left:0,top:0,width:1600,height:950}});
 assert.equal(arranged.ok,true);
 assert.equal(arranged.result.count,4);
 assert.equal(arranged.result.layout,'tiled');
 const created=calls.filter(c=>c[0]==='window-create');
 assert.equal(created.length,2,'existing normal browser windows MUST be reused');
 assert.deepEqual(created.map(c=>c[1].tabId),[3,4]);
 assert.ok(created.every(c=>c[1].type==='normal' && c[1].focused===false));
 assert.deepEqual(arranged.result.window_ids.slice(0,2),[10,11]);
 const sized=calls.filter(c=>c[0]==='window-update' && 'width' in c[2]);
 assert.equal(sized.length,4);
 assert.deepEqual(sized.map(c=>c[2].width),[800,800,800,800]);
 assert.ok(sized.every(c=>c[2].height>=440));
 assert.ok(new Set(sized.map(c=>c[2].top)).size>=2);
 assert.equal(calls.filter(c=>c[0]==='tab-update').length,0,'no reload/navigation/activation');
});
test('open dashboard resizes the CURRENT normal Chrome window, no plugin window',async()=>{
 calls.length=0;
 const response=await send('open-dashboard-window',{
   screen:{left:0,top:0,width:1600,height:900},origin_window_id:11,
 });
 assert.equal(response.ok,true);
 assert.equal(response.result.chrome_window_id,11);
 const resized=calls.filter(c=>c[0]==='window-update' && c[1]===11);
 assert.equal(resized.length,1);
 assert.deepEqual({left:resized[0][2].left,top:resized[0][2].top,width:resized[0][2].width,height:resized[0][2].height},{left:0,top:0,width:800,height:900});
 const opened=calls.filter(c=>c[0]==='window-create');
 assert.equal(opened.length,1,'dashboard is the only newly opened window');
 assert.equal(opened[0][1].left,800);
 assert.equal(opened[0][1].width,800);
 assert.ok(opened[0][1].url.startsWith('http://127.0.0.1:5173'));
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
  assert.match(disabled.error,/Unknown message type/);
  assert.equal((await send('get-open-sessions')).ok,true);
  await send('set-enabled',{enabled:true});
  const legacy=await send('load-session');
  assert.equal(legacy.ok,false);
});
