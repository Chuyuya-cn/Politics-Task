// Serves dist/ over HTTP so the static build can be exercised exactly as a
// hosted site would be (same-origin http, not file://). Used by the static E2E
// test; not part of the shipped bundle.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'dist');
const PORT = Number(process.env.STATIC_PORT || 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const target = path.join(ROOT, pathname);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const cache = pathname === '/content.json' || pathname.startsWith('/prompts/') || pathname === '/sw.js'
      ? 'no-cache'
      : 'public, max-age=60';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    // SPA fallback, mirroring the production server config.
    try {
      const body = await readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`static preview on http://127.0.0.1:${PORT}`);
});
