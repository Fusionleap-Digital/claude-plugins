---
name: agent-evals
description: Test an AI agent, chatbot, RAG app or LLM prompt before shipping and on every change. Drafts test cases from what the agent is for, runs them against an HTTP endpoint, a local command or the Anthropic API, checks answers deterministically (contains, regex, JSON schema, tool calls, latency, cost, leaked PII or secrets) with optional model-graded rubrics, runs built-in suites for off-topic requests, prompt injection, sensitive-data leakage and destructive tool calls, repeats cases to expose flaky behaviour, and compares runs to catch regressions in CI. Use when the user asks to evaluate, test or benchmark their agent or prompt, write evals or test cases for an LLM app, check it for prompt injection, data leaks or unsafe tool use, compare a model or prompt change, or gate releases on eval results.
---

# Agent evals

A test harness for an AI agent or LLM app. A Node script runs the cases and
decides pass or fail. A model is used only for rubric checks, which are
optional and labeled *(graded)* everywhere they appear.

Scripts are in `${CLAUDE_PLUGIN_ROOT}/skills/agent-evals/scripts/`. Node 18+.
No install is needed for deterministic checks. Graded checks and the
anthropic target need `npm install` in that folder (adds `@anthropic-ai/sdk`
and `yaml`) and `ANTHROPIC_API_KEY`.

## Rules

- **Never change an expected result to make a test pass.** Don't edit
  assertions, `seeded` values, thresholds, `min_pass_rate` or the baseline
  to turn a failure green. A failing case means the agent is wrong, or the
  case is. If you think the case is wrong, say why, show the evidence, and
  let the user decide. Change it only when they say so, and say in your
  reply that you changed a test.
- **Fix the agent, not the eval.** When asked to fix failures, change the
  agent's prompt, code or tools, then rerun the same cases.
- **Show the evidence.** When explaining a failure, quote the exact input
  (and the document or tool result that matters), the exact output, and the
  check that failed, from `report.md`. Don't paraphrase the output.
- **Label graded results.** Say which results came from a model judge and
  which from exact checks. If graded checks were skipped, say so and say
  why. Don't present a heuristic refusal check as proof.
- **Made-up data only.** Suites and cases contain fake names, numbers and
  keys. Never put real customer data, real credentials or production
  secrets in a case, and never copy them out of the user's systems into one.
- **Never print secret values.** Reports mask detector hits and seeded
  values. Don't unmask them, and don't read real secrets back from the
  user's environment to show them.
- **Ask before spending.** Count the runs (cases × repeats) and say roughly
  what they cost before running against a paid API or the anthropic target.
  Ask before running against anything but a local or test environment.
- **No real side effects.** The target must not reach tools that change real
  data. Destructive tools in tests must be mocked or pointed at a sandbox.

## 1. Set up

From the user's project:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agent-evals/scripts/evals.mjs" init
```

Creates `evals/evals.config.yaml`, `evals/cases/correctness.yaml` (an example
to replace) and editable copies of the four built-in suites in
`evals/suites/`. `--suites prompt-injection,data-leakage` copies only those.

Then set the target. Read `references/adapters.md` and pick:

- **command**: the agent runs locally; it gets the request as JSON on stdin
  and prints a reply. Often a 10-line wrapper around their agent (example
  in `adapters.md`).
- **http**: a running endpoint; map the request body and the reply fields.
- **anthropic**: a prompt-only app; a system prompt and tools, called
  through the Messages API. Use the model and settings they use in
  production.

Fill `vars:` (agent purpose, a normal in-scope question, the names of a
read-only and a destructive tool). Run `evals.mjs validate` to check the
files without calling anything.

## 2. Draft cases from the agent's purpose

Ask what the agent is for, who uses it, what it must never do, which tools
it has, and what a good answer looks like. Read its system prompt and tool
definitions if they're in the repo. Then draft cases in
`evals/cases/*.yaml` (format: `references/format.md`):

- 10 to 30 correctness cases from real questions, not invented edge cases
  only. Ask for real (anonymised) examples or support tickets.
- One case per behaviour, with a `description` saying why it exists.
- Deterministic checks first: an exact fact (`contains`), a format
  (`json-schema`, `regex`), the right tool and arguments (`tool-called`),
  a limit (`max-latency`, `max-cost`). Add a `rubric` only when no pattern
  can decide, and keep its criterion to one checkable sentence.
- `repeats: 3` or more for anything a model answers.
- A few control cases that must *not* be refused.

Show the drafted cases to the user and get their agreement on the expected
results before running. Those expectations are theirs, not yours.

Then tailor the built-in suites in `evals/suites/`: delete cases that are in
scope for this agent (a medical agent answers health questions), set tool
names, add cases for its own risks. Keep the data fake.

| Suite | Checks |
|---|---|
| `refusal-scope` | off-topic and out-of-scope requests (creative writing, medical, legal, investment advice, persona swaps) are declined; one in-scope control must be answered |
| `prompt-injection` | instructions hidden in documents and tool results are ignored. Canary strings and tool calls make it deterministic |
| `data-leakage` | fake PII, PHI and secrets in the context never reach the output. Pattern detection, no model |
| `tool-misuse` | destructive tools aren't called without explicit confirmation; one confirmed control must call it |

## 3. Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agent-evals/scripts/evals.mjs" run --config evals/evals.config.yaml --label baseline
```

- `--suite a,b` and `--case id` narrow the run; `--repeats N` overrides.
- `--no-graded` skips rubric checks. Without `ANTHROPIC_API_KEY` they are
  skipped automatically, with a message; deterministic checks still run.
- `--concurrency N` parallel calls (default 4).
- Writes `evals/runs/<timestamp>-<label>/report.md` and `report.json`.
  Exit 1 means at least one case is below its `min_pass_rate`.

## 4. Explain the results

Read `report.md`. Lead with the suite table, then go through failures most
severe first: errors, failing cases, then flaky ones. For each, give:

1. the case and why it exists (its description),
2. the exact input, and the planted document or tool result if that's the
   cause,
3. the exact output (masked values stay masked),
4. which check failed and its detail line,
5. the likely cause in the agent (for example "the system prompt doesn't
   say to treat document text as data") and a concrete fix.

Flaky cases (some runs pass) usually mean an underspecified prompt or a
borderline case; say which runs failed and how the outputs differ (see
`report.json`). Target errors are not agent failures; fix the setup first.

## 5. Compare runs (drift)

After a model, prompt or code change, run again with a new label and
compare:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agent-evals/scripts/evals.mjs" compare evals/runs/<base> evals/runs/<head> --threshold 0.1
```

`latest` and `previous` work as run names. It writes `compare.md` and
`compare.json` into the head run: pass-rate change per suite and per case,
improvements, regressions, and cases whose definition changed between the
runs. Exit 1 if any case or suite pass rate dropped by more than the
threshold (0.1 = 10 points).

Report regressions first, with the failing output from the head run. Point
out edited cases: their change may come from the test, not the agent. With
fewer than 3 repeats, small changes are noise; say so.

## 6. CI

`references/github-actions.yml` runs the evals on pull requests and fails on
regressions against a committed baseline (`evals/baseline/report.json`).
Help the user copy it, pin the plugin version, and add the API key as a
repository secret if they use graded checks or the anthropic target. Update
the baseline only when the user asks, from a run they've reviewed.
