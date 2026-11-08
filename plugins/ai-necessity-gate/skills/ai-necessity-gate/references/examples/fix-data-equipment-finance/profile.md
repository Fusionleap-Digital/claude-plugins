# Data profile

As of 2026-11-08. Counts, rates and column names only: no values were printed or stored.

## contracts_sample.csv

1,200 rows, 19 columns (csv). Candidate keys: none. Duplicate rows: 0.

| Column | Type | Empty | Distinct | Key | Freshness | Sensitive |
|---|---|---|---|---|---|---|
| `contract_id` | string | 0.0% | 1,196 | 4 repeats |  |  |
| `servicing_customer_id` | string | 0.0% | 516 | 684 repeats |  |  |
| `origination_customer_id` | string | 17.8% | 458 | 528 repeats |  |  |
| `legal_name` | string | 0.0% | 516 |  |  |  |
| `owner_first_name` | string | 64.3% | 4 |  |  | PII: person name (name) |
| `owner_last_name` | string | 64.3% | 3 |  |  | PII: person name (name) |
| `tax_id` | string | 64.3% | 272 | 156 repeats |  | financial: tax id (name) |
| `contact_email` | string | 0.0% | 516 |  |  | PII: email (name; 1200 values match) |
| `contact_phone` | string | 0.0% | 738 |  |  | PII: phone (name; 1200 values match) |
| `industry_code` | integer | 22.8% | 6 |  |  |  |
| `equipment_type` | string | 0.0% | 6 |  |  |  |
| `original_amount` | integer | 0.0% | 512 |  |  |  |
| `term_months` | integer | 0.0% | 4 |  |  |  |
| `funded_date` | date | 0.0% | 685 |  | newest 8d old, spans 2399d |  |
| `last_payment_date` | date | 0.0% | 80 |  | newest 1d old, spans 131d |  |
| `days_past_due` | integer | 0.0% | 7 |  |  |  |
| `financials_as_of` | date | 31.3% | 378 |  | newest 300d old, spans 693d |  |
| `annual_revenue` | integer | 31.0% | 289 |  |  |  |
| `state` | string | 0.0% | 7 |  |  |  |

**Issues**

- No single column is unique and complete, so there is no obvious primary key.
- `contract_id` looks like an ID but has 4 repeated value(s).
- `servicing_customer_id` looks like an ID but has 684 repeated value(s).
- `origination_customer_id` looks like an ID but has 528 repeated value(s) and 214 empty.
- `owner_first_name` is 64.3% empty.
- `owner_last_name` is 64.3% empty.
- `tax_id` is 64.3% empty.
- `tax_id` looks like an ID but has 156 repeated value(s) and 772 empty.
- `industry_code` is 22.8% empty.
- `financials_as_of` is 31.3% empty.
- `financials_as_of`: newest value is 300 days old.
- `annual_revenue` is 31.0% empty.
