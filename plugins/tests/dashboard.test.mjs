import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {compressGitDiff,normalizeGitDiffPaths} from '../chrome/symbol-compression.js';
globalThis.crypto ??= webcrypto;
const handlers=[];
const stored={};
let acknowledged=false;
let browserConfirmed=true;
let observedMessage='';
const tabs=[
  {id:3,windowId:1,active:false,title:'A',url:'https://chatgpt.com/c/session-1'},
  {id:4,windowId:2,active:true,title:'B',url:'https://claude.ai/chat/session-2'},
  {id:5,windowId:2,active:false,title:'Home',url:'https://claude.ai/'},
];
globalThis.chrome={
  runtime:{onMessage:{addListener(fn){handlers.push(fn)}},lastError:null},
  tabs:{async query(){return tabs},async get(id){return tabs.find(t=>t.id===id)},
    async create({url}){const t={id:9,url,title:'New conversation'};tabs.push(t);return t},
    async sendMessage(_id,body){observedMessage=body.payload.text;assert.match(body.payload.text,/^USER REQUEST\nPlease fix the UI/);if(!body.payload.text.includes('SYMBOL-COMPRESSED GIT DIFF'))assert.match(body.payload.text,/BATCH DIFF/);return {ok:true,result:{confirmed:browserConfirmed}}}},
  windows:{async get(){return {focused:true}}},
  storage:{local:{async get(defaults){if(typeof defaults==='string')return {[defaults]:stored[defaults]};return {...defaults,...stored}},async set(obj){Object.assign(stored,obj)},async remove(key){delete stored[key]}}},
  action:{async setBadgeText(){},async setBadgeBackgroundColor(){}}
};
globalThis.fetch=async (url,options={})=>{
  if(url.includes('/api/v1/chat-sessions/delivery?'))return Response.json({status:'prepared',provider:'chatgpt',conversation_id:'session-1',llm_diff:'BATCH DIFF | 1 files\nCHANGED FILES',git_diff:'--- a//Users/me/repos/example/src/file.ts\n+++ b//Users/me/repos/example/src/file.ts\n@@ -1 +1,2 @@\n-const veryLongIdentifierName = 1;\n+const veryLongIdentifierName = 2;\n+console.log(veryLongIdentifierName + veryLongIdentifierName);\n',files:[{status:'updated',path:'/Users/me/repos/example/src/file.ts'}],diff_tokens:44,original_tokens:800,estimator:'test',user_prompt:'Please fix the UI'});
  if(url.endsWith('/api/v1/chat-sessions/delivery') && options.method==='POST'){
    acknowledged=true;const sentBody=JSON.parse(options.body);assert.match(sentBody.delivery_id,/^[ab]{32}$/);assert.equal(sentBody.diff_tokens,44);assert.equal(sentBody.original_tokens,800);assert.equal(sentBody.estimator,'test');
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
  const out=await call('deliver-session',{tab_id:3,delivery_id:'a'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test',repo_path:'/Users/me/repos/example'});
  assert.equal(out.ok,true);assert.equal(out.result.status,'sent');assert.equal(acknowledged,true);
});
test('rejects conversation id mismatch',async()=>{
  acknowledged=false;
  const out=await call('deliver-session',{tab_id:4,delivery_id:'a'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test',repo_path:'/Users/me/repos/example'});
  assert.equal(out.ok,false);assert.equal(acknowledged,false);
});

test('extension settings and dashboard share compression toggle and verify reversible delivery',async()=>{
  const s=await call('set-symbol-compression',{enabled:true});assert.equal(s.ok,true);
  const st=await call('symbol-settings',{provider:'chatgpt',conversation_id:'session-1'});
  assert.equal(st.result.enabled,true);
  const raw='--- a//Users/me/repos/example/src/file.ts\n+++ b//Users/me/repos/example/src/file.ts\n@@ -1 +1,2 @@\n-const veryLongIdentifierName = 1;\n+const veryLongIdentifierName = 2;\n+console.log(veryLongIdentifierName + veryLongIdentifierName);\n';
  const gitDiff=normalizeGitDiffPaths(raw,[{path:'/Users/me/repos/example/src/file.ts'}],'/Users/me/repos/example');
  const result=compressGitDiff(gitDiff,st.result.registry,s=>s.length);
  assert.ok(result.active);
  browserConfirmed=false;
  const params={tab_id:3,delivery_id:'b'.repeat(32),diff_tokens:44,original_tokens:800,estimator:'test',repo_path:'/Users/me/repos/example',
    compression_enabled:true,compressed_diff:result.diff,symbol_registry:result.registry};
  const sent=await call('deliver-session',params);
  assert.equal(sent.ok,true);
  assert.equal(sent.result.status,'unconfirmed');
  assert.match(observedMessage,/SYMBOL-COMPRESSED GIT DIFF/);
  assert.match(observedMessage,/\+\+\+ b\/src\/file.ts/);
  assert.equal(stored['symbol-registry:chatgpt:session-1'],undefined,'Never commit aliases before confirmation');
  browserConfirmed=true;
  const confirmed=await call('deliver-session',params);
  assert.equal(confirmed.ok,true);
  assert.equal(confirmed.result.status,'sent');
  assert.deepEqual(stored['symbol-registry:chatgpt:session-1'],result.registry);
  assert.equal(stored['patch-delivery:'+params.delivery_id].symbol_registry['src/file.ts'][result.registry['src/file.ts'].veryLongIdentifierName], 'veryLongIdentifierName');
  const unset=await call('set-symbol-compression',{enabled:false});assert.equal(unset.ok,true);
});
