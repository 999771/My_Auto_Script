/**
 * Cloudflare Worker —— 多源节点数据聚合 (/ip.txt)
 *
 * 环境变量（在 Cloudflare Dashboard -> Workers -> 设置 -> 变量 中添加）：
 *   TOKEN        必填，访问令牌。请求时必须携带，否则返回 403。
 *   SOURCE_URLS  必填，数据源链接。支持两种写法：
 *                1) JSON 数组： ["https://bestcf.pages.dev/s5gy/jp.txt","https://bestcf.pages.dev/vvhan/ipv6.txt"]
 *                2) 逗号/换行分隔： https://a.txt,https://b.txt
 *
 * 访问方式：
 *   https://<你的域名>/ip.txt?token=<TOKEN>
 *   或使用请求头  X-Token: <TOKEN>
 *
 * 缓存策略：
 *   结果缓存在 Cloudflare Edge Cache，TTL = 2 小时。
 *   2 小时内的请求直接命中缓存，过期后下一次请求会重新抓取全部源并全量覆盖（不保留旧数据）。
 */

const CACHE_TTL_SECONDS = 7200; // 2 小时，可修改
const CACHE_KEY_URL = 'https://cache.internal/ip.txt'; // 仅作缓存 key，不是真实请求

// 注释段中需要跳过的“无意义”字段
const LABEL_SKIP_RE =
  /^(default|none|null|n\/a|na|-|tcp|udp|ws|wss|grpc|http|https|h2|h3|tls|tcp\+tls)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------- 1. 鉴权 ----------------
    const expected = String(env.TOKEN || env.ACCESS_TOKEN || '').trim();
    if (!expected) {
      return text('500 Server Error: 未配置 TOKEN 环境变量', 500);
    }

    const provided = String(
      url.searchParams.get('token') || request.headers.get('X-Token') || ''
    ).trim();

    if (!safeEqual(provided, expected)) {
      return text('403 Forbidden: token 不正确', 403);
    }

    // ---------------- 2. 路由 ----------------
    if (url.pathname !== '/ip.txt') {
      return text('404 Not Found', 404);
    }

    // ---------------- 3. 读缓存 ----------------
    const cache = caches.default;
    const cacheKey = new Request(CACHE_KEY_URL, { method: 'GET' });

    const hit = await cache.match(cacheKey);
    if (hit) {
      return text(await hit.text(), 200);
    }

    // ---------------- 4. 抓取 + 整理 ----------------
    let body;
    try {
      body = await buildPayload(env);
    } catch (err) {
      return text('500 Server Error: ' + (err && err.message ? err.message : err), 500);
    }

    // 写入缓存（带 2 小时 TTL）
    const forCache = new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, forCache));

    // 返回给客户端：禁止客户端侧缓存，避免 token 被本地缓存
    return text(body, 200);
  },
};

/* =========================================================
 *  数据生成
 * ========================================================= */

async function buildPayload(env) {
  const urls = parseSourceUrls(env);
  if (urls.length === 0) return '';

  // 并发抓取所有源，单个源失败不影响整体
  const results = await Promise.allSettled(urls.map((u) => fetchAndParse(u)));

  const seen = new Set();
  const out = [];

  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const line of r.value) {
      // 以 "ip:port"（# 之前的部分）去重
      const key = line.slice(0, line.indexOf('#'));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }

  return out.length ? out.join('\n') + '\n' : '';
}

async function fetchAndParse(srcUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(srcUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; CF-Worker-NodeCollector/1.0; +https://workers.cloudflare.com/)',
        Accept: 'text/plain,*/*',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!res.ok) {
      throw new Error(`fetch ${srcUrl} -> HTTP ${res.status}`);
    }

    const text = await res.text();
    return text
      .split(/\r?\n/)
      .map(processLine)
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单行处理：
 *   输入  172.104.120.92:443#S5公益优选 | 小日本儿 | JP | 172.104.120.92:443
 *   输出  172.104.120.92:443#JP
 *
 *   输入  [2606:4700:8dee:...:ab3c]:443#vvHan优选 | 移动 | Default | 2606:4700:...:ab3c
 *   输出  [2606:4700:8dee:...:ab3c]:443#移动
 *
 * 规则：
 *   1) 丢弃包含 BestCF.pages.dev 的行（不区分大小写）
 *   2) 保留 "地址:端口" 原样，只重写 # 后面的备注
 *   3) 备注按 "|" 分段，从后往前取第一个“有效字段”：
 *      - 跳过 Default / None / 协议名之类的占位字段
 *      - 跳过与地址本身重复的字段（如末尾再写一遍 ip:port）
 */
function processLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;

  // 1) 过滤 BestCF.pages.dev
  if (/bestcf\.pages\.dev/i.test(line)) return null;

  // 2) 拆分 地址 与 备注
  const hashIdx = line.indexOf('#');
  if (hashIdx === -1) return null;

  const addr = line.slice(0, hashIdx).trim();
  const comment = line.slice(hashIdx + 1);

  const parsed = splitAddr(addr);
  if (!parsed) return null;

  const { host, port } = parsed;
  if (!host || !/^\d+$/.test(port)) return null;

  // 3) 提取备注
  const label = extractLabel(comment, addr, host);
  if (!label) return null;

  return `${addr}#${label}`;
}

/** 拆出 host / port，兼容 [IPv6]:port 与 IPv4:port */
function splitAddr(addr) {
  const v6 = addr.match(/^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/);
  if (v6) return { host: v6[1], port: v6[2] };

  const idx = addr.lastIndexOf(':');
  if (idx <= 0) return null;

  return { host: addr.slice(0, idx), port: addr.slice(idx + 1) };
}

/** 从备注中挑选出真正有意义的标签（从后往前找） */
function extractLabel(comment, addr, host) {
  const parts = comment
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];

    if (LABEL_SKIP_RE.test(p)) continue; // Default / None / 协议名
    if (p === addr) continue;            // 与地址完全相同
    if (p.includes(host)) continue;      // 地址重复出现（含 IPv6 无括号形式）

    return p;
  }

  return null;
}

/* =========================================================
 *  工具函数
 * ========================================================= */

/** 解析 SOURCE_URLS 环境变量 */
function parseSourceUrls(env) {
  const raw = String(
    env.SOURCE_URLS || env.URLS || env.URL || ''
  ).trim();

  if (!raw) return [];

  // 优先按 JSON 数组解析
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .map((s) => String(s).trim())
          .filter((s) => /^https?:\/\//i.test(s));
      }
    } catch {
      /* 解析失败则按分隔符处理 */
    }
  }

  return raw
    .split(/[\n,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

/** 定长比较，降低时序侧信道风险 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 统一响应，禁止客户端缓存 */
function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
