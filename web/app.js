(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // 常量
  // -------------------------------------------------------------------------

  // 想用自托管接口时，把这里改成你的地址；
  // 也可以在 URL 加 ?api=https://api.example.com 临时覆盖。
  const API = 'https://api.fxtwitter.com';
  const API_OVERRIDE = (() => {
    try {
      const value = new URLSearchParams(location.search).get('api');
      return value && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value) ? value.replace(/\/$/, '') : null;
    } catch {
      return null;
    }
  })();
  const API_BASE = API_OVERRIDE || API;

  // 后端扫描端点（Vercel 部署时是同源 /api/scan-stream）；
  // 可用 ?scan= 覆盖，比如本地 vercel dev。
  const SCAN_ENDPOINT = (() => {
    try {
      const v = new URLSearchParams(location.search).get('scan');
      if (v && /^https?:\/\//i.test(v)) return v.replace(/\/$/, '');
    } catch {}
    return '/api/scan-stream';
  })();
  const TWITTER_EPOCH = 1288834974657n;
  const ID_SHIFT = 22n;
  const MIN_SPLIT = 4194304000n; // 1 秒的 snowflake 跨度
  const CACHE_VERSION = 2;
  const CACHE_TTL = 30 * 60 * 1000;
  const MAX_FOLLOWING = 50000;
  const MAX_FOLLOWERS = 50000;
  const MAX_PAGES = 5000;
  const WORKERS = 4;
  const RPS = 8;
  const PAGE_SIZE = 60;
  const PAGE_STEP = 120;

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const form = $('#scan-form');
  const input = $('#handle');
  const scanBtn = $('#scan-btn');
  const cancelBtn = $('#cancel-btn');
  const retryBtn = $('#retry-btn');
  const refreshBtn = $('#refresh-btn');
  const progressPanel = $('#progress-panel');
  const progressTitle = $('#progress-title');
  const progressStatus = $('#progress-status');
  const errorPanel = $('#error-panel');
  const errorTitle = $('#error-title');
  const errorText = $('#error-text');
  const resultPanel = $('#result-panel');
  const profileCard = $('#profile-card');
  const statsGrid = $('#stats-grid');
  const coverageNote = $('#coverage-note');
  const warnBox = $('#warn-box');
  const notbackCount = $('#notback-count');
  const oweCount = $('#owe-count');
  const blueOnly = $('#blue-only');
  const noBlue = $('#no-blue');
  const sortSelect = $('#sort-select');
  const copyBtn = $('#copy-btn');
  const jsonBtn = $('#json-btn');
  const csvBtn = $('#csv-btn');
  const listNote = $('#list-note');
  const mirrorList = $('#mirror-list');
  const moreBtn = $('#more-btn');
  const toast = $('#toast');
  const followingCountEl = $('#following-count');
  const followersCountEl = $('#followers-count');
  const followingBar = $('#following-bar');
  const followersBar = $('#followers-bar');

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  const state = {
    scanning: false,
    abort: null,
    cancelled: false,
    scan: null,
    fromCache: false,
    tab: 'notBack',
    blueOnly: false,
    noBlue: false,
    sort: 'recent',
    limit: PAGE_SIZE,
    lastHandle: '',
    pageCount: 0,
    warnings: [],
    // 筛选/排序结果缓存
    _filteredCache: null,
    _filteredKey: '',
  };

  const counts = { following: 0, followers: 0 };
  let toastTimer = 0;

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  function fmt(n) {
    return new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
  }

  function compact(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
    return fmt(n);
  }

  function pct(x) {
    if (!Number.isFinite(x)) return '—';
    if (x >= 0.9995) return '100%';
    return (x * 100).toFixed(x === 0 ? 0 : 1).replace(/\.0$/, '') + '%';
  }

  function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function normalizeHandle(value) {
    let s = String(value ?? '').trim();
    const m = s.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').replace(/\/.*$/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
  }

  function nowSnowflake() {
    return (BigInt(Date.now()) - TWITTER_EPOCH) << ID_SHIFT;
  }

  function toSnowflake(ms) {
    const n = BigInt(Math.floor(ms));
    return n <= TWITTER_EPOCH ? 0n : (n - TWITTER_EPOCH) << ID_SHIFT;
  }

  function minBig(a, b) {
    return a < b ? a : b;
  }

  function maxBig(a, b) {
    return a > b ? a : b;
  }

  function abortError() {
    return new DOMException('aborted', 'AbortError');
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let timer = 0;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(abortError());
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-show'), 2400);
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function scrollTo(el) {
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // HTTP / 限速
  // -------------------------------------------------------------------------

  class HttpError extends Error {
    constructor(status, message) {
      super(message || `HTTP ${status}`);
      this.name = 'HttpError';
      this.status = status;
    }
  }

  class UserError extends Error {
    constructor(title, message) {
      super(message);
      this.name = 'UserError';
      this.title = title;
    }
  }

  class RateLimiter {
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

  const limiter = new RateLimiter(RPS);

  function fetchWithTimeout(url, options, timeoutMs, outerSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException('timeout', 'TimeoutError')),
      timeoutMs,
    );
    const onAbort = () => ctrl.abort(new DOMException('aborted', 'AbortError'));
    if (outerSignal) {
      if (outerSignal.aborted) onAbort();
      else outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    });
  }

  function retryAfterMs(value) {
    if (!value) return 0;
    const sec = Number(value);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const t = Date.parse(value);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
  }

  async function apiGet(path, { signal, retry404 = false, onStatus } = {}) {
    const url = API_BASE + path;
    const retries = 6;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw abortError();
      await limiter.wait(signal);
      if (signal?.aborted) throw abortError();

      let res;
      try {
        res = await fetchWithTimeout(
          url,
          {
            headers: { Accept: 'application/json' },
          },
          20000,
          signal,
        );
      } catch (e) {
        if (signal?.aborted) throw abortError();
        lastErr = e;
        if (attempt >= retries) break;
        onStatus?.('网络抖动，重试中…');
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250, signal);
        continue;
      }

      const status = res.status;

      if (status === 404) {
        lastErr = new HttpError(404, '接口返回 404');
        if (!retry404) throw lastErr;
        if (attempt >= retries) break;
        onStatus?.('接口 404，重试中…');
        await sleep(Math.min(10000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }

      if (status === 401 || status === 403 || status === 429 || status >= 500) {
        lastErr = new HttpError(status, `接口返回 ${status}`);
        if (attempt >= retries) break;
        const wait = retryAfterMs(res.headers.get('retry-after'));
        onStatus?.(
          status === 429
            ? '被接口限流，等一会儿再试…'
            : status === 401 || status === 403
              ? '接口拒绝访问，重试中…'
              : `接口 ${status}，重试中…`,
        );
        await sleep(
          Math.max(wait, Math.min(12000, 700 * 2 ** attempt)) + Math.random() * 300,
          signal,
        );
        continue;
      }

      if (!res.ok) {
        throw new HttpError(status, `接口返回 ${status}`);
      }

      let data;
      try {
        data = await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt >= retries) break;
        onStatus?.('响应解析失败，重试中…');
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250, signal);
        continue;
      }

      const code = Number(data?.code) || 200;

      if (code === 404) {
        lastErr = new HttpError(404, '接口返回 404');
        if (!retry404) throw lastErr;
        if (attempt >= retries) break;
        await sleep(Math.min(10000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }

      if (code === 401 || code === 403 || code === 429 || code >= 500) {
        lastErr = new HttpError(code, `接口返回 ${code}`);
        if (attempt >= retries) break;
        await sleep(Math.min(12000, 700 * 2 ** attempt) + Math.random() * 300, signal);
        continue;
      }

      if (code >= 400) throw new HttpError(code, `接口返回 ${code}`);

      state.pageCount++;
      return data;
    }

    throw lastErr || new Error('请求失败');
  }

  // -------------------------------------------------------------------------
  // cursor / 用户 / 排序
  // -------------------------------------------------------------------------

  function parseCursor(raw) {
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

  function parseUser(raw) {
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

  function addPage(users, results, pageHi, pageLo, onCount) {
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

  function orderMid(u) {
    return u.hasOrder ? (u.hi + u.lo) / 2n : 0n;
  }

  // 预计算 orderMid 并缓存，避免排序时重复计算
  function cmpRecent(a, b) {
    const am = a._mid ?? (a._mid = orderMid(a));
    const bm = b._mid ?? (b._mid = orderMid(b));
    if (am !== bm) return am > bm ? -1 : 1;
    if (a.idx !== b.idx) return a.idx - b.idx;
    return a.handle.localeCompare(b.handle);
  }

  // 时间优先 + 粉丝数次优先；索引和用户名兜底，保证顺序确定
  function cmpRecentBig(a, b) {
    const am = a._mid ?? (a._mid = orderMid(a));
    const bm = b._mid ?? (b._mid = orderMid(b));
    if (am !== bm) return am > bm ? -1 : 1;
    if (a.followers !== b.followers) return b.followers - a.followers;
    if (a.idx !== b.idx) return a.idx - b.idx;
    return a.handle.localeCompare(b.handle);
  }

  function sortUsers(list, mode) {
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

  // -------------------------------------------------------------------------
  // 抓取
  // -------------------------------------------------------------------------

  async function fetchProfile(handle, signal, onStatus) {
    const data = await apiGet(`/2/profile/${encodeURIComponent(handle)}`, {
      signal,
      retry404: false,
      onStatus,
    });
    const u = data?.user;
    if (!u) throw new HttpError(404, '查无此人');

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

  async function scanList(kind, profile, { signal, onProgress, onStatus, warnings }) {
    const expected = kind === 'following' ? profile.following : profile.followers;
    const label = kind === 'following' ? '关注' : '粉丝';
    const users = new Map();
    const lowerBound = profile.lowerBound;

    const report = () => onProgress?.({ kind, count: users.size, expected });

    let initial;
    try {
      initial = await apiGet(`/2/profile/${encodeURIComponent(profile.handle)}/${kind}`, {
        signal,
        retry404: true,
        onStatus,
      });
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (e.status === 404) {
        throw new UserError('名单抓不到', `@${profile.handle} 的${label}名单接口返回 404，可能被限流或不可见。`);
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

    if (!initialCursor || initialCursor.end || initialCursor.val <= lowerBound) {
      return { users, partial: false, warnings };
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
          if (signal.aborted) throw abortError();

          if (state.pageCount > MAX_PAGES) {
            limitHit = true;
            warnings.push(`${label}名单超过最大页数 ${MAX_PAGES}，结果可能不完整`);
            break;
          }

          const rawCursor = cur ?? cursorFor(seg.start);
          let data;
          try {
            data = await apiGet(
              `/2/profile/${encodeURIComponent(profile.handle)}/${kind}?cursor=${encodeURIComponent(rawCursor)}`,
              { signal, retry404: true, onStatus },
            );
          } catch (e) {
            if (signal.aborted) throw abortError();
            if (e.status === 404) {
              sawHardError = true;
              warnings.push(`${label}名单有一段 cursor 多次 404，已跳过（可能被限流）`);
              break;
            }
            throw e;
          }

          const results = Array.isArray(data?.results) ? data.results : [];
          const next = parseCursor(data?.cursor?.bottom);
          const pageLo =
            next && !next.end ? maxBig(next.val, lowerBound) : lowerBound;

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
        if (signal.aborted) throw abortError();
        const seg = pickSegment();
        if (!seg) {
          if (segments.every((s) => s.done)) return;
          await sleep(25, signal);
          continue;
        }
        await runSegment(seg);
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, () => worker()));

    // 和资料人数差太多时，退回顺序链补抓一次。
    if (expected >= 20 && users.size < expected * 0.9) {
      onStatus?.(`${label}名单偏少，顺序补抓中…`);
      try {
        let cur = initialCursor.raw;
        let empty = 0;
        let pages = 0;

        for (;;) {
          if (signal.aborted) throw abortError();
          if (pages++ > MAX_PAGES || state.pageCount > MAX_PAGES) {
            limitHit = true;
            break;
          }

          let data;
          try {
            data = await apiGet(
              `/2/profile/${encodeURIComponent(profile.handle)}/${kind}?cursor=${encodeURIComponent(cur)}`,
              { signal, retry404: true, onStatus },
            );
          } catch (e) {
            if (signal.aborted) throw abortError();
            warnings.push(`${label}名单顺序补抓遇到 404，停止补抓`);
            break;
          }

          const results = Array.isArray(data?.results) ? data.results : [];
          const next = parseCursor(data?.cursor?.bottom);
          const hi = parseCursor(cur)?.val ?? now;
          const lo =
            next && !next.end ? maxBig(next.val, lowerBound) : lowerBound;

          addPage(users, results, hi, lo, report);

          if (!next || next.end || next.val >= hi) break;
          cur = next.raw;
          empty = results.length ? 0 : empty + 1;
          if (empty >= 20) break;
        }
      } catch (e) {
        if (signal.aborted) throw abortError();
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
      limitHit ||
      sawHardError ||
      (expected >= 20 && users.size < expected * 0.9);

    return { users, partial, warnings };
  }

  function compareLists(profile, following, followers) {
    const selfId = profile.id;
    const selfHandle = profile.handle.toLowerCase();
    const isSelf = (u) =>
      u.id === selfId || u.handle.toLowerCase() === selfHandle;

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

  async function scanAccount(handle, { force = false } = {}) {
    if (state.scanning) return;

    state.scanning = true;
    state.cancelled = false;
    state.lastHandle = handle;
    state.pageCount = 0;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    state.warnings = [];

    hideResult();
    hideError();
    showProgress(handle);
    updateFormState();

    try {
      if (!force) {
        const cached = await cacheGet(handle);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          const scan = hydrateScan(cached);
          state.fromCache = true;
          state.scan = scan;
          finishProgress(scan);
          renderScan(scan, { fromCache: true });
          try {
            history.replaceState(null, '', `?u=${encodeURIComponent(scan.profile.handle)}`);
          } catch {}
          return;
        }
      }

      // 通过同源 /api/scan-stream 代理扫描，避免浏览器直连时的 CORS 与限速问题
      const scan = await streamScan(handle, {
        signal,
        onProfile(profile) {
          progressTitle.textContent = `正在照 @${profile.handle}…`;
          setStatus(`关注 ${fmt(profile.following)} · 粉丝 ${fmt(profile.followers)}`);
          updateProgress({ kind: 'following', count: 0, expected: profile.following });
          updateProgress({ kind: 'followers', count: 0, expected: profile.followers });
        },
        onProgress: updateProgress,
        onWarn(message) {
          state.warnings?.push?.(message);
        },
        onStatus: setStatus,
      });

      state.fromCache = false;
      state.scan = scan;
      finishProgress(scan);
      renderScan(scan, { fromCache: false });
      // 推迟序列化+写 IndexedDB，避免阻塞主线程渲染结果
      const scheduleCache = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 3000 })
        : (fn) => setTimeout(fn, 0);
      scheduleCache(() => void cachePut(serializeScan(scan)).catch(() => {}));

      try {
        history.replaceState(null, '', `?u=${encodeURIComponent(scan.profile.handle)}`);
      } catch {}
    } catch (e) {
      if (e.name === 'AbortError') {
        if (state.cancelled) {
          hideProgress();
          showToast('已取消');
        } else {
          showError('已取消', '这次没有照完。');
        }
      } else {
        state.abort?.abort();
        const friendly = friendlyError(e);
        showError(friendly.title, friendly.text);
      }
    } finally {
      state.scanning = false;
      state.abort = null;
      updateFormState();
    }
  }

  /**
   * 调用 /api/scan-stream（NDJSON 流），把事件转换成 UI 回调。
   * 如果部署环境没有该接口（比如纯静态托管），自动回退到直连 FxTwitter。
   */
  async function streamScan(handle, { signal, onProfile, onProgress, onWarn, onStatus }) {
    // 蓝V筛选在前端本地做（数据本来就全量返回），这里不传 blue 参数
    const url = `${SCAN_ENDPOINT}?u=${encodeURIComponent(handle)}`;

    let res;
    try {
      res = await fetch(url, {
        signal,
        headers: { Accept: 'application/x-ndjson' },
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      // 端点不存在时回退
      return legacyScan(handle, { signal, onProfile, onProgress, onWarn, onStatus });
    }

    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('ndjson')) {
      // 不是流式接口（404 / HTML），回退到浏览器直连
      return legacyScan(handle, { signal, onProfile, onProgress, onWarn, onStatus });
    }

    onStatus?.('已连接扫描服务…');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let profile = null;
    let result = null;
    let errorEvent = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'profile') {
          profile = evt.profile;
          onProfile?.(evt.profile);
        } else if (evt.type === 'progress') {
          onProgress?.({ kind: evt.kind, count: evt.count, expected: evt.expected });
        } else if (evt.type === 'warn') {
          onWarn?.(evt.message);
        } else if (evt.type === 'result') {
          result = evt.data;
        } else if (evt.type === 'error') {
          errorEvent = evt;
        }
      }
    }

    if (errorEvent) {
      throw new UserError(errorEvent.title || '扫描失败', errorEvent.message || '');
    }
    if (!result) {
      throw new UserError('扫描失败', '服务没有返回结果，请稍后重试。');
    }

    return normalizeApiResult(result);
  }

  /** 把 /api/scan-stream 的 JSON 结果转成内部 scan 结构 */
  function normalizeApiResult(data) {
    const toUser = (u) => ({
      ...u,
      avatar: u.avatar || '',
      following: u.following || 0,
      tweets: u.tweets || 0,
      verified: !!u.verified,
      org: !!u.org,
      hi: 0n,
      lo: 0n,
      idx: 0,
      hasOrder: false,
      orderKey: u.orderKey,
    });

    // 服务端返回的列表已按「关注先后」排好。
    // 用递减索引伪造排序区间，保证 sortUsers('recent') 原样保留这个顺序
    // （服务端 orderKey 在同一页内相同，不能直接用来排序）。
    const orderUsers = (list) => {
      const arr = list || [];
      return arr.map((u, i) => {
        const rank = BigInt(arr.length - i);
        return { ...toUser(u), idx: i, hasOrder: true, hi: rank, lo: rank };
      });
    };

    const profile = {
      ...data.profile,
      followers: data.profile.followers || 0,
      following: data.profile.following || 0,
      lowerBound: 0n,
    };

    return {
      profile,
      following: orderUsers(data.following),
      followers: orderUsers(data.followers),
      // 服务端返回的 notBack/owe 已经按关注先后排好；
      // 注入递减索引，保证 sortUsers('recent') 不再重排。
      notBack: orderUsers(data.notBack).map((u, i, arr) => ({
        ...u,
        hi: BigInt(arr.length - i),
        lo: BigInt(arr.length - i),
      })),
      owe: orderUsers(data.owe).map((u, i, arr) => ({
        ...u,
        hi: BigInt(arr.length - i),
        lo: BigInt(arr.length - i),
      })),
      mutual: data.stats?.mutual ?? 0,
      rate: data.stats?.rate ?? 0,
      warnings: data.warnings || [],
      fetchedAt: Date.now(),
      serverStats: data.stats,
    };
  }

  /** 回退方案：浏览器直连 FxTwitter（纯静态部署时使用） */
  async function legacyScan(handle, { signal, onProfile, onProgress, onWarn, onStatus }) {
    const profile = await fetchProfile(handle, signal, onStatus);

    if (profile.protected) {
      throw new UserError('锁推账号', `@${profile.handle} 锁推了，关注和粉丝列表不可见。`);
    }
    if (profile.following > MAX_FOLLOWING) {
      throw new UserError(
        '号太大',
        `@${profile.handle} 关注 ${fmt(profile.following)} 人，超过上限 ${fmt(MAX_FOLLOWING)}。`,
      );
    }
    if (profile.followers > MAX_FOLLOWERS) {
      throw new UserError(
        '号太大',
        `@${profile.handle} 粉丝 ${fmt(profile.followers)} 人，超过上限 ${fmt(MAX_FOLLOWERS)}。`,
      );
    }

    onProfile?.(profile);
    const warnings = [];
    const [followingResult, followersResult] = await Promise.all([
      scanList('following', profile, {
        signal,
        onProgress,
        onStatus,
        warnings,
      }),
      scanList('followers', profile, {
        signal,
        onProgress,
        onStatus,
        warnings,
      }),
    ]);

    onStatus?.('比对名单中…');
    const following = [...followingResult.users.values()];
    const followers = [...followersResult.users.values()];
    const comp = compareLists(profile, following, followers);

    for (const w of warnings) onWarn?.(w);

    return {
      profile,
      following: comp.following,
      followers: comp.followers,
      notBack: comp.notBack,
      owe: comp.owe,
      mutual: comp.mutual,
      rate: comp.rate,
      warnings,
      fetchedAt: Date.now(),
    };
  }

  function friendlyError(e) {
    if (e instanceof UserError) {
      return { title: e.title, text: e.message };
    }
    if (e?.status === 404) {
      return {
        title: '查无此人',
        text: '账号不存在、被封，或接口临时出错。',
      };
    }
    if (e?.status === 429) {
      return {
        title: '被限流了',
        text: '接口限流了，过几分钟再试。',
      };
    }
    if (e?.status === 401 || e?.status === 403) {
      return {
        title: '接口拒绝访问',
        text: '接口返回 401/403，可能被限流了。',
      };
    }
    if (e instanceof TypeError) {
      return {
        title: '网络请求失败',
        text: '检查网络或代理后再试。',
      };
    }
    return {
      title: '出了点问题',
      text: e?.message || '再试一次。',
    };
  }

  // -------------------------------------------------------------------------
  // 进度 UI
  // -------------------------------------------------------------------------

  function showProgress(handle) {
    progressPanel.hidden = false;
    progressTitle.textContent = `正在照 @${handle}…`;
    setStatus('准备抓取公开名单');
    counts.following = 0;
    counts.followers = 0;
    followingBar.style.width = '0%';
    followersBar.style.width = '0%';
    followingCountEl.textContent = '0 / 0';
    followersCountEl.textContent = '0 / 0';
    scrollTo(progressPanel);
  }

  function hideProgress() {
    progressPanel.hidden = true;
  }

  function updateProgress({ kind, count, expected }) {
    counts[kind] = count;
    const isFollowing = kind === 'following';
    const bar = isFollowing ? followingBar : followersBar;
    const text = isFollowing ? followingCountEl : followersCountEl;
    const width = expected > 0 ? Math.min(100, (count / expected) * 100) : 0;
    bar.style.width = `${width}%`;
    text.textContent = `${fmt(count)} / ${fmt(expected)}`;
    setStatus(`已请求 ${fmt(state.pageCount)} 页 · 正在抓取公开名单`);
  }

  function finishProgress(scan) {
    hideProgress();
    // 让进度条在关闭前保留最终值，方便从缓存回来时看到覆盖率
    updateProgress({
      kind: 'following',
      count: scan.following.length,
      expected: scan.profile.following,
    });
    updateProgress({
      kind: 'followers',
      count: scan.followers.length,
      expected: scan.profile.followers,
    });
  }

  function setStatus(text) {
    progressStatus.textContent = text;
  }

  // -------------------------------------------------------------------------
  // 结果 UI
  // -------------------------------------------------------------------------

  function hideResult() {
    resultPanel.hidden = true;
  }

  function hideError() {
    errorPanel.hidden = true;
  }

  function showError(title, message) {
    hideProgress();
    hideResult();
    errorTitle.textContent = title || '出了点问题';
    errorText.textContent = message || '';
    errorPanel.hidden = false;
    scrollTo(errorPanel);
  }

  function createBlueCheck() {
    const el = document.createElement('span');
    el.className = 'blue-check';
    el.title = '蓝V';
    el.setAttribute('aria-label', '蓝V');
    el.textContent = '✓';
    return el;
  }

  function createAvatar(u, cls = 'avatar') {
    if (u.avatar) {
      const img = document.createElement('img');
      img.className = cls;
      img.src = u.avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.width = 40;
      img.height = 40;
      img.addEventListener(
        'error',
        () => {
          const ph = document.createElement('span');
          ph.className = `${cls} placeholder`;
          ph.textContent = (u.name || u.handle).slice(0, 1).toUpperCase();
          img.replaceWith(ph);
        },
        { once: true },
      );
      return img;
    }
    const ph = document.createElement('span');
    ph.className = `${cls} placeholder`;
    ph.textContent = (u.name || u.handle).slice(0, 1).toUpperCase();
    return ph;
  }

  function renderProfile(scan, fromCache) {
    profileCard.replaceChildren();
    const { profile } = scan;

    const avatar = createAvatar(profile, 'profile-avatar');
    profileCard.appendChild(avatar);

    const main = document.createElement('div');
    main.className = 'profile-main';

    const h2 = document.createElement('h2');
    const name = document.createElement('span');
    name.textContent = profile.name;
    h2.appendChild(name);
    if (profile.verified) h2.appendChild(createBlueCheck());

    const p = document.createElement('p');
    const joined = profile.joined
      ? ` · 注册于 ${profile.joined.slice(0, 10)}`
      : '';
    p.textContent = `@${profile.handle} · 关注 ${fmt(profile.following)} · 粉丝 ${fmt(
      profile.followers,
    )}${joined}`;
    main.append(h2, p);
    profileCard.appendChild(main);

    const badge = document.createElement('span');
    badge.className = 'profile-badge';
    badge.textContent = fromCache
      ? `缓存于 ${formatTime(scan.fetchedAt)}`
      : '刚刚抓取';
    profileCard.appendChild(badge);
  }

  function statCard(label, value, extraClass = '') {
    const el = document.createElement('div');
    el.className = `stat-card ${extraClass}`.trim();
    const l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    el.append(l, v);
    return el;
  }

  function coverageOf(scan) {
    const { profile, following, followers } = scan;
    return {
      following: profile.following > 0 ? following.length / profile.following : 1,
      followers: profile.followers > 0 ? followers.length / profile.followers : 1,
      missingFollowing: Math.max(0, profile.following - following.length),
      missingFollowers: Math.max(0, profile.followers - followers.length),
    };
  }

  function renderStats(scan) {
    statsGrid.replaceChildren(
      statCard('互关', fmt(scan.mutual), 'accent'),
      statCard('回关率', pct(scan.rate), 'blue'),
      statCard('没回关你', fmt(scan.notBack.length), 'danger'),
      statCard('你没回关', fmt(scan.owe.length)),
    );
  }

  function renderCoverage(scan, fromCache) {
    const cov = coverageOf(scan);
    const parts = [
      `抓到 关注 ${fmt(scan.following.length)} / ${fmt(scan.profile.following)}（${pct(
        cov.following,
      )}）`,
      `粉丝 ${fmt(scan.followers.length)} / ${fmt(scan.profile.followers)}（${pct(
        cov.followers,
      )}）`,
    ];
    if (fromCache) parts.push(`缓存于 ${formatTime(scan.fetchedAt)}`);
    coverageNote.textContent = parts.join(' · ');

    const warnings = [...new Set(scan.warnings || [])];
    if (cov.missingFollowing || cov.missingFollowers) {
      warnings.push(
        `资料人数含被封/注销号或接口未返回：关注少 ${fmt(
          cov.missingFollowing,
        )}，粉丝少 ${fmt(cov.missingFollowers)}。`,
      );
    }
    if (cov.following < 0.9) {
      warnings.push(`关注名单覆盖率只有 ${pct(cov.following)}，结果可能不完整。`);
    }
    if (cov.followers < 0.9) {
      warnings.push(`粉丝名单覆盖率只有 ${pct(cov.followers)}，结果可能不完整。`);
    }

    warnBox.replaceChildren();
    if (warnings.length) {
      for (const w of warnings) {
        const p = document.createElement('p');
        p.textContent = `⚠ ${w}`;
        warnBox.appendChild(p);
      }
      warnBox.hidden = false;
    } else {
      warnBox.hidden = true;
    }
  }

  function invalidateFilteredCache() {
    state._filteredCache = null;
    state._filteredKey = '';
  }

  function getFiltered() {
    if (!state.scan) return [];
    // 缓存键：tab + blueOnly + noBlue + sort，扫描数据不变时直接复用
    const key = `${state.tab}|${state.blueOnly}|${state.noBlue}|${state.sort}`;
    if (state._filteredKey === key && state._filteredCache) return state._filteredCache;
    let list = state.scan[state.tab] || [];
    if (state.blueOnly) list = list.filter((u) => u.verified);
    if (state.noBlue) list = list.filter((u) => !u.verified);
    const result = sortUsers(list, state.sort);
    state._filteredCache = result;
    state._filteredKey = key;
    return result;
  }

  function renderList() {
    if (!state.scan) return;

    const all = state.scan[state.tab] || [];
    const filtered = getFiltered();
    const shown = filtered.slice(0, state.limit);

    // DOM diffing：复用已有节点，只插入/删除差异行
    const hasEmptyState =
      mirrorList.children.length === 1 &&
      mirrorList.firstElementChild?.classList.contains('empty-state');

    if (!shown.length) {
      if (!hasEmptyState) {
        mirrorList.replaceChildren();
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        const strong = document.createElement('strong');
        const p = document.createElement('p');
        if (state.blueOnly) {
          strong.textContent = '这里没有蓝V';
          p.textContent = '换一个名单，或取消“只看蓝V”再看看。';
        } else if (state.noBlue) {
          strong.textContent = '这里全是蓝V';
          p.textContent = '没有非蓝V账号，取消“不看蓝V”再看看。';
        } else if (state.tab === 'notBack') {
          strong.textContent = '全都回关了，道心通明';
          p.textContent = '没有找到关注了但没回关你的账号。';
        } else {
          strong.textContent = '关注你的你都回关了';
          p.textContent = '没有找到关注了你但你没回关的账号。';
        }
        empty.append(strong, p);
        mirrorList.appendChild(empty);
      }
    } else {
      if (hasEmptyState) mirrorList.replaceChildren();
      const shownCount = shown.length;
      for (let i = 0; i < shownCount; i++) {
        const u = shown[i];
        const existingLi = mirrorList.children[i];
        if (existingLi && existingLi.dataset.id === u.id) continue;
        const newLi = createRow(u);
        if (existingLi) {
          mirrorList.replaceChild(newLi, existingLi);
        } else {
          mirrorList.appendChild(newLi);
        }
      }
      // 删除多余行
      while (mirrorList.children.length > shownCount) {
        mirrorList.lastChild.remove();
      }
    }

    const blueCount = all.filter((u) => u.verified).length;
    const bits = [
      state.tab === 'notBack'
        ? '你关注了但没关注你的，点一行进 TA 的主页。'
        : '关注了你、你还没回关的，点一行进 TA 的主页。',
      `当前 ${fmt(filtered.length)} 人`,
    ];
    if (state.blueOnly) bits.push(`蓝V ${fmt(blueCount)} 人`);
    if (state.noBlue) bits.push(`非蓝V ${fmt(all.length - blueCount)} 人`);
    bits.push('被封/注销号不在名单里');
    listNote.textContent = bits.join(' · ');

    const remaining = filtered.length - shown.length;
    if (remaining > 0) {
      moreBtn.hidden = false;
      moreBtn.textContent = `再显示 ${fmt(Math.min(PAGE_STEP, remaining))} 位（共 ${fmt(
        filtered.length,
      )} 位）`;
    } else {
      moreBtn.hidden = true;
    }
  }

  function createRow(u) {
    const li = document.createElement('li');
    li.className = 'mirror-item';
    li.dataset.id = u.id; // DOM diffing 用

    const a = document.createElement('a');
    a.href = `https://x.com/${encodeURIComponent(u.handle)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    a.appendChild(createAvatar(u));

    const main = document.createElement('span');
    main.className = 'item-main';

    const nameRow = document.createElement('span');
    nameRow.className = 'item-name';

    const nameText = document.createElement('span');
    nameText.className = 'name-text';
    nameText.textContent = u.name || u.handle;
    nameRow.appendChild(nameText);

    if (u.verified) nameRow.appendChild(createBlueCheck());

    if (u.org) {
      const org = document.createElement('span');
      org.className = 'badge-org';
      org.textContent = '机构';
      nameRow.appendChild(org);
    }

    const sub = document.createElement('span');
    sub.className = 'item-sub';
    sub.textContent = `@${u.handle} · ${compact(u.followers)}粉`;

    main.append(nameRow, sub);
    a.appendChild(main);

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    a.appendChild(chevron);

    li.appendChild(a);
    return li;
  }

  function renderScan(scan, { fromCache = false } = {}) {
    state.scan = scan;
    state.fromCache = fromCache;

    // 新一轮HackMirror回到默认筛选，同时清除缓存
    state.tab = 'notBack';
    state.blueOnly = false;
    state.noBlue = false;
    state.sort = 'recent';
    state.limit = PAGE_SIZE;
    invalidateFilteredCache();
    blueOnly.checked = false;
    noBlue.checked = false;
    sortSelect.value = 'recent';

    renderProfile(scan, fromCache);
    renderStats(scan);
    renderCoverage(scan, fromCache);

    notbackCount.textContent = fmt(scan.notBack.length);
    oweCount.textContent = fmt(scan.owe.length);

    updateTabs();
    renderList();

    hideProgress();
    hideError();
    resultPanel.hidden = false;
    refreshBtn.disabled = false;
    scrollTo(resultPanel);
  }

  function updateTabs() {
    $$('.tab').forEach((tab) => {
      const active = tab.dataset.tab === state.tab;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function updateFormState() {
    scanBtn.disabled = state.scanning;
    scanBtn.textContent = state.scanning ? '照妖中…' : '照一照';
    input.disabled = state.scanning;
    cancelBtn.disabled = !state.scanning;
    refreshBtn.disabled = state.scanning || !state.scan;
    if (!state.scanning) cancelBtn.disabled = true;
  }

  // -------------------------------------------------------------------------
  // 导出 / 复制
  // -------------------------------------------------------------------------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
      return ok;
    }
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function userToJson(u) {
    return {
      id: u.id,
      handle: u.handle,
      name: u.name,
      followers: u.followers,
      following: u.following,
      tweets: u.tweets,
      verified: u.verified,
      org: u.org,
      orderKey: orderMid(u).toString(),
    };
  }

  function compactUser(u) {
    return {
      id: u.id,
      handle: u.handle,
      name: u.name,
      followers: u.followers,
      verified: u.verified,
    };
  }

  function buildExport(scan) {
    const cov = coverageOf(scan);
    const notBack = sortUsers(scan.notBack, state.sort);
    const owe = sortUsers(scan.owe, state.sort);
    return {
      handle: scan.profile.handle,
      generatedAt: new Date().toISOString(),
      profile: {
        id: scan.profile.id,
        handle: scan.profile.handle,
        name: scan.profile.name,
        followers: scan.profile.followers,
        following: scan.profile.following,
        joined: scan.profile.joined,
        verified: scan.profile.verified,
      },
      stats: {
        following: scan.following.length,
        followers: scan.followers.length,
        mutual: scan.mutual,
        rate: scan.rate,
        notBack: scan.notBack.length,
        owe: scan.owe.length,
        notBackBlue: scan.notBack.filter((u) => u.verified).length,
        oweBlue: scan.owe.filter((u) => u.verified).length,
        missingFollowing: cov.missingFollowing,
        missingFollowers: cov.missingFollowers,
        followingCoverage: cov.following,
        followersCoverage: cov.followers,
        partial: cov.following < 0.9 || cov.followers < 0.9,
      },
      warnings: [...new Set(scan.warnings || [])],
      following: sortUsers(scan.following, 'recent').map(compactUser),
      followers: sortUsers(scan.followers, 'recent').map(compactUser),
      notBack: notBack.map(userToJson),
      owe: owe.map(userToJson),
    };
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(scan) {
    const rows = [['list', 'id', 'handle', 'name', 'followers', 'verified']];
    for (const [list, users] of [
      ['notBack', sortUsers(scan.notBack, state.sort)],
      ['owe', sortUsers(scan.owe, state.sort)],
    ]) {
      for (const u of users) {
        rows.push([list, u.id, u.handle, u.name, u.followers, u.verified ? 1 : 0]);
      }
    }
    return '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
  }

  // -------------------------------------------------------------------------
  // IndexedDB 缓存
  // -------------------------------------------------------------------------

  const DB_NAME = 'hackmirror-web';
  let dbPromise = null;

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('no indexedDB'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('scans')) {
            db.createObjectStore('scans', { keyPath: 'handle' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function cacheGet(handle) {
    try {
      const db = await openDB();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('scans', 'readonly');
        const req = tx.objectStore('scans').get(handle.toLowerCase());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (!record || record.version !== CACHE_VERSION || !record.profile) return null;
      return record;
    } catch {
      return null;
    }
  }

  async function cachePut(record) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('scans', 'readwrite');
        tx.objectStore('scans').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {}
  }

  function serializeUser(u) {
    return {
      ...u,
      hi: u.hi.toString(),
      lo: u.lo.toString(),
    };
  }

  function deserializeUser(u) {
    return {
      ...u,
      hi: BigInt(u.hi || '0'),
      lo: BigInt(u.lo || '0'),
      hasOrder: true,
    };
  }

  function serializeScan(scan) {
    return {
      version: CACHE_VERSION,
      handle: scan.profile.handle.toLowerCase(),
      fetchedAt: scan.fetchedAt,
      profile: {
        ...scan.profile,
        lowerBound: scan.profile.lowerBound.toString(),
      },
      following: scan.following.map(serializeUser),
      followers: scan.followers.map(serializeUser),
      warnings: scan.warnings,
    };
  }

  function hydrateScan(record) {
    const profile = {
      ...record.profile,
      lowerBound: BigInt(record.profile.lowerBound || '0'),
    };
    const following = (record.following || []).map(deserializeUser);
    const followers = (record.followers || []).map(deserializeUser);
    const comp = compareLists(profile, following, followers);
    return {
      profile,
      following: comp.following,
      followers: comp.followers,
      notBack: comp.notBack,
      owe: comp.owe,
      mutual: comp.mutual,
      rate: comp.rate,
      warnings: record.warnings || [],
      fetchedAt: record.fetchedAt,
    };
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.scanning) return;
    const handle = normalizeHandle(input.value);
    if (!handle) {
      showToast('请输入有效的 X 用户名（字母/数字/下划线）');
      input.focus();
      return;
    }
    input.value = handle;
    scanAccount(handle);
  });

  cancelBtn.addEventListener('click', () => {
    if (!state.scanning || !state.abort) return;
    state.cancelled = true;
    state.abort.abort();
  });

  retryBtn.addEventListener('click', () => {
    const handle = normalizeHandle(input.value) || state.lastHandle;
    if (handle) scanAccount(handle, { force: true });
  });

  refreshBtn.addEventListener('click', () => {
    const handle = state.scan?.profile?.handle;
    if (handle) scanAccount(handle, { force: true });
  });

  blueOnly.addEventListener('change', () => {
    state.blueOnly = blueOnly.checked;
    if (state.blueOnly && noBlue.checked) {
      noBlue.checked = false;
      state.noBlue = false;
    }
    state.limit = PAGE_SIZE;
    renderList();
  });

  noBlue.addEventListener('change', () => {
    state.noBlue = noBlue.checked;
    if (state.noBlue && blueOnly.checked) {
      blueOnly.checked = false;
      state.blueOnly = false;
    }
    state.limit = PAGE_SIZE;
    renderList();
  });

  sortSelect.addEventListener('change', () => {
    state.sort = ['recent', 'big', 'small', 'recent-big'].includes(sortSelect.value)
      ? sortSelect.value
      : 'recent';
    state.limit = PAGE_SIZE;
    renderList();
  });

  moreBtn.addEventListener('click', () => {
    state.limit += PAGE_STEP;
    renderList();
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab === 'owe' ? 'owe' : 'notBack';
      state.limit = PAGE_SIZE;
      updateTabs();
      renderList();
    });
  });

  copyBtn.addEventListener('click', async () => {
    const list = getFiltered();
    if (!list.length) {
      showToast('名单是空的');
      return;
    }
    const text = list.map((u) => `@${u.handle}`).join('\n');
    const ok = await copyText(text);
    showToast(ok ? `已复制 ${fmt(list.length)} 个用户名` : '复制失败，请手动选择');
  });

  jsonBtn.addEventListener('click', () => {
    if (!state.scan) return;
    const data = buildExport(state.scan);
    const name = `HackMirror-${state.scan.profile.handle}.json`;
    download(name, JSON.stringify(data, null, 2), 'application/json');
    showToast('JSON 已开始下载');
  });

  csvBtn.addEventListener('click', () => {
    if (!state.scan) return;
    const name = `HackMirror-${state.scan.profile.handle}.csv`;
    download(name, buildCsv(state.scan), 'text/csv;charset=utf-8');
    showToast('CSV 已开始下载');
  });

  // -------------------------------------------------------------------------
  // 启动 & PWA 注册
  // -------------------------------------------------------------------------

  // 注册 PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  updateFormState();

  const q = new URLSearchParams(location.search).get('u');
  if (q) {
    const handle = normalizeHandle(q);
    if (handle) {
      input.value = handle;
      scanAccount(handle);
    }
  } else {
    input.focus();
  }
})();
