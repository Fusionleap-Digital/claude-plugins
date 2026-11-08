---
name: ops-digest
description: Produce a weekly operations report for a small production website in one run - uptime and response time, TLS certificate expiry, domain expiry (RDAP), security headers (or the site-hardening probe's report), routes/sitemap/robots, email DNS, AI visibility, bot traffic from an access log, npm audit for the repo, optional Lighthouse scores and an analytics summary - and set it up to run on a schedule with Claude Code routines. Use when the user asks for a weekly site check, an ops or health report, "is everything OK with the site", certificate or domain expiry, or wants these checks scheduled.
---

# Weekly ops digest

One command that runs the other site-ops checks plus the expiry and
dependency checks, and writes one report with a "Needs attention" list at
the top.

## Rules

- **The user's own site and repo only.**
- **Read-only.** GET requests at 2 per second, DNS, one TLS handshake per
  host, an RDAP lookup, `npm audit` (which sends the dependency list to the
  npm registry, as any `npm install` does) and, if asked, Lighthouse. It
  submits no forms and changes nothing.
- **Never print secrets**, including from analytics modules: they read API
  keys from env vars and must not return them.
- **Ask before fixing.** The digest reports; fixes (dependency updates,
  DNS, headers) go through the user as separate changes.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/ops-digest/scripts/digest.mjs" https://example.com --repo . --tls-host www.example.com
```

Sections and what they flag:

| Section | Flags |
|---|---|
| Uptime and status | Home page fails any of 3 requests; median over 2.5 s; `--status-url /api/health` (repeatable) not 200 |
| TLS certificate | Untrusted cert; expires in under 30 days (medium), 14 (high: managed renewal is stuck), 7 (critical). `--tls-host` adds hosts such as `www.` |
| Domain registration | Expires in under 45 days (high) or 14 (critical); no registrar transfer lock. RDAP first, `whois` as fallback |
| Security headers | From `--hardening <site-hardening report.json>` if given (full check); otherwise a presence check of the five main headers on `/`. The full probe lives in the site-hardening plugin; this skill doesn't repeat it |
| Routes, sitemap and robots | The deploy-check smoke test on `/` and 5 sitemap pages (`--form /contact` to check a form too) |
| Email DNS | The email-deliverability DNS check (`--selector` for DKIM) |
| AI visibility | The ai-visibility site check |
| Bot traffic | The bot-triage check, only if `--log <file>` is given (repeatable) |
| npm audit | Critical or high vulnerabilities in production dependencies (`--repo`); dev-only counts as info |
| Lighthouse | Only with `--lighthouse`: runs `npx --yes lighthouse` (downloads it from npm on first use; needs Chrome). Flags a category under 70 |
| Analytics | Only with `--analytics <module.mjs>`; see below |
| Other reports | `--include <report.json or folder>` (repeatable) adds problems from earlier site-ops runs, such as a lead test or env check |

`--skip smoke,email,ai` leaves sections out. Writes `report.md` and
`report.json`. Exit code 1 means a critical or high finding, so a
scheduled run can alert on it.

For the security section, run the site-hardening probe monthly (it takes
about two minutes and needs its ownership proof) and pass its report:

```bash
node digest.mjs https://example.com --repo . --hardening site-hardening-example.com-2026-11-01/report.json
```

## Analytics extension point

`scripts/analytics-example.mjs` shows the contract. A module's default
export gets `{ site, since, until }` (the last 7 days, ISO strings) and
returns `{ title, summary: [lines], metrics: { name: value }, findings:
[{ severity, check, detail }] }`. Copy it, fill in the fetch against the
user's analytics API with the key from an env var, and pass
`--analytics ./my-analytics.mjs`. A WysLeap module will plug in here once
WysLeap API access is available; until then, don't invent analytics
numbers.

## Schedule it

See `references/scheduling.md` for setting this up as a weekly Claude Code
routine (or a local scheduled task, or GitHub Actions), including what to
ask the routine to do with the report.

## Report

Lead with the "Needs attention" list, most severe first, each with the
fix in one line. Then one line per section. Compare with last week's
report if the user keeps them (`report.json` per week): say what's new,
what's fixed and what's still open. Don't pad a quiet week; "nothing needs
attention" is a fine digest.
