// Two local servers for testing csp.mjs: a site on :4597 and a "third party"
// on :4598 that serves a script, an image and an embed.
import { createServer } from 'node:http';

const THIRD = 'http://localhost:4598';
const page = `<!doctype html><html><head>
<style>body { font-family: sans-serif }</style>
<script>window.answer = eval('40 + 2');</script>
<script src="${THIRD}/widget.js"></script>
</head><body>
<h1>Fixture</h1>
<a href="/about">About</a>
<iframe src="${THIRD}/embed"></iframe>
<form action="/subscribe" method="post"><button>Go</button></form>
</body></html>`;

createServer((req, res) => {
  if (req.url === '/' || req.url === '/about') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  res.writeHead(404).end();
}).listen(4597);

createServer((req, res) => {
  if (req.url === '/widget.js') return res.writeHead(200, { 'content-type': 'text/javascript' })
    .end(`const i = new Image(); i.src = '${THIRD}/pixel.gif'; document.body?.append(i); fetch('${THIRD}/api/ping').catch(() => {});`);
  if (req.url === '/embed') return res.writeHead(200, { 'content-type': 'text/html' }).end('<p>embed</p>');
  if (req.url === '/pixel.gif') return res.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' })
    .end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  if (req.url === '/api/ping') return res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
  res.writeHead(404).end();
}).listen(4598, () => console.log('csp fixture on http://localhost:4597 (third party :4598)'));
