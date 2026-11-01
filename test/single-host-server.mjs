// Minimal HTTP server for dist-single/ (just index.html) used by
// single-host-e2e.mjs. Not part of the shipped bundle.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', process.env.SERVE_DIR || 'dist-single');
const PORT = Number(process.env.STATIC_PORT || 8099);

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
  const target = path.join(ROOT, pathname);
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`single-host preview on http://127.0.0.1:${PORT}`);
});
