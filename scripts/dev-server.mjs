/**
 * 本地开发用的小服务器（模拟 Vercel Functions）
 *
 *   node scripts/dev-server.mjs
 *
 * 只用于本地测试 /api/*，生产请用 `vercel dev` 或 `vercel --prod`。
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const routes = {
  '/api/health': join(root, 'api/health.js'),
  '/api/scan': join(root, 'api/scan.js'),
  '/api/scan-stream': join(root, 'api/scan-stream.js'),
};

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const file = routes[url.pathname];

  // CORS（前端可能在别的端口）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!file) {
    if (url.pathname === '/' || url.pathname === '') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(
        JSON.stringify(
          {
            ok: true,
            service: 'hackmirror dev server',
            routes: Object.keys(routes),
            examples: [
              '/api/health?probe=1&u=someuser',
              '/api/scan?u=someuser',
              '/api/scan-stream?u=someuser',
            ],
          },
          null,
          2,
        ),
      );
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  }

  try {
    const mod = await import(pathToFileURL(file).href);
    await mod.default(req, res);
  } catch (e) {
    console.error(e);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'internal', message: String(e?.message || e) }));
    }
  }
});

server.listen(port, host, () => {
  console.log(`dev server: http://${host}:${port}`);
  console.log(`  GET /api/health?probe=1&u=someuser`);
  console.log(`  GET /api/scan?u=someuser`);
  console.log(`  GET /api/scan-stream?u=someuser`);
});
