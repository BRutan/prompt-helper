import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const js=readFileSync(new URL('../chrome/background.js',import.meta.url),'utf8');
test('background includes only a manual ChatGPT handoff',()=>{
  assert.match(js,/openSessionPreview/);
  assert.match(js,/markManualSent/);
  assert.match(js,/markManualResponded/);
  assert.doesNotMatch(js,/chrome\.tabs\.sendMessage\(|chrome\.downloads\.|chrome\.scripting\.|sendPatchError|downloadPatch|processPaste/);
});
test('previews are fetched from own backend and cannot be created from arbitrary sites',()=>{
  assert.match(js,/const stage=await api\('/);
  assert.match(js,/startsWith\(chrome\.runtime\.getURL\('session-preview\.html'\)\)/);
  assert.match(js,/Manual-only|manually sent|manual copy|manual/i);
});
