/**
 * npm start —— 一条命令同时启动前端和 API
 *
 *   npm start
 *   npm start -- --port=8090
 *
 * 不需要 python3，也不需要 Vercel CLI：
 *   前端  http://127.0.0.1:8080
 *   API   http://127.0.0.1:8787
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, extname, normalize, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const WEB_PORT = argValue('port', 8080);
const API_PORT = argValue('api-port', 8787);
const HOST = '127.0.0.1';

const routes = {
  '/api/health': join(root, 'api/health.js'),
  '/api/scan': join(root, 'api/scan.js'),
  '/api/scan-stream': join(root, 'api/scan-stream.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// API 服务器
// ---------------------------------------------------------------------------

const apiServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const file = routes[url.pathname];
  if (!file) {
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

// ---------------------------------------------------------------------------
// 静态服务器（同时把 /api/* 代理到 API 端口）
// ---------------------------------------------------------------------------

function proxyApi(req, res) {
  const upstream = http.request(
    {
      host: HOST,
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'api_unavailable', message: String(e.message) }));
  });
  req.pipe(upstream);
}

const webServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) return proxyApi(req, res);

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(webDir, safe);

  if (!file.startsWith(webDir)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`${label} 端口 ${port} 已被占用，用 --port / --api-port 换一个`));
      } else reject(e);
    });
    server.listen(port, HOST, () => resolve());
  });
}

try {
  await listen(apiServer, API_PORT, 'API');
  await listen(webServer, WEB_PORT, '前端');

  const target = `http://${HOST}:${WEB_PORT}/?scan=http://${HOST}:${WEB_PORT}/api/scan-stream`;

  console.log('');
  console.log('  HackMirror已启动');
  console.log(`  前端  http://${HOST}:${WEB_PORT}`);
  console.log(`  API   http://${HOST}:${WEB_PORT}/api/*`);
  console.log('');
  console.log(`  打开：${target}`);
  console.log('');
  console.log('  Ctrl+C 停止');
  console.log('');
} catch (e) {
  console.error(`\n启动失败：${e.message}\n`);
  process.exit(1);
}

const shutdown = () => {
  apiServer.close();
  webServer.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
