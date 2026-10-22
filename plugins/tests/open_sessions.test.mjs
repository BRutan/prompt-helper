import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserConversation,openConversations,dashboardGeometry} from '../chrome/open-sessions.js';

const windows=[
  {id:10,type:'normal',tabs:[
    {id:1,windowId:10,url:'https://chatgpt.com/c/one',title:'One',active:false},
    {id:2,windowId:10,url:'https://claude.ai/chat/two',title:'Two',active:true},
  ]},
  {id:20,type:'normal',tabs:[
    {id:3,windowId:20,url:'https://chatgpt.com/c/three',title:'Three'},
    {id:4,windowId:20,url:'https://chatgpt.com/',title:'New Chat'},
  ]},
  {id:30,type:'popup',tabs:[
    {id:5,windowId:30,url:'https://claude.ai/new',title:'New Claude'},
  ]},
];
test('all conversations across normal and popup windows are listed, including inactive and new chats',()=>{
  const found=openConversations(windows);
  assert.deepEqual(found.map(t=>t.tab_id),[1,2,3,4,5]);
  assert.deepEqual(found.map(t=>t.window_id),[10,10,20,20,30]);
  assert.equal(found.filter(t=>t.provider==='chatgpt').length,3);
  assert.equal(found.filter(t=>t.provider==='claude').length,2);
  assert.equal(found.find(t=>t.tab_id===4).unsaved,true);
  assert.equal(found.find(t=>t.tab_id===1).active,false);
});
test('does not count plugin UI or unrelated websites, and does not duplicate fallback tab results',()=>{
  const found=openConversations(windows,[
    {id:1,windowId:10,url:'https://chatgpt.com/c/one'},
    {id:6,windowId:40,url:'https://example.com'},
    {id:7,windowId:50,url:'chrome-extension://abc/popup.html'},
  ]);
  assert.equal(found.length,5);
  assert.equal(browserConversation({id:6,url:'https://example.com'}),null);
});
test('dashboard geometry splits the current Chrome window and dashboard evenly',()=>{
  assert.deepEqual(dashboardGeometry({left:80,top:40,width:1601,height:900}),{
    chrome:{left:80,top:40,width:800,height:900},
    dashboard:{left:880,top:40,width:801,height:900},
  });
});
