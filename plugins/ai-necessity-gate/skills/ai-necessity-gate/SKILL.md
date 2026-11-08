---
name: ai-necessity-gate
description: Run the AI Necessity Gate on a proposed AI use case before money is spent. Interviews the user (or reads a pasted brief or PRD), tests whether rules, search, a report, a form or a process change would do the job instead, checks data readiness (profiling a CSV sample, SQL schema or data dictionary without printing values), maps regulatory risk and who must sign off, and returns a verdict (Go, Go after fixing data, Not AI, or Not yet) as a one-page gate.md plus gate.json with the scores. Use when the user asks whether a use case needs AI, wants to vet, score, assess or go/no-go an AI idea, proposal, pilot, brief or PRD, asks "should we use AI for this" or "do we need AI for this", wants an AI business case checked before funding, or mentions the AI Necessity Gate. Not for reviewing AI code or building the system.
---

# AI Necessity Gate

Three tests, asked before anyone writes a prompt:

1. **Simplicity Test.** Does a deterministic pipeline do this?
2. **Clarity Test.** Is the outcome measurable in value, not hours?
3. **Data Test.** Is the data governed enough to trust the output?

Then a risk and sign-off map, and one verdict: **Go**, **Go after fixing
data**, **Not AI**, or **Not yet**. You score the criteria and write the
reasons. `scripts/gate.mjs` adds up the scores and applies the verdict
rules, so the same evidence always gives the same answer.

The criteria, thresholds and verdict rules are in `references/rubric.md`.
Read it before scoring. Worked examples are in `references/examples/`.

## Rules

- **"You don't need AI for this" is a good answer.** Say it plainly when
  the Simplicity Test fails. Don't soften it into "AI could help". Name
  the simpler build.
- **Unknown scores 0.** Never score up to be encouraging. If the user
  doesn't know the volume, the owner or the data quality, the score is 0
  and the fix goes in the output.
- **The script decides the verdict.** Never state a verdict before
  `gate.mjs` has run, and never override it. If the verdict feels wrong,
  re-check the scores against the rubric and change a score only if the
  evidence supports it. Say what changed.
- **Never read data values.** Only `scripts/profile.mjs` opens data files.
  Don't `cat`, `head`, Read or grep a CSV, export or database dump, and
  don't quote values from one. Schemas and data dictionaries are fine to
  read.
- **Security and compliance are partners, not a gate.** Say what they will
  need to see to sign off. Never call them a blocker, a veto or a hurdle.
- **Value, not hours.** "Saves 20 hours a week" is not an outcome until
  you know what those hours turn into.
- **Regulations are "plausibly in scope".** Name them; don't give legal
  conclusions. The client's counsel decides what applies.
- **Plain language.** Short sentences, headlines of six words or fewer, no
  jargon the CEO would have to look up. Don't invent frameworks or
  statistics.

## 1. Intake

Gather these. If the user pasted a brief, PRD or ticket, pull the answers
from it first and ask only about the gaps, in one message, numbered, eight
questions at most. "Don't know" is an acceptable answer.

| Topic | Ask |
|---|---|
| Problem | What goes wrong today, in one sentence? |
| Who | Who has the problem, and how many people? |
| Today | How is it handled now? What tools and steps? |
| Volume and cost | How many a day/week/month? What does each cost (time, money, delay, errors)? Counted or estimated? |
| Wrong answer | What happens when the answer is wrong? Who notices, and what does it cost? |
| Data | What data would it use, where does it live, who owns it? Any personal, health or financial data? |
| Value | What business number moves if this works? What is it today? |
| Sign-off | Who has to approve: business owner, sponsor, security, privacy, legal, data owner? |

If the use case bundles a lookup with a judgment, split it and gate each
part separately (see the rubric).

Create the output folder `ai-necessity-gate/<short-slug>/` in the current
directory. Copy `references/gate.template.json` there as `gate.json` and
fill `use_case` and `intake` as you go.

## 2. Simplicity Test

Before scoring, try hard to solve it without AI. For each of rules,
search, a report, a form, a process change and a system integration, ask:
would this do most of the job? The best one goes in `alternative`, even
when AI wins; it becomes the baseline the build has to beat.

Score `input`, `rules`, `output` and `alternative` from the rubric.

## 3. Clarity Test

Score `value`, `volume`, `owner` and `wrong_answer`. Push on value: if the
only benefit is hours saved, ask what the hours turn into (more orders
handled, fewer refunds, faster cash, less write-off). A named metric with
no baseline scores 1; the first build can measure the baseline.

## 4. Data Test

Ask for something to profile: a CSV or TSV sample (a few thousand rows is
plenty; ask for an export with the real column names), a SQL schema
(`CREATE TABLE` statements), or a data dictionary as CSV.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/ai-necessity-gate/scripts/profile.mjs" sample.csv schema.sql data_dictionary.csv --out ai-necessity-gate/<slug>
```

- Writes `profile.md` and `profile.json`: rows, columns, inferred types,
  empty rates, distinct counts, candidate keys, ID columns with repeats,
  duplicate rows, freshness of date columns as ages in days, and columns
  that look like PII, PHI or financial data by name or by value pattern
  (email, SSN, phone, IP, IBAN, Luhn-valid card numbers). Counts only, no
  values.
- A CSV is treated as a data dictionary when its name contains
  dictionary, glossary or catalog, or with `--dictionary`.
- `--as-of YYYY-MM-DD` sets "today" for freshness; `--stale-days` (default
  90) sets when a date column counts as stale.
- Excel, Parquet or a live database: ask the user to export a CSV sample or
  the DDL. Don't connect to databases.

Read `profile.md`, then score `availability`, `quality`, `access` and
`sensitivity`. Set `data.profiled` to true only if a profile backed the
scores. Name-based PII flags are hints: a `patient_id` in a veterinary lab
is an animal, but its owner's phone number is still PII. Say which flags
you discounted and why.

## 5. Risk and sign-off

Answer the five `risk.flags` yes or no from the rubric; the script sets the
risk level and the human-review rule. List plausible regulations and, for
each approver, what they will need to see. Encourage the user to bring
security and compliance the data-flow diagram in week one.

## 6. Verdict

Run the gate once the scores are in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/ai-necessity-gate/scripts/gate.mjs" ai-necessity-gate/<slug>/gate.json
```

It prints the verdict, saves it to `gate.json` under `result`, and lists
any narrative fields still missing (exit 2). Write those to fit the
verdict, then run it again to render `gate.md`:

- `reasons`: three to five sentences that explain the verdict from the
  scores and evidence.
- `top_risks`: exactly three, each with what reduces it.
- `first_build`: the smallest build that proves value (one team, one
  document type, one region) and what's left out. For Not AI, the non-AI
  build.
- `measure`: one metric, baseline, target, check date. Value, not hours.
- `data_fixes` (Go after fixing data): gap, owner, how you'll know it's
  fixed.
- `unblock` (Not yet): what would change the verdict and who can do it.

## Report

Show the user the verdict line and the three scores, then point to
`gate.md` (the one-pager for their CEO) and `gate.json` (the scores and
evidence). Mention which scores were 0 because something was unknown, and
what to find out. Offer to re-run the gate when they have the answers.
