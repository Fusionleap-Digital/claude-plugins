#!/usr/bin/env node
// Security review inventory: reads an AI system's repo (and optional IaC
// folder) and writes the facts a security review packet needs. Read-only.
// Never prints secret values. Node 18+, no dependencies.
//
//   node inventory.mjs <repo> [--iac <dir>] [--out <dir>] [--no-audit]

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, basename, join } from 'node:path';
import { loadRepo } from './lib/files.mjs';
import { scanDependencies } from './lib/deps.mjs';
import { scanModels, scanProviders, scanDatastores, scanVendors, scanSecretManagers, scanHosts, scanDataHandling, scanDataTerms, scanEnv, scanControls } from './lib/code.mjs';
import { scanRoutes } from './lib/routes.mjs';
import { scanTools, scanCustomRouters, scanHostedTools, scanAgentConfig, scanMcp } from './lib/agents.mjs';
import { scanIac } from './lib/iac.mjs';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const args = { audit: true, iac: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iac') args.iac.push(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-audit') args.audit = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.repo = rest[0];
  return args;
}

const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const loc = (r) => (r ? `${r.file}:${r.line}` : null);

// Deterministic flags: things the packet must address. Claude decides how
// to word them; the check script makes sure each critical/high one appears.
function buildFlags(inv) {
  const flags = [];
  const add = (severity, area, title, where, detail) => flags.push({ severity, area, title, where: where.filter(Boolean).slice(0, 8), detail });
  const prod = (x) => !x.test;

  const realSecrets = inv.env.hardcodedSecrets.filter((s) => !s.placeholder);
  for (const s of realSecrets.filter(prod)) add('critical', 'secrets', `Possible ${s.kind} in source`, [`${s.file}:${s.line}`], 'Value not shown. Treat as leaked: rotate it, then move it to a secrets store.');
  for (const s of realSecrets.filter((x) => x.test)) add('low', 'secrets', `Possible ${s.kind} in a test file`, [`${s.file}:${s.line}`], 'Confirm it is a fake value.');
  for (const e of inv.env.envFiles.filter((e) => e.tracked && !e.template)) {
    add(e.secretNamesWithValues?.length ? 'critical' : 'high', 'secrets', `Env file committed to git: ${e.path}`, [e.path],
      e.secretNamesWithValues?.length ? `Has values for ${e.secretNamesWithValues.length} secret-like names (${e.secretNamesWithValues.slice(0, 5).join(', ')}). Rotate them and remove the file from git history.` : 'Remove it from git and add it to .gitignore.');
  }
  for (const v of inv.env.vars.filter((v) => v.browserExposed && v.secretLike)) add('medium', 'secrets', `Secret-like name exposed to the browser: ${v.name}`, v.refs.slice(0, 3), 'Public-prefixed env vars are bundled into client code. Confirm it is meant to be public (a publishable or write-only key), not a secret.');

  const routes = inv.routes.items.filter(prod);
  const open = routes.filter((r) => r.auth.status === 'none-found');
  const llmFiles = new Set([...inv.providers.flatMap((p) => p.evidence.map((e) => e.file)), ...inv.agents.tools.map((t) => t.file)]);
  for (const r of open) {
    if (/(^|\/)(health|healthz|ping|ready|readyz|live|livez|status|version)$/.test(r.path)) { add('info', 'access', `Public health/status route ${r.method} ${r.path}`, [`${r.file}:${r.line}`], 'Check it returns nothing sensitive.'); continue; }
    const sensitive = /chat|ask|complete|generate|agent|ingest|upload|embed|admin|search|query|tool|rag|llm|ai\b|assistant|webhook/i.test(r.path);
    add(sensitive ? 'high' : 'medium', 'access', `No auth check found on ${r.method} ${r.path}`, [`${r.file}:${r.line}`],
      sensitive ? 'Route looks like it reaches the model, the index or uploads. Confirm it is meant to be public, or add an auth check.' : 'Confirm it is meant to be public.');
  }
  const viaMw = routes.filter((r) => r.auth.status === 'middleware');
  if (viaMw.length && inv.routes.middleware) {
    const mw = inv.routes.middleware;
    add(mw.cookieOnly ? 'medium' : 'low', 'access', `${viaMw.length} API routes have no auth check of their own; only the middleware matcher covers them`, [loc(mw.authRef) || mw.file, ...viaMw.slice(0, 4).map((r) => `${r.file}:${r.line}`)],
      `${mw.cookieOnly ? 'The middleware checks that a session cookie exists, not that it is valid, so a forged cookie passes. ' : ''}Read the middleware: it may exempt some of these on purpose (webhooks, telemetry). For the rest, validate the session in the route. Middleware-only auth has had bypasses (for example CVE-2025-29927 in Next.js before 14.2.25 / 15.2.3).`);
  }
  for (const a of inv.routes.serverActions.filter((a) => a.auth.status === 'none-found' && !a.test)) add('medium', 'access', `No auth check found in server action ${a.name}`, [`${a.file}:${a.line}`], 'Server actions are public POST endpoints.');

  for (const t of inv.agents.tools.filter(prod)) {
    const c = Object.keys(t.capabilities);
    const risky = c.filter((x) => ['shell', 'codeEval', 'arbitrarySql', 'payments', 'sendMessage', 'fileWrite', 'dbWrite'].includes(x));
    const strong = t.humanApproval?.strength === 'framework-approval';
    if (risky.length && !strong) add(['shell', 'codeEval', 'arbitrarySql', 'payments'].some((x) => risky.includes(x)) ? 'high' : 'medium', 'agent-tools',
      `Tool "${t.name}" can ${risky.join(', ')} with no approval step found`, [`${t.file}:${t.line}`, ...risky.map((x) => loc(t.capabilities[x]))],
      t.humanApproval ? `Only an approval keyword was found (${loc(t.humanApproval)}); confirm a person approves before it runs.` : 'A prompt injection could make the model call this tool.');
    if (c.includes('network') && inv.hosts.dynamicCalls.some((d) => d.file === t.file && d.line >= t.line && d.line < t.line + 80)) {
      add('medium', 'agent-tools', `Tool "${t.name}" fetches a URL chosen at run time`, [`${t.file}:${t.line}`, loc(t.capabilities.network)], 'Check for an allowlist: this is an SSRF and data-exfiltration path.');
    }
  }
  for (const s of inv.agents.config.filter((s) => /bypassPermissions|dangerously/.test(s.snippet))) add('high', 'agent-tools', 'Agent permissions bypassed', [`${s.file}:${s.line}`], 'Tools run without permission checks.');
  for (const m of inv.mcp.configs) {
    if (m.transport === 'stdio' && m.command && /^(npx|uvx|bunx|pnpm)$/.test(m.command) && !m.pinnedVersion) add('medium', 'mcp', `MCP server "${m.name}" runs an unpinned package`, [`${m.file}:${m.line}`], `\`${m.command} ${(m.args || []).join(' ')}\` fetches the latest version at start-up.`);
  }

  const logs = inv.dataHandling.promptLogging.filter((r) => r.file && !r.test);
  if (logs.length) add('medium', 'logging', 'Prompts or model output written to logs', logs.slice(0, 5).map(loc), 'Logs may then hold user data and need the same retention and access rules as the database.');
  for (const v of inv.vendors.filter((v) => v.receivesPrompts && v.confidence !== 'test-only')) add('info', 'vendors', `${v.name} may receive prompts or documents`, v.evidence.slice(0, 2).map(loc), 'Add to the sub-processor list and confirm its retention.');

  for (const r of inv.iac.resources) {
    if (r.encryption?.status === 'disabled') add('high', 'infrastructure', `Encryption turned off on ${r.type}.${r.name}`, [`${r.file}:${r.line}`], '');
    else if (r.encryption?.status === 'not-declared') add('low', 'infrastructure', `No explicit encryption setting on ${r.type}.${r.name}`, [`${r.file}:${r.line}`], `Provider default: ${r.encryption.providerDefault || 'check provider docs'}.`);
    for (const e of r.exposure || []) if (/no aws_s3_bucket_public_access_block/.test(e)) add('low', 'infrastructure', `${r.type}.${r.name}: ${e}`, [`${r.file}:${r.line}`], ''); else add(/0\.0\.0\.0|publicly|public-read|PublicRead|NONE/.test(e) ? 'high' : 'medium', 'infrastructure', `${r.type}.${r.name}: ${e}`, [`${r.file}:${r.line}`], '');
    for (const k of Object.keys(r.attrs || {}).filter((k) => k.startsWith('hardcoded:'))) add('critical', 'secrets', `Literal ${k.slice(10)} in ${r.type}.${r.name}`, [`${r.file}:${r.line}`], 'Value not shown. Move it to a variable fed from a secrets store, and rotate it.');
  }
  for (const s of inv.iac.terraform?.stateFiles || []) if (s.tracked) add('critical', 'secrets', `Terraform state committed: ${s.path}`, [s.path], 'State files hold resource secrets in plain text.');
  for (const s of inv.iac.terraform?.tfvars || []) if (s.tracked) add('medium', 'secrets', `tfvars file committed: ${s.path}`, [s.path], 'Check it holds no secrets.');
  if (inv.iac.amplify?.teamProviderInfo?.tracked) add('medium', 'secrets', 'amplify/team-provider-info.json is committed', [inv.iac.amplify.teamProviderInfo.path], 'It can hold auth secrets for social sign-in.');
  for (const p of inv.iac.amplify?.publicAccess || []) add('medium', 'access', 'Amplify data or storage allows public (API key or guest) access', [loc(p)], 'Confirm which models or paths this covers.');
  const usesBedrock = inv.providers.some((p) => p.id === 'bedrock');
  if (usesBedrock && inv.iac.tools.includes('terraform') && !inv.iac.resources.some((r) => r.type === 'aws_bedrock_model_invocation_logging_configuration')) {
    add('info', 'logging', 'Bedrock model invocation logging is not configured in Terraform', [], 'Without it there is no AWS-side record of prompts and responses. Decide whether you want one.');
  }

  for (const a of inv.dependencies.audit.npm.filter((a) => a.ran)) {
    const c = a.counts || {};
    if (c.critical || c.high) add(c.critical ? 'high' : 'medium', 'dependencies', `npm audit: ${c.critical || 0} critical, ${c.high || 0} high in ${a.manifest}`, [a.manifest], (a.vulnerabilities || []).filter((v) => ['critical', 'high'].includes(v.severity)).slice(0, 6).map((v) => `${v.package} (${v.severity})`).join(', '));
  }
  for (const a of inv.dependencies.audit.pip.filter((a) => a.ran && a.vulnerabilities.length)) add('medium', 'dependencies', `pip-audit: ${a.vulnerabilities.length} known vulnerabilities in ${a.manifest}`, [a.manifest], [...new Set(a.vulnerabilities.map((v) => v.package))].slice(0, 6).join(', '));
  const copyleft = [...inv.dependencies.node.copyleft.filter((c) => !c.dev), ...inv.dependencies.python.copyleft];
  if (copyleft.length) add('low', 'dependencies', `${copyleft.length} runtime dependencies with copyleft or source-available licenses`, [], copyleft.slice(0, 8).map((c) => `${c.name} (${c.license})`).join(', '));

  if (!inv.controls.rateLimit.length && (inv.providers.some((p) => !p.wrapper && !p.local) || routes.length)) add('medium', 'abuse', 'No rate limiting found', [], 'Model calls cost money per request; check the hosting layer (WAF, API gateway) if not in code.');
  if (inv.agents.tools.length && !inv.controls.tokenAndStepLimits.length) add('low', 'abuse', 'No step or token limit found on the agent loop', [], '');

  flags.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  flags.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(3, '0')}`; });
  return flags;
}

function md(inv) {
  const L = [];
  const p = (...x) => L.push(...x);
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const where = (refs) => (refs || []).filter((r) => r.file).slice(0, 3).map((r) => `\`${r.file}:${r.line}\``).join(', ');
  const m = inv.meta;
  p(`# Inventory: ${m.repoName}`, '', `- Scanned: ${m.scannedAt} by security-review-packet ${m.version}`,
    `- Root: \`${m.root}\`${m.git ? ` (git ${m.git.branch}@${m.git.commit}${m.git.dirty ? ', uncommitted changes' : ''})` : ' (not a git repo)'}`,
    `- Files read: ${m.filesRead}${m.iacRoots.length ? `; IaC: ${m.iacRoots.map((r) => `\`${r}\``).join(', ')}` : ''}`,
    `- Languages: ${m.languages.join(', ') || 'none detected'}`, '');
  const counts = SEV.map((s) => [s, inv.flags.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  p('## Flags', '', counts.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : 'None.', '');
  if (inv.flags.length) {
    p('| ID | Severity | Area | Flag | Where |', '|---|---|---|---|---|');
    for (const f of inv.flags) p(`| ${f.id} | ${f.severity} | ${f.area} | ${esc(f.title)}${f.detail ? ` — ${esc(f.detail)}` : ''} | ${f.where.map((w) => `\`${w}\``).join(', ')} |`);
    p('');
  }
  p('## Model providers', '', '| Provider | Confidence | Evidence | Env vars |', '|---|---|---|---|');
  for (const x of inv.providers) p(`| ${esc(x.name)} | ${x.confidence} | ${where(x.evidence) || x.dependencies.join(', ')} | ${x.envVars?.join(', ') || ''} |`);
  p('', '## Model IDs', '');
  for (const x of inv.models) p(`- \`${x.id}\` (${x.family}): ${where(x.refs)}`);
  p('', '## Data stores', '', '| Store | Category | Evidence |', '|---|---|---|');
  for (const x of inv.datastores) p(`| ${esc(x.name)} | ${x.category} | ${where(x.evidence) || x.dependencies.join(', ')} |`);
  p('', '## Vendors and services', '', '| Vendor | Category | Gets prompts? | Evidence |', '|---|---|---|---|');
  for (const x of inv.vendors) p(`| ${esc(x.name)} | ${x.category} | ${x.receivesPrompts ? 'likely' : ''} | ${where(x.evidence) || x.dependencies.join(', ')} |`);
  p('', '## Outbound hosts', '', 'Called from code (URL on a line with a fetch/HTTP call) or implied by an SDK:', '');
  for (const h of inv.hosts.hosts.filter((h) => h.called || h.source !== 'literal')) p(`- \`${h.host}\` (${h.called ? 'called' : h.source})${h.refs.length ? `: ${where(h.refs)}` : ''}`);
  const mentioned = inv.hosts.hosts.filter((h) => !h.called && h.source === 'literal' && !h.testOnly);
  if (mentioned.length) p('', `Mentioned but no call seen on the same line (${mentioned.length}; check any that receive data): ${mentioned.slice(0, 40).map((h) => `\`${h.host}\``).join(', ')}${mentioned.length > 40 ? ' …' : ''}`);
  if (inv.hosts.dynamicCalls.length) p('', `Calls to URLs built at run time: ${where(inv.hosts.dynamicCalls.filter((r) => r.file).slice(0, 6))}${inv.hosts.dynamicCalls.length > 3 ? ' …' : ''}`);
  p('', '## Where prompts, logs and embeddings go', '');
  for (const [k, v] of Object.entries(inv.dataHandling)) p(`- **${k}**: ${v.filter((r) => r.file).length ? where(v) : 'none found'}`);
  p('', '## API routes', '', inv.routes.middleware ? `Middleware: \`${inv.routes.middleware.file}\`, matchers ${JSON.stringify(inv.routes.middleware.matchers)}, auth ${inv.routes.middleware.hasAuth ? 'yes' : 'not found'}` : 'No Next.js middleware.', '',
    '| Method | Path | Auth | Where |', '|---|---|---|---|');
  for (const r of inv.routes.items) p(`| ${r.method} | \`${r.path}\` | ${r.auth.status}${r.auth.kind ? ` (${r.auth.kind})` : ''}${r.auth.ref ? ` \`${r.auth.ref.file}:${r.auth.ref.line}\`` : ''} | \`${r.file}:${r.line}\` |`);
for (const a of inv.routes.serverActions) p(`| action | ${a.name} | ${a.auth.status} | \`${a.file}:${a.line}\` |`);
  p('', '## Agent tools', '', '| Tool | Framework | Can | Approval step | Where |', '|---|---|---|---|---|');
  for (const t of inv.agents.tools) p(`| ${t.name} | ${t.framework} | ${Object.keys(t.capabilities).join(', ') || 'nothing detected'} | ${t.humanApproval ? `${t.humanApproval.strength} \`${t.humanApproval.file}:${t.humanApproval.line}\`` : 'none found'} | \`${t.file}:${t.line}\`${t.handler ? `, handler \`${t.handler}\`` : ''} |`);
  if (inv.agents.hostedTools.filter((r) => r.file).length) p('', `Provider-hosted tools (run on the model provider's side): ${inv.agents.hostedTools.filter((r) => r.file).slice(0, 6).map((r) => `${r.tool} \`${r.file}:${r.line}\``).join(', ')}`);
  p('', '## MCP servers', '');
  for (const s of inv.mcp.configs) p(`- **${s.name}** (${s.transport}) ${s.command ? `\`${s.command} ${(s.args || []).join(' ')}\`` : s.url ? `\`${s.url}\`` : ''}${s.envNames.length ? `, env: ${s.envNames.join(', ')}` : ''} — \`${s.file}:${s.line}\``);
  for (const c of inv.mcp.code.filter((c) => c.file)) p(`- in code (${c.role}, ${c.api}): \`${c.file}:${c.line}\``);
  if (!inv.mcp.configs.length && !inv.mcp.code.length) p('None found.');
  p('', '## Secrets and env vars', '', `Secret stores: ${inv.secretManagers.map((s) => s.name).join(', ') || 'none found'}`, '');
  for (const e of inv.env.envFiles) p(`- \`${e.path}\`: ${e.tracked ? '**tracked by git**' : e.ignored ? 'ignored by git' : 'untracked'}${e.template ? ' (template)' : ''}${e.names.length ? `, ${e.names.length} names` : ''}`);
  p('', `Secret-like names: ${inv.env.vars.filter((v) => v.secretLike).map((v) => `\`${v.name}\``).join(', ') || 'none'}`, '');
  p(`Other names: ${inv.env.vars.filter((v) => !v.secretLike).map((v) => `\`${v.name}\``).join(', ') || 'none'}`, '');
  p('## Infrastructure', '', `Tools: ${inv.iac.tools.join(', ') || 'none found'}. Regions: ${inv.iac.regions.join(', ') || 'none declared'}.`, '');
  if (inv.iac.resources.length) {
    p('| Resource | Region | Encryption | Exposure | Where |', '|---|---|---|---|---|');
    for (const r of inv.iac.resources) p(`| ${r.type}.${r.name} | ${esc(r.region || '')} | ${r.encryption ? `${r.encryption.status}${r.encryption.declared?.length ? ` (${r.encryption.declared.join(', ')})` : ''}` : 'n/a'} | ${esc((r.exposure || []).join('; '))} | \`${r.file}:${r.line}\` |`);
  }
  p('', '## Controls found (signals, not proof)', '');
  for (const [k, v] of Object.entries(inv.controls)) p(`- **${k}**: ${v.filter((r) => r.file).length ? where(v) : 'none found'}`);
  p('', '## Data classification hints', '');
  for (const [k, v] of Object.entries(inv.dataTerms)) p(`- **${k}**: ${v.hits} lines${v.hits ? ` (${Object.entries(v.terms).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ×${n}`).join(', ')}), e.g. ${where(v.refs)}` : ''}`);
  const d = inv.dependencies;
  p('', '## Dependencies', '', `Node: ${d.node.direct.length} direct in ${d.node.manifests.length} manifests. Python: ${d.python.direct.length} direct in ${d.python.manifests.length} manifests.`, '');
  for (const a of d.audit.npm) p(`- npm audit \`${a.manifest}\`: ${a.ran ? JSON.stringify(a.counts) : `not run (${a.reason})`}`);
  for (const a of d.audit.pip) p(`- pip-audit \`${a.manifest}\`: ${a.ran ? `${a.vulnerabilities.length} vulnerabilities` : `not run (${a.reason})`}`);
  const lic = Object.entries(d.node.licenseSummary).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (lic.length) p(`- npm licenses (all packages in lockfile): ${lic.map(([l, n]) => `${l} ×${n}`).join(', ')}`);
  if (d.python.direct.length) p(`- Python licenses: ${d.python.licensesFrom ? Object.entries(d.python.licenseSummary).map(([l, n]) => `${l} ×${n}`).join(', ') : 'not read (no local virtualenv found)'}`);
  p('', '## Not covered by this scan', '', ...inv.meta.notCovered.map((x) => `- ${x}`), '');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo) {
    console.log('Usage: node inventory.mjs <repo> [--iac <dir>]... [--out <dir>] [--no-audit]');
    process.exit(args.help ? 0 : 2);
  }
  const root = resolve(args.repo);
  if (!existsSync(root)) { console.error(`Not found: ${args.repo}`); process.exit(2); }
  console.error(`Reading ${root} …`);
  const repo = await loadRepo(root);
  const iacRoots = [];
  for (const dir of args.iac) {
    const abs = resolve(dir);
    const rel = relative(root, abs);
    if (!rel.startsWith('..') && rel !== '') continue; // already inside the repo
    const extra = await loadRepo(abs);
    for (const f of extra.files) { f.path = `${basename(abs)}/${f.path}`; repo.files.push(f); }
    for (const p of extra.tracked) repo.tracked.add(`${basename(abs)}/${p}`);
    repo.allPaths.push(...extra.allPaths.map((p) => `${basename(abs)}/${p}`));
    iacRoots.push(abs);
  }
  const files = repo.files;

  const deps = scanDependencies(root, repo, { audit: args.audit });
  const env = scanEnv(files, repo);
  const envNames = new Set(env.vars.map((v) => v.name));
  const providers = scanProviders(files, deps.names, envNames);
  const inv = {
    meta: {
      tool: 'security-review-packet', version: VERSION, scannedAt: new Date().toISOString(),
      repoName: basename(root), root: relative(process.cwd(), root) || '.', iacRoots: iacRoots.map((r) => relative(process.cwd(), r)),
      git: repo.git, filesRead: files.length, truncated: repo.truncated || undefined, skippedLarge: repo.skippedLarge || undefined,
      languages: [files.some((f) => /\.[cm]?tsx?$/.test(f.path)) && 'typescript', files.some((f) => /\.[cm]?jsx?$/.test(f.path)) && 'javascript', files.some((f) => f.path.endsWith('.py')) && 'python', files.some((f) => f.path.endsWith('.tf')) && 'terraform'].filter(Boolean),
      audit: args.audit ? 'npm audit / pip-audit ran where possible (sends package names and versions to the registry)' : 'skipped (--no-audit)',
      notCovered: [
        'Code behind dynamic imports, generated clients or other repos (shared libraries, infra repos not passed with --iac).',
        'Cloud console settings not in code: account-level S3 public access block, Bedrock/OpenAI org settings, IAM outside IaC, WAF rules.',
        'Vendor contract terms (retention, training use, BAA/DPA). These need an answer from the team.',
        'Whether the controls found actually work. A rate limiter that is imported is not proof it is applied to every route.',
        'Runtime behavior: prompts, tool calls and logs in production.',
      ],
    },
    providers,
    models: scanModels(files),
    datastores: scanDatastores(files, deps.names),
    vendors: scanVendors(files, deps.names),
    secretManagers: scanSecretManagers(files, deps.names),
    hosts: null,
    dataHandling: scanDataHandling(files),
    dataTerms: scanDataTerms(files),
    env,
    routes: scanRoutes(files),
    agents: { tools: [], hostedTools: scanHostedTools(files), config: scanAgentConfig(files) },
    mcp: scanMcp(files),
    iac: scanIac(files, repo),
    controls: scanControls(files),
    dependencies: { node: deps.node, python: deps.python, audit: deps.audit },
    flags: [],
  };
  inv.agents.tools = scanTools(files);
  inv.agents.tools.push(...scanCustomRouters(files, inv.agents.tools));
  inv.hosts = scanHosts(files, providers);
  inv.flags = buildFlags(inv);

  const out = args.out || `security-review-packet-${basename(root)}`;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'inventory.json'), JSON.stringify(inv, null, 2));
  await writeFile(join(out, 'inventory.md'), md(inv));
  const c = SEV.map((s) => [s, inv.flags.filter((f) => f.severity === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ');
  console.error(`Done: ${files.length} files, ${inv.providers.length} providers, ${inv.routes.items.length} routes, ${inv.agents.tools.length} tools, ${inv.mcp.configs.length} MCP servers, ${inv.iac.resources.length} IaC resources. Flags: ${c || 'none'}.\nWrote ${join(out, 'inventory.json')} and inventory.md`);
}

main().catch((err) => { console.error(err); process.exit(1); });
