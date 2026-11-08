# Framework coverage map

Use this only when the user asks for the framework appendix. It maps packet
sections and inventory fields to the areas common security questionnaires
ask about, so the team can see what evidence exists and what is missing.

It is not a compliance assessment. Never write that the system "is
compliant" or "meets" a framework. Use these statuses:

- **Evidence in code**: the packet cites code or IaC that addresses the area.
- **Partial**: some of it is in code; the rest is a gap or needs the team.
- **Gap**: the packet found nothing, or found a problem (cite the flag).
- **Not assessed**: process, policy or people controls the code can't show.

Most governance and process areas are **Not assessed** by design. Say so
rather than leaving them out.

Include HIPAA rows only if PHI is in scope (the team says so, or `dataTerms.phi`
has real hits and the team confirms). Include GLBA rows only for financial
institutions handling consumer financial data.

## Rows to fill

| Framework | Area | Packet section | Inventory fields |
|---|---|---|---|
| SOC 2 CC6.1 | Logical access: authentication and authorization on entry points | 4 | `routes`, `iac.resources[].exposure` |
| SOC 2 CC6.1 | Encryption of data at rest | 3, 4 | `iac.resources[].encryption` |
| SOC 2 CC6.2–6.3 | User provisioning and role-based access | 4 | identity provider in `vendors` (auth); mostly Not assessed |
| SOC 2 CC6.6 | Boundary protection: public endpoints, network rules | 4 | `iac.resources[].exposure`, public routes |
| SOC 2 CC6.7 | Data in transit and to third parties | 2, 8 | `hosts`, `providers`, `vendors` |
| SOC 2 CC6.8 | Malicious or unauthorized software | 6 | `dependencies.audit`, `mcp.configs` |
| SOC 2 CC7.1 | Vulnerability and configuration management | Appendix B | `dependencies.audit`, flags in `infrastructure` |
| SOC 2 CC7.2 | Monitoring for anomalies and security events | 5 | `controls.auditLogging`, `vendors` (apm, error-monitoring) |
| SOC 2 CC7.3–7.5 | Incident response | 9 | Not assessed unless a runbook exists in the repo |
| SOC 2 CC8.1 | Change management | — | Not assessed (CI, code review, branch protection live outside the code) |
| SOC 2 CC9.2 | Vendor and business partner risk | 8 | `providers`, `vendors`, `datastores` with `vendor: true` |
| SOC 2 C1.1–C1.2 | Confidential data: identified, protected, disposed of | 3 | `dataTerms`, `controls.retentionSettings` |
| SOC 2 P (Privacy) | Notice, use, retention and disposal of personal data | 3 | `dataTerms.pii`; mostly Not assessed |
| NIST AI RMF GOVERN 1 | Policies, roles and accountability for AI risk | 9, 10 | Not assessed |
| NIST AI RMF GOVERN 6 | Third-party AI risk (models, data, vendors) | 8 | `providers`, `models`, `vendors` |
| NIST AI RMF MAP 1 | Context: intended use, users, impact | 1 | Assumed until the team confirms |
| NIST AI RMF MAP 4 | Risks from third-party components and data | 3, 8 | `providers`, `dependencies` |
| NIST AI RMF MEASURE 2.7 | Security and resilience evaluated | 6 | `agents.tools`, `controls` |
| NIST AI RMF MEASURE 2.10 | Privacy risk examined | 3 | `dataTerms`, `dataHandling` |
| NIST AI RMF MANAGE 2.4 | Ability to disengage or deactivate the system | 9 | kill switch, feature flags; often Gap |
| NIST AI RMF MANAGE 4.1 | Post-deployment monitoring | 5 | `controls.auditLogging`, LLM tracing vendors |
| ISO/IEC 42001 A.2 | AI policy | — | Not assessed |
| ISO/IEC 42001 A.4 | Resources: data, tools, systems documented | 1, 2 | the whole inventory |
| ISO/IEC 42001 A.5 | AI system impact assessment | 3, 10 | Not assessed unless one exists |
| ISO/IEC 42001 A.6 | AI system life cycle: requirements, verification, deployment, monitoring | 5, 6 | evals and tests in the repo; often Gap |
| ISO/IEC 42001 A.7 | Data for AI systems: provenance, quality, preparation | 3 | ingestion routes, `dataHandling.vectorWrites` |
| ISO/IEC 42001 A.8 | Information for users and interested parties | 7 | UI disclaimers; Not assessed from backend code |
| ISO/IEC 42001 A.9 | Responsible use: human oversight, intended use | 7 | `controls.humanApproval` |
| ISO/IEC 42001 A.10 | Third-party and customer relationships | 8 | `providers`, `vendors` |
| OWASP LLM01 | Prompt injection | 6 | T1–T3 in threats.md |
| OWASP LLM02 | Sensitive information disclosure | 3, 5, 6 | `dataHandling.promptLogging`, T8 |
| OWASP LLM03 | Supply chain | 6, Appendix B | `dependencies.audit`, `mcp.configs` |
| OWASP LLM04 | Data and model poisoning | 6 | T13 |
| OWASP LLM05 | Improper output handling | 6 | T4, T10 |
| OWASP LLM06 | Excessive agency | 6, 7 | `agents.tools`, T5, T6 |
| OWASP LLM07 | System prompt leakage | 6 | T9 |
| OWASP LLM08 | Vector and embedding weaknesses | 3, 6 | `controls.tenantIsolation`, T7 |
| OWASP LLM09 | Misinformation | 7 | T14 |
| OWASP LLM10 | Unbounded consumption | 6 | `controls.rateLimit`, `controls.tokenAndStepLimits`, T11 |
| HIPAA §164.312(a) | Access control (unique user IDs, emergency access, automatic logoff, encryption) | 4 | `routes`, session lifetime, `iac` encryption |
| HIPAA §164.312(b) | Audit controls | 5 | `controls.auditLogging` |
| HIPAA §164.312(c) | Integrity | 6 | tools with `dbWrite` and their approval steps |
| HIPAA §164.312(d) | Person or entity authentication | 4 | identity provider |
| HIPAA §164.312(e) | Transmission security | 2 | `hosts` (TLS), DB `ssl` settings |
| HIPAA §164.308(b) | Business associate agreements | 8 | Ask team, per vendor |
| HIPAA §164.308(a)(6) | Security incident procedures | 9 | Not assessed |
| GLBA Safeguards §314.4(c)(1) | Access controls on customer information | 4 | `routes`, tenant isolation |
| GLBA Safeguards §314.4(c)(3) | Encryption in transit and at rest | 2, 3 | `iac.resources[].encryption`, `hosts` |
| GLBA Safeguards §314.4(c)(8) | Monitoring and logging of user activity | 5 | `controls.auditLogging` |
| GLBA Safeguards §314.4(f) | Service provider oversight | 8 | `providers`, `vendors` |
| GLBA Safeguards §314.4(h) | Written incident response plan | 9 | Not assessed |

## Wording

Good: "Partial. Auth check on 5 of 7 routes [Found: …]; /api/ingest has none (F-002)."
Good: "Not assessed. Change management lives in CI and code review settings, which this scan doesn't read."
Bad: "SOC 2 compliant." Bad: "Meets HIPAA requirements."
