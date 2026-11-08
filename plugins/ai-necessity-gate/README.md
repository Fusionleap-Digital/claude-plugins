# AI Necessity Gate

**Publisher:** [FusionLeap Digital](https://fusionleap.io)
**Version:** 1.0.0

A Claude Code plugin that runs a proposed AI use case through the AI
Necessity Gate before money is spent. You get a one-page verdict a
technology leader can take to the CEO.

By the estimates RAND cites (2024), more than 80% of AI projects fail, about
twice the rate of IT projects without AI. Many of them never needed a model.
The Gate asks three questions first:

| Test | Question |
|---|---|
| Simplicity | Does a deterministic pipeline do this? |
| Clarity | Is the outcome measurable in value, not hours? |
| Data | Is the data governed enough to trust the output? |

## What it does

1. **Intake.** A short interview, or it reads a brief or PRD you paste and
   asks only about the gaps: the problem, who has it, how it's handled
   today, volume and cost, what a wrong answer costs, the data, and who
   signs off.
2. **Simplicity.** Tries rules, search, a report, a form, a process change
   and a system integration first. When one of them does the job, it says
   so: you don't need AI for this.
3. **Clarity.** Checks for a business metric with a baseline, a named owner
   and sponsor, and a known cost of being wrong. Hours saved alone don't
   count.
4. **Data.** Profiles a CSV sample, SQL schema or data dictionary with a
   local script: row counts, empty rates, keys, duplicates, freshness, and
   columns that look like PII, PHI or financial data by name or pattern.
   It never prints or stores a value.
5. **Risk and sign-off.** Sets a risk level and a human-review rule, lists
   regulations plausibly in scope, and says what security, compliance,
   legal and data owners will need to see to sign off.
6. **Verdict.** One of **Go**, **Go after fixing data**, **Not AI** or
   **Not yet**, with the reasons, the three biggest risks, the smallest
   useful first build and how to measure it.

Claude scores twelve criteria from the evidence. A script adds them up and
applies the verdict rules, so the same evidence always gives the same
answer. The rubric is in
[`references/rubric.md`](skills/ai-necessity-gate/references/rubric.md),
written to be read by people too.

## Output

In `ai-necessity-gate/<use-case>/`:

- `gate.md`: the one-pager. Verdict, why, scores, risks, first build,
  measure, sign-off, and the evidence behind each score.
- `gate.json`: every score with its evidence, and the computed result.
- `profile.md` and `profile.json`: the data profile, if you shared data.

## Examples

Three made-up mid-market cases, each with the brief, the scored
`gate.json` and the rendered `gate.md`:

| Example | Verdict |
|---|---|
| [Veterinary lab: read requisition forms](skills/ai-necessity-gate/references/examples/go-animal-health/gate.md) | Go |
| [Parts distributor: customer service chatbot](skills/ai-necessity-gate/references/examples/not-ai-supply-chain/gate.md) | Not AI |
| [Equipment lender: delinquency early warning](skills/ai-necessity-gate/references/examples/fix-data-equipment-finance/gate.md) | Go after fixing data |

## Install

In Claude Code:

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install ai-necessity-gate@fusionleap
```

Then ask:

> "Run the AI Necessity Gate on this brief" (and paste it)

or

> "Do we actually need AI for this? Here's a sample of the data: exports/orders.csv"

## Requirements

- Node.js 18+ for the two scripts. No packages to install.
- Data samples as CSV or TSV, schemas as `CREATE TABLE` SQL, dictionaries
  as CSV. Export Excel or Parquet to CSV first. The skill doesn't connect to
  databases.

Everything runs locally. The profiler reads your files on your machine and
writes only counts and column names.

## Tests

```bash
node --test test/necessity-gate-*.test.mjs
```

## In an engagement

In FusionLeap's AI Enablement Sprint, every candidate use case goes through
the AI Necessity Gate in Sprint Zero, and every Sprint Zero so far has found
at least one that didn't need AI. This plugin is the same three questions,
for running on your own.

## License

MIT
