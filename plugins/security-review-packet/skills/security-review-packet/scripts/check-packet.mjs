#!/usr/bin/env node
// Checks a drafted security review packet before anyone sees it:
//   - every required section is there
//   - every statement (bullet or table row) is tagged [Found: file:line],
//     [Assumed] or [Ask team]
//   - every file:line citation exists in the repo
//   - every critical and high inventory flag (F-001…) is addressed
//   - no secret values, no compliance claims, no "blocker"/"veto" wording
// Writes packet.json (every statement with its tag and citations). Exit 1
// if anything fails. Node 18+, no dependencies.
//
//   node check-packet.mjs <packet.md> [--inventory inventory.json] [--root <repo>]

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { SECRET_PATTERNS } from './lib/files.mjs';

const REQUIRED = [
  ['overview', /system overview/i],
  ['data-flow', /data[- ]flow/i],
  ['data-inventory', /data inventory|classification/i],
  ['access', /access control|identity/i],
  ['logging', /logging|monitoring|audit/i],
  ['threats', /prompt injection|tool misuse|threat/i],
  ['hitl', /human[- ]in[- ]the[- ]loop|human review|approval/i],
  ['vendors', /vendor|sub-?processor/i],
  ['incident', /incident/i],
  ['open-questions', /open questions/i],
];
const TAG = /\[(Found|Assumed|Ask team)(?::\s*([^\]]+))?\]/gi;
const CITE = /([A-Za-z0-9_@./()[\]-]+\.[A-Za-z0-9]+|[A-Za-z0-9_./-]*(?:Dockerfile|Makefile|\.env[\w.]*|\.mcp\.json)):(\d+)(?:-(\d+))?/g;

function parseArgs(argv) {
  const a = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inventory') a.inventory = argv[++i];
    else if (argv[i] === '--root') a.root = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') a.help = true;
    else a.rest.push(argv[i]);
  }
  a.packet = a.rest[0];
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.packet) {
    console.log('Usage: node check-packet.mjs <packet.md> [--inventory inventory.json] [--root <repo>]');
    process.exit(args.help ? 0 : 2);
  }
  const text = await readFile(args.packet, 'utf8');
  const invPath = args.inventory || join(dirname(args.packet), 'inventory.json');
  const inv = existsSync(invPath) ? JSON.parse(await readFile(invPath, 'utf8')) : null;
  const root = resolve(args.root || inv?.meta?.root || '.');
  const errors = [];
  const warnings = [];
  const lines = text.split('\n');

  // Sections.
  const headings = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  for (const [id, re] of REQUIRED) if (!headings.some(({ l }) => re.test(l))) errors.push(`Missing section: ${id}`);

  // Statements.
  const statements = [];
  let section = null;
  let inFence = false;
  let tableHeader = false;
  const lineCache = new Map();
  const fileLines = (rel) => {
    if (!lineCache.has(rel)) {
      const abs = join(root, rel);
      lineCache.set(rel, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n').length : null);
    }
    return lineCache.get(rel);
  };
  lines.forEach((line, i) => {
    if (/^```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    if (/^#{1,6}\s/.test(line)) { section = line.replace(/^#+\s*/, ''); tableHeader = false; return; }
    if (!section || /^(legend|how to read)|scan details/i.test(section)) return;
    const isTable = /^\s*\|/.test(line);
    if (isTable) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { tableHeader = false; return; } // separator row
      if (!tableHeader && !lines[i - 1]?.trim().startsWith('|')) { tableHeader = true; return; } // header row
      tableHeader = false;
    } else tableHeader = false;
    const isBullet = /^\s*([-*+]|\d+\.)\s+\S/.test(line);
    if (!isTable && !isBullet) return;
    const tags = [...line.matchAll(TAG)];
    const st = { line: i + 1, section, text: line.trim().slice(0, 300), tags: tags.map((t) => t[1].toLowerCase().replace(' ', '-')), citations: [] };
    if (!tags.length) errors.push(`Line ${i + 1}: statement has no [Found: file:line], [Assumed] or [Ask team] tag`);
    for (const t of tags) {
      if (t[1].toLowerCase() !== 'found') continue;
      if (!t[2]) { errors.push(`Line ${i + 1}: [Found] without a file:line citation`); continue; }
      const cites = [...t[2].matchAll(CITE)];
      if (!cites.length) errors.push(`Line ${i + 1}: [Found: ${t[2]}] has no file:line citation`);
      for (const c of cites) {
        const [, file, from, to] = c;
        st.citations.push(`${file}:${from}${to ? `-${to}` : ''}`);
        const n = fileLines(file);
        if (n === null) errors.push(`Line ${i + 1}: cited file not found: ${file}`);
        else if (Number(to || from) > n || Number(from) < 1) errors.push(`Line ${i + 1}: ${file} has ${n} lines, cited ${from}${to ? `-${to}` : ''}`);
      }
    }
    statements.push(st);
  });

  // Flags the packet must address.
  if (inv?.flags) {
    for (const f of inv.flags.filter((f) => ['critical', 'high'].includes(f.severity))) {
      if (!text.includes(f.id)) errors.push(`Flag ${f.id} (${f.severity}: ${f.title}) is not addressed. Cite its ID where the packet covers it.`);
    }
    for (const f of inv.flags.filter((f) => f.severity === 'medium')) if (!text.includes(f.id)) warnings.push(`Medium flag ${f.id} (${f.title}) not mentioned.`);
    for (const p of inv.providers || []) if (!p.wrapper && !new RegExp(p.name.split(/[ (]/)[0], 'i').test(text)) warnings.push(`Provider not mentioned: ${p.name}`);
    for (const t of inv.agents?.tools || []) if (!t.test && !text.includes(t.name)) warnings.push(`Agent tool not mentioned: ${t.name}`);
    for (const m of inv.mcp?.configs || []) if (!text.includes(m.name)) warnings.push(`MCP server not mentioned: ${m.name}`);
  }

  // Secrets and wording.
  lines.forEach((line, i) => {
    for (const [kind, re] of SECRET_PATTERNS) {
      const m = line.match(re);
      if (m && !/EXAMPLE|\[redacted/.test(m[0])) errors.push(`Line ${i + 1}: looks like a secret value (${kind}). Name it, don't quote it.`);
    }
    if (/\b(blocker|blocking us|veto)\b/i.test(line)) warnings.push(`Line ${i + 1}: says "blocker" or "veto". Say security "has to sign off" or work is "waiting on security review".`);
    if (/\b(is|are|fully|now)\s+(compliant|certified)\b|\bcompliant with\b|\bguarantee[sd]?\b/i.test(line) && !/\bnot\b/i.test(line)) warnings.push(`Line ${i + 1}: reads as a compliance claim. Say what evidence exists and what is missing instead.`);
  });

  const count = (tag) => statements.filter((s) => s.tags.includes(tag)).length;
  const summary = { statements: statements.length, found: count('found'), assumed: count('assumed'), askTeam: count('ask-team'), untagged: statements.filter((s) => !s.tags.length).length };
  const out = { packet: args.packet, root: relative(process.cwd(), root) || '.', checkedAt: new Date().toISOString(), summary, errors, warnings, statements };
  const outPath = join(dirname(args.packet), 'packet.json');
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.error(`${summary.statements} statements: ${summary.found} found in code, ${summary.assumed} assumed, ${summary.askTeam} need an answer from the team.`);
  for (const e of errors) console.error(`ERROR  ${e}`);
  for (const w of warnings) console.error(`warn   ${w}`);
  console.error(errors.length ? `\n${errors.length} errors. Fix them and run again.` : `\nPacket passes. Wrote ${outPath}`);
  process.exit(errors.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
