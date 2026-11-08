#!/usr/bin/env node
// CSP builder: opens the site in headless Chrome, records every origin each
// page loads from, writes a Content-Security-Policy, then reloads the pages
// with that policy applied (report-only) to prove nothing would be blocked.
// Zero dependencies: drives the installed Chrome over the DevTools protocol.
// Node 22+ (global WebSocket).
//
//   node csp.mjs https://example.com [--pages 12] [--out dir]
//   node csp.mjs https://example.com --verify "default-src 'self'; ..."

import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '0.1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- args ----------
function parseArgs(argv) {
  const args = { pages: 12 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') args.pages = Math.min(40, Math.max(1, Number(argv[++i])));
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--verify') args.verify = argv[++i];
    else if (a === '--path') (args.paths ||= []).push(argv[++i]);
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.target = rest[0];
  return args;
}

// ---------- chrome ----------
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  }[process.platform] || [];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch {}
  }
  return null;
}

async function launchChrome() {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found. Install Chrome or Chromium, or set CHROME_PATH.');
  const userDir = await mkdtemp(join(tmpdir(), 'site-hardening-csp-'));
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    // Local builds often load from another local port (an API, a CDN stand-in);
    // headless Chrome can't show the permission prompt for that, so allow it.
    '--disable-features=LocalNetworkAccessChecks',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start within 20 s')), 20_000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code})`)); });
  });
  const close = async () => { proc.kill(); await sleep(300); await rm(userDir, { recursive: true, force: true }).catch(() => {}); };
  return { wsUrl, close };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p) m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else for (const l of this.listeners) l(m);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { this.ws.close(); }
}

// ---------- page session ----------
const VIOLATION_HOOK = `document.addEventListener('securitypolicyviolation', (e) => {
  try { window.__cspViolation(JSON.stringify({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample })); } catch (err) {}
}, true);`;

// mode 'discover': strip any CSP so we see everything the page wants to load.
// mode 'verify': replace any CSP with the candidate as report-only, so every
// would-be block is reported without breaking later loads.
async function openTab(cdp, mode, policy) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  const state = { requests: [], sockets: [], violations: [], injectErrors: [], mainFrameId: null, lastNetwork: Date.now(), loaded: false };

  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    switch (m.method) {
      case 'Network.requestWillBeSent':
        state.lastNetwork = Date.now();
        state.requests.push({ url: p.request.url, type: p.type, frameId: p.frameId, initiator: p.initiator?.type });
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        state.lastNetwork = Date.now();
        break;
      case 'Network.webSocketCreated':
        state.sockets.push(p.url);
        break;
      case 'Page.loadEventFired':
        state.loaded = true;
        break;
      case 'Runtime.bindingCalled':
        if (p.name === '__cspViolation') { try { state.violations.push(JSON.parse(p.payload)); } catch {} }
        break;
      case 'Fetch.requestPaused': {
        // Only the top-level page gets the policy (a page target's main frame id
        // is its target id); embeds keep their own, and failed loads pass through.
        if (p.frameId !== targetId || p.responseStatusCode === undefined || p.responseErrorReason) {
          s('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
          break;
        }
        // getResponseBody returns the decoded body, so drop encoding and length too.
        const headers = (p.responseHeaders || []).filter((h) => !/^(content-security-policy(-report-only)?|content-encoding|content-length)$/i.test(h.name));
        if (mode === 'verify') headers.push({ name: 'Content-Security-Policy-Report-Only', value: policy });
        // Rebuild the response: Chrome ignores header-only changes for CSP.
        const status = p.responseStatusCode;
        const isRedirect = status >= 300 && status < 400;
        (isRedirect ? Promise.resolve({ body: '', base64Encoded: true }) : s('Fetch.getResponseBody', { requestId: p.requestId }))
          .then(({ body, base64Encoded }) => s('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: status, responseHeaders: headers,
            body: base64Encoded ? body : Buffer.from(body, 'utf8').toString('base64'),
          }))
          .catch((err) => {
            state.injectErrors.push(err.message);
            return s('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
          });
        break;
      }
    }
  });

  await s('Page.enable');
  await s('Network.enable');
  await s('Runtime.enable');
  await s('Runtime.addBinding', { name: '__cspViolation' });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: VIOLATION_HOOK });
  await s('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
  await s('Network.setCacheDisabled', { cacheDisabled: true });

  return {
    state,
    async visit(url) {
      state.requests = []; state.sockets = []; state.violations = []; state.loaded = false;
      state.lastNetwork = Date.now();
      const nav = await s('Page.navigate', { url });
      if (nav.errorText) return { error: nav.errorText };
      state.mainFrameId = nav.frameId;
      const start = Date.now();
      while (!state.loaded && Date.now() - start < 15_000) await sleep(100);
      // Scroll through the page to trigger lazy-loaded images, embeds and scripts.
      await s('Runtime.evaluate', { expression: `(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } window.scrollTo(0, 0); })()`, awaitPromise: true }).catch(() => {});
      // Wait for the network to go quiet (lazyOnload scripts, beacons, replay chunks).
      const idleStart = Date.now();
      while (Date.now() - state.lastNetwork < 2000 && Date.now() - idleStart < 12_000) await sleep(200);
      const { result } = await s('Runtime.evaluate', { expression: DOM_PROBE, returnByValue: true });
      return { dom: result.value };
    },
    close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}),
  };
}

// What the static page needs that network logs don't show.
const DOM_PROBE = `(() => {
  const exec = (s) => !s.type || /^(text|application)\\/(javascript|ecmascript)$|^module$/i.test(s.type);
  const inline = [...document.querySelectorAll('script:not([src])')].filter(exec).map((s) => s.textContent);
  let handlers = 0;
  for (const el of document.querySelectorAll('*')) for (const a of el.attributes) if (/^on[a-z]+$/i.test(a.name)) handlers++;
  return {
    inlineScripts: inline,
    eventHandlers: handlers,
    jsUrls: document.querySelectorAll('a[href^="javascript:" i]').length,
    styleAttrs: document.querySelectorAll('[style]').length,
    styleTags: document.querySelectorAll('style').length,
    nextjs: !!(window.__next_f || window.__NEXT_DATA__ || document.getElementById('__next')),
    links: [...document.querySelectorAll('a[href]')].map((a) => a.href),
    iframes: [...document.querySelectorAll('iframe[src]')].map((f) => f.src),
    forms: [...document.forms].map((f) => f.action),
    framed: window.top !== window,
  };
})()`;

// ---------- policy ----------
const TYPE_TO_DIRECTIVE = {
  Script: 'script-src', Stylesheet: 'style-src', Image: 'img-src', Font: 'font-src', Media: 'media-src',
  TextTrack: 'media-src', XHR: 'connect-src', Fetch: 'connect-src', EventSource: 'connect-src',
  WebSocket: 'connect-src', Ping: 'connect-src', Manifest: 'manifest-src', Prefetch: 'default-src',
};

function sourceFor(url, origin) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol === 'data:') return 'data:';
  if (u.protocol === 'blob:') return 'blob:';
  if (!/^(https?|wss?):$/.test(u.protocol)) return null; // chrome-extension:, about:, etc.
  if (u.origin === origin) return "'self'";
  return `${u.protocol}//${u.host}`;
}

function sha256(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function buildPolicy(pages, origin) {
  const d = new Map(); // directive -> Map(source -> Set(page paths))
  const add = (dir, src, page) => {
    if (!src) return;
    if (!d.has(dir)) d.set(dir, new Map());
    const m = d.get(dir);
    if (!m.has(src)) m.set(src, new Set());
    m.get(src).add(page);
  };
  const inlineScripts = new Map(); // hash -> Set(pages)
  let handlers = 0, jsUrls = 0, styleInline = false, nextjs = false;

  for (const p of pages) {
    if (!p.dom) continue;
    const path = new URL(p.url).pathname;
    for (const r of p.requests) {
      if (r.type === 'Document') {
        if (r.frameId !== p.mainFrameId) add('frame-src', sourceFor(r.url, origin), path);
        continue;
      }
      if (r.frameId !== p.mainFrameId) continue; // a child frame's own resources follow its own policy
      const dir = TYPE_TO_DIRECTIVE[r.type];
      if (dir) add(dir, sourceFor(r.url, origin), path);
    }
    for (const w of p.sockets) add('connect-src', sourceFor(w, origin), path);
    for (const f of p.dom.iframes) add('frame-src', sourceFor(f, origin), path);
    for (const f of p.dom.forms) add('form-action', sourceFor(f, origin), path);
    for (const s of p.dom.inlineScripts) {
      const h = sha256(s);
      if (!inlineScripts.has(h)) inlineScripts.set(h, new Set());
      inlineScripts.get(h).add(path);
    }
    handlers += p.dom.eventHandlers;
    jsUrls += p.dom.jsUrls;
    styleInline ||= p.dom.styleAttrs > 0 || p.dom.styleTags > 0;
    nextjs ||= p.dom.nextjs;
  }

  // Prefetches are same-origin route loads in practice; fold them into self.
  d.delete('default-src');

  const notes = [];
  const scriptExtra = [];
  if (handlers || jsUrls) {
    scriptExtra.push("'unsafe-inline'");
    notes.push(`Pages use ${handlers} inline event handler(s)${jsUrls ? ` and ${jsUrls} javascript: link(s)` : ''}; these need 'unsafe-inline'. Move them into script files to drop it.`);
  } else if (inlineScripts.size && (nextjs || inlineScripts.size > 15)) {
    scriptExtra.push("'unsafe-inline'");
    notes.push(nextjs
      ? `Next.js inlines page data scripts that differ on every page (${inlineScripts.size} unique found), so hashes won't work. 'unsafe-inline' is needed unless you add per-request nonces in middleware (which makes every page render dynamically).`
      : `${inlineScripts.size} different inline scripts; too many to hash reliably, so 'unsafe-inline' is used. Moving them into files allows dropping it.`);
  } else if (inlineScripts.size) {
    scriptExtra.push(...inlineScripts.keys());
    notes.push(`${inlineScripts.size} inline script(s) allowed by hash. If their content changes, the hash must be updated.`);
  }

  const list = (dir, base = []) => [...new Set([...base, ...[...(d.get(dir)?.keys() || [])].sort((a, b) => (a === "'self'" ? -1 : b === "'self'" ? 1 : a.localeCompare(b)))])];
  const directives = [
    ['default-src', ["'self'"]],
    ['script-src', list('script-src', ["'self'"]).concat(scriptExtra)],
    ['style-src', list('style-src', ["'self'"]).concat(styleInline ? ["'unsafe-inline'"] : [])],
    ['img-src', list('img-src', ["'self'"])],
    ['font-src', list('font-src', ["'self'"])],
    ['connect-src', list('connect-src', ["'self'"])],
    ['media-src', d.has('media-src') ? list('media-src') : null],
    ['frame-src', d.has('frame-src') ? list('frame-src') : null],
    ['manifest-src', d.has('manifest-src') && list('manifest-src').some((s) => s !== "'self'") ? list('manifest-src') : null],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', list('form-action', ["'self'"])],
    ['frame-ancestors', ["'none'"]],
  ].filter(([, v]) => v);
  if (origin.startsWith('https:')) directives.push(['upgrade-insecure-requests', []]);
  if (styleInline) notes.push("style-src includes 'unsafe-inline' because pages use style attributes or <style> tags. This is common and low risk.");
  notes.push("frame-ancestors 'none' stops other sites from framing yours. Change it to 'self' or list partners if the site is meant to be embedded.");

  const policy = directives.map(([k, v]) => [k, ...v].join(' ')).join('; ');
  const evidence = Object.fromEntries([...d].map(([dir, m]) => [dir, Object.fromEntries([...m].map(([src, set]) => [src, [...set].slice(0, 5)]))]));
  return { policy, directives, notes, evidence, nextjs };
}

// Add sources for violations seen in the verify pass.
function patchPolicy(directives, violations, origin) {
  let changed = false;
  for (const v of violations) {
    const dir = v.directive === 'script-src-elem' ? 'script-src' : v.directive === 'style-src-elem' || v.directive === 'style-src-attr' ? 'style-src' : v.directive;
    let src = null;
    if (v.blocked === 'inline') src = "'unsafe-inline'";
    else if (v.blocked === 'eval') src = "'unsafe-eval'";
    else if (v.blocked === 'data') src = 'data:';
    else if (v.blocked === 'blob') src = 'blob:';
    else src = sourceFor(v.blocked, origin);
    if (!src) continue;
    let entry = directives.find(([k]) => k === dir);
    if (!entry) { entry = [dir, ["'self'"]]; directives.splice(directives.length - 2, 0, entry); }
    if (!entry[1].includes(src)) { entry[1].push(src); changed = true; }
  }
  return changed;
}

// ---------- crawl ----------
const SKIP_PATH = /\.(pdf|zip|png|jpe?g|gif|webp|svg|ico|mp4|webm|xml|txt|json)$|\/(log-?out|sign-?out)\b/i;

async function crawl(cdp, origin, startPaths, maxPages, mode, policy) {
  const tab = await openTab(cdp, mode, policy);
  const queue = [...startPaths];
  const seen = new Set();
  const pages = [];
  while (queue.length && pages.length < maxPages) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const url = origin + path;
    process.stderr.write(`  ${mode === 'verify' ? 'verify' : 'scan  '} ${path}\n`);
    const r = await tab.visit(url);
    pages.push({ url, ...r, requests: [...tab.state.requests], sockets: [...tab.state.sockets], violations: [...tab.state.violations], mainFrameId: tab.state.mainFrameId });
    for (const link of r.dom?.links || []) {
      let u;
      try { u = new URL(link); } catch { continue; }
      if (u.origin !== origin || SKIP_PATH.test(u.pathname)) continue;
      const p = u.pathname.replace(/\/$/, '') || '/';
      if (!seen.has(p) && !queue.includes(p)) queue.push(p);
    }
  }
  await tab.close();
  if (tab.state.injectErrors.length) throw new Error(`Could not apply the policy to pages: ${tab.state.injectErrors[0]}`);
  return pages;
}

function dedupeViolations(pages) {
  const m = new Map();
  for (const p of pages) for (const v of p.violations) {
    const key = `${v.directive}|${v.blocked}`;
    if (!m.has(key)) m.set(key, { ...v, pages: new Set() });
    m.get(key).pages.add(new URL(p.url).pathname);
  }
  return [...m.values()].map((v) => ({ ...v, pages: [...v.pages] }));
}

// ---------- output ----------
function snippets(policy) {
  const lines = policy.split('; ');
  return {
    nextjs: `// next.config.ts
const contentSecurityPolicy = [
${lines.map((l) => `  ${JSON.stringify(l)},`).join('\n')}
].join("; ");

// inside nextConfig:
async headers() {
  return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] }];
},`,
    amplify: `# amplify.yml (or Amplify console > Custom headers)
customHeaders:
  - pattern: '**/*'
    headers:
      - key: 'Content-Security-Policy'
        value: "${policy.replace(/"/g, '\\"')}"`,
    vercel: JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: policy }] }] }, null, 2),
    netlify: `# public/_headers\n/*\n  Content-Security-Policy: ${policy}`,
  };
}

function toMarkdown(r) {
  const out = [
    `# Content-Security-Policy for ${r.host}`, '',
    `- Pages loaded: ${r.pages.length} (${r.pages.map((p) => `\`${new URL(p.url).pathname}\``).join(', ')})`,
    `- Verified: ${r.verify.violations.length ? `${r.verify.violations.length} violation(s) remain` : 'no violations with the policy applied'} (${r.verify.rounds} round(s))`,
    '',
    '## Policy', '', '```', r.policy.split('; ').join(';\n'), '```', '',
  ];
  if (r.notes.length) { out.push('## Notes', ''); for (const n of r.notes) out.push(`- ${n}`); out.push(''); }
  out.push('## Where each source came from', '', '| Directive | Source | Seen on |', '|---|---|---|');
  for (const [dir, m] of Object.entries(r.evidence)) for (const [src, pages] of Object.entries(m)) out.push(`| ${dir} | \`${src}\` | ${pages.join(', ')} |`);
  out.push('');
  if (r.verify.violations.length) {
    out.push('## Still blocked', '', '| Directive | Blocked | Pages | Source |', '|---|---|---|---|');
    for (const v of r.verify.violations) out.push(`| ${v.directive} | \`${v.blocked}\` | ${v.pages.join(', ')} | ${v.source ? `${v.source}:${v.line}` : ''} |`);
    out.push('');
  }
  out.push('## Not covered', '',
    '- Pages behind sign-in, and anything that only loads after a click (chat widgets, video players, payment forms). Open those by hand with the policy in report-only mode and check the console.',
    '- Browser extensions inject their own requests; those are ignored.', '');
  out.push('## Rollout', '',
    '1. Ship it as `Content-Security-Policy-Report-Only` first and watch the browser console on key pages (or add a `report-to` endpoint).',
    '2. After a few days with no unexpected reports, switch the header name to `Content-Security-Policy`.', '');
  const s = snippets(r.policy);
  out.push('## Config', '', '### Next.js', '', '```ts', s.nextjs, '```', '', '### AWS Amplify', '', '```yaml', s.amplify, '```', '',
    '### Vercel (`vercel.json`)', '', '```json', s.vercel, '```', '', '### Netlify', '', '```', s.netlify, '```', '');
  return out.join('\n');
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) {
    console.log('Usage: node csp.mjs https://your-site.com [--pages 12] [--path /pricing] [--out dir] [--verify "<policy>"]');
    process.exit(args.help ? 0 : 2);
  }
  if (typeof WebSocket === 'undefined') { console.error('Node 22 or newer is required.'); process.exit(2); }
  const target = new URL(args.target.includes('://') ? args.target : `https://${args.target}`);
  const origin = target.origin;
  const startPaths = [target.pathname.replace(/\/$/, '') || '/', ...(args.paths || [])];

  const chrome = await launchChrome();
  const cdp = await CDP.connect(chrome.wsUrl);
  try {
    let result;
    if (args.verify) {
      console.error(`Checking a policy on ${origin}`);
      const pages = await crawl(cdp, origin, startPaths, args.pages, 'verify', args.verify);
      const violations = dedupeViolations(pages);
      result = { host: target.host, pages, policy: args.verify, notes: [], evidence: {}, verify: { rounds: 1, violations } };
    } else {
      console.error(`Recording what ${origin} loads (up to ${args.pages} pages)`);
      const pages = await crawl(cdp, origin, startPaths, args.pages, 'discover');
      const built = buildPolicy(pages, origin);
      const paths = pages.filter((p) => p.dom).map((p) => new URL(p.url).pathname);
      let rounds = 0, violations = [], policy = built.policy;
      // Verify, add anything the first pass missed (dynamic inline code, eval), verify again.
      for (; rounds < 3; ) {
        rounds++;
        const vpages = await crawl(cdp, origin, paths, paths.length, 'verify', policy);
        violations = dedupeViolations(vpages);
        if (!violations.length || !patchPolicy(built.directives, violations, origin)) break;
        policy = built.directives.map(([k, v]) => [k, ...v].join(' ')).join('; ');
        built.notes.push(`Added after round ${rounds}: ${violations.map((v) => `${v.directive} ${v.blocked}`).join(', ')}.`);
      }
      result = { host: target.host, pages, policy, notes: built.notes, evidence: built.evidence, verify: { rounds, violations } };
    }

    const out = args.out || `site-hardening-csp-${target.hostname}-${new Date().toISOString().slice(0, 10)}`;
    await mkdir(out, { recursive: true });
    const json = { version: VERSION, host: result.host, policy: result.policy, notes: result.notes, evidence: result.evidence,
      verify: result.verify, pages: result.pages.map((p) => ({ url: p.url, error: p.error, requests: p.requests.length })) };
    await writeFile(join(out, 'csp.json'), JSON.stringify(json, null, 2));
    await writeFile(join(out, 'csp.md'), toMarkdown(result));
    console.log(result.policy);
    console.error(`\n${result.verify.violations.length ? `${result.verify.violations.length} violation(s) remain` : 'Verified: nothing blocked'}. Report: ${join(out, 'csp.md')}`);
    process.exitCode = result.verify.violations.length ? 1 : 0;
  } finally {
    cdp.close();
    await chrome.close();
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(2); });
