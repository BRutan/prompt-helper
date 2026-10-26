import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;
const handlers=[];
const saved={};
const sessionSaved={};
const actions=[];
const conversation={id:3,windowId:1,active:true,title:'Task Title',url:'https://chatgpt.com/c/session-1'};
const deliveryId='a'.repeat(32);
const stage={status:'prepared',provider:'chatgpt',conversation_id:'session-1',
  llm_diff:'BATCH DIFF | 1 files\nCHANGED FILES',git_diff:'',
  files:[{status:'updated',path:'/Users/me/repos/example/src/file.ts'}],diff_tokens:44,original_tokens:800,
  estimator:'test',user_prompt:'Please fix the UI'};
const chrome={
 runtime:{getURL:path=>'chrome-extension://unit-test/'+path,onMessage:{addListener(fn){handlers.push(fn)}},reload(){}},
 alarms:{onAlarm:{addListener(){}},async create(){}},
 tabs:{async query(){return[conversation]},async get(id){return id===3?conversation:null},
   async update(id,args){actions.push(['tab-update',id,args]);}},
 windows:{async getAll(){return [{id:1,focused:true,type:'normal',tabs:[conversation]}]},
   async create(arg){actions.push(['create',arg]);return{id:51}},async update(id,args){actions.push(['window-update',id,args])}},
 storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:saved[keys]};return {...keys,...saved}},
   async set(values){Object.assign(saved,values)},async remove(key){delete saved[key]}},
   session:{async get(key){return{[key]:sessionSaved[key]}},async set(data){Object.assign(sessionSaved,data)}}},
 action:{async setBadgeText(){},async setBadgeBackgroundColor(){}}
};
globalThis.chrome=chrome;
globalThis.fetch=async(url,opts={})=>{
 if(url.startsWith('chrome-extension://'))return {ok:false};
 if(url.includes('/api/v1/chat-sessions/delivery?'))return Response.json(stage);
 if(url.endsWith('/api/v1/chat-sessions/delivery')&&opts.method==='POST')return Response.json({status:'sent'});
 throw Error('Unexpected URL '+url);
};
await import('../chrome/background.js?manual-handoff-test');
const call=(type,payload={},sender={tab:{id:9,url:'http://127.0.0.1:5173/'},url:'http://127.0.0.1:5173/'})=>
 new Promise(resolve=>handlers[0]({type,payload,...(type.includes('preview')||type.startsWith('mark-manual')?payload:{})},sender,resolve));
const fromPreview={url:'chrome-extension://unit-test/session-preview.html?provider=chatgpt&conversation_id=session-1'};
test('session selection does not inspect or extract chat content',async()=>{
 const listed=await call('list-sessions');
 assert.equal(listed.ok,true);assert.equal(listed.result.sessions.length,1);
 assert.equal(listed.result.sessions[0].title,'Task Title');
});
test('dashboard stages a prompt, opens only an extension-owned popup, never sends',async()=>{
 const response=await call('deliver-session',{tab_id:3,delivery_id:deliveryId,diff_tokens:44,original_tokens:800,
   estimator:'test',repo_path:'/Users/me/repos/example',compression_enabled:false});
 assert.equal(response.ok,true);assert.equal(response.result.status,'unconfirmed');
 assert.equal(saved['manual-preview:chatgpt:session-1'].status,'ready');
 const popup=actions.find(a=>a[0]==='create');assert.equal(popup[1].type,'popup');
 assert.ok(popup[1].url.startsWith('chrome-extension://unit-test/session-preview.html'));
 assert.equal(actions.filter(a=>a[0]==='tab-update').length,0);
});
test('preview requires an extension page and shows text for copying',async()=>{
 const unauthorized=await call('get-session-preview',{provider:'chatgpt',conversation_id:'session-1'});
 assert.equal(unauthorized.ok,false);
 const r=await call('get-session-preview',{provider:'chatgpt',conversation_id:'session-1'},fromPreview);
 assert.equal(r.ok,true);assert.match(r.result.prompt,/^USER REQUEST\nPlease fix the UI/);
 assert.match(r.result.prompt,/BATCH DIFF/);
});
test('manual confirmation is the ONLY trigger for recording sent/responded',async()=>{
 assert.equal(saved['manual-preview:chatgpt:session-1'].status,'ready');
 const sent=await call('mark-manual-sent',{provider:'chatgpt',conversation_id:'session-1'},fromPreview);
 assert.equal(sent.ok,true);assert.equal(saved['manual-preview:chatgpt:session-1'].status,'sent');
 const response=await call('mark-manual-responded',{provider:'chatgpt',conversation_id:'session-1',patch_url:'https://example.com/patch.zip'},fromPreview);
 assert.equal(response.ok,true);assert.equal(saved['manual-preview:chatgpt:session-1'].status,'responded');
 assert.equal(saved['manual-preview:chatgpt:session-1'].patch_url,'https://example.com/patch.zip');
 const unsafe=await call('mark-manual-responded',{provider:'chatgpt',conversation_id:'session-1',patch_url:'javascript:alert(1)'},fromPreview);
 assert.equal(unsafe.ok,false);
});
test('non-extension callers cannot mark a response',async()=>{
 const r=await call('mark-manual-responded',{provider:'chatgpt',conversation_id:'session-1'},
  {tab:conversation,url:'https://chatgpt.com/c/session-1'});
 assert.equal(r.ok,false);
});
