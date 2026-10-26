import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const root=new URL('../chrome/',import.meta.url);
test('manual-only manifest registers no ChatGPT or Claude content scripts',()=>{
  const m=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8'));
  assert.deepEqual(m.content_scripts.map(s=>s.matches),[['http://127.0.0.1/*','http://localhost/*']]);
  assert.ok(!m.permissions.includes('downloads'));
  assert.ok(!m.permissions.includes('scripting'));
  assert.ok(!m.host_permissions.some(s=>/chatgpt|openai|claude/.test(s)));
});
test('automatic submission/response monitoring modules no longer exist',()=>{
  for(const name of ['content.js','delivery-content.js','response-monitor.js','session-media-upload.js']){
    assert.equal(existsSync(new URL(name,root)),false,name);
  }
  const bg=readFileSync(new URL('background.js',root),'utf8');
  assert.doesNotMatch(bg,/chrome\.downloads\.|chrome\.scripting\.|chrome\.tabs\.sendMessage\(|report-patch-error|assistant-response-complete|click-assistant-patch/);
});
