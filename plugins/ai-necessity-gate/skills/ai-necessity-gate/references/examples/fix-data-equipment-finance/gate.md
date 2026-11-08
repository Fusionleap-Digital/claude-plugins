# Early warning for delinquent accounts

Harbor Point Equipment Finance (fictional) · 2026-11-08 · Prepared by Renee Castillo, CTO · For Helen Mbeki, CFO

> **Verdict: Go after fixing data.** Worth building with AI, once the data gaps below are fixed.

A weekly list of contracts likely to go 30+ days past due in the next 60 days, so collections can call early and offer a payment plan. Outreach priority only: it doesn't change credit terms, limits or pricing.

## Why

- Predicting which current accounts will go late is a forecast from many weak signals, and the existing days-past-due rules only fire after the miss. It passes the Simplicity Test (5 of 8) but not by much, so a rule-based watchlist is the baseline to beat.
- The value is clear and large: net charge-offs were $9.8M last year, and there is a named owner, a sponsor, and a cheap cost for false alarms.
- The data exists and has owners, but it isn't ready (4 of 8): origination isn't in the warehouse, customer IDs don't match after the 2021 re-key, and key fields are 18% to 31% empty in the sample.
- These are weeks of data work, not a research problem. Fix them first, then build; building on the broken join would train the model on mismatched customers.

## Scores

| Test | Score | Result |
|---|---|---|
| Simplicity: does a pipeline do this? | 5/8 | Needs AI |
| Clarity: is the value measurable? | 8/8 | Pass |
| Data: can we trust it? | 4/8 | Fixable |

## Fix the data first

| Gap | Owner | Fixed when |
|---|---|---|
| Origination data isn't in Snowflake. | IT data team with Ravi Shah | Origination tables load nightly with a freshness check. |
| Customer IDs don't match between origination and servicing (17.8% blank in the sample, plus re-keyed IDs). | Ravi Shah and Tom Brandt | A reviewed crosswalk matches at least 98% of active contracts. |
| contract_id repeats in the extract (4 in 1,200 rows). | Servicing operations | contract_id is unique in the extract. |
| industry_code is 22.8% blank. | Credit team | Under 5% blank on active contracts, or blanks are an explicit "unknown" the model can use. |
| Tax IDs and owner contact details sit next to the features. | IT security and the data team | The model reads a masked view with no direct identifiers. |

## Biggest risks

1. The model doesn't beat a simple drift-and-partial-payment rule. *Reduce it:* Back-test both on the same months; ship the rules if the model doesn't clearly win.
2. Features such as state or industry act as proxies for protected classes, creating fair-lending exposure even in collections. *Reduce it:* Compliance reviews the feature list before training; direct identifiers stay out; every flagged customer gets the same plan options; results are documented for the banks.
3. Crosswalk mistakes attach the wrong origination data to a customer. *Reduce it:* Build the crosswalk with a match confidence, have both data owners review it, and leave unmatched contracts out of training.

## First build

After the data fixes: a model trained on servicing history plus crosswalked origination data, back-tested on the first half of 2026 against the rule baseline. If it wins, a weekly top-200 list for two collectors for eight weeks.

**Left out:** Telematics (40% coverage, next version), annual financial statements as features, any automatic action, and any change to terms, limits or pricing.

**Human review:** A person reviews every output in the first build.

**Baseline to beat:** A rule-based watchlist: flag contracts whose payments arrive later each month, that make partial payments, or whose engine hours drop sharply. Build it first as the baseline; the model ships only if it clearly beats these rules in the back-test.

## How to measure it

**Net charge-off rate:** 0.70% today → 0.55% annualized, with the roll rate to 30+ days past due among flagged accounts reviewed monthly from the first list. Check by 2027-12-31.

## Who signs off

Risk: **high**. Plausibly in scope: ECOA and Regulation B (fair lending, including business credit), FCRA, if credit bureau data is used as a feature, GLBA safeguards for customer financial data, State privacy laws for sole proprietors. Counsel confirms what applies.

| Who | What they need to see |
|---|---|
| Security | Data flow from servicing and origination into Snowflake, masked views for the model, where training and scoring run, and who can see the weekly list. |
| Compliance | The feature list with a review for proxies of protected classes, proof that the list only orders outreach, and that every flagged customer is offered the same plan options. |
| Warehouse-line banks | Model documentation: data sources, the back-test against the rule baseline, validation, monitoring and drift checks. |
| Tom Brandt and Ravi Shah, data owners | Which tables and fields, read-only access, and sign-off on the customer ID crosswalk. |
| Helen Mbeki, CFO | The charge-off metric, baseline, target and check date. |

## Score detail

| Criterion | Score | Evidence |
|---|---|---|
| simplicity: input | 0 | Structured data: payment history, days past due, amounts, codes, engine hours. |
| simplicity: rules | 2 | Nobody can write down rules for spotting trouble before a miss: days-past-due rules fire only after one, and the analyst's watchlist is unwritten judgment. |
| simplicity: output | 2 | A probability of 30+ days past due within 60 days, per contract. |
| simplicity: alternative | 1 | Rules on payment-date drift, partial payments and utilization drops would catch some early cases, perhaps half. |
| clarity: value | 2 | Net charge-off rate, 0.70% last year ($9.8M), target 0.55%. |
| clarity: volume | 2 | 11,000 active contracts, a 6.2% 30+ day rate and $9.8M in net charge-offs, all from the servicing system. |
| clarity: owner | 2 | Tom Brandt owns collections and the outcome; the CFO sponsors it. |
| clarity: wrong answer | 2 | A false alarm costs one courtesy call; collectors decide every action; the list never changes terms. |
| data: availability | 1 | Seven years of payment history exist, but origination data isn't in the warehouse, telematics covers about 40% of the fleet, and the two systems don't share a reliable customer key. |
| data: quality | 1 | Profile of the 1,200-row sample: origination_customer_id 17.8% empty, industry_code 22.8% empty, financials_as_of 31.3% empty and newest 300 days old, contract_id has 4 repeated values. Repeats in servicing_customer_id are expected (several contracts per customer). |
| data: access | 1 | Owners are named (Tom Brandt for servicing, Ravi Shah for origination). Servicing lands in Snowflake nightly; origination has no read path yet. |
| data: sensitivity | 1 | The profile flags owner names, tax_id, contact_email and contact_phone. The team knows what's there but has no masking plan yet. |

---

Scored with the AI Necessity Gate rubric v1.0.0 (rule 4). Scores and evidence are in gate.json.
