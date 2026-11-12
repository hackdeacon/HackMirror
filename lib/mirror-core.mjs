/**
 * HackMirror · 共享核心逻辑
 *
 * 被两个入口复用：
 *   - api/scan.js        Vercel Serverless Function
 *   - mirror.mjs         命令行
 *
 * 只依赖 Node.js 内置模块（fetch / AbortController 等原生 API）。
 *
 * 用到的 FxTwitter 接口（仅这 3 个）：
 *   GET /2/profile/{handle}
 *   GET /2/profile/{handle}/following?cursor=<cursor>
 *   GET /2/profile/{handle}/followers?cursor=<cursor>
 */

export const API = 'https://api.fxtwitter.com';

const TWITTER_EPOCH = 1288834974657n;
const ID_SHIFT = 22n;
const MIN_SPLIT = 4194304000n; // 1 秒的 snowflake 跨度

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class UserError extends Error {
  constructor(title, message) {
    super(message);
    this.name = 'UserError';
    this.title = title;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function nowSnowflake() {
  return (BigInt(Date.now()) - TWITTER_EPOCH) << ID_SHIFT;
}

export function toSnowflake(ms) {
  const n = BigInt(Math.floor(ms));
  return n <= TWITTER_EPOCH ? 0n : (n - TWITTER_EPOCH) << ID_SHIFT;
}

export const minBig = (a, b) => (a < b ? a : b);
export const maxBig = (a, b) => (a > b ? a : b);

export function normalizeHandle(input) {
  let s = String(input ?? '').trim();
  const url = s.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  if (url) s = url[1];
  s = s.replace(/^@/, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}

export function fmt(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
}

export function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
  return fmt(n);
}

export function pct(x) {
  if (!Number.isFinite(x)) return '—';
  if (x >= 0.9995) return '100%';
  return (x * 100).toFixed(x === 0 ? 0 : 1).replace(/\.0$/, '') + '%';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    let timer = 0;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new AbortError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 限速 + 请求
// ---------------------------------------------------------------------------

export class Limiter {
  constructor(rps) {
    this.interval = rps > 0 ? 1000 / rps : 0;
    this.nextAt = 0;
  }
  async wait(signal) {
    if (!this.interval) return;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.interval;
    if (at > now) await sleep(at - now, signal);
  }
}

function retryAfterMs(value) {
  if (!value) return 0;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

/**
 * 创建一组带状态和限速的请求函数。
 */
export function createClient({
  base = API,
  rps = 8,
  timeout = 20000,
  userAgent = 'hackmirror/1.0',
} = {}) {
  const limiter = new Limiter(rps);
  const stats = { requests: 0, retries: 0 };
  const warnings = [];

  async function apiGet(path, { signal, retry404 = false } = {}) {
    const url = `${base}${path}`;
    const retries = 6;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new AbortError();
      await limiter.wait(signal);
      if (signal?.aborted) throw new AbortError();

      let res;
      try {
        res = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': userAgent },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        });
      } catch (e) {
        if (signal?.aborted) throw new AbortError();
        lastErr = e;
        if (attempt >= retries) break;
        stats.retries++;
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250, signal);
        continue;
      }

      const status = res.status;

      if (status === 404) {
        lastErr = new NotFoundError(`HTTP 404: ${path}`);
        if (!retry404) throw lastErr;
        if (attempt >= retries) break;
        stats.retries++;
        await sleep(Math.min(10000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }

      if (status === 401 || status === 403 || status === 429 || status >= 500) {
        lastErr = new Error(`HTTP ${status}: ${path}`);
        if (attempt >= retries) break;
        stats.retries++;
        const wait = retryAfterMs(res.headers.get('retry-after'));
        await sleep(
          Math.max(wait, Math.min(12000, 700 * 2 ** attempt)) + Math.random() * 300,
          signal,
        );
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${status}: ${path}`);

      let data;
      try {
        data = await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt >= retries) break;
        stats.retries++;
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250, signal);
        continue;
      }

      const code = Number(data?.code) || 200;
      if (code === 404) {
        lastErr = new NotFoundError(`API 404: ${path}`);
        if (!retry404) throw lastErr;
        if (attempt >= retries) break;
        stats.retries++;
        await sleep(Math.min(10000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }
      if (code >= 500 || code === 401 || code === 403 || code === 429) {
        lastErr = new Error(`API ${code}: ${path}`);
        if (attempt >= retries) break;
        stats.retries++;
        await sleep(Math.min(12000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }
      if (code >= 400) throw new Error(`API ${code}: ${path}`);

      stats.requests++;
      return data;
    }

    throw lastErr || new Error(`请求失败：${path}`);
  }

  return { apiGet, stats, warnings, base };
}

// ---------------------------------------------------------------------------
// cursor / 用户
// ---------------------------------------------------------------------------

export function parseCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf('|');
  const first = idx >= 0 ? raw.slice(0, idx) : raw;
  if (!/^-?\d+$/.test(first)) return null;
  let val;
  try {
    val = BigInt(first);
  } catch {
    return null;
  }
  return {
    raw,
    val,
    end: val <= 0n,
    second: idx >= 0 ? raw.slice(idx + 1) : '',
  };
}

export function parseUser(raw) {
  const id = String(raw?.id ?? '').trim();
  const handle = String(raw?.screen_name ?? '').trim();
  if (!id || !handle) return null;
  const vType = raw?.verification?.type;
  return {
    id,
    handle,
    name: String(raw?.name ?? '').trim() || handle,
    avatar: String(raw?.avatar_url ?? '').replace(/_normal(\.\w+)$/, '_400x400$1'),
    followers: Number(raw?.followers) || 0,
    following: Number(raw?.following) || 0,
    tweets: Number(raw?.statuses ?? raw?.tweets) || 0,
    verified: !!raw?.verification?.verified,
    org: vType === 'business' || vType === 'government',
    hi: 0n,
    lo: 0n,
    idx: 0,
    hasOrder: false,
  };
}

export function addPage(users, results, pageHi, pageLo, onCount) {
  if (!Array.isArray(results) || !results.length) return;
  const hi = pageHi > pageLo ? pageHi : pageLo;
  const lo = pageLo;

  for (let i = 0; i < results.length; i++) {
    const u = parseUser(results[i]);
    if (!u) continue;
    const prev = users.get(u.id);

    if (!prev) {
      u.hi = hi;
      u.lo = lo;
      u.idx = i;
      u.hasOrder = true;
      users.set(u.id, u);
      continue;
    }

    prev.name = u.name;
    prev.avatar = u.avatar || prev.avatar;
    prev.followers = u.followers;
    prev.following = u.following;
    prev.tweets = u.tweets;
    prev.verified = u.verified;
    prev.org = u.org;

    if (!prev.hasOrder) {
      prev.hi = hi;
      prev.lo = lo;
      prev.idx = i;
      prev.hasOrder = true;
      continue;
    }

    const newHi = minBig(prev.hi, hi);
    const newLo = maxBig(prev.lo, lo);

    if (newHi > newLo) {
      const oldWidth = prev.hi - prev.lo;
      const newWidth = newHi - newLo;
      if (newWidth < oldWidth || (newWidth === oldWidth && i < prev.idx)) {
        prev.idx = i;
      }
      prev.hi = newHi;
      prev.lo = newLo;
    }
  }

  onCount?.(users.size);
}

export function orderMid(u) {
  return u.hasOrder ? (u.hi + u.lo) / 2n : 0n;
}

export function cmpRecent(a, b) {
  const am = a._mid ?? (a._mid = orderMid(a));
  const bm = b._mid ?? (b._mid = orderMid(b));
  if (am !== bm) return am > bm ? -1 : 1;
  if (a.idx !== b.idx) return a.idx - b.idx;
  return a.handle.localeCompare(b.handle);
}

/**
 * 时间优先 + 粉丝数次优先。
 *
 * 先按关注时间从晚到早；时间相同（排序区间中点相等）时按粉丝数从多到少；
 * 仍相同则用原始索引和用户名兜底，保证结果完全确定、不会出现顺序冲突。
 */
export function cmpRecentBig(a, b) {
  const am = a._mid ?? (a._mid = orderMid(a));
  const bm = b._mid ?? (b._mid = orderMid(b));
  if (am !== bm) return am > bm ? -1 : 1;
  if (a.followers !== b.followers) return b.followers - a.followers;
  if (a.idx !== b.idx) return a.idx - b.idx;
  return a.handle.localeCompare(b.handle);
}

export function sortUsers(list, mode) {
  const arr = [...list];
  if (mode === 'big') {
    arr.sort((a, b) => b.followers - a.followers || cmpRecent(a, b));
  } else if (mode === 'small') {
    arr.sort((a, b) => a.followers - b.followers || cmpRecent(a, b));
  } else if (mode === 'recent-big') {
    arr.sort(cmpRecentBig);
  } else {
    arr.sort(cmpRecent);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

export async function fetchProfile(client, handle, { signal } = {}) {
  const data = await client.apiGet(`/2/profile/${encodeURIComponent(handle)}`, { signal });
  const u = data?.user;
  if (!u) throw new NotFoundError(`@${handle} 不存在`);

  const handleOut = String(u.screen_name ?? handle);
  const joinedMs = Date.parse(String(u.joined ?? ''));
  const lowerBound = Number.isFinite(joinedMs) ? toSnowflake(joinedMs) : 0n;

  return {
    id: String(u.id ?? ''),
    handle: handleOut,
    name: String(u.name ?? '').trim() || handleOut,
    avatar: String(u.avatar_url ?? ''),
    followers: Number(u.followers) || 0,
    following: Number(u.following) || 0,
    joined: Number.isFinite(joinedMs) ? new Date(joinedMs).toISOString() : null,
    verified: !!u.verification?.verified,
    protected: !!u.protected,
    lowerBound,
  };
}

export async function scanList(
  client,
  kind,
  profile,
  { signal, workers = 4, maxPages = 5000, onProgress } = {},
) {
  const expected = kind === 'following' ? profile.following : profile.followers;
  const label = kind === 'following' ? '关注' : '粉丝';
  const users = new Map();
  const lowerBound = profile.lowerBound;
  const report = () => onProgress?.({ kind, count: users.size, expected });

  let initial;
  try {
    initial = await client.apiGet(`/2/profile/${encodeURIComponent(profile.handle)}/${kind}`, {
      signal,
      retry404: true,
    });
  } catch (e) {
    if (signal?.aborted) throw new AbortError();
    if (e instanceof NotFoundError) {
      throw new UserError(
        '名单抓不到',
        `@${profile.handle} 的${label}名单返回 404，可能被限流或不可见。`,
      );
    }
    throw e;
  }

  const initialResults = Array.isArray(initial?.results) ? initial.results : [];
  const initialCursor = parseCursor(initial?.cursor?.bottom);
  const now = nowSnowflake();

  if (initialResults.length) {
    const lo =
      initialCursor && !initialCursor.end
        ? maxBig(initialCursor.val, lowerBound)
        : lowerBound;
    addPage(users, initialResults, now, lo, report);
  }
  report();

  const warnings = client.warnings;

  if (!initialCursor || initialCursor.end || initialCursor.val <= lowerBound) {
    return { users, partial: false };
  }

  const nonce = initialCursor.second || String(now);
  const cursorFor = (val) => `${val}|${nonce}`;
  const segments = [
    {
      start: initialCursor.val,
      cur: initialCursor.raw,
      curv: initialCursor.val,
      end: lowerBound,
      busy: false,
      done: false,
    },
  ];

  let limitHit = false;
  let sawHardError = false;

  function pickSegment() {
    const idle = segments.find((s) => !s.busy && !s.done);
    if (idle) return idle;

    let best = null;
    for (const s of segments) {
      if (!s.busy || s.done || s.curv == null) continue;
      const gap = s.curv - s.end;
      if (gap <= MIN_SPLIT) continue;
      if (!best || gap > best.gap) best = { s, gap };
    }
    if (!best) return null;

    const s = best.s;
    const mid = s.end + (s.curv - s.end) / 2n;
    if (mid <= s.end || mid >= s.curv) return null;

    const ns = {
      start: mid,
      cur: null,
      curv: mid,
      end: s.end,
      busy: false,
      done: false,
    };
    s.end = mid;
    segments.push(ns);
    return ns;
  }

  async function runSegment(seg) {
    seg.busy = true;
    try {
      let cur = seg.cur;
      let first = cur == null;
      let cursorVal = first ? seg.start : parseCursor(cur)?.val;
      let emptyStreak = 0;

      for (;;) {
        if (signal?.aborted) throw new AbortError();
        if (client.stats.requests > maxPages) {
          limitHit = true;
          warnings.push(`${label}名单超过最大页数 ${maxPages}，结果可能不完整`);
          break;
        }

        const rawCursor = cur ?? cursorFor(seg.start);
        let data;
        try {
          data = await client.apiGet(
            `/2/profile/${encodeURIComponent(profile.handle)}/${kind}?cursor=${encodeURIComponent(rawCursor)}`,
            { signal, retry404: true },
          );
        } catch (e) {
          if (signal?.aborted) throw new AbortError();
          if (e instanceof NotFoundError) {
            sawHardError = true;
            warnings.push(`${label}名单有一段 cursor 多次 404，已跳过（可能被限流）`);
            break;
          }
          throw e;
        }

        const results = Array.isArray(data?.results) ? data.results : [];
        const next = parseCursor(data?.cursor?.bottom);
        const pageLo = next && !next.end ? maxBig(next.val, lowerBound) : lowerBound;

        addPage(users, results, cursorVal, pageLo, report);

        if (!next || next.end) break;

        if (next.val >= cursorVal) {
          if (first) break;
          sawHardError = true;
          warnings.push(`${label}名单 cursor 卡住，结果可能不完整`);
          break;
        }
        if (next.val <= seg.end) break;

        seg.curv = next.val;
        seg.cur = next.raw;
        cur = next.raw;
        cursorVal = next.val;
        first = false;
        emptyStreak = results.length ? 0 : emptyStreak + 1;
        if (emptyStreak >= 20) {
          warnings.push(`${label}名单连续 20 页为空，提前结束`);
          break;
        }
      }
    } finally {
      seg.busy = false;
      seg.done = true;
    }
  }

  async function worker() {
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const seg = pickSegment();
      if (!seg) {
        if (segments.every((s) => s.done)) return;
        await sleep(25, signal);
        continue;
      }
      await runSegment(seg);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()));

  // 覆盖率明显不足时，顺序补抓一次
  if (expected >= 20 && users.size < expected * 0.9) {
    try {
      let cur = initialCursor.raw;
      let empty = 0;
      let pages = 0;
      for (;;) {
        if (signal?.aborted) throw new AbortError();
        if (pages++ > maxPages || client.stats.requests > maxPages) {
          limitHit = true;
          break;
        }

        let data;
        try {
          data = await client.apiGet(
            `/2/profile/${encodeURIComponent(profile.handle)}/${kind}?cursor=${encodeURIComponent(cur)}`,
            { signal, retry404: true },
          );
        } catch (e) {
          if (signal?.aborted) throw new AbortError();
          warnings.push(`${label}名单顺序补抓遇到 404，停止补抓`);
          break;
        }

        const results = Array.isArray(data?.results) ? data.results : [];
        const next = parseCursor(data?.cursor?.bottom);
        const hi = parseCursor(cur)?.val ?? now;
        const lo = next && !next.end ? maxBig(next.val, lowerBound) : lowerBound;

        addPage(users, results, hi, lo, report);

        if (!next || next.end || next.val >= hi) break;
        cur = next.raw;
        empty = results.length ? 0 : empty + 1;
        if (empty >= 20) break;
      }
    } catch (e) {
      if (signal?.aborted) throw new AbortError();
      warnings.push(`${label}名单顺序补抓失败：${e?.message || e}`);
    }
  }

  report();

  if (expected >= 20 && users.size < expected * 0.5) {
    warnings.push(
      `${label}名单只抓到资料人数的 ${pct(users.size / expected)}，接口可能在限流，过几分钟再试`,
    );
  }

  const partial =
    limitHit || sawHardError || (expected >= 20 && users.size < expected * 0.9);

  return { users, partial };
}

// ---------------------------------------------------------------------------
// 比对
// ---------------------------------------------------------------------------

export function compareLists(profile, following, followers) {
  const selfId = profile.id;
  const selfHandle = profile.handle.toLowerCase();
  const isSelf = (u) => u.id === selfId || u.handle.toLowerCase() === selfHandle;

  const f = following.filter((u) => !isSelf(u));
  const g = followers.filter((u) => !isSelf(u));
  const fSet = new Set(f.map((u) => u.id));
  const gSet = new Set(g.map((u) => u.id));

  const notBack = f.filter((u) => !gSet.has(u.id));
  const owe = g.filter((u) => !fSet.has(u.id));
  const mutual = f.length - notBack.length;
  const rate = f.length ? mutual / f.length : 0;

  return { following: f, followers: g, notBack, owe, mutual, rate };
}

// ---------------------------------------------------------------------------
// 编排：一次完整扫描（供 API / CLI 共用）
// ---------------------------------------------------------------------------

export async function runScan(handle, options = {}) {
  const {
    signal,
    workers = 4,
    rps = 8,
    base = API,
    timeout = 20000,
    maxFollowing = 50000,
    maxFollowers = 50000,
    maxPages = 5000,
    onProgress,
    userAgent,
  } = options;

  const client = createClient({ base, rps, timeout, userAgent });

  const profile = await fetchProfile(client, handle, { signal });

  if (profile.protected) {
    throw new UserError('锁推账号', `@${profile.handle} 锁推了，关注和粉丝列表不可见。`);
  }
  if (maxFollowing && profile.following > maxFollowing) {
    throw new UserError(
      '号太大',
      `@${profile.handle} 关注 ${fmt(profile.following)} 人，超过上限 ${fmt(maxFollowing)}。`,
    );
  }
  if (maxFollowers && profile.followers > maxFollowers) {
    throw new UserError(
      '号太大',
      `@${profile.handle} 粉丝 ${fmt(profile.followers)} 人，超过上限 ${fmt(maxFollowers)}。`,
    );
  }

  const [followingRes, followersRes] = await Promise.all([
    scanList(client, 'following', profile, {
      signal,
      workers,
      maxPages,
      onProgress,
    }),
    scanList(client, 'followers', profile, {
      signal,
      workers,
      maxPages,
      onProgress,
    }),
  ]);

  const following = [...followingRes.users.values()];
  const followers = [...followersRes.users.values()];
  const comp = compareLists(profile, following, followers);

  return {
    profile,
    ...comp,
    warnings: [...new Set(client.warnings)],
    stats: { ...client.stats },
    partial: followingRes.partial || followersRes.partial,
  };
}

// ---------------------------------------------------------------------------
// 输出序列化
// ---------------------------------------------------------------------------

export function userToJson(u) {
  return {
    id: u.id,
    handle: u.handle,
    name: u.name,
    avatar: u.avatar,
    followers: u.followers,
    following: u.following,
    tweets: u.tweets,
    verified: u.verified,
    org: u.org,
    orderKey: orderMid(u).toString(),
  };
}

export function buildResult(result, sort = 'recent') {
  const cov = {
    following:
      result.profile.following > 0
        ? result.following.length / result.profile.following
        : 1,
    followers:
      result.profile.followers > 0
        ? result.followers.length / result.profile.followers
        : 1,
  };
  const missingFollowing = Math.max(0, result.profile.following - result.following.length);
  const missingFollowers = Math.max(0, result.profile.followers - result.followers.length);

  return {
    handle: result.profile.handle,
    generatedAt: new Date().toISOString(),
    profile: {
      id: result.profile.id,
      handle: result.profile.handle,
      name: result.profile.name,
      avatar: result.profile.avatar,
      followers: result.profile.followers,
      following: result.profile.following,
      joined: result.profile.joined,
      verified: result.profile.verified,
    },
    stats: {
      following: result.following.length,
      followers: result.followers.length,
      mutual: result.mutual,
      rate: result.rate,
      notBack: result.notBack.length,
      owe: result.owe.length,
      notBackBlue: result.notBack.filter((u) => u.verified).length,
      oweBlue: result.owe.filter((u) => u.verified).length,
      missingFollowing,
      missingFollowers,
      followingCoverage: cov.following,
      followersCoverage: cov.followers,
      partial: result.partial || cov.following < 0.9 || cov.followers < 0.9,
      requests: result.stats?.requests ?? 0,
    },
    warnings: result.warnings || [],
    following: sortUsers(result.following, 'recent').map((u) => ({
      id: u.id,
      handle: u.handle,
      name: u.name,
      followers: u.followers,
      verified: u.verified,
    })),
    followers: sortUsers(result.followers, 'recent').map((u) => ({
      id: u.id,
      handle: u.handle,
      name: u.name,
      followers: u.followers,
      verified: u.verified,
    })),
    notBack: sortUsers(result.notBack, sort).map(userToJson),
    owe: sortUsers(result.owe, sort).map(userToJson),
  };
}
