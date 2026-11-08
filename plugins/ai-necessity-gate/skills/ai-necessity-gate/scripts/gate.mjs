#!/usr/bin/env node
// Apply the AI Necessity Gate rubric (references/rubric.md) to a scored gate.json.
// Claude scores the criteria and writes the narrative; this script adds up the
// scores, applies the verdict rules, sets the risk level, and renders gate.md.
//
//   node gate.mjs path/to/gate.json [--out gate.md]
//
// Always prints the verdict and writes it to gate.json under "result".
// Exit 0: gate.md written. Exit 2: scores are valid but narrative fields are
// missing (listed). Exit 1: invalid input.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const VERSION = '1.0.0';

export const TESTS = {
  simplicity: ['input', 'rules', 'output', 'alternative'],
  clarity: ['value', 'volume', 'owner', 'wrong_answer'],
  data: ['availability', 'quality', 'access', 'sensitivity'],
};
const ALTERNATIVES = { rules: 'Rules', search: 'Search', report: 'A report', form: 'A form', process: 'A process change', integration: 'A system integration', none: 'Nothing simpler' };
const FLAGS = ['decisions_about_people', 'regulated_data', 'unreviewed_external_output', 'personal_data', 'money_movement'];

export const VERDICTS = {
  go: 'Go',
  go_after_fixing_data: 'Go after fixing data',
  not_ai: 'Not AI',
  not_yet: 'Not yet',
};

export function evaluate(g) {
  const errors = [];
  const totals = {};
  for (const [test, criteria] of Object.entries(TESTS)) {
    let total = 0;
    for (const c of criteria) {
      const s = g[test]?.[c]?.score;
      if (![0, 1, 2].includes(s)) errors.push(`${test}.${c}.score must be 0, 1 or 2`);
      else total += s;
      if (typeof g[test]?.[c]?.evidence !== 'string' || !g[test][c].evidence.trim()) errors.push(`${test}.${c}.evidence is missing (write "not known" if nobody knows)`);
    }
    totals[test] = total;
  }
  if (!ALTERNATIVES[g.alternative?.best]) errors.push(`alternative.best must be one of ${Object.keys(ALTERNATIVES).join(', ')}`);
  for (const f of FLAGS) if (typeof g.risk?.flags?.[f] !== 'boolean') errors.push(`risk.flags.${f} must be true or false`);
  if (errors.length) return { errors };

  const s = (t, c) => g[t][c].score;
  const simplicity = totals.simplicity >= 4 && s('simplicity', 'alternative') > 0;
  const clarity = totals.clarity >= 5 && s('clarity', 'value') >= 1 && s('clarity', 'owner') >= 1;
  const dataPass = totals.data >= 7 && TESTS.data.every((c) => s('data', c) > 0);
  const dataFixable = !dataPass && s('data', 'availability') >= 1 && s('data', 'access') >= 1;

  let verdict, rule;
  if (!simplicity) [verdict, rule] = ['not_ai', 1];
  else if (!clarity) [verdict, rule] = ['not_yet', 2];
  else if (dataPass) [verdict, rule] = ['go', 3];
  else if (dataFixable) [verdict, rule] = ['go_after_fixing_data', 4];
  else [verdict, rule] = ['not_yet', 5];

  const f = g.risk.flags;
  const risk = f.decisions_about_people || f.regulated_data || f.unreviewed_external_output ? 'high' : f.personal_data || f.money_movement ? 'medium' : 'low';
  const review = {
    high: 'A person reviews every output in the first build.',
    medium: 'A person reviews outputs below a confidence threshold, plus a sample of the rest.',
    low: 'Spot checks are enough.',
  }[risk];

  return {
    result: {
      rubric_version: VERSION,
      verdict,
      verdict_label: VERDICTS[verdict],
      rule,
      scores: totals,
      max_per_test: 8,
      tests: {
        simplicity: simplicity ? 'needs_ai' : 'pipeline_will_do',
        clarity: clarity ? 'pass' : 'fail',
        data: dataPass ? 'pass' : dataFixable ? 'fixable' : 'not_ready',
      },
      data_verified: g.data.profiled === true,
      risk_level: risk,
      human_review: review,
    },
  };
}

function missingNarrative(g, verdict) {
  const m = [];
  const str = (v) => typeof v === 'string' && v.trim();
  if (!str(g.use_case?.name)) m.push('use_case.name');
  if (!str(g.use_case?.summary)) m.push('use_case.summary');
  if (!Array.isArray(g.reasons) || !g.reasons.length || !g.reasons.every(str)) m.push('reasons (3 to 5 sentences)');
  if (!Array.isArray(g.top_risks) || g.top_risks.length !== 3 || !g.top_risks.every((r) => str(r.risk) && str(r.mitigation))) m.push('top_risks (exactly 3, each with risk and mitigation)');
  if (!str(g.first_build?.scope) || !str(g.first_build?.left_out)) m.push('first_build.scope and first_build.left_out');
  for (const k of ['metric', 'baseline', 'target', 'check_by']) if (!str(g.measure?.[k])) m.push(`measure.${k}`);
  if (!str(g.alternative?.description)) m.push('alternative.description');
  if (!Array.isArray(g.risk?.sign_off) || !g.risk.sign_off.length || !g.risk.sign_off.every((x) => str(x.who) && str(x.needs))) m.push('risk.sign_off (who and needs)');
  if (verdict === 'go_after_fixing_data' && (!Array.isArray(g.data_fixes) || !g.data_fixes.length || !g.data_fixes.every((x) => str(x.gap) && str(x.owner) && str(x.done_when)))) m.push('data_fixes (gap, owner, done_when)');
  if (verdict === 'not_yet' && (!Array.isArray(g.unblock) || !g.unblock.length || !g.unblock.every((x) => str(x.what) && str(x.who)))) m.push('unblock (what, who)');
  return m;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function render(g, r) {
  const u = g.use_case;
  const alt = ALTERNATIVES[g.alternative.best];
  const line = {
    go: 'Build it. The problem needs a model, the value is measurable, and the data can be trusted.',
    go_after_fixing_data: 'Worth building with AI, once the data gaps below are fixed.',
    not_ai: `You don't need AI for this. ${alt} will do it faster, cheaper and easier to audit.`,
    not_yet: r.rule === 2 ? 'Not yet. Define the value and the owner before spending on a build.' : "Not yet. The data this needs doesn't exist yet, or nobody owns it.",
  }[r.verdict];
  const meta = [u.organization, u.date, u.prepared_by && `Prepared by ${u.prepared_by}`, u.prepared_for && `For ${u.prepared_for}`].filter(Boolean).join(' · ');
  const testLabel = {
    simplicity: { needs_ai: 'Needs AI', pipeline_will_do: 'A pipeline will do' },
    clarity: { pass: 'Pass', fail: 'Not yet' },
    data: { pass: 'Pass', fixable: 'Fixable', not_ready: 'Not ready' },
  };

  const o = [`# ${u.name}`, ''];
  if (meta) o.push(meta, '');
  o.push(`> **Verdict: ${r.verdict_label}.** ${line}`, '', u.summary, '', '## Why', '');
  for (const x of g.reasons) o.push(`- ${x}`);
  o.push('', '## Scores', '', '| Test | Score | Result |', '|---|---|---|');
  o.push(`| Simplicity: does a pipeline do this? | ${r.scores.simplicity}/8 | ${testLabel.simplicity[r.tests.simplicity]} |`);
  o.push(`| Clarity: is the value measurable? | ${r.scores.clarity}/8 | ${testLabel.clarity[r.tests.clarity]} |`);
  o.push(`| Data: can we trust it? | ${r.scores.data}/8 | ${testLabel.data[r.tests.data]}${r.data_verified ? '' : ' (not profiled)'} |`, '');

  if (r.verdict === 'not_ai') o.push('## Build this instead', '', g.alternative.description, '');
  if (r.verdict === 'go_after_fixing_data') {
    o.push('## Fix the data first', '', '| Gap | Owner | Fixed when |', '|---|---|---|');
    for (const x of g.data_fixes) o.push(`| ${cell(x.gap)} | ${cell(x.owner)} | ${cell(x.done_when)} |`);
    o.push('');
  }
  if (r.verdict === 'not_yet') {
    o.push('## What would change this', '');
    for (const x of g.unblock) o.push(`- ${x.what} (${x.who})`);
    o.push('');
  }

  o.push('## Biggest risks', '');
  g.top_risks.forEach((x, i) => o.push(`${i + 1}. ${x.risk} *Reduce it:* ${x.mitigation}`));
  o.push('', '## First build', '', g.first_build.scope, '', `**Left out:** ${g.first_build.left_out}`, '');
  if (r.verdict !== 'not_ai') o.push(`**Human review:** ${r.human_review}`, '');
  // A model has to beat the simplest option, so name it next to the build.
  if (['go', 'go_after_fixing_data'].includes(r.verdict) && g.alternative.best !== 'none') {
    o.push(`**Baseline to beat:** ${g.alternative.description}`, '');
  }

  const m = g.measure;
  o.push('## How to measure it', '', `**${m.metric}:** ${m.baseline} today → ${m.target}. Check by ${m.check_by}.`, '');

  const riskLabel = r.verdict === 'not_ai' ? 'Risk of the AI version as proposed' : 'Risk';
  o.push('## Who signs off', '', `${riskLabel}: **${r.risk_level}**.${g.risk.regulations?.length ? ` Plausibly in scope: ${g.risk.regulations.join(', ')}. Counsel confirms what applies.` : ''}`, '', '| Who | What they need to see |', '|---|---|');
  for (const x of g.risk.sign_off) o.push(`| ${cell(x.who)} | ${cell(x.needs)} |`);

  o.push('', '## Score detail', '', '| Criterion | Score | Evidence |', '|---|---|---|');
  for (const [test, criteria] of Object.entries(TESTS)) for (const c of criteria) o.push(`| ${test}: ${c.replace('_', ' ')} | ${g[test][c].score} | ${cell(g[test][c].evidence)} |`);
  o.push('', '---', '', `Scored with the AI Necessity Gate rubric v${VERSION} (rule ${r.rule}). Scores and evidence are in gate.json.`, '');
  return o.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: gate.mjs path/to/gate.json [--out gate.md]'); process.exit(1); }
  const outIdx = args.indexOf('--out');
  const path = resolve(file);
  const out = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(dirname(path), 'gate.md');

  let g;
  try { g = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { console.error(`gate: can't read ${file}: ${e.message}`); process.exit(1); }
  const { errors, result } = evaluate(g);
  if (errors) { console.error(`gate: fix these in ${file}:\n- ${errors.join('\n- ')}`); process.exit(1); }

  g.result = result;
  writeFileSync(path, JSON.stringify(g, null, 2) + '\n');
  const t = result.scores;
  console.log(`Verdict: ${result.verdict_label} (rule ${result.rule}). Simplicity ${t.simplicity}/8, Clarity ${t.clarity}/8, Data ${t.data}/8. Risk ${result.risk_level}.`);

  const missing = missingNarrative(g, result.verdict);
  if (missing.length) {
    console.log(`Scores saved. Fill these in ${file}, then run again:\n- ${missing.join('\n- ')}`);
    process.exit(2);
  }
  writeFileSync(out, render(g, result));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
