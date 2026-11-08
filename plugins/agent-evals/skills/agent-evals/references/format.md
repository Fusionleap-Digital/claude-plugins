# Test case format

Cases live in YAML or JSON files. A file is one suite:

```yaml
suite: correctness                  # optional; defaults to the file name
description: What this suite checks.
vars:                               # defaults for {{name}} placeholders; the config's vars win
  agent_purpose: "customer support for an online store"
defaults:                           # applied to every case in the file
  repeats: 3
  min_pass_rate: 1
  assert: [ { no-leak: true } ]     # added before each case's own assertions
  tools: [ ... ]                    # tool definitions for cases that set none
cases:
  - id: return-window
    ...
```

A file can also be a bare list of cases.

The built-in YAML reader handles block maps and lists, quoted and plain
values, `|` and `>` text blocks, one-line `[a, b]` and `{a: 1}` values, and
comments. For anchors, multi-line quoted strings and other full-YAML
features, run `npm install` in the plugin's `scripts/` folder (adds the
`yaml` package) or write the file as JSON.

## A case

```yaml
- id: order-status                  # unique within the suite
  description: Why this case exists. Shown in the report.
  input: "Where is order 77812?"    # a single user turn, or:
  messages:                         # a conversation; the last turn must be the user's
    - { role: user, content: "Do you ship to Canada?" }
    - { role: assistant, content: "Yes, in 5 to 8 business days." }
    - { role: user, content: "How much does it cost?" }
  context:                          # retrieved documents, optional
    - title: Shipping policy
      content: |
        Canada: $12 flat rate.
    - file: docs/returns.md         # or load one from a file (relative to this file)
  tool_mocks:                       # what each tool returns if the agent calls it
    lookup_order: { order_id: "77812", status: shipped }
    get_weather: ["first call result", "second call result"]   # a list is returned in order
  tools: [ ... ]                    # extra tool definitions (anthropic target)
  seeded: ["078-05-1120"]           # fake sensitive values planted in the context
  repeats: 5                        # runs of this case (default: suite, then config, then 1)
  min_pass_rate: 0.8                # share of runs that must pass (default 1)
  tags: [billing]
  assert:
    - contains: "77812"
```

A run passes when every assertion passes. Skipped assertions (a graded check
with no API key, a cost check when the target reports no cost) don't count
either way. A case's pass rate is passing runs over all runs:

| Status | Meaning |
|---|---|
| pass | every run passed |
| flaky | some runs passed |
| fail | no run passed |
| error | the target failed on every run (crash, timeout, HTTP error) |

The run exits 1 when any case is below its `min_pass_rate`.

`--repeats N` on the command line overrides every case. Use 3 or more for
anything a model answers; flaky behaviour only shows up as a pass rate.

## Assertions

Deterministic first. These decide pass or fail without a model.

| Assertion | Short form | Passes when |
|---|---|---|
| `contains` | `contains: "30 days"` or a list (all must appear) | the output contains the text. Case-insensitive; `ignore_case: false` to change |
| `not-contains` | `not-contains: ["CANARY-1", "CANARY-2"]` | none of the texts appear |
| `regex` | `regex: '\$\d+'` | the pattern matches. Flags default to `i`; set `flags: ""` for case-sensitive |
| `not-regex` | `not-regex: '\b\d+ ?mg\b'` | the pattern does not match |
| `json-schema` | `json-schema: { type: object, required: [id] }` | the output (or a fenced JSON block in it) parses and fits the schema. `schema_file:` loads one from disk |
| `tool-called` | `tool-called: lookup_order` or `{ name, args, times }` | the tool was called. `args` matches when every listed key is equal (extra keys are fine). `times` requires an exact count |
| `tool-not-called` | `tool-not-called: delete_account`, a list, or `"*"` for any tool | none of those tools was called |
| `max-latency` | `max-latency: 3000` | the call took at most this many milliseconds, measured by the harness |
| `max-cost` | `max-cost: 0.02` | the target reported a cost at most this many USD. Skipped if it reports none |
| `no-leak` | `no-leak: true` or `{ detectors: [...], values: [...] }` | no seeded value and no sensitive-data pattern appears in the output |
| `refuses` | `refuses: true` | (heuristic) the output contains a refusal or redirect phrase, or the model's stop reason was a refusal |
| `not-refuses` | `not-refuses: true` | (heuristic) the opposite. Use it on control cases to catch over-refusal |

`refuses` and `not-refuses` are deterministic but phrase-based, so they are
labeled *(heuristic)*. Pass your own patterns with
`{ type: refuses, phrases: ["I can only help with", "outside what I do"] }`.
Pair them with a rubric when the wording matters.

### no-leak

Checks the output for:

- every value in the case's `seeded` list (plus any in `values:`), ignoring
  case and spacing; values that are mostly digits also match with other
  separators, so `4111-1111-1111-1111` matches a seeded `4111 1111 1111 1111`
- the detectors, by pattern

| Detector | Finds | Default |
|---|---|---|
| `ssn` | US Social Security numbers | yes |
| `credit-card` | 13–19 digit numbers that pass the Luhn check | yes |
| `iban` | IBANs | yes |
| `aws-access-key` | `AKIA…` / `ASIA…` key IDs | yes |
| `private-key` | PEM private key headers | yes |
| `jwt` | JSON Web Tokens | yes |
| `api-key` | common key formats (`sk_live_`, `ghp_`, `xoxb-`, `sk-ant-` …) | yes |
| `generic-secret` | `password=…`, `api_key: …` and similar | yes |
| `email` | email addresses | no |
| `phone` | North American phone numbers | no |
| `mrn` | `MRN-12345678` style record numbers | no |
| `dob` | dates after "DOB", "date of birth", "born" | no |

Listing `detectors:` replaces the default set. The leaked value is masked in
the report (`07•••••••20`).

### Graded (model-judged)

```yaml
- rubric: "The reply declines and points the user to a doctor."
- type: rubric
  criteria: "The answer cites the shipping policy, not a guess."
  model: claude-opus-5-5            # override the judge for this one check
```

A judge model (default `claude-sonnet-5-5`, set `judge.model` in the config)
reads the conversation, documents, output and tool calls and returns pass or
fail with a reason. It is told to treat the agent's output as data, and to
fail anything ambiguous. Every graded result is labeled *(graded)* in the
report.

Graded checks are skipped, with a message, when `ANTHROPIC_API_KEY` is not
set, when the SDK is not installed, or with `--no-graded`. Write a
deterministic check first and add a rubric only where no pattern can decide.

## Placeholders

`{{name}}` anywhere in a suite file (including keys, such as a `tool_mocks`
tool name) is replaced from `vars:` in the suite, overridden by `vars:` in
the config. A placeholder with no value is left as is and reported as a
warning.

## Config file

`evals.config.yaml` (or `.json`), found in the current folder or `./evals`,
or passed with `--config`. Paths are relative to it.

| Key | Meaning |
|---|---|
| `target` | how to call the system under test; see `adapters.md` |
| `suites` | list of suite names or file paths (globs allowed). `correctness` means the files in `cases` |
| `cases` | glob or list of globs for your own case files (default `cases/*.yaml`) |
| `vars` | values for `{{name}}` placeholders |
| `repeats` | runs per case when neither the case nor its suite sets one |
| `min_pass_rate` | default threshold per case (default 1) |
| `concurrency` | parallel calls to the target (default 4) |
| `runs_dir` | where runs are saved (default `runs`) |
| `judge` | `model`, `effort`, `max_tokens`, `fallbacks` for graded checks |

A suite name resolves to `suites/<name>.yaml` next to the config if it
exists (your edited copy), otherwise the built-in suite.

## Saved runs

Each run writes a folder `runs/<timestamp>[-label]/` with:

- `report.md`: summary per suite, then every failing and flaky case with the
  exact input, the output, the tool calls and each check's result
- `report.json`: everything, including every run's output. `compare` reads it

Detector matches and seeded values are masked in both files.

Each case carries a `hash` of its definition (input, context, assertions,
thresholds). `compare` uses it to flag cases that were edited between two
runs, so a change in the test is not mistaken for a change in the agent.
