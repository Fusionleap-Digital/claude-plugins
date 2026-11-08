#!/usr/bin/env node
// Pre-deploy env check: finds every environment variable the code reads and
// compares that list with what the host has set. Reads names only; values
// are never printed or stored. Zero dependencies, Node 18+.
//
//   node env-check.mjs [repo-dir] [--host amplify|vercel|netlify]
//                      [--amplify-app <id>] [--branch main] [--names-file names.txt]
//                      [--build] [--out dir]

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative, basename, resolve } from 'node:path';
import { parseArgs, finding, sortFindings, summaryLine, hasBlocking, findingsTable, mdTable, writeReport, defaultOut, runCli, isMain, VERSION } from '../../../lib/common.mjs';

const USAGE = 'Usage: node env-check.mjs [repo-dir] [--host amplify|vercel|netlify] [--amplify-app <id>] [--branch main] [--names-file names.txt] [--build] [--out dir]';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'out', 'dist', 'build', 'coverage', '.vercel', '.netlify', '.amplify', '.turbo', '.cache', 'test', 'tests', '__tests__', '.npm']);
const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts)$/;
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.example', '.env.sample', '.env.template'];

// Set by the runtime or the host, never by you.
const PROVIDED = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'PORT', 'HOSTNAME', 'CI', 'TZ', 'PWD', 'HOME', 'PATH',
  'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF',
  'NETLIFY', 'CONTEXT', 'URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL', 'SITE_NAME', 'BRANCH', 'COMMIT_REF', 'BUILD_ID',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_APP_ID', 'AWS_BRANCH', 'AWS_JOB_ID', 'AWS_COMMIT_ID',
  'NEXT_PUBLIC_VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_URL', 'npm_package_version', 'npm_lifecycle_event']);

const SECRETISH = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|API_KEY|_KEY$|CREDENTIAL|CREDS|DATABASE_URL|SERVICE_ROLE)/;

// ---------- scan the code ----------
async function* walk(dir, root = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* walk(join(dir, e.name), root); }
    else if (CODE_EXT.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name)) yield join(dir, e.name);
  }
}

export function extractEnvReads(source) {
  const reads = [];
  const lines = source.split('\n');
  const add = (name, i, line) => reads.push({ name, line: i + 1, fallback: /^\s*(\|\||\?\?)/.test(line.slice(line.indexOf(name) + name.length).replace(/^['"\]]*/, '')) });
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(/(?:process\.env|import\.meta\.env)(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\])/g)) add(m[1] || m[2], i, line);
    // const { A, B: alias = 'x' } = process.env
    const d = line.match(/\{([^}]+)\}\s*=\s*process\.env\b/);
    if (d) for (const part of d[1].split(',')) {
      const name = part.trim().split(/[:=\s]/)[0];
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) reads.push({ name, line: i + 1, fallback: part.includes('=') });
    }
  });
  return reads;
}

const isServerFile = (rel, src) => /(^|\/)(app\/api|pages\/api|lib\/server|server)\/|route\.[jt]s$|middleware\.[jt]s$|actions?\.[jt]s$/.test(rel) || /^['"]use server['"]/m.test(src);

export async function scanRepo(repo) {
  const vars = new Map();
  for await (const file of walk(repo)) {
    const src = await readFile(file, 'utf8').catch(() => '');
    if (!src.includes('.env')) continue;
    const rel = relative(repo, file);
    for (const r of extractEnvReads(src)) {
      if (!vars.has(r.name)) vars.set(r.name, { name: r.name, uses: [], fallback: true, server: false });
      const v = vars.get(r.name);
      v.uses.push(`${rel}:${r.line}`);
      v.fallback &&= r.fallback;
      v.server ||= isServerFile(rel, src);
    }
  }
  return vars;
}

// Keys only: anything after "=" is dropped on the floor.
export function parseNames(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^export\s+/, '').split(/[=\s]/)[0]).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

async function localEnvFiles(repo) {
  const out = {};
  for (const f of ENV_FILES) {
    const text = await readFile(join(repo, f), 'utf8').catch(() => null);
    if (text !== null) out[f] = parseNames(text);
  }
  return out;
}

// ---------- host env names ----------
function run(cmd, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err && typeof err.code !== 'number' ? String(err.code || err) : null }));
  });
}

async function amplifyNames(appId, branch) {
  // JMESPath keys() returns names only, so values never leave AWS.
  const app = await run('aws', ['amplify', 'get-app', '--app-id', appId, '--query', '{env:keys(app.environmentVariables||`{}`),platform:app.platform,buildSpec:app.buildSpec}', '--output', 'json']);
  if (app.code) return { error: `aws amplify get-app failed: ${(app.stderr || app.error || '').trim().split('\n').pop()}` };
  const a = JSON.parse(app.stdout);
  let branchEnv = [];
  if (branch) {
    const b = await run('aws', ['amplify', 'get-branch', '--app-id', appId, '--branch-name', branch, '--query', 'keys(branch.environmentVariables||`{}`)', '--output', 'json']);
    if (!b.code) branchEnv = JSON.parse(b.stdout);
  }
  return { names: [...new Set([...a.env, ...branchEnv])], platform: a.platform, buildSpec: a.buildSpec, source: `aws amplify get-app ${appId}${branch ? ` + branch ${branch}` : ''}` };
}

async function vercelNames(repo) {
  const r = await run('vercel', ['env', 'ls', 'production'], { cwd: repo });
  if (r.code) return { error: `vercel env ls failed: ${(r.stderr || r.error || '').trim().split('\n').pop()}` };
  // Table rows start with the name; values are shown as "Encrypted".
  const names = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n) && n !== 'NAME');
  return { names, source: 'vercel env ls production' };
}

async function netlifyNames(repo) {
  const r = await run('netlify', ['env:list', '--json', '--context', 'production'], { cwd: repo });
  if (r.code) return { error: `netlify env:list failed: ${(r.stderr || r.error || '').trim().split('\n').pop()}` };
  return { names: Object.keys(JSON.parse(r.stdout || '{}')), source: 'netlify env:list --context production' };
}

// Amplify SSR (WEB_COMPUTE) only passes console env vars to the server at
// runtime if the build writes them into .env. Returns the names written.
export function buildSpecEnvWrites(spec) {
  if (!spec) return null;
  const names = new Set();
  for (const m of spec.matchAll(/echo\s+["']?([A-Z_][A-Z0-9_]*)=\$\{?\1\}?["']?\s*>>\s*\.env(\.production)?\b/g)) names.add(m[1]);
  if (/env\s*\|\s*grep[^\n]*>>\s*\.env/.test(spec)) names.add('*'); // env | grep -e A -e B >> .env (treat as covering)
  for (const m of spec.matchAll(/grep\s+[^\n|]*>>\s*\.env/g)) for (const n of m[0].matchAll(/-e\s+["']?\^?([A-Z_][A-Z0-9_]*)/g)) names.add(n[1]);
  return names;
}

// ---------- build ----------
async function runBuild(repo) {
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8').catch(() => '{}'));
  if (!pkg.scripts?.build) return { skipped: 'no build script in package.json' };
  const started = Date.now();
  const r = await run('npm', ['run', 'build'], { cwd: repo, timeout: 15 * 60_000 });
  const tail = (r.stdout + '\n' + r.stderr).split('\n').filter((l) => l.trim()).slice(-25)
    .map((l) => l.replace(/([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1[hidden]'));
  return { ok: r.code === 0, seconds: Math.round((Date.now() - started) / 1000), tail };
}

// ---------- main check ----------
export async function checkEnv(repo, opts = {}) {
  const findings = [];
  const vars = await scanRepo(repo);
  const local = await localEnvFiles(repo);
  const host = opts.host || (opts.amplifyApp ? 'amplify' : opts.namesFile ? 'file' : null);
  let hostInfo = null;
  if (opts.namesFile) hostInfo = { names: parseNames(await readFile(opts.namesFile, 'utf8')), source: basename(opts.namesFile) };
  else if (host === 'amplify') hostInfo = opts.amplifyApp ? await amplifyNames(opts.amplifyApp, opts.branch) : { error: 'Pass --amplify-app <app id> (aws amplify list-apps).' };
  else if (host === 'vercel') hostInfo = await vercelNames(repo);
  else if (host === 'netlify') hostInfo = await netlifyNames(repo);
  if (opts.buildSpec) hostInfo = { ...(hostInfo || {}), buildSpec: opts.buildSpec };
  if (!hostInfo?.buildSpec && host === 'amplify') hostInfo = { ...(hostInfo || {}), buildSpec: await readFile(join(repo, 'amplify.yml'), 'utf8').catch(() => null) };

  if (hostInfo?.error) findings.push(finding('review', 'host-env-unreadable', `${hostInfo.error} Check the host's env var list by hand with references/hosts.md.`));
  const hostNames = new Set(hostInfo?.names || []);
  const writes = host === 'amplify' ? buildSpecEnvWrites(hostInfo?.buildSpec) : null;
  const ssr = host === 'amplify' && (hostInfo?.platform ? hostInfo.platform === 'WEB_COMPUTE' : true);

  const rows = [];
  for (const v of [...vars.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (PROVIDED.has(v.name)) continue;
    const inHost = hostInfo?.names ? hostNames.has(v.name) : null;
    const inLocal = Object.entries(local).filter(([, n]) => n.includes(v.name)).map(([f]) => f);
    const where = v.uses[0] + (v.uses.length > 1 ? ` (+${v.uses.length - 1})` : '');
    rows.push([v.name, v.uses.length, v.server ? 'server' : 'any', v.fallback ? 'yes' : 'no', inHost === null ? '?' : inHost ? 'yes' : 'NO', inLocal.join(', ') || '-']);
    if (inHost === false) {
      findings.push(finding(v.fallback ? 'medium' : 'high', 'env-missing-in-host', `${v.name} is read by the code but not set in ${hostInfo.source}.${v.fallback ? ' The code has a fallback, so check the fallback is right for production.' : ' Expect an error or empty value in production.'}`, { where, name: v.name }));
    }
    if (inHost && ssr && writes && !writes.has('*') && !writes.has(v.name) && !v.name.startsWith('NEXT_PUBLIC_') && v.server) {
      findings.push(finding('high', 'amplify-env-not-in-dotenv', `${v.name} is set in Amplify but the build doesn't write it to .env. Amplify SSR only passes env vars to server code at runtime through that file, so the server sees it as empty. Add: echo "${v.name}=$${v.name}" >> .env`, { where, name: v.name }));
    }
    if (v.name.startsWith('NEXT_PUBLIC_') && SECRETISH.test(v.name.replace(/^NEXT_PUBLIC_/, ''))) {
      findings.push(finding('high', 'public-secret', `${v.name} looks like a secret, but NEXT_PUBLIC_ variables are copied into the browser bundle. Rename it and read it only on the server.`, { where, name: v.name }));
    }
    const example = local['.env.example'] || local['.env.sample'] || local['.env.template'];
    if (example && !example.includes(v.name)) findings.push(finding('low', 'env-undocumented', `${v.name} is read by the code but missing from the example env file, so the next person won't know to set it.`, { where, name: v.name }));
  }
  if (hostInfo?.names) {
    const read = new Set(vars.keys());
    for (const n of hostInfo.names) if (!read.has(n) && !PROVIDED.has(n) && !/^(AMPLIFY_|_|NEXT_TELEMETRY|NODE_OPTIONS|NPM_)/.test(n)) {
      findings.push(finding('info', 'env-unused-in-host', `${n} is set in the host but nothing in the code reads it. Leftover from a provider move? Remove it if unused.`, { name: n }));
    }
  }
  if (writes && writes.size && host === 'amplify') {
    findings.push(finding('info', 'amplify-redeploy-needed', `The build writes ${writes.has('*') ? 'env vars' : writes.size + ' env vars'} into .env, so changing one in the Amplify console has no effect until the next build. Redeploy after every env change.`));
  }
  if (opts.build) {
    const b = await runBuild(repo);
    if (b.skipped) findings.push(finding('review', 'build', `Build not run: ${b.skipped}.`));
    else if (!b.ok) findings.push(finding('high', 'build-failed', `npm run build failed after ${b.seconds}s. Last lines:\n${b.tail.slice(-8).join(' / ')}`, { tail: b.tail }));
    else findings.push(finding('pass', 'build', `npm run build passed in ${b.seconds}s.`));
  }
  if (!findings.some((f) => f.check.startsWith('env-missing') || f.check.startsWith('amplify-env')) && hostInfo?.names) {
    findings.push(finding('pass', 'env-host', `Every variable the code reads is set in ${hostInfo.source}.`));
  }
  sortFindings(findings);
  return {
    meta: { tool: 'env-check', version: VERSION, repo, host: host || 'not checked', hostSource: hostInfo?.source || null, checked: new Date().toISOString(), variables: rows.length },
    variables: rows.map(([name, uses, side, fallback, inHost, local]) => ({ name, uses, side, fallback, inHost, local })),
    findings,
    summary: summaryLine(findings),
  };
}

function toMarkdown(r) {
  const problems = r.findings.filter((f) => f.severity !== 'pass');
  return [
    `# Env check: ${basename(resolve(r.meta.repo))}`,
    '',
    `- Checked: ${r.meta.checked}`,
    `- Host list: ${r.meta.hostSource || 'not checked (pass --host, --amplify-app or --names-file)'}`,
    `- Result: ${r.summary}`,
    '',
    '## Variables the code reads',
    '',
    'Names only. Values are never read from the host or printed.',
    '',
    mdTable(['Name', 'Uses', 'Where read', 'Has fallback', 'Set in host', 'Local env files'], r.variables.map((v) => [v.name, v.uses, v.side, v.fallback, v.inHost, v.local])),
    '## Findings',
    '',
    problems.length ? findingsTable(problems) : 'None.\n',
    ...r.findings.filter((f) => f.severity === 'pass').map((f) => `- Passed: ${f.detail}`),
    '',
  ].join('\n');
}

if (isMain(import.meta)) {
  runCli(USAGE, async () => {
    const args = parseArgs(process.argv.slice(2), { host: 'string', amplifyApp: 'string', branch: 'string', namesFile: 'string', build: 'boolean', out: 'string' });
    if (args.help) { console.log(USAGE); return 0; }
    const repo = args._[0] || '.';
    if (!(await stat(repo).catch(() => null))?.isDirectory()) throw new Error(`Not a directory: ${repo}`);
    const report = await checkEnv(repo, args);
    const path = await writeReport(args.out || defaultOut('env', basename(resolve(repo)) || 'repo'), report, toMarkdown(report));
    console.error(`Done: ${report.summary}. ${report.meta.variables} variables read by the code. Report: ${path}`);
    return hasBlocking(report.findings) ? 1 : 0;
  });
}
