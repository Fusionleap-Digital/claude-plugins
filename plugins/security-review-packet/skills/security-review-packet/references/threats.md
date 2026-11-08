# Prompt injection and tool misuse: what to check

For each threat: when it applies, what in `inventory.json` points at it,
what counts as a mitigation (only if you can cite the line), and what to
ask. Keep the rows that apply to this system; drop the rest.

Mitigations in `controls` are signals, not proof. Open the file and check
that the control is applied on the path in question. A rate limiter
imported in one route does not protect the others.

| # | Threat | Applies when | Inventory fields | Counts as a mitigation (cite it) | Ask if missing | OWASP LLM |
|---|---|---|---|---|---|---|
| T1 | Direct prompt injection: a user tells the model to ignore its rules | Any user-facing model call | `routes.items`, `providers` | Tools scoped to the caller's own data; authorization checked in tool code, not in the prompt; output validation | Which actions could a user talk the model into that their role doesn't allow? | LLM01 |
| T2 | Indirect prompt injection from retrieved documents, uploads, web pages, emails or tool results | RAG, `fetch_url`-style tools, document ingestion | `dataHandling.vectorWrites`, `hosts.dynamicCalls`, tools with `network` | Retrieved text wrapped and marked untrusted (`controls.untrustedContentMarking`); tools that change data need approval; ingestion limited to trusted sources | Who can add documents to the index? Can a document's text trigger a tool call without a person seeing it? | LLM01 |
| T3 | Data exfiltration through a tool: injected text makes the model send data to an attacker URL or email | Any tool with `network` or `sendMessage` capability, plus any tool that reads data | `agents.tools[].capabilities` | Host allowlist on outbound fetch; approval before sending; recipients limited to known addresses | Can the model put data from one tool's result into another tool's URL or message? | LLM01, LLM06 |
| T4 | Exfiltration through rendered output: markdown images or links to attacker hosts in the chat UI | Model output rendered as markdown/HTML | grep the UI for markdown renderers, `dangerouslySetInnerHTML` | Image hosts allowlisted; CSP `img-src` restricted; links shown as text | Does the chat UI render images from any host? | LLM05 |
| T5 | Excessive agency: a tool can do more than the feature needs (shell, arbitrary SQL, file writes, payments, email) | Tools with `shell`, `codeEval`, `arbitrarySql`, `dbWrite`, `fileWrite`, `payments`, `sendMessage` | `agents.tools`, flags in area `agent-tools` | Narrow tool (fixed query with parameters instead of SQL text); read-only DB role; framework approval step (`needsApproval`, `interrupt`, `canUseTool`) | What is the worst single call this tool can make? Which DB role does it run as? | LLM06 |
| T6 | SSRF: a fetch tool reaches internal addresses (cloud metadata at 169.254.169.254, internal services) | Tools that fetch a URL chosen at run time | `hosts.dynamicCalls` inside a tool | Allowlist of hosts; block private and link-local ranges after DNS resolution; no redirects to private ranges | Where does this code run, and what can it reach on the network? | LLM06 |
| T7 | Cross-tenant leakage through retrieval: vector search returns another customer's chunks | Multi-tenant apps with a shared index | `datastores` (vector), `controls.tenantIsolation` | Tenant filter on every query, enforced server-side from the session (not from the request body); separate namespaces or row-level security | Is the tenant ID ever taken from the client? Is there a test for it? | LLM08, LLM02 |
| T8 | Sensitive data disclosure: the model repeats PII/PHI from context to someone who shouldn't see it, or it lands in logs and traces | Restricted data in prompts | `dataTerms`, `dataHandling.promptLogging`, vendors with `receivesPrompts` | Redaction before the call or before logging (`controls.piiRedaction`); log fields limited; tracing vendor masking | Which logs and traces contain prompts, who can read them, how long are they kept? | LLM02 |
| T9 | System prompt leakage: secrets or internal rules in the system prompt | System prompts with keys, internal URLs or access rules | grep `SYSTEM_PROMPT`, `system:` | No secrets in prompts; access rules enforced in code | Is anything in the system prompt sensitive if a user sees it? | LLM07 |
| T10 | Improper output handling: model output used as SQL, shell, HTML, file paths or URLs without checks | Output flows into code paths | tools with `arbitrarySql`/`shell`; `controls.outputValidation` | Structured output with a schema; parameterized queries; escaping | Where does model output get executed or rendered? | LLM05 |
| T11 | Unbounded consumption: cost or denial of service through long inputs, loops or many requests | Every public or signed-in model route | `controls.rateLimit`, `controls.tokenAndStepLimits`, `controls.inputValidation` | Per-user rate limit; max input size; max steps and max output tokens; spend alerts | What stops one account from running up the bill? Is there a spend alert at the provider? | LLM10 |
| T12 | Supply chain: compromised model, package or MCP server | Every repo | `dependencies.audit`, `mcp.configs` (unpinned `npx`/`uvx`), `models` | Lockfile; audit in CI; pinned MCP server versions; models from a known provider | Who reviews new MCP servers and dependency upgrades? | LLM03 |
| T13 | Poisoned index: someone adds documents that steer answers | RAG with user or third-party uploads | ingest routes, `dataHandling.vectorWrites` | Auth on ingest; source recorded per chunk; review before indexing | Who can write to the index, and can you trace an answer back to its source chunk? | LLM04 |
| T14 | Over-reliance: the model's answer is treated as a decision | Answers that drive claims, credit, clinical or legal decisions | Section 7 human-in-the-loop points | A person approves; citations shown; disclaimers in the UI | Which decisions does a person make, and which does the model make? | LLM09 |
| T15 | MCP server trust: a configured MCP server gets broad credentials or returns injected text | `mcp.configs` | env and header names on each server | Read-only credentials; servers from known publishers, pinned; tool results treated as untrusted | What credentials does each MCP server hold, and who added it? | LLM03, LLM06 |

## Commands for a closer look

Run from the repo root.

```bash
# Model output rendered as HTML or markdown in the UI
grep -rnE "dangerouslySetInnerHTML|react-markdown|marked\(|markdown-it|rehype-raw|v-html" --include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.vue' --exclude-dir=node_modules .

# Tenant or user ID read from the request instead of the session
grep -rnE "(body|params|query|searchParams)\.(get\()?['\"]?(tenant|org|user|account)_?[iI]d" --include='*.ts' --include='*.tsx' --include='*.py' --exclude-dir=node_modules .

# Raw SQL built from strings
grep -rnE 'queryRawUnsafe|executeRawUnsafe|execute\(f"|query\(`' --include='*.ts' --include='*.py' --exclude-dir=node_modules .
```
