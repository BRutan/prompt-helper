import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;
const handlers=[];
let acknowledged=false;
const tabs=[
  {id:3,windowId:1,active:false,title:'A',url:'https://chatgpt.com/c/session-1'},
  {id:4,windowId:2,active:true,title:'B',url:'https://claude.ai/chat/session-2'},
  {id:5,windowId:2,active:false,title:'Home',url:'https://claude.ai/'},
];
globalThis.chrome={
  runtime:{onMessage:{addListener(fn){handlers.push(fn)}},lastError:null},
  tabs:{async query(){return tabs},async get(id){return tabs.find(t=>t.id===id)},
    async create({url}){const t={id:9,url,title:'New conversation'};tabs.push(t);return t},
    async sendMessage(_id,body){assert.equal(body.payload.text,'BATCH DIFF | 1 files\nCHANGED FILES');return {ok:true,result:{confirmed:true}}}},
  windows:{async get(){return {focused:true}}},
  storage:{local:{async get(defaults){return defaults}}},
  action:{async setBadgeText(){},async setBadgeBackgroundColor(){}}
};
globalThis.fetch=async (url,options={})=>{
  if(url.includes('/api/v1/chat-sessions/delivery?'))return Response.json({status:'prepared',provider:'chatgpt',conversation_id:'session-1',llm_diff:'BATCH DIFF | 1 files\nCHANGED FILES',files:[{status:'updated'}],diff_tokens:44,original_tokens:800,estimator:'test'});
  if(url.endsWith('/api/v1/chat-sessions/delivery') && options.method==='POST'){
    acknowledged=true;assert.deepEqual(JSON.parse(options.body),{delivery_id:'a'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test'});
    return Response.json({status:'sent',changed:1});
  }
  throw Error(`Unexpected request ${url}`);
};
await import('../chrome/background.js?dashboard-test');
function call(type,payload,origin='http://127.0.0.1:5173') {
  return new Promise(resolve=>handlers[0]({type,payload},{tab:{id:10,url:origin},url:origin},resolve));
}
test('enumerates supported conversations across ALL windows',async()=>{
  const out=await call('list-sessions');assert.equal(out.ok,true);
  assert.deepEqual(out.result.sessions.map(s=>s.conversation_id),['session-1','session-2']);
});
test('opens selected platform only',async()=>{
  const out=await call('open-provider',{provider:'claude'});
  assert.equal(out.ok,true);assert.equal(tabs.at(-1).url,'https://claude.ai/');
});
test('rejects non-dashboard origin before enumerating tabs',async()=>{
  const out=await call('list-sessions',{},'http://evil.com');assert.equal(out.ok,false);
});
test('acknowledges only confirmed delivery into the correct conversation',async()=>{
  const out=await call('deliver-session',{tab_id:3,delivery_id:'a'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test'});
  assert.equal(out.ok,true);assert.equal(out.result.status,'sent');assert.equal(acknowledged,true);
});
test('rejects conversation id mismatch',async()=>{
  acknowledged=false;
  const out=await call('deliver-session',{tab_id:4,delivery_id:'a'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test'});
  assert.equal(out.ok,false);assert.equal(acknowledged,false);
});
