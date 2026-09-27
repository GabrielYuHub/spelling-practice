// 帮助页截图用的本地服务器：把每个 HTTP 请求转成云函数的 event 调用 main()（和 CloudBase 的 HTTP 网关一样，base64 的响应先解码）
const http = require('http');
const m = require(process.argv[2]);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
  const out = await m.main({ path: url.pathname, httpMethod: req.method, headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams), body, isBase64Encoded: false });
  res.writeHead(out.statusCode, out.headers); res.end(out.isBase64Encoded ? Buffer.from(out.body, "base64") : out.body);
}).listen(8770, () => console.log('cb mock on 8770'));
