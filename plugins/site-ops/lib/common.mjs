// Shared helpers for the site-ops scripts: argument parsing, a rate-limited
// HTTP client, ownership proof, and report writing. Zero dependencies,
// Node 18+.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolveTxt } from 'node:dns/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
export const UA = `site-ops/${VERSION} (+https://fusionleap.io/tools; site owner self-check)`;
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'review', 'info', 'pass'];

// True when the file was run directly (not imported by the digest or tests).
export const isMain = (meta) => process.argv[1] && meta.url === pathToFileURL(process.argv[1]).href;

// ---------- args ----------
// spec: { flagName: 'string' | 'number' | 'boolean' | 'list' }. Lists take a
// comma-separated value and can repeat.
export function parseArgs(argv, spec) {
  const args = { _: [] };
  for (const [k, t] of Object.entries(spec)) if (t === 'list') args[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const [rawKey, inline] = a.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const type = spec[key];
    if (!type) throw new Error(`Unknown flag --${rawKey}`);
    if (type === 'boolean') { args[key] = true; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${rawKey} needs a value`);
    if (type === 'number') args[key] = Number(value);
    else if (type === 'list') args[key].push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    else args[key] = value;
  }
  return args;
}

export function siteUrl(input) {
  if (!input) return null;
  return new URL(input.includes('://') ? input : `https://${input}`);
}

export function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.localhost') || host.endsWith('.test');
}

// ---------- http ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small client that spaces requests out (default 2 per second, max 5) and
// caps bodies at 256 KB. Never throws: network errors come back as status 0.
export function createHttp({ rate = 2, bodyLimit = 256 * 1024, timeoutMs = 15_000 } = {}) {
  const gap = 1000 / Math.min(5, Math.max(0.2, rate));
  let last = 0;
  let count = 0;
  async function request(url, { method = 'GET', headers = {}, body, redirect = 'follow', ua = UA } = {}) {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count++;
    const started = performance.now();
    try {
      const res = await fetch(url, { method, redirect, body, headers: { 'user-agent': ua, accept: '*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      const ttfb = Math.round(performance.now() - started);
      let text = '';
      if (res.body) {
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        while (size < bodyLimit) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        reader.cancel().catch(() => {});
        text = Buffer.concat(chunks).toString('utf8');
      }
      return { status: res.status, headers: res.headers, body: text, url: res.url || url, redirected: res.redirected, ttfb, ms: Math.round(performance.now() - started) };
    } catch (err) {
      return { status: 0, headers: new Headers(), body: '', url, error: String(err?.cause?.code || err?.cause?.message || err?.message || err), ms: Math.round(performance.now() - started) };
    }
  }
  return { request, get: (url, opts) => request(url, { ...opts, method: 'GET' }), get count() { return count; } };
}

// ---------- ownership ----------
// Same proof the site-hardening probe accepts, plus a site-ops variant.
// Only needed for scripts that write to the site (the lead test).
const PROOFS = [
  ['/.well-known/site-ops.txt', '_site-ops', 'site-ops-verification='],
  ['/.well-known/site-hardening.txt', '_site-hardening', 'site-hardening-verification='],
];

export async function verifyOwnership(origin, hostname, http) {
  if (isLocalHost(hostname)) return { ok: true, method: 'local development host' };
  for (const [file, , prefix] of PROOFS) {
    const r = await http.get(origin + file);
    if (r.status === 200 && r.body.includes(prefix)) return { ok: true, method: `file ${file}` };
  }
  for (const [, label, prefix] of PROOFS) {
    try {
      const records = (await resolveTxt(`${label}.${hostname}`)).map((r) => r.join(''));
      if (records.some((r) => r.startsWith(prefix))) return { ok: true, method: `DNS TXT ${label}.${hostname}` };
    } catch {
      // no record
    }
  }
  return { ok: false };
}

export function ownershipHelp(origin, hostname) {
  return `Ownership not verified for ${hostname}. Prove you control the site with either:\n` +
    `  1. A file at ${origin}/.well-known/site-ops.txt containing:  site-ops-verification=<any-id>\n` +
    `  2. A DNS TXT record on _site-ops.${hostname} with value:  site-ops-verification=<any-id>\n` +
    '(The site-hardening proof file or TXT record works too.)';
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
  });
}

// ---------- findings and reports ----------
export const finding = (severity, check, detail, extra = {}) => ({ severity, check, detail, ...extra });

export function sortFindings(findings) {
  return findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function countBySeverity(findings) {
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

export function summaryLine(findings) {
  const problems = findings.filter((f) => !['pass', 'info'].includes(f.severity));
  if (!problems.length) return 'no problems found';
  const c = countBySeverity(problems);
  return SEVERITY_ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ');
}

export const hasBlocking = (findings) => findings.some((f) => f.severity === 'critical' || f.severity === 'high');

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function mdTable(headers, rows) {
  if (!rows.length) return '';
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`), ''].join('\n');
}

export function findingsTable(findings, { where = 'where' } = {}) {
  return mdTable(['Severity', 'Check', where === false ? null : 'Where', 'Detail'].filter(Boolean),
    findings.map((f) => [f.severity, f.check, ...(where === false ? [] : [f.where ? `\`${f.where}\`` : '']), f.detail]));
}

export async function writeReport(outDir, json, markdown) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), JSON.stringify(json, null, 2));
  await writeFile(join(outDir, 'report.md'), markdown);
  return join(outDir, 'report.md');
}

export const today = () => new Date().toISOString().slice(0, 10);
export const defaultOut = (tool, name) => `site-ops-${tool}-${name}-${today()}`;

// Shared entry wrapper: prints usage on --help or bad flags, exits 2 on
// usage errors and 1 when a report has critical or high findings.
export async function runCli(usage, fn) {
  try {
    const code = await fn();
    process.exit(code ?? 0);
  } catch (err) {
    if (err?.usage || /^(Unknown flag|--)/.test(err?.message || '')) {
      console.error(`${err.message}\n\n${usage}`);
      process.exit(2);
    }
    console.error(err?.stack || String(err));
    process.exit(2);
  }
}

export function usageError(message) {
  const e = new Error(message);
  e.usage = true;
  return e;
}
