# FusionLeap AI-Enhanced Engineering SDLC

**Publisher:** [FusionLeap Digital](https://fusionleap.io)
**Version:** 1.1.0

A Claude Code plugin with two skills for Node.js / TypeScript projects: pre-commit security checks, and spec-driven development.

---

## Secure Coding Guardrails

Sets up Git hooks (Husky v9) that run on every `git commit`:

| Check | Tool | What it catches | Blocks the commit? |
|---|---|---|---|
| Lint + format | lint-staged (ESLint if configured, Prettier) | Style and lint errors in staged files | Yes |
| Type check | `tsc --noEmit` via a `typecheck` script | Type errors | Yes |
| Secret scanning | detect-secrets | API keys, tokens, private keys, database URLs | Yes |
| Security scan | Semgrep, 10 rules for Next.js / TypeScript / MongoDB | `eval`, `new Function`, unsafe `dangerouslySetInnerHTML`, hardcoded secrets and MongoDB URIs, `NEXT_PUBLIC_` secrets, passwords in responses | ERROR rules block; WARNING rules (missing auth checks, raw request data in queries, tokens in responses) are shown |
| Commit message | commit-msg hook | Messages that aren't `type(scope): description` | Yes |

Semgrep reports only findings new since the last commit, and runs with `--metrics=off`, so no code or findings leave your machine. Tests stay in CI: running the whole suite on every commit makes people skip the hook. The skill fits the Semgrep rules to your project (your auth helper names, your public routes) and keeps your existing hooks and `test` script.

## Spec-Driven Development

Engineers write a machine-readable spec (inputs, outputs, error cases, security requirements, GIVEN/WHEN/THEN acceptance criteria) before the code. A script then calls the Claude API to draft unit tests, JSDoc and a code scaffold from it, into `specs/generated/` for review.

```
Product owner → Engineer writes spec → Claude drafts tests + docs + scaffold → Engineer reviews
```

Paste a PRD or ticket and Claude drafts the spec for you to review. The generator uses `claude-opus-5-5` by default (`SPEC_GEN_MODEL` to change it), and `--dry-run` prints the prompts without calling the API.

---

## Install

In Claude Code:

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install fusionleap-ai-sdlc@fusionleap
```

Then ask:

> "Set up secure coding guardrails for my project"

or

> "Write a spec for the login API endpoint"

## Requirements

- Node.js 18+ and npm, a `package.json`, and a Git repository
- TypeScript for the type check (the step is skipped without a `typecheck` script)
- detect-secrets and Semgrep (`pipx install detect-secrets semgrep`, or Homebrew). The hook skips either one with a warning if it isn't installed
- For the spec generator: Claude API credentials (`ANTHROPIC_API_KEY` in `.env.local`, or `ant auth login`)

---

## About FusionLeap Digital

FusionLeap Digital builds production AI with engineering teams: working systems in your cloud, owned by your team. [fusionleap.io](https://fusionleap.io)
