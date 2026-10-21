import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source=readFileSync(join(fileURLToPath(new URL('..',import.meta.url)), 'chrome/response-monitor.js'),'utf8');

test('detects completed answer and its patch ZIP; does not count old answer', async()=>{
  const messages=[];
  const handlers=[];
  let timestamp=1000;
  let ticker;
  const old={innerText:'Previous response',querySelectorAll(){return []}};
  const patch={href:'https://chatgpt.com/backend-api/files/output.zip',innerText:'Download Git patch ZIP'};
  const next={innerText:'I have generated the patch.',querySelectorAll(){return [patch]}};
  let assistant=[old];
  const document={
    querySelectorAll(){return assistant;},
    querySelector(){return null;},
    addEventListener(){},
  };
  const chrome={runtime:{onMessage:{addListener(fn){handlers.push(fn)}},sendMessage(msg){messages.push(msg)}}};
  const location={hostname:'chatgpt.com',pathname:'/c/abc123'};
  class Clock extends Date { static now(){return timestamp;} }
  vm.runInNewContext(source,{document,chrome,location,Date:Clock,
    setInterval(fn){ticker=fn;return 1},clearInterval(){},console});
  let answer;
  handlers[0]({type:'monitor-assistant',payload:{provider:'chatgpt',conversation_id:'abc123',
    delivery_id:'a'.repeat(32),started_at:1000}},null,v=>{answer=v});
  assert.equal(answer.ok,true);
  ticker();timestamp+=6000;ticker();assert.equal(messages.length,0);
  assistant=[old,next];ticker();timestamp+=6000;ticker();
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,'assistant-response-complete');
  assert.equal(messages[0].payload.files[0].url,patch.href);
  assert.equal(messages[0].payload.response_ms,12000);
});
