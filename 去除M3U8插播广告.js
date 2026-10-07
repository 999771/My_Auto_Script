// ============================================================
// M3U8 Ad Remover — Cloudflare Workers (已编译，可直接粘贴到 Dashboard)
// 传入 m3u8 链接，自动解析并删除插播广告片段
// ============================================================

// ========== URL 工具 ==========
function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return relative; }
}
function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(url);
}

// ========== M3U8 解析器 ==========
function parseMediaPlaylist(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trimEnd());
  const segments = [];
  const headerLines = [];
  const footerLines = [];
  let currentTags = [], currentDuration = 0, hasDiscontinuity = false, hasCueOut = false;
  let segIndex = 0, inFooter = false, targetDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1]) || 0;
      headerLines.push(line); continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { headerLines.push(line); continue; }
    if (line === '#EXT-X-DISCONTINUITY') { hasDiscontinuity = true; currentTags.push(line); continue; }
    if (line.startsWith('#EXT-X-CUE-OUT') || line.startsWith('#EXT-X-CUE-OUT-CONT')) {
      hasCueOut = true; currentTags.push(line); continue;
    }
    if (line === '#EXT-X-CUE-IN') { hasCueOut = false; currentTags.push(line); continue; }
    if (line.startsWith('#EXT-X-DATERANGE') && (line.includes('SCTE35') || line.includes('CUE'))) continue;
    if (line === '#EXT-X-ENDLIST') { footerLines.push(line); inFooter = true; continue; }
    if (line.startsWith('#EXTINF')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      currentDuration = match ? parseFloat(match[1]) : 0;
      currentTags.push(line); continue;
    }
    if (line.startsWith('#')) {
      if (inFooter) footerLines.push(line); else currentTags.push(line); continue;
    }
    if (line && !line.startsWith('#')) {
      const fullUrl = isAbsoluteUrl(line) ? line : resolveUrl(baseUrl, line);
      segments.push({
        index: segIndex++, duration: currentDuration, url: fullUrl, domain: getDomain(fullUrl),
        tags: [...currentTags], discontinuity: hasDiscontinuity, cueOut: hasCueOut, isAd: false,
      });
      currentTags = []; currentDuration = 0; hasDiscontinuity = false; hasCueOut = false; continue;
    }
    if (!inFooter && segments.length === 0) headerLines.push(line);
  }
  return { segments, headerLines, footerLines, targetDuration };
}

// ========== 广告检测引擎（5层策略） ==========
function detectAds(segments, targetDuration) {
  if (!segments.length) return;
  const domainCount = new Map();
  for (const s of segments) domainCount.set(s.domain, (domainCount.get(s.domain) || 0) + s.duration);
  let mainDomain = '', mainDur = 0;
  for (const [d, dur] of domainCount) { if (dur > mainDur) { mainDur = dur; mainDomain = d; } }

  let insideAd = false, adDom = '';
  for (const seg of segments) {
    if (seg.cueOut) { insideAd = true; seg.isAd = true; continue; }
    if (!seg.cueOut && insideAd) {
      if (seg.tags.some(t => t === '#EXT-X-CUE-IN')) insideAd = false;
      else { seg.isAd = true; continue; }
    }
    if (seg.discontinuity && seg.domain !== mainDomain && mainDomain) {
      seg.isAd = true; insideAd = true; adDom = seg.domain; continue;
    }
    if (insideAd && seg.domain === adDom) { seg.isAd = true; continue; }
    if (insideAd && seg.domain === mainDomain) { insideAd = false; adDom = ''; continue; }
    if (targetDuration > 0 && seg.domain !== mainDomain && mainDomain && seg.duration < targetDuration * 0.3 && seg.duration > 0) {
      seg.isAd = true; continue;
    }
    if (seg.domain !== mainDomain && mainDomain) {
      const prev = segments[seg.index - 1], next = segments[seg.index + 1];
      if ((prev && prev.domain === mainDomain && !prev.isAd) || (next && next.domain === mainDomain && !next.isAd)) {
        seg.isAd = true;
      }
    }
  }
  if (mainDomain && targetDuration > 0) {
    let cs = -1, cd = '', cDur = 0;
    const markCluster = (start, end, dom) => {
      if (dom !== mainDomain && cDur >= 5 && cDur <= 120)
        for (let j = start; j < end; j++) if (segments[j].domain === dom) segments[j].isAd = true;
    };
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]; if (s.isAd) continue;
      if (s.domain !== mainDomain) {
        if (cd === s.domain) { cDur += s.duration; }
        else { markCluster(cs, i, cd); cs = i; cd = s.domain; cDur = s.duration; }
      } else { markCluster(cs, i, cd); cs = -1; cd = ''; cDur = 0; }
    }
    markCluster(cs, segments.length, cd);
  }
}

// ========== 重建播放列表 ==========
function rebuildPlaylist(segments, headerLines, footerLines, baseUrl, proxyBase) {
  const lines = [...headerLines];
  let prevAd = false;
  for (const seg of segments) {
    if (seg.isAd) { prevAd = true; continue; }
    const tags = seg.tags.filter(t => {
      if (t === '#EXT-X-DISCONTINUITY' && prevAd) return false;
      if (t.startsWith('#EXT-X-CUE')) return false;
      return true;
    });
    for (const t of tags) lines.push(t);
    let segUrl = seg.url;
    if (proxyBase) {
      segUrl = proxyBase + '/segment?url=' + encodeURIComponent(seg.url);
    } else {
      try {
        const base = new URL(baseUrl), sp = new URL(seg.url);
        if (sp.origin === base.origin) segUrl = sp.pathname + sp.search;
      } catch {}
    }
    lines.push(segUrl);
    prevAd = false;
  }
  lines.push(...footerLines);
  return lines.join('\n');
}

// ========== 清理主函数 ==========
function cleanM3U8(content, url, proxyBase) {
  const trimmed = content.trim();
  if (trimmed.includes('#EXT-X-STREAM-INF')) {
    const lines = trimmed.split('\n').map(l => l.trimEnd());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        out.push(lines[i]);
        const next = (lines[i + 1] || '').trim();
        if (next && !next.startsWith('#')) {
          const vu = isAbsoluteUrl(next) ? next : resolveUrl(url, next);
          out.push(proxyBase + '/clean?url=' + encodeURIComponent(vu));
          i++;
        }
      } else out.push(lines[i]);
    }
    return { content: out.join('\n'), stats: null, type: 'master' };
  }
  const { segments, headerLines, footerLines, targetDuration } = parseMediaPlaylist(trimmed, url);
  detectAds(segments, targetDuration);
  const ads = segments.filter(s => s.isAd);
  const origDur = segments.reduce((a, s) => a + s.duration, 0);
  return {
    content: rebuildPlaylist(segments, headerLines, footerLines, url, proxyBase),
    stats: {
      totalSegments: segments.length, removedSegments: ads.length,
      removedDuration: Math.round(ads.reduce((a, s) => a + s.duration, 0) * 100) / 100,
      adDomains: [...new Set(ads.map(s => s.domain))],
      originalDuration: Math.round(origDur * 100) / 100,
      cleanedDuration: Math.round((origDur - ads.reduce((a, s) => a + s.duration, 0)) * 100) / 100,
    },
    type: 'media',
  };
}

// ========== CORS ==========
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() } });
}

// ========== 路由处理 ==========
async function handleClean(request, url) {
  const m3u8Url = url.searchParams.get('url');
  if (!m3u8Url) return json({ error: 'Missing required parameter: url' }, 400);
  if (!isAbsoluteUrl(m3u8Url)) return json({ error: 'Invalid URL format' }, 400);
  if (!m3u8Url.includes('.m3u8')) return json({ error: 'URL does not appear to be an m3u8 playlist' }, 400);
  const proxyBase = url.protocol + '//' + url.host;
  const res = await fetch(m3u8Url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', 'Referer': m3u8Url } });
  if (!res.ok) return json({ error: 'Failed to fetch m3u8: ' + res.status }, 502);
  const content = await res.text();
  const result = cleanM3U8(content, m3u8Url, proxyBase);
  const accept = request.headers.get('Accept') || '';
  if (accept.includes('application/json')) {
    return json({ type: result.type, clean_url: proxyBase + '/clean?url=' + encodeURIComponent(m3u8Url), stats: result.stats, m3u8_content: result.content });
  }
  return new Response(result.content, {
    status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...corsHeaders(), 'Cache-Control': 'public, max-age=60', 'X-Ad-Removed': String(result.stats?.removedSegments || 0) }
  });
}

async function handleSegment(url) {
  const segUrl = url.searchParams.get('url');
  if (!segUrl) return json({ error: 'Missing required parameter: url' }, 400);
  if (!isAbsoluteUrl(segUrl)) return json({ error: 'Invalid URL format' }, 400);
  const res = await fetch(segUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', 'Referer': segUrl } });
  if (!res.ok) return new Response(null, { status: res.status });
  return new Response(res.body, { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'video/mp2t', ...corsHeaders(), 'Cache-Control': 'public, max-age=86400' } });
}

async function handleParse(url) {
  const m3u8Url = url.searchParams.get('url');
  if (!m3u8Url) return json({ error: 'Missing required parameter: url' }, 400);
  if (!isAbsoluteUrl(m3u8Url)) return json({ error: 'Invalid URL format' }, 400);
  const proxyBase = url.protocol + '//' + url.host;
  const res = await fetch(m3u8Url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', 'Referer': m3u8Url } });
  if (!res.ok) return json({ error: 'Failed to fetch m3u8: ' + res.status }, 502);
  const content = await res.text();
  const result = cleanM3U8(content, m3u8Url, proxyBase);
  return json({ input_url: m3u8Url, clean_url: proxyBase + '/clean?url=' + encodeURIComponent(m3u8Url), type: result.type, stats: result.stats, m3u8_preview: result.content.substring(0, 2000) });
}

function handleIndex(url) {
  const proxyBase = url.protocol + '//' + url.host;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>M3U8 Ad Remover</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}h1{font-size:1.8rem;margin-bottom:.5rem;background:linear-gradient(135deg,#f97316,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.subtitle{color:#737373;margin-bottom:2rem;font-size:.9rem}.api-card{background:#171717;border:1px solid #262626;border-radius:12px;padding:1.5rem;width:100%;max-width:640px;margin-bottom:1rem}.api-card h3{color:#f97316;font-size:1rem;margin-bottom:.75rem}.api-card code{background:#262626;padding:.5rem .75rem;border-radius:6px;display:block;font-size:.8rem;word-break:break-all;color:#a3e635;margin-bottom:.5rem;font-family:'SF Mono',Monaco,monospace}.api-card p{color:#a3a3a3;font-size:.85rem;line-height:1.6}.method{display:inline-block;background:#f97316;color:#000;font-weight:700;padding:2px 8px;border-radius:4px;font-size:.75rem;margin-right:.5rem}</style></head><body><h1>M3U8 广告移除服务</h1><p class="subtitle">Cloudflare Workers 驱动 · 自动解析 m3u8 · 智能移除插播广告</p><div class="api-card"><h3><span class="method">GET</span>/clean?url=&lt;m3u8&gt;</h3><p>核心接口：返回清理广告后的播放列表，可直接用于播放器。</p><code>${proxyBase}/clean?url=https://example.com/video/index.m3u8</code></div><div class="api-card"><h3><span class="method">GET</span>/api/parse?url=&lt;m3u8&gt;</h3><p>解析接口：返回 JSON 格式的广告统计和清理后预览。</p><code>${proxyBase}/api/parse?url=https://example.com/video/index.m3u8</code></div><div class="api-card"><h3><span class="method">GET</span>/segment?url=&lt;ts&gt;</h3><p>段代理：转发 TS 视频段，绕过 CDN Referrer 校验。</p><code>${proxyBase}/segment?url=https://cdn.example.com/seg001.ts</code></div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() } });
}

// ========== Worker 入口 ==========
const worker = {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    try {
      if (path === '/clean') return await handleClean(request, url);
      if (path === '/segment') return await handleSegment(url);
      if (path === '/api/parse') return await handleParse(url);
      if (path === '/') return handleIndex(url);
      return json({ error: 'Not Found', routes: ['/', '/clean', '/api/parse', '/segment'] }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal Server Error' }, 500);
    }
  },
};

export default worker;
