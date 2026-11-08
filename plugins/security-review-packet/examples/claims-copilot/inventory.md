# Inventory: security-packet-fixture

- Scanned: 2026-11-08T22:33:59.878Z by security-review-packet 0.1.0
- Root: `test/security-packet-fixture` (git claude/feat-security-review-packet-f35ea3@ec151bf, uncommitted changes)
- Files read: 23
- Languages: typescript, javascript, python, terraform

## Flags

1 critical, 4 high, 7 medium, 4 low, 4 info

| ID | Severity | Area | Flag | Where |
|---|---|---|---|---|
| F-001 | critical | secrets | Possible hardcoded-credential in source — Value not shown. Treat as leaked: rotate it, then move it to a secrets store. | `worker/settings.py:8` |
| F-002 | high | access | No auth check found on POST /api/ingest — Route looks like it reaches the model, the index or uploads. Confirm it is meant to be public, or add an auth check. | `app/api/ingest/route.ts:13` |
| F-003 | high | agent-tools | Tool "run_report_query" can arbitrarySql with no approval step found — A prompt injection could make the model call this tool. | `lib/agent/tools.ts:40`, `lib/agent/tools.ts:44` |
| F-004 | high | infrastructure | aws_lambda_function_url.worker: authorization = NONE | `infra/main.tf:93` |
| F-005 | high | dependencies | npm audit: 3 critical, 4 high in package.json — @auth/core (critical), @fastify/busboy (high), next (critical), next-auth (critical), postcss (high), undici (high) | `package.json` |
| F-006 | medium | access | No auth check found on POST /summarize — Confirm it is meant to be public. | `worker/app.py:42` |
| F-007 | medium | access | No auth check found in server action submitFeedback — Server actions are public POST endpoints. | `app/actions/feedback.ts:5` |
| F-008 | medium | agent-tools | Tool "fetch_url" fetches a URL chosen at run time — Check for an allowlist: this is an SSRF and data-exfiltration path. | `lib/agent/tools.ts:49`, `lib/agent/tools.ts:53` |
| F-009 | medium | agent-tools | Tool "email_claimant" can sendMessage with no approval step found — Only an approval keyword was found (lib/agent/tools.ts:59); confirm a person approves before it runs. | `lib/agent/tools.ts:58`, `lib/agent/tools.ts:62` |
| F-010 | medium | mcp | MCP server "claims-db" runs an unpinned package — `npx -y @modelcontextprotocol/server-postgres postgres://readonly@localhost:5432/claims` fetches the latest version at start-up. | `.mcp.json:3` |
| F-011 | medium | logging | Prompts or model output written to logs — Logs may then hold user data and need the same retention and access rules as the database. | `app/api/chat/route.ts:30`, `worker/app.py:36` |
| F-012 | medium | infrastructure | aws_iam_role_policy.worker_bedrock: IAM policy grants access to all resources ("*") | `infra/main.tf:103` |
| F-013 | low | infrastructure | No explicit encryption setting on aws_s3_bucket.exports — Provider default: AWS applies SSE-S3 (AES-256) to new objects by default since Jan 2023; no customer-managed key. | `infra/main.tf:47` |
| F-014 | low | infrastructure | aws_s3_bucket.exports: no aws_s3_bucket_public_access_block (account-level block may still apply) | `infra/main.tf:47` |
| F-015 | low | infrastructure | No explicit encryption setting on aws_cloudwatch_log_group.worker — Provider default: encrypted by CloudWatch with a service key; no customer-managed key. | `infra/main.tf:78` |
| F-016 | low | infrastructure | No explicit encryption setting on aws_lambda_function.worker — Provider default: environment variables encrypted with an AWS managed key. | `infra/main.tf:83` |
| F-017 | info | access | Public health/status route GET /api/health — Check it returns nothing sensitive. | `app/api/health/route.ts:1` |
| F-018 | info | access | Public health/status route GET /healthz — Check it returns nothing sensitive. | `worker/app.py:26` |
| F-019 | info | vendors | Langfuse may receive prompts or documents — Add to the sub-processor list and confirm its retention. | `lib/telemetry.ts:1`, `lib/telemetry.ts:4` |
| F-020 | info | logging | Bedrock model invocation logging is not configured in Terraform — Without it there is no AWS-side record of prompts and responses. Decide whether you want one. |  |

## Model providers

| Provider | Confidence | Evidence | Env vars |
|---|---|---|---|
| Anthropic (Claude API) | code | `lib/llm.ts:1` | ANTHROPIC_API_KEY |
| OpenAI API | code | `lib/retrieval.ts:2` | OPENAI_API_KEY |
| AWS Bedrock | code | `worker/app.py:16`, `worker/app.py:48` |  |
| Vercel AI SDK (wrapper; provider is set separately) | code | `app/api/chat/route.ts:1`, `lib/agent/tools.ts:1`, `lib/retrieval.ts:1` |  |

## Model IDs

- `claude-sonnet-4-5` (anthropic): `lib/llm.ts:3`
- `claude-haiku-4-5` (anthropic): `lib/llm.ts:4`
- `text-embedding-3-small` (openai): `lib/retrieval.ts:5`
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` (anthropic-via-bedrock): `worker/app.py:18`

## Data stores

| Store | Category | Evidence |
|---|---|---|
| Postgres + pgvector | vector | `lib/retrieval.ts:16`, `lib/retrieval.ts:19` |
| PostgreSQL | database | `lib/db.ts:1`, `lib/db.ts:3` |
| Redis / Valkey | cache | `app/api/chat/route.ts:3` |
| Amazon S3 | object-storage | `app/api/ingest/route.ts:1`, `app/api/ingest/route.ts:4`, `app/api/ingest/route.ts:15` |

## Vendors and services

| Vendor | Category | Gets prompts? | Evidence |
|---|---|---|---|
| Langfuse | llm-observability | likely | `lib/telemetry.ts:1`, `lib/telemetry.ts:4` |
| Auth.js / NextAuth | auth |  | `auth.ts:1`, `auth.ts:2`, `auth.ts:5` |
| Okta | auth |  | `auth.ts:2`, `auth.ts:7` |
| Amazon SES | email |  | `lib/agent/tools.ts:3`, `lib/agent/tools.ts:7`, `lib/agent/tools.ts:62` |

## Outbound hosts

Called from code (URL on a line with a fetch/HTTP call) or implied by an SDK:

- `cloud.langfuse.com` (called): `lib/telemetry.ts:7`
- `api.anthropic.com` (sdk-default (anthropic))
- `api.openai.com` (sdk-default (openai))
- `bedrock-runtime.<region>.amazonaws.com` (sdk-default (bedrock))

Mentioned but no call seen on the same line (2; check any that receive data): `api.githubcopilot.com`, `claims-copilot.internal.example-insurer.test`

Calls to URLs built at run time: `lib/agent/tools.ts:53`, `worker/app.py:37`

## Where prompts, logs and embeddings go

- **promptLogging**: `app/api/chat/route.ts:30`, `worker/app.py:36`
- **conversationStorage**: `app/actions/feedback.ts:6`, `lib/db.ts:12`
- **embeddingCalls**: `lib/retrieval.ts:5`, `lib/retrieval.ts:8`
- **vectorWrites**: `lib/retrieval.ts:29`
- **fileStorage**: `app/api/ingest/route.ts:1`, `app/api/ingest/route.ts:15`

## API routes

Middleware: `middleware.ts`, matchers ["/dashboard/:path*","/api/chat/:path*"], auth yes

| Method | Path | Auth | Where |
|---|---|---|---|
| POST | `/api/admin/reindex` | found (header-check (read it: may be weak)) `app/api/admin/reindex/route.ts:4` | `app/api/admin/reindex/route.ts:3` |
| POST | `/api/chat` | found (session-or-token-check) `app/api/chat/route.ts:20` | `app/api/chat/route.ts:19` |
| GET | `/api/health` | none-found | `app/api/health/route.ts:1` |
| POST | `/api/ingest` | none-found | `app/api/ingest/route.ts:13` |
| GET | `/healthz` | none-found | `worker/app.py:26` |
| POST | `/documents` | found (Depends() in signature) `worker/app.py:32` | `worker/app.py:31` |
| POST | `/summarize` | none-found | `worker/app.py:42` |
| action | submitFeedback | none-found | `app/actions/feedback.ts:5` |

## Agent tools

| Tool | Framework | Can | Approval step | Where |
|---|---|---|---|---|
| search_policies | ai-sdk | nothing detected | none found | `lib/agent/tools.ts:11` |
| lookup_claim | ai-sdk | dbRead | none found | `lib/agent/tools.ts:17` |
| update_claim_status | ai-sdk | dbWrite, dbRead | framework-approval `lib/agent/tools.ts:32` | `lib/agent/tools.ts:29` |
| run_report_query | ai-sdk | dbRead, arbitrarySql | none found | `lib/agent/tools.ts:40` |
| fetch_url | ai-sdk | network | none found | `lib/agent/tools.ts:49` |
| email_claimant | ai-sdk | sendMessage | keyword-only `lib/agent/tools.ts:59` | `lib/agent/tools.ts:58` |

## MCP servers

- **claims-db** (stdio) `npx -y @modelcontextprotocol/server-postgres postgres://readonly@localhost:5432/claims`, env: PGPASSWORD — `.mcp.json:3`
- **github** (http) `https://api.githubcopilot.com/mcp/` — `.mcp.json:8`

## Secrets and env vars

Secret stores: none found

- `.env.example`: untracked (template), 16 names

Secret-like names: `ANTHROPIC_API_KEY`, `AUTH_OKTA_SECRET`, `AUTH_SECRET`, `DATABASE_URL`, `LANGFUSE_SECRET_KEY`, `OPENAI_API_KEY`, `REINDEX_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `WORKER_API_KEY`

Other names: `AUTH_OKTA_ID`, `AUTH_OKTA_ISSUER`, `AWS_REGION`, `CHAT_MODEL`, `DOCS_BUCKET`, `INGEST_URL`, `LANGFUSE_BASEURL`, `NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY`, `UPSTASH_REDIS_REST_URL`, `WORKER_URL`

## Infrastructure

Tools: terraform. Regions: us-east-1 (var.region default).

| Resource | Region | Encryption | Exposure | Where |
|---|---|---|---|---|
| aws_kms_key.data | us-east-1 (var.region default) | n/a |  | `infra/main.tf:18` |
| aws_s3_bucket.docs | us-east-1 (var.region default) | declared (aws_s3_bucket_server_side_encryption_configuration) |  | `infra/main.tf:24` |
| aws_s3_bucket_server_side_encryption_configuration.docs | us-east-1 (var.region default) | n/a |  | `infra/main.tf:28` |
| aws_s3_bucket_public_access_block.docs | us-east-1 (var.region default) | n/a |  | `infra/main.tf:38` |
| aws_s3_bucket.exports | us-east-1 (var.region default) | not-declared | no aws_s3_bucket_public_access_block (account-level block may still apply) | `infra/main.tf:47` |
| aws_db_instance.main | us-east-1 (var.region default) | declared (storage_encrypted, kms_key_id) |  | `infra/main.tf:52` |
| aws_security_group.db | us-east-1 (var.region default) | n/a |  | `infra/main.tf:68` |
| aws_cloudwatch_log_group.worker | us-east-1 (var.region default) | not-declared |  | `infra/main.tf:78` |
| aws_lambda_function.worker | us-east-1 (var.region default) | not-declared |  | `infra/main.tf:83` |
| aws_lambda_function_url.worker | us-east-1 (var.region default) | n/a | authorization = NONE | `infra/main.tf:93` |
| aws_iam_role.worker | us-east-1 (var.region default) | n/a |  | `infra/main.tf:98` |
| aws_iam_role_policy.worker_bedrock | us-east-1 (var.region default) | n/a | IAM policy grants access to all resources ("*") | `infra/main.tf:103` |
| aws_secretsmanager_secret.app | us-east-1 (var.region default) | declared (kms_key_id) |  | `infra/main.tf:115` |

## Controls found (signals, not proof)

- **rateLimit**: `app/api/chat/route.ts:2`, `app/api/chat/route.ts:12`, `app/api/chat/route.ts:25`
- **inputValidation**: `app/api/chat/route.ts:4`, `app/api/chat/route.ts:14`, `app/api/chat/route.ts:15`
- **moderation**: none found
- **guardrailLibrary**: none found
- **piiRedaction**: none found
- **humanApproval**: `lib/agent/tools.ts:32`
- **outputValidation**: none found
- **allowlist**: none found
- **untrustedContentMarking**: `lib/llm.ts:7`, `lib/llm.ts:11`
- **tokenAndStepLimits**: `app/api/chat/route.ts:1`, `app/api/chat/route.ts:41`, `app/api/chat/route.ts:42`
- **tenantIsolation**: `app/api/chat/route.ts:22`, `app/api/chat/route.ts:23`, `app/api/chat/route.ts:32`
- **auditLogging**: `lib/agent/tools.ts:4`, `lib/agent/tools.ts:35`, `lib/agent/tools.ts:67`
- **structuredLogging**: `worker/app.py:14`
- **csrfOrOrigin**: none found
- **secretScanning**: none found
- **retentionSettings**: none found

## Data classification hints

- **phi**: 1 lines (diagnosis ×1), e.g. `lib/agent/tools.ts:22`
- **financial**: 0 lines
- **pii**: 7 lines (email ×7), e.g. `app/api/chat/route.ts:21`, `app/api/chat/route.ts:25`, `app/api/chat/route.ts:30`

## Dependencies

Node: 16 direct in 1 manifests. Python: 6 direct in 1 manifests.

- npm audit `package.json`: {"info":0,"low":0,"moderate":5,"high":4,"critical":3,"total":12}
- pip-audit `worker/requirements.txt`: not run (pip-audit not installed (pipx install pip-audit))
- npm licenses (all packages in lockfile): MIT ×56, Apache-2.0 ×36, ISC ×6, UNKNOWN ×2, CC-BY-4.0 ×1, (AFL-2.1 OR BSD-3-Clause) ×1, BSD-3-Clause ×1, 0BSD ×1
- Python licenses: not read (no local virtualenv found)

## Not covered by this scan

- Code behind dynamic imports, generated clients or other repos (shared libraries, infra repos not passed with --iac).
- Cloud console settings not in code: account-level S3 public access block, Bedrock/OpenAI org settings, IAM outside IaC, WAF rules.
- Vendor contract terms (retention, training use, BAA/DPA). These need an answer from the team.
- Whether the controls found actually work. A rate limiter that is imported is not proof it is applied to every route.
- Runtime behavior: prompts, tool calls and logs in production.
