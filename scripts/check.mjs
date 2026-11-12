/**
 * 诊断脚本（本地运行，不需要 Vercel）
 *
 *   node scripts/check.mjs
 *   node scripts/check.mjs someuser
 *   node scripts/check.mjs someuser https://api.fxtwitter.com
 *
 * 逐项检查 3 个必需接口是否可用，并报告耗时。
 */

import { API, createClient, fetchProfile, scanList, normalizeHandle } from '../lib/mirror-core.mjs';

const argHandle = process.argv[2] || 'someuser';
const argBase = process.argv[3] || API;
const handle = normalizeHandle(argHandle);

if (!handle) {
  console.error('用户名不合法：', argHandle);
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');

console.log(`\nHackMirror 接口诊断`);
console.log(`  handle : @${handle}`);
console.log(`  base   : ${argBase}\n`);

const client = createClient({ base: argBase, rps: 6, userAgent: 'hackmirror-check/1.0' });

// 1. /2/profile/{handle}
let profile = null;
let t0 = Date.now();
try {
  profile = await fetchProfile(client, handle);
  console.log(`${ok(true)} ${pad('GET /2/profile/{handle}', 32)} ${Date.now() - t0}ms`);
  console.log(`      @${profile.handle}  关注 ${profile.following} · 粉丝 ${profile.followers}`);
  console.log(`      注册 ${profile.joined?.slice(0, 10) || '未知'}${profile.verified ? ' · 蓝V' : ''}${profile.protected ? ' · 锁推' : ''}`);
} catch (e) {
  console.log(`${ok(false)} ${pad('GET /2/profile/{handle}', 32)} ${e?.message || e}`);
  console.log(`\n资料接口不可用，后续检查跳过。`);
  process.exit(1);
}

// 2 & 3. 名单接口，各抓一页
for (const kind of ['following', 'followers']) {
  t0 = Date.now();
  const expected = kind === 'following' ? profile.following : profile.followers;
  const label = kind === 'following' ? '关注' : '粉丝';
  try {
    const res = await scanList(client, kind, profile, {
      workers: 1,
      onProgress: () => {},
      // 只取一页：把 maxPages 压到最小
      maxPages: 3,
    });
    const n = res.users.size;
    const good = n > 0;
    console.log(
      `${ok(good)} ${pad(`GET /2/profile/{handle}/${kind}`, 32)} ${Date.now() - t0}ms`,
    );
    console.log(`      抓到 ${n} / ${expected} ${label}`);
  } catch (e) {
    console.log(`${ok(false)} ${pad(`GET /2/profile/{handle}/${kind}`, 32)} ${e?.message || e}`);
  }
}

console.log(`\n请求数 ${client.stats.requests} · 重试 ${client.stats.retries}`);
for (const w of new Set(client.warnings)) console.log(`⚠ ${w}`);
console.log('');
