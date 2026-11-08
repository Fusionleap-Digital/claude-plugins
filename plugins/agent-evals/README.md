# agent-evals

A test harness for an AI agent or LLM app, to run before shipping and on
every change. Most AI apps stall between demo and production because nobody
can say whether the last prompt or model change made things better or worse.
This plugin gives you a repeatable answer.

- **Your own cases** in YAML or JSON: a single question or a conversation,
  optional documents and tool results, and the expected result.
- **Deterministic checks first**: contains, not-contains, regex, JSON schema,
  tool called with arguments, tool not called, max latency, max cost, and
  leaked PII, PHI or secrets.
- **Model-graded rubrics** where no pattern can decide, labeled *(graded)*
  in every report, and skipped with a clear message when there's no API key.
- **Repeats per case**, so flaky behaviour shows up as a pass rate instead
  of a lucky pass.
- **Built-in suites** you can opt into and edit (made-up data only):

  | Suite | Checks |
  |---|---|
  | refusal-scope | off-topic requests (creative writing, medical, legal, investment advice, persona swaps) are declined; a normal question still gets answered |
  | prompt-injection | instructions hidden in retrieved documents and tool results are ignored |
  | data-leakage | fake SSNs, card numbers, patient data and keys in the context never reach the output |
  | tool-misuse | destructive tools aren't called without explicit confirmation |

- **Drift**: every run is saved; `compare` shows pass-rate changes per case
  and suite between two runs and exits 1 on regressions, for CI. A sample
  GitHub Actions workflow is included.

## Targets

| Target | For |
|---|---|
| `command` | an agent you can run locally: it gets the case as JSON on stdin and prints a reply |
| `http` | a running endpoint, with configurable request body and response mapping |
| `anthropic` | a prompt-only app: a system prompt and tools, called through the Anthropic API |

## Install

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install agent-evals@fusionleap
```

Then ask Claude to "write evals for my agent", "test my chatbot for prompt
injection" or "compare the new prompt against the last run". Claude drafts
cases from what your agent is for, runs the suites, and explains each
failure with the exact input and output. It never edits an expected result
to make a test pass.

## Run it directly

```bash
node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs init
```

```bash
node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs run --config evals/evals.config.yaml --label baseline
```

```bash
node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs compare previous latest --config evals/evals.config.yaml --threshold 0.1
```

Node 18+. Deterministic checks need no install. For graded checks and the
`anthropic` target, run `npm install` in
`plugins/agent-evals/skills/agent-evals/scripts/` (adds `@anthropic-ai/sdk`
and `yaml`) and set `ANTHROPIC_API_KEY`. The judge defaults to
`claude-sonnet-5-5`; set `judge.model` to change it.

Each run writes `report.md` (suite summary, then every failing or flaky case
with its exact input, output, tool calls and check results) and
`report.json`. Exit code 1 means a case is below its pass threshold (`run`)
or a pass rate dropped more than the threshold (`compare`).

Docs: [test format](skills/agent-evals/references/format.md),
[targets](skills/agent-evals/references/adapters.md),
[CI workflow](skills/agent-evals/references/github-actions.yml).

## Safety

- Built-in suites use made-up data only: a test card number, a retired
  sample SSN, the AWS documentation example key, fictional people.
- Reports mask SSNs, card numbers, keys, tokens and every seeded value.
- Graded checks send the case and the agent's output to the Anthropic API.
  Leave `ANTHROPIC_API_KEY` unset or pass `--no-graded` to keep everything
  local.
- Point the target at a test environment. Tool results in tests are mocked;
  nothing should call a tool that changes real data.

## Test

The fixture is a rule-based support bot for a made-up bike shop. It passes
some cases and fails others on purpose (it follows an injected note, leaks a
seeded SSN, patient data and an example key, gives a drug dose, deletes an
account without asking). No API key needed.

```bash
node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs run --config test/agent-evals-fixture/evals.config.yaml --label v1
```

Expected: 33 cases, 22 pass, 1 flaky, 10 fail, 10 graded checks skipped.

```bash
FIXTURE_VERSION=2 node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs run --config test/agent-evals-fixture/evals.config.yaml --label v2
```

```bash
node plugins/agent-evals/skills/agent-evals/scripts/evals.mjs compare previous latest --config test/agent-evals-fixture/evals.config.yaml
```

Expected: 6 improvements and a regression in `correctness/opening-hours`
(and the correctness suite), exit code 1. A sample of both reports is in
`test/agent-evals-fixture/sample/`.

To test the `anthropic` target and graded checks without a key or any
spend, run the mock API in `test/agent-evals-mock-anthropic.mjs` and point
`ANTHROPIC_BASE_URL` at it (instructions at the top of the file).

## License

MIT
