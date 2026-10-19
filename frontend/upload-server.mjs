// Path: frontend/upload-server.mjs
// Lightweight upload writer colocated with nginx in the frontend container.
// POST /upload/file writes a timestamped UTF-8 source file to shared /data/uploads.
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const defaultDirectory = process.env.UPLOAD_DIR || '/data/uploads';

function respond(res, status, result) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
}

export function createUploadServer(directory = defaultDirectory) {
  return createServer(async (req, res) => {
    if (req.url === '/upload/health' && req.method === 'GET') {
      respond(res, 200, { status: 'ok' });
      return;
    }
    if (req.url !== '/upload/file') {
      respond(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      respond(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!/^text\/plain(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
      respond(res, 415, { error: 'send source text as text/plain; charset=utf-8' });
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const filename = `${stamp}-${randomUUID().replace(/-/g, '')}.txt`;
    const destination = join(directory, filename);
    const temporary = `${destination}.partial`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      // Stream to disk rather than allocating another full input-sized buffer.
      await pipeline(req, createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
      await rename(temporary, destination);
      const info = await stat(destination);
      respond(res, 201, { filename, bytes: info.size });
      console.info(`upload saved filename=${filename} bytes=${info.size}`);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      console.error(`upload failed filename=${filename}:`, error);
      respond(res, 500, { error: `Could not save upload: ${error.message}` });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = createUploadServer();
  server.listen(8081, '127.0.0.1', () => {
    console.info(`prompt-helper upload writer listening on 127.0.0.1:8081, dir=${defaultDirectory}`);
  });
}
