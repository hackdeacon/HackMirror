/**
 * Vercel Serverless Function: 健康检查 / 配置探测
 *
 * GET /api/health
 * GET /api/health?probe=1&u=someuser   （实际请求一次上游接口）
 */

import { API, createClient } from '../lib/mirror-core.mjs';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const probe = url.searchParams.get('probe') === '1';
  const handle = url.searchParams.get('u') || 'someuser';

  const info = {
    ok: true,
    runtime: 'vercel-serverless',
    node: process.version,
    api: API,
    env: {
      SCAN_WORKERS: process.env.SCAN_WORKERS ?? null,
      SCAN_RPS: process.env.SCAN_RPS ?? null,
      SCAN_TIMEOUT_MS: process.env.SCAN_TIMEOUT_MS ?? null,
      MAX_FOLLOWING: process.env.MAX_FOLLOWING ?? null,
      MAX_FOLLOWERS: process.env.MAX_FOLLOWERS ?? null,
    },
  };

  if (probe) {
    const client = createClient({ rps: 4, userAgent: 'hackmirror-health/1.0' });
    const started = Date.now();
    try {
      const data = await client.apiGet(`/2/profile/${encodeURIComponent(handle)}`);
      info.probe = {
        ok: true,
        handle: data?.user?.screen_name,
        following: data?.user?.following,
        followers: data?.user?.followers,
        ms: Date.now() - started,
      };
    } catch (e) {
      info.ok = false;
      info.probe = { ok: false, error: e?.message || String(e), ms: Date.now() - started };
    }
  }

  res.statusCode = info.ok ? 200 : 503;
  return res.end(JSON.stringify(info, null, 2));
}
