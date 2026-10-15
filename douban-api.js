/**
 * Open Image & Data Proxy for Cloudflare Workers (TOKEN-protected)
 *
 * Referenced from MoonTVPlus — https://github.com/mtvpls/MoonTVPlus
 *
 * Routes
 *   /dbjpg  -> Image proxy (ANY host)
 *   /dbapi  -> Data  proxy (ANY host, returns JSON/text/etc.)
 *
 * Auth
 *   A TOKEN must be set as an environment variable in the Cloudflare Workers
 *   settings (Dashboard -> Settings -> Variables -> Add, recommend "Encrypt").
 *   Every request must carry it via one of:
 *     - Header:  Authorization: Bearer <TOKEN>
 *     - Header:  X-Proxy-Token: <TOKEN>
 *     - Query:   ?token=<TOKEN>      (handy for <img>/<video>/fetch-without-headers)
 *   Without a valid token the worker returns 401. If TOKEN is unset it returns
 *   503 (fail-closed, never an open proxy).
 *
 * Usage
 *   Image (path-suffix, recommended, no encoding needed):
 *     https://<worker>/dbjpg/img3.doubanio.com/view/photo/photo/public/p123.jpg?token=XXX
 *   Image (query form):
 *     https://<worker>/dbjpg?url=https%3A%2F%2Fimg3.doubanio.com%2F...%2Fp123.jpg&token=XXX
 *
 *   Data (path-suffix, query string preserved):
 *     https://<worker>/dbapi/movie.douban.com/j/search_subjects?type=movie&tag=热门&page_limit=20&page_start=0&token=XXX
 *     https://<worker>/dbapi/m.douban.com/rexxar/api/v2/subject/1292052?token=XXX
 *   Data (query form):
 *     https://<worker>/dbapi?url=https%3A%2F%2Fm.douban.com%2Frexxar%2Fapi%2Fv2%2Fsubject%2F1292052&token=XXX
 *
 * Special-casing
 *   Douban hosts still get the MoonTVPlus headers (Referer/Origin -> movie.douban.com)
 *   to satisfy hotlink / API origin checks. Non-Douban hosts get a neutral UA
 *   + generic Accept header.
 *
 * Deploy
 *   Wrangler:
 *     1. npm i -g wrangler
 *     2. cd cloudflare-workers/douban-proxy
 *     3. wrangler login
 *     4. wrangler deploy
 *     5. wrangler secret put TOKEN   (recommended: store as an encrypted secret)
 *        — or set TOKEN in Dashboard -> Settings -> Variables (Encrypt = ON)
 *   Dashboard: paste this file into the editor, Deploy, then add TOKEN variable.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// Long browser-style cache for images; short cache for JSON data
const IMG_CACHE = 'public, max-age=15720000, immutable'; // ~6 months
const DATA_CACHE = 'public, max-age=60';

// Hosts that need Douban-specific headers to pass hotlink / origin checks
const DOUBAN_IMAGE_HOST_RE = /^img\d+\.doubanio\.com$/; // img1/img2/img3/img9 ...
const DOUBAN_DATA_HOST_RE = /(^|\.)douban(?:io)?\.com$/; // *.douban.com / *.doubanio.com

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- Auth gate (fail-closed) -------------------------------------
    const authErr = checkAuth(request, url, env);
    if (authErr) return authErr;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed' }, 405);
    }

    try {
      const p = url.pathname;
      if (p === '/dbjpg' || p.startsWith('/dbjpg/')) {
        return await proxyImage(request, url);
      }
      if (p === '/dbapi' || p.startsWith('/dbapi/')) {
        return await proxyData(request, url);
      }
      if (p === '/' || p === '') {
        return json({
          service: 'open-proxy',
          auth: 'required',
          routes: {
            '/dbjpg/<host>/<path>': 'Image proxy (any host)',
            '/dbjpg?url=<full url>': 'Image proxy (query form)',
            '/dbapi/<host>/<path>?<query>': 'Data proxy (any host)',
            '/dbapi?url=<full url>': 'Data proxy (query form)',
          },
          authMethods: [
            'Authorization: Bearer <TOKEN>',
            'X-Proxy-Token: <TOKEN>',
            '?token=<TOKEN>',
          ],
        });
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Proxy error', message: String((err && err.message) || err) }, 502);
    }
  },
};

/* ----------------------------- helpers ----------------------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkAuth(request, url, env) {
  const expected = (env && env.TOKEN && String(env.TOKEN)) || '';
  if (!expected) {
    return json(
      {
        error: 'TOKEN not configured',
        message:
          'Set the TOKEN environment variable in Cloudflare Workers settings (Dashboard -> Settings -> Variables, Encrypt = ON; or `wrangler secret put TOKEN`).',
      },
      503,
    );
  }

  let provided = null;
  // 1) Authorization: Bearer <token>
  const authz = request.headers.get('Authorization') || '';
  if (authz.toLowerCase().startsWith('bearer ')) {
    provided = authz.slice(7).trim();
  }
  // 2) X-Proxy-Token header
  if (!provided) {
    const h = (request.headers.get('X-Proxy-Token') || '').trim();
    if (h) provided = h;
  }
  // 3) ?token=<token>  (needed for <img>/<video>/<audio> tags)
  if (!provided) {
    const t = url.searchParams.get('token');
    if (t) provided = t;
  }

  if (!provided) {
    return json(
      {
        error: 'Unauthorized: missing token',
        hint: 'Send `Authorization: Bearer <TOKEN>` header, `X-Proxy-Token` header, or `?token=<TOKEN>` query param.',
      },
      401,
    );
  }
  if (!constantTimeEq(provided, expected)) {
    return json({ error: 'Unauthorized: invalid token' }, 401);
  }
  return null;
}

/**
 * Resolve the upstream target URL for a /<routePrefix>/... path.
 * Supports two forms:
 *   1. ?url=<full url>             — query form (URL may be encoded)
 *   2. /<routePrefix>/<host>/<path>?<query>  — path-suffix form (no encoding needed)
 *
 * The `token` query param is ALWAYS stripped before forwarding to upstream
 * (it's our auth, not theirs).
 */
function resolveTarget(routePrefix, url) {
  const qUrl = url.searchParams.get('url');
  if (qUrl) {
    // Be friendly: accept host/path without a scheme too.
    return /^https?:\/\//i.test(qUrl) ? qUrl : `https://${qUrl}`;
  }
  // drop the leading "/<routePrefix>/" (routePrefix has no slash itself)
  const rest = url.pathname.slice(routePrefix.length + 2);
  if (!rest) return null;

  // Rebuild query string without the `token` param
  const params = new URLSearchParams(url.searchParams);
  params.delete('token');
  const qs = params.toString();
  return qs ? `https://${rest}?${qs}` : `https://${rest}`;
}

function safeParse(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/* --------------------------- image proxy --------------------------- */

async function proxyImage(request, url) {
  const target = resolveTarget('dbjpg', url);
  if (!target) {
    return json({ error: 'Missing target. Use /dbjpg/<host>/<path> or ?url=<full url>' }, 400);
  }
  const targetUrl = safeParse(target);
  if (!targetUrl || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
    return json({ error: 'Invalid target URL', target }, 400);
  }

  const headers = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
  // Douban images need the movie.douban.com Referer to bypass hotlink protection
  if (DOUBAN_IMAGE_HOST_RE.test(targetUrl.hostname)) {
    headers['Referer'] = 'https://movie.douban.com/';
  }
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const resp = await fetch(targetUrl.toString(), {
    method: request.method,
    headers,
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!resp.ok && resp.status !== 206) {
    return json(
      { error: 'Upstream image fetch failed', status: resp.status, url: targetUrl.toString() },
      502,
    );
  }

  const respHeaders = new Headers({
    'Content-Type': resp.headers.get('Content-Type') || 'image/jpeg',
    'Cache-Control': IMG_CACHE,
    ...CORS_HEADERS,
  });
  const len = resp.headers.get('Content-Length');
  if (len) respHeaders.set('Content-Length', len);
  const cr = resp.headers.get('Content-Range');
  if (cr) respHeaders.set('Content-Range', cr);

  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}

/* ---------------------------- data proxy --------------------------- */

async function proxyData(request, url) {
  const target = resolveTarget('dbapi', url);
  if (!target) {
    return json({ error: 'Missing target. Use /dbapi/<host>/<path> or ?url=<full url>' }, 400);
  }
  const targetUrl = safeParse(target);
  if (!targetUrl || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
    return json({ error: 'Invalid target URL', target }, 400);
  }

  // Douban data endpoints need Referer/Origin = movie.douban.com (no apikey).
  // Other hosts get a neutral JSON-style fetch.
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (DOUBAN_DATA_HOST_RE.test(targetUrl.hostname)) {
    headers['Referer'] = 'https://movie.douban.com/';
    headers['Origin'] = 'https://movie.douban.com';
  }

  const resp = await fetch(targetUrl.toString(), {
    method: request.method,
    headers,
    cf: { cacheTtl: 30, cacheEverything: true },
  });

  const respHeaders = new Headers({
    'Content-Type': resp.headers.get('Content-Type') || 'application/json; charset=utf-8',
    'Cache-Control': DATA_CACHE,
    ...CORS_HEADERS,
  });
  const len = resp.headers.get('Content-Length');
  if (len) respHeaders.set('Content-Length', len);

  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}
