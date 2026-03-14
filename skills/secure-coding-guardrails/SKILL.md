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

1. **lint-staged** — ESLint + Prettier on staged files only (fast, no full-repo scan)
2. **TypeScript** — `tsc --noEmit` to catch type errors before they reach CI
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
mkdir -p .husky/_
mkdir -p .semgrep
```

## Step 3 — Create the Husky runtime shim

Create `.husky/_/husky.sh` — see `references/husky-shim.sh`.

## Step 4 — Create the pre-commit hook

Create `.husky/pre-commit` — see `references/pre-commit.sh`.

Make it executable:
```bash
chmod +x .husky/pre-commit
```

## Step 5 — Create the commit-msg hook

Create `.husky/commit-msg` with this content:

```sh
#!/usr/bin/env sh
. "$(dirname "$0")/_/husky.sh"

commit_msg=$(cat "$1")
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

This file contains 12 rules tuned for Next.js / TypeScript / MongoDB covering:
- Hardcoded API keys and MongoDB URIs
- `NEXT_PUBLIC_` environment variable secret leaks
- Missing auth checks in API route handlers
- NoSQL injection via raw request data
- `eval()` and `new Function()` usage
- `dangerouslySetInnerHTML` XSS risks
- Password or token fields in JSON responses

## Step 7 — Create detect-secrets config

Create `.detect-secrets.cfg` — see `references/detect-secrets-cfg.json`.

## Step 8 — Create lint-staged config

Create `.lintstagedrc.json`:

```json
{
  "*.{ts,tsx}": ["prettier --write"],
  "*.{js,jsx,mjs,cjs}": ["prettier --write"],
  "*.{json,css,md,mdx}": ["prettier --write"]
}
```

## Step 9 — Update package.json

Add to `"scripts"`:
```json
"prepare": "husky",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest"
```

Add to `"devDependencies"`:
```json
"eslint-plugin-security": "^3",
"husky": "^9",
"lint-staged": "^15",
"prettier": "^3",
"vitest": "^2"
```

## Step 10 — Create setup script

Create `scripts/setup-guardrails.sh` — see `references/setup-guardrails.sh`.

Tell the user to run it once:
```bash
bash scripts/setup-guardrails.sh
```

## Step 11 — Update .gitignore

Add to `.gitignore`:
```
# Spec generator output — review before committing
specs/generated/
```

Note: `.secrets.baseline` **should** be committed — it is not a secret, it is the allowlist baseline.

## Step 12 — Confirm and summarise

After creating all files, tell the user:
- Run `bash scripts/setup-guardrails.sh` once to install npm packages, initialise Husky, and generate the `.secrets.baseline`
- Every subsequent `git commit` will run all four checks automatically
- Semgrep and detect-secrets are skipped gracefully if not installed (the hook degrades without failing)
- `--metrics=off` is set on every Semgrep call — no code or findings leave the machine

## Important notes

- Never hardcode secrets or API keys in any generated file
- If the project already has a `prepare` script in `package.json`, merge rather than overwrite
- If TypeScript has pre-existing errors (`tsc --noEmit` fails), note this to the user and suggest using the `typecheck` script manually rather than in pre-commit until the errors are resolved
- The Semgrep rules in `references/semgrep-security.yml` are tuned for Next.js + MongoDB. If the user's stack differs, tell them which rules to remove or adapt
