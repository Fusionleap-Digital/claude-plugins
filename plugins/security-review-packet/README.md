# security-review-packet

Drafts the packet a security and compliance team asks for before they sign
off on an AI system going to production. Point it at the repo of an LLM app,
RAG service or agent (and the infrastructure code, if it lives elsewhere).
It inventories what the code actually does, then Claude writes the packet
from that inventory, with a `file:line` citation behind every claim.

AI projects stall when they're waiting on security review, mostly because
nobody has written down which data goes to which model, who can call what,
and what an agent's tools can do. This plugin does that first draft in
minutes and lists the questions only your team can answer.

## What you get

1. **Inventory** (`scripts/inventory.mjs`, read-only): model providers and
   model IDs (Anthropic, OpenAI, Azure OpenAI, Bedrock, Vertex, Gemini,
   Mistral, Cohere, local models and more), vector stores and databases,
   outbound hosts, where prompts, logs and embeddings are written, env var
   names and secrets handling, auth on API routes (Next.js, Express-style,
   FastAPI, Flask), agent tools and what each can do, MCP servers, IaC
   resources with regions and encryption (Terraform, CloudFormation/SAM,
   CDK, Amplify), and dependencies with licenses and `npm audit` /
   `pip-audit` results. Writes `inventory.json` and `inventory.md`, with
   flags (F-001…) for the gaps it can prove.
2. **Packet** (`packet.md`), drafted by Claude from
   `references/packet-template.md`:
   - system overview and data-flow diagram (Mermaid)
   - data inventory and classification: which data reaches which model or
     vendor, and a checklist of vendor terms to confirm (retention, training
     use, DPA/BAA, region)
   - access control and identity
   - logging, monitoring and audit trail
   - prompt injection and tool-misuse threats, with the mitigations found
     in code
   - human-in-the-loop points
   - vendors and sub-processors
   - incident response contacts (placeholders)
   - open questions for the team
   - optional appendix: coverage map for SOC 2, NIST AI RMF, ISO/IEC
     42001, OWASP Top 10 for LLM Applications, and HIPAA / GLBA where
     relevant. It shows evidence and gaps; it doesn't claim compliance.
3. **Check** (`scripts/check-packet.mjs`): every statement must be tagged
   **[Found: file:line]**, **[Assumed]** or **[Ask team]**; every citation
   must point at a real line; every critical and high flag must be covered;
   no secret values. Exit code 1 if not.

## Safety

- **Read-only.** The scripts read files and write only to the output folder.
- **No secret values.** The inventory records env var names, and the file
  and line of anything that looks like a secret, never the value. Env files
  are read for names only.
- **No invented controls.** If the code doesn't show it, the packet says
  "none found" and asks the team.
- **Dependency audit sends package names.** `npm audit` and `pip-audit`
  send package names and versions (no code) to the registry. Pass
  `--no-audit` to skip.
- **Keep the packet private.** It lists the system's gaps. Don't commit it
  to a public repo.

## Install

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install security-review-packet@fusionleap
```

Then ask Claude for "a security review packet for this repo" or "what does
security need before we ship the AI feature".

## Run the inventory directly

```bash
node plugins/security-review-packet/skills/security-review-packet/scripts/inventory.mjs path/to/repo --iac path/to/infra --out packet-out
```

```bash
node plugins/security-review-packet/skills/security-review-packet/scripts/check-packet.mjs packet-out/packet.md --root path/to/repo
```

Node 18+, no dependencies. `pip-audit` is used if installed.

## Test

```bash
node test/security-packet-inventory.test.mjs
```

Runs the inventory on `test/security-packet-fixture/` (a Next.js + Python
claims assistant with pgvector, six agent tools, two MCP servers and
Terraform) and checks the expected findings: a hard-coded token, an ingest
route with no auth check, a tool that runs model-written SQL, a Lambda
function URL with no auth, prompts in logs, an unpinned MCP server, and the
controls that are there (NextAuth, rate limit, tenant filter, an approval
step). Then it runs the checker on the sample packet in
`examples/claims-copilot/`, which must pass.

## License

MIT
