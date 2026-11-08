# Read lab requisition forms

Ridgeline Veterinary Diagnostics (fictional) · 2026-11-08 · Prepared by Dana Okafor, VP Technology · For Priya Natarajan, CEO

> **Verdict: Go.** Build it. The problem needs a model, the value is measurable, and the data can be trusted.

Extract the fields from faxed and scanned requisition forms, pre-fill the LIMS record, and have accessioning staff confirm it instead of typing it. About 2,300 forms a day from 1,400 clinics, each with its own layout.

## Why

- The inputs are scans of about 1,400 different, often handwritten forms, so no fixed template or rule set can read them; this is the kind of work a model is for.
- The value is measurable today: median receipt-to-in-testing time is 3.4 hours against a 1-hour target, and wrong-test re-runs cost about $3,400 a week.
- Three years of scans already linked to keyed records give a ready-made test set, and the data sits with a clear owner and an existing read path.
- Owner contact data is already restricted and masked, and processing stays in Ridgeline's own Azure tenant, so the main sign-off questions have answers.
- Data quality is the softest score: it hasn't been profiled, and the keyed records include the 3.1% error rate. Profile a sample in week one.

## Scores

| Test | Score | Result |
|---|---|---|
| Simplicity: does a pipeline do this? | 8/8 | Needs AI |
| Clarity: is the value measurable? | 8/8 | Pass |
| Data: can we trust it? | 7/8 | Pass (not profiled) |

## Biggest risks

1. Accuracy on poor faxes and handwriting is too low for confirming to beat typing. *Reduce it:* Measure field-level accuracy on 500 audited forms before building the screen; send low-confidence forms straight to manual keying.
2. Staff wave through pre-filled fields, so errors that typing would catch get saved. *Reduce it:* Require explicit confirmation of species and test codes, highlight unsure fields, and audit a weekly sample against today's 3.1%.
3. The keyed records used as answers carry their own errors, so accuracy looks better or worse than it is. *Reduce it:* Build the test set only from forms checked in last quarter's audit.

## First build

One lab, the 50 clinics that send the most paper (about 40% of its paper volume), plus referral-lab forms. Extract clinic, vet, species, animal ID, tests and owner contact; pre-fill LIMS; staff confirm every record. Run it for eight weeks next to the current process.

**Left out:** The other two labs, free-text clinical history, saving without confirmation, and any change to how samples are routed.

**Human review:** A person reviews outputs below a confidence threshold, plus a sample of the rest.

**Baseline to beat:** Grow the clinic web portal past its 30% share: onboarding calls for the top 100 paper clinics and a tick-box fax form for the 50 most-ordered tests. Keep doing this alongside the build; every portal order skips extraction entirely.

## How to measure it

**Median time from sample receipt to in testing, at the pilot lab:** 3.4 hours today → under 1 hour, with the keying error rate at or below 3.1%. Check by 2027-03-31.

## Who signs off

Risk: **medium**. Plausibly in scope: State veterinary record confidentiality rules, State consumer privacy laws for pet owners' contact data. Counsel confirms what applies.

| Who | What they need to see |
|---|---|
| IT security lead | Data-flow diagram from scan to model to LIMS, Azure tenant and model deployment settings, who can see the confirm screen, and how prompts, images and outputs are logged and retained. |
| Compliance manager | Which owner contact fields are extracted, retention for images and model logs, and the confirm-every-record design. |
| Marcus Reyes, lab operations | Field-level accuracy on audited forms, the confirm screen, and the fallback to typing. |
| Priya Natarajan, CEO | The turnaround metric, baseline, target and check date. |

## Score detail

| Criterion | Score | Evidence |
|---|---|---|
| simplicity: input | 2 | Faxed and scanned paper, many handwritten, about 1,400 different clinic layouts. |
| simplicity: rules | 2 | Where each field sits differs by clinic and by hand; staff read the form, they don't follow rules. |
| simplicity: output | 2 | Values extracted from unstructured images: species, tests, clinic, vet, owner contact. |
| simplicity: alternative | 2 | The web portal already takes 30% of orders and has been pushed for years; rural clinics and referral labs stay on paper, so it solves well under 40% of today's paper volume. |
| clarity: value | 2 | Median receipt-to-in-testing time, 3.4 hours today; plus about $3,400 a week in wrong-test re-runs. |
| clarity: volume | 2 | 2,300 forms a day from LIMS counts; 4 minutes a form; 40 re-runs a week at $85. |
| clarity: owner | 2 | Marcus Reyes owns the process and outcome; the CEO sponsors it with budget set aside. |
| clarity: wrong answer | 2 | Cost is known (wrong test, wrong clinic). Staff confirm every record and low-confidence fields are highlighted. |
| data: availability | 2 | 1.9 million scans, each linked to the LIMS record keyed from it: three years of right answers to test against. |
| data: quality | 1 | Not profiled yet. The keyed records carry the known 3.1% error rate, so they are noisy as answers; audited forms can serve as a clean test set. |
| data: access | 2 | Marcus Reyes owns LIMS and the document store; read-only access to both already exists in Azure for reporting. |
| data: sensitivity | 2 | Owner contact data (PII) is already in a restricted LIMS table and masked in logs. Processing stays in their Azure tenant under terms that exclude training. Animal records are not PHI. |

---

Scored with the AI Necessity Gate rubric v1.0.0 (rule 3). Scores and evidence are in gate.json.
