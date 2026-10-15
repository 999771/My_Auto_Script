//本地优选ip测速结果上传cloudflare KV存储
//环境变量 U   ，绑定KV空间
//环境变量T   ，绑定token验证

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const token = url.searchParams.get('token');

    // 1. 验证：路径必须为 /ip.txt，且 token 必须与环境变量 T 一致
    const validPath = path === '/ip.txt';
    const validToken = token === env.T;
    if (!(validPath && validToken)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 2. 处理上传（POST 覆盖原数据）和查看（GET）
    if (request.method === 'POST') {
      const body = await request.text();
      await env.U.put('ip.txt', body);
      return new Response('Upload success', { status: 200 });
    } else {
      const content = await env.U.get('ip.txt');
      if (content === null) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }
}
