import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto;
const handlers = {};
const saved = new Map();
let focused = true;
const active = { id: 5, windowId: 1, active: true, url: 'https://chatgpt.com/c/abc-123' };
const queries = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener(handler) { handlers.message = handler; } } },
  storage: {
    local: { async get(defaults) { return defaults; }, async set() {} },
    session: {
      async set(data) { for (const [k, v] of Object.entries(data)) saved.set(k, v); },
      async get(key) { return { [key]: saved.get(key) }; }
    }
  },
  windows: { async get() { return { focused }; } },
  tabs: { async query() { return [active]; } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
};
globalThis.fetch = async (url, options) => {
  queries.push({ url, options });
  return Response.json({ status: 'updated', total: 1, changed: 1, unchanged: 0,
    additions: 2, deletions: 1, llm_diff: 'incremental patch',
    session_diff: { llm_diff: 'cumulative session patch' } });
};
await import('../chrome/background.js');
async function message(type, data = {}, sender = { tab: active, url: active.url }) {
  return new Promise(resolve => handlers.message({ type, ...data }, sender, resolve));
}

test('accepts only active focused supported conversation and produces session diff', async () => {
  const content = '# Path: src/app.py\n' + 'a'.repeat(1100);
  const response = await message('process-source', { content });
  assert.equal(response.ok, true);
  assert.equal(response.result.replacement_text, 'incremental patch');
  assert.equal(response.result.session_diff, 'cumulative session patch');
  assert.deepEqual(JSON.parse(queries[0].options.body), { provider: 'chatgpt', conversation_id: 'abc-123', content });
  const again = await message('process-source', { content });
  assert.equal(again.ok, true);
  assert.equal(queries.length, 1, 'duplicate input is not submitted twice');
  const state = await message('get-status');
  assert.equal(state.result.state.changed, 1);
});

test('unfocused Chrome window cannot send source', async () => {
  focused = false;
  const result = await message('process-source', { content: '# Path: src/app.py\n' + 'b'.repeat(1100) });
  assert.equal(result.ok, false);
  assert.match(result.error, /active, focused/);
  focused = true;
});

test('different conversation has an independent session', async () => {
  active.url = 'https://claude.ai/chat/another-12';
  const result = await message('process-source', { content: '# Path: src/app.py\n' + 'a'.repeat(1100) });
  assert.equal(result.ok, true);
  assert.equal(queries.length, 2);
  assert.equal(JSON.parse(queries[1].options.body).provider, 'claude');
});
