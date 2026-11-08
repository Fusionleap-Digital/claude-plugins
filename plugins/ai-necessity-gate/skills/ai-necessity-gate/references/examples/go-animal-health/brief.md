# Brief: read lab requisition forms automatically

*Made-up company and numbers, for illustration.*

**From:** Dana Okafor, VP Technology, Ridgeline Veterinary Diagnostics
**Company:** Regional veterinary reference lab, 420 staff, three labs in the US Midwest.

**Problem.** Every sample that arrives comes with a requisition form: which
animal, which tests, the clinic, the vet, and the owner's contact details.
About 1,400 client clinics send us 2,300 forms a day (LIMS counts, last
quarter). Most are faxed
or scanned paper. Each clinic uses its own form, many handwritten. Nine
accessioning staff key every form into our LIMS by hand.

**Today.** Keying takes about 4 minutes a form. Samples wait in the queue
until they are keyed, so on busy mornings results go out 6 to 8 hours later
than they should. Our audit last quarter found a 3.1% keying error rate. The
expensive errors are the wrong test or wrong species: those cause re-runs
(40 a week on average last quarter, at $85 each in reagent and tech time) and, worse, late
results for sick animals. Clinics complain about turnaround more than price.

We already have a web portal for clinics to submit orders as structured
data. 30% of volume comes through it. We keep pushing it, but small and rural
clinics don't use it, and referral samples from other labs always come on
paper.

**What we want.** Extract the fields from scanned forms, pre-fill the LIMS
record, and have staff confirm instead of type.

**Value.** Median time from sample receipt to "in testing" is 3.4 hours
today; we want it under 1 hour. Fewer wrong-test re-runs. We'd keep the
same staff and move two people to client support, which is short-handed.

**Data.** Three years of scanned forms (about 1.9 million images) are in our
document store in the same Azure tenant, each linked to the LIMS record that staff keyed from it, so
we have the right answers. LIMS is owned by our lab operations director,
Marcus Reyes, who also owns the document store, and we already have
read-only access to both in Azure for reporting. The forms include pet owners' names, addresses and phone numbers.
No human medical data. We run in our own Azure tenant, and our Azure OpenAI
deployment has data-processing terms that exclude training on our data.
Owner contact fields already sit in a separate LIMS table with restricted
access, and we mask them in logs.

**People.** Marcus Reyes (lab operations) owns the process and the outcome.
Our CEO, Priya Natarajan, is sponsoring it and has set aside budget. Our IT
security lead and our compliance manager will both need to approve.

**Wrong answers.** If a field is extracted wrong and staff don't catch it,
the wrong test runs or the result goes to the wrong clinic. Staff will
confirm every record before it's saved, and any field the system isn't sure
of will be highlighted.
