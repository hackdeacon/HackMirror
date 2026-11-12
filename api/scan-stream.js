/**
 * Vercel Serverless Function: 带进度的流式扫描（NDJSON）
 *
 * POST /api/scan-stream?u=someuser
 * GET  /api/scan-stream?u=someuser
 *
 * 响应按行返回 JSON（NDJSON）：
 *   {"type":"profile", ...}
 *   {"type":"progress","kind":"following","count":500,"expected":10392}
 *   {"type":"warn","message":"..."}
 *   {"type":"result","data":{...}}
 *   {"type":"error","message":"..."}
 *
 * 前端可用 fetch + ReadableStream 逐行读取，实时显示进度。
 */

import {
  normalizeHandle,
  createClient,
  fetchProfile,
  scanList,
  compareLists,
  buildResult,
  sortUsers,
} from '../lib/mirror-core.mjs';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handle = normalizeHandle(url.searchParams.get('u') || url.searchParams.get('handle'));
  const sort = ['recent', 'big', 'small', 'recent-big'].includes(url.searchParams.get('sort') || '')
    ? url.searchParams.get('sort')
    : 'recent';
  const blueParam = url.searchParams.get('blue');
  const blueOnly = blueParam === '1';
  const noBlue = blueParam === '0';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.statusCode = 200;

  const send = (obj) => {
    if (res.writableEnded) return false;
    res.write(JSON.stringify(obj) + '\n');
    return true;
  };

  if (!handle) {
    send({ type: 'error', title: '用户名无效', message: '需要 ?u=用户名' });
    return res.end();
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on?.('close', onClose);

  const timeoutMs = Number(process.env.SCAN_TIMEOUT_MS) || 280_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let lastSent = 0;
  let sent = new Map();

  const onProgress = ({ kind, count, expected }) => {
    const key = kind;
    const prev = sent.get(key) ?? -1;
    if (count === prev && count < expected) return;
    const now = Date.now();
    if (count < expected && now - lastSent < 400 && count - prev < 200) return;
    lastSent = now;
    sent.set(key, count);
    send({ type: 'progress', kind, count, expected });
  };

  try {
    const client = createClient({
      workers: undefined,
      rps: Number(process.env.SCAN_RPS) || 8,
      workersCount: Number(process.env.SCAN_WORKERS) || 4,
      userAgent: 'hackmirror-vercel/1.0',
    });

    const profile = await fetchProfile(client, handle, { signal: controller.signal });

    send({
      type: 'profile',
      profile: {
        id: profile.id,
        handle: profile.handle,
        name: profile.name,
        avatar: profile.avatar,
        followers: profile.followers,
        following: profile.following,
        joined: profile.joined,
        verified: profile.verified,
      },
    });

    if (profile.protected) {
      send({ type: 'error', title: '锁推账号', message: `@${profile.handle} 锁推了` });
      return res.end();
    }

    const workers = Number(process.env.SCAN_WORKERS) || 4;
    const [followingRes, followersRes] = await Promise.all([
      scanList(client, 'following', profile, {
        signal: controller.signal,
        workers,
        onProgress,
      }),
      scanList(client, 'followers', profile, {
        signal: controller.signal,
        workers,
        onProgress,
      }),
    ]);

    const following = [...followingRes.users.values()];
    const followers = [...followersRes.users.values()];
    const comp = compareLists(profile, following, followers);

    const result = {
      profile,
      ...comp,
      warnings: [...new Set(client.warnings)],
      stats: { ...client.stats },
      partial: followingRes.partial || followersRes.partial,
    };

    for (const w of result.warnings) send({ type: 'warn', message: w });

    const out = buildResult(result, sort);
    if (blueOnly) {
      out.notBack = out.notBack.filter((u) => u.verified);
      out.owe = out.owe.filter((u) => u.verified);
    } else if (noBlue) {
      out.notBack = out.notBack.filter((u) => !u.verified);
      out.owe = out.owe.filter((u) => !u.verified);
    }

    send({ type: 'result', data: out });
    return res.end();
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    send({
      type: 'error',
      title: aborted ? '扫描超时' : e?.title || '扫描失败',
      message: aborted
        ? 'Vercel 函数执行时间到达上限，账号太大请改用命令行版。'
        : e?.message || String(e),
    });
    return res.end();
  } finally {
    clearTimeout(timer);
    res.off?.('close', onClose);
  }
}
