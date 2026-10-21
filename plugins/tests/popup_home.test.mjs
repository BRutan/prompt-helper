// Path: plugins/tests/popup_home.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../chrome/popup.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../chrome/popup.js',import.meta.url),'utf8');

function fakeElement(id='') {
  const handlers = new Map();
  const attrs = {};
  const classSet = new Set(['hidden']);
  return {id,handlers,attrs,children:[],textContent:'',value:'',checked:false,disabled:false,
    classList:{add:(x)=>classSet.add(x),toggle:(x,force)=>force?classSet.add(x):classSet.delete(x),
      contains:(x)=>classSet.has(x)},
    setAttribute:(k,v)=>attrs[k]=v,
    addEventListener:(name,handler)=>handlers.set(name,handler),
    replaceChildren(){this.children.length=0},
    append(...nodes){this.children.push(...nodes)},
    click(){return this.handlers.get('click')?.()},
  };
}
const nodes=new Map();
function $(id){if(!nodes.has(id))nodes.set(id,fakeElement(id));return nodes.get(id)}
const document={getElementById:$,createElement:()=>fakeElement(),body:fakeElement('body')};
const messages=[];
let enabled=true;
const chrome={runtime:{lastError:null,sendMessage:(req,done)=>{
  messages.push(req);
  if(req.type==='get-popup-config')done({ok:true,result:{enabled,minChars:1100,replaceOnPaste:true,symbolCompression:false}});
  else if(req.type==='set-enabled'){enabled=req.enabled;done({ok:true,result:{enabled}})}
  else if(req.type==='set-options')done({ok:true,result:req});
  else if(req.type==='get-open-sessions')done({ok:true,result:{sessions:[
    {provider:'chatgpt',conversation_id:'1',tab_id:3,window_id:9,title:'Chat A'},
    {provider:'claude',conversation_id:'2',tab_id:4,window_id:10,title:'Chat B'},
  ]}});
  else done({ok:true,result:{count:2}});
}}};
const location={search:''};
const window={screen:{availLeft:0,availTop:0,availWidth:1500,availHeight:900}};
Object.assign(globalThis,{document,chrome,location,window});
await import('../chrome/popup.js');

// Await the initial runtime.get-popup-config request and DOM updates.
await new Promise(resolve=>setImmediate(resolve));

test('home screen has only four buttons, no diff rendered or retrieved',()=>{
  const home=html.match(/<section id="home-view"[\s\S]*?<\/section>/)[0];
  const buttonIds=[...home.matchAll(/<button id="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(buttonIds,['sessions-button','settings-button','dashboard-button','enabled-toggle']);
  assert.ok(!/id="diff"|id="copy"|id="load"/.test(html));
  assert.ok(!/load-session|get-status|session_diff|llm_diff|clipboard/.test(script));
  assert.equal($('home-view').classList.contains('hidden'),false);
  assert.equal($('sessions-view').classList.contains('hidden'),true);
  assert.equal($('settings-view').classList.contains('hidden'),true);
  assert.deepEqual(messages.map(m=>m.type),['get-popup-config']);
});

test('sessions and settings are navigable in the popup, with Back actions',async()=>{
  await $('sessions-button').click();
  assert.equal($('sessions-view').classList.contains('hidden'),false);
  assert.equal($('chatgpt-count').textContent,'1');
  assert.equal($('claude-count').textContent,'1');
  await $('sessions-back').click();
  await $('settings-button').click();
  assert.equal($('settings-view').classList.contains('hidden'),false);
  assert.equal($('minimum').value,1100);
  await $('settings-back').click();
  assert.equal($('home-view').classList.contains('hidden'),false);
});

test('on/off is persisted through background and dashboard remains a home action',async()=>{
  await $('enabled-toggle').click();
  assert.equal(enabled,false);
  assert.equal($('enabled-state').textContent,'OFF');
  assert.equal($('enabled-toggle').attrs['aria-pressed'],'false');
  await $('enabled-toggle').click();
  assert.equal(enabled,true);
  assert.equal($('enabled-state').textContent,'ON');
  await $('dashboard-button').click();
  assert.equal(messages.at(-1).type,'open-dashboard-window');
});
