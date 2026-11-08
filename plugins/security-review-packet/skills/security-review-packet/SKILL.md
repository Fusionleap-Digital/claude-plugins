---
name: security-review-packet
description: Draft the packet a security and compliance team asks for before they sign off on an AI system going to production — system overview and data-flow diagram, data inventory and classification, access control, logging and audit trail, prompt injection and tool-misuse threats, human-in-the-loop points, vendor and sub-processor list, incident contacts and open questions, with an optional SOC 2 / NIST AI RMF / ISO 42001 / OWASP LLM / HIPAA / GLBA coverage table. Works from the repo (and optional infrastructure-as-code) of an LLM app, RAG service or agent, in Node/TypeScript or Python. Use when the user asks for a security review packet, security questionnaire answers, an AI risk assessment, a vendor or data-flow inventory for an AI feature, "what does security need before we launch", or says their AI work is waiting on security review.
---

# Security review packet

Two scripts and one draft:

1. **Inventory** (`scripts/inventory.mjs`): reads the repo and writes
   `inventory.json` and `inventory.md`. Facts only, each with `file:line`.
2. **Draft**: you fill `references/packet-template.md` from the inventory and
   from reading the cited files.
3. **Check** (`scripts/check-packet.mjs`): fails the draft if a statement is
   untagged, a citation is wrong, a critical or high flag is missing, or a
   secret value slipped in. Fix and rerun until it passes.

## Rules

- **Read-only.** Don't change the user's repo. Write output to a folder
  outside it, or one the user names. Tell them not to commit the packet to
  a public repo: it lists the system's gaps.
- **Never print secret values.** The inventory records names and locations
  only. Don't open `.env` files or Terraform state to show values. If a
  secret is in the code, say which file and line, say what kind, and tell
  the user to rotate it.
- **Never invent controls.** Every statement is tagged:
  - `[Found: file:line]` only after you opened the file and saw it.
  - `[Assumed]` for an inference. Say what it rests on.
  - `[Ask team]` for anything the code can't show: contracts, retention,
    console settings, people, process.
  If you didn't find a control, write "none found in this repo". A
  missing control is a finding, not something to fill in.
- **The inventory finds signals, not proof.** A rate limiter imported in one
  route doesn't protect the others; an "approval" keyword in a description
  isn't an approval step. Open the file before you cite it.
- **No compliance claims.** The framework appendix is a coverage map with
  gaps. Never write that the system "is compliant" or "meets" a framework.
- **Copy.** Plain and short. Write for a security reviewer and a CTO.
  Security and compliance "have to sign off"; work is "waiting on security
  review". Never call them a blocker or a veto.
- **Placeholders for people.** Incident contacts are `{{name}}` placeholders.
  Never guess names, emails or phone numbers.

## 1. Scope

Ask, in one message, only what you can't tell from the repo:

- Which repo (default: current directory) and where the infrastructure code
  lives if it's in another repo (`--iac`).
- Which environment the packet covers (usually production).
- Whether regulated data is in scope: PHI (HIPAA), consumer financial data
  (GLBA), card data, children's data. Don't decide this from the code alone.
- Whether they want the framework appendix, and for which frameworks.

## 2. Inventory

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/security-review-packet/scripts/inventory.mjs" <repo> --out <out-dir> [--iac ../infra] [--no-audit]
```

- Default output folder: `security-review-packet-<repo-name>/` in the
  current directory.
- It runs `npm audit --package-lock-only` where a `package-lock.json`
  exists, and `pip-audit --no-deps --disable-pip` on fully pinned
  `requirements*.txt` if `pip-audit` is installed. These send package names
  and versions (no code) to the registry. Use `--no-audit` if the user
  can't allow that.
- Read `inventory.md` first, then `inventory.json` for detail. What it
  collects:

| Field | What |
|---|---|
| `providers`, `models` | Model SDKs and APIs (Anthropic, OpenAI, Azure OpenAI, Bedrock, Vertex, Gemini, Mistral, Cohere, local models…) and model IDs in quoted strings |
| `datastores` | Vector stores, databases, caches, object storage |
| `vendors` | Tracing, analytics, auth, email, payments, search, parsing. `receivesPrompts` marks ones that usually get prompts or documents |
| `hosts` | Hosts in URL literals, SDK default hosts, and fetch calls to URLs built at run time |
| `dataHandling` | Lines that log prompts, store conversations, create embeddings, write vectors, store files |
| `dataTerms` | Lines mentioning PHI, financial or PII field names: hints for classification |
| `env` | Env var names (secret-like or not, browser-exposed), env files and whether git tracks them, hard-coded secret locations |
| `routes` | Next.js routes, server actions and middleware; Express-style; FastAPI; Flask; with the auth check found or `none-found` |
| `agents` | Tools, what each can do (shell, SQL, network, file and DB writes, email, payments) and any approval step; agent loop settings |
| `mcp` | MCP servers in config files (command, transport, env names) and MCP clients or servers in code |
| `iac` | Terraform, CloudFormation/SAM, CDK, Amplify, docker-compose: resources, regions, encryption, public exposure |
| `controls` | Signals for rate limits, validation, moderation, approval, tenant filters, audit logs, untrusted-content marking, limits |
| `dependencies` | Direct dependencies, licenses (from the lockfile or local virtualenv), audit results |
| `flags` | Deterministic findings with IDs (F-001…) and severity. The packet must address every critical and high one |

## 3. Verify

Before drafting, open the files behind every flag and every control you
plan to cite. Look for what the scan can't see:

- Routes the scan marked `found` with a weak `header-check`: is the
  comparison sound, and is the key a real secret?
- Routes marked `none-found`: is there auth elsewhere (a wrapper, an API
  gateway, a Lambda authorizer, an IP allowlist)? If not, it's a gap.
- Tools: what DB role or credentials does each run with? Can the model pick
  any URL, table or recipient?
- Where do the tenant and user IDs come from: the session, or the request?
- Run the commands at the end of `references/threats.md` for UI rendering
  and tenant-ID sources.

Correct the inventory in your head, not by editing `inventory.json`.

## 4. Draft

Copy `references/packet-template.md` to `<out-dir>/packet.md` and fill it:

- Section 2: the Mermaid diagram has a node for every provider, data store,
  vendor that receives data and MCP server in the inventory. Label edges
  with the data that moves.
- Section 3: one row per kind of data. Vendor retention and training use are
  `[Ask team]`; use `references/vendor-terms.md` for the checklist.
- Section 6: go through `references/threats.md` and keep the threats that
  apply. Mitigations column lists only cited code.
- Section 10: every `[Ask team]` from above, as one-line questions, most
  important first, with flag IDs.
- Appendix A only if asked: use `references/framework-map.md`.

## 5. Check

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/security-review-packet/scripts/check-packet.mjs" <out-dir>/packet.md --inventory <out-dir>/inventory.json --root <repo>
```

Exit 1 means errors: fix each one and run it again. Read the warnings too
(unmentioned providers, tools or medium flags; compliance-claim wording).
It writes `packet.json`: every statement with its tag and citations.

## Report

Tell the user, in this order:

1. Anything critical (secrets to rotate) first.
2. The open questions the team must answer before security can sign off,
   most important first.
3. The counts from the check (found / assumed / ask team).
4. What the scan can't see (the "Not covered" list) and where the files are.

Offer to fix code gaps (an auth check, an approval step, an allowlist) as a
separate change. Don't change code while drafting the packet.
