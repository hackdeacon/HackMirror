/**
 * 命令行版（基于 lib/mirror-core.mjs，与 Vercel API 共用逻辑）
 *
 * 用法：
 *   node mirror.mjs <用户名|主页链接> [选项]
 *
 * 例：
 *   node mirror.mjs someuser
 *   node mirror.mjs @someuser --blue --sort big
  node mirror.mjs @someuser --no-blue
 *   node mirror.mjs someuser --limit 0 --json out.json
 *   node mirror.mjs someuser --api https://api.example.com
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  API,
  normalizeHandle,
  fmt,
  compact,
  pct,
  runScan,
  buildResult,
  sortUsers,
  orderMid,
} from './lib/mirror-core.mjs';

const TWITTER = 'https://x.com';

function filterBlue(list, opts) {
  if (opts.blue) return list.filter((u) => u.verified);
  if (opts.noBlue) return list.filter((u) => !u.verified);
  return list;
}

function blueLabel(opts) {
  if (opts.blue) return '（只看蓝V）';
  if (opts.noBlue) return '（不看蓝V）';
  return '';
}

function userRow(u, i) {
  const badge = u.verified ? ' ✓' : '';
  const name = String(u.name || u.handle).slice(0, 30);
  return `${String(i + 1).padStart(4)}. @${u.handle}  ${name}${badge} · ${compact(u.followers)}粉`;
}

function printSection(title, list, opts) {
  const filtered = filterBlue(list, opts);
  const sorted = sortUsers(filtered, opts.sort);
  const shown = opts.limit > 0 ? sorted.slice(0, opts.limit) : sorted;
  const sortLabel =
    opts.sort === 'big' ? '粉丝多的在前' : opts.sort === 'small' ? '粉丝少的在前' : '按关注先后';
  console.log(`\n【${title}】${fmt(filtered.length)} 人${blueLabel(opts)} · ${sortLabel}`);
  if (!shown.length) {
    console.log('  （空）');
    return;
  }
  shown.forEach((u, i) => console.log(userRow(u, i)));
  if (shown.length < filtered.length) {
    console.log(`  … 还有 ${fmt(filtered.length - shown.length)} 人（--limit 0 显示全部）`);
  }
}

function toCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['list,id,handle,name,followers,verified'];
  for (const [list, users] of rows) {
    for (const u of users) {
      lines.push([list, u.id, u.handle, u.name, u.followers, u.verified ? 1 : 0].map(esc).join(','));
    }
  }
  return '\ufeff' + lines.join('\n') + '\n';
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      blue: { type: 'boolean', default: false },
      'no-blue': { type: 'boolean', default: false },
      sort: { type: 'string', default: 'recent' },
      limit: { type: 'string', default: '40' },
      workers: { type: 'string', default: '4' },
      rps: { type: 'string', default: '8' },
      api: { type: 'string' },
      json: { type: 'string' },
      csv: { type: 'string' },
      'cache-dir': { type: 'string', default: '.mirror-cache' },
      'cache-ttl': { type: 'string', default: '30' },
      refresh: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'max-following': { type: 'string', default: '50000' },
      'max-followers': { type: 'string', default: '50000' },
      'max-pages': { type: 'string', default: '5000' },
      timeout: { type: 'string', default: '20000' },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`HackMirror（本地版）

用法:
  node mirror.mjs <用户名|主页链接> [选项]

示例:
  node mirror.mjs someuser
  node mirror.mjs @someuser --blue --sort big
  node mirror.mjs someuser --limit 0 --json result.json
  node mirror.mjs someuser --api https://api.example.com

选项:
  --blue                 只看蓝V
  --no-blue              不看蓝V（只列非蓝V）
  --sort <recent|big|small>  关注先后（默认）/ 粉丝多在前 / 粉丝少在前
  --limit <n>            每栏显示前 n 条，0 = 全部，默认 40
  --workers <n>          每份名单并发数，默认 4
  --rps <n>              全局限速（请求/秒），默认 8
  --api <url>            覆盖 API 地址，默认 ${API}
  --json <path>          导出完整 JSON
  --csv <path>           导出 CSV
  --refresh              忽略缓存
  --no-cache             不读不写缓存
  --cache-dir <path>     缓存目录，默认 .mirror-cache
  --cache-ttl <分钟>     缓存有效期，默认 30
  --max-following <n>    关注数上限，默认 50000，0 = 不限
  --max-followers <n>    粉丝数上限，默认 50000，0 = 不限
  --max-pages <n>        单份名单最多请求页数，默认 5000
  --timeout <ms>         单请求超时，默认 20000
  --quiet                不显示进度
  -h, --help             显示帮助

部署到 Vercel:
  vercel deploy          首次需要登录并 link 项目
  然后访问 https://<项目>.vercel.app/api/scan?u=用户名
`);
    return;
  }

  const handle = normalizeHandle(positionals[0]);
  if (!handle) {
    console.error('用户名不合法：请输入 X 用户名或主页链接。');
    process.exitCode = 2;
    return;
  }

  const opts = {
    blue: values.blue && !values['no-blue'],
    noBlue: values['no-blue'] && !values.blue,
    sort: ['recent', 'big', 'small'].includes(values.sort) ? values.sort : 'recent',
    limit: Math.max(0, parseInt(values.limit, 10) || 0),
    workers: Math.min(16, Math.max(1, parseInt(values.workers, 10) || 4)),
    rps: Math.max(0, Number(values.rps) || 0),
    api: (values.api || API).replace(/\/$/, ''),
    json: values.json,
    csv: values.csv,
    cacheDir: values['cache-dir'],
    cacheTtl: Number.isFinite(Number(values['cache-ttl'])) ? Number(values['cache-ttl']) : 30,
    refresh: values.refresh,
    noCache: values['no-cache'],
    maxFollowing: Math.max(0, parseInt(values['max-following'], 10) || 0),
    maxFollowers: Math.max(0, parseInt(values['max-followers'], 10) || 0),
    maxPages: Math.max(1, parseInt(values['max-pages'], 10) || 5000),
    timeout: Math.max(1000, parseInt(values.timeout, 10) || 20000),
    quiet: values.quiet,
  };

  const started = Date.now();

  // 缓存
  const cacheKey = `${handle.toLowerCase()}@${new URL(opts.api).host}`;
  const cacheFile = join(opts.cacheDir, `${cacheKey.replace(/[^a-z0-9@.-]/gi, '_')}.json`);

  if (!opts.noCache && !opts.refresh) {
    try {
      const raw = await readFile(cacheFile, 'utf8');
      const c = JSON.parse(raw);
      if (Date.now() - c.at < opts.cacheTtl * 60_000) {
        if (!opts.quiet) {
          console.error(`使用缓存（${new Date(c.at).toLocaleString()}，--refresh 可重抓）`);
        }
        printSummary(c.result, opts);
        return;
      }
    } catch {}
  }

  const finished = new Set();
  const progress = (() => {
    let last = 0;
    let shown = '';
    return ({ kind, count, expected }) => {
      if (opts.quiet) return;
      if (finished.has(kind)) return;
      const now = Date.now();
      const done = expected > 0 && count >= expected;
      if (done) finished.add(kind);
      if (!done && now - last < 800) return;
      last = now;
      const label = kind === 'following' ? '关注' : '粉丝';
      const p = expected > 0 ? Math.floor((count / expected) * 100) : 0;
      const line = `照妖中… ${label} ${fmt(count)}/${fmt(expected)} (${p}%)`;
      if (line === shown) return;
      shown = line;
      if (process.stderr.isTTY) {
        process.stderr.write(`\r\x1b[2K${line}`);
        if (done) process.stderr.write('\n');
      } else {
        process.stderr.write(line + '\n');
      }
    };
  })();

  let result;
  try {
    result = await runScan(handle, {
      workers: opts.workers,
      rps: opts.rps,
      base: opts.api,
      timeout: opts.timeout,
      maxFollowing: opts.maxFollowing,
      maxFollowers: opts.maxFollowers,
      maxPages: opts.maxPages,
      onProgress: progress,
      userAgent: 'hackmirror-cli/1.0',
    });
  } catch (e) {
    if (!opts.quiet) process.stderr.write('\r\x1b[2K');
    console.error(`\n出错了：${e?.message || e}`);
    process.exitCode = 1;
    return;
  }

  if (!opts.quiet) process.stderr.write('\r\x1b[2K');

  const payload = buildResult(result, opts.sort);

  // 写缓存
  if (!opts.noCache) {
    try {
      await mkdir(opts.cacheDir, { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ at: Date.now(), result: payload }));
    } catch {}
  }

  printSummary(payload, opts);

  if (opts.json) {
    await mkdir(dirname(opts.json), { recursive: true });
    await writeFile(opts.json, JSON.stringify(payload, null, 2));
    console.log(`\nJSON 已写入 ${opts.json}`);
  }
  if (opts.csv) {
    await mkdir(dirname(opts.csv), { recursive: true });
    await writeFile(
      opts.csv,
      toCsv([
        ['notBack', sortUsers(result.notBack, opts.sort)],
        ['owe', sortUsers(result.owe, opts.sort)],
      ]),
    );
    console.log(`CSV 已写入 ${opts.csv}`);
  }

  if (!opts.quiet) {
    console.error(`\n完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒 · ${payload.stats.requests} 次请求`);
  }
}

function printSummary(payload, opts) {
  const s = payload.stats;
  const p = payload.profile;

  console.log(`\n@${p.handle}  ${p.name}${p.verified ? ' ✓' : ''}`);
  console.log(
    `关注 ${fmt(p.following)} · 粉丝 ${fmt(p.followers)} · 抓到 关注 ${fmt(s.following)} / 粉丝 ${fmt(s.followers)}`,
  );
  console.log(
    `互关 ${fmt(s.mutual)} · 回关率 ${pct(s.rate)} · 没回关你 ${fmt(s.notBack)} · 你没回关 ${fmt(s.owe)}`,
  );
  if (s.missingFollowing || s.missingFollowers) {
    console.log(
      `ℹ 资料人数含被封/注销号或接口未返回：关注少 ${fmt(s.missingFollowing)}，粉丝少 ${fmt(s.missingFollowers)}。`,
    );
  }
  if (opts.blue) {
    console.log(`蓝V：没回关你 ${fmt(s.notBackBlue)} · 你没回关 ${fmt(s.oweBlue)}`);
  }
  if (opts.noBlue) {
    console.log(`非蓝V：没回关你 ${fmt(s.notBack - s.notBackBlue)} · 你没回关 ${fmt(s.owe - s.oweBlue)}`);
  }
  if (s.followingCoverage < 0.9) {
    console.log(`⚠ 关注名单覆盖 ${pct(s.followingCoverage)}，可能有限流或被封号。`);
  }
  if (s.followersCoverage < 0.9) {
    console.log(`⚠ 粉丝名单覆盖 ${pct(s.followersCoverage)}，可能有限流或被封号。`);
  }
  for (const w of new Set(payload.warnings || [])) console.log(`⚠ ${w}`);

  const blue = (list) => (opts.blue ? { length: list.filter((u) => u.verified).length } : null);

  printSectionFromJson('没回关你', payload.notBack, opts);
  printSectionFromJson('你没回关', payload.owe, opts);
}

function printSectionFromJson(title, list, opts) {
  const filtered = filterBlue(list, opts);
  const sortLabel =
    opts.sort === 'big' ? '粉丝多的在前' : opts.sort === 'small' ? '粉丝少的在前' : '按关注先后';
  const shown = opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered;
  console.log(`\n【${title}】${fmt(filtered.length)} 人${blueLabel(opts)} · ${sortLabel}`);
  if (!shown.length) {
    console.log('  （空）');
    return;
  }
  shown.forEach((u, i) => {
    const badge = u.verified ? ' ✓' : '';
    const name = String(u.name || u.handle).slice(0, 30);
    console.log(`${String(i + 1).padStart(4)}. @${u.handle}  ${name}${badge} · ${compact(u.followers)}粉`);
  });
  if (shown.length < filtered.length) {
    console.log(`  … 还有 ${fmt(filtered.length - shown.length)} 人（--limit 0 显示全部）`);
  }
}

main().catch((e) => {
  console.error(`\n出错了：${e?.message || e}`);
  process.exitCode = 1;
});
