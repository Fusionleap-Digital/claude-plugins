---
name: secure-coding-guardrails
description: >
  FusionLeap Digital — Secure Coding Guardrails. Sets up production-ready
  pre-commit security automation for Node.js / TypeScript projects. Use when
  the user says "set up guardrails", "add pre-commit hooks", "secure my commits",
  "add secret scanning", "set up Semgrep", "add Husky", "pre-commit security",
  "detect secrets in git", "block bad commits", "secure coding setup",
  "add lint-staged", or "enforce security before commit". Also triggers on
  "FusionLeap guardrails".
---

# Secure Coding Guardrails

You are implementing the FusionLeap Digital Secure Coding Guardrails pillar — a four-layer pre-commit security system for Node.js / TypeScript projects. Work through the checklist below in order, creating every file and updating `package.json` as you go.

## What you are setting up

Four checks run automatically on every `git commit`:

1. **lint-staged** — ESLint (if the project has it) + Prettier on staged files only
2. **TypeScript** — `tsc --noEmit` via the `typecheck` script. Tests stay in CI: running the full suite on every commit makes people skip the hook.
3. **detect-secrets** — blocks commits that introduce API keys, tokens, or credentials
4. **Semgrep** — security rules tuned for Next.js / TypeScript / MongoDB: missing auth checks, NoSQL injection, XSS, hardcoded secrets, dangerous functions

Plus a **commit-msg hook** enforcing conventional commit format (`feat:`, `fix:`, `security:`, etc.).

## Step 1 — Confirm project context

Before creating any files, ask the user:
- Where is their project root? (or assume current working directory)
- Do they already have Husky installed? (`ls .husky` to check)
- Are there existing pre-commit hooks that should be preserved?

## Step 2 — Create directory structure

```bash
mkdir -p .husky .semgrep
```

Husky v9 hooks are plain shell scripts. Don't create anything in `.husky/_/`: Husky generates that folder itself.

## Step 3 — Preserve existing hooks

If `.husky/pre-commit` already exists, show the user what it runs and merge those commands into the new hook rather than dropping them.

## Step 4 — Create the pre-commit hook

Create `.husky/pre-commit` — see `references/pre-commit.sh`.

Make it executable:
```bash
chmod +x .husky/pre-commit
```

## Step 5 — Create the commit-msg hook

Create `.husky/commit-msg` with this content:

```sh
commit_msg=$(head -n 1 "$1")
pattern='^(feat|fix|docs|style|refactor|test|chore|security|perf|ci|build|revert)(\(.+\))?: .{1,100}$'

if ! echo "$commit_msg" | grep -qE "$pattern"; then
  echo ""
  echo "✖ Invalid commit message format."
  echo "  Expected: <type>(scope): <description>"
  echo "  Example:  feat(auth): add session expiry refresh"
  echo "  Example:  security(api): sanitise query params before DB insert"
  echo "  Allowed types: feat | fix | docs | style | refactor | test | chore | security | perf | ci | build | revert"
  echo ""
  exit 1
fi
```

Make it executable:
```bash
chmod +x .husky/commit-msg
```

## Step 6 — Create Semgrep rules

Create `.semgrep/security.yml` — see `references/semgrep-security.yml`.

This file contains 10 rules tuned for Next.js / TypeScript / MongoDB covering:
- Hardcoded API keys and MongoDB URIs
- `NEXT_PUBLIC_` environment variable secret leaks
- Missing auth checks in API route handlers
- NoSQL injection via raw request data
- `eval()` and `new Function()` usage
- `dangerouslySetInnerHTML` XSS risks
- Password or token fields in JSON responses

Then fit it to the project:
- The `api-route-missing-auth` rule looks for `isAuthenticated(...)` or `getAuthToken(...)`. Find how this project's routes check auth and replace those names with its helpers. If it isn't a Next.js App Router project, delete the rule.
- Adjust the `exclude` lists to the project's public routes (health checks, webhooks, auth callbacks).
- If the project doesn't use MongoDB, delete `hardcoded-mongodb-uri` and `mongoose-query-user-input`.

ERROR rules block the commit; WARNING rules are shown but don't block.

## Step 7 — Create lint-staged config

Create `.lintstagedrc.json`. If the project has an ESLint config (`eslint.config.*` or `.eslintrc*`), lint code files too:

```json
{
  "*.{ts,tsx,js,jsx,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,css,md,mdx}": ["prettier --write"]
}
```

Without an ESLint config, use Prettier only:

```json
{
  "*.{ts,tsx,js,jsx,mjs,cjs,json,css,md,mdx}": ["prettier --write"]
}
```

## Step 8 — Update package.json

Merge into `"scripts"` (keep any existing `test` script as it is):
```json
"prepare": "husky",
"typecheck": "tsc --noEmit"
```

The setup script installs `husky`, `lint-staged` and `prettier`.

## Step 9 — Create setup script

Create `scripts/setup-guardrails.sh` — see `references/setup-guardrails.sh`.

Tell the user to run it once:
```bash
bash scripts/setup-guardrails.sh
```

`.secrets.baseline` **should** be committed — it is not a secret, it is the allowlist of findings already reviewed. It also stores the detect-secrets settings.

## Step 10 — Confirm and summarise

After creating all files, tell the user:
- Run `bash scripts/setup-guardrails.sh` once to install npm packages, activate the Husky hooks, and generate the `.secrets.baseline` (it never overwrites the hooks)
- Every subsequent `git commit` will run all four checks automatically
- Semgrep and detect-secrets are skipped gracefully if not installed (the hook degrades without failing)
- `--metrics=off` is set on every Semgrep call — no code or findings leave the machine

## Important notes

- Never hardcode secrets or API keys in any generated file
- If the project already has a `prepare` script in `package.json`, merge rather than overwrite
- If TypeScript has pre-existing errors (`tsc --noEmit` fails), note this to the user and suggest using the `typecheck` script manually rather than in pre-commit until the errors are resolved
- The Semgrep rules in `references/semgrep-security.yml` are tuned for Next.js + MongoDB. If the user's stack differs, tell them which rules to remove or adapt
