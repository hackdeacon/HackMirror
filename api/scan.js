/**
 * Vercel Serverless Function: 同步扫描
 *
 * GET /api/scan?u=someuser&sort=recent&blue=1   （blue=1 只看蓝V，blue=0 不看蓝V）
 *
 * 限制：Vercel 免费版单次函数最长执行时间有限（Hobby 约 60s，Pro 300s）。
 * 万级账号可能超时，建议用 /api/scan-stream 或命令行版。
 */

import {
  normalizeHandle,
  runScan,
  buildResult,
  createClient,
} from '../lib/mirror-core.mjs';

const SELF = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('x') ?? '';
  } catch {
    return '';
  }
})();

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handle = normalizeHandle(url.searchParams.get('u') || url.searchParams.get('handle'));
  const sort = ['recent', 'big', 'small'].includes(url.searchParams.get('sort') || '')
    ? url.searchParams.get('sort')
    : 'recent';
  const blueParam = url.searchParams.get('blue');
  const blueOnly = blueParam === '1';
  const noBlue = blueParam === '0';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!handle) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error: 'invalid_handle',
        message: '需要 ?u=用户名，支持 @用户名 或 x.com/用户名',
      }),
    );
  }

  // Vercel 提供的取消信号（客户端断开时）
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on?.('close', onClose);

  const timeoutMs = Number(process.env.SCAN_TIMEOUT_MS) || 55_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runScan(handle, {
      signal: controller.signal,
      workers: Number(process.env.SCAN_WORKERS) || 4,
      rps: Number(process.env.SCAN_RPS) || 8,
      maxFollowing: Number(process.env.MAX_FOLLOWING) || 50000,
      maxFollowers: Number(process.env.MAX_FOLLOWERS) || 50000,
      userAgent: 'hackmirror-vercel/1.0',
    });

    const out = buildResult(result, sort);
    if (blueOnly) {
      out.notBack = out.notBack.filter((u) => u.verified);
      out.owe = out.owe.filter((u) => u.verified);
    } else if (noBlue) {
      out.notBack = out.notBack.filter((u) => !u.verified);
      out.owe = out.owe.filter((u) => !u.verified);
    }
    res.statusCode = 200;
    return res.end(JSON.stringify(out));
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    res.statusCode = aborted ? 504 : e?.name === 'UserError' ? 422 : 500;
    return res.end(
      JSON.stringify({
        error: aborted ? 'timeout' : e?.name === 'UserError' ? 'rejected' : 'failed',
        title: e?.title || (aborted ? '扫描超时' : '扫描失败'),
        message:
          e?.message ||
          (aborted
            ? '账号太大或接口较慢，Vercel 单次函数超时。请改用 /api/scan-stream 或命令行版。'
            : String(e)),
      }),
    );
  } finally {
    clearTimeout(timer);
    res.off?.('close', onClose);
  }
}
