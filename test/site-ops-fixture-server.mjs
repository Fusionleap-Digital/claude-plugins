// A small local site with deliberate problems, for testing the site-ops
// smoke test, AI visibility check and lead test. Never deploy this.
//
//   node test/site-ops-fixture-server.mjs        (http://localhost:4596)
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4596);
const ORIGIN = `http://localhost:${PORT}`;

const org = { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Fixture Co', url: ORIGIN, description: 'A fixture company.' };
const layout = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>
<meta name="description" content="Fixture site for site-ops tests.">${head}
<script type="application/ld+json">${JSON.stringify(org)}</script>
<script src="/static/app.js"></script></head><body>${body}</body></html>`;

const pages = {
  '/': layout('Fixture Co | Home', '<h1>Welcome to Fixture Co</h1>', '<script type="application/ld+json">{"@type": "WebSite", broken</script>'),
  '/pricing': layout('Pricing', '<h1>Pricing</h1>', '<meta name="robots" content="noindex">'),
  '/contact': layout('Contact', `<form class="contact">
    <input id="name" required><input type="email" id="email" required>
    <input id="company"><input name="website" tabindex="-1" autocomplete="off">
    <textarea id="message" required></textarea><button>Send</button></form>`),
};

export const submissions = [];

export function start(port = PORT) {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ' + ORIGIN + '/sitemap.xml\n');
    if (path === '/sitemap.xml') {
      const locs = ['/', '/pricing', '/about', '/contact'].map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('') + '<url><loc>https://main.d123.amplifyapp.com/blog</loc></url>';
      return res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    }
    if (path === '/static/app.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('fetch("/api/contact",{method:"POST"});fetch("/api/admin/session");');
    if (path === '/api/contact' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.email || !data.message) return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Missing required fields"}');
          submissions.push(data);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, id: submissions.length }));
        } catch {
          res.writeHead(400).end('bad json');
        }
      });
      return;
    }
    if (path === '/about') return res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Internal Server Error</h1>');
    if (pages[path]) {
      // Missing CSP and Referrer-Policy on purpose.
      return res.writeHead(200, { 'content-type': 'text/html', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }).end(pages[path]);
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end(layout('404', 'Not found'));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`site-ops fixture site on ${ORIGIN}`));
}
