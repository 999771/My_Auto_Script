// 部署在cloudflare workers 
export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/url=(.+)$/);
    if (!match) {
      return new Response("Usage: /url=example.com", { status: 400 });
    }

    // 解析目标 URL（保留完整路径用于解析相对路径和抓取标题）
    let rawTarget;
    try {
      rawTarget = decodeURIComponent(match[1]).trim();
    } catch (e) {
      rawTarget = match[1].trim();
    }
    if (!/^https?:\/\//i.test(rawTarget)) {
      rawTarget = "https://" + rawTarget;
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawTarget);
    } catch (e) {
      return new Response("Invalid URL", { status: 400 });
    }

    const domain = targetUrl.hostname.toLowerCase();
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
      return new Response("Invalid domain", { status: 400 });
    }

    // ===== 主路径：从 HTML 中提取 <link rel="icon"> 相关元素 =====
    const { iconUrl, title } = await extractIconFromHtml(targetUrl);

    if (iconUrl) {
      const icon = await fetchIcon(iconUrl, targetUrl);
      if (icon) return withCors(icon);
    }

    // ===== 回退路径：仅当 HTML 中找不到任何 icon 元素时使用 =====
    const fallbacks = [
      // Google Favicon API（128px）
      `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      // DuckDuckGo Icons
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      // 直接请求 /favicon.ico
      `https://${domain}/favicon.ico`,
    ];

    for (const fbUrl of fallbacks) {
      const icon = await fetchIcon(fbUrl, targetUrl);
      if (icon) return withCors(icon);
    }

    // ===== 兜底：用 <title> 或域名首字母生成占位 SVG =====
    const letter = firstLetter(title) || firstLetter(domain) || "?";
    return new Response(placeholderSvg(letter), {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Content-Disposition": "inline",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};

/**
 * 从 HTML 中提取最佳 icon 链接
 * 返回 { iconUrl: string | null, title: string | null }
 *
 * 提取范围：
 *   - <link rel="icon">
 *   - <link rel="shortcut icon">
 *   - <link rel="apple-touch-icon">
 *   - <link rel="mask-icon">
 *   - <link rel="fluid-icon">
 *   - <link rel="apple-touch-icon-precomposed">
 *   - 任何 rel 属性包含 "icon" 的 <link>
 *   - <meta property="og:image"> / <meta name="twitter:image"> 兜底
 *
 * 所有 href 都基于 targetUrl 自动拼接为绝对 URL（保留查询参数）。
 */
async function extractIconFromHtml(targetUrl) {
  let titleParts = [];

  try {
    const resp = await fetch(targetUrl.href, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });

    if (!resp.ok) return { iconUrl: null, title: null };
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return { iconUrl: null, title: null };

    const icons = [];        // 候选 icon 元素
    const metaImages = [];   // meta 兜底图片

    const rewriter = new HTMLRewriter()
      // 抓取 <title>（可能被拆成多个 text 节点）
      .on("title", {
        text(t) {
          titleParts.push(t.text);
        },
      })
      // 抓取所有含 icon 的 <link>
      .on('link[rel*="icon"]', {
        element(el) {
          const rel = (el.getAttribute("rel") || "").toLowerCase().trim();
          const href = (el.getAttribute("href") || "").trim();
          const sizes = (el.getAttribute("sizes") || "").trim();
          const type = (el.getAttribute("type") || "").toLowerCase().trim();
          if (!href) return;

          // 跳过 data URI 之外的非 http(s) 资源；内联 SVG 单独处理
          if (href.startsWith("data:")) {
            if (href.toLowerCase().startsWith("data:image/svg+xml")) {
              icons.push({ kind: "inline-svg", href, rel, sizes, type });
            }
            return;
          }

          icons.push({ kind: "link", href, rel, sizes, type });
        },
      })
      // 兜底：og:image / twitter:image
      .on('meta[property="og:image"], meta[name="og:image"]', {
        element(el) {
          const c = (el.getAttribute("content") || "").trim();
          if (c) metaImages.push({ href: c, source: "og:image" });
        },
      })
      .on('meta[name="twitter:image"], meta[property="twitter:image"]', {
        element(el) {
          const c = (el.getAttribute("content") || "").trim();
          if (c) metaImages.push({ href: c, source: "twitter:image" });
        },
      })
      .on('meta[name="msapplication-TileImage"]', {
        element(el) {
          const c = (el.getAttribute("content") || "").trim();
          if (c) metaImages.push({ href: c, source: "ms-tile" });
        },
      });

    await rewriter.transform(resp).text();

    const title = titleParts.join("").replace(/\s+/g, " ").trim() || null;

    // 打分：分数越高越优
    function score(c) {
      if (c.kind === "inline-svg") return 1000;

      const hrefLower = c.href.toLowerCase();
      const cleanPath = hrefLower.split("?")[0].split("#")[0];
      const isSvg = c.type.includes("svg") || cleanPath.endsWith(".svg");

      // 尺寸解析
      let size = 0;
      if (c.sizes && c.sizes.toLowerCase() !== "any") {
        for (const part of c.sizes.split(/\s+/)) {
          const m = part.match(/(\d+)x(\d+)/i);
          if (m) size = Math.max(size, parseInt(m[1], 10), parseInt(m[2], 10));
        }
      }

      // SVG 元素（矢量）优先级很高
      if (isSvg) return 900 + Math.min(size, 64);

      // apple-touch-icon：通常为高分辨率位图
      if (c.rel.includes("apple-touch-icon")) return 500 + Math.min(size, 200);

      // 明确 256+ 的大尺寸 icon
      if (size >= 256) return 600;
      // 128~255
      if (size >= 128) return 550;

      // mask-icon / fluid-icon：多为矢量
      if (c.rel.includes("mask-icon") || c.rel.includes("fluid-icon"))
        return 450;

      // 有尺寸声明但较小
      if (size > 0) return 300 + size;

      // 无尺寸声明（如 /static/favicon.ico，可能是多尺寸 ICO）
      return 400;
    }

    icons.sort((a, b) => score(b) - score(a));

    // 主选：icons 中得分最高者
    const best = icons[0];

    if (best) {
      if (best.kind === "inline-svg") {
        const svgText = decodeDataUriSvg(best.href);
        if (svgText) {
          return {
            iconUrl: `__inline_svg__:${svgText}`,
            title,
          };
        }
      } else {
        return { iconUrl: resolveUrl(best.href, targetUrl), title };
      }
    }

    // 无 icon 元素，尝试 meta 图片
    if (metaImages.length > 0) {
      const priority = { "twitter:image": 3, "ms-tile": 2, "og:image": 1 };
      metaImages.sort(
        (a, b) => (priority[b.source] || 0) - (priority[a.source] || 0)
      );
      return { iconUrl: resolveUrl(metaImages[0].href, targetUrl), title };
    }

    return { iconUrl: null, title };
  } catch (e) {
    return { iconUrl: null, title: null };
  }
}

/**
 * 相对路径拼接：把 href 转成绝对 URL
 * - https://xxx  → 原样
 * - //xxx        → 补 https:
 * - /xxx         → 拼到 targetUrl 的 origin（保留查询参数）
 * - xxx          → 基于 targetUrl 拼接
 */
function resolveUrl(href, targetUrl) {
  try {
    const h = href.trim();
    if (!h) return null;
    if (/^https?:\/\//i.test(h)) return h;
    if (h.startsWith("//")) return "https:" + h;
    return new URL(h, targetUrl).href;
  } catch (e) {
    return null;
  }
}

/**
 * 拉取图标 URL，返回 Response（自动校验类型）
 * 若 iconUrl 以 __inline_svg__: 开头，直接返回内联 SVG
 */
async function fetchIcon(iconUrl, targetUrl) {
  if (!iconUrl) return null;

  // 内联 SVG 直接返回
  if (iconUrl.startsWith("__inline_svg__:")) {
    const svg = iconUrl.slice("__inline_svg__:".length);
    return new Response(svg, {
      status: 200,
      headers: { "Content-Type": "image/svg+xml" },
    });
  }

  try {
    const r = await fetch(iconUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: targetUrl.href,
      },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    if (!r.ok) return null;

    const t = (r.headers.get("content-type") || "").toLowerCase();
    const accept =
      t.startsWith("image/") ||
      t === "" ||
      t === "application/octet-stream" ||
      t === "binary/octet-stream";

    return accept ? r : null;
  } catch (e) {
    return null;
  }
}

/**
 * 解码 data:image/svg+xml 内联 SVG
 */
function decodeDataUriSvg(dataUri) {
  const commaIdx = dataUri.indexOf(",");
  if (commaIdx === -1) return null;

  const meta = dataUri.substring(0, commaIdx).toLowerCase();
  const data = dataUri.substring(commaIdx + 1);

  let svg;
  try {
    svg = meta.includes(";base64") ? atob(data) : decodeURIComponent(data);
  } catch (e) {
    return null;
  }
  return svg && svg.includes("<svg") ? svg : null;
}

/**
 * 取首个有效字符并大写
 */
function firstLetter(str) {
  if (!str) return null;
  const m = str.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 生成首字母占位 SVG
 */
function placeholderSvg(letter) {
  const safe = String(letter)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="24" fill="#6366f1"/>
    <text x="64" y="82" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">${safe}</text>
  </svg>`;
}

/**
 * 统一附加 CORS、Content-Disposition、缓存头，并纠正 Content-Type
 */
function withCors(resp) {
  const headers = new Headers(resp.headers);
  headers.delete("Content-Disposition");
  headers.delete("Content-Transfer-Encoding");
  headers.delete("Content-Encoding");

  const origType = resp.headers.get("content-type") || "";
  let finalType = origType;

  if (
    !finalType.startsWith("image/") ||
    finalType === "application/octet-stream" ||
    finalType === "binary/octet-stream"
  ) {
    const u = (resp.url || "").toLowerCase().split("?")[0].split("#")[0];
    if (u.endsWith(".png")) finalType = "image/png";
    else if (u.endsWith(".svg")) finalType = "image/svg+xml";
    else if (u.endsWith(".webp")) finalType = "image/webp";
    else if (u.endsWith(".gif")) finalType = "image/gif";
    else if (u.endsWith(".jpg") || u.endsWith(".jpeg"))
      finalType = "image/jpeg";
    else finalType = "image/x-icon";
  }

  headers.set("Content-Type", finalType);
  headers.set("Content-Disposition", "inline");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Cache-Control",
    "public, max-age=86400, s-maxage=86400, immutable"
  );

  return new Response(resp.body, { status: 200, headers });
}
