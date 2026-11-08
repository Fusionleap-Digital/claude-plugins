#!/usr/bin/env node
// Post-deploy smoke test: key routes answer, show the text they should, keep
// their security headers, forms still render, and sitemap and robots are
// sane. GET only, 2 requests per second by default. Zero dependencies,
// Node 18+.
//
//   node smoke.mjs https://example.com [--route /pricing] [--expect "/::Welcome"]
//                  [--form /contact] [--sitemap-pages 8] [--baseline old/report.json]
//                  [--rate 2] [--out dir]

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs, siteUrl, decodeEntities, createHttp, finding, sortFindings, summaryLine, hasBlocking, findingsTable, mdTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION } from '../../../lib/common.mjs';

const USAGE = 'Usage: node smoke.mjs https://example.com [--route /a,/b] [--expect "/path::text"] [--form /contact] [--sitemap-pages 8] [--baseline report.json] [--rate 2] [--out dir]';

// A presence check so a deploy that drops headers gets caught. The full
// header review (values, leaks, HTTPS redirect) is the site-hardening probe.
export const HEADER_CHECKS = [
  ['strict-transport-security', 'Strict-Transport-Security', (h) => !!h.get('strict-transport-security')],
  ['content-security-policy', 'Content-Security-Policy', (h) => !!h.get('content-security-policy')],
  ['x-content-type-options', 'X-Content-Type-Options', (h) => (h.get('x-content-type-options') || '').toLowerCase() === 'nosniff'],
  ['framing', 'X-Frame-Options or CSP frame-ancestors', (h) => !!h.get('x-frame-options') || /frame-ancestors/i.test(h.get('content-security-policy') || '')],
  ['referrer-policy', 'Referrer-Policy', (h) => !!h.get('referrer-policy')],
];

export function headerPresence(headers, isHttps = true) {
  return HEADER_CHECKS.filter(([k]) => isHttps || k !== 'strict-transport-security').map(([key, label, ok]) => ({ key, label, present: ok(headers) }));
}

const ERROR_MARKERS = [
  [/Application error: a (client|server)-side exception has occurred/i, 'Next.js application error'],
  [/id="__next_error__"/, 'Next.js error page'],
  [/Internal Server Error/i, 'Internal Server Error text'],
  [/<title>\s*(404|500)\b/i, 'error page title'],
];

export function formsIn(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => {
    const fields = [...m[2].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
      .map((f) => ({ tag: f[1].toLowerCase(), type: f[2].match(/\btype="([^"]*)"/i)?.[1] || (f[1].toLowerCase() === 'input' ? 'text' : f[1].toLowerCase()), name: f[2].match(/\bname="([^"]*)"/i)?.[1] || f[2].match(/\bid="([^"]*)"/i)?.[1] || '' }))
      .filter((f) => !['hidden', 'submit', 'button'].includes(f.type) || f.name);
    return { action: m[1].match(/\baction="([^"]*)"/i)?.[1] || null, method: (m[1].match(/\bmethod="([^"]*)"/i)?.[1] || 'get').toLowerCase(), fields, hasSubmit: /type="submit"|<button(?![^>]*type="button")/i.test(m[2]) };
  });
}

function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const [k, ...rest] = line.split(':');
    const key = k?.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (!key) continue;
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ type: key, path: value });
    }
  }
  return { groups, sitemaps: [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]) };
}

export async function runSmoke(site, opts = {}) {
  const origin = site.origin;
  const http = opts.http || createHttp({ rate: opts.rate || 2 });
  const findings = [];
  const results = [];
  const expects = new Map();
  for (const e of opts.expect || []) {
    const [p, text] = e.split('::');
    if (!expects.has(p)) expects.set(p, []);
    expects.get(p).push(text);
  }

  // robots.txt
  const robots = await http.get(origin + '/robots.txt');
  let robotsInfo = { sitemaps: [] };
  if (robots.status !== 200) findings.push(finding('medium', 'robots', `robots.txt returned ${robots.status || robots.error}.`, { where: '/robots.txt' }));
  else {
    robotsInfo = parseRobots(robots.body);
    const star = robotsInfo.groups.find((g) => g.agents.includes('*'));
    if (star?.rules.some((r) => r.type === 'disallow' && r.path === '/') && !star.rules.some((r) => r.type === 'allow' && r.path === '/')) {
      findings.push(finding('critical', 'robots-blocks-all', 'robots.txt tells every crawler to stay out (User-agent: * / Disallow: /). Often a staging robots.txt shipped to production.', { where: '/robots.txt' }));
    } else findings.push(finding('pass', 'robots', `robots.txt is served${robotsInfo.sitemaps.length ? ' and points to a sitemap' : ''}.`, { where: '/robots.txt' }));
    if (!robotsInfo.sitemaps.length) findings.push(finding('low', 'robots-no-sitemap', 'robots.txt has no Sitemap: line.', { where: '/robots.txt' }));
  }

  // sitemap
  const sitemapUrl = robotsInfo.sitemaps[0] || origin + '/sitemap.xml';
  const sm = await http.get(sitemapUrl);
  let sitemapPaths = [];
  if (sm.status !== 200 || !/<(urlset|sitemapindex)\b/.test(sm.body)) {
    findings.push(finding('medium', 'sitemap', `Sitemap at ${sitemapUrl} returned ${sm.status || sm.error}${sm.status === 200 ? ' but is not a sitemap XML file' : ''}.`, { where: new URL(sitemapUrl).pathname }));
  } else {
    const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const foreign = locs.filter((l) => { try { return new URL(l).host.replace(/^www\./, '') !== site.host.replace(/^www\./, ''); } catch { return true; } });
    if (foreign.length) findings.push(finding('high', 'sitemap-wrong-host', `${foreign.length} of ${locs.length} sitemap URLs point at another host (for example ${foreign[0]}). Usually NEXT_PUBLIC_SITE_URL (or similar) is set to a preview or default host domain.`, { where: new URL(sitemapUrl).pathname }));
    const plain = locs.filter((l) => l.startsWith('http://') && site.protocol === 'https:');
    if (plain.length) findings.push(finding('medium', 'sitemap-http', `${plain.length} sitemap URLs use http://.`, { where: new URL(sitemapUrl).pathname }));
    if (!locs.length) findings.push(finding('medium', 'sitemap-empty', 'Sitemap has no <loc> entries.', { where: new URL(sitemapUrl).pathname }));
    else findings.push(finding('pass', 'sitemap', `Sitemap lists ${locs.length} URLs.`, { where: new URL(sitemapUrl).pathname }));
    sitemapPaths = locs.filter((l) => !foreign.includes(l)).map((l) => new URL(l).pathname).filter((p) => !p.endsWith('.xml'));
  }

  // routes: always /, then the user's, then a sample from the sitemap
  const routes = [...new Set(['/', ...(opts.route || []), ...expects.keys(), ...(opts.form || []), ...sitemapPaths.slice(0, opts.sitemapPages ?? 8)])];
  let home = null;
  for (const path of routes) {
    const r = await http.get(origin + path);
    if (path === '/') home = r;
    const title = decodeEntities(r.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '');
    const forms = formsIn(r.body);
    const row = { path, status: r.status, ms: r.ms, finalUrl: r.url !== origin + path ? r.url : null, title: title.slice(0, 80), forms: forms.length, error: r.error || null };
    results.push(row);
    if (r.status !== 200) {
      findings.push(finding(path === '/' ? 'critical' : 'high', 'route-status', `${path} returned ${r.status || r.error}.`, { where: path }));
      continue;
    }
    const marker = ERROR_MARKERS.find(([re]) => re.test(r.body));
    if (marker) findings.push(finding('high', 'route-error-page', `${path} returned 200 but shows a ${marker[1]}.`, { where: path }));
    if (/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(r.body) && (path === '/' || sitemapPaths.includes(path))) {
      findings.push(finding('high', 'route-noindex', `${path} is in the sitemap but has a noindex robots meta tag, so search engines will drop it.`, { where: path }));
    }
    if (!title) findings.push(finding('low', 'route-no-title', `${path} has no <title>.`, { where: path }));
    for (const text of expects.get(path) || []) {
      if (!r.body.includes(text)) findings.push(finding('high', 'route-expected-text', `${path} doesn't contain "${text}".`, { where: path }));
      else findings.push(finding('pass', 'route-expected-text', `${path} contains "${text}".`, { where: path }));
    }
    if ((opts.form || []).includes(path)) {
      if (!forms.length) findings.push(finding('high', 'form-missing', `${path} should have a form, but no <form> was found in the HTML. If the form renders only in the browser, check it by hand.`, { where: path }));
      else {
        const f = forms[0];
        findings.push(finding(f.hasSubmit ? 'pass' : 'medium', 'form', `${path} has a form with ${f.fields.length} fields (${f.fields.map((x) => x.name || x.type).join(', ')})${f.hasSubmit ? ' and a submit button' : ', but no submit button was found'}.`, { where: path, fields: f.fields }));
      }
    }
    if (r.ms > 3000) findings.push(finding('low', 'route-slow', `${path} took ${r.ms} ms.`, { where: path }));
  }

  // headers on the home page
  let headers = [];
  if (home?.status === 200) {
    headers = headerPresence(home.headers, site.protocol === 'https:');
    const missing = headers.filter((h) => !h.present);
    if (missing.length) findings.push(finding('high', 'security-headers', `Home page is missing: ${missing.map((h) => h.label).join(', ')}. If these were there before this deploy, the header config was lost (next.config headers, amplify.yml customHeaders, vercel.json, _headers). Run the site-hardening probe for the full header check.`, { where: '/' }));
    else findings.push(finding('pass', 'security-headers', 'Home page has HSTS, CSP, nosniff, framing protection and Referrer-Policy.', { where: '/' }));
  }

  // missing pages should 404
  const missingPath = `/site-ops-missing-${randomBytes(4).toString('hex')}`;
  const nf = await http.get(origin + missingPath);
  if (nf.status === 200) findings.push(finding('low', 'soft-404', 'A page that doesn\'t exist returns 200. Real 404s keep broken links out of search results and make monitoring honest.', { where: missingPath }));
  else if (nf.status >= 500) findings.push(finding('high', 'not-found-crash', `A missing page returns ${nf.status}; the not-found page is crashing.`, { where: missingPath }));

  // compare with a run from before the deploy
  if (opts.baseline) {
    const base = JSON.parse(await readFile(opts.baseline, 'utf8'));
    for (const b of base.routes || []) {
      const now = results.find((r) => r.path === b.path);
      if (now && now.status !== b.status) findings.push(finding(now.status === 200 ? 'info' : 'high', 'changed-since-baseline', `${b.path} was ${b.status}, now ${now.status}.`, { where: b.path }));
    }
    const baseHeaders = new Set((base.headers || []).filter((h) => h.present).map((h) => h.key));
    for (const h of headers) if (baseHeaders.has(h.key) && !h.present) findings.push(finding('high', 'header-lost', `${h.label} was present before and is gone now.`, { where: '/' }));
  }

  sortFindings(findings);
  return {
    meta: { tool: 'smoke', version: VERSION, site: origin, checked: new Date().toISOString(), requests: http.count },
    routes: results,
    headers,
    findings,
    summary: summaryLine(findings),
  };
}

export function toMarkdown(r) {
  const problems = r.findings.filter((f) => f.severity !== 'pass');
  return [
    `# Smoke test: ${r.meta.site}`,
    '',
    `- Checked: ${r.meta.checked} (${r.meta.requests} GET requests)`,
    `- Result: ${r.summary}`,
    '',
    '## Routes',
    '',
    mdTable(['Path', 'Status', 'Time (ms)', 'Title', 'Forms', 'Ended at'], r.routes.map((x) => [x.path, x.status || x.error, x.ms, x.title, x.forms, x.finalUrl || ''])),
    '## Security headers (home page)',
    '',
    r.headers.length ? mdTable(['Header', 'Present'], r.headers.map((h) => [h.label, h.present ? 'yes' : 'NO'])) : 'Not checked (home page did not load).\n',
    '## Problems',
    '',
    problems.length ? findingsTable(problems) : 'None.\n',
    '## Passed',
    '',
    findingsTable(r.findings.filter((f) => f.severity === 'pass')),
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { route: 'list', expect: 'list', form: 'list', sitemapPages: 'number', baseline: 'string', rate: 'number', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    const site = siteUrl(args._[0]);
    if (!site) throw usageError('Give the site URL.');
    const report = await runSmoke(site, args);
    const path = await writeReport(args.out || defaultOut('smoke', site.hostname), report, toMarkdown(report));
    console.error(`Done: ${report.summary}. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}
