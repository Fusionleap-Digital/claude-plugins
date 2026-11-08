# Brief: AI assistant for customer service

*Made-up company and numbers, for illustration.*

**From:** Luis Ferrante, Director of IT, Calder Industrial Supply
**Company:** Distributor of industrial maintenance parts, 650 staff, 14
branches, about 9,000 business customers.

**Problem.** Our customer service team is swamped. We get about 600 calls
and 250 emails a day. Hold times average 7 minutes and customers complain.
The CEO saw a demo of a generative AI chatbot and wants one on our website
and phone line to take the load off.

**Today.** We sampled 500 calls last month. 71% were "where is my order?":
the customer gives a PO or order number and the agent looks it up in our ERP
(order status) and the carrier's site (tracking). Another 12% were "do you
have part X in stock at branch Y", also a lookup in the ERP. The rest are
returns, pricing disputes and technical questions.

Order status, ship dates and tracking numbers are all in the ERP, which is
the source of truth. Carrier tracking comes in through our shipping
system's carrier integration. We don't send shipment notification emails
today; we turned them off years ago after a bad template went out.

**Value.** Customer service is 22 people. The CEO's goal is "save 30% of
agent time". The VP of Customer Service, Ana Ruiz, would own it. Nobody has
put a number on what the saved time is worth; we're not planning layoffs.

**Data.** ERP (orders, inventory, customers) owned by our ERP team, with a
reporting database we can read. Customer contacts include names, phones and
emails of buyers at customer companies.

**Wrong answers.** If the assistant gives a wrong ship date, the customer
plans around it and their maintenance crew is idle. That costs them money
and costs us the account.

**Sign-off.** IT security and our general counsel would want to review
anything customer-facing.
