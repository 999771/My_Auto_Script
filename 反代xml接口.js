export default {
  async fetch(request, env) {
    // 设置CORS头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // 处理OPTIONS请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    // 获取目标URL
    const url = new URL(request.url);
    const target = "https://caiji.dyttzyapi.com/api.php/provide/vod/at/xml/";
    
    // 复制原始请求头，并添加必要的头信息
    const headers = new Headers(request.headers);
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    headers.set('Referer', 'https://caiji.dyttzyapi.com/');
    headers.set('Origin', 'https://caiji.dyttzyapi.com');
    
    // 移除可能引起问题的头
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ray');
    headers.delete('cf-ipcountry');
    headers.delete('cf-visitor');
    
    // 复制请求参数
    let newRequest;
    if (request.method === 'POST') {
      const body = await request.text();
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      
      newRequest = new Request(target, {
        method: 'POST',
        body: body,
        headers: headers
      });
    } else {
      // 如果是GET请求，将查询参数添加到目标URL
      let targetWithParams = target;
      if (url.search) {
        targetWithParams += url.search;
      }
      
      newRequest = new Request(targetWithParams, {
        method: 'GET',
        headers: headers
      });
    }

    try {
      // 发送请求到目标服务器
      const response = await fetch(newRequest);
      
      // 检查响应是否成功
      if (!response.ok) {
        throw new Error(`目标服务器响应错误: ${response.status}`);
      }
      
      // 获取响应文本
      const text = await response.text();
      
      // 使用正则表达式提取XML内容
      const xmlMatch = text.match(/<rss[\s\S]*?<\/rss>/i);
      if (xmlMatch) {
        // 返回纯XML，保持原始格式
        return new Response(xmlMatch[0], {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            ...corsHeaders
          }
        });
      } else {
        // 如果没有找到XML，返回错误
        return new Response('<?xml version="1.0"?><error>未找到XML数据</error>', {
          status: 500,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            ...corsHeaders
          }
        });
      }
    } catch (error) {
      // 返回错误信息
      return new Response(`<?xml version="1.0"?><error>${error.message}</error>`, {
        status: 500,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          ...corsHeaders
        }
      });
    }
  }
};
