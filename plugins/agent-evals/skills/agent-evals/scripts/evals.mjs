#!/usr/bin/env node
// Agent evals: a test harness for an AI agent or LLM app. Deterministic
// checks decide pass or fail; rubric checks ask a model and are labeled
// graded. Node 18+. No dependencies for the deterministic path.
//
//   node evals.mjs init     [--dir evals] [--suites all|name,name]
//   node evals.mjs run      [--config file] [--suite a,b] [--case id] [--repeats N]
//                           [--label name] [--no-graded] [--concurrency N] [--out dir]
//   node evals.mjs compare  <base> <head> [--threshold 0.1] [--out dir]
//   node evals.mjs list     [--config file]
//   node evals.mjs validate [--config file]

import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { findConfig, loadConfig, loadSuites, BUILTIN_SUITES, BUILTIN_SUITES_DIR, SKILL_DIR } from './lib/load.mjs';
import { describeTarget } from './lib/adapters.mjs';
import { runSuites } from './lib/run.mjs';
import { runReport, compareReport } from './lib/report.mjs';
import { compareRuns } from './lib/compare.mjs';
import { hasCredentials } from './lib/anthropic.mjs';
import { DEFAULT_JUDGE_MODEL } from './lib/judge.mjs';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const args = { _: [] };
  const flags = { 'no-graded': 'noGraded', help: 'help', h: 'help', force: 'force' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a === '-h') {
      const name = a.replace(/^-+/, '');
      if (flags[name]) args[flags[name]] = true;
      else args[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

const HELP = `agent-evals ${VERSION}

  init      Create evals/ with a config, an example case file and editable copies of the built-in suites
  run       Run the suites against the target; writes report.md and report.json into a new run folder
  compare   Compare two runs and exit 1 if a pass rate dropped more than --threshold
  list      List suites and cases
  validate  Check the config and every case without calling the target

Exit codes: 0 ok, 1 failures or regressions, 2 usage or config error.`;

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function cmdInit(args) {
  const dir = resolve(args.dir || 'evals');
  const pick = !args.suites || args.suites === 'all' ? BUILTIN_SUITES : args.suites.split(',').map((s) => s.trim());
  for (const s of pick) if (!BUILTIN_SUITES.includes(s)) throw new Error(`unknown suite "${s}" (built-in: ${BUILTIN_SUITES.join(', ')})`);
  await mkdir(join(dir, 'suites'), { recursive: true });
  await mkdir(join(dir, 'cases'), { recursive: true });
  const written = [];
  const put = async (path, content) => {
    if (existsSync(path) && !args.force) return;
    await writeFile(path, content);
    written.push(relative(process.cwd(), path));
  };
  const copy = async (from, to) => {
    if (existsSync(to) && !args.force) return;
    await copyFile(from, to);
    written.push(relative(process.cwd(), to));
  };
  await copy(join(SKILL_DIR, 'references', 'evals.config.example.yaml'), join(dir, 'evals.config.yaml'));
  await copy(join(BUILTIN_SUITES_DIR, 'correctness.example.yaml'), join(dir, 'cases', 'correctness.yaml'));
  for (const s of pick) await copy(join(BUILTIN_SUITES_DIR, `${s}.yaml`), join(dir, 'suites', `${s}.yaml`));
  await put(join(dir, '.gitignore'), 'runs/\n');
  console.log(written.length ? `Created:\n${written.map((w) => `  ${w}`).join('\n')}` : 'Nothing to create; files already exist (use --force to overwrite).');
  console.log(`\nNext: set "target" and "vars" in ${relative(process.cwd(), join(dir, 'evals.config.yaml'))}, write cases in cases/, then run:\n  node "${join(SKILL_DIR, 'scripts', 'evals.mjs')}" run --config ${relative(process.cwd(), join(dir, 'evals.config.yaml'))}`);
}

function selectSuites(all, args) {
  let suites = all;
  if (args.suite) {
    const want = args.suite.split(',').map((s) => s.trim());
    for (const w of want) if (!all.some((s) => s.name === w)) throw new Error(`no suite named "${w}" in this config (have: ${all.map((s) => s.name).join(', ')})`);
    suites = all.filter((s) => want.includes(s.name));
  }
  if (args.case) {
    const want = args.case.split(',').map((s) => s.trim());
    suites = suites.map((s) => ({ ...s, cases: s.cases.filter((c) => want.includes(c.id) || want.includes(`${s.name}/${c.id}`)) })).filter((s) => s.cases.length);
    if (!suites.length) throw new Error(`no case matches --case ${args.case}`);
  }
  return suites;
}

async function cmdRun(args) {
  const config = loadConfig(findConfig(args.config));
  const warnings = [];
  const suites = selectSuites(loadSuites(config, { warn: (w) => { warnings.push(w); console.error(`warning: ${w}`); } }), args);
  if (config.target?.type === 'anthropic' && !hasCredentials()) throw new Error('target type "anthropic" needs ANTHROPIC_API_KEY');
  const repeats = args.repeats ? Number(args.repeats) : null;
  const concurrency = Number(args.concurrency || config.concurrency || 4);
  const gradedCount = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + c.assert.filter((a) => a.type === 'rubric').length, 0), 0);
  const judge = config.judge || {};
  let graded = !args.noGraded && gradedCount > 0;
  let gradedReason = args.noGraded ? 'turned off with --no-graded' : '';
  if (graded && !hasCredentials()) {
    graded = false;
    gradedReason = 'ANTHROPIC_API_KEY is not set';
  }
  if (graded) {
    try { await import('@anthropic-ai/sdk'); } catch {
      graded = false;
      gradedReason = '@anthropic-ai/sdk is not installed (run "npm install" in the agent-evals scripts folder)';
    }
  }
  if (gradedCount && !graded) console.error(`Skipping ${gradedCount} graded (model-judged) checks: ${gradedReason}. Deterministic checks still run.`);

  const started = new Date();
  const runId = `${stamp(started)}${args.label ? `-${args.label.replace(/[^\w.-]+/g, '-')}` : ''}`;
  const runsDir = resolve(config.baseDir, config.runs_dir || 'runs');
  const out = resolve(args.out || join(runsDir, runId));
  const totalRuns = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + (repeats || c.repeats || config.repeats || 1), 0), 0);
  console.error(`Running ${suites.reduce((n, s) => n + s.cases.length, 0)} cases (${totalRuns} runs) against ${describeTarget(config.target)}`);

  const { cases, suites: summaries } = await runSuites({
    config,
    suites,
    repeats,
    graded,
    gradedReason,
    judge,
    concurrency,
    onProgress: (done, total) => { if (process.stderr.isTTY) process.stderr.write(`\r  ${done}/${total}`); },
  });
  if (process.stderr.isTTY) process.stderr.write('\n');

  const runsN = cases.reduce((a, c) => a + c.repeats, 0);
  const passesN = cases.reduce((a, c) => a + c.passes, 0);
  const totals = {
    cases: cases.length,
    runs: runsN,
    passes: passesN,
    pass_rate: runsN ? passesN / runsN : 0,
    pass: cases.filter((c) => c.status === 'pass').length,
    flaky: cases.filter((c) => c.status === 'flaky').length,
    fail: cases.filter((c) => c.status === 'fail').length,
    error: cases.filter((c) => c.status === 'error').length,
    below_threshold: cases.filter((c) => !c.meets_threshold).length,
    cost_usd: cases.flatMap((c) => c.runs).reduce((a, r) => a + (r.cost_usd || 0), 0),
  };
  const reps = [...new Set(cases.map((c) => c.repeats))];
  const data = {
    meta: {
      tool: `agent-evals ${VERSION}`,
      run_id: runId,
      label: args.label || null,
      started_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
      config: relative(out, config.path),
      target: describeTarget(config.target),
      repeats_note: reps.length === 1 ? `${reps[0]} per case` : `${Math.min(...reps)}–${Math.max(...reps)} per case`,
      graded: { enabled: graded, count: gradedCount, model: graded ? judge.model || DEFAULT_JUDGE_MODEL : null, reason: gradedReason || null },
      node: process.version,
      warnings,
    },
    totals,
    suites: summaries,
    cases,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(data, null, 2));
  await writeFile(join(out, 'report.md'), runReport(data));
  for (const s of summaries) console.log(`  ${s.name.padEnd(20)} ${String(Math.round(s.pass_rate * 100)).padStart(3)}%  ${s.pass} pass, ${s.flaky} flaky, ${s.fail} fail${s.error ? `, ${s.error} error` : ''}`);
  console.log(`${totals.below_threshold ? `${totals.below_threshold} of ${totals.cases} cases below threshold` : `All ${totals.cases} cases passed`}. Report: ${relative(process.cwd(), join(out, 'report.md'))}`);
  return totals.below_threshold ? 1 : 0;
}

// Accepts a run folder, a report.json path, or "latest" / "previous".
async function resolveRun(ref, args) {
  if (ref === 'latest' || ref === 'previous') {
    const config = loadConfig(findConfig(args.config));
    const runsDir = resolve(config.baseDir, config.runs_dir || 'runs');
    const dirs = existsSync(runsDir) ? (await readdir(runsDir)).filter((d) => existsSync(join(runsDir, d, 'report.json'))).sort() : [];
    const pick = ref === 'latest' ? dirs[dirs.length - 1] : dirs[dirs.length - 2];
    if (!pick) throw new Error(`no ${ref} run in ${runsDir}`);
    return join(runsDir, pick, 'report.json');
  }
  const p = resolve(ref);
  if (existsSync(p) && statSync(p).isDirectory()) return join(p, 'report.json');
  return p;
}

async function cmdCompare(args) {
  if (args._.length !== 2) throw new Error('usage: compare <base run> <head run> [--threshold 0.1]');
  const [bp, hp] = [await resolveRun(args._[0], args), await resolveRun(args._[1], args)];
  for (const p of [bp, hp]) if (!existsSync(p)) throw new Error(`no report.json at ${p}`);
  const threshold = args.threshold === undefined ? 0.1 : Number(args.threshold);
  if (!(threshold >= 0 && threshold <= 1)) throw new Error('--threshold is a pass-rate drop between 0 and 1, for example 0.1 for 10 points');
  const base = JSON.parse(await readFile(bp, 'utf8'));
  const head = JSON.parse(await readFile(hp, 'utf8'));
  const cmp = compareRuns(base, head, threshold);
  const out = resolve(args.out || dirname(hp));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'compare.json'), JSON.stringify(cmp, null, 2));
  await writeFile(join(out, 'compare.md'), compareReport(cmp));
  for (const r of cmp.regressions) console.log(`  regressed  ${r.kind} ${r.name}: ${Math.round(r.base * 100)}% -> ${Math.round(r.head * 100)}%`);
  for (const r of cmp.improvements) console.log(`  improved   ${r.name}: ${Math.round(r.base * 100)}% -> ${Math.round(r.head * 100)}%`);
  const edited = cmp.cases.filter((c) => c.edited).length;
  if (edited) console.log(`  note: ${edited} case(s) changed definition between the runs; their pass rates may reflect the test, not the agent`);
  console.log(`${cmp.regressions.length ? `${cmp.regressions.length} regression(s)` : 'No regressions'} at threshold ${threshold}. Report: ${relative(process.cwd(), join(out, 'compare.md'))}`);
  return cmp.regressions.length ? 1 : 0;
}

async function cmdList(args, { quiet = false } = {}) {
  const config = loadConfig(findConfig(args.config));
  const suites = loadSuites(config, { warn: (w) => console.error(`warning: ${w}`) });
  if (!config.target?.type) throw new Error('config: target.type is required (http, command or anthropic)');
  if (quiet) return suites;
  console.log(`Target: ${describeTarget(config.target)}`);
  for (const s of suites) {
    console.log(`\n${s.name}${s.builtin ? ' (built-in)' : ''}: ${s.cases.length} cases`);
    for (const c of s.cases) console.log(`  ${c.id.padEnd(32)} ${c.assert.map((a) => a.type).join(', ')}`);
  }
  return 0;
}

async function cmdValidate(args) {
  const suites = await cmdList(args, { quiet: true });
  const n = suites.reduce((a, s) => a + s.cases.length, 0);
  const graded = suites.reduce((a, s) => a + s.cases.reduce((m, c) => m + c.assert.filter((x) => x.type === 'rubric').length, 0), 0);
  console.log(`OK: ${suites.length} suites, ${n} cases, ${graded} graded checks.`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (!cmd || args.help) { console.log(HELP); return cmd ? 0 : 2; }
  const commands = { init: cmdInit, run: cmdRun, compare: cmdCompare, list: cmdList, validate: cmdValidate };
  if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n\n${HELP}`); return 2; }
  return (await commands[cmd](args)) ?? 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`error: ${err.message}`);
  process.exit(2);
});
