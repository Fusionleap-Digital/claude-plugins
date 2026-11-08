# FusionLeap AI-Enhanced Engineering SDLC

**Publisher:** [FusionLeap Digital](https://fusionleap.io)
**Version:** 1.0.0

A Claude plugin that implements FusionLeap Digital's two core AI-enhanced engineering pillars — production-ready, ready to drop into any Node.js / TypeScript project.

---

## What this plugin does

### Pillar 1 — Secure Coding Guardrails

Sets up a four-layer pre-commit security system that runs automatically on every `git commit`:

| Check | Tool | What it catches |
|---|---|---|
| Lint + format | ESLint + Prettier via lint-staged | Style violations, staged files only |
| Unit tests | Vitest | Regressions before they reach CI |
| Secret scanning | detect-secrets | API keys, tokens, MongoDB URIs in code |
| Security scan | Semgrep | Missing auth checks, XSS, NoSQL injection, dangerous functions |

Plus conventional commit message enforcement (`feat:`, `fix:`, `security:`, etc.).

**Privacy note:** Semgrep runs with `--metrics=off` on every call — no code or findings are sent to Semgrep's servers.

### Pillar 2 — Spec-Driven Development

A workflow where engineers write machine-readable specs before code, then use Claude AI to generate unit tests, JSDoc documentation, and code scaffolding from those specs.

```
PM / Product Owner → Engineer writes spec → Claude generates tests + docs + code
```

Phase 2 vision: Claude reads PRDs or JIRA tickets directly and drafts the spec for engineer review.

---

## Skills included

| Skill | Trigger phrases |
|---|---|
| `secure-coding-guardrails` | "set up guardrails", "add pre-commit hooks", "secure my commits", "add Semgrep", "detect secrets" |
| `spec-driven-development` | "write a spec", "spec-first", "generate tests from spec", "PRD to spec", "JIRA to spec" |

---

## Requirements

- Node.js 18+ and npm
- TypeScript project with a `package.json`
- Git repository (`.git` directory present)
- Python 3 + pip (for detect-secrets and Semgrep — both optional, hooks degrade gracefully if absent)
- `ANTHROPIC_API_KEY` in `.env.local` (for the spec generator only)

---

## Quick start

Install the plugin in Claude Cowork, then ask:

> "Set up secure coding guardrails for my project"

or

> "Write a spec for the login API endpoint"

---

## About FusionLeap Digital

FusionLeap Digital helps engineering teams adopt AI-enhanced development practices — from security automation to spec-driven workflows and AI observability.

[fusionleap.io](https://fusionleap.io)
