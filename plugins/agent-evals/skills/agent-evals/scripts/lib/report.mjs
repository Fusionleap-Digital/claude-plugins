// report.md for a run, and compare.md for two runs.

const pct = (x) => `${Math.round(x * 100)}%`;
const fence = (text, lang = 'text') => {
  const t = String(text ?? '');
  const ticks = t.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${t}\n${ticks}`;
};
const clip = (t, n = 6000) => (t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters in report.json)` : t);
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const MARK = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP', error: 'ERROR' };
const STATUS_ORDER = { error: 0, fail: 1, flaky: 2, pass: 3 };

function median(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function toolCalls(calls) {
  if (!calls?.length) return 'none';
  return calls.map((c) => `\`${c.name}(${JSON.stringify(c.args)})\``).join(', ');
}

function caseSection(c) {
  const lines = [];
  const head = c.status === 'error' ? 'ERROR' : c.status === 'flaky' ? 'FLAKY' : 'FAIL';
  lines.push(`### ${head} ${c.suite} / ${c.id} — ${c.passes}/${c.repeats} runs passed${c.meets_threshold ? ` (meets min pass rate ${pct(c.min_pass_rate)})` : ''}`, '');
  if (c.description) lines.push(c.description, '');
  lines.push('**Input**', '', fence(c.input.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')), '');
  if (c.input.context?.length) {
    lines.push(`**Context** (${c.input.context.length} document${c.input.context.length > 1 ? 's' : ''})`, '');
    for (const d of c.input.context) lines.push(`<details><summary>${esc(d.title)}</summary>`, '', fence(clip(d.content.trimEnd(), 3000)), '', '</details>', '');
  }
  if (Object.keys(c.input.tool_mocks || {}).length) lines.push('**Tool results the test supplies**', '', fence(JSON.stringify(c.input.tool_mocks, null, 2), 'json'), '');
  const failing = c.runs.filter((r) => !r.passed);
  const shown = failing[0] || c.runs[0];
  if (c.status === 'flaky') lines.push(`Passed on runs ${c.runs.filter((r) => r.passed).map((r) => r.repeat).join(', ')}; failed on runs ${failing.map((r) => r.repeat).join(', ')}.`, '');
  lines.push(`**Output** (run ${shown.repeat}, ${shown.latency_ms} ms${shown.cost_usd != null ? `, $${shown.cost_usd.toFixed(5)}` : ''})`, '');
  if (shown.error) lines.push(`Target error: ${shown.error}`, '');
  lines.push(fence(clip(shown.output || '(empty)')), '', `**Tool calls:** ${toolCalls(shown.tool_calls)}`, '');
  if (shown.checks.length) {
    lines.push('| Check | Result | Detail |', '|---|---|---|');
    for (const k of shown.checks) {
      lines.push(`| ${esc(k.assertion)} | ${MARK[k.status] || k.status} | ${esc(k.message)} |`);
    }
    lines.push('');
  }
  const others = failing.slice(1).filter((r) => r.output !== shown.output);
  if (others.length) lines.push(`${others.length} other failing run${others.length > 1 ? 's' : ''} gave different output; see report.json.`, '');
  return lines.join('\n');
}

export function runReport(data) {
  const { meta, suites, cases, totals } = data;
  const L = [];
  L.push('# Agent eval report', '');
  L.push(`- Run: \`${meta.run_id}\`${meta.label ? ` (${meta.label})` : ''}, ${meta.started_at.replace('T', ' ').slice(0, 19)} UTC, ${Math.round(meta.duration_ms / 1000)} s`);
  L.push(`- Target: ${meta.target}`);
  L.push(`- Repeats: ${meta.repeats_note}`);
  if (meta.graded.enabled) L.push(`- Graded checks: judged by \`${meta.graded.model}\`. These are a model's judgement and are marked "(graded)".`);
  else if (meta.graded.count) L.push(`- Graded checks: **${meta.graded.count} skipped**, ${meta.graded.reason}. Only deterministic checks decided these results.`);
  else L.push('- Graded checks: none in these suites.');
  L.push(`- Result: **${totals.below_threshold ? `${totals.below_threshold} of ${totals.cases} cases below their pass threshold` : `all ${totals.cases} cases passed`}** (${totals.pass} pass, ${totals.flaky} flaky, ${totals.fail} fail${totals.error ? `, ${totals.error} error` : ''}; ${pct(totals.pass_rate)} of ${totals.runs} runs passed)`);
  L.push('');
  L.push('## Suites', '', '| Suite | Pass rate | Cases | Pass | Flaky | Fail | Error |', '|---|---|---|---|---|---|---|');
  for (const s of suites) L.push(`| ${s.name}${s.builtin ? ' (built-in)' : ''} | ${pct(s.pass_rate)} | ${s.cases} | ${s.pass} | ${s.flaky} | ${s.fail} | ${s.error} |`);
  L.push('');
  const problems = cases.filter((c) => c.status !== 'pass').sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.pass_rate - b.pass_rate);
  if (problems.length) {
    L.push('## Failures and flaky cases', '', 'Each one shows the exact input sent and the output that failed.', '');
    for (const c of problems) L.push(caseSection(c));
  }
  const passing = cases.filter((c) => c.status === 'pass');
  if (passing.length) {
    L.push('## Passing cases', '', '| Suite | Case | Runs | Median latency |', '|---|---|---|---|');
    for (const c of passing) L.push(`| ${c.suite} | ${c.id} | ${c.passes}/${c.repeats} | ${median(c.runs.map((r) => r.latency_ms))} ms |`);
    L.push('');
  }
  L.push('## Notes', '');
  L.push('- Sensitive values (detector matches and seeded test values) are masked in this report and in report.json.');
  L.push('- "(graded)" checks are a model\'s judgement. "(heuristic)" checks look for refusal phrases; they are deterministic but can miss a refusal worded another way. Everything else is an exact check.');
  if (meta.warnings?.length) for (const w of meta.warnings) L.push(`- Warning: ${w}`);
  L.push('');
  return L.join('\n');
}

export function compareReport(cmp) {
  const L = [];
  const { base, head, threshold } = cmp.meta;
  L.push('# Agent eval comparison', '');
  L.push(`- Base: \`${base.run_id}\`${base.label ? ` (${base.label})` : ''}, ${base.target}`);
  L.push(`- Head: \`${head.run_id}\`${head.label ? ` (${head.label})` : ''}, ${head.target}`);
  L.push(`- Regression threshold: a drop of more than ${pct(threshold)} in pass rate`);
  L.push(`- Result: **${cmp.regressions.length ? `${cmp.regressions.length} regression${cmp.regressions.length > 1 ? 's' : ''}` : 'no regressions'}**, ${cmp.improvements.length} improvement${cmp.improvements.length === 1 ? '' : 's'}`);
  L.push('');
  L.push('## Suites', '', '| Suite | Base | Head | Change |', '|---|---|---|---|');
  for (const s of cmp.suites) L.push(`| ${s.name} | ${s.base === null ? '—' : pct(s.base)} | ${s.head === null ? '—' : pct(s.head)} | ${s.delta === null ? s.base === null ? 'new' : 'removed' : `${s.delta > 0 ? '+' : ''}${Math.round(s.delta * 100)} pts`}${s.regressed ? ' **regressed**' : ''} |`);
  L.push('');
  const changed = cmp.cases.filter((c) => c.change !== 'same');
  L.push('## Cases that changed', '');
  if (!changed.length) L.push('No case changed its pass rate.', '');
  else {
    L.push('| Suite | Case | Base | Head | Change | Note |', '|---|---|---|---|---|---|');
    const order = { regressed: 0, worse: 1, removed: 2, new: 3, better: 4, improved: 5 };
    for (const c of changed.sort((a, b) => order[a.change] - order[b.change])) {
      L.push(`| ${c.suite} | ${c.id} | ${c.base === null ? '—' : pct(c.base)} | ${c.head === null ? '—' : pct(c.head)} | ${c.change === 'regressed' ? '**regressed**' : c.change} | ${c.edited ? 'case definition changed between runs' : ''} |`);
    }
    L.push('');
  }
  const edited = cmp.cases.filter((c) => c.edited);
  if (edited.length) L.push(`Note: ${edited.length} case${edited.length > 1 ? 's were' : ' was'} edited between the runs (input or expected result). A change there can come from the test, not the agent.`, '');
  if (cmp.notes.length) { L.push('## Notes', ''); for (const n of cmp.notes) L.push(`- ${n}`); L.push(''); }
  return L.join('\n');
}
