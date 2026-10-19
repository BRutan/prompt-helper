// Path: frontend/upload-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadServer } from './upload-server.mjs';

test('writes timestamp-named UTF-8 input unchanged and returns only filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-helper-uploads-'));
  const server = createUploadServer(root);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const body = '// Path: project/hello.swift\nlet name = "é"\n';
    const response = await fetch(`http://127.0.0.1:${port}/upload/file`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body,
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.match(result.filename, /^\d{8}T\d{9}Z-[0-9a-f]{32}\.txt$/);
    assert.equal(result.bytes, Buffer.byteLength(body));
    assert.equal(await readFile(join(root, result.filename), 'utf8'), body);
    assert.deepEqual(await readdir(root), [result.filename]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsupported content type without creating a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-helper-uploads-'));
  const server = createUploadServer(root);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/upload/file`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
