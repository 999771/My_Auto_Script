addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event))
})

// Base58 编码函数（Cloudflare Workers 兼容）
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// 合并多个JSON配置文件
async function mergeJsonConfigs(urls) {
  const allData = []
  
  for (const url of urls) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        console.error(`Failed to fetch ${url}: ${response.status}`)
        continue
      }
      const data = await response.json()
      
      // 如果数据是数组，直接合并；如果是对象，包装成数组
      if (Array.isArray(data)) {
        allData.push(...data)
      } else if (typeof data === 'object' && data !== null) {
        allData.push(data)
      }
    } catch (error) {
      console.error(`Error fetching ${url}:`, error)
    }
  }
  
  return allData
}

async function handleRequest(request, event) {
  // 获取环境变量
  const env = event && event.env ? event.env : {}
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

  const reqUrl = new URL(request.url)
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // -------------------- 通用 API 中转代理 --------------------
  if (targetUrlParam) {
    let fullTargetUrl = targetUrlParam
    const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/)
    if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

    let targetURL
    try {
      targetURL = new URL(fullTargetUrl)
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL', url: fullTargetUrl }, null, 2), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
      })
    }

    try {
      const proxyRequest = new Request(targetURL.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 9000)
      const response = await fetch(proxyRequest, { signal: controller.signal })
      clearTimeout(timeoutId)

      const responseHeaders = new Headers(corsHeaders)
      const excludeHeaders = [
        'content-encoding', 'content-length', 'transfer-encoding',
        'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
      ]
      for (const [key, value] of response.headers) {
        if (!excludeHeaders.includes(key.toLowerCase())) responseHeaders.set(key, value)
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      })
    } catch (err) {
      return new Response(JSON.stringify({
        error: 'Proxy Error',
        message: err.message || '代理请求失败',
        target: fullTargetUrl,
        timestamp: new Date().toISOString()
      }, null, 2), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
      })
    }
  }

  // -------------------- 根据 source 参数选择 JSON 源 --------------------
  // 从环境变量获取源，如果没有设置则使用默认值
  const defaultVodUrl = 'https://raw.githubusercontent.com/999771/tv-config-check/refs/heads/main/output/sub-config.json'
  const defaultXxxUrl = 'https://raw.githubusercontent.com/999771/tv-config-check/refs/heads/main/output/xxx-config.json'
  
  const vodUrl = env.vod || defaultVodUrl
  const xxxUrl = env.xxx || defaultXxxUrl
  
  const JSON_SOURCES = {
    'vod': vodUrl,
    'xxx': xxxUrl,
    'full': 'merge' // 特殊标记，表示需要合并
  }

  // -------------------- JSON 配置 + format 参数处理 --------------------
  if (formatParam !== null) {
    try {
      let data
      
      if (sourceParam === 'full' || (!sourceParam && formatParam !== null)) {
        // full模式：合并所有JSON文件
        const allUrls = [vodUrl, xxxUrl]
        data = await mergeJsonConfigs(allUrls)
      } else if (sourceParam && JSON_SOURCES[sourceParam] && JSON_SOURCES[sourceParam] !== 'merge') {
        // 单个源模式
        const selectedSource = JSON_SOURCES[sourceParam]
        const response = await fetch(selectedSource)
        if (!response.ok) {
          return new Response(JSON.stringify({ 
            error: 'Failed to fetch source data',
            source: selectedSource,
            status: response.status,
            statusText: response.statusText
          }, null, 2), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
          })
        }
        data = await response.json()
      } else {
        return new Response(JSON.stringify({ 
          error: 'Invalid source parameter',
          source: sourceParam,
          availableSources: Object.keys(JSON_SOURCES).filter(s => s !== 'full')
        }, null, 2), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
        })
      }

      // 根据 format 参数决定处理逻辑
      let addPrefix = false
      let encodeBase58 = false

      if (formatParam === '1' || formatParam === 'proxy') {
        addPrefix = true
      } else if (formatParam === '2' || formatParam === 'base58') {
        encodeBase58 = true
      } else if (formatParam === '3' || formatParam === 'proxy-base58') {
        addPrefix = true
        encodeBase58 = true
      }

      const newData = addPrefix
        ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
        : data

      if (encodeBase58) {
        const encoded = base58Encode(newData)
        return new Response(encoded, {
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...corsHeaders },
        })
      } else {
        return new Response(JSON.stringify(newData), {
          headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders },
        })
      }
    } catch (err) {
      return new Response(JSON.stringify({ 
        error: err.message,
        stack: err.stack
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      })
    }
  }

  // -------------------- 根目录返回说明页面 --------------------
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    h3 { color: #666; margin-top: 25px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
    .copy-btn { margin-left: 10px; padding: 2px 8px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; }
    .copy-btn:hover { background: #45a049; }
    .url-info { background: #e3f2fd; padding: 10px; border-radius: 5px; margin: 10px 0; word-break: break-all; }
    .deploy-steps { background: #fff3e0; padding: 15px; border-radius: 5px; border-left: 4px solid #ff9800; }
    .deploy-steps ol { margin: 10px 0; padding-left: 20px; }
    .deploy-steps li { margin: 8px 0; }
    .status-badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
    .status-default { background: #e0e0e0; color: #616161; }
    .status-configured { background: #c8e6c9; color: #2e7d32; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>vod</code> = 普通版<br>
            <code>xxx</code> = 成人版<br>
            <code>full</code> = 完整版（自动合并）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 普通版（vod）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=vod</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=vod</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=vod</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=vod</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 成人版（xxx）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=xxx</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=xxx</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=xxx</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=xxx</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，自动合并）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>当前配置信息</h2>
  <div class="section">
    <p><strong>环境变量状态：</strong>
      <span class="status-badge ${env.vod || env.xxx ? 'status-configured' : 'status-default'}">
        ${env.vod || env.xxx ? '已设置，使用配置源' : '未设置，使用默认源'}
      </span>
    </p>
  </div>
  
  <h2>部署说明</h2>
  <div class="deploy-steps">
    <h3>🚀 如何设置环境变量</h3>
    <ol>
      <li>在 Workers 控制台打开设置中的"变量和机密"部分</li>
      <li>点击"添加变量"按钮</li>
      <li>设置变量信息：
        <ul>
          <li><strong>类型：</strong>选择"文本"</li>
          <li><strong>变量名称：</strong>输入 <code>vod</code> 或 <code>xxx</code></li>
          <li><strong>值：</strong>输入对应的 JSON 文件 URL</li>
        </ul>
      </li>
      <li>点击"保存"按钮</li>
      <li>保存并部署 Worker</li>
    </ol>
    <p><strong>提示：</strong>可以同时设置两个环境变量，也可以只设置其中一个。未设置的变量将使用默认的 GitHub 源。</p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
    <li>✅ 支持环境变量配置</li>
    <li>✅ 支持自动合并多个JSON源</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } 
  })
}
