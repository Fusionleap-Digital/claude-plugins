# Brief: early warning for delinquent accounts

*Made-up company and numbers, for illustration.*

**From:** Renee Castillo, CTO, Harbor Point Equipment Finance
**Company:** Independent lender that finances construction and agricultural
equipment for small and mid-size businesses. 11,000 active contracts, $1.4B
portfolio, 280 staff.

**Problem.** We find out a customer is in trouble when they miss a payment.
By then recovery is harder: the equipment may already be idle, moved or
sold. We want a weekly list of accounts likely to go 30+ days past due in
the next 60 days, so collections can call early and offer a payment plan
before it becomes a repossession.

**Today.** Collections works accounts by days past due. A senior analyst
also keeps a spreadsheet watchlist from gut feel, industry news and
utilization reports. Last year 6.2% of contracts went 30+ days past due and
net charge-offs were $9.8M (both from the servicing system). Our collections head, Tom Brandt, thinks early
contact cuts losses on an account by about a third.

**Value.** Net charge-off rate on the portfolio (0.70% last year). Target
0.55%. Tom Brandt owns collections and the outcome; our CFO, Helen Mbeki,
is the sponsor.

**Data.** Payment history (7 years) is in the servicing system. Origination
data (application, credit pull, financial statements, industry code) is in
a separate loan origination system. Telematics (engine hours) for about 40%
of the fleet comes from the manufacturers. A sample export of the contract
table we'd join on is attached (`contracts_sample.csv`, 1,200 rows of
synthetic data with our real column layout). We know the customer ID doesn't
always match between origination and servicing, because servicing re-keyed
customers in a 2021 migration. Industry codes are often blank. Financial
statements are updated once a year at renewal, if at all.

Servicing data is owned by Tom's operations team; origination data by the
credit team (Ravi Shah). IT can set up read access in our Snowflake
warehouse, where servicing already lands nightly; origination does not land
there yet. The data includes owner names, tax IDs, emails and phones for
sole proprietors, plus financial statements.

**Wrong answers.** A missed account is what happens today. A false alarm is
a polite call to a good customer. The list only prioritizes outreach; it
does not change credit terms, limits or pricing. Collections staff decide
what to do with each account.

**Sign-off.** Security, compliance (we follow fair-lending practice even on
the servicing side), and our warehouse-line banks, who ask for model
documentation on anything that affects credit.
