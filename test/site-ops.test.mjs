// Tests for the site-ops scripts. Offline: DNS is faked, crawler IP lists
// come from test/site-ops-fixtures/ranges, and HTTP checks run against the
// local fixture site.
//
//   node --test test/site-ops.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { start, submissions } from './site-ops-fixture-server.mjs';
import { checkEmail } from '../plugins/site-ops/skills/email-deliverability/scripts/email-dns.mjs';
import { checkEnv, extractEnvReads, buildSpecEnvWrites } from '../plugins/site-ops/skills/deploy-check/scripts/env-check.mjs';
import { runSmoke } from '../plugins/site-ops/skills/deploy-check/scripts/smoke.mjs';
import { triage, parseLog } from '../plugins/site-ops/skills/bot-triage/scripts/bot-verify.mjs';
import { checkAiVisibility, parseRobots, robotsVerdict } from '../plugins/site-ops/skills/ai-visibility/scripts/ai-visibility.mjs';
import { leadTest } from '../plugins/site-ops/skills/lead-flow-test/scripts/lead-test.mjs';
import { createHttp } from '../plugins/site-ops/lib/common.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'site-ops-fixtures');
const PORT = 4596;
const SITE = new URL(`http://localhost:${PORT}`);
const checks = (r) => r.findings.map((f) => f.check);
const fast = () => createHttp({ rate: 5 });

let server;
before(async () => { server = await start(PORT); });
after(() => server.close());

// ---------- email ----------
function fakeResolver(zone) {
  const none = () => Object.assign(new Error('none'), { code: 'ENODATA' });
  return {
    resolveTxt: async (n) => { if (!zone.txt[n]) throw none(); return zone.txt[n].map((t) => [t]); },
    resolveMx: async (n) => { if (!zone.mx?.[n]) throw none(); return zone.mx[n]; },
    rawTxt: async (labels) => (zone.txt[labels.join('.')] || []).map((t) => [t]) || null,
  };
}

test('email: flags the mistakes from our own DNS', async () => {
  const r = await checkEmail('broken.test', { smtpHost: 'smtp.zoho.com', smtpProbe: false }, fakeResolver({
    txt: {
      'broken.test': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:zoho.com ~all', 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC'],
      '@.broken.test': ['v=spf1 include:_spf.google.com ~all'],
      '_spf.google.com': ['v=spf1 ip4:1.2.3.0/24 ~all'],
    },
    mx: { 'broken.test': [{ priority: 1, exchange: 'smtp.google.com' }] },
  }));
  const c = checks(r);
  for (const want of ['spf-multiple', 'dkim-at-root', 'record-at-literal-at', 'dmarc-missing', 'dkim-not-found']) assert.ok(c.includes(want), `missing ${want}: ${c}`);
});

test('email: a healthy domain passes', async () => {
  const key = 'A'.repeat(392); // ~2048-bit RSA key length
  const r = await checkEmail('good.test', { selector: ['mail2026'], smtpHost: 'smtp.gmail.com', smtpProbe: false }, fakeResolver({
    txt: {
      'good.test': ['v=spf1 include:_spf.google.com -all'],
      '_spf.google.com': ['v=spf1 ip4:1.2.3.0/24 ~all'],
      'mail2026._domainkey.good.test': [`v=DKIM1; k=rsa; p=${key}`],
      '_dmarc.good.test': ['v=DMARC1; p=reject; rua=mailto:dmarc@good.test'],
    },
    mx: { 'good.test': [{ priority: 1, exchange: 'smtp.google.com' }] },
  }));
  assert.deepEqual(r.findings.filter((f) => f.severity !== 'pass').map((f) => f.check), []);
  assert.deepEqual(r.records.dkimSelectors, ['mail2026']);
});

test('email: SMTP host from the old provider is caught', async () => {
  const r = await checkEmail('moved.test', { smtpHost: 'smtp.zoho.com', smtpProbe: false }, fakeResolver({
    txt: { 'moved.test': ['v=spf1 include:_spf.google.com ~all'], '_spf.google.com': ['v=spf1 ~all'], '_dmarc.moved.test': ['v=DMARC1; p=none; rua=mailto:a@moved.test'] },
    mx: { 'moved.test': [{ priority: 1, exchange: 'aspmx.l.google.com' }] },
  }));
  assert.ok(checks(r).includes('smtp-provider-mismatch'));
});

// ---------- env ----------
test('env: reads names in all the usual forms', () => {
  const reads = extractEnvReads("const a = process.env.A_ONE || 'x';\nconst { B_TWO, C: c = 1 } = process.env;\nf(process.env['D_FOUR']);\n// process.env.NOPE\n").map((r) => r.name);
  assert.deepEqual(reads, ['A_ONE', 'B_TWO', 'C', 'D_FOUR']);
  assert.deepEqual([...buildSpecEnvWrites('- echo "X=$X" >> .env\n- echo "Y=${Y}" >> .env')], ['X', 'Y']);
});

test('env: finds missing, unbaked and public-secret variables without printing values', async () => {
  const r = await checkEnv(join(FIX, 'repo'), { host: 'amplify', namesFile: join(FIX, 'host-env-names.txt') });
  const by = (check) => r.findings.filter((f) => f.check === check).map((f) => f.name).sort();
  assert.deepEqual(by('env-missing-in-host'), ['EMAIL_TO', 'NEXT_PUBLIC_MAPS_API_KEY']);
  assert.deepEqual(by('amplify-env-not-in-dotenv'), ['DATABASE_URL', 'EMAIL_SERVER']);
  assert.deepEqual(by('public-secret'), ['NEXT_PUBLIC_MAPS_API_KEY']);
  assert.deepEqual(by('env-unused-in-host'), ['OLD_ZOHO_TOKEN']);
  assert.ok(!JSON.stringify(r).includes('should-never-be-printed'), 'a value leaked into the report');
  assert.ok(!r.variables.some((v) => v.name === 'NODE_ENV' || v.name === 'COMMENTED_OUT'));
});

// ---------- smoke ----------
test('smoke: catches the broken fixture site', async () => {
  const r = await runSmoke(SITE, { http: fast(), form: ['/contact'], expect: ['/::Welcome to Fixture Co', '/::Not on the page'] });
  const c = checks(r);
  for (const want of ['sitemap-wrong-host', 'route-status', 'route-noindex', 'security-headers', 'route-expected-text', 'form']) assert.ok(c.includes(want), `missing ${want}: ${c}`);
  assert.equal(r.findings.find((f) => f.check === 'route-status').where, '/about');
  assert.match(r.findings.find((f) => f.check === 'security-headers').detail, /Content-Security-Policy, Referrer-Policy/);
  assert.equal(r.findings.filter((f) => f.check === 'route-expected-text' && f.severity === 'high').length, 1);
});

// ---------- bots ----------
test('bots: parses Amplify access logs', () => {
  const { format, rows } = parseLog(`date,time,c-ip,cs\\(User-Agent),cs-uri-stem,sc-status\n2026-10-14,01:00:00,1.2.3.4,Mozilla/5.0%20\\(compatible;%20GPTBot/1.2),/a,200\n`);
  assert.equal(format, 'amplify');
  assert.deepEqual(rows[0], { ip: '1.2.3.4', ua: 'Mozilla/5.0 (compatible; GPTBot/1.2)', path: '/a', status: 200, time: '2026-10-14 01:00:00' });
  const combined = parseLog('5.6.7.8 - - [14/Oct/2026:01:00:00 +0000] "GET /.env HTTP/1.1" 404 12 "-" "ClaudeBot/1.0"\n');
  assert.equal(combined.format, 'combined');
  assert.equal(combined.rows[0].ua, 'ClaudeBot/1.0');
});

test('bots: sorts genuine, fake and unverifiable crawlers', async () => {
  const ptr = { '52.70.0.1': ['52-70-0-1.crawl.amazonbot.amazon'], '192.0.2.9': ['crawl.amazonbot.amazon.evil.example'], '198.51.100.7': ['vm-7.cloud.example'] };
  const fwd = { '52-70-0-1.crawl.amazonbot.amazon': ['52.70.0.1'] };
  const dnsApi = { reverse: async (ip) => ptr[ip] || [], resolve4: async (h) => fwd[h] || [], resolve6: async () => [] };
  const r = await triage(await readFile(join(FIX, 'amplify-access.csv'), 'utf8'), { rangesDir: join(FIX, 'ranges'), dnsApi });
  const row = (name) => r.crawlers.find((c) => c.crawler === name);
  assert.deepEqual([row('Googlebot').genuine, row('Googlebot').fake], [2, 1]);
  assert.deepEqual([row('GPTBot').genuine, row('GPTBot').fake], [1, 1]);
  assert.deepEqual([row('Amazonbot').genuine, row('Amazonbot').fake], [1, 1]);
  assert.equal(row('Bytespider').unverifiable, 1);
  const scanner = r.suspects.find((s) => s.ip === '198.51.100.7');
  assert.deepEqual(scanner.names.sort(), ['CCBot', 'ClaudeBot', 'GPTBot', 'PerplexityBot']);
  assert.equal(scanner.sensitiveServed, 1);
  assert.ok(checks(r).includes('rotating-names'));
  assert.ok(checks(r).includes('sensitive-served'));
  assert.deepEqual(r.otherScanners.map((s) => s.ip), ['192.0.2.88']);
  assert.ok(!JSON.stringify(r).includes('192.0.2.77'), 'an ordinary visitor IP is in the report');
});

// ---------- AI visibility ----------
test('ai-visibility: robots matching follows the crawler rules', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\nAllow: /blog$\n');
  assert.equal(robotsVerdict(g, 'GPTBot').allowed, false);
  assert.equal(robotsVerdict(g, 'GPTBot', '/blog').allowed, true);
  assert.equal(robotsVerdict(g, 'ClaudeBot').allowed, true);
  assert.equal(robotsVerdict(g, 'ClaudeBot', '/private/x').allowed, false);
});

test('ai-visibility: flags blocked search bots, broken JSON-LD and missing identity', async () => {
  const r = await checkAiVisibility(SITE, { http: fast(), name: 'Fixture Co' });
  const c = checks(r);
  for (const want of ['robots-blocks-ai-search', 'robots-blocks-training', 'schema-invalid-json', 'org-disambiguating', 'org-sameas', 'schema-website', 'llms-txt']) assert.ok(c.includes(want), `missing ${want}: ${c}`);
  assert.match(r.findings.find((f) => f.check === 'robots-blocks-ai-search').detail, /OAI-SearchBot/);
  assert.equal(r.robots.find((a) => a.agent === 'ClaudeBot').allowed, true);
});

// ---------- lead test ----------
test('lead-test: dry run sends nothing and finds the JS endpoint', async () => {
  const before = submissions.length;
  const r = await leadTest(SITE, { http: fast(), page: '/contact' });
  assert.equal(submissions.length, before);
  assert.equal(r.meta.endpoint, '/api/contact');
  assert.deepEqual(Object.keys(r.payload).sort(), ['company', 'email', 'message', 'name']);
  assert.deepEqual(r.skipped, ['website']);
  assert.match(r.payload.message, new RegExp(r.meta.marker));
});

test('lead-test: --submit sends exactly one marked lead on a local host', async () => {
  const before = submissions.length;
  const r = await leadTest(SITE, { http: fast(), page: '/contact', submit: true, marker: 'SITEOPS-TEST-FIXTURE' });
  assert.equal(submissions.length, before + 1);
  assert.equal(r.result.status, 200);
  assert.deepEqual(r.result.responseKeys, ['success', 'id']);
  assert.match(submissions.at(-1).name, /SITEOPS-TEST-FIXTURE/);
  assert.equal(submissions.at(-1).website, undefined, 'honeypot was filled');
});

test('lead-test: refuses to submit to a public host without ownership proof', async () => {
  const calls = [];
  const http = { get: async (u) => { calls.push(['GET', u]); return u.endsWith('/contact') ? { status: 200, body: '<form><input id="email"><textarea id="message"></textarea></form>', headers: new Headers() } : { status: 404, body: '', headers: new Headers() }; },
    request: async (u, o) => { calls.push([o.method, u]); return { status: 200, body: '{}', headers: new Headers() }; } };
  const r = await leadTest(new URL('https://unverified.example'), { http, page: '/contact', endpoint: '/api/contact', submit: true });
  assert.equal(r.refused, true);
  assert.ok(!calls.some(([m]) => m === 'POST'), 'it posted anyway');
});
