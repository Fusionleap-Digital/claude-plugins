#!/usr/bin/env node
// Weekly ops digest: one report on whether the site is up, when its TLS
// certificate and domain expire, whether its headers, email DNS, deploy
// basics and AI visibility still hold, what npm audit says about the repo,
// and (optionally) Lighthouse scores and an analytics summary. Read-only.
// Zero dependencies, Node 18+.
//
//   node digest.mjs https://example.com [--repo ./site] [--hardening report.json]
//                   [--log access.log] [--include dir/report.json] [--lighthouse]
//                   [--analytics ./analytics.mjs] [--skip email,smoke,ai] [--out dir]

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:tls';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, siteUrl, createHttp, finding, sortFindings, summaryLine, hasBlocking, findingsTable, mdTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION, UA, SEVERITY_ORDER } from '../../../lib/common.mjs';
import { checkEmail } from '../../email-deliverability/scripts/email-dns.mjs';
import { runSmoke, headerPresence } from '../../deploy-check/scripts/smoke.mjs';
import { checkAiVisibility } from '../../ai-visibility/scripts/ai-visibility.mjs';
import { triage } from '../../bot-triage/scripts/bot-verify.mjs';

const USAGE = 'Usage: node digest.mjs https://example.com [--repo dir] [--hardening report.json] [--log access.log] [--include report.json] [--lighthouse] [--analytics module.mjs] [--skip email,smoke,ai] [--out dir]';

const daysUntil = (d) => Math.floor((new Date(d).getTime() - Date.now()) / 86_400_000);

function run(cmd, args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err && typeof err.code !== 'number' ? String(err.code || err.signal || err) : null }));
  });
}

// ---------- uptime ----------
async function uptime(http, site, opts) {
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push(await http.get(site.origin + '/'));
  const ok = samples.filter((s) => s.status === 200);
  const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)] ?? null;
  const checks = [];
  for (const u of opts.statusUrl || []) {
    const r = await http.get(new URL(u, site.origin).href);
    checks.push({ url: u, status: r.status || r.error, ms: r.ms });
  }
  const findings = [];
  if (!ok.length) findings.push(finding('critical', 'uptime', `The home page didn't load in 3 tries (${samples.map((s) => s.status || s.error).join(', ')}).`, { where: '/' }));
  else if (ok.length < 3) findings.push(finding('high', 'uptime', `The home page failed ${3 - ok.length} of 3 tries (${samples.map((s) => s.status || s.error).join(', ')}).`, { where: '/' }));
  else findings.push(finding('pass', 'uptime', `Home page up, median ${median} ms over 3 requests.`, { where: '/' }));
  if (median > 2500) findings.push(finding('medium', 'latency', `Home page median response time is ${median} ms.`, { where: '/' }));
  for (const c of checks) if (c.status !== 200) findings.push(finding('high', 'status-url', `${c.url} returned ${c.status}.`, { where: c.url }));
  return { data: { status: samples.map((s) => s.status || s.error), medianMs: median, checks, headers: ok[0] ? headerPresence(ok[0].headers, site.protocol === 'https:') : [] }, findings };
}

// ---------- TLS ----------
export function tlsCert(host, port = 443, timeoutMs = 10_000) {
  return new Promise((done) => {
    const sock = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = sock.getPeerCertificate();
      const authorized = sock.authorized;
      const authError = sock.authorizationError ? String(sock.authorizationError) : null;
      sock.end();
      done({ validTo: c.valid_to, validFrom: c.valid_from, issuer: c.issuer?.O || c.issuer?.CN, subject: c.subject?.CN, san: (c.subjectaltname || '').replace(/DNS:/g, '').split(', ').filter(Boolean), authorized, authError, protocol: sock.getProtocol?.() });
    });
    sock.on('error', (e) => done({ error: e.code || String(e) }));
    sock.on('timeout', () => { sock.destroy(); done({ error: 'timeout' }); });
  });
}

async function tls(site, opts) {
  const hosts = [...new Set([site.hostname, ...(opts.tlsHost || [])])];
  const findings = [];
  const data = [];
  for (const h of hosts) {
    const c = await tlsCert(h);
    if (c.error) { findings.push(finding('high', 'tls', `Couldn't open TLS to ${h} (${c.error}).`, { where: h })); continue; }
    const days = daysUntil(c.validTo);
    data.push({ host: h, expires: new Date(c.validTo).toISOString().slice(0, 10), days, issuer: c.issuer, valid: c.authorized, protocol: c.protocol });
    if (!c.authorized) findings.push(finding('critical', 'tls-invalid', `${h} certificate isn't trusted: ${c.authError}.`, { where: h }));
    if (days < 7) findings.push(finding('critical', 'tls-expiry', `${h} certificate expires in ${days} days (${c.validTo}).`, { where: h }));
    else if (days < 14) findings.push(finding('high', 'tls-expiry', `${h} certificate expires in ${days} days. Managed certificates (Amplify, Vercel, Netlify) renew about 30 days out, so a renewal is stuck: check the DNS validation record.`, { where: h }));
    else if (days < 30) findings.push(finding('medium', 'tls-expiry', `${h} certificate expires in ${days} days. Should renew on its own soon; check again next week.`, { where: h }));
    else findings.push(finding('pass', 'tls', `${h} certificate valid for ${days} more days (${c.issuer}).`, { where: h }));
  }
  return { data, findings };
}

// ---------- domain expiry (RDAP) ----------
// RDAP servers for TLDs missing from IANA's bootstrap file.
const RDAP_EXTRA = { io: 'https://rdap.identitydigital.services/rdap/', ai: 'https://rdap.identitydigital.services/rdap/', sh: 'https://rdap.identitydigital.services/rdap/', ac: 'https://rdap.identitydigital.services/rdap/' };
const TWO_LEVEL = /\.(co|com|org|net|gov|ac|edu)\.(uk|au|nz|za|in|jp|br|mx|sg)$/;

export function registrableDomain(host) {
  const parts = host.replace(/^www\./, '').split('.');
  return parts.slice(TWO_LEVEL.test(host) ? -3 : -2).join('.');
}

async function rdapExpiry(domain) {
  const tld = domain.split('.').pop();
  let base = null;
  try {
    const boot = await (await fetch('https://data.iana.org/rdap/dns.json', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })).json();
    base = boot.services.find(([tlds]) => tlds.includes(tld))?.[1]?.[0] || null;
  } catch {}
  base ||= RDAP_EXTRA[tld];
  if (base) {
    try {
      const res = await fetch(new URL(`domain/${domain}`, base.endsWith('/') ? base : base + '/'), { headers: { 'user-agent': UA, accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const j = await res.json();
        const exp = j.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
        const registrar = j.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3];
        if (exp) return { expires: exp, registrar, source: 'RDAP', status: j.status };
      }
    } catch {}
  }
  // Last resort: the whois command, if installed.
  const w = await run('whois', [domain], { timeout: 20_000 });
  const m = w.stdout.match(/(Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|paid-till):\s*(\S+)/i);
  if (m) return { expires: m[2], source: 'whois' };
  return { error: base ? 'no expiration date in RDAP or whois' : `no RDAP server for .${tld} and whois gave no date` };
}

async function domainExpiry(site) {
  const domain = registrableDomain(site.hostname);
  const r = await rdapExpiry(domain);
  if (r.error) return { data: { domain, ...r }, findings: [finding('review', 'domain-expiry', `Couldn't read the expiry date for ${domain} (${r.error}). Check at the registrar.`, { where: domain })] };
  const days = daysUntil(r.expires);
  const f = days < 14 ? finding('critical', 'domain-expiry', `${domain} expires in ${days} days (${r.expires.slice(0, 10)}). Renew now.`, { where: domain })
    : days < 45 ? finding('high', 'domain-expiry', `${domain} expires in ${days} days (${r.expires.slice(0, 10)}). Check auto-renew is on and the card on file is current.`, { where: domain })
      : finding('pass', 'domain-expiry', `${domain} registered until ${r.expires.slice(0, 10)} (${days} days, via ${r.source}).`, { where: domain });
  const extra = [];
  if (r.status && !r.status.some((s) => /transfer prohibited/i.test(s))) extra.push(finding('low', 'domain-lock', `${domain} has no transfer lock (clientTransferProhibited). Turn on the registrar lock.`, { where: domain }));
  return { data: { domain, ...r, days }, findings: [f, ...extra] };
}

// ---------- security headers ----------
// The site-hardening probe owns the full header check. If its report.json is
// given, use it; otherwise fall back to a presence check of the home page.
async function headers(opts, home) {
  if (opts.hardening) {
    const rep = JSON.parse(await readFile(opts.hardening, 'utf8'));
    const hs = (rep.findings || []).filter((f) => /^header-|^https-redirect/.test(f.check));
    const age = daysUntil(rep.meta?.started || rep.meta?.finished || Date.now()) * -1;
    const findings = hs.map((f) => finding(f.severity, f.check, `${f.detail} (from the site-hardening probe, ${age} days ago)`, { where: f.path }));
    if (age > 31) findings.push(finding('low', 'hardening-stale', `The site-hardening report is ${age} days old. Run the probe again.`));
    if (!hs.length) findings.push(finding('pass', 'security-headers', `site-hardening probe (${age} days ago) found no header problems.`));
    const exposed = (rep.findings || []).filter((f) => (f.result === 'fail') && ['critical', 'high'].includes(f.severity) && !/^header-/.test(f.check));
    if (exposed.length) findings.push(finding('critical', 'hardening-open', `The site-hardening report still lists ${exposed.length} critical/high exposures. Fix them first.`));
    return { data: { source: `site-hardening report ${opts.hardening}`, probeDate: rep.meta?.started }, findings };
  }
  const missing = home.filter((h) => !h.present);
  return {
    data: { source: 'home page presence check (run the site-hardening probe for the full check)', headers: home },
    findings: [missing.length
      ? finding('high', 'security-headers', `Home page is missing: ${missing.map((h) => h.label).join(', ')}. Run the site-hardening probe for the full header check and fixes.`, { where: '/' })
      : finding('pass', 'security-headers', 'HSTS, CSP, nosniff, framing protection and Referrer-Policy are present. For values and leaks, run the site-hardening probe and pass --hardening.', { where: '/' })],
  };
}

// ---------- npm audit ----------
async function npmAudit(repo) {
  const lock = await readFile(join(repo, 'package-lock.json'), 'utf8').catch(() => null);
  if (!lock) return { data: { skipped: 'no package-lock.json' }, findings: [finding('review', 'npm-audit', 'No package-lock.json in the repo, so npm audit was skipped.')] };
  const all = await run('npm', ['audit', '--json'], { cwd: repo });
  const prod = await run('npm', ['audit', '--json', '--omit=dev'], { cwd: repo });
  const parse = (r) => { try { return JSON.parse(r.stdout).metadata?.vulnerabilities || null; } catch { return null; } };
  const a = parse(all);
  const p = parse(prod);
  if (!a) return { data: { error: (all.stderr || all.error || '').trim().split('\n').pop() }, findings: [finding('review', 'npm-audit', `npm audit didn't run: ${(all.stderr || all.error || 'no output').trim().split('\n').pop()}`)] };
  let top = [];
  try {
    top = Object.values(JSON.parse(prod.stdout).vulnerabilities || {}).filter((v) => ['critical', 'high'].includes(v.severity)).slice(0, 8)
      .map((v) => `${v.name} (${v.severity}${v.fixAvailable ? ', fix available' : ''})`);
  } catch {}
  const findings = [];
  const counts = `${p?.critical || 0} critical and ${p?.high || 0} high`;
  if (p?.critical || p?.high) findings.push(finding(p.critical ? 'critical' : 'high', 'npm-audit', `Production dependencies have ${counts} vulnerabilities: ${top.join(', ')}. Update them (npm audit fix, or a version bump for breaking fixes), build, test and redeploy.`));
  else if (p?.moderate) findings.push(finding('low', 'npm-audit', `${p.moderate} moderate vulnerabilities in production dependencies.`));
  const devOnly = (a.critical + a.high) - ((p?.critical || 0) + (p?.high || 0));
  if (devOnly > 0) findings.push(finding('info', 'npm-audit-dev', `${devOnly} critical/high vulnerabilities in dev-only dependencies (not shipped to the site).`));
  if (!findings.length || !(p?.critical || p?.high)) findings.push(finding('pass', 'npm-audit', `No critical or high vulnerabilities in production dependencies (${a.total} total across all dependencies).`));
  return { data: { all: a, production: p }, findings };
}

// ---------- Lighthouse (optional) ----------
async function lighthouse(site) {
  const dir = await mkdtemp(join(tmpdir(), 'site-ops-lh-'));
  try {
    const out = join(dir, 'lh.json');
    const r = await run('npx', ['--yes', 'lighthouse', site.origin + '/', '--output=json', `--output-path=${out}`, '--quiet', '--chrome-flags=--headless=new',
      '--only-categories=performance,accessibility,best-practices,seo'], { timeout: 240_000 });
    const j = JSON.parse(await readFile(out, 'utf8').catch(() => 'null'));
    if (!j) return { data: { error: (r.stderr || r.error || 'no output').trim().split('\n').pop() }, findings: [finding('review', 'lighthouse', `Lighthouse didn't run: ${(r.stderr || r.error || 'no output').trim().split('\n').pop().slice(0, 160)}. It needs Chrome installed.`)] };
    const scores = Object.fromEntries(Object.entries(j.categories).map(([k, v]) => [k, Math.round(v.score * 100)]));
    const audits = j.audits || {};
    const metrics = { LCP: audits['largest-contentful-paint']?.displayValue, CLS: audits['cumulative-layout-shift']?.displayValue, TBT: audits['total-blocking-time']?.displayValue };
    const low = Object.entries(scores).filter(([, s]) => s < 70);
    const findings = low.map(([k, s]) => finding(s < 50 ? 'high' : 'medium', 'lighthouse', `Lighthouse ${k} score is ${s} (mobile).`));
    if (!low.length) findings.push(finding('pass', 'lighthouse', `Lighthouse (mobile): ${Object.entries(scores).map(([k, s]) => `${k} ${s}`).join(', ')}.`));
    return { data: { scores, metrics, version: j.lighthouseVersion }, findings };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- analytics (extension point) ----------
// A module whose default export is `async ({ site, since, until }) =>
// ({ title, summary: [lines], metrics: {name: value}, findings: [] })`.
// See analytics-example.mjs. A WysLeap module will plug in here.
async function analytics(modulePath, site) {
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 86_400_000);
  const r = await mod.default({ site: site.origin, since: since.toISOString(), until: until.toISOString() });
  return { data: { title: r.title || 'Analytics', summary: r.summary || [], metrics: r.metrics || {} }, findings: (r.findings || []).map((f) => finding(f.severity || 'info', f.check || 'analytics', f.detail, f.where ? { where: f.where } : {})) };
}

// ---------- other site-ops reports ----------
async function included(paths) {
  const out = [];
  for (const p of paths) {
    const file = p.endsWith('.json') ? p : join(p, 'report.json');
    const rep = JSON.parse(await readFile(file, 'utf8'));
    out.push({ file, tool: rep.meta?.tool || 'report', checked: rep.meta?.checked || rep.meta?.started, summary: rep.summary || '', findings: (rep.findings || []).filter((f) => !['pass', 'info'].includes(f.severity)) });
  }
  return out;
}

// ---------- main ----------
export async function digest(site, opts = {}) {
  const http = createHttp({ rate: opts.rate || 2 });
  const skip = new Set(opts.skip || []);
  const sections = [];
  const add = async (key, title, fn) => {
    try {
      const r = await fn();
      sections.push({ key, title, ...r });
    } catch (err) {
      sections.push({ key, title, data: { error: String(err.message || err) }, findings: [finding('review', key, `Section failed: ${String(err.message || err).slice(0, 200)}`)] });
    }
  };
  const fromReport = (r) => ({ data: { summary: r.summary }, findings: r.findings });

  let home = [];
  await add('uptime', 'Uptime and status', async () => { const r = await uptime(http, site, opts); home = r.data.headers; return r; });
  await add('tls', 'TLS certificate', () => tls(site, opts));
  await add('domain', 'Domain registration', () => domainExpiry(site));
  await add('headers', 'Security headers', () => headers(opts, home));
  if (!skip.has('smoke')) await add('smoke', 'Routes, sitemap and robots', async () => fromReport(await runSmoke(site, { http, sitemapPages: 5, form: opts.form })));
  if (!skip.has('email')) await add('email', 'Email DNS', async () => fromReport(await checkEmail(registrableDomain(site.hostname), { selector: opts.selector })));
  if (!skip.has('ai')) await add('ai', 'AI visibility', async () => fromReport(await checkAiVisibility(site, { http })));
  if (opts.log?.length) await add('bots', 'Bot traffic', async () => {
    const r = await triage((await Promise.all(opts.log.map((f) => readFile(f, 'utf8')))).join('\n'), {});
    return { data: { claimed: r.meta.claimed, fake: r.meta.fake, genuine: r.meta.genuine, topFake: r.suspects.slice(0, 5).map((s) => `${s.ip} (${s.cloud || s.ptr || '?'}, ${s.requests} req)`) }, findings: r.findings };
  });
  if (opts.repo) await add('npm', 'npm audit', () => npmAudit(opts.repo));
  if (opts.lighthouse) await add('lighthouse', 'Lighthouse', () => lighthouse(site));
  if (opts.analytics) await add('analytics', 'Analytics', () => analytics(opts.analytics, site));
  if (opts.include?.length) await add('included', 'Other reports', async () => {
    const reps = await included(opts.include);
    return { data: { reports: reps.map((r) => ({ tool: r.tool, checked: r.checked, summary: r.summary, file: r.file })) }, findings: reps.flatMap((r) => r.findings.map((f) => ({ ...f, check: `${r.tool}: ${f.check}` }))) };
  });

  const all = sortFindings(sections.flatMap((s) => s.findings.map((f) => ({ ...f, section: s.title }))));
  return {
    meta: { tool: 'ops-digest', version: VERSION, site: site.origin, checked: new Date().toISOString(), requests: http.count },
    sections: sections.map((s) => ({ key: s.key, title: s.title, summary: summaryLine(s.findings), data: s.data, findings: s.findings })),
    findings: all,
    summary: summaryLine(all),
  };
}

function toMarkdown(r) {
  const attention = r.findings.filter((f) => SEVERITY_ORDER.indexOf(f.severity) <= SEVERITY_ORDER.indexOf('low'));
  const lines = [
    `# Ops digest: ${r.meta.site}`,
    '',
    `- Run: ${r.meta.checked}`,
    `- Result: ${r.summary}`,
    '',
    '## Needs attention',
    '',
    attention.length ? mdTable(['Severity', 'Section', 'Detail'], attention.map((f) => [f.severity, f.section, f.detail])) : 'Nothing this week.\n',
    '## At a glance',
    '',
    mdTable(['Section', 'Result'], r.sections.map((s) => [s.title, s.summary])),
  ];
  for (const s of r.sections) {
    lines.push(`## ${s.title}`, '');
    const d = s.data || {};
    if (s.key === 'tls' && Array.isArray(d)) lines.push(mdTable(['Host', 'Expires', 'Days left', 'Issuer'], d.map((c) => [c.host, c.expires, c.days, c.issuer])));
    else if (s.key === 'domain' && d.expires) lines.push(`${d.domain}: expires ${String(d.expires).slice(0, 10)} (${d.days} days)${d.registrar ? `, registrar ${d.registrar}` : ''}, source ${d.source}.`, '');
    else if (s.key === 'npm' && d.production) lines.push(`Production dependencies: ${['critical', 'high', 'moderate', 'low'].map((k) => `${d.production[k] || 0} ${k}`).join(', ')}. All dependencies: ${d.all.total} total.`, '');
    else if (s.key === 'lighthouse' && d.scores) lines.push(`Scores (mobile): ${Object.entries(d.scores).map(([k, v]) => `${k} ${v}`).join(', ')}. LCP ${d.metrics.LCP}, CLS ${d.metrics.CLS}, TBT ${d.metrics.TBT}.`, '');
    else if (s.key === 'bots' && d.claimed !== undefined) lines.push(`${d.claimed} crawler requests: ${d.genuine} genuine, ${d.fake} fake.${d.topFake.length ? ` Top unverified: ${d.topFake.join('; ')}.` : ''}`, '');
    else if (s.key === 'analytics') lines.push(...(d.summary || []).map((x) => `- ${x}`), '', mdTable(['Metric', 'Value'], Object.entries(d.metrics || {})));
    else if (s.key === 'headers') lines.push(`Source: ${d.source}.`, '');
    else if (s.key === 'uptime') lines.push(`Status of 3 requests: ${d.status?.join(', ')}; median ${d.medianMs} ms.`, '');
    const shown = s.findings.filter((f) => f.severity !== 'pass');
    lines.push(shown.length ? findingsTable(shown) : `All checks passed.${s.findings.length ? ' ' + s.findings.map((f) => f.detail).join(' ') : ''}\n`);
  }
  lines.push('## Not covered', '', '- Pages behind sign-in, and anything the checks above don\'t list.', '- The full security probe: run the site-hardening plugin\'s probe monthly and pass its report.json with --hardening.', '');
  return lines.join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { repo: 'string', hardening: 'string', log: 'list', include: 'list', lighthouse: 'boolean', analytics: 'string', skip: 'list', statusUrl: 'list', tlsHost: 'list', selector: 'list', form: 'list', rate: 'number', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    const site = siteUrl(args._[0]);
    if (!site) throw usageError('Give the site URL.');
    const report = await digest(site, args);
    const path = await writeReport(args.out || defaultOut('digest', site.hostname), report, toMarkdown(report));
    console.error(`Done: ${report.summary}. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}

