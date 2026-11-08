// Runs every case `repeats` times against the target and scores each run.

import { makeAdapter } from './adapters.mjs';
import { runAssertion, describeAssertion } from './assertions.mjs';
import { maskText } from './detectors.mjs';

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function maskDeep(v, seeded) {
  if (typeof v === 'string') return maskText(v, seeded);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, seeded));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, seeded)]));
  return v;
}

export async function runSuites({ config, suites, repeats, graded, gradedReason, judge, concurrency, onProgress = () => {} }) {
  const adapter = makeAdapter(config.target, config.baseDir);
  const tasks = [];
  const caseResults = [];
  for (const suite of suites) {
    for (const c of suite.cases) {
      const n = repeats || c.repeats || config.repeats || 1;
      const cr = { case: c, repeats: n, runs: new Array(n) };
      caseResults.push(cr);
      for (let r = 0; r < n; r++) tasks.push({ cr, r });
    }
  }

  let done = 0;
  await pool(tasks, concurrency, async ({ cr, r }) => {
    const c = cr.case;
    const req = {
      case_id: `${c.suite}/${c.id}`,
      repeat: r + 1,
      input: c.messages[c.messages.length - 1].content,
      messages: c.messages,
      context: c.context,
      tool_mocks: c.tool_mocks,
      tools: c.tools,
    };
    const started = Date.now();
    let result;
    try {
      result = await adapter(req);
    } catch (err) {
      result = { output: '', tool_calls: [], error: String(err?.message || err) };
    }
    const latencyMs = Date.now() - started;
    const checks = [];
    if (!result.error) {
      for (const a of c.assert) {
        let res;
        try {
          res = await runAssertion(a, { req, result, latencyMs, caseDef: c, baseDir: config.baseDir, judge, graded, gradedReason });
        } catch (err) {
          res = { status: 'error', message: String(err?.message || err) };
        }
        checks.push({
          assertion: describeAssertion(a),
          type: a.type,
          graded: a.type === 'rubric',
          heuristic: a.type === 'refuses' || a.type === 'not-refuses',
          ...res,
        });
      }
    }
    const passed = !result.error && checks.every((k) => k.status === 'pass' || k.status === 'skipped');
    cr.runs[r] = {
      repeat: r + 1,
      passed,
      latency_ms: latencyMs,
      cost_usd: typeof result.cost_usd === 'number' ? result.cost_usd : null,
      usage: result.usage,
      refusal: result.refusal || undefined,
      error: result.error,
      output: maskText(String(result.output ?? ''), c.seeded),
      tool_calls: maskDeep(result.tool_calls || [], c.seeded),
      checks,
    };
    onProgress(++done, tasks.length, cr.case, passed);
  });

  const cases = caseResults.map(({ case: c, repeats: n, runs }) => {
    const passes = runs.filter((x) => x.passed).length;
    const errors = runs.filter((x) => x.error).length;
    const rate = passes / n;
    const status = errors === n ? 'error' : passes === n ? 'pass' : passes === 0 ? 'fail' : 'flaky';
    return {
      suite: c.suite,
      id: c.id,
      description: c.description,
      hash: c.hash,
      repeats: n,
      passes,
      pass_rate: rate,
      min_pass_rate: c.min_pass_rate,
      meets_threshold: rate >= c.min_pass_rate,
      status,
      input: { messages: maskDeep(c.messages, c.seeded), context: maskDeep(c.context, c.seeded), tool_mocks: maskDeep(c.tool_mocks, c.seeded) },
      assertions: c.assert.map(describeAssertion),
      runs,
    };
  });

  const suiteSummaries = suites.map((s) => {
    const mine = cases.filter((c) => c.suite === s.name);
    const runs = mine.reduce((a, c) => a + c.repeats, 0);
    const passes = mine.reduce((a, c) => a + c.passes, 0);
    return {
      name: s.name,
      description: s.description,
      builtin: s.builtin,
      files: s.files,
      cases: mine.length,
      runs,
      passes,
      pass_rate: runs ? passes / runs : 0,
      pass: mine.filter((c) => c.status === 'pass').length,
      flaky: mine.filter((c) => c.status === 'flaky').length,
      fail: mine.filter((c) => c.status === 'fail').length,
      error: mine.filter((c) => c.status === 'error').length,
      below_threshold: mine.filter((c) => !c.meets_threshold).length,
    };
  });

  return { cases, suites: suiteSummaries };
}
