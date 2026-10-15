//部署到cloudflare的短剧搜索
//环境变量DRAMA_KV  ，绑定KV空间
//环境变量TOKEN，设置密码验证

// 北京时间工具
const BEIJING_TZ = 'Asia/Shanghai';

function nowBeijing() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utc + 8 * 60 * 60_000);
}

function todayBeijingISO() {
  return toISODate(nowBeijing());
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function beijingDisplay(d = nowBeijing()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

// 统一 JSON 响应
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function ok(data, extra = {}, status = 200) {
  return json({ ok: true, ...extra, data }, status);
}

function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

// ─── Auth ───
const COOKIE_NAME = 'duanju_token';
const COOKIE_MAX_AGE = 30 * 24 * 3600;

function extractToken(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkToken(request, env) {
  const token = extractToken(request);
  if (!token || !env.TOKEN) return false;
  return safeEqual(token, env.TOKEN);
}

function setCookieHeader(token, request) {
  const isHttps = new URL(request.url).protocol === 'https:';
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=/`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    `SameSite=Lax`,
    `HttpOnly`,
  ];
  if (isHttps) flags.push('Secure');
  return flags.join('; ');
}

// ─── 自动归类 ───
function categorize(rawName) {
  let s = (rawName || '').trim();
  let title = s;
  let episodes;
  let actors = [];
  let index;

  const epMatch = s.match(/[（(](\d{1,4})\s*集[）)]/);
  if (epMatch) {
    episodes = parseInt(epMatch[1], 10);
    const idx = s.indexOf(epMatch[0]);
    const before = s.slice(0, idx);
    const after = s.slice(idx + epMatch[0].length);
    const idxMatch = before.match(/^\s*(\d{1,3})\s*[.、\-)）]\s*(.*)$/);
    if (idxMatch) {
      index = idxMatch[1].padStart(2, '0');
      title = idxMatch[2].trim();
    } else {
      title = before.trim();
    }
    const actorStr = after.trim();
    if (actorStr) {
      actors = actorStr.split(/[&＆/、，,＋+]/).map(p => p.trim()).filter(Boolean);
    }
  } else {
    const idxMatch = s.match(/^\s*(\d{1,3})\s*[.、\-)）]\s*(.*)$/);
    if (idxMatch) {
      index = idxMatch[1].padStart(2, '0');
      title = idxMatch[2].trim();
    }
  }
  title = title.replace(/[（()）「」【】\s]+$/g, '').replace(/^[（()）「」【】\s]+/g, '').trim();
  if (!title) title = s;
  return { title, episodes, actors, index };
}

function computeCategoryStats(dramas) {
  let withEpisodes = 0;
  let withActors = 0;
  const actorCount = new Map();
  for (const d of dramas) {
    if (d.episodes != null) withEpisodes++;
    if (d.actors && d.actors.length) {
      withActors++;
      for (const a of d.actors) actorCount.set(a, (actorCount.get(a) || 0) + 1);
    }
  }
  const topActors = [...actorCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return { withEpisodes, withActors, distinctActors: actorCount.size, topActors };
}

// ─── 存储层 ───
const KEY_DATA = 'data:dramas';
const KEY_META = 'meta:info';

async function getDramas(env) {
  const raw = await env.DRAMA_KV.get(KEY_DATA);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveDramas(env, dramas, source) {
  await env.DRAMA_KV.put(KEY_DATA, JSON.stringify(dramas));
  const meta = buildMeta(dramas, source);
  await env.DRAMA_KV.put(KEY_META, JSON.stringify(meta));
  return meta;
}

async function getMeta(env) {
  const raw = await env.DRAMA_KV.get(KEY_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildMeta(dramas, source) {
  let min = null;
  let max = null;
  for (const d of dramas) {
    if (!d.date) continue;
    if (!min || d.date < min) min = d.date;
    if (!max || d.date > max) max = d.date;
  }
  return {
    count: dramas.length,
    lastUpdate: new Date().toISOString(),
    dateRange: { min, max },
    source,
    categories: computeCategoryStats(dramas),
  };
}

// ─── Handlers ───
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(v) {
  const n = v ? parseInt(v, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function searchDramas(dramas, query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matched = [];
  for (const d of dramas) {
    const hay = [d.name, d.title, ...(d.actors || [])].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(q)) {
      matched.push(d);
      if (matched.length >= limit) break;
    }
  }
  return matched;
}

function dramasOnDate(dramas, dateISO) {
  return dramas.filter((d) => d.date === dateISO);
}

function latestDate(dramas) {
  let latest = null;
  for (const d of dramas) {
    if (d.date && (!latest || d.date > latest)) latest = d.date;
  }
  return latest;
}

// 搜索接口（支持分页）
async function handleSearch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  let query = url.searchParams.get('q') || '';
  if (!query && path.startsWith('/s=')) {
    query = decodeURIComponent(path.slice(3));
  } else if (!query && path.startsWith('/s/') && path.length > 3) {
    query = decodeURIComponent(path.slice(3));
  }
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10) || 20));

  const dramas = await getDramas(env);
  const q = query.trim().toLowerCase();
  let matched = [];
  if (q) {
    for (const d of dramas) {
      const hay = [d.name, d.title, ...(d.actors || [])].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) matched.push(d);
    }
  }
  const total = matched.length;
  const start = (page - 1) * size;
  const results = matched.slice(start, start + size);

  return ok(results, {
    query,
    count: results.length,
    total,
    page,
    size,
    pages: Math.max(1, Math.ceil(total / size)),
  });
}

// 最近更新（分页）
async function handleRecent(request, env) {
  const url = new URL(request.url);
  const size = clampLimit(url.searchParams.get('size'));
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const dramas = await getDramas(env);
  const latest = latestDate(dramas);
  let all = [];
  if (latest) {
    all = dramasOnDate(dramas, latest).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const total = all.length;
  const start = (page - 1) * size;
  const results = all.slice(start, start + size);
  return ok(results, {
    date: latest,
    count: results.length,
    size,
    page,
    total,
    pages: Math.max(1, Math.ceil(total / size)),
  });
}

// 全部列表（分页）
async function handleList(request, env) {
  const url = new URL(request.url);
  const size = clampLimit(url.searchParams.get('size'));
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  let dramas = await getDramas(env);
  dramas = [...dramas].sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db < da ? -1 : db > da ? 1 : 0;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const total = dramas.length;
  const start = (page - 1) * size;
  const items = dramas.slice(start, start + size);
  return ok(items, {
    page,
    size,
    total,
    pages: Math.max(1, Math.ceil(total / size)),
  });
}

// 上传
async function handleUpload(request, env) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  let payload;
  try {
    if (ct.includes('application/json')) {
      payload = await request.json();
    } else {
      return fail('仅支持 application/json', 415);
    }
  } catch (e) {
    return fail('JSON 解析失败：' + e.message, 400);
  }

  let arr;
  let mode = 'merge';
  if (Array.isArray(payload)) {
    arr = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload;
    arr = obj.records || obj.dramas || obj.data || obj.list;
    if (typeof obj.mode === 'string' && (obj.mode === 'replace' || obj.mode === 'merge')) {
      mode = obj.mode;
    }
  } else {
    arr = null;
  }
  if (!Array.isArray(arr)) {
    return fail('数据格式不正确：需要数组或 {records:[...]} 对象', 400);
  }

  const { dramas: newDramas, dropped } = normalizeDramas(arr);
  if (newDramas.length === 0) {
    return fail('未解析到有效记录', 400, { dropped });
  }

  const source = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? String(payload.source || payload.fileName || 'json-upload')
    : 'json-upload';

  const existing = mode === 'replace' ? [] : await getDramas(env);
  const totalBefore = existing.length;

  const byLink = new Map();
  for (const d of existing) byLink.set(d.link, d);

  let added = 0;
  let updated = 0;
  for (const nd of newDramas) {
    const old = byLink.get(nd.link);
    if (!old) {
      byLink.set(nd.link, nd);
      added++;
    } else {
      byLink.set(nd.link, mergeDrama(old, nd));
      updated++;
    }
  }
  const merged = Array.from(byLink.values());
  merged.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db < da ? -1 : db > da ? 1 : 0;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const totalAfter = merged.length;

  const meta = await saveDramas(env, merged, source);
  const categories = computeCategoryStats(merged);

  const message = mode === 'replace'
    ? `替换完成：共 ${totalAfter} 条${dropped ? `（忽略 ${dropped} 条无效行）` : ''}`
    : `合并完成：新增 ${added} 条，去重更新 ${updated} 条，总计 ${totalAfter} 条${dropped ? `（忽略 ${dropped} 条无效行）` : ''}`;

  return ok(merged.slice(0, 20), {
    count: totalAfter,
    added,
    updated,
    duplicates: updated,
    dropped,
    totalBefore,
    totalAfter,
    mode,
    categories,
    meta,
    message,
  });
}

// 清空数据
async function handleClear(request, env) {
  await saveDramas(env, [], null);
  return ok([], { count: 0, message: '数据已清空' });
}

// 按日期范围删除
async function handleDeleteByDateRange(request, env) {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return fail('请提供有效的 start 参数（YYYY-MM-DD）', 400);
  }
  let dramas = await getDramas(env);
  const before = dramas.length;
  let endDate = end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : start;
  dramas = dramas.filter(d => {
    if (!d.date) return true;
    return d.date < start || d.date > endDate;
  });
  const after = dramas.length;
  await saveDramas(env, dramas, null);
  return ok({ deleted: before - after, remaining: after });
}

// 按链接删除单条
async function handleDeleteByLink(request, env) {
  const url = new URL(request.url);
  const link = url.searchParams.get('link');
  if (!link) {
    return fail('请提供有效的 link 参数', 400);
  }
  let dramas = await getDramas(env);
  const before = dramas.length;
  dramas = dramas.filter(d => d.link !== link);
  const after = dramas.length;
  await saveDramas(env, dramas, null);
  return ok({ deleted: before - after, remaining: after });
}

// ─── 数据规范化 ───
function excelSerialToDate(serial) {
  if (!Number.isFinite(serial)) return null;
  const utcDays = serial - 25569;
  const ms = utcDays * 86400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mergeDrama(old, nd) {
  let date = old.date;
  if (nd.date && (!old.date || nd.date > old.date)) date = nd.date;
  return {
    name: nd.name || old.name,
    link: old.link,
    date,
    title: nd.title || old.title,
    episodes: nd.episodes ?? old.episodes,
    actors: (nd.actors && nd.actors.length) ? nd.actors : (old.actors || []),
    index: nd.index || old.index,
  };
}

function normalizeDramas(arr) {
  const seen = new Set();
  const dramas = [];
  let dropped = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') { dropped++; continue; }
    const o = item;
    const name = pickStr(o, ['name', '名称', '短剧名称', 'title']);
    let link = pickStr(o, ['link', '链接', '网盘链接', 'url', '地址']);
    let date = pickStr(o, ['date', '日期', '更新日期', 'update', 'time']);
    const rawDate = o.date ?? o['日期'] ?? o['更新日期'] ?? o.update ?? o.time;

    if (!name) { dropped++; continue; }
    if (!link || /^(前往|点击|链接|查看)$/.test(link)) {
      link = pickStr(o, ['link', '链接', '网盘链接', 'url', '地址', 'href', 'target']);
    }
    if (!link || /^(前往|点击|链接|查看)$/.test(link) || !/^https?:\/\//i.test(link)) {
      dropped++;
      continue;
    }

    let dateStr = null;
    if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
      dateStr = rawDate.toISOString().slice(0, 10);
    } else if (typeof rawDate === 'number') {
      dateStr = excelSerialToDate(rawDate);
    } else if (typeof rawDate === 'string' && rawDate.trim()) {
      const m = rawDate.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (m) dateStr = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    } else if (date) {
      const m = date.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (m) dateStr = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    }

    const key = link.trim();
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);

    const cat = categorize(name);
    dramas.push({
      name: name.trim(),
      link: key,
      date: dateStr,
      title: cat.title,
      episodes: cat.episodes,
      actors: cat.actors,
      index: cat.index,
    });
  }
  return { dramas, dropped };
}

function pickStr(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

// ─── 渲染主页 HTML ───
function renderHomeHTML(stats) {
  const source = stats?.source ?? '—';

  const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M40.366 33.388c1.738 0 3.134 1.397 3.134 3.134s-1.396 3.145-3.134 3.145s-3.145-1.407-3.145-3.145s1.408-3.134 3.145-3.134M22.058 20.303c.858 0 1.561.704 1.561 1.572s-.704 1.573-1.561 1.573a1.572 1.572 0 1 1 0-3.145m-8.896 13.085c1.726 0 3.134 1.397 3.134 3.134s-1.407 3.145-3.134 3.145c-1.737 0-3.145-1.407-3.145-3.145s1.408-3.134 3.145-3.134m-5.179.198l7.246-2.44l-1.517-4.52l-7.246 2.43zm26.885-10.93a1.572 1.572 0 1 1 0 3.145c-.858 0-1.561-.704-1.561-1.572s.704-1.573 1.561-1.573m-7.323 3.75c1.792.264 3.123 1.264 2.969 2.232c-.143.968-1.705 1.528-3.497 1.265c-1.781-.275-3.112-1.276-2.969-2.244c.154-.967 1.715-1.528 3.497-1.253"/><path d="M18.913 28.154c-2.09 3.134 2.09 6.279 4.53 4.53c1.749-1.396 4.058-1.924 5.311.594c1.672 3.244 6.906 1.155 5.861-3.034c-1.055-6.28-12.557-7.324-15.702-2.09M15.78 38.612h22.123"/><path d="M39.838 33.388c2.1-4.19-2.089-11.512 0-16.746c2.1-5.235-1.044-7.324-5.223-3.134c-3.145 3.133-6.279 3.133-8.379-1.056c-3.134-6.279-7.323-5.223-7.323 2.1c0 6.279-3.739 8.665-3.783 10.622m-4.453-1.561l-1.199 2.419l-2.419-1.199"/><path d="M10.402 34.785L8.6 35.39q-1.814.615-2.42-1.199l-1.528-4.53q-.605-1.803 1.21-2.408l7.235-2.441q1.814-.605 2.42 1.21l1.517 4.519q.615 1.814-1.199 2.419l-1.803.604"/></svg>`;
  const FAVICON_SVG = LOGO_SVG.replace('currentColor', '#e11d48');
  const FAVICON_URI = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>短剧资源库</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_URI}" />
<link rel="apple-touch-icon" href="${FAVICON_URI}" />
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root { --accent: #e11d48; --accent-d: #be123c; }
  * { -webkit-tap-highlight-color: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .card-hover { transition: transform .15s ease, box-shadow .15s ease; }
  .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 24px -8px rgba(0,0,0,.15); }
  .scroll-area { scrollbar-width: thin; scrollbar-color: #d4d4d8 transparent; }
  .scroll-area::-webkit-scrollbar { width: 8px; height: 8px; }
  .scroll-area::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 4px; }
  .scroll-area::-webkit-scrollbar-thumb:hover { background: #a1a1aa; }
  .tab-active { background: var(--accent); color: #fff; }
  .tab-active svg { color: #fff; }
  .skeleton { background: linear-gradient(90deg,#f4f4f5 25%,#e4e4e7 37%,#f4f4f5 63%); background-size: 400% 100%; animation: sk 1.4s ease infinite; }
  @keyframes sk { 0%{background-position:100% 50%} 100%{background-position:0 50%} }
  .fade-in { animation: fadeIn .25s ease; }
  @keyframes fadeIn { from{opacity:0; transform:translateY(4px)} to{opacity:1; transform:translateY(0)} }
  input:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .logo-icon { width: 36px; height: 36px; color: #e11d48; }

  /* 搜索框清除按钮放大 */
  input[type="search"]::-webkit-search-cancel-button {
    -webkit-appearance: none;
    height: 20px;
    width: 20px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23999'%3E%3Cpath d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/%3E%3C/svg%3E") no-repeat center;
    background-size: 20px 20px;
    cursor: pointer;
  }
  input[type="search"]::-webkit-search-cancel-button:hover {
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23555'%3E%3Cpath d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/%3E%3C/svg%3E") no-repeat center;
    background-size: 20px 20px;
  }

  /* 分页组件样式 */
  .ant-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: rgba(0,0,0,0.65);
    justify-content: center;
  }
  .ant-pagination-prev,
  .ant-pagination-next,
  .ant-pagination-item,
  .ant-pagination-jump-prev,
  .ant-pagination-jump-next {
    display: inline-block;
    min-width: 32px;
    height: 32px;
    line-height: 32px;
    text-align: center;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    cursor: pointer;
    background: #fff;
    transition: all .3s;
    user-select: none;
  }
  .ant-pagination-item-active {
    border-color: var(--accent);
    background: #fff !important;
  }
  .ant-pagination-item-active a {
    color: var(--accent) !important;
  }
  .ant-pagination-jump-prev .ant-pagination-item-container,
  .ant-pagination-jump-next .ant-pagination-item-container {
    display: inline-block;
    width: 32px;
    text-align: center;
  }
  .ant-pagination-jump-prev .ant-pagination-item-link-icon,
  .ant-pagination-jump-next .ant-pagination-item-link-icon {
    display: none;
  }
  .ant-pagination-jump-prev:hover .ant-pagination-item-link-icon,
  .ant-pagination-jump-next:hover .ant-pagination-item-link-icon {
    display: inline-block;
  }
  .ant-pagination-jump-prev:hover .ant-pagination-item-ellipsis,
  .ant-pagination-jump-next:hover .ant-pagination-item-ellipsis {
    display: none;
  }
  .ant-pagination-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ant-pagination-disabled a {
    pointer-events: none;
  }
  .ant-pagination-prev a,
  .ant-pagination-next a {
    display: block;
    color: rgba(0,0,0,0.65);
    text-decoration: none;
  }
  .ant-pagination-item a {
    display: block;
    color: rgba(0,0,0,0.65);
    text-decoration: none;
    transition: none;
  }
  .ant-pagination-item:hover {
    border-color: var(--accent);
  }
  .ant-pagination-item:hover a {
    color: var(--accent);
  }
  .ant-pagination-options {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: 8px;
  }
  .ant-pagination-options-size-changer select {
    height: 32px;
    padding: 0 8px;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
  }
  .ant-pagination-options-quick-jumper {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ant-pagination-options-quick-jumper input {
    width: 48px;
    height: 32px;
    padding: 0 4px;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    text-align: center;
    font-size: 14px;
  }
  .ant-pagination-options-quick-jumper input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .anticon {
    display: inline-block;
    line-height: 1;
  }
  .anticon svg {
    display: inline-block;
    vertical-align: -0.125em;
    width: 1em;
    height: 1em;
  }
  .ant-pagination-prev .anticon,
  .ant-pagination-next .anticon {
    font-size: 12px;
  }
  @media (max-width: 640px) {
    .ant-pagination { gap: 4px; font-size: 12px; }
    .ant-pagination-item,
    .ant-pagination-prev,
    .ant-pagination-next,
    .ant-pagination-jump-prev,
    .ant-pagination-jump-next {
      min-width: 28px;
      height: 28px;
      line-height: 28px;
    }
    .ant-pagination-options-size-changer select { height: 28px; font-size: 12px; }
    .ant-pagination-options-quick-jumper input { height: 28px; width: 40px; font-size: 12px; }
  }
</style>
</head>
<body class="min-h-screen flex flex-col bg-zinc-50 text-zinc-800">
  <header class="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-zinc-200">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="shrink-0">${LOGO_SVG.replace('<svg ', '<svg class="logo-icon" ')}</div>
        <div class="min-w-0">
          <h1 class="font-bold text-base sm:text-lg leading-tight truncate">短剧资源库</h1>
        </div>
      </div>
      <a href="/admin" class="text-sm text-rose-600 hover:underline">管理</a>
    </div>
  </header>

  <main class="flex-1 w-full max-w-5xl mx-auto px-4 py-5">
    <nav class="flex gap-1.5 mb-5 overflow-x-auto scroll-area pb-1" role="tablist">
      ${tabBtn('search', '搜索短剧', 'magnifier', true)}
      ${tabBtn('latest', '最近更新', 'sparkles')}
      ${tabBtn('all', '全部短剧', 'list')}
      ${tabBtn('api', '资源接口', 'code')}
    </nav>

    <!-- 搜索 Tab -->
    <section id="tab-search" class="tab-panel">
      <div class="relative mb-4">
        <svg class="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="search-input" type="search" placeholder="输入短剧名称关键词，如「咬夏阳」「王培延」…" autocomplete="off"
          class="w-full pl-11 pr-4 py-3 rounded-xl border border-zinc-200 bg-white text-sm sm:text-base focus:border-rose-400 transition" />
      </div>
      <div id="search-results" class="space-y-2.5"></div>
      <div id="search-pagination" class="mt-4"></div>
    </section>

    <!-- 最近更新 Tab -->
    <section id="tab-latest" class="tab-panel hidden">
      <div id="latest-results" class="space-y-2.5"></div>
      <div id="latest-pagination" class="mt-4"></div>
    </section>

    <!-- 全部短剧 Tab -->
    <section id="tab-all" class="tab-panel hidden">
      <div id="all-results" class="space-y-2.5"></div>
      <div id="all-pagination" class="mt-4"></div>
    </section>

    <!-- API 文档 Tab -->
    <section id="tab-api" class="tab-panel hidden">
      ${apiDocsHTML()}
    </section>
  </main>

  <div id="toast" class="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 hidden">
    <div id="toast-inner" class="px-4 py-2.5 rounded-xl text-sm font-medium text-white shadow-lg"></div>
  </div>

<script>
${HOME_JS}
</script>
</body>
</html>`;
}

// ─── 辅助 HTML 片段 ───
function tabBtn(id, label, _icon, active = false) {
  const icons = {
    magnifier: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  };
  return `<button data-tab="${id}" role="tab" class="tab-btn shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${active ? 'tab-active' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'}">
    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[_icon]}</svg>
    ${label}
  </button>`;
}

// API 文档
function apiDocsHTML() {
  return `<div class="space-y-4">
    ${apiEndpoint('GET', '/s=短剧名称', `搜索短剧，按名称/剧名/演员模糊匹配`, `curl "https://example.com/s=咬夏阳"`, `{
  "ok": true,
  "query": "咬夏阳",
  "count": 1,
  "total": 64178,
  "data": [
    {
      "name": "01.咬夏阳（76集）王培延&至春禾",
      "link": "https://pan.quark.cn/s/935572a80452",
      "date": "2026-08-09",
      "title": "咬夏阳",
      "episodes": 76,
      "actors": ["王培延", "至春禾"]
    }
  ]
}`, '可选参数 ?limit=50（最大 200）。也支持 /s?q=名称 或 /s/名称')}

    ${apiEndpoint('GET', '/api/recent?page=1&size=10', `最近一次有更新日期的短剧（分页）`, `curl "https://example.com/api/recent?page=1&size=10"`, `{
  "ok": true,
  "date": "2026-08-09",
  "total": 267,
  "page": 1,
  "pages": 27,
  "data": [ ... ]
}`, 'page 从 1 开始，size 默认 50 最大 200')}

    ${apiEndpoint('GET', '/api/list?page=1&size=10', `全部短剧分页浏览（按日期倒序）`, `curl "https://example.com/api/list?page=1&size=10"`, `{
  "ok": true,
  "total": 64178,
  "page": 1,
  "pages": 6418,
  "data": [ ... ]
}`, '')}
  </div>`;
}

function apiEndpoint(method, path, desc, example, response, note) {
  const methodColor = method === 'GET' ? 'bg-emerald-100 text-emerald-700' : method === 'POST' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return `<div class="bg-white rounded-2xl border border-zinc-200 p-5 sm:p-6">
    <div class="flex items-center gap-2 flex-wrap mb-2">
      <span class="px-2 py-0.5 rounded text-xs font-bold ${methodColor}">${method}</span>
      <code class="text-sm font-mono text-zinc-800 break-all">${path}</code>
    </div>
    <p class="text-sm text-zinc-500 mb-3">${desc}</p>
    <div class="mb-2">
      <p class="text-xs text-zinc-400 mb-1">请求示例</p>
      <pre class="bg-zinc-900 text-zinc-100 rounded-lg p-3 text-xs overflow-x-auto scroll-area"><code>${escapeForAttr(example)}</code></pre>
    </div>
    <div>
      <p class="text-xs text-zinc-400 mb-1">返回示例</p>
      <pre class="bg-zinc-50 border border-zinc-200 rounded-lg p-3 text-xs overflow-x-auto scroll-area"><code>${escapeForAttr(response)}</code></pre>
    </div>
    ${note ? `<p class="text-xs text-zinc-400 mt-2">💡 ${note}</p>` : ''}
  </div>`;
}

function escapeForAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 主页 JS ───
const HOME_JS = `
(function(){
  "use strict";
  var SP = new URLSearchParams(location.search);
  var TOKEN = SP.get('token') || (localStorage.getItem('duanju_token') || '');
  var XPORT = SP.get('XTransformPort') || '';

  function apiUrl(path, withToken){
    var u = new URL(path, location.origin);
    if(withToken && TOKEN) u.searchParams.set('token', TOKEN);
    if(XPORT) u.searchParams.set('XTransformPort', XPORT);
    return u.toString();
  }
  async function api(path){
    var res = await fetch(apiUrl(path, false), { credentials: 'include' });
    if(res.status === 401){ showToast('Token 无效或已过期', 'error'); throw new Error('401'); }
    return res.json();
  }

  // Toast
  var toastTimer;
  function showToast(msg, type){
    type = type || 'info';
    var colors = { info:'#18181b', success:'#15803d', error:'#dc2626', warn:'#d97706' };
    var el = document.getElementById('toast');
    var inner = document.getElementById('toast-inner');
    if (!el || !inner) return;
    inner.textContent = msg;
    inner.style.background = colors[type] || colors.info;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, 3200);
  }

  // 渲染卡片（标题只显示剧名+集数，日期绿色）
  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function dramaCard(d, idx){
    var titleText = d.title || d.name;
    var epText = d.episodes ? '（' + d.episodes + '集）' : '';
    var displayTitle = titleText + epText;
    var dateBadge = d.date ? '<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium">'+escapeHtml(d.date)+'</span>' : '';
    var epBadge = d.episodes ? '<span class="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-xs font-medium">'+escapeHtml(d.episodes)+'集</span>' : '';
    var actorChips = (d.actors && d.actors.length)
      ? d.actors.slice(0,3).map(function(a){ return '<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 text-xs">'+escapeHtml(a)+'</span>'; }).join('') + (d.actors.length>3 ? '<span class="text-xs text-zinc-400">+'+(d.actors.length-3)+'</span>' : '')
      : '';
    return '<div class="fade-in bg-white rounded-xl border border-zinc-200 p-3.5 card-hover flex items-start gap-3">'+
      '<div class="w-7 h-7 rounded-lg bg-rose-50 text-rose-600 grid place-items-center text-xs font-bold shrink-0">'+(idx+1)+'</div>'+
      '<div class="flex-1 min-w-0">'+
        '<p class="font-medium text-sm sm:text-base text-zinc-800 break-all leading-snug">'+escapeHtml(displayTitle)+'</p>'+
        '<div class="flex items-center gap-1.5 mt-1.5 flex-wrap">'+dateBadge+epBadge+actorChips+'</div>'+
        '<div class="flex items-center gap-1 mt-1 flex-wrap"><span class="truncate text-xs text-zinc-400">'+escapeHtml(shortLink(d.link))+'</span></div>'+
      '</div>'+
      '<div class="flex flex-col gap-1.5 shrink-0">'+
        '<a href="'+escapeHtml(d.link)+'" target="_blank" rel="noopener" class="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 transition inline-flex items-center gap-1">前往<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17 17 7M7 7h10v10"/></svg></a>'+
        '<button class="copy-btn px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-500 text-xs hover:bg-zinc-50 transition" data-link="'+escapeHtml(d.link)+'">复制</button>'+
      '</div>'+
    '</div>';
  }
  function shortLink(l){ try{ var u=new URL(l); return u.hostname + (u.pathname.length>20?u.pathname.slice(0,20)+'…':u.pathname); }catch(e){ return l; } }
  function emptyState(text){ return '<div class="text-center py-12 text-zinc-400"><svg class="w-12 h-12 mx-auto mb-3 text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><p class="text-sm">'+text+'</p></div>'; }
  function loadingSkeleton(n){ var h=''; for(var i=0;i<n;i++){ h+='<div class="skeleton rounded-xl h-16"></div>'; } return h; }
  function renderList(container, items){ if(!items.length){ container.innerHTML = emptyState('暂无数据'); return; } container.innerHTML = items.map(function(d,i){ return dramaCard(d,i); }).join(''); }

  // ─── 通用分页组件 ───
  function renderPagination(containerId, total, page, size, pages, onPageChange, onSizeChange) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (total === 0) { container.innerHTML = ''; return; }
    var html = '<div class="ant-pagination mini">';
    html += '<div class="ant-pagination-total-text">共 ' + total + ' 条</div>';

    var disabledPrev = page <= 1 ? ' ant-pagination-disabled' : '';
    html += '<div title="上一页" class="ant-pagination-prev' + disabledPrev + '" aria-disabled="' + (page<=1) + '">' +
      '<a class="ant-pagination-item-link"><i class="anticon anticon-left"><svg viewBox="64 64 896 896" data-icon="left" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 0 0 0 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"></path></svg></i></a></div>';

    var startPage = Math.max(1, page - 2);
    var endPage = Math.min(pages, page + 2);
    if (startPage > 1) {
      html += '<div title="1" class="ant-pagination-item ant-pagination-item-1" data-page="1"><a>1</a></div>';
      if (startPage > 2) {
        html += '<div class="ant-pagination-jump-prev"><a class="ant-pagination-item-link"><div class="ant-pagination-item-container"><i class="anticon anticon-double-left ant-pagination-item-link-icon"><svg viewBox="64 64 896 896" data-icon="double-left" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M272.9 512l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L186.8 492.3a31.99 31.99 0 0 0 0 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H532c6.7 0 10.4-7.7 6.3-12.9L272.9 512zm304 0l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L490.8 492.3a31.99 31.99 0 0 0 0 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H836c6.7 0 10.4-7.7 6.3-12.9L576.9 512z"></path></svg></i><span class="ant-pagination-item-ellipsis">•••</span></div></a></div>';
      }
    }
    for (var i = startPage; i <= endPage; i++) {
      var active = i === page ? ' ant-pagination-item-active' : '';
      html += '<div title="' + i + '" class="ant-pagination-item ant-pagination-item-' + i + active + '" data-page="' + i + '"><a>' + i + '</a></div>';
    }
    if (endPage < pages) {
      if (endPage < pages - 1) {
        html += '<div class="ant-pagination-jump-next"><a class="ant-pagination-item-link"><div class="ant-pagination-item-container"><i class="anticon anticon-double-right ant-pagination-item-link-icon"><svg viewBox="64 64 896 896" data-icon="double-right" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M533.2 492.3L277.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H188c-6.7 0-10.4 7.7-6.3 12.9L447.1 512 181.7 851.1A7.98 7.98 0 0 0 188 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5zm304 0L581.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H492c-6.7 0-10.4 7.7-6.3 12.9L751.1 512 485.7 851.1A7.98 7.98 0 0 0 492 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5z"></path></svg></i><span class="ant-pagination-item-ellipsis">•••</span></div></a></div>';
      }
      html += '<div title="' + pages + '" class="ant-pagination-item ant-pagination-item-' + pages + '" data-page="' + pages + '"><a>' + pages + '</a></div>';
    }

    var disabledNext = page >= pages ? ' ant-pagination-disabled' : '';
    html += '<div title="下一页" class="ant-pagination-next' + disabledNext + '" aria-disabled="' + (page>=pages) + '">' +
      '<a class="ant-pagination-item-link"><i class="anticon anticon-right"><svg viewBox="64 64 896 896" data-icon="right" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M765.7 486.8L314.9 134.7A7.97 7.97 0 0 0 302 141v77.3c0 4.9 2.3 9.6 6.1 12.6l360 281.1-360 281.1c-3.9 3-6.1 7.7-6.1 12.6V883c0 6.7 7.7 10.4 12.9 6.3l450.8-352.1a31.96 31.96 0 0 0 0-50.4z"></path></svg></i></a></div>';

    html += '<div class="ant-pagination-options">' +
      '<div class="ant-pagination-options-size-changer"><select id="' + containerId + '-size-select">' +
        '<option value="10"' + (size===10?' selected':'') + '>10 条/页</option>' +
        '<option value="20"' + (size===20?' selected':'') + '>20 条/页</option>' +
        '<option value="50"' + (size===50?' selected':'') + '>50 条/页</option>' +
      '</select></div>' +
      '<div class="ant-pagination-options-quick-jumper">跳至<input id="' + containerId + '-jump-input" type="text" value="' + page + '">页</div>' +
    '</div>';

    html += '</div>';
    container.innerHTML = html;

    // 绑定事件
    var prev = container.querySelector('.ant-pagination-prev');
    if (prev && !prev.classList.contains('ant-pagination-disabled')) {
      prev.addEventListener('click', function(e){ e.preventDefault(); if (page > 1) onPageChange(page - 1); });
    }
    var next = container.querySelector('.ant-pagination-next');
    if (next && !next.classList.contains('ant-pagination-disabled')) {
      next.addEventListener('click', function(e){ e.preventDefault(); if (page < pages) onPageChange(page + 1); });
    }
    container.querySelectorAll('.ant-pagination-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        var p = parseInt(el.getAttribute('data-page'), 10);
        if (!isNaN(p) && p !== page) onPageChange(p);
      });
    });
    var select = document.getElementById(containerId + '-size-select');
    if (select) {
      select.addEventListener('change', function(e) {
        var newSize = parseInt(select.value, 10);
        if (!isNaN(newSize) && newSize !== size) onSizeChange(newSize);
      });
    }
    var jumpInput = document.getElementById(containerId + '-jump-input');
    if (jumpInput) {
      jumpInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          var val = parseInt(jumpInput.value, 10);
          if (!isNaN(val) && val >= 1 && val <= pages) onPageChange(val);
          else jumpInput.value = page;
        }
      });
      jumpInput.addEventListener('blur', function() {
        var val = parseInt(jumpInput.value, 10);
        if (!isNaN(val) && val >= 1 && val <= pages) onPageChange(val);
        else jumpInput.value = page;
      });
    }
  }

  // ─── Tab 切换 ───
  var tabs = document.querySelectorAll('.tab-btn');
  var panels = document.querySelectorAll('.tab-panel');
  var loadedTabs = {};
  tabs.forEach(function(btn){
    btn.addEventListener('click', function(){
      var id = btn.getAttribute('data-tab');
      tabs.forEach(function(b){ b.classList.remove('tab-active'); b.classList.add('bg-white','border','border-zinc-200','text-zinc-600','hover:bg-zinc-50'); });
      btn.classList.add('tab-active'); btn.classList.remove('bg-white','border','border-zinc-200','text-zinc-600','hover:bg-zinc-50');
      panels.forEach(function(p){ p.classList.add('hidden'); });
      document.getElementById('tab-'+id).classList.remove('hidden');
      if(!loadedTabs[id]){ loadTab(id); }
    });
  });

  function loadTab(id){
    if(id==='latest') loadLatest(1);
    else if(id==='all') loadAll(1);
    loadedTabs[id]=true;
  }

  // ─── 搜索 ───
  var searchPage = 1, searchSize = 10, searchTotal = 0, searchPages = 1, searchQuery = '';
  var searchInput = document.getElementById('search-input');
  var searchResults = document.getElementById('search-results');
  var searchPagination = document.getElementById('search-pagination');

  function doSearch(q, page, size) {
    if (!q) { searchResults.innerHTML = ''; searchPagination.innerHTML = ''; return; }
    searchResults.innerHTML = loadingSkeleton(5);
    var url = '/s=' + encodeURIComponent(q) + '?page=' + page + '&size=' + size;
    api(url).then(function(r) {
      searchTotal = r.total || 0;
      searchPages = r.pages || 1;
      renderList(searchResults, r.data || []);
      renderPagination('search-pagination', searchTotal, page, size, searchPages,
        function(newPage) { searchPage = newPage; doSearch(searchQuery, searchPage, searchSize); },
        function(newSize) { searchSize = newSize; searchPage = 1; doSearch(searchQuery, searchPage, searchSize); }
      );
    }).catch(function(e) {
      searchResults.innerHTML = emptyState('搜索失败，请重试');
      searchPagination.innerHTML = '';
    });
  }

  var searchTimer;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimer);
    var q = searchInput.value.trim();
    if (!q) { searchResults.innerHTML = ''; searchPagination.innerHTML = ''; return; }
    searchTimer = setTimeout(function() {
      searchQuery = q;
      searchPage = 1;
      doSearch(searchQuery, searchPage, searchSize);
    }, 280);
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      searchQuery = searchInput.value.trim();
      if (searchQuery) {
        searchPage = 1;
        doSearch(searchQuery, searchPage, searchSize);
      }
    }
  });

  // ─── 最近更新 ───
  var latestPage = 1, latestSize = 10;
  function loadLatest(page) {
    latestPage = page;
    var box = document.getElementById('latest-results');
    box.innerHTML = loadingSkeleton(5);
    api('/api/recent?page='+page+'&size='+latestSize).then(function(r) {
      renderList(box, r.data||[]);
      renderPagination('latest-pagination', r.total, page, latestSize, r.pages,
        function(newPage) { loadLatest(newPage); },
        function(newSize) { latestSize = newSize; latestPage = 1; loadLatest(1); }
      );
    }).catch(function(e) {
      box.innerHTML = emptyState('加载失败');
      document.getElementById('latest-pagination').innerHTML = '';
    });
  }

  // ─── 全部短剧 ───
  var allPage = 1, allSize = 10;
  function loadAll(page) {
    allPage = page;
    var box = document.getElementById('all-results');
    box.innerHTML = loadingSkeleton(10);
    api('/api/list?page='+page+'&size='+allSize).then(function(r) {
      renderList(box, r.data||[]);
      renderPagination('all-pagination', r.total, page, allSize, r.pages,
        function(newPage) { loadAll(newPage); },
        function(newSize) { allSize = newSize; allPage = 1; loadAll(1); }
      );
    }).catch(function(e) {
      box.innerHTML = emptyState('加载失败');
      document.getElementById('all-pagination').innerHTML = '';
    });
  }

  // 复制链接
  document.body.addEventListener('click', function(e){
    var btn = e.target.closest('.copy-btn');
    if(!btn) return;
    var link = btn.getAttribute('data-link');
    navigator.clipboard.writeText(link).then(function(){ showToast('链接已复制','success'); btn.textContent='已复制'; setTimeout(function(){btn.textContent='复制';},1500); });
  });

  // 初始化加载
  setTimeout(function(){ 
    var input = document.getElementById('search-input');
    if (input) input.focus();
  }, 200);
})();
`;

// ─── 管理页面 HTML ───
function renderAdminHTML() {
  const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M40.366 33.388c1.738 0 3.134 1.397 3.134 3.134s-1.396 3.145-3.134 3.145s-3.145-1.407-3.145-3.145s1.408-3.134 3.145-3.134M22.058 20.303c.858 0 1.561.704 1.561 1.572s-.704 1.573-1.561 1.573a1.572 1.572 0 1 1 0-3.145m-8.896 13.085c1.726 0 3.134 1.397 3.134 3.134s-1.407 3.145-3.134 3.145c-1.737 0-3.145-1.407-3.145-3.145s1.408-3.134 3.145-3.134m-5.179.198l7.246-2.44l-1.517-4.52l-7.246 2.43zm26.885-10.93a1.572 1.572 0 1 1 0 3.145c-.858 0-1.561-.704-1.561-1.572s.704-1.573 1.561-1.573m-7.323 3.75c1.792.264 3.123 1.264 2.969 2.232c-.143.968-1.705 1.528-3.497 1.265c-1.781-.275-3.112-1.276-2.969-2.244c.154-.967 1.715-1.528 3.497-1.253"/><path d="M18.913 28.154c-2.09 3.134 2.09 6.279 4.53 4.53c1.749-1.396 4.058-1.924 5.311.594c1.672 3.244 6.906 1.155 5.861-3.034c-1.055-6.28-12.557-7.324-15.702-2.09M15.78 38.612h22.123"/><path d="M39.838 33.388c2.1-4.19-2.089-11.512 0-16.746c2.1-5.235-1.044-7.324-5.223-3.134c-3.145 3.133-6.279 3.133-8.379-1.056c-3.134-6.279-7.323-5.223-7.323 2.1c0 6.279-3.739 8.665-3.783 10.622m-4.453-1.561l-1.199 2.419l-2.419-1.199"/><path d="M10.402 34.785L8.6 35.39q-1.814.615-2.42-1.199l-1.528-4.53q-.605-1.803 1.21-2.408l7.235-2.441q1.814-.605 2.42 1.21l1.517 4.519q.615 1.814-1.199 2.419l-1.803.604"/></svg>`;
  const FAVICON_SVG = LOGO_SVG.replace('currentColor', '#e11d48');
  const FAVICON_URI = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>管理后台 - 短剧资源库</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_URI}" />
<link rel="apple-touch-icon" href="${FAVICON_URI}" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>
<style>
  :root { --accent: #e11d48; --accent-d: #be123c; }
  * { -webkit-tap-highlight-color: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .card-hover { transition: transform .15s ease, box-shadow .15s ease; }
  .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 24px -8px rgba(0,0,0,.15); }
  .scroll-area { scrollbar-width: thin; scrollbar-color: #d4d4d8 transparent; }
  .scroll-area::-webkit-scrollbar { width: 8px; height: 8px; }
  .scroll-area::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 4px; }
  .scroll-area::-webkit-scrollbar-thumb:hover { background: #a1a1aa; }
  .skeleton { background: linear-gradient(90deg,#f4f4f5 25%,#e4e4e7 37%,#f4f4f5 63%); background-size: 400% 100%; animation: sk 1.4s ease infinite; }
  @keyframes sk { 0%{background-position:100% 50%} 100%{background-position:0 50%} }
  .fade-in { animation: fadeIn .25s ease; }
  @keyframes fadeIn { from{opacity:0; transform:translateY(4px)} to{opacity:1; transform:translateY(0)} }
  input:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .drag-over { border-color: var(--accent) !important; background: #fff1f2 !important; }
  .logo-icon { width: 36px; height: 36px; color: #e11d48; }
  .delete-btn {
    background: #fee2e2;
    color: #dc2626;
    border: none;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .delete-btn:hover { background: #fca5a5; }

  /* 分页组件样式（与主页保持一致） */
  .ant-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: rgba(0,0,0,0.65);
    justify-content: center;
  }
  .ant-pagination-prev,
  .ant-pagination-next,
  .ant-pagination-item,
  .ant-pagination-jump-prev,
  .ant-pagination-jump-next {
    display: inline-block;
    min-width: 32px;
    height: 32px;
    line-height: 32px;
    text-align: center;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    cursor: pointer;
    background: #fff;
    transition: all .3s;
    user-select: none;
  }
  .ant-pagination-item-active {
    border-color: var(--accent);
    background: #fff !important;
  }
  .ant-pagination-item-active a {
    color: var(--accent) !important;
  }
  .ant-pagination-jump-prev .ant-pagination-item-container,
  .ant-pagination-jump-next .ant-pagination-item-container {
    display: inline-block;
    width: 32px;
    text-align: center;
  }
  .ant-pagination-jump-prev .ant-pagination-item-link-icon,
  .ant-pagination-jump-next .ant-pagination-item-link-icon {
    display: none;
  }
  .ant-pagination-jump-prev:hover .ant-pagination-item-link-icon,
  .ant-pagination-jump-next:hover .ant-pagination-item-link-icon {
    display: inline-block;
  }
  .ant-pagination-jump-prev:hover .ant-pagination-item-ellipsis,
  .ant-pagination-jump-next:hover .ant-pagination-item-ellipsis {
    display: none;
  }
  .ant-pagination-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ant-pagination-disabled a {
    pointer-events: none;
  }
  .ant-pagination-prev a,
  .ant-pagination-next a {
    display: block;
    color: rgba(0,0,0,0.65);
    text-decoration: none;
  }
  .ant-pagination-item a {
    display: block;
    color: rgba(0,0,0,0.65);
    text-decoration: none;
    transition: none;
  }
  .ant-pagination-item:hover {
    border-color: var(--accent);
  }
  .ant-pagination-item:hover a {
    color: var(--accent);
  }
  .ant-pagination-options {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: 8px;
  }
  .ant-pagination-options-size-changer select {
    height: 32px;
    padding: 0 8px;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
  }
  .ant-pagination-options-quick-jumper {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ant-pagination-options-quick-jumper input {
    width: 48px;
    height: 32px;
    padding: 0 4px;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    text-align: center;
    font-size: 14px;
  }
  .ant-pagination-options-quick-jumper input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .anticon {
    display: inline-block;
    line-height: 1;
  }
  .anticon svg {
    display: inline-block;
    vertical-align: -0.125em;
    width: 1em;
    height: 1em;
  }
  .ant-pagination-prev .anticon,
  .ant-pagination-next .anticon {
    font-size: 12px;
  }
  @media (max-width: 640px) {
    .ant-pagination { gap: 4px; font-size: 12px; }
    .ant-pagination-item,
    .ant-pagination-prev,
    .ant-pagination-next,
    .ant-pagination-jump-prev,
    .ant-pagination-jump-next {
      min-width: 28px;
      height: 28px;
      line-height: 28px;
    }
    .ant-pagination-options-size-changer select { height: 28px; font-size: 12px; }
    .ant-pagination-options-quick-jumper input { height: 28px; width: 40px; font-size: 12px; }
  }
</style>
</head>
<body class="min-h-screen flex flex-col bg-zinc-50 text-zinc-800">
  <header class="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-zinc-200">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="shrink-0">${LOGO_SVG.replace('<svg ', '<svg class="logo-icon" ')}</div>
        <div class="min-w-0">
          <h1 class="font-bold text-base sm:text-lg leading-tight truncate">管理后台</h1>
        </div>
      </div>
      <a href="/" class="text-sm text-rose-600 hover:underline">返回首页</a>
    </div>
  </header>

  <main class="flex-1 w-full max-w-5xl mx-auto px-4 py-5">
    <div class="bg-white rounded-2xl border border-zinc-200 p-5 sm:p-6 space-y-5">
      <!-- 上传区域 -->
      <div>
        <h2 class="font-semibold text-base mb-1">上传短剧表格</h2>
        <p class="text-sm text-zinc-500 leading-relaxed">
          支持 <code class="px-1.5 py-0.5 rounded bg-zinc-100 text-rose-600 text-xs">.xlsx / .xls / .csv</code> 文件，需包含「短剧名称」「网盘链接」「更新日期」三列。
          表格在<span class="text-rose-600 font-medium">浏览器本地</span>解析，仅把整理后的 JSON 提交到接口。
        </p>
        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-medium"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>自动归类</span>
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-medium"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>自动去重</span>
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-medium"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>合并导入</span>
          <span class="text-xs text-zinc-400 self-center">每次上传自动解析剧名（集数/演员）、按链接去重并与现有数据合并</span>
        </div>
      </div>

      <div id="drop-zone" class="border-2 border-dashed border-zinc-300 rounded-xl p-8 text-center cursor-pointer transition hover:border-rose-400 hover:bg-rose-50/50">
        <svg class="w-10 h-10 mx-auto mb-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <p class="text-sm text-zinc-600 font-medium">点击选择文件或拖拽到此处</p>
        <p class="text-xs text-zinc-400 mt-1">支持超链接识别（“前往”按钮会自动提取真实链接）</p>
        <input id="file-input" type="file" accept=".xlsx,.xls,.csv" class="hidden" />
      </div>

      <div id="parse-status" class="hidden"></div>

      <div id="parse-preview" class="hidden">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-medium text-sm">解析预览（前 10 条）</h3>
          <span id="preview-count" class="text-xs text-zinc-400"></span>
        </div>
        <div id="preview-list" class="space-y-1.5 max-h-64 overflow-y-auto scroll-area bg-zinc-50 rounded-lg p-3"></div>
        <div class="flex gap-2 mt-4">
          <button id="confirm-upload" class="flex-1 px-4 py-2.5 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 transition disabled:opacity-50 disabled:cursor-not-allowed">确认导入 <span id="confirm-count"></span></button>
          <button id="cancel-upload" class="px-4 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm hover:bg-zinc-50 transition">取消</button>
        </div>
      </div>

      <!-- 数据管理 -->
      <div class="border-t border-zinc-100 pt-4 mt-2">
        <h3 class="font-medium text-sm mb-2 text-zinc-700">数据管理</h3>
        <!-- 日期范围删除 -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <span class="text-xs text-zinc-500">按日期范围删除：</span>
          <input id="delete-start" type="date" class="px-2 py-1 border border-zinc-300 rounded text-sm" />
          <span class="text-xs text-zinc-400">至</span>
          <input id="delete-end" type="date" class="px-2 py-1 border border-zinc-300 rounded text-sm" />
          <button id="delete-range-btn" class="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs hover:bg-red-50 transition">删除范围</button>
        </div>
        <!-- 搜索单个删除 -->
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs text-zinc-500">搜索删除：</span>
          <input id="search-delete-input" type="text" placeholder="输入关键词搜索…" class="flex-1 px-2 py-1 border border-zinc-300 rounded text-sm" />
          <button id="search-delete-btn" class="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs hover:bg-rose-700 transition">搜索</button>
          <button id="reset-delete-list" class="px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-xs hover:bg-zinc-50 transition hidden">显示全部</button>
        </div>
        <!-- 列表 -->
        <div class="mt-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs text-zinc-500">数据列表：</span>
            <span id="manage-stats" class="text-xs text-zinc-400"></span>
          </div>
          <div id="manage-list" class="space-y-1.5 max-h-80 overflow-y-auto scroll-area"></div>
          <div id="manage-pagination" class="mt-2"></div>
        </div>
        <!-- 清空全部 -->
        <div class="mt-3">
          <button id="clear-data" class="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs hover:bg-red-50 transition">清空全部数据</button>
        </div>
      </div>
    </div>
  </main>

  <div id="toast" class="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 hidden">
    <div id="toast-inner" class="px-4 py-2.5 rounded-xl text-sm font-medium text-white shadow-lg"></div>
  </div>

<script>
${ADMIN_JS}
</script>
</body>
</html>`;
}

// ─── 管理页 JS ───
const ADMIN_JS = `
(function(){
  "use strict";
  var SP = new URLSearchParams(location.search);
  var TOKEN = SP.get('token') || (localStorage.getItem('duanju_token') || '');
  var XPORT = SP.get('XTransformPort') || '';

  function apiUrl(path, withToken){
    var u = new URL(path, location.origin);
    if(withToken && TOKEN) u.searchParams.set('token', TOKEN);
    if(XPORT) u.searchParams.set('XTransformPort', XPORT);
    return u.toString();
  }

  async function apiWrite(path, options){
    var opts = options || {};
    opts.credentials = 'include';
    var res = await fetch(apiUrl(path, true), opts);
    var contentType = res.headers.get('content-type') || '';
    if (res.status === 401) {
      throw new Error('未授权');
    }
    if (contentType.includes('application/json')) {
      return await res.json();
    } else {
      var text = await res.text();
      throw new Error('服务器返回非 JSON 格式: ' + text.substring(0, 100));
    }
  }

  async function api(path){
    var res = await fetch(apiUrl(path, false), { credentials: 'include' });
    if(res.status === 401){ showToast('Token 无效或已过期', 'error'); throw new Error('401'); }
    return res.json();
  }

  // Toast
  var toastTimer;
  function showToast(msg, type){
    type = type || 'info';
    var colors = { info:'#18181b', success:'#15803d', error:'#dc2626', warn:'#d97706' };
    var el = document.getElementById('toast');
    var inner = document.getElementById('toast-inner');
    if (!el || !inner) return;
    inner.textContent = msg;
    inner.style.background = colors[type] || colors.info;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, 3200);
  }

  // 卡片渲染（与主页完全一致）
  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function dramaCard(d, idx, showDelete){
    var titleText = d.title || d.name;
    var epText = d.episodes ? '（' + d.episodes + '集）' : '';
    var displayTitle = titleText + epText;
    var dateBadge = d.date ? '<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium">'+escapeHtml(d.date)+'</span>' : '';
    var epBadge = d.episodes ? '<span class="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-xs font-medium">'+escapeHtml(d.episodes)+'集</span>' : '';
    var actorChips = (d.actors && d.actors.length)
      ? d.actors.slice(0,3).map(function(a){ return '<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 text-xs">'+escapeHtml(a)+'</span>'; }).join('') + (d.actors.length>3 ? '<span class="text-xs text-zinc-400">+'+(d.actors.length-3)+'</span>' : '')
      : '';
    var deleteBtn = showDelete ? '<button class="delete-btn delete-single" data-link="'+escapeHtml(d.link)+'">删除</button>' : '';
    return '<div class="fade-in bg-white rounded-xl border border-zinc-200 p-3.5 card-hover flex items-start gap-3">'+
      '<div class="w-7 h-7 rounded-lg bg-rose-50 text-rose-600 grid place-items-center text-xs font-bold shrink-0">'+(idx+1)+'</div>'+
      '<div class="flex-1 min-w-0">'+
        '<p class="font-medium text-sm sm:text-base text-zinc-800 break-all leading-snug">'+escapeHtml(displayTitle)+'</p>'+
        '<div class="flex items-center gap-1.5 mt-1.5 flex-wrap">'+dateBadge+epBadge+actorChips+'</div>'+
        '<div class="flex items-center gap-1 mt-1 flex-wrap"><span class="truncate text-xs text-zinc-400">'+escapeHtml(shortLink(d.link))+'</span></div>'+
      '</div>'+
      '<div class="flex flex-col gap-1.5 shrink-0">'+
        '<a href="'+escapeHtml(d.link)+'" target="_blank" rel="noopener" class="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 transition inline-flex items-center gap-1">前往<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17 17 7M7 7h10v10"/></svg></a>'+
        '<button class="copy-btn px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-500 text-xs hover:bg-zinc-50 transition" data-link="'+escapeHtml(d.link)+'">复制</button>'+
        deleteBtn+
      '</div>'+
    '</div>';
  }
  function shortLink(l){ try{ var u=new URL(l); return u.hostname + (u.pathname.length>20?u.pathname.slice(0,20)+'…':u.pathname); }catch(e){ return l; } }
  function emptyState(text){ return '<div class="text-center py-12 text-zinc-400"><svg class="w-12 h-12 mx-auto mb-3 text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><p class="text-sm">'+text+'</p></div>'; }
  function loadingSkeleton(n){ var h=''; for(var i=0;i<n;i++){ h+='<div class="skeleton rounded-xl h-16"></div>'; } return h; }
  function renderList(container, items, showDelete){
    if(!items.length){ container.innerHTML = emptyState('暂无数据'); return; }
    container.innerHTML = items.map(function(d,i){ return dramaCard(d,i, showDelete); }).join('');
  }

  // ─── 分页组件（与主页一致） ───
  function renderPagination(containerId, total, page, size, pages, onPageChange, onSizeChange) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (total === 0) { container.innerHTML = ''; return; }
    var html = '<div class="ant-pagination mini">';
    html += '<div class="ant-pagination-total-text">共 ' + total + ' 条</div>';

    var disabledPrev = page <= 1 ? ' ant-pagination-disabled' : '';
    html += '<div title="上一页" class="ant-pagination-prev' + disabledPrev + '" aria-disabled="' + (page<=1) + '">' +
      '<a class="ant-pagination-item-link"><i class="anticon anticon-left"><svg viewBox="64 64 896 896" data-icon="left" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 0 0 0 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"></path></svg></i></a></div>';

    var startPage = Math.max(1, page - 2);
    var endPage = Math.min(pages, page + 2);
    if (startPage > 1) {
      html += '<div title="1" class="ant-pagination-item ant-pagination-item-1" data-page="1"><a>1</a></div>';
      if (startPage > 2) {
        html += '<div class="ant-pagination-jump-prev"><a class="ant-pagination-item-link"><div class="ant-pagination-item-container"><i class="anticon anticon-double-left ant-pagination-item-link-icon"><svg viewBox="64 64 896 896" data-icon="double-left" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M272.9 512l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L186.8 492.3a31.99 31.99 0 0 0 0 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H532c6.7 0 10.4-7.7 6.3-12.9L272.9 512zm304 0l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L490.8 492.3a31.99 31.99 0 0 0 0 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H836c6.7 0 10.4-7.7 6.3-12.9L576.9 512z"></path></svg></i><span class="ant-pagination-item-ellipsis">•••</span></div></a></div>';
      }
    }
    for (var i = startPage; i <= endPage; i++) {
      var active = i === page ? ' ant-pagination-item-active' : '';
      html += '<div title="' + i + '" class="ant-pagination-item ant-pagination-item-' + i + active + '" data-page="' + i + '"><a>' + i + '</a></div>';
    }
    if (endPage < pages) {
      if (endPage < pages - 1) {
        html += '<div class="ant-pagination-jump-next"><a class="ant-pagination-item-link"><div class="ant-pagination-item-container"><i class="anticon anticon-double-right ant-pagination-item-link-icon"><svg viewBox="64 64 896 896" data-icon="double-right" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M533.2 492.3L277.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H188c-6.7 0-10.4 7.7-6.3 12.9L447.1 512 181.7 851.1A7.98 7.98 0 0 0 188 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5zm304 0L581.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H492c-6.7 0-10.4 7.7-6.3 12.9L751.1 512 485.7 851.1A7.98 7.98 0 0 0 492 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5z"></path></svg></i><span class="ant-pagination-item-ellipsis">•••</span></div></a></div>';
      }
      html += '<div title="' + pages + '" class="ant-pagination-item ant-pagination-item-' + pages + '" data-page="' + pages + '"><a>' + pages + '</a></div>';
    }

    var disabledNext = page >= pages ? ' ant-pagination-disabled' : '';
    html += '<div title="下一页" class="ant-pagination-next' + disabledNext + '" aria-disabled="' + (page>=pages) + '">' +
      '<a class="ant-pagination-item-link"><i class="anticon anticon-right"><svg viewBox="64 64 896 896" data-icon="right" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path d="M765.7 486.8L314.9 134.7A7.97 7.97 0 0 0 302 141v77.3c0 4.9 2.3 9.6 6.1 12.6l360 281.1-360 281.1c-3.9 3-6.1 7.7-6.1 12.6V883c0 6.7 7.7 10.4 12.9 6.3l450.8-352.1a31.96 31.96 0 0 0 0-50.4z"></path></svg></i></a></div>';

    html += '<div class="ant-pagination-options">' +
      '<div class="ant-pagination-options-size-changer"><select id="' + containerId + '-size-select">' +
        '<option value="10"' + (size===10?' selected':'') + '>10 条/页</option>' +
        '<option value="20"' + (size===20?' selected':'') + '>20 条/页</option>' +
        '<option value="50"' + (size===50?' selected':'') + '>50 条/页</option>' +
      '</select></div>' +
      '<div class="ant-pagination-options-quick-jumper">跳至<input id="' + containerId + '-jump-input" type="text" value="' + page + '">页</div>' +
    '</div>';

    html += '</div>';
    container.innerHTML = html;

    // 事件绑定
    var prev = container.querySelector('.ant-pagination-prev');
    if (prev && !prev.classList.contains('ant-pagination-disabled')) {
      prev.addEventListener('click', function(e){ e.preventDefault(); if (page > 1) onPageChange(page - 1); });
    }
    var next = container.querySelector('.ant-pagination-next');
    if (next && !next.classList.contains('ant-pagination-disabled')) {
      next.addEventListener('click', function(e){ e.preventDefault(); if (page < pages) onPageChange(page + 1); });
    }
    container.querySelectorAll('.ant-pagination-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        var p = parseInt(el.getAttribute('data-page'), 10);
        if (!isNaN(p) && p !== page) onPageChange(p);
      });
    });
    var select = document.getElementById(containerId + '-size-select');
    if (select) {
      select.addEventListener('change', function(e) {
        var newSize = parseInt(select.value, 10);
        if (!isNaN(newSize) && newSize !== size) onSizeChange(newSize);
      });
    }
    var jumpInput = document.getElementById(containerId + '-jump-input');
    if (jumpInput) {
      jumpInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          var val = parseInt(jumpInput.value, 10);
          if (!isNaN(val) && val >= 1 && val <= pages) onPageChange(val);
          else jumpInput.value = page;
        }
      });
      jumpInput.addEventListener('blur', function() {
        var val = parseInt(jumpInput.value, 10);
        if (!isNaN(val) && val >= 1 && val <= pages) onPageChange(val);
        else jumpInput.value = page;
      });
    }
  }

  // ─── 管理列表加载 ───
  var managePage = 1, manageSize = 10;
  var currentMode = 'all';
  var searchKeyword = '';

  function loadManage(page) {
    managePage = page;
    var list = document.getElementById('manage-list');
    var stats = document.getElementById('manage-stats');
    if (!list || !stats) return;
    list.innerHTML = loadingSkeleton(5);
    var url;
    if (currentMode === 'all') {
      url = '/api/list?page=' + page + '&size=' + manageSize;
    } else {
      url = '/s=' + encodeURIComponent(searchKeyword) + '?page=' + page + '&size=' + manageSize;
    }
    api(url).then(function(r) {
      stats.textContent = '共 ' + r.total + ' 条';
      renderList(list, r.data||[], true);
      list.querySelectorAll('.delete-single').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var link = btn.getAttribute('data-link');
          if (confirm('确定要删除该记录吗？')) {
            deleteSingle(link);
          }
        });
      });
      renderPagination('manage-pagination', r.total, page, manageSize, r.pages,
        function(newPage) { loadManage(newPage); },
        function(newSize) { manageSize = newSize; managePage = 1; loadManage(1); }
      );
    }).catch(function(e) {
      list.innerHTML = emptyState('加载失败');
      stats.textContent = '';
      document.getElementById('manage-pagination').innerHTML = '';
    });
  }

  // 删除单条
  async function deleteSingle(link) {
    try {
      var r = await apiWrite('/api/item?link=' + encodeURIComponent(link), { method: 'DELETE' });
      if (r.ok) {
        showToast('删除成功', 'success');
        loadManage(managePage);
      } else {
        showToast(r.error || '删除失败', 'error');
      }
    } catch(e) {
      showToast('删除失败：' + e.message, 'error');
    }
  }

  // 日期范围删除
  document.getElementById('delete-range-btn').addEventListener('click', function() {
    var start = document.getElementById('delete-start').value;
    var end = document.getElementById('delete-end').value;
    if (!start || !end) {
      showToast('请选择开始和结束日期', 'error');
      return;
    }
    if (start > end) {
      showToast('开始日期不能晚于结束日期', 'error');
      return;
    }
    if (!confirm('确定要删除 ' + start + ' 至 ' + end + ' 范围内的所有记录吗？此操作不可撤销！')) return;
    apiWrite('/api/range?start=' + start + '&end=' + end, { method: 'DELETE' }).then(function(r) {
      if (r.ok) {
        showToast('已删除 ' + r.deleted + ' 条记录', 'success');
        loadManage(managePage);
      } else {
        showToast(r.error || '删除失败', 'error');
      }
    }).catch(function(e) {
      showToast('删除失败：' + e.message, 'error');
    });
  });

  // 搜索删除
  var searchDeleteInput = document.getElementById('search-delete-input');
  var searchDeleteBtn = document.getElementById('search-delete-btn');
  var resetDeleteBtn = document.getElementById('reset-delete-list');

  searchDeleteBtn.addEventListener('click', function() {
    var keyword = searchDeleteInput.value.trim();
    if (!keyword) {
      showToast('请输入关键词', 'error');
      return;
    }
    searchKeyword = keyword;
    currentMode = 'search';
    resetDeleteBtn.classList.remove('hidden');
    managePage = 1;
    loadManage(1);
  });

  resetDeleteBtn.addEventListener('click', function() {
    currentMode = 'all';
    searchKeyword = '';
    resetDeleteBtn.classList.add('hidden');
    searchDeleteInput.value = '';
    managePage = 1;
    loadManage(1);
  });

  searchDeleteInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchDeleteBtn.click();
  });

  // ─── 上传功能 ───
  var dropZone = document.getElementById('drop-zone');
  var fileInput = document.getElementById('file-input');
  var parsedRecords = [];
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', function(){ fileInput.click(); });
    ['dragover','dragenter'].forEach(function(ev){ dropZone.addEventListener(ev, function(e){ e.preventDefault(); dropZone.classList.add('drag-over'); }); });
    ['dragleave','drop'].forEach(function(ev){ dropZone.addEventListener(ev, function(e){ e.preventDefault(); dropZone.classList.remove('drag-over'); }); });
    dropZone.addEventListener('drop', function(e){ if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', function(){ if(fileInput.files.length) handleFile(fileInput.files[0]); });
  }

  function excelSerialToDate(serial){
    var utcDays = serial - 25569;
    var d = new Date(utcDays * 86400000);
    if(isNaN(d.getTime())) return null;
    return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  }

  async function handleFile(file){
    var status = document.getElementById('parse-status');
    var preview = document.getElementById('parse-preview');
    if (!status || !preview) return;
    status.classList.remove('hidden');
    status.innerHTML = '<div class="flex items-center gap-2 text-sm text-zinc-600"><div class="w-4 h-4 border-2 border-rose-500 border-t-transparent rounded-full animate-spin"></div>正在解析「'+escapeHtml(file.name)+'」…</div>';
    preview.classList.add('hidden');
    try{
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type:'array', cellDates:true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      if(!ws || !ws['!ref']) throw new Error('空表格');
      var range = XLSX.utils.decode_range(ws['!ref']);
      var records = [];
      var colName=0, colLink=1, colDate=2;
      var hdr = {};
      for(var c=range.s.c; c<=range.e.c; c++){ var cell = ws[XLSX.utils.encode_cell({r:range.s.r,c:c})]; if(cell && cell.v) hdr[String(cell.v).trim()] = c; }
      ['短剧名称','名称','name','title'].forEach(function(k){ if(k in hdr) colName=hdr[k]; });
      ['网盘链接','链接','link','url','地址'].forEach(function(k){ if(k in hdr) colLink=hdr[k]; });
      ['更新日期','日期','date','time'].forEach(function(k){ if(k in hdr) colDate=hdr[k]; });

      for(var R=range.s.r+1; R<=range.e.r; R++){
        var a = ws[XLSX.utils.encode_cell({r:R,c:colName})];
        var b = ws[XLSX.utils.encode_cell({r:R,c:colLink})];
        var cc = ws[XLSX.utils.encode_cell({r:R,c:colDate})];
        var name = a ? String(a.v==null?'':a.v).trim() : '';
        var link = '';
        if(b){ link = (b.l && b.l.Target) ? b.l.Target : String(b.v==null?'':b.v).trim(); }
        var date = null;
        if(cc){
          if(cc.v instanceof Date) date = cc.v.toISOString().slice(0,10);
          else if(typeof cc.v==='number') date = excelSerialToDate(cc.v);
          else if(typeof cc.v==='string'){ var m=cc.v.match(/(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})/); if(m) date=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'); }
        }
        if(name && /^https?:\\/\\//i.test(link)) records.push({ name:name, link:link, date:date });
      }
      parsedRecords = records;
      status.classList.add('hidden');
      if(!records.length){ preview.classList.add('hidden'); showToast('未解析到有效记录（需含名称与 http 链接）','error'); return; }
      document.getElementById('preview-count').textContent = '共解析 '+records.length+' 条';
      document.getElementById('preview-list').innerHTML = records.slice(0,10).map(function(d,i){
        return '<div class="flex items-center gap-2 text-xs"><span class="text-zinc-400 w-6">'+(i+1)+'</span><span class="flex-1 truncate text-zinc-700">'+escapeHtml(d.name)+'</span>'+(d.date?'<span class="text-zinc-400">'+d.date+'</span>':'')+'</div>';
      }).join('');
      document.getElementById('confirm-count').textContent = '('+records.length+' 条)';
      preview.classList.remove('hidden');
      showToast('解析成功：'+records.length+' 条','success');
    }catch(e){
      status.innerHTML = '<div class="text-sm text-red-600">解析失败：'+escapeHtml(e.message)+'</div>';
    }
  }

  var confirmUpload = document.getElementById('confirm-upload');
  var cancelUpload = document.getElementById('cancel-upload');
  if (confirmUpload) {
    confirmUpload.addEventListener('click', async function(){
      if(!parsedRecords.length) return;
      var btn = confirmUpload;
      btn.disabled = true; btn.textContent = '导入中…';
      try{
        var r = await apiWrite('/api/upload', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ source:'web-upload', records: parsedRecords })
        });
        if(r.ok){
          showToast(r.message || ('导入成功：'+r.count+' 条'), 'success');
          showUploadSummary(r);
          document.getElementById('parse-preview').classList.add('hidden');
          loadManage(managePage);
        } else { showToast(r.error || '导入失败','error'); }
      } catch(e){ showToast('导入失败：'+e.message,'error'); }
      btn.disabled = false; btn.textContent = '确认导入';
    });
  }
  if (cancelUpload) {
    cancelUpload.addEventListener('click', function(){
      document.getElementById('parse-preview').classList.add('hidden');
      parsedRecords = [];
      fileInput.value = '';
    });
  }

  function showUploadSummary(r){
    var box = document.getElementById('parse-status');
    if (!box) return;
    box.classList.remove('hidden');
    var c = r.categories || {};
    var modeLabel = r.mode === 'replace' ? '替换导入' : '合并导入';
    var rows = [
      ['模式', modeLabel],
      ['解析有效', r.count + ' 条' + (r.dropped ? '（忽略 '+r.dropped+' 条无效）' : '')],
    ];
    if(r.mode !== 'replace'){
      rows.push(['原数据', (r.totalBefore||0) + ' 条']);
      rows.push(['新增', '<span class="text-emerald-600 font-semibold">'+(r.added||0)+' 条</span>']);
      rows.push(['去重更新', '<span class="text-amber-600 font-semibold">'+(r.updated||0)+' 条</span>']);
      rows.push(['合计', '<span class="text-rose-600 font-bold">'+(r.totalAfter||0)+' 条</span>']);
    } else {
      rows.push(['合计', '<span class="text-rose-600 font-bold">'+(r.totalAfter||0)+' 条</span>']);
    }
    if(c.withEpisodes || c.withActors){
      rows.push(['自动归类', '集数 '+(c.withEpisodes||0)+' · 演员 '+(c.withActors||0)+' · '+(c.distinctActors||0)+' 位演员']);
    }
    var html = '<div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">'+
      '<div class="flex items-center gap-2 mb-2"><svg class="w-5 h-5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span class="font-semibold text-sm text-emerald-800">'+escapeHtml(r.message||'导入完成')+'</span></div>'+
      '<div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">'+
      rows.map(function(rv){ return '<span class="text-zinc-500">'+rv[0]+'</span><span class="text-zinc-700 font-medium">'+rv[1]+'</span>'; }).join('') +
      '</div>';
    if(c.topActors && c.topActors.length){
      html += '<div class="mt-2.5 pt-2.5 border-t border-emerald-200"><span class="text-xs text-zinc-500">出场最多的演员：</span>'+
        c.topActors.slice(0,6).map(function(a){ return '<span class="inline-block ml-1 mt-1 px-1.5 py-0.5 rounded bg-white text-rose-600 text-xs">'+escapeHtml(a.name)+' <b>'+a.count+'</b></span>'; }).join('') +
        '</div>';
    }
    html += '</div>';
    box.innerHTML = html;
  }

  // 清空全部
  document.getElementById('clear-data').addEventListener('click', async function(){
    if(!confirm('确定清空全部短剧数据？此操作不可撤销。')) return;
    try{
      var r = await apiWrite('/api/data', { method:'DELETE' });
      if(r.ok){ showToast('数据已清空','success'); loadManage(1); } else { showToast(r.error||'失败','error'); }
    } catch(e){ showToast('清空失败：'+e.message,'error'); }
  });

  // 复制链接
  document.body.addEventListener('click', function(e){
    var btn = e.target.closest('.copy-btn');
    if(!btn) return;
    var link = btn.getAttribute('data-link');
    navigator.clipboard.writeText(link).then(function(){ showToast('链接已复制','success'); btn.textContent='已复制'; setTimeout(function(){btn.textContent='复制';},1500); });
  });

  // 初始化
  loadManage(1);
})();
`;

// ─── Worker 入口 ───
const PROTECTED_PATHS = new Set(['/api/upload', '/api/data', '/api/range', '/api/item']);

const worker = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const path = url.pathname;
    const isProtected = PROTECTED_PATHS.has(path);

    const extraHeaders = {};
    if (url.searchParams.get('token')) {
      extraHeaders['Set-Cookie'] = setCookieHeader(url.searchParams.get('token'), request);
    }

    if (isProtected) {
      if (!env.TOKEN) {
        return fail('服务端未配置 TOKEN 环境变量', 500);
      }
      if (!checkToken(request, env)) {
        return fail('未授权', 401);
      }
    }

    // 首页
    if ((path === '/' || path === '/index.html') && method === 'GET') {
      const meta = await getMeta(env);
      const html = renderHomeHTML(meta);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
      });
    }

    // 管理页面（需要 token）
    if (path === '/admin' && method === 'GET') {
      if (!env.TOKEN) {
        return fail('服务端未配置 TOKEN 环境变量', 500);
      }
      if (!checkToken(request, env)) {
        return fail('请携带有效的 token 访问管理后台', 401);
      }
      const html = renderAdminHTML();
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
      });
    }

    // 搜索接口
    if ((path === '/s' || path.startsWith('/s=') || path.startsWith('/s/')) && method === 'GET') {
      const res = await handleSearch(request, env);
      return withHeaders(res, extraHeaders);
    }

    // API 路由
    if (path.startsWith('/api/')) {
      let res;
      if (path === '/api/recent' && method === 'GET') res = await handleRecent(request, env);
      else if (path === '/api/list' && method === 'GET') res = await handleList(request, env);
      else if (path === '/api/upload' && method === 'POST') res = await handleUpload(request, env);
      else if (path === '/api/data' && method === 'DELETE') res = await handleClear(request, env);
      else if (path === '/api/range' && method === 'DELETE') res = await handleDeleteByDateRange(request, env);
      else if (path === '/api/item' && method === 'DELETE') res = await handleDeleteByLink(request, env);
      else {
        res = fail('接口不存在：' + path, 404);
      }
      return withHeaders(res, extraHeaders);
    }

    // 健康检查
    if (path === '/health') {
      return Response.json({ ok: true, time: beijingDisplay(), service: 'duanju-api' });
    }

    return fail('路径不存在：' + path, 404);
  }
};

function withHeaders(res, extra) {
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default worker;
