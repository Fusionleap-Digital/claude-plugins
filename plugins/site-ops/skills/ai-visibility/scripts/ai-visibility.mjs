#!/usr/bin/env node
// AI visibility check: can AI crawlers read the site, and does the site say
// clearly who the company is? Checks robots.txt rules per AI crawler,
// llms.txt, Organization and WebSite structured data (including
// disambiguatingDescription), and the basic meta tags. GET only, 2 requests
// per second. Zero dependencies, Node 18+.
//
//   node ai-visibility.mjs https://example.com [--name "Company"] [--path /about]
//                          [--rate 2] [--out dir]

import { parseArgs, siteUrl, createHttp, decodeEntities, finding, sortFindings, summaryLine, hasBlocking, findingsTable, mdTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION } from '../../../lib/common.mjs';

const USAGE = 'Usage: node ai-visibility.mjs https://example.com [--name "Company"] [--path /about] [--rate 2] [--out dir]';

// The user agents AI companies use, and what each one is for. "search"
// bots fetch pages to cite in answers; blocking them hides you from
// assistant answers. "training" bots collect data for model training.
export const AI_AGENTS = [
  ['GPTBot', 'OpenAI', 'training'], ['OAI-SearchBot', 'OpenAI', 'search'], ['ChatGPT-User', 'OpenAI', 'user fetch'],
  ['ClaudeBot', 'Anthropic', 'training'], ['Claude-SearchBot', 'Anthropic', 'search'], ['Claude-User', 'Anthropic', 'user fetch'],
  ['PerplexityBot', 'Perplexity', 'search'], ['Perplexity-User', 'Perplexity', 'user fetch'],
  ['Google-Extended', 'Google (Gemini)', 'training'], ['Applebot-Extended', 'Apple', 'training'], ['Amazonbot', 'Amazon', 'search'],
  ['CCBot', 'Common Crawl', 'training'], ['Bytespider', 'ByteDance', 'training'], ['meta-externalagent', 'Meta', 'training'], ['cohere-ai', 'Cohere', 'training'],
];

const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|ProfessionalService|NGO|EducationalOrganization|OnlineBusiness|OnlineStore|Store|Airline|NewsMediaOrganization|MedicalOrganization|SportsOrganization|GovernmentOrganization|.*Business)$/;

// ---------- robots.txt (RFC 9309 matching) ----------
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let agentRun = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!agentRun) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      agentRun = true;
    } else {
      agentRun = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

const ruleMatches = (rule, path) => {
  if (!rule.path) return false;
  const re = new RegExp('^' + rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
};

export function robotsVerdict(groups, agent, path = '/') {
  const a = agent.toLowerCase();
  let matched = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const named = matched.length > 0;
  if (!named) matched = groups.filter((g) => g.agents.includes('*'));
  const rules = matched.flatMap((g) => g.rules).filter((r) => ruleMatches(r, path));
  if (!rules.length) return { allowed: true, group: named ? 'named' : matched.length ? '*' : 'none' };
  // Longest match wins; on a tie, allow wins.
  rules.sort((x, y) => y.path.length - x.path.length || y.allow - x.allow);
  return { allowed: rules[0].allow, group: named ? 'named' : '*', rule: `${rules[0].allow ? 'Allow' : 'Disallow'}: ${rules[0].path}` };
}

// ---------- JSON-LD ----------
export function jsonLdNodes(html) {
  const nodes = [];
  const errors = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const walk = (d) => {
        if (Array.isArray(d)) return d.forEach(walk);
        if (!d || typeof d !== 'object') return;
        if (d['@graph']) walk(d['@graph']);
        if (d['@type']) nodes.push(d);
      };
      walk(data);
    } catch (err) {
      errors.push(String(err.message).slice(0, 100));
    }
  }
  return { nodes, errors };
}

const types = (n) => [].concat(n['@type'] || []);
const text = (v) => (typeof v === 'string' ? v : v?.['@value'] || v?.name || '');

function checkOrganization(nodes, site, opts, findings) {
  const org = nodes.find((n) => types(n).some((t) => ORG_TYPES.test(t)));
  if (!org) {
    findings.push(finding('high', 'schema-organization', 'No Organization structured data on the home page. AI assistants and search engines use it to know the company\'s name, site, logo and profiles.', { where: '/' }));
    return null;
  }
  const where = '/ (JSON-LD)';
  const name = text(org.name);
  if (!name) findings.push(finding('high', 'org-name', 'Organization has no name.', { where }));
  if (opts.name && name && name.toLowerCase() !== opts.name.toLowerCase()) findings.push(finding('medium', 'org-name-mismatch', `Organization name is "${name}", not "${opts.name}".`, { where }));
  try {
    if (!org.url) findings.push(finding('medium', 'org-url', 'Organization has no url.', { where }));
    else if (new URL(org.url).host.replace(/^www\./, '') !== site.host.replace(/^www\./, '')) findings.push(finding('high', 'org-url-host', `Organization url is ${org.url}, which is not this site.`, { where }));
  } catch { findings.push(finding('medium', 'org-url', `Organization url "${org.url}" isn't a valid URL.`, { where })); }
  if (!org.logo) findings.push(finding('low', 'org-logo', 'Organization has no logo.', { where }));
  if (!org.description) findings.push(finding('medium', 'org-description', 'Organization has no description: one plain sentence on what the company does.', { where }));
  const sameAs = [].concat(org.sameAs || []);
  if (!sameAs.length) findings.push(finding('medium', 'org-sameas', 'Organization has no sameAs links (LinkedIn, GitHub, Crunchbase and so on). These tie the site to the company\'s other profiles.', { where }));
  if (!org.disambiguatingDescription) {
    findings.push(finding('medium', 'org-disambiguating', 'No disambiguatingDescription. If another company has a similar name, say here who you are and who you are not, e.g. "An AI engineering firm in Sacramento (example.io). Not affiliated with Example, a design agency in Lisbon (example.net)."', { where }));
  } else {
    const d = text(org.disambiguatingDescription);
    findings.push(finding('pass', 'org-disambiguating', `disambiguatingDescription: "${d.slice(0, 200)}"`, { where }));
    if (!d.toLowerCase().includes(site.hostname.replace(/^www\./, '').toLowerCase())) findings.push(finding('low', 'org-disambiguating-domain', 'disambiguatingDescription doesn\'t mention your domain. Naming it helps assistants keep you apart from look-alikes on other domains.', { where }));
  }
  if (!org.contactPoint && !org.email) findings.push(finding('low', 'org-contact', 'Organization has no contactPoint or email.', { where }));
  if (!org.address && !org.areaServed) findings.push(finding('low', 'org-location', 'Organization has no address or areaServed, which helps tell apart companies with the same name in different places.', { where }));
  if (name && org.url && sameAs.length && org.description) findings.push(finding('pass', 'schema-organization', `Organization "${name}" with url, description and ${sameAs.length} sameAs link${sameAs.length === 1 ? '' : 's'}.`, { where }));
  return org;
}

function checkWebsite(nodes, org, findings) {
  const ws = nodes.find((n) => types(n).includes('WebSite'));
  const where = '/ (JSON-LD)';
  if (!ws) { findings.push(finding('medium', 'schema-website', 'No WebSite structured data. It names the site and links it to the Organization as publisher.', { where: '/' })); return null; }
  if (!ws.name) findings.push(finding('low', 'website-name', 'WebSite has no name.', { where }));
  if (!ws.url) findings.push(finding('low', 'website-url', 'WebSite has no url.', { where }));
  const pub = ws.publisher?.['@id'] || text(ws.publisher);
  if (!pub) findings.push(finding('low', 'website-publisher', 'WebSite has no publisher linking it to the Organization.', { where }));
  else if (org?.['@id'] && ws.publisher?.['@id'] && ws.publisher['@id'] !== org['@id']) findings.push(finding('low', 'website-publisher', `WebSite publisher @id (${ws.publisher['@id']}) doesn't match the Organization @id (${org['@id']}).`, { where }));
  else findings.push(finding('pass', 'schema-website', `WebSite "${ws.name || ''}" with publisher.`, { where }));
  return ws;
}

// ---------- llms.txt ----------
async function checkLlms(http, origin, findings) {
  const r = await http.get(origin + '/llms.txt');
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  if (r.status !== 200 || /<html/i.test(r.body.slice(0, 500))) {
    findings.push(finding('low', 'llms-txt', `No /llms.txt (${r.status === 200 ? 'got an HTML page' : r.status || r.error}). It's optional and not every assistant reads it, but it's a cheap way to give them a plain summary and the pages that matter.`, { where: '/llms.txt' }));
    return null;
  }
  const lines = r.body.split('\n');
  const links = [...r.body.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g)].map((m) => new URL(m[1], origin).href);
  if (!/^#\s+\S/.test(lines.find((l) => l.trim()) || '')) findings.push(finding('low', 'llms-title', 'llms.txt should start with "# <name>".', { where: '/llms.txt' }));
  if (!lines.some((l) => l.startsWith('> '))) findings.push(finding('low', 'llms-summary', 'llms.txt has no "> " summary line under the title.', { where: '/llms.txt' }));
  if (!/^text\/(plain|markdown)$/.test(ct)) findings.push(finding('low', 'llms-content-type', `llms.txt is served as ${ct || 'no content-type'}; use text/plain or text/markdown.`, { where: '/llms.txt' }));
  const own = links.filter((l) => new URL(l).origin === origin).slice(0, 10);
  const broken = [];
  for (const l of own) {
    const x = await http.get(l);
    if (x.status !== 200) broken.push(`${new URL(l).pathname} (${x.status || x.error})`);
  }
  if (broken.length) findings.push(finding('medium', 'llms-broken-links', `llms.txt links to pages that don't load: ${broken.join(', ')}.`, { where: '/llms.txt' }));
  findings.push(finding('pass', 'llms-txt', `llms.txt is served (${r.body.length} bytes, ${links.length} links; checked ${own.length}).`, { where: '/llms.txt' }));
  return { bytes: r.body.length, links: links.length, checked: own.length, broken };
}

// ---------- main ----------
export async function checkAiVisibility(site, opts = {}) {
  const origin = site.origin;
  const http = opts.http || createHttp({ rate: opts.rate || 2 });
  const findings = [];

  const robots = await http.get(origin + '/robots.txt');
  const groups = robots.status === 200 ? parseRobots(robots.body) : [];
  if (robots.status !== 200) findings.push(finding('low', 'robots', `robots.txt returned ${robots.status || robots.error}, so every crawler is allowed by default.`, { where: '/robots.txt' }));
  const agents = AI_AGENTS.map(([agent, owner, purpose]) => ({ agent, owner, purpose, ...robotsVerdict(groups, agent, '/') }));
  const blockedSearch = agents.filter((a) => !a.allowed && a.purpose !== 'training');
  if (blockedSearch.length) findings.push(finding('high', 'robots-blocks-ai-search', `robots.txt blocks ${blockedSearch.map((a) => a.agent).join(', ')}. These fetch pages to answer and cite in assistant results; blocking them hides the site from those answers.`, { where: '/robots.txt' }));
  const blockedTraining = agents.filter((a) => !a.allowed && a.purpose === 'training');
  if (blockedTraining.length) findings.push(finding('info', 'robots-blocks-training', `robots.txt blocks training crawlers: ${blockedTraining.map((a) => a.agent).join(', ')}. That's a policy choice; it doesn't affect search-style answers.`, { where: '/robots.txt' }));
  if (!blockedSearch.length) findings.push(finding('pass', 'robots-ai', `robots.txt lets the AI search and user-fetch agents read /${agents.some((a) => a.group === 'named') ? ' (some have their own rules)' : ''}.`, { where: '/robots.txt' }));

  const llms = await checkLlms(http, origin, findings);

  const pages = ['/', ...(opts.path || [])];
  const pageInfo = [];
  let org = null;
  let ws = null;
  for (const p of pages) {
    const r = await http.get(origin + p);
    if (r.status !== 200) { findings.push(finding(p === '/' ? 'critical' : 'medium', 'page', `${p} returned ${r.status || r.error}.`, { where: p })); continue; }
    const { nodes, errors } = jsonLdNodes(r.body);
    for (const e of errors) findings.push(finding('high', 'schema-invalid-json', `A JSON-LD block on ${p} isn't valid JSON (${e}), so it's ignored.`, { where: p }));
    const title = decodeEntities(r.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '');
    const desc = decodeEntities(r.body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '');
    const canonical = r.body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)?.[1] || '';
    const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(r.body) || /noindex/i.test(r.headers.get('x-robots-tag') || '');
    pageInfo.push({ path: p, title, description: desc, canonical, noindex, schema: [...new Set(nodes.flatMap(types))] });
    if (noindex) findings.push(finding('critical', 'noindex', `${p} tells crawlers not to index it (robots meta or X-Robots-Tag).`, { where: p }));
    if (!desc) findings.push(finding('low', 'meta-description', `${p} has no meta description.`, { where: p }));
    if (canonical) {
      try { if (new URL(canonical, origin).host.replace(/^www\./, '') !== site.host.replace(/^www\./, '')) findings.push(finding('high', 'canonical-host', `${p} canonical points at another host: ${canonical}.`, { where: p })); } catch {}
    } else if (p === '/') findings.push(finding('low', 'canonical', 'Home page has no canonical link.', { where: p }));
    if (p === '/') { org = checkOrganization(nodes, site, opts, findings); ws = checkWebsite(nodes, org, findings); }
  }

  const name = text(org?.name) || opts.name || pageInfo[0]?.title.split(/[|–—-]/)[0].trim() || site.hostname;
  sortFindings(findings);
  return {
    meta: { tool: 'ai-visibility', version: VERSION, site: origin, name, checked: new Date().toISOString(), requests: http.count },
    robots: agents,
    llms,
    organization: org ? { name: text(org.name), url: org.url, sameAs: [].concat(org.sameAs || []), disambiguatingDescription: text(org.disambiguatingDescription) || null } : null,
    website: ws ? { name: ws.name, url: ws.url } : null,
    pages: pageInfo,
    // For the assistant check in references/assistant-check.md.
    questions: [`What is ${name}?`, `What does ${site.hostname.replace(/^www\./, '')} do?`, `Who are the founders or leaders of ${name}?`, `Where is ${name} based?`, `What services does ${name} offer, and for whom?`, `Is ${name} the same company as <look-alike>?`],
    findings,
    summary: summaryLine(findings),
  };
}

function toMarkdown(r) {
  const problems = r.findings.filter((f) => f.severity !== 'pass');
  return [
    `# AI visibility: ${r.meta.site}`,
    '',
    `- Checked: ${r.meta.checked} (${r.meta.requests} GET requests)`,
    `- Company name used: ${r.meta.name}`,
    `- Result: ${r.summary}`,
    '',
    '## Problems',
    '',
    problems.length ? findingsTable(problems) : 'None.\n',
    '## AI crawlers in robots.txt',
    '',
    mdTable(['Agent', 'Owner', 'Used for', 'Can read /', 'Rule'], r.robots.map((a) => [a.agent, a.owner, a.purpose, a.allowed ? 'yes' : 'NO', a.rule ? `${a.rule} (${a.group === 'named' ? 'own group' : 'User-agent: *'})` : a.group === 'named' ? 'own group, no matching rule' : 'default'])),
    '## Pages',
    '',
    mdTable(['Path', 'Title', 'Description', 'Canonical', 'Structured data'], r.pages.map((p) => [p.path, p.title, p.description.slice(0, 90), p.canonical, p.schema.join(', ')])),
    '## Passed',
    '',
    findingsTable(r.findings.filter((f) => f.severity === 'pass')),
    '## Ask the assistants',
    '',
    'Ask each assistant these in a fresh chat with no web context from you, and compare the answers with the site (see references/assistant-check.md):',
    '',
    ...r.questions.map((q) => `- ${q}`),
    '',
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { name: 'string', path: 'list', rate: 'number', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    const site = siteUrl(args._[0]);
    if (!site) throw usageError('Give the site URL.');
    const report = await checkAiVisibility(site, args);
    const path = await writeReport(args.out || defaultOut('ai-visibility', site.hostname), report, toMarkdown(report));
    console.error(`Done: ${report.summary}. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}
