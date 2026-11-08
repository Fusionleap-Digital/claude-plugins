# Answer order and stock questions

Calder Industrial Supply (fictional) · 2026-11-08 · Prepared by Luis Ferrante, Director of IT · For the CEO

> **Verdict: Not AI.** You don't need AI for this. A system integration will do it faster, cheaper and easier to audit.

A generative AI chatbot on the website and phone line to answer customer service contacts. Gated here: the 83% of calls that are "where is my order" (71%) and "is part X in stock at branch Y" (12%). Returns, pricing disputes and technical questions are a separate use case.

## Why

- 83% of contacts ask for a fact that already sits in the ERP, keyed by an order or part number. That is a lookup, not a judgment, and it scores 0 of 8 on the Simplicity Test.
- A chatbot would add model cost and the risk of a confidently wrong ship date to a question that has one exact answer.
- Proactive shipment emails stop many of these calls before they happen, which no chatbot can do.
- "Save 30% of agent time" is not yet a value. Hold time, 7 minutes today, and the accounts at risk from late or wrong answers are the numbers to track.
- Returns, pricing disputes and technical questions (17% of calls) may need judgment. Gate them separately once these calls are gone.

## Scores

| Test | Score | Result |
|---|---|---|
| Simplicity: does a pipeline do this? | 0/8 | A pipeline will do |
| Clarity: is the value measurable? | 6/8 | Pass |
| Data: can we trust it? | 5/8 | Fixable (not profiled) |

## Build this instead

Turn shipment emails back on (order confirmed, shipped with tracking link, delayed with new date) from a reviewed template. Add order lookup by PO or order number to the customer portal and the phone menu. Then a branch stock lookup for signed-in customers, the same way. All of it reads the ERP and carrier data agents already use.

## Biggest risks

1. ERP promise dates are wrong often enough that proactive emails spread bad dates faster. *Reduce it:* Compare promise dates with carrier delivery for one month before turning on delay emails.
2. A template mistake repeats what got emails turned off years ago. *Reduce it:* Review templates with customer service and counsel, send to 5% of customers first, and watch replies and unsubscribes.
3. Customers keep calling out of habit, so call volume barely moves. *Reduce it:* Put the order link in every confirmation, offer the lookup first in the phone menu, and have agents send the link on each call.

## First build

Shipment emails (confirmed, shipped with tracking, delayed) from a reviewed template, plus order lookup by PO or order number in the customer portal and the phone menu. About six weeks with the ERP team.

**Left out:** Any chatbot; the branch stock lookup (next, same pattern); returns, pricing disputes and technical questions, which get their own gate.

## How to measure it

**"Where is my order" calls per day:** about 425 (71% of 600) today → under 200, with average hold time under 3 minutes. Check by 2027-03-31.

## Who signs off

Risk of the AI version as proposed: **high**. Plausibly in scope: State consumer privacy laws for buyer contact data, CAN-SPAM for shipment emails. Counsel confirms what applies.

| Who | What they need to see |
|---|---|
| IT security | Which ERP fields the portal, phone menu and emails expose, how customers are authenticated before seeing an order, and logging. |
| General counsel | The shipment email templates and the wording of delay notices. |
| Ana Ruiz, customer service | The call categories that move to self-service and how agents point callers to it. |
| ERP team | Read access for the portal and phone menu, and the refresh timing of ship dates. |

## Score detail

| Criterion | Score | Evidence |
|---|---|---|
| simplicity: input | 0 | The customer gives a PO or order number, or a part number and a branch. |
| simplicity: rules | 0 | Agents follow one rule: look the number up in the ERP and the carrier site. |
| simplicity: output | 0 | A lookup: order status, ship date, tracking link, stock on hand. |
| simplicity: alternative | 0 | Shipment emails, an order-status page and an IVR lookup by order number would answer most of the 83%, from the same ERP data, with exact answers. |
| clarity: value | 2 | The stated goal is agent hours, which scores 0 alone. But average hold time, 7 minutes today, is a wait customers feel and complain about. |
| clarity: volume | 1 | About 600 calls and 250 emails a day; categories from a counted 500-call sample; no cost per contact. |
| clarity: owner | 2 | Ana Ruiz would own it; the CEO asked for it. |
| clarity: wrong answer | 1 | Cost is clear (idle crews, lost accounts), but no review step or fallback is defined for a chatbot answer. |
| data: availability | 2 | Order status, ship dates, tracking and stock are all in the ERP, the source of truth. |
| data: quality | 0 | Not known. Nobody has checked how often ERP promise dates match actual delivery. |
| data: access | 2 | ERP team owns it; a reporting database is already readable. |
| data: sensitivity | 1 | Buyer names, phones and emails are listed as the personal data involved; no masking or access plan described. |

---

Scored with the AI Necessity Gate rubric v1.0.0 (rule 1). Scores and evidence are in gate.json.
