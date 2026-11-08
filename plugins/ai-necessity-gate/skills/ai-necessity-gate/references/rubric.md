# AI Necessity Gate rubric

Three tests, four criteria each, each criterion scored 0, 1 or 2. Claude
scores the criteria from the evidence. `scripts/gate.mjs` adds them up and
applies the verdict rules below, so the same scores always give the same
verdict.

| Test | Question |
|---|---|
| Simplicity | Does a deterministic pipeline do this? |
| Clarity | Is the outcome measurable in value, not hours? |
| Data | Is the data governed enough to trust the output? |

## How to score

- **Score what is true today**, not what the plan says will be true.
- **Unknown scores 0.** If nobody can say, the evidence is "not known" and
  the score is 0. This is what keeps the Gate honest; the fix is to find out,
  not to guess high.
- **Quote the evidence.** Each score carries one line saying why: a number
  from the intake, a profile finding, or "not known".
- **Split mixed use cases.** If part of the work needs a model and part is a
  lookup, gate them as two use cases. "Answer customer emails" is often a
  lookup (order status) plus a judgment (complaints).
- **Judge the problem, not the pitch.** The question is whether the problem
  needs AI, not whether the proposed solution uses it.
- **Use the best evidence in the intake.** Score from every fact given, not
  only the ones the sponsor framed as the goal. If the stated goal is
  "hours saved" but the brief also gives a customer-facing number with a
  baseline, score that number and say the stated goal was hours.
- **Judge the hardest step.** For `input` and `rules`, score the hardest
  thing the system has to do. A form whose fields are known but handwritten
  is unstructured input.
- **Weakest source wins.** When the first build needs several data sources,
  score each Data criterion by the weakest one it needs.
- **Risk flags describe the use case as proposed**, even when the verdict
  is Not AI.

## Simplicity Test

High scores mean a model is needed. Low scores mean plain software will do.

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| `input`: what goes in | Structured fields: IDs, codes, numbers, picklists | Semi-structured: a few known templates, forms with fixed layouts, tables with free-text columns | Unstructured and varied: free text, scans, images, audio, many layouts |
| `rules`: can someone write the logic down? | Yes. A person could list the rules today, or they exist in a policy | Mostly. Rules cover the common cases; exceptions are frequent (roughly 1 in 5 or more) | No. Experts decide from experience or examples and can't state the rules |
| `output`: what comes out | A lookup, filter, count, sum or fixed report | A ranking or a choice among a known, short list of options | Generated text, a forecast or probability, or values extracted from unstructured input |
| `alternative`: best non-AI option | Rules, search, a report, a form, a process change or an integration would solve 80% or more of the problem as it stands today | It would solve 40% to 79% | It would solve under 40%, or it has been tried and stalled |

For `alternative`, name the option in `alternative.best` (`rules`,
`search`, `report`, `form`, `process`, `integration` or `none`) and describe
it in `alternative.description`, even when AI wins. That option is also the
baseline the AI build has to beat.

**Passes** when the total is 4 or more and `alternative` is not 0.

## Clarity Test

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| `value`: the outcome metric | Only "hours saved", "productivity" or "efficiency", or none | A business metric is named (revenue, cost, loss, risk, cycle time a customer feels) but there is no baseline | A business metric with today's baseline number |
| `volume`: how often and what it costs | Not known | Estimated ("about 600 a day"), or counted but with no cost per unit or per year | Counted from a system or an audit, with the current cost per unit or per year |
| `owner`: who owns the outcome | Nobody named | A business owner or an executive sponsor, not both | A named business owner who will use it and an executive sponsor (an executive who asked for it or controls the budget) |
| `wrong_answer`: cost of a mistake | Not known | Known, but no review step or fallback is defined | Known, and there is a review step, a fallback, or the cost is small enough to accept |

Hours saved can be part of the story, but it scores 0 on its own: hours
saved only become value if they are spent on something that earns or
protects money. Ask what the hours turn into.

**Passes** when the total is 5 or more, and `value` and `owner` are both at
least 1.

## Data Test

Use the profile (`scripts/profile.mjs`) when the user can share a sample,
schema or dictionary. Without one, score from what they tell you and say
the data score is unverified. Two rules keep that repeatable:

- `quality` can't score 2 without a profile or a recent data audit. A
  measured problem the user states (an audited error rate, a field known to
  be often blank) scores 1. Nothing stated scores 0.
- "Classified" means someone has listed which fields are sensitive, in the
  intake or a dictionary. "There's customer data in there" is not a list.

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| `availability`: does the data exist? | It isn't captured, or only in people's heads or inboxes | Partly: some fields or history are missing, or it has to be joined across systems without a shared key | The needed fields exist in a system, with enough history and examples of right answers to test a model against (for a lookup, the facts the answer comes from) |
| `quality`: can it be trusted? | Unknown, or known to be poor | Known problems that a few weeks of work would fix: key fields over 5% empty, duplicate keys, stale feeds, inconsistent codes | Checked: key fields under 5% empty, keys unique, fresh enough for the decision |
| `access`: owner and path | No owner for the data | An owner is known, but there is no approved read path yet | A named owner and a read path (warehouse, API, export) that is approved or routine to approve |
| `sensitivity`: is it governed? | Not classified, or sensitive data with no plan | Sensitive data is classified, but there is no masking, tokenization or boundary plan yet | No sensitive data, or it is classified and there is a plan: masked or tokenized at the source, kept in the client's cloud, provider terms that exclude training on it |

Sensitive means personal data (PII), health data (PHI), payment card data
and other regulated financial data. Animal health records are not PHI, but
the owner's name, address and phone are PII.

**Passes** when the total is 7 or more and no criterion is 0.
**Fixable** when it doesn't pass but `availability` and `access` are both at
least 1: the data exists and someone owns it.

## Verdict

Applied in this order. The first rule that matches wins.

| # | Rule | Verdict |
|---|---|---|
| 1 | Simplicity fails | **Not AI.** Build the alternative. |
| 2 | Clarity fails | **Not yet.** Define the value and the owner first. |
| 3 | Data passes | **Go.** |
| 4 | Data is fixable | **Go after fixing data.** Fix the listed gaps, then build. |
| 5 | Otherwise | **Not yet.** The data doesn't exist or nobody owns it. |

Simplicity comes first on purpose. If a plain pipeline does the job, data
quality and value don't change the answer: build the pipeline. That is a
good result. It is usually faster, cheaper and easier to audit.

"Not yet" is not "no". Say exactly what would change the verdict.

## Risk and sign-off

Risk doesn't change the verdict. It changes how the first build is shaped
and who needs to see what. Answer each flag yes or no in `risk.flags`:

| Flag | Yes when |
|---|---|
| `decisions_about_people` | Output decides or strongly steers credit, insurance, employment, housing, healthcare or benefits for a person. Changing terms, limits, approvals or prices counts; ordering who gets a courtesy call does not |
| `regulated_data` | PHI, cardholder data, nonpublic financial data (GLBA), or special-category personal data is processed |
| `unreviewed_external_output` | Output reaches customers, patients or the public without a person checking it |
| `personal_data` | Any personal data is processed |
| `money_movement` | Output moves money, sets prices, or commits the company to spend |

- **High** if `decisions_about_people`, `regulated_data` or
  `unreviewed_external_output` is yes. A person reviews every output in the
  first build.
- **Medium** if `personal_data` or `money_movement` is yes. A person reviews
  outputs below a confidence threshold, plus a sample of the rest.
- **Low** otherwise. Spot checks are enough.

List the regulations that plausibly apply in `risk.regulations` (for
example HIPAA, GLBA, PCI DSS, ECOA and Regulation B, GDPR, CCPA/CPRA, state
privacy laws, the EU AI Act, SOX). Say "plausibly"; the client's counsel
decides what applies.

### Sign-off

For each group that has to approve, say what they will need to see.
Typical:

| Who | What they need to see |
|---|---|
| Security | Data-flow diagram, where data is stored and processed, model provider and its terms, access control, logging, and how prompts and outputs are retained |
| Privacy or compliance | Data classification, the purpose, the legal basis or notice, retention, and the human-review design |
| Data owner | Which tables and fields, read-only access, and the refresh schedule |
| Legal | Provider contract and data-processing terms, and any customer-facing disclosures |
| Model risk (lenders, insurers) | How the model is validated, monitored and explained |
| Business owner | The metric, the baseline, the target and the check date |

Security and compliance are partners in the design. Bring them in during
the first week with the data-flow diagram, not at the end with a finished
build. Never describe them as a blocker, a veto or a hurdle.

## The rest of the one-pager

| Field | What goes in it |
|---|---|
| `reasons` | Three to five plain sentences that explain the verdict. Cite scores and evidence |
| `top_risks` | Exactly three. The biggest ways this fails, each with what reduces it |
| `first_build` | The smallest build that proves value: one team, one document type, one region. For Not AI, the non-AI build. Include what is left out |
| `measure` | One metric, today's baseline, a target, and the date to check. Value, not hours |
| `data_fixes` | Go after fixing data only. Each gap, the owner, and how you'll know it's fixed |
| `unblock` | Not yet only. What would change the verdict, and who can do it |
