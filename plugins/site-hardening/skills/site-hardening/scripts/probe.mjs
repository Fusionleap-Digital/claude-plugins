#!/usr/bin/env node
// Site hardening probe: checks your own live site for the files and routes
// that scanners ask for. Read-only (GET only), rate-limited, and it refuses
// to run until the site proves ownership. Zero dependencies, Node 18+.
//
//   node probe.mjs https://example.com [--protected /admin,/dashboard]
//                  [--rate 2] [--out ./report-dir] [--paths file.tsv]

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolveTxt } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const VERSION = '0.1.0';
const UA = `site-hardening-probe/${VERSION} (owner-verified security self-check)`;
const VERIFY_PREFIX = 'site-hardening-verification=';
const VERIFY_FILE = '/.well-known/site-hardening.txt';
const BODY_LIMIT = 64 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
function parseArgs(argv) {
  const args = { rate: 2, protected: ['/admin', '/dashboard', '/settings', '/account', '/api/admin'] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rate') args.rate = Math.min(5, Math.max(0.2, Number(argv[++i])));
    else if (a === '--protected') args.protected = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--paths') args.paths = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.target = rest[0];
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- http ----------
let lastRequest = 0;
let minGapMs = 500;
let requestCount = 0;

async function get(url, { redirect = 'manual' } = {}) {
  const wait = lastRequest + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  requestCount++;
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect,
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    let body = '';
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      while (size < BODY_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      reader.cancel().catch(() => {});
      body = Buffer.concat(chunks).toString('utf8');
    }
    return { status: res.status, headers: res.headers, body, url };
  } catch (err) {
    return { status: 0, headers: new Headers(), body: '', url, error: String(err?.cause?.code || err?.name || err) };
  }
}

// ---------- ownership ----------
function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.localhost') || host.endsWith('.test');
}

async function verifyOwnership(origin, host) {
  if (isLocalHost(host)) return { ok: true, method: 'local development host' };
  const file = await get(origin + VERIFY_FILE, { redirect: 'follow' });
  if (file.status === 200 && file.body.includes(VERIFY_PREFIX)) return { ok: true, method: `file ${VERIFY_FILE}` };
  try {
    const records = (await resolveTxt(`_site-hardening.${host}`)).map((r) => r.join(''));
    if (records.some((r) => r.startsWith(VERIFY_PREFIX))) return { ok: true, method: `DNS TXT _site-hardening.${host}` };
  } catch {
    // no record
  }
  return { ok: false };
}

// ---------- detection ----------
// Signatures that mean real secret material came back. Only the signature
// name goes into the report, never the matched text.
const SECRET_SIGNATURES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GCP service account', /"type"\s*:\s*"service_account"/],
  ['private_key field', /"private_key(_id)?"\s*:/],
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['AWS secret key', /aws_secret_access_key/i],
  ['Terraform state', /"terraform_version"\s*:/],
  ['git config', /\[core\][\s\S]{0,80}repositoryformatversion/],
  ['git HEAD', /^ref: refs\/heads\//m],
  ['process environment', /(^|\0)(PATH|HOME|HOSTNAME|NODE_ENV)=[^\0\n]+(\0|\n)/],
  ['passwd file', /root:x:0:0:/],
  ['Stripe live key', /\bsk_live_[0-9a-zA-Z]{10,}/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Supabase service role', /service_role|SUPABASE_SERVICE_ROLE/],
  ['database URL', /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s"']+:[^\s"']+@/],
  ['Kubernetes config', /^apiVersion:\s*v1[\s\S]{0,200}clusters:/m],
  ['dotenv file', /(^[A-Z][A-Z0-9_]{2,}=.*\n){3,}/m],
];

function secretHits(body) {
  return SECRET_SIGNATURES.filter(([, re]) => re.test(body)).map(([name]) => name);
}

function fingerprint(r) {
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  // Strip things that change per request (nonces, build ids, timestamps).
  const norm = r.body.replace(/nonce="[^"]*"/g, '').replace(/[0-9a-f]{16,}/gi, '').replace(/\d+/g, '');
  return { status: r.status, ct, len: r.body.length, hash: createHash('sha1').update(norm).digest('hex') };
}

function looksLikeBaseline(r, baselines) {
  const f = fingerprint(r);
  return baselines.some((b) => {
    if (b.status !== f.status || b.ct !== f.ct) return false;
    if (b.hash === f.hash) return true;
    return b.len > 0 && Math.abs(b.len - f.len) / b.len < 0.05 && f.ct === 'text/html';
  });
}

const SEVERITY_BY_CATEGORY = {
  env: 'high', credentials: 'high', cloud: 'high', traversal: 'high', 'vcs-backup': 'high',
  build: 'medium', config: 'medium', recon: 'review',
};
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'review', 'info'];

// ---------- checks ----------
async function checkPaths(origin, entries, baselines, findings) {
  let exposed = 0;
  for (const { category, path } of entries) {
    const r = await get(origin + path);
    const base = { check: 'exposed-file', category, path, status: r.status };
    if (r.error) { findings.push({ ...base, severity: 'info', result: 'error', detail: r.error }); continue; }
    if (r.status >= 500) {
      findings.push({ ...base, severity: category === 'traversal' ? 'medium' : 'low', result: 'warn',
        detail: 'Server error on a probe. Check that the route handles bad input without crashing.' });
      continue;
    }
    if (r.status < 200 || r.status >= 300) continue; // 3xx/4xx = not served
    if (looksLikeBaseline(r, baselines)) continue; // the site's normal "not found" page
    const hits = secretHits(r.body);
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    if (category === 'recon') {
      let keys = [];
      try { keys = Object.keys(JSON.parse(r.body) || {}); } catch {}
      findings.push({ ...base, severity: hits.length ? 'critical' : 'review', result: 'review',
        detail: `Public response (${ct}, ${r.body.length} bytes)${keys.length ? `, top-level keys: ${keys.join(', ')}` : ''}. Confirm it reveals nothing to signed-out visitors.` });
      continue;
    }
    exposed++;
    findings.push({ ...base, severity: hits.length ? 'critical' : SEVERITY_BY_CATEGORY[category] || 'medium', result: 'fail',
      detail: `Served with ${r.status} (${ct || 'no content-type'}, ${r.body.length} bytes)` +
        (hits.length ? `; contains: ${hits.join(', ')}. Remove it from the deploy and rotate any secrets it held.` : '; review the content and remove it from the deploy.') });
  }
  return exposed;
}

async function checkHeaders(origin, home, findings) {
  const h = home.headers;
  const add = (severity, check, detail) => findings.push({ check, path: '/', status: home.status, severity, result: 'fail', detail });
  const csp = h.get('content-security-policy');
  if (origin.startsWith('https:') && !h.get('strict-transport-security')) add('medium', 'header-hsts', 'No Strict-Transport-Security header.');
  if (!csp) add(h.get('content-security-policy-report-only') ? 'low' : 'medium', 'header-csp',
    h.get('content-security-policy-report-only') ? 'CSP is report-only, not enforced.' : 'No Content-Security-Policy header.');
  if ((h.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') add('low', 'header-nosniff', 'X-Content-Type-Options: nosniff is missing.');
  if (!h.get('x-frame-options') && !(csp && /frame-ancestors/i.test(csp))) add('medium', 'header-framing', 'No X-Frame-Options or CSP frame-ancestors; the site can be framed (clickjacking).');
  if (!h.get('referrer-policy')) add('low', 'header-referrer', 'No Referrer-Policy header.');
  const powered = h.get('x-powered-by');
  if (powered) add('low', 'header-x-powered-by', `X-Powered-By reveals the stack: ${powered}.`);
  const server = h.get('server');
  if (server && /\d/.test(server)) add('low', 'header-server-version', `Server header reveals a version: ${server}.`);
}

async function checkHttpsRedirect(host, findings) {
  if (isLocalHost(host)) return;
  const r = await get(`http://${host}/`); // default port only
  const loc = r.headers.get('location') || '';
  if (r.error) return;
  if (!(r.status >= 300 && r.status < 400 && loc.startsWith('https://'))) {
    findings.push({ check: 'https-redirect', path: 'http://' + host + '/', status: r.status, severity: 'medium', result: 'fail',
      detail: 'Plain HTTP does not redirect to HTTPS.' });
  }
}

async function checkSourceMaps(origin, home, findings) {
  const srcs = [...home.body.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  const sameOrigin = [...new Set(srcs)]
    .map((s) => new URL(s, origin))
    .filter((u) => u.origin === origin)
    .slice(0, 8);
  let checked = 0;
  for (const u of sameOrigin) {
    const js = await get(u.href);
    if (js.status !== 200) continue;
    checked++;
    const ref = js.body.match(/\/\/[#@] sourceMappingURL=(\S+)\s*$/m)?.[1] || js.headers.get('sourcemap') || js.headers.get('x-sourcemap');
    const mapUrl = ref && !ref.startsWith('data:') ? new URL(ref, u).href : u.href.split('?')[0] + '.map';
    const map = await get(mapUrl);
    if (map.status === 200 && /"mappings"\s*:/.test(map.body)) {
      const full = /"sourcesContent"\s*:\s*\[/.test(map.body);
      findings.push({ check: 'source-map', path: new URL(mapUrl).pathname, status: 200, severity: full ? 'high' : 'medium', result: 'fail',
        detail: full ? 'Production source map includes your original source code.' : 'Production source map is public.' });
      return; // one is enough to prove the build setting
    }
  }
  if (!checked) findings.push({ check: 'source-map', path: '/', status: home.status, severity: 'info', result: 'skipped', detail: 'No same-origin scripts found on the home page.' });
}

async function checkEncodedBypass(origin, protectedPaths, baselines, findings) {
  for (const p of protectedPaths) {
    const plain = await get(origin + p);
    const isGuarded = (plain.status >= 300 && plain.status < 400) || plain.status === 401 || plain.status === 403;
    if (!isGuarded) continue; // missing (404) or public: nothing to bypass
    const name = p.replace(/^\//, '');
    for (const v of [`/%2F${name}`, `//${name}`, `/${encodeURIComponent(name).replace(/\//g, '%2F')}`, `/./${name}`, `${p}%2F`]) {
      if (v === p) continue;
      const r = await get(origin + v);
      if (r.status >= 200 && r.status < 300 && !looksLikeBaseline(r, baselines)) {
        findings.push({ check: 'auth-bypass', path: v, status: r.status, severity: 'high', result: 'fail',
          detail: `${p} is guarded (${plain.status}) but ${v} returns ${r.status}. Middleware is matching the raw path; decode and normalize it before the auth check.` });
        break;
      }
    }
  }
}

// ---------- report ----------
function toMarkdown(meta, findings) {
  const fails = findings.filter((f) => f.result === 'fail' || f.result === 'warn');
  const reviews = findings.filter((f) => f.result === 'review');
  const counts = SEVERITY_ORDER.map((s) => [s, fails.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const lines = [
    `# Site hardening report: ${meta.host}`,
    '',
    `- Scanned: ${meta.started} (${meta.requests} GET requests, ${meta.rate}/s)`,
    `- Ownership: ${meta.ownership}`,
    `- Probe list: ${meta.pathCount} paths`,
    `- Result: ${fails.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : 'no problems found'}`,
    '',
  ];
  const table = (rows) => {
    lines.push('| Severity | Check | Path | Status | Detail |', '|---|---|---|---|---|');
    for (const f of rows) lines.push(`| ${f.severity} | ${f.check}${f.category ? ` (${f.category})` : ''} | \`${f.path}\` | ${f.status} | ${f.detail.replace(/\|/g, '\\|')} |`);
    lines.push('');
  };
  if (fails.length) { lines.push('## Problems'); lines.push(''); table(fails); }
  if (reviews.length) { lines.push('## Check by hand'); lines.push(''); table(reviews); }
  lines.push('## Passed', '', `${meta.pathCount - meta.exposed} of ${meta.pathCount} probe paths exposed no content (404, 403, redirect, error, or the site\'s normal not-found page).`, '');
  return lines.join('\n');
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) {
    console.log('Usage: node probe.mjs https://your-site.com [--protected /admin,/dashboard] [--rate 2] [--out dir] [--paths file.tsv]');
    process.exit(args.help ? 0 : 2);
  }
  const target = new URL(args.target.includes('://') ? args.target : `https://${args.target}`);
  const origin = target.origin;
  const host = target.host;
  minGapMs = 1000 / args.rate;

  const own = await verifyOwnership(origin, target.hostname);
  if (!own.ok) {
    console.error(`Refusing to scan ${host}: ownership not verified.\n\nProve you control the site with either:\n` +
      `  1. A file at ${origin}${VERIFY_FILE} containing:  ${VERIFY_PREFIX}<any-id>\n` +
      `  2. A DNS TXT record on _site-hardening.${target.hostname} with value:  ${VERIFY_PREFIX}<any-id>\n\n` +
      'Only scan sites you own or have written permission to test.');
    process.exit(2);
  }

  const raw = await readFile(args.paths || join(HERE, '..', 'references', 'probe-paths.tsv'), 'utf8');
  const entries = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
    const [category, path] = l.split('\t');
    return { category, path };
  });

  const started = new Date().toISOString();
  console.error(`Scanning ${origin} (${own.method}) — ${entries.length} paths at ${args.rate}/s`);

  // What this site returns for a page that doesn't exist.
  const tag = randomBytes(6).toString('hex');
  const baselines = [];
  for (const p of [`/sh-missing-${tag}`, `/sh-missing-${tag}.json`, `/sh-missing-${tag}/config.yml`]) baselines.push(fingerprint(await get(origin + p)));

  const findings = [];
  if (baselines.some((b) => b.status === 200)) {
    findings.push({ check: 'soft-404', path: `/sh-missing-${tag}`, status: 200, severity: 'info', result: 'review',
      detail: 'Missing pages return 200. Probes that match that page are ignored, but real 404s make scanners give up sooner.' });
  }

  const home = await get(origin + '/', { redirect: 'follow' });
  await checkHeaders(origin, home, findings);
  await checkHttpsRedirect(target.hostname, findings);
  await checkSourceMaps(origin, home, findings);
  await checkEncodedBypass(origin, args.protected, baselines, findings);
  const exposed = await checkPaths(origin, entries, baselines, findings);

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const meta = { host, origin, started, finished: new Date().toISOString(), ownership: own.method, rate: args.rate,
    requests: requestCount, pathCount: entries.length, exposed, version: VERSION };

  const out = args.out || `site-hardening-${target.hostname}-${started.slice(0, 10)}`;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify({ meta, findings }, null, 2));
  await writeFile(join(out, 'report.md'), toMarkdown(meta, findings));

  const problems = findings.filter((f) => f.result === 'fail' || f.result === 'warn');
  const bad = problems.filter((f) => f.severity === 'critical' || f.severity === 'high');
  console.error(`Done: ${problems.length} problems (${bad.length} critical/high). Report: ${join(out, 'report.md')}`);
  process.exit(bad.length ? 1 : 0);
}

main();
