const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const pasteBtn = document.getElementById('paste');
const clearBtn = document.getElementById('clear');

function setStatus(text) {
  statusEl.textContent = text || '';
}

function parseTargets(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    arr = raw
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => ({ id: x, handle: x }));
  }
  if (!Array.isArray(arr)) throw new Error('清单格式不对，请重新从 HackMirror 复制');
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const id = String(item && typeof item === 'object' ? item.id ?? '' : item ?? '').trim();
    if (!/^\d{3,}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, handle: String((item && item.handle) || id) });
  }
  return out;
}

function findXTab() {
  return chrome.tabs
    .query({ url: ['https://x.com/*', 'https://twitter.com/*'] })
    .then((tabs) => tabs[0] || null);
}

async function getXTab() {
  const existing = await findXTab();
  if (existing) return existing;
  const created = await chrome.tabs.create({ url: 'https://x.com/home' });
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === created.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 15000);
  });
  return created;
}

startBtn.addEventListener('click', async () => {
  try {
    const targets = parseTargets(listEl.value);
    if (!targets.length) throw new Error('没有可用的账号 ID');
    if (
      targets.length > 50 &&
      !confirm(`选了 ${targets.length} 个，建议单次不超过 50 个。继续？`)
    ) {
      return;
    }
    setStatus('正在准备 x.com 标签页…');
    const tab = await getXTab();
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [targets],
        func: runUnfollow,
      })
      .catch((e) => setStatus('注入失败：' + e.message));
    setStatus(`已开始 ${targets.length} 个。保持 x.com 标签页打开，进度看页面控制台。`);
  } catch (e) {
    setStatus('失败：' + (e && e.message ? e.message : e));
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    const tab = await findXTab();
    if (!tab) {
      setStatus('没有打开 x.com 标签页');
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__hackmirrorStop = true;
      },
    });
    setStatus('已发送停止信号');
  } catch (e) {
    setStatus('停止失败：' + e.message);
  }
});

pasteBtn.addEventListener('click', async () => {
  try {
    listEl.value = await navigator.clipboard.readText();
    setStatus('已粘贴');
  } catch {
    setStatus('读取剪贴板失败，请手动粘贴');
  }
});

clearBtn.addEventListener('click', () => {
  listEl.value = '';
  setStatus('');
});

/**
 * 在 x.com 页面主世界里执行。必须自包含，不能引用 popup 作用域。
 */
async function runUnfollow(targets) {
  const csrf = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1];
  if (!csrf) {
    alert('请先登录 x.com 再运行');
    return;
  }
  if (!confirm('将取关 ' + targets.length + ' 个账号，继续？')) return;

  const bearer =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  let ok = 0;
  let fail = 0;
  window.__hackmirrorStop = false;
  const onKey = (e) => {
    if (e.key === 'Escape') window.__hackmirrorStop = true;
  };
  addEventListener('keydown', onKey);
  console.log('[HackMirror] 开始取关', targets.length, '个');

  for (let i = 0; i < targets.length; i++) {
    if (window.__hackmirrorStop) {
      console.log('[HackMirror] 已手动停止');
      break;
    }
    const t = targets[i];
    let status = 0;
    try {
      const r = await fetch('https://x.com/i/api/1.1/friendships/destroy.json', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          authorization: 'Bearer ' + bearer,
        },
        body: 'user_id=' + encodeURIComponent(t.id),
      });
      status = r.status;
      if (r.ok) ok++;
      else fail++;
    } catch (e) {
      fail++;
    }
    console.log(
      '[HackMirror] ' +
        (i + 1) +
        '/' +
        targets.length +
        ' @' +
        t.handle +
        ' -> ' +
        (status || 'error'),
    );
    await new Promise((res) => setTimeout(res, 2000 + Math.random() * 1500));
  }

  removeEventListener('keydown', onKey);
  console.log('[HackMirror] 完成：成功 ' + ok + '，失败 ' + fail);
  alert('取关完成：成功 ' + ok + '，失败 ' + fail);
}
