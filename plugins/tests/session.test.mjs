import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromUrl, looksLikeSource, localBaseUrl } from '../chrome/session.js';

test('detects supported provider conversation IDs and ignores unrelated pages', () => {
  assert.deepEqual(sessionFromUrl('https://chatgpt.com/c/uuid-123'), { provider: 'chatgpt', conversation_id: 'uuid-123' });
  assert.deepEqual(sessionFromUrl('https://chat.openai.com/c/id_234'), { provider: 'chatgpt', conversation_id: 'id_234' });
  assert.deepEqual(sessionFromUrl('https://claude.ai/chat/a1b2c3'), { provider: 'claude', conversation_id: 'a1b2c3' });
  assert.deepEqual(sessionFromUrl('https://claude.ai/project/test/chat/a-b'), { provider: 'claude', conversation_id: 'a-b' });
  for (const url of ['https://chatgpt.com/', 'https://claude.ai/new', 'https://evil.com/c/id', 'http://chatgpt.com/c/id']) {
    assert.equal(sessionFromUrl(url), null);
  }
});

test('requires long source matching authoritative frame or Path header', () => {
  const frame = '================================================================================\nSOURCE_DIR: /repo\nFILE: src/app.py\n================================================================================\n\n' + 'x'.repeat(1100);
  assert.equal(looksLikeSource(frame), true);
  assert.equal(looksLikeSource('# Path: src/app.py\n' + 'x'.repeat(1100)), true);
  assert.equal(looksLikeSource('Here is a long unrelated chat: ' + 'x'.repeat(2000)), false);
  assert.equal(looksLikeSource('SOURCE_DIR: /repo\nFILE: x.py\n' + 'x'.repeat(1100)), false);
  assert.equal(looksLikeSource(frame, 2000), false);
});

test('rejects external, authenticated, or TLS endpoint URLs', () => {
  assert.equal(localBaseUrl('http://127.0.0.1:5173/foo'), 'http://127.0.0.1:5173');
  assert.equal(localBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  for (const endpoint of ['https://127.0.0.1:5173', 'http://evil.com', 'http://a@localhost:3000', 'file:///tmp/x', 'not a URL']) {
    assert.throws(() => localBaseUrl(endpoint));
  }
});
