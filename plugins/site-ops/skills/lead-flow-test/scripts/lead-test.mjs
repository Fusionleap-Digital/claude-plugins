#!/usr/bin/env node
// Lead flow test: sends one clearly marked test lead through a form on a
// site you own, so you can follow it to the database, the inbox and the
// admin view, then delete it. Without --submit it only reads the page and
// prints what it would send. With --submit it sends exactly one request,
// and only after the site proves ownership. Zero dependencies, Node 18+.
//
//   node lead-test.mjs https://example.com --page /contact [--endpoint /api/contact]
//                      [--email you@example.com] [--field key=value] [--encoding json|form]
//                      [--submit] [--out dir]

import { randomBytes } from 'node:crypto';
import { parseArgs, siteUrl, createHttp, verifyOwnership, ownershipHelp, finding, sortFindings, summaryLine, findingsTable, mdTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION } from '../../../lib/common.mjs';
import { formsIn } from '../../deploy-check/scripts/smoke.mjs';

const USAGE = 'Usage: node lead-test.mjs https://example.com --page /contact [--endpoint /api/contact] [--email you@example.com] [--field key=value] [--encoding json|form] [--submit] [--out dir]';

const CAPTCHA = /(google\.com\/recaptcha|recaptcha\/api\.js|grecaptcha|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile|cf-turnstile|friendlycaptcha)/i;
const HONEYPOT = /^(website|url|homepage|hp|honeypot|bot[-_]?field|fax|_gotcha|address2)$/i;

// Where a JS-rendered form posts to: look for /api/... strings in the page's
// own scripts. Reads at most 25 scripts.
async function findEndpoints(http, origin, html) {
  const found = new Map();
  const scan = (src, where) => {
    for (const m of src.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/[\]]+)["'`]/g)) {
      const p = m[1].replace(/\/$/, '');
      if (!found.has(p)) found.set(p, where);
    }
  };
  scan(html, 'page HTML');
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))].map((s) => new URL(s, origin)).filter((u) => u.origin === origin);
  for (const u of srcs.slice(0, 25)) {
    const r = await http.get(u.href);
    if (r.status === 200) scan(r.body, u.pathname);
  }
  // The likeliest form endpoints first.
  return [...found].map(([path, where]) => ({ path, where })).sort((a, b) => score(b.path) - score(a.path));
}
const score = (p) => (/contact|lead|enquir|inquir|message|form|submit|demo|signup|subscribe/i.test(p) ? 2 : 0) - (/admin|auth|session|chat|health/i.test(p) ? 2 : 0);

// Fill each field with an obviously fake value that carries the marker.
export function buildPayload(fields, { marker, email, overrides = {} }) {
  const payload = {};
  const skipped = [];
  for (const f of fields) {
    const k = f.name;
    if (!k) continue;
    if (HONEYPOT.test(k) || f.type === 'hidden') { skipped.push(k); continue; }
    if (f.type === 'checkbox' || f.type === 'radio') continue;
    if (f.type === 'email' || /e-?mail/i.test(k)) payload[k] = email;
    else if (f.type === 'tel' || /phone|tel|mobile/i.test(k)) payload[k] = '000-000-0000';
    else if (/^name$|full.?name|your.?name/i.test(k)) payload[k] = `Site Ops Test ${marker}`;
    else if (/first/i.test(k)) payload[k] = 'SiteOps';
    else if (/last|surname/i.test(k)) payload[k] = `Test ${marker}`;
    else if (/company|organi[sz]ation|business/i.test(k)) payload[k] = `TEST LEAD - delete me (${marker})`;
    else if (f.tag === 'textarea' || /message|comment|details|body|note|question/i.test(k)) payload[k] = `This is an automated test lead from the site-ops plugin. It is safe to delete. Marker: ${marker}`;
    else if (f.tag === 'select') continue;
    else payload[k] = `TEST ${marker}`;
  }
  Object.assign(payload, overrides);
  return { payload, skipped };
}

export async function leadTest(site, opts = {}) {
  const origin = site.origin;
  const http = opts.http || createHttp({ rate: 2 });
  const findings = [];
  const page = opts.page || '/contact';
  const marker = opts.marker || `SITEOPS-TEST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const email = opts.email || `site-ops-test@${site.hostname.replace(/^www\./, '')}`;

  const r = await http.get(origin + page);
  if (r.status !== 200) throw new Error(`${page} returned ${r.status || r.error}.`);
  const forms = formsIn(r.body);
  const form = forms[opts.formIndex || 0];
  if (!form) findings.push(finding('review', 'form-not-in-html', `No <form> in the HTML of ${page}. The form may render only in the browser; pass the fields with --field.`, { where: page }));
  if (CAPTCHA.test(r.body)) findings.push(finding('review', 'captcha', 'The page loads a CAPTCHA. A script can\'t (and shouldn\'t) pass it: submit the test lead by hand in a browser, then follow the checklist with the marker you typed.', { where: page }));

  let endpoint = opts.endpoint || (form?.action ? new URL(form.action, origin + page).pathname : null);
  let candidates = [];
  if (!endpoint) {
    candidates = await findEndpoints(http, origin, r.body);
    endpoint = candidates[0]?.path || null;
    if (endpoint) findings.push(finding('review', 'endpoint-guessed', `The form has no action, so the endpoint was found in the page's scripts: ${endpoint}${candidates.length > 1 ? ` (others: ${candidates.slice(1, 5).map((c) => c.path).join(', ')})` : ''}. Confirm it in the form's submit handler before submitting.`, { where: page }));
    else findings.push(finding('high', 'endpoint-unknown', 'Couldn\'t find where the form sends its data. Read the form\'s submit handler in the repo and pass --endpoint.', { where: page }));
  }
  const overrides = Object.fromEntries((opts.field || []).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const { payload, skipped } = buildPayload(form?.fields || [], { marker, email, overrides });
  const encoding = opts.encoding || (form?.action ? 'form' : 'json');

  const result = { submitted: false };
  if (opts.submit) {
    if (!endpoint) throw new Error('No endpoint to submit to. Pass --endpoint.');
    const own = await verifyOwnership(origin, site.hostname, http);
    if (!own.ok) {
      console.error(ownershipHelp(origin, site.hostname));
      return { refused: true };
    }
    result.ownership = own.method;
    // A plain HTML form with method="get" sends a query string; everything
    // else (including forms posted by JavaScript) is a POST.
    const asGet = Boolean(form?.action) && form.method === 'get';
    const body = encoding === 'json' ? JSON.stringify(payload) : new URLSearchParams(payload).toString();
    const url = origin + endpoint + (asGet ? `?${new URLSearchParams(payload)}` : '');
    const res = await http.request(url, { method: asGet ? 'GET' : 'POST', redirect: 'manual', body: asGet ? undefined : body,
      headers: { ...(asGet ? {} : { 'content-type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }), origin, referer: origin + page } });
    result.submitted = true;
    result.status = res.status || res.error;
    result.ms = res.ms;
    let keys = null;
    try { keys = Object.keys(JSON.parse(res.body)); } catch {}
    result.responseKeys = keys;
    result.responseSnippet = keys ? null : res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (res.status >= 200 && res.status < 400) findings.push(finding('pass', 'submit', `${endpoint} answered ${res.status} in ${res.ms} ms${keys ? ` (JSON keys: ${keys.join(', ')})` : ''}. Now follow the lead downstream with the checklist.`, { where: endpoint }));
    else findings.push(finding('high', 'submit', `${endpoint} answered ${res.status || res.error}. The form is broken for real visitors too, or the payload doesn't match what the endpoint expects.`, { where: endpoint }));
  }
  sortFindings(findings);
  return {
    meta: { tool: 'lead-test', version: VERSION, site: origin, page, endpoint, encoding, marker, email, checked: new Date().toISOString(), mode: opts.submit ? 'submit' : 'dry run' },
    form: form ? { fields: form.fields, action: form.action, method: form.method } : null,
    endpointCandidates: candidates.slice(0, 8),
    payload,
    skipped,
    result,
    findings,
    summary: summaryLine(findings),
  };
}

function toMarkdown(r) {
  const m = r.meta;
  return [
    `# Lead flow test: ${m.site}${m.page}`,
    '',
    `- Mode: **${m.mode}**`,
    `- Marker: \`${m.marker}\` (search for this everywhere the lead should land)`,
    `- Endpoint: ${m.endpoint ? `\`${m.endpoint}\`` : 'unknown'} (${m.encoding})`,
    r.result.submitted ? `- Response: ${r.result.status} in ${r.result.ms} ms${r.result.responseKeys ? `, JSON keys: ${r.result.responseKeys.join(', ')}` : r.result.responseSnippet ? `, body starts: "${r.result.responseSnippet}"` : ''}` : '- Nothing was sent.',
    '',
    '## Payload',
    '',
    mdTable(['Field', 'Value'], Object.entries(r.payload).map(([k, v]) => [k, v])),
    r.skipped.length ? `Left empty on purpose (hidden or honeypot fields): ${r.skipped.join(', ')}\n` : '',
    r.findings.length ? '## Findings\n\n' + findingsTable(r.findings) : '',
    '## Follow the lead',
    '',
    `Work through references/lead-checklist.md with the marker \`${m.marker}\`: database row, notification email, auto-reply (if any), admin view, analytics or CRM, then delete it everywhere.`,
    '',
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { page: 'string', endpoint: 'string', email: 'string', field: 'list', encoding: 'string', formIndex: 'number', marker: 'string', submit: 'boolean', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    const site = siteUrl(args._[0]);
    if (!site) throw usageError('Give the site URL.');
    if (args.field.some((f) => !f.includes('='))) throw usageError('--field takes key=value.');
    const report = await leadTest(site, args);
    if (report.refused) return 2;
    const path = await writeReport(args.out || defaultOut('lead', site.hostname), report, toMarkdown(report));
    if (!args.submit) {
      console.error(`Dry run: nothing sent. Payload and endpoint are in ${path}.\nTo send this one test lead, run again with --submit${args.marker ? '' : ` --marker ${report.meta.marker}`} (needs ownership proof).`);
      return 0;
    }
    console.error(`Submitted: ${report.result.status}. Marker ${report.meta.marker}. Report: ${path}`);
    return report.findings.some((f) => f.check === 'submit' && f.severity === 'high') ? 1 : 0;
  });
}
