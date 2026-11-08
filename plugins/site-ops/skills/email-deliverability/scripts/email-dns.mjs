#!/usr/bin/env node
// Email deliverability check: reads a domain's SPF, DKIM, DMARC and MX
// records and flags the mistakes that send mail to spam or get it rejected.
// DNS lookups only. Zero dependencies, Node 18+.
//
//   node email-dns.mjs example.com [--selector s1,s2] [--smtp-host smtp.gmail.com]
//                     [--no-mail] [--resolver 1.1.1.1] [--out dir]

import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';
import { rawResolveTxt } from '../../../lib/dns-wire.mjs';
import { parseArgs, finding, sortFindings, summaryLine, hasBlocking, findingsTable, writeReport, defaultOut, runCli, usageError, isMain, VERSION } from '../../../lib/common.mjs';

const USAGE = 'Usage: node email-dns.mjs example.com [--selector s1,s2] [--smtp-host smtp.gmail.com] [--smtp-port 587] [--no-mail] [--resolver 1.1.1.1] [--out dir]';

// Selectors the common providers use. Add the user's own with --selector
// (it's the s= value in a received message's DKIM-Signature header).
export const COMMON_SELECTORS = [
  'google', 'selector1', 'selector2', 'k1', 'k2', 'k3', 's1', 's2', 'default', 'dkim', 'mail', 'smtp', 'mta',
  'mandrill', 'mailjet', 'zmail', 'zoho', 'resend', 'pm', 'cm', 'fm1', 'fm2', 'fm3', 'protonmail', 'protonmail2',
  'protonmail3', 'mxvault', 'everlytickey1', 'sig1', 'turbo-smtp', 'hs1', 'hs2', 'sendgrid', 'mailgun', 'krs',
];

// Mail providers by their MX, SPF include and SMTP host, so a contact form
// that still sends through the old provider after a move can be spotted.
export const PROVIDERS = [
  { name: 'Google Workspace', mx: /(\.|^)(google|googlemail)\.com$/, spf: /_spf\.google\.com/, smtp: /(^|\.)(smtp|smtp-relay)\.gmail\.com$|google\.com$/ },
  { name: 'Microsoft 365', mx: /\.protection\.outlook\.com$|\.mail\.protection\.outlook\.com$/, spf: /spf\.protection\.outlook\.com/, smtp: /office365\.com$|outlook\.com$/ },
  { name: 'Zoho', mx: /zoho\.(com|eu|in)$/, spf: /zoho(mail)?\.(com|eu|in)/, smtp: /zoho\.(com|eu|in)$/ },
  { name: 'Fastmail', mx: /messagingengine\.com$/, spf: /messagingengine\.com/, smtp: /fastmail\.com$/ },
  { name: 'Proton', mx: /protonmail\.ch$/, spf: /protonmail\.ch/, smtp: /protonmail\.ch$/ },
  { name: 'GoDaddy', mx: /secureserver\.net$/, spf: /secureserver\.net/, smtp: /secureserver\.net$/ },
  { name: 'Namecheap Private Email', mx: /privateemail\.com$/, spf: /privateemail\.com|spf\.web-hosting\.com/, smtp: /privateemail\.com$/ },
  { name: 'Amazon SES', mx: /amazonaws\.com$/, spf: /amazonses\.com/, smtp: /email-smtp\.[a-z0-9-]+\.amazonaws\.com$/ },
  { name: 'SendGrid', mx: null, spf: /sendgrid\.net/, smtp: /sendgrid\.net$/ },
  { name: 'Mailgun', mx: /mailgun\.org$/, spf: /mailgun\.org/, smtp: /mailgun\.org$/ },
  { name: 'Postmark', mx: null, spf: /mtasv\.net/, smtp: /postmarkapp\.com$/ },
  { name: 'Resend', mx: null, spf: /amazonses\.com/, smtp: /resend\.com$/ },
  { name: 'Brevo', mx: null, spf: /sendinblue\.com|brevo\.com/, smtp: /(sendinblue|brevo)\.com$/ },
];

const providerFor = (field, value) => PROVIDERS.find((p) => p[field] && p[field].test(value.toLowerCase()));

const NONE_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME', 'NXDOMAIN']);

// Wraps a resolver so "no record" returns [] and real failures are kept.
function makeDns(resolver) {
  const wrap = (fn) => async (name) => {
    try { return { records: await fn(name) }; } catch (err) {
      if (NONE_CODES.has(err.code)) return { records: [] };
      return { records: [], error: err.code || String(err) };
    }
  };
  return {
    txt: wrap(async (n) => (await resolver.resolveTxt(n)).map((r) => r.join(''))),
    mx: wrap((n) => resolver.resolveMx(n)),
    rawTxt: resolver.rawTxt
      ? wrap(async (labels) => (await resolver.rawTxt(labels) || []).map((r) => r.join('')))
      : async () => ({ records: [] }),
  };
}

// ---------- SPF ----------
const LOOKUP_TERMS = /^[+~?-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr\b|ptr:|exists:|redirect=)/i;

async function countSpfLookups(dns, record, seen = new Set(), depth = 0) {
  let count = 0;
  const nested = [];
  for (const term of record.split(/\s+/).slice(1)) {
    if (!LOOKUP_TERMS.test(term)) continue;
    count++;
    const target = term.match(/^[+~?-]?(?:include:|redirect=)(.+)$/i)?.[1];
    if (target && depth < 10 && !seen.has(target)) {
      seen.add(target);
      const r = await dns.txt(target);
      const spf = r.records.find((t) => /^v=spf1\b/i.test(t));
      if (spf) count += (await countSpfLookups(dns, spf, seen, depth + 1)).count;
      else nested.push(target);
    }
  }
  return { count, missing: nested };
}

async function checkSpf(dns, domain, rootTxt, opts, findings) {
  const spf = rootTxt.filter((t) => /^v=spf1\b/i.test(t));
  const where = domain;
  if (!spf.length) {
    findings.push(finding(opts.noMail ? 'medium' : 'high', 'spf-missing', opts.noMail
      ? 'No SPF record. For a domain that sends no mail, publish "v=spf1 -all" so nobody can send as it.'
      : 'No SPF record at the domain root. Receivers can\'t tell which servers may send as this domain.', { where }));
    return null;
  }
  if (spf.length > 1) {
    findings.push(finding('high', 'spf-multiple', `${spf.length} SPF records at the root. Receivers treat that as an SPF error (permerror) and SPF fails for every message. Merge them into one record.`, { where, records: spf }));
  }
  const record = spf[0];
  const all = record.match(/\s([+~?-]?)all\b/i);
  if (!all && !/redirect=/i.test(record)) findings.push(finding('medium', 'spf-no-all', 'SPF record has no "all" term at the end, so mail from anywhere else is neutral. End it with ~all or -all.', { where }));
  else if (all && (all[1] === '+' || all[1] === '')) findings.push(finding('critical', 'spf-pass-all', 'SPF ends in "+all" (or bare "all"): any server in the world may send as this domain.', { where }));
  else if (all && all[1] === '?') findings.push(finding('medium', 'spf-neutral-all', 'SPF ends in "?all", which tells receivers nothing. Use ~all or -all.', { where }));
  if (/\sptr\b|\sptr:/i.test(record)) findings.push(finding('low', 'spf-ptr', 'SPF uses the "ptr" mechanism, which is deprecated and slow. Replace it with ip4/ip6 or include.', { where }));
  const { count, missing } = await countSpfLookups(dns, record);
  if (count > 10) findings.push(finding('high', 'spf-too-many-lookups', `SPF needs ${count} DNS lookups; the limit is 10, so SPF fails. Remove unused includes or flatten them.`, { where }));
  for (const m of missing) findings.push(finding('medium', 'spf-include-missing', `SPF includes ${m}, which has no SPF record. Remove it or fix the name.`, { where }));
  findings.push(finding('pass', 'spf', `One SPF record: ${record} (${count} DNS lookup${count === 1 ? '' : 's'} of 10).`, { where }));
  return record;
}

// ---------- DKIM ----------
function dkimKeyBits(record) {
  const p = record.match(/\bp=([A-Za-z0-9+/=]*)/)?.[1];
  if (p === undefined) return { p: null };
  if (!p) return { p: '' };
  // An RSA public key's base64 length tracks its size closely.
  const bytes = Math.floor((p.length * 3) / 4);
  const bits = bytes > 500 ? 4096 : bytes > 270 ? 2048 : bytes > 140 ? 1024 : 512;
  return { p, bits, rsa: !/k=ed25519/i.test(record) };
}

async function checkDkim(dns, domain, rootTxt, selectors, findings) {
  const rootDkim = rootTxt.filter((t) => /^v=DKIM1\b|(^|;)\s*k=rsa\s*;\s*p=/i.test(t));
  if (rootDkim.length) {
    findings.push(finding('high', 'dkim-at-root', 'A DKIM key is published at the domain root. Receivers only look for it at <selector>._domainkey.' + domain + ', so it does nothing there. Move it to the selector name your provider gives (Google: google._domainkey).', { where: domain }));
  }
  const found = [];
  for (const sel of selectors) {
    const name = `${sel}._domainkey.${domain}`;
    const r = await dns.txt(name);
    const rec = r.records.find((t) => /v=DKIM1|\bp=/i.test(t));
    if (!rec) continue;
    const key = dkimKeyBits(rec);
    found.push(sel);
    if (key.p === '') findings.push(finding('medium', 'dkim-revoked', `Selector "${sel}" has an empty key (p=), meaning it was revoked. Remove it if nothing signs with it.`, { where: name }));
    else if (key.p === null) findings.push(finding('high', 'dkim-malformed', `Selector "${sel}" has no p= key.`, { where: name }));
    else if (key.rsa && key.bits < 1024) findings.push(finding('high', 'dkim-weak', `Selector "${sel}" key is about ${key.bits}-bit RSA; receivers reject keys under 1024 bits. Generate a 2048-bit key.`, { where: name }));
    else if (key.rsa && key.bits < 2048) findings.push(finding('low', 'dkim-1024', `Selector "${sel}" key is about 1024-bit RSA. It works, but providers recommend 2048-bit.`, { where: name }));
    else findings.push(finding('pass', 'dkim', `Selector "${sel}" has a DKIM key${key.rsa ? ` (about ${key.bits}-bit RSA)` : ''}.`, { where: name }));
  }
  if (!found.length) {
    findings.push(finding('medium', 'dkim-not-found', `No DKIM key at ${selectors.length} common selectors. If mail is signed, pass the selector with --selector (it's the s= value in a received message's DKIM-Signature header). If it isn't, turn on DKIM signing at your mail provider.`, { where: `*._domainkey.${domain}` }));
  }
  return found;
}

// ---------- DMARC ----------
async function checkDmarc(dns, domain, rootTxt, findings) {
  const name = `_dmarc.${domain}`;
  if (rootTxt.some((t) => /^v=DMARC1\b/i.test(t))) {
    findings.push(finding('high', 'dmarc-at-root', `A DMARC record is at the domain root. Receivers only read it at ${name}. Move it there.`, { where: domain }));
  }
  const r = await dns.txt(name);
  if (r.error) { findings.push(finding('review', 'dmarc-lookup-error', `Lookup failed (${r.error}). Run again.`, { where: name })); return null; }
  const recs = r.records.filter((t) => /^v=DMARC1\b/i.test(t));
  if (!recs.length) {
    findings.push(finding('high', 'dmarc-missing', 'No DMARC record. Gmail and Yahoo require one for bulk senders, and without it nobody is told when someone spoofs your domain. Start with "v=DMARC1; p=none; rua=mailto:<you>@' + domain + '".', { where: name }));
    return null;
  }
  if (recs.length > 1) findings.push(finding('high', 'dmarc-multiple', `${recs.length} DMARC records; receivers ignore DMARC when there's more than one. Keep one.`, { where: name }));
  const rec = recs[0];
  const tag = (t) => rec.match(new RegExp(`(?:^|;)\\s*${t}\\s*=\\s*([^;]+)`, 'i'))?.[1]?.trim();
  const p = tag('p')?.toLowerCase();
  if (!p) findings.push(finding('high', 'dmarc-no-policy', 'DMARC record has no p= policy, so it is invalid.', { where: name }));
  else if (p === 'none') findings.push(finding('low', 'dmarc-monitor-only', 'DMARC policy is p=none (report only). Fine to start with; once reports show your real mail passes, move to p=quarantine, then p=reject.', { where: name }));
  if (!tag('rua')) findings.push(finding('low', 'dmarc-no-reports', 'DMARC has no rua= address, so you get no reports on who sends as your domain.', { where: name }));
  const pct = tag('pct');
  if (pct && Number(pct) < 100) findings.push(finding('low', 'dmarc-pct', `DMARC applies to only ${pct}% of failing mail (pct=${pct}).`, { where: name }));
  findings.push(finding('pass', 'dmarc', `DMARC record: ${rec}`, { where: name }));
  return rec;
}

// ---------- the literal "@" record ----------
// In Route 53 (and some other DNS consoles) the root name is left blank.
// Typing "@" creates a record at a subdomain literally named "@", shown as
// \100.example.com, and nobody ever reads it.
async function checkAtLabel(dns, domain, findings) {
  const r = await dns.rawTxt(['@', ...domain.split('.')]);
  const name = `\\100.${domain}`;
  for (const t of r.records) {
    const kind = /^v=spf1/i.test(t) ? 'SPF' : /^v=DMARC1/i.test(t) ? 'DMARC' : /v=DKIM1|\bp=/i.test(t) ? 'DKIM' : /verification/i.test(t) ? 'verification' : 'TXT';
    findings.push(finding('high', 'record-at-literal-at', `A ${kind} record sits at a subdomain literally named "@" (${name}), so it is never read. Create it at the root instead (in Route 53, leave the record name blank) and delete this one.`, { where: name, record: t.slice(0, 80) }));
  }
}

// ---------- MX ----------
async function checkMx(dns, domain, opts, findings) {
  const r = await dns.mx(domain);
  if (r.error) { findings.push(finding('review', 'mx-lookup-error', `Lookup failed (${r.error}).`, { where: domain })); return []; }
  const mx = r.records.sort((a, b) => a.priority - b.priority);
  if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) {
    findings.push(finding(opts.noMail ? 'pass' : 'high', 'mx-null', 'Null MX ("0 ."): this domain says it accepts no mail.', { where: domain }));
    return mx;
  }
  if (!mx.length) {
    findings.push(finding(opts.noMail ? 'low' : 'high', 'mx-missing', opts.noMail
      ? 'No MX record. For a domain that receives no mail, publish a null MX ("0 .") to say so.'
      : 'No MX record, so mail to this domain bounces (including replies to your contact-form emails).', { where: domain }));
    return mx;
  }
  const providers = [...new Set(mx.map((m) => providerFor('mx', m.exchange)?.name).filter(Boolean))];
  if (providers.length > 1) findings.push(finding('medium', 'mx-mixed', `MX records point at more than one provider (${providers.join(', ')}). Leftovers from a mail move? Mail can land in the old mailbox.`, { where: domain }));
  findings.push(finding('pass', 'mx', `MX: ${mx.map((m) => `${m.priority} ${m.exchange}`).join(', ')}${providers.length ? ` (${providers.join(', ')})` : ''}.`, { where: domain }));
  return mx;
}

// ---------- SMTP host ----------
function smtpBanner(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let data = '';
    const done = (result) => { sock.destroy(); resolve(result); };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || String(e) }));
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (/^220[ -]/m.test(data) && !data.includes('EHLO-SENT')) {
        sock.write('EHLO site-ops.check\r\n');
        data += 'EHLO-SENT';
      } else if (/^250 /m.test(data)) {
        sock.write('QUIT\r\n');
        done({ ok: true, starttls: /STARTTLS/i.test(data), banner: data.split('\n')[0].slice(0, 120).trim() });
      } else if (/^[45]\d\d /m.test(data)) done({ ok: false, error: data.split('\n')[0].trim().slice(0, 120) });
    });
  });
}

async function checkSmtp(opts, mx, spf, findings) {
  const host = opts.smtpHost.toLowerCase();
  const provider = providerFor('smtp', host);
  const mxProvider = mx.map((m) => providerFor('mx', m.exchange)).find(Boolean);
  const where = `${host}:${opts.smtpPort}`;
  if (provider && mxProvider && provider.name !== mxProvider.name && provider.spf && !(spf && provider.spf.test(spf))) {
    findings.push(finding('high', 'smtp-provider-mismatch', `The SMTP host is ${provider.name}, but MX says mail is hosted at ${mxProvider.name}, and SPF doesn't include ${provider.name}. After a mail move, the form's env vars often still point at the old provider. Update EMAIL_SERVER (or similar) and redeploy.`, { where }));
  } else if (provider?.spf && spf && !provider.spf.test(spf)) {
    findings.push(finding('high', 'smtp-not-in-spf', `Mail sent through ${provider.name} will fail SPF: the SPF record doesn't include it. Add its include, or send through the provider SPF already lists.`, { where }));
  }
  if (opts.smtpProbe === false) return;
  const r = await smtpBanner(host, opts.smtpPort);
  if (!r.ok) findings.push(finding('high', 'smtp-unreachable', `Couldn't talk to ${where} (${r.error}). Check the host and port in the site's env vars. Note: some networks block outbound SMTP, so confirm from the host too.`, { where }));
  else if (opts.smtpPort === 587 && !r.starttls) findings.push(finding('medium', 'smtp-no-starttls', 'The server answered on 587 but did not offer STARTTLS.', { where }));
  else findings.push(finding('pass', 'smtp', `${where} answers (${r.banner})${r.starttls ? ', offers STARTTLS' : ''}. Nothing was sent; the check said EHLO and QUIT.`, { where }));
}

// ---------- main check ----------
export async function checkEmail(domain, opts = {}, resolver) {
  domain = domain.toLowerCase().replace(/\.$/, '');
  const dns = makeDns(resolver || defaultResolver(opts.resolver));
  const findings = [];
  const root = await dns.txt(domain);
  if (root.error) findings.push(finding('review', 'txt-lookup-error', `Root TXT lookup failed (${root.error}). Results may be incomplete.`, { where: domain }));
  const selectors = [...new Set([...(opts.selector || []), ...COMMON_SELECTORS])];
  const mx = await checkMx(dns, domain, opts, findings);
  const spf = await checkSpf(dns, domain, root.records, opts, findings);
  const dkim = await checkDkim(dns, domain, root.records, selectors, findings);
  const dmarc = await checkDmarc(dns, domain, root.records, findings);
  await checkAtLabel(dns, domain, findings);
  if (opts.smtpHost) await checkSmtp({ smtpPort: 587, ...opts }, mx, spf, findings);
  sortFindings(findings);
  return {
    meta: { tool: 'email-dns', version: VERSION, domain, checked: new Date().toISOString(), selectorsTried: selectors.length },
    records: { mx: mx.map((m) => `${m.priority} ${m.exchange}`), spf, dkimSelectors: dkim, dmarc },
    findings,
    summary: summaryLine(findings),
  };
}

export function defaultResolver(server) {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (server) r.setServers([server]);
  r.rawTxt = (labels) => rawResolveTxt(labels, { server });
  return r;
}

export function toMarkdown(report) {
  const { meta, records, findings } = report;
  const problems = findings.filter((f) => f.severity !== 'pass');
  return [
    `# Email DNS report: ${meta.domain}`,
    '',
    `- Checked: ${meta.checked}`,
    `- Result: ${report.summary}`,
    `- MX: ${records.mx.join(', ') || 'none'}`,
    `- SPF: ${records.spf || 'none'}`,
    `- DKIM selectors found: ${records.dkimSelectors.join(', ') || `none of ${meta.selectorsTried} tried`}`,
    `- DMARC: ${records.dmarc || 'none'}`,
    '',
    problems.length ? '## Problems\n\n' + findingsTable(problems) : '## Problems\n\nNone.\n',
    '## Passed\n',
    findingsTable(findings.filter((f) => f.severity === 'pass')),
    'Next: work through `references/smtp-checklist.md` for the contact form\'s sending path.',
    '',
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { selector: 'list', smtpHost: 'string', smtpPort: 'number', noMail: 'boolean', resolver: 'string', out: 'string', noSmtpProbe: 'boolean' });
    if (args.help) { console.log(USAGE); return 0; }
    const domain = args._[0]?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) throw usageError('Give a domain.');
    const report = await checkEmail(domain, { ...args, smtpPort: args.smtpPort || 587, smtpProbe: !args.noSmtpProbe });
    const path = await writeReport(args.out || defaultOut('email', domain), report, toMarkdown(report));
    console.error(`Done: ${report.summary}. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}
