#!/usr/bin/env node
// Bot traffic triage: reads an access log, finds requests that claim to be
// well-known crawlers, and checks each claim against the IP ranges the
// crawler's owner publishes and/or reverse-then-forward DNS. Reports which
// are fake and what they asked for. Reads the log and does DNS lookups; it
// sends nothing to your site. Zero dependencies, Node 18+.
//
//   node bot-verify.mjs access.log [--format auto|amplify|cloudfront|combined|csv|jsonl]
//                       [--no-dns] [--max-ips 300] [--ranges-dir dir] [--out dir]

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { reverse, resolve4, resolve6 } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { parseArgs, finding, sortFindings, summaryLine, hasBlocking, findingsTable, mdTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION, UA } from '../../../lib/common.mjs';

const USAGE = 'Usage: node bot-verify.mjs access.log [--format auto|amplify|cloudfront|combined|csv|jsonl] [--no-dns] [--max-ips 300] [--ranges-dir dir] [--out dir]';

// How each crawler's owner says to verify it. `ranges` are the JSON files
// they publish ({prefixes:[{ipv4Prefix|ipv6Prefix}]}); `rdns` are the host
// name suffixes a genuine IP reverses to (then must forward-resolve back).
export const CRAWLERS = [
  { name: 'Googlebot', ua: /Googlebot/i, ranges: ['https://developers.google.com/static/search/apis/ipranges/googlebot.json'], rdns: ['.googlebot.com', '.google.com'] },
  { name: 'Google other crawlers', ua: /Google-(InspectionTool|Extended|Safety)|GoogleOther|Storebot-Google|AdsBot-Google|Mediapartners-Google|APIs-Google/i, ranges: ['https://developers.google.com/static/search/apis/ipranges/special-crawlers.json', 'https://developers.google.com/static/search/apis/ipranges/googlebot.json'], rdns: ['.googlebot.com', '.google.com', '.googleusercontent.com'] },
  { name: 'Bingbot', ua: /bingbot|BingPreview|msnbot|adidxbot/i, ranges: ['https://www.bing.com/toolbox/bingbot.json'], rdns: ['.search.msn.com'] },
  { name: 'OAI-SearchBot', ua: /OAI-SearchBot/i, ranges: ['https://openai.com/searchbot.json'] },
  { name: 'ChatGPT-User', ua: /ChatGPT-User/i, ranges: ['https://openai.com/chatgpt-user.json'] },
  { name: 'GPTBot', ua: /GPTBot/i, ranges: ['https://openai.com/gptbot.json'] },
  { name: 'ClaudeBot', ua: /ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai|Claude-Web/i, ranges: ['https://claude.com/crawling/bots.json'] },
  { name: 'PerplexityBot', ua: /PerplexityBot/i, ranges: ['https://www.perplexity.com/perplexitybot.json'] },
  { name: 'Perplexity-User', ua: /Perplexity-User/i, ranges: ['https://www.perplexity.com/perplexity-user.json'] },
  { name: 'CCBot', ua: /CCBot/i, ranges: ['https://index.commoncrawl.org/ccbot.json'] },
  { name: 'Applebot', ua: /Applebot/i, ranges: ['https://search.developer.apple.com/applebot.json'], rdns: ['.applebot.apple.com'] },
  { name: 'Amazonbot', ua: /Amazonbot/i, rdns: ['.crawl.amazonbot.amazon'] },
  { name: 'DuckDuckBot', ua: /DuckDuckBot|DuckAssistBot/i, ranges: ['https://duckduckgo.com/duckduckbot.json'] },
  // ByteDance publishes no IP list or DNS names for Bytespider, so a claim
  // can't be proven either way. Judge it by what it asks for.
  { name: 'Bytespider', ua: /Bytespider/i },
  { name: 'meta-externalagent', ua: /meta-externalagent|meta-externalfetcher|FacebookBot/i },
  { name: 'cohere-ai', ua: /cohere-ai|cohere-training-data-crawler/i },
];

// What scanners ask for. A real search or AI crawler follows links and
// sitemaps; it has no reason to request these.
export const SENSITIVE = /(^|\/)\.(env|git|svn|hg|aws|ssh|docker|npmrc|htpasswd|DS_Store|vscode)\b|\.env(\.|$)|(^|\/)(wp-admin|wp-login|wp-config|xmlrpc|phpmyadmin|phpinfo|server-status|actuator|cgi-bin|vendor\/phpunit)|\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp|tfstate|tfvars|pem|key|p12|sqlite|log)$|(^|\/)(config|credentials|secrets?|settings|application|database|amplify|aws-exports|supabase|firebase|terraform|docker-compose|appsettings|\.?config)(\.[a-z]+)?\.(json|ya?ml|js|ts|toml|ini|xml)$|amplify\/|team-provider-info|serviceAccount|\.\.\//i;

const CLOUD_PTR = [
  [/amazonaws\.com\.?$|\.aws\.?$/, 'AWS'], [/googleusercontent\.com\.?$|bc\.googleusercontent/, 'Google Cloud'], [/cloudapp\.(azure|net)|\.azure\.com\.?$/, 'Azure'],
  [/linodeusercontent\.com|members\.linode\.com/, 'Linode/Akamai'], [/digitalocean/, 'DigitalOcean'], [/your-server\.de|hetzner/, 'Hetzner'],
  [/ovh\.(net|ca|us)|\.ip-\d+-\d+-\d+\.(eu|net|us)/, 'OVH'], [/vultrusercontent\.com|vultr/, 'Vultr'], [/contaboserver\.net/, 'Contabo'],
  [/oraclecloud|oracle\.com/, 'Oracle Cloud'], [/alibaba|aliyun/, 'Alibaba Cloud'], [/tencent/, 'Tencent Cloud'], [/scaleway|online\.net/, 'Scaleway'],
];

// ---------- log parsing ----------
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"' && cur === '') quoted = true;
    else if (c === '\\' && i + 1 < line.length) { cur += c + line[++i]; } // CloudFront/Amplify escape
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const unescape = (s) => (s || '').replace(/\\(.)/g, '$1');
const decode = (s) => { try { return decodeURIComponent(s.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { return s; } };
const dash = (s) => (s === '-' ? '' : s);

function pick(cols, names) {
  const norm = cols.map((c) => unescape(c).toLowerCase().replace(/[^a-z]/g, ''));
  for (const n of names) { const i = norm.indexOf(n); if (i >= 0) return i; }
  return -1;
}

export function parseLog(text, format = 'auto') {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { format: 'empty', rows: [] };
  const first = lines[0];
  if (format === 'auto') {
    if (/^#(Version|Fields):/.test(first)) format = 'cloudfront';
    else if (first.trim().startsWith('{')) format = 'jsonl';
    else if (/^\S+ \S+ \S+ \[[^\]]+\] "/.test(first)) format = 'combined';
    else if (first.includes(',') && /c-ip|cs\\?\(user-agent\\?\)/i.test(first)) format = 'amplify';
    else format = 'csv';
  }
  const rows = [];
  if (format === 'combined') {
    const re = /^(\S+) \S+ \S+ \[([^\]]+)\] "(?:(\S+) (\S+)[^"]*|[^"]*)" (\d{3}|-) \S+(?: "([^"]*)" "([^"]*)")?/;
    for (const l of lines) {
      const m = l.match(re);
      if (m) rows.push({ ip: m[1], time: m[2], method: m[3] || '', path: (m[4] || '').split('?')[0], status: Number(m[5]) || 0, ua: m[7] || '' });
    }
  } else if (format === 'cloudfront') {
    const fields = (lines.find((l) => l.startsWith('#Fields:')) || '').replace('#Fields:', '').trim().split(/\s+/);
    const idx = (n) => fields.indexOf(n);
    for (const l of lines.filter((x) => !x.startsWith('#'))) {
      const c = l.split('\t');
      rows.push({ ip: c[idx('c-ip')], time: `${c[idx('date')]} ${c[idx('time')]}`, method: c[idx('cs-method')], path: decode(c[idx('cs-uri-stem')] || ''), status: Number(c[idx('sc-status')]) || 0, ua: decode(decode(dash(c[idx('cs(User-Agent)')] || ''))) });
    }
  } else if (format === 'jsonl') {
    const get = (o, paths) => { for (const p of paths) { const v = p.split('.').reduce((a, k) => a?.[k], o); if (v !== undefined && v !== null) return Array.isArray(v) ? v.join(' ') : String(v); } return ''; };
    for (const l of lines) {
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      rows.push({ ip: get(o, ['ip', 'clientIp', 'client_ip', 'remote_addr', 'remoteAddr', 'proxy.clientIp', 'request.ip', 'c-ip']),
        ua: get(o, ['userAgent', 'user_agent', 'ua', 'proxy.userAgent', 'request.headers.user-agent', 'headers.user-agent']),
        path: get(o, ['path', 'proxy.path', 'request.path', 'url', 'request.url', 'uri']).replace(/^https?:\/\/[^/]+/, '').split('?')[0],
        status: Number(get(o, ['status', 'statusCode', 'proxy.statusCode', 'response.status'])) || 0,
        time: get(o, ['timestamp', 'time', 'date', '@timestamp']) });
    }
  } else {
    // amplify / generic CSV with a header row
    const header = splitCsv(first);
    const ci = { ip: pick(header, ['cip', 'ip', 'clientip', 'remoteaddr', 'remoteip', 'sourceip']), ua: pick(header, ['csuseragent', 'useragent', 'ua', 'agent']),
      path: pick(header, ['csuristem', 'path', 'uri', 'url', 'requestpath', 'request']), status: pick(header, ['scstatus', 'status', 'statuscode']),
      date: pick(header, ['date', 'timestamp', 'time']), time: pick(header, ['time']) };
    if (ci.ip < 0 || ci.ua < 0 || ci.path < 0) throw usageError(`Couldn't find ip, user-agent and path columns in the header: ${first.slice(0, 200)}`);
    for (const l of lines.slice(1)) {
      const c = splitCsv(l).map(unescape);
      rows.push({ ip: c[ci.ip], ua: decode(decode(dash(c[ci.ua] || ''))), path: decode(c[ci.path] || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0], status: Number(c[ci.status]) || 0,
        time: ci.date >= 0 ? `${c[ci.date]}${ci.time >= 0 && ci.time !== ci.date ? ' ' + c[ci.time] : ''}` : '' });
    }
  }
  return { format, rows: rows.filter((r) => r.ip && isIP(r.ip.replace(/^\[|\]$/g, ''))).map((r) => ({ ...r, ip: r.ip.replace(/^\[|\]$/g, '') })) };
}

// ---------- verification data ----------
async function loadRanges(url, { rangesDir, cacheDir }) {
  const key = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.]+/gi, '_');
  if (rangesDir) {
    const text = await readFile(join(rangesDir, `${key}`), 'utf8').catch(() => readFile(join(rangesDir, basename(new URL(url).pathname)), 'utf8').catch(() => null));
    return text ? { prefixes: JSON.parse(text).prefixes || [], source: 'local file' } : { error: 'no local file' };
  }
  const cached = join(cacheDir, key);
  const s = await stat(cached).catch(() => null);
  if (s && Date.now() - s.mtimeMs < 24 * 3600 * 1000) return { prefixes: JSON.parse(await readFile(cached, 'utf8')).prefixes || [], source: 'cache' };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cached, text);
    return { prefixes: json.prefixes || [], source: 'downloaded', created: json.creationTime };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

export function buildBlockList(prefixes) {
  const bl = new BlockList();
  let n = 0;
  for (const p of prefixes) {
    const cidr = p.ipv4Prefix || p.ipv6Prefix;
    if (!cidr) continue;
    const [net, bits] = cidr.split('/');
    try { bl.addSubnet(net, Number(bits), p.ipv6Prefix ? 'ipv6' : 'ipv4'); n++; } catch { /* skip bad prefix */ }
  }
  return { bl, n };
}

const inList = (bl, ip) => bl.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

async function limitAll(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function ptr(ip, dnsApi) {
  try { return (await dnsApi.reverse(ip)).map((h) => h.replace(/\.$/, '').toLowerCase()); } catch { return []; }
}

async function forwardConfirms(host, ip, dnsApi) {
  try {
    const addrs = isIP(ip) === 6 ? await dnsApi.resolve6(host) : await dnsApi.resolve4(host);
    return addrs.includes(ip);
  } catch { return false; }
}

// ---------- main ----------
export async function triage(text, opts = {}) {
  const dnsApi = opts.dnsApi || { reverse, resolve4, resolve6 };
  const { format, rows } = parseLog(text, opts.format);
  const claimed = [];
  for (const r of rows) {
    const c = CRAWLERS.find((x) => x.ua.test(r.ua));
    if (c) claimed.push({ ...r, crawler: c.name });
  }
  // Ranges for the crawlers that appear in the log.
  const needed = new Set(claimed.map((r) => r.crawler));
  const lists = {};
  const rangeNotes = [];
  for (const c of CRAWLERS.filter((x) => needed.has(x.name) && x.ranges)) {
    const prefixes = [];
    for (const url of c.ranges) {
      const r = await loadRanges(url, { rangesDir: opts.rangesDir, cacheDir: opts.cacheDir || join(tmpdir(), 'site-ops-crawler-ranges') });
      if (r.error) rangeNotes.push(`${c.name}: couldn't load ${url} (${r.error})`);
      else prefixes.push(...r.prefixes);
    }
    if (prefixes.length) lists[c.name] = buildBlockList(prefixes).bl;
  }

  // One verdict per (crawler, ip).
  const pairs = [...new Set(claimed.map((r) => `${r.crawler}\t${r.ip}`))].map((k) => k.split('\t'));
  const maxIps = opts.maxIps ?? 300;
  const ptrCache = new Map();
  const getPtr = async (ip) => {
    if (opts.noDns) return [];
    if (!ptrCache.has(ip)) ptrCache.set(ip, ptr(ip, dnsApi));
    return ptrCache.get(ip);
  };
  let dnsBudget = maxIps;
  const verdicts = new Map();
  await limitAll(pairs, 8, async ([name, ip]) => {
    const c = CRAWLERS.find((x) => x.name === name);
    let verdict = 'unverifiable';
    let method = 'owner publishes no way to verify';
    if (lists[name] && inList(lists[name], ip)) { verdict = 'genuine'; method = 'in published IP ranges'; }
    else if (c.rdns && !opts.noDns && dnsBudget-- > 0) {
      const hosts = await getPtr(ip);
      const match = hosts.find((h) => c.rdns.some((s) => h.endsWith(s)));
      if (match && (await forwardConfirms(match, ip, dnsApi))) { verdict = 'genuine'; method = `reverse DNS ${match}, forward confirmed`; }
      else { verdict = 'fake'; method = match ? `reverse DNS ${match} did not resolve back to the IP` : `reverse DNS is ${hosts[0] || 'missing'}, not ${c.rdns.join(' or ')}`; }
    } else if (lists[name]) { verdict = 'fake'; method = 'not in published IP ranges'; }
    else if (c.ranges || c.rdns) { verdict = 'unknown'; method = c.rdns && opts.noDns ? 'DNS checks turned off' : 'IP list unavailable'; }
    verdicts.set(`${name}\t${ip}`, { verdict, method });
  });

  // Rows of IPs that weren't PTR-looked-up yet get a network label for fakes.
  const fakeIps = [...new Set([...verdicts].filter(([, v]) => v.verdict === 'fake' || v.verdict === 'unverifiable').map(([k]) => k.split('\t')[1]))];
  if (!opts.noDns) await limitAll(fakeIps.slice(0, maxIps), 8, getPtr);
  const network = async (ip) => {
    const hosts = ptrCache.has(ip) ? await ptrCache.get(ip) : [];
    const cloud = CLOUD_PTR.find(([re]) => hosts.some((h) => re.test(h)))?.[1];
    return { ptr: hosts[0] || '', cloud: cloud || '' };
  };

  // ---------- summaries ----------
  const byCrawler = {};
  for (const r of claimed) {
    const v = verdicts.get(`${r.crawler}\t${r.ip}`).verdict;
    const s = (byCrawler[r.crawler] ||= { crawler: r.crawler, requests: 0, ips: new Set(), genuine: 0, fake: 0, unverifiable: 0, unknown: 0, sensitive: 0 });
    s.requests++; s.ips.add(r.ip); s[v]++;
    if (SENSITIVE.test(r.path)) s.sensitive++;
  }
  const crawlerRows = Object.values(byCrawler).sort((a, b) => b.requests - a.requests).map((s) => ({ ...s, ips: s.ips.size }));

  const byIp = new Map();
  for (const r of claimed) {
    const v = verdicts.get(`${r.crawler}\t${r.ip}`);
    if (v.verdict === 'genuine') continue;
    const e = byIp.get(r.ip) || { ip: r.ip, requests: 0, names: new Set(), verdicts: new Set(), sensitive: 0, served: 0, paths: new Map(), first: r.time, last: r.time };
    e.requests++; e.names.add(r.crawler); e.verdicts.add(v.verdict); e.last = r.time;
    e.paths.set(r.path, (e.paths.get(r.path) || 0) + 1);
    if (SENSITIVE.test(r.path)) { e.sensitive++; if (r.status >= 200 && r.status < 300) e.served++; }
    byIp.set(r.ip, e);
  }
  const suspects = [];
  for (const e of byIp.values()) {
    const net = await network(e.ip);
    suspects.push({ ip: e.ip, ...net, requests: e.requests, names: [...e.names], verdict: [...e.verdicts].join('/'), sensitive: e.sensitive, sensitiveServed: e.served,
      topPaths: [...e.paths].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => (n > 1 ? `${p} (${n})` : p)), first: e.first, last: e.last });
  }
  suspects.sort((a, b) => (b.verdict.includes('fake') - a.verdict.includes('fake')) || b.sensitive - a.sensitive || b.requests - a.requests);

  // Clients with ordinary browser user agents that probe for secret files.
  const scanners = new Map();
  for (const r of rows) {
    if (!SENSITIVE.test(r.path) || CRAWLERS.some((c) => c.ua.test(r.ua))) continue;
    const e = scanners.get(r.ip) || { ip: r.ip, requests: 0, served: 0, paths: new Set(), ua: r.ua };
    e.requests++; e.paths.add(r.path);
    if (r.status >= 200 && r.status < 300) e.served++;
    scanners.set(r.ip, e);
  }
  const otherScanners = [...scanners.values()].sort((a, b) => b.requests - a.requests).slice(0, 15).map((e) => ({ ...e, paths: [...e.paths].slice(0, 4) }));

  const totalClaimed = claimed.length;
  const fakeReq = crawlerRows.reduce((n, s) => n + s.fake, 0);
  const unverReq = crawlerRows.reduce((n, s) => n + s.unverifiable, 0);
  const genuineReq = crawlerRows.reduce((n, s) => n + s.genuine, 0);
  const rotating = suspects.filter((s) => s.names.length > 1);
  const findings = [];
  if (!totalClaimed) findings.push(finding('info', 'no-crawlers', `No requests in the log claim to be one of the ${CRAWLERS.length} known crawlers.`));
  if (fakeReq) findings.push(finding('medium', 'fake-crawlers', `${fakeReq} of ${totalClaimed} crawler requests (${Math.round((100 * fakeReq) / totalClaimed)}%) came from ${suspects.filter((s) => s.verdict.includes('fake')).length} IPs that are not who they claim to be. Don't trust user agents for allow rules or analytics.`));
  if (rotating.length) findings.push(finding('medium', 'rotating-names', `${rotating.length} IPs used more than one crawler name (for example ${rotating[0].ip}: ${rotating[0].names.join(', ')}). Real crawlers never do this; these are scanners.`, { where: rotating[0].ip }));
  const served = [...suspects.filter((s) => s.sensitiveServed), ...otherScanners.filter((s) => s.served)];
  if (served.length) findings.push(finding('high', 'sensitive-served', `${served.length} clients got a 2xx answer to a secret or config path (for example ${served[0].ip}). Check those paths now with the site-hardening probe; a 2xx can be a soft-404 page or a real leak.`, { where: served[0].ip }));
  const sensFake = suspects.reduce((n, s) => n + s.sensitive, 0);
  if (sensFake) findings.push(finding('info', 'sensitive-asked', `Unverified "crawlers" asked for ${sensFake} secret or config paths (.env, .git, config files). These requests should all get 404.`));
  if (unverReq) findings.push(finding('info', 'unverifiable', `${unverReq} request${unverReq === 1 ? '' : 's'} named crawlers that publish no IP list or DNS names (${crawlerRows.filter((s) => s.unverifiable).map((s) => s.crawler).join(', ')}). Judge them by what they ask for.`));
  for (const n of rangeNotes) findings.push(finding('review', 'ranges-unavailable', n));
  if (genuineReq) findings.push(finding('pass', 'genuine', `${genuineReq} crawler requests verified as genuine.`));
  sortFindings(findings);

  return {
    meta: { tool: 'bot-verify', version: VERSION, format, lines: rows.length, claimed: totalClaimed, genuine: genuineReq, fake: fakeReq, unverifiable: unverReq, dns: !opts.noDns, checked: new Date().toISOString(),
      span: rows.length ? `${rows[0].time} to ${rows[rows.length - 1].time}` : '' },
    crawlers: crawlerRows,
    suspects,
    otherScanners,
    findings,
    summary: summaryLine(findings),
  };
}

function toMarkdown(r, source) {
  const m = r.meta;
  const pct = (n) => (m.claimed ? `${Math.round((100 * n) / m.claimed)}%` : '0%');
  return [
    `# Bot traffic triage: ${source}`,
    '',
    `- Log: ${m.lines} requests (${m.format}), ${m.span}`,
    `- Claimed crawler requests: ${m.claimed}. Genuine ${m.genuine} (${pct(m.genuine)}), fake ${m.fake} (${pct(m.fake)}), can't be verified ${m.unverifiable} (${pct(m.unverifiable)})`,
    `- Checked with: published IP ranges${m.dns ? ' and reverse-then-forward DNS' : ' only (--no-dns)'}`,
    `- Result: ${r.summary}`,
    '',
    '## Findings',
    '',
    findingsTable(r.findings),
    '## By crawler',
    '',
    mdTable(['Crawler', 'Requests', 'IPs', 'Genuine', 'Fake', 'Unverifiable', 'Secret/config paths'], r.crawlers.map((c) => [c.crawler, c.requests, c.ips, c.genuine, c.fake, c.unverifiable + c.unknown, c.sensitive])),
    r.suspects.length ? '## Fake or unverified crawler IPs\n' : '',
    mdTable(['IP', 'Network (reverse DNS)', 'Verdict', 'Requests', 'Names used', 'Secret/config asks', 'Top paths'],
      r.suspects.slice(0, 40).map((s) => [s.ip, [s.cloud, s.ptr].filter(Boolean).join(': ') || '-', s.verdict, s.requests, s.names.join(', '), s.sensitive ? `${s.sensitive}${s.sensitiveServed ? ` (${s.sensitiveServed} got 2xx)` : ''}` : 0, s.topPaths.join(', ')])),
    r.otherScanners.length ? '## Other clients asking for secret or config files\n\nThese used ordinary browser user agents.\n' : '',
    mdTable(['IP', 'Requests', 'Got 2xx', 'Sample paths'], r.otherScanners.map((s) => [s.ip, s.requests, s.served, s.paths.join(', ')])),
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { format: 'string', noDns: 'boolean', maxIps: 'number', rangesDir: 'string', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    if (!args._.length) throw usageError('Give one or more log files.');
    const text = (await Promise.all(args._.map((f) => readFile(f, 'utf8')))).map((t, i) => (i ? t.split('\n').slice(/^(date,|#)/.test(t) ? 1 : 0).join('\n') : t)).join('\n');
    const report = await triage(text, args);
    const name = basename(args._[0]).replace(/\.[^.]+$/, '');
    const path = await writeReport(args.out || defaultOut('bots', name), report, toMarkdown(report, args._.map((f) => basename(f)).join(', ')));
    console.error(`Done: ${report.meta.claimed} crawler requests, ${report.meta.fake} fake, ${report.meta.unverifiable} unverifiable. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}
