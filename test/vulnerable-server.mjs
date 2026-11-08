// A deliberately leaky local site for testing the probe. Never deploy this.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4599);
const fake = {
  '/.env': 'DATABASE_URL=postgres://app:hunter2@db.internal/app\nSTRIPE_KEY=sk_test_x\nNODE_ENV=production\n',
  '/terraform.tfstate': '{"version":4,"terraform_version":"1.9.0","resources":[]}',
  '/keys/service-account.json': '{"type":"service_account","project_id":"demo","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}',
  '/supabase/config.toml': '[api]\nport = 54321\n',
  '/.git/HEAD': 'ref: refs/heads/main\n',
  '/app.js.map': '{"version":3,"sources":["src/app.ts"],"sourcesContent":["secret()"],"mappings":"AAAA"}',
  '/app.js': 'console.log(1)\n//# sourceMappingURL=app.js.map\n',
  '/api/auth/session': '{"user":null,"csrfToken":"abc"}',
};
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const raw = req.url.split('?')[0];
  if (fake[raw]) return res.writeHead(200, { 'content-type': raw.endsWith('.json') || raw.endsWith('.map') || raw.includes('session') ? 'application/json' : 'text/plain' }).end(fake[raw]);
  if (raw === '/') return res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'Express' }).end(page('<script src="/app.js"></script>Home'));
  // Naive guard: only the exact raw prefix is protected, so /%2Fadmin slips past.
  if (raw.startsWith('/admin')) return res.writeHead(307, { location: '/login' }).end();
  if (decodeURIComponent(url.pathname).replace(/^\/+/, '/') === '/admin') return res.writeHead(200, { 'content-type': 'text/html' }).end(page('Admin panel'));
  if (raw.includes('environ')) return res.writeHead(500).end('crash');
  res.writeHead(404, { 'content-type': 'text/html' }).end(page('Not found'));
}).listen(PORT, () => console.log(`vulnerable test site on http://localhost:${PORT}`));
