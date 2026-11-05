#!/usr/bin/env node
// Local preview that resolves URLs the way GitHub Pages does: node _src/serve.mjs [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

const isFile = path => existsSync(path) && statSync(path).isFile();

function resolve(pathname) {
  const path = join(ROOT, normalize(decodeURIComponent(pathname)));
  if (!path.startsWith(ROOT)) return null;
  return [path, join(path, 'index.html'), `${path}.html`].find(isFile) ?? null;
}

createServer((req, res) => {
  const file = resolve(new URL(req.url, 'http://localhost').pathname);
  const target = file ?? join(ROOT, '404.html');
  res.writeHead(file ? 200 : 404, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}`));
