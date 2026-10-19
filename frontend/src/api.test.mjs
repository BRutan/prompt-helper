import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetchJSON } from './api.js';

async function withMockResponse(response, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { await callback(); } finally { globalThis.fetch = original; }
}

test('accepts valid JSON API response', async () => {
  await withMockResponse(Response.json({ total: 84 }), async () => {
    assert.deepEqual(await apiFetchJSON('/api/v1/files/batch-diff'), { total: 84 });
  });
});

test('surfaces batch endpoint 404 instead of Safari generic string error', async () => {
  await withMockResponse(new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } }), async () => {
    await assert.rejects(apiFetchJSON('/api/v1/files/batch-diff', { method: 'POST' }), err =>
      err.message.includes('HTTP 404') && err.message.includes('batch endpoint is missing') && err.message.includes('404 page not found'));
  });
});

test('surfaces proxy HTML 502 and includes logs guidance', async () => {
  await withMockResponse(new Response('<html><h1>Bad Gateway</h1></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), async () => {
    await assert.rejects(apiFetchJSON('/api/v1/files/batch-diff', { method: 'POST' }), err =>
      err.message.includes('HTTP 502') && err.message.includes('Bad Gateway') && err.message.includes('docker compose logs'));
  });
});

test('preserves structured JSON API validation failures', async () => {
  await withMockResponse(Response.json({ error: 'section 12: invalid Path' }, { status: 422 }), async () => {
    await assert.rejects(apiFetchJSON('/api/v1/files/batch-diff', { method: 'POST' }), /HTTP 422: section 12: invalid Path/);
  });
});

test('does not mistake a successful HTML response for JSON', async () => {
  await withMockResponse(new Response('<html>SPA index</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), async () => {
    await assert.rejects(apiFetchJSON('/api/v1/files/batch-diff'), /HTTP 200.*text\/html instead of JSON/);
  });
});

test('reports malformed JSON and network errors with request context', async () => {
  await withMockResponse(new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }), async () => {
    await assert.rejects(apiFetchJSON('/api/v1/files'), /HTTP 200 returned invalid JSON/);
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('The string did not match the expected pattern.'); };
  try {
    await assert.rejects(apiFetchJSON('/api/v1/files'), /failed before receiving an HTTP response/);
  } finally { globalThis.fetch = original; }
});
